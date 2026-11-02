import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PHOTO_LIMITS } from "../../../photo-library-contract/src/v2.ts";
import type { PhotoAsset, RenderCapability, Sha256 } from "../../../photo-library-contract/src/v2.ts";
import { CloudMediaError } from "../types.ts";
import { isBoundedWorkingCopyMeta } from "../index.ts";
import type { CloudMediaErrorCode, ValidatedMediaRecipe } from "../types.ts";
import baseline from "../../sdk-baseline.json" with { type: "json" };
import { createMediaIdentity, mediaIdentityKey } from "./identity.ts";
import { inspectPng } from "./png.ts";
import { loadVerifiedContract, sha256 } from "./runtime.ts";
import type {
  MediaRenderResult,
  MediaRenderedAsset,
  PinnedMediaProvider,
  PinnedMediaProviderOptions,
  ProviderRenderRequest,
} from "./types.ts";

const HASH = /^[a-f0-9]{64}$/;
const JPEG_MAX_BYTES = 64 * 1024 ** 2;
const PNG_MAX_BYTES = 10 * 1024 ** 2;
const OUTPUT_LIMITS = { thumbnail: 2 * 1024 ** 2, preview: 8 * 1024 ** 2 } as const;
const CHILD_STDOUT_LIMIT = 64 * 1024;
const CHILD_PATH = fileURLToPath(new URL("./pinned-provider-child.ts", import.meta.url));
const ERROR_CODES = new Set<CloudMediaErrorCode>([
  "invalid_input", "input_limit", "content_mismatch", "unsupported_settings", "renderer_unavailable",
  "decoder_failed", "invalid_output", "timeout", "cancelled",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function exactAsset(left: PhotoAsset, right: PhotoAsset): boolean {
  return left.id === right.id && left.kind === right.kind && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes && left.contentType === right.contentType
    && left.width === right.width && left.height === right.height;
}

function immutable<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) immutable(child, seen);
    Object.freeze(value);
  }
  return value;
}

function activeError(signal: AbortSignal): CloudMediaError {
  const code = signal.reason instanceof CloudMediaError && ERROR_CODES.has(signal.reason.code)
    ? signal.reason.code
    : "cancelled";
  return new CloudMediaError(code);
}

function sanitizedError(error: unknown, fallback: CloudMediaErrorCode): CloudMediaError {
  return error instanceof CloudMediaError && ERROR_CODES.has(error.code)
    ? new CloudMediaError(error.code)
    : new CloudMediaError(fallback);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  let abort = (): void => {};
  let abandoned = false;
  let disposed = false;
  const dispose = (value: T): void => {
    if (disposed || !onLate) return;
    disposed = true;
    try { onLate(value); } catch { /* best-effort cleanup stays inside the boundary */ }
  };
  void promise.then((value) => { if (abandoned) dispose(value); }, () => {});
  try {
    const value = await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => {
        abandoned = true;
        reject(activeError(signal));
      };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    })]);
    if (abandoned) {
      dispose(value);
      throw activeError(signal);
    }
    return value;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function safeReturnIterator(iterator: AsyncIterator<Uint8Array>): void {
  try {
    const result = iterator.return?.();
    if (result) void Promise.resolve(result).catch(() => {});
  } catch { /* best effort */ }
}

function safeReturnIterable(iterable: AsyncIterable<Uint8Array>): void {
  try { safeReturnIterator(iterable[Symbol.asyncIterator]()); } catch { /* best effort */ }
}

function validateAsset(asset: PhotoAsset, kind: PhotoAsset["kind"], maxBytes: number, maxEdge?: number): boolean {
  return boundedString(asset.id) && asset.kind === kind && HASH.test(asset.sha256)
    && boundedString(asset.contentType, 128) && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(asset.contentType)
    && Number.isSafeInteger(asset.sizeBytes) && asset.sizeBytes > 0 && asset.sizeBytes <= maxBytes
    && Number.isSafeInteger(asset.width) && Number.isSafeInteger(asset.height) && asset.width > 0 && asset.height > 0
    && asset.width * asset.height <= PHOTO_LIMITS.maxPixels
    && (maxEdge === undefined || Math.max(asset.width, asset.height) <= maxEdge);
}

async function validateRequest(request: ProviderRenderRequest, options: PinnedMediaProviderOptions): Promise<ValidatedMediaRecipe> {
  const { source, input } = request;
  const photo = source.photo;
  if (!boundedString(source.ownerId) || !boundedString(source.originalGeneration) || !Number.isSafeInteger(source.lifecycleGeneration)
    || source.lifecycleGeneration < 0 || photo.storageState !== "stored" || photo.lifecycle !== "active"
    || !boundedString(photo.id) || !boundedString(photo.libraryId)
    || !["jpeg", "png", "heic", "heif", "tiff", "raw"].includes(photo.format)
    || (input.kind !== "original" && input.kind !== "workingCopy")
    || input.photoId !== photo.id || input.libraryId !== photo.libraryId || input.originalAssetId !== photo.original.id
    || input.originalSha256 !== photo.original.sha256 || !validateAsset(photo.original, "original", PHOTO_LIMITS.maxFileBytes)
    || photo.original.width !== photo.width || photo.original.height !== photo.height
    || !Number.isSafeInteger(photo.recipe.revision) || photo.recipe.revision < 0 || !HASH.test(photo.recipe.settingsSha256)) {
    throw new CloudMediaError("invalid_input");
  }
  let validated: ValidatedMediaRecipe;
  try { validated = structuredClone(options.validateRecipe(photo.recipe)); }
  catch { throw new CloudMediaError("unsupported_settings"); }
  if (typeof validated.canonicalSettings !== "string" || !HASH.test(validated.settingsSha256)
    || validated.settingsSha256 !== photo.recipe.settingsSha256
    || sha256(validated.canonicalSettings) !== validated.settingsSha256
    || Buffer.byteLength(validated.canonicalSettings) > PHOTO_LIMITS.maxRecipeBytes
    || validated.baseVersion !== photo.recipe.baseVersion
    || (validated.baseVersion !== null && !boundedString(validated.baseVersion))
    || !Array.isArray(validated.maskSurfaceIds)) {
    throw new CloudMediaError("unsupported_settings");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(validated.canonicalSettings); } catch { throw new CloudMediaError("unsupported_settings"); }
  if (!isDeepStrictEqual(parsed, photo.recipe.settings)) throw new CloudMediaError("unsupported_settings");
  const contract = await loadVerifiedContract();
  try {
    if (!contract.supportsDevelopSettingsWrite(parsed) || !contract.readDevelopSettings(parsed)
      || !contract.isEditableDevelopSettings(parsed)) throw new Error();
  } catch { throw new CloudMediaError("unsupported_settings"); }

  if (input.kind === "original") {
    if (input.format !== "jpeg" && input.format !== "png") throw new CloudMediaError("invalid_input");
    const max = input.format === "jpeg" ? JPEG_MAX_BYTES : PNG_MAX_BYTES;
    const contentType = input.format === "jpeg" ? "image/jpeg" : "image/png";
    if (photo.recipe.baseVersion !== null || (parsed as Record<string, unknown>).base !== null
      || input.format !== photo.format || !exactAsset(input.asset, photo.original)
      || input.asset.contentType !== contentType || !validateAsset(input.asset, "original", Math.min(max, options.maxInputBytes))
      || input.asset.width * input.asset.height > PHOTO_LIMITS.browserDirectMaxPixels
      || input.exportMaxEdge !== Math.max(input.asset.width, input.asset.height)) throw new CloudMediaError("invalid_input");
  } else {
    if (input.encoding !== "png16" && input.encoding !== "jpeg8") throw new CloudMediaError("invalid_input");
    if (!isBoundedWorkingCopyMeta(input.meta)) throw new CloudMediaError("invalid_input");
    const copy = photo.media.state === "ready" ? photo.media.workingCopy : null;
    if (!copy || !exactAsset(input.asset, copy.asset) || input.baseVersion !== copy.baseVersion
      || input.encoding !== copy.encoding || !isDeepStrictEqual(input.meta, copy.meta)
      || validated.baseVersion !== input.baseVersion || !validateAsset(input.asset, "working-copy", options.maxInputBytes, PHOTO_LIMITS.workingCopyMaxEdge)
      || input.asset.contentType !== (input.encoding === "png16" ? "image/png" : "image/jpeg")
      || input.exportMaxEdge !== Math.max(input.asset.width, input.asset.height)) throw new CloudMediaError("invalid_input");
    try {
      const compatible = contract.developSettingsOnWorkingCopy(parsed as Record<string, unknown>, input.baseVersion, input.meta);
      if (!isDeepStrictEqual(compatible, parsed)) throw new Error();
    } catch { throw new CloudMediaError("unsupported_settings"); }
  }

  const required = [...validated.maskSurfaceIds];
  if (new Set(required).size !== required.length || required.some((id) => !HASH.test(id))
    || !isDeepStrictEqual([...required].sort(), [...photo.recipe.maskSurfaceIds].sort())
    || request.masks.length !== required.length || request.masks.length > 8) throw new CloudMediaError("unsupported_settings");
  const supplied = new Map(request.masks.map((mask) => [mask.surfaceId, mask]));
  if (supplied.size !== request.masks.length || required.some((id) => !supplied.has(id))) throw new CloudMediaError("invalid_input");
  let maskTotal = 0;
  for (const mask of request.masks) {
    maskTotal += mask.asset.sizeBytes;
    if (mask.surfaceId !== mask.asset.sha256
      || !validateAsset(mask.asset, "mask", PHOTO_LIMITS.maxMaskBytes, PHOTO_LIMITS.maxMaskEdge)
      || mask.asset.contentType !== "image/png") throw new CloudMediaError("invalid_input");
  }
  if (!Number.isSafeInteger(maskTotal) || maskTotal > options.maxMaskTotalBytes) throw new CloudMediaError("input_limit");
  return Object.freeze({ ...validated, maskSurfaceIds: Object.freeze([...validated.maskSurfaceIds]) });
}

async function spoolAsset(
  request: ProviderRenderRequest,
  asset: PhotoAsset,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const iterable = await abortable(request.readAsset(asset, signal), signal, safeReturnIterable);
  const iterator = iterable[Symbol.asyncIterator]();
  const file = await open(path, "wx", 0o600);
  let total = 0;
  const hash = createHash("sha256");
  try {
    while (true) {
      const part = await abortable(iterator.next(), signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0
        || total + part.value.byteLength > asset.sizeBytes) throw new CloudMediaError("content_mismatch");
      total += part.value.byteLength;
      hash.update(part.value);
      let offset = 0;
      while (offset < part.value.byteLength) {
        const written = await abortable(file.write(part.value, offset), signal);
        if (written.bytesWritten < 1) throw new CloudMediaError("decoder_failed");
        offset += written.bytesWritten;
      }
    }
    if (total !== asset.sizeBytes || hash.digest("hex") !== asset.sha256) throw new CloudMediaError("content_mismatch");
  } finally {
    safeReturnIterator(iterator);
    await file.close();
  }
}

type ChildSuccess = {
  readonly ok: true;
  readonly renderer: RenderCapability;
  readonly outputs: readonly { readonly kind: "thumbnail" | "preview"; readonly file: string; readonly width: number; readonly height: number }[];
};

function parseChildResult(stdout: Buffer): ChildSuccess | { readonly ok: false; readonly code: "unsupported_settings" | "renderer_unavailable" | "decoder_failed" | "invalid_output" } {
  try {
    const value: unknown = JSON.parse(stdout.toString("utf8"));
    if (!record(value) || typeof value.ok !== "boolean") throw new Error();
    if (value.ok === false && ["unsupported_settings", "renderer_unavailable", "decoder_failed", "invalid_output"].includes(String(value.code))) {
      return value as { readonly ok: false; readonly code: "unsupported_settings" | "renderer_unavailable" | "decoder_failed" | "invalid_output" };
    }
    if (value.ok !== true || !record(value.renderer) || !Array.isArray(value.outputs) || value.outputs.length !== 2
      || value.renderer.sdkVersion !== baseline.releaseTag.slice("photo-sdk-v".length)
      || value.renderer.crateVersion !== baseline.engine.crateVersion
      || value.renderer.manifestSha256 !== baseline.engine.manifest.sha256
      || value.renderer.maskSurfaces !== true || !Array.isArray(value.renderer.settingsVersions)
      || !Array.isArray(value.renderer.engines) || !Array.isArray(value.renderer.features) || !Array.isArray(value.renderer.maskKinds)) throw new Error();
    if (!isDeepStrictEqual(value.renderer.settingsVersions, baseline.recipeCompatibility.supportedVersions)
      || !isDeepStrictEqual(value.renderer.engines, baseline.recipeCompatibility.engineIdentifiers)
      || value.renderer.features.some((item) => typeof item !== "string")
      || value.renderer.maskKinds.some((item) => typeof item !== "string")) throw new Error();
    const outputs = value.outputs as unknown[];
    const kinds = new Set<string>();
    for (const item of outputs) {
      if (!record(item) || (item.kind !== "thumbnail" && item.kind !== "preview") || item.file !== `${item.kind}.png`
        || !Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height) || kinds.has(item.kind as string)) throw new Error();
      kinds.add(item.kind as string);
    }
    const success = value as unknown as ChildSuccess;
    const renderer: RenderCapability = Object.freeze({
      ...success.renderer,
      settingsVersions: Object.freeze([...success.renderer.settingsVersions]),
      engines: Object.freeze([...success.renderer.engines]),
      features: Object.freeze([...success.renderer.features]),
      maskKinds: Object.freeze([...success.renderer.maskKinds]),
    });
    return Object.freeze({ ...success, renderer, outputs: Object.freeze(success.outputs.map((item) => Object.freeze({ ...item }))) });
  } catch {
    throw new CloudMediaError("renderer_unavailable");
  }
}

async function runChild(payload: string, scratch: string, signal: AbortSignal): Promise<ChildSuccess> {
  if (Buffer.byteLength(payload) > PHOTO_LIMITS.maxRecipeBytes + PHOTO_LIMITS.maxWorkingCopyMetaBytes + 32 * 1024) {
    throw new CloudMediaError("unsupported_settings");
  }
  const child = spawn(process.execPath, ["--max-old-space-size=320", CHILD_PATH], {
    cwd: scratch,
    env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let stdout = Buffer.alloc(0);
  let overflow = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdout.byteLength + chunk.byteLength > CHILD_STDOUT_LIMIT) {
      overflow = true;
      child.kill("SIGKILL");
    } else stdout = Buffer.concat([stdout, chunk]);
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let boundTimer: ReturnType<typeof setTimeout> | undefined;
    let failure: CloudMediaError | undefined;
    const settle = (error?: CloudMediaError): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (boundTimer) clearTimeout(boundTimer);
      signal.removeEventListener("abort", onAbort);
      child.stdin.removeListener("error", onStdinError);
      if (error) reject(error); else resolve();
    };
    const terminate = (error: CloudMediaError): void => {
      failure ??= error;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 200);
      boundTimer ??= setTimeout(() => settle(failure), 750);
    };
    const onAbort = (): void => terminate(activeError(signal));
    const onStdinError = (): void => terminate(new CloudMediaError("renderer_unavailable"));
    child.stdin.once("error", onStdinError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.once("error", () => settle(new CloudMediaError("renderer_unavailable")));
    child.once("close", (code, childSignal) => {
      if (failure) settle(failure);
      else if (signal.aborted) settle(activeError(signal));
      else if (overflow || code !== 0 || childSignal) settle(new CloudMediaError("renderer_unavailable"));
      else settle();
    });
    if (!signal.aborted) {
      try { child.stdin.end(payload); } catch { onStdinError(); }
    } else {
      child.stdin.destroy();
    }
  });
  const result = parseChildResult(stdout);
  if (!result.ok) throw new CloudMediaError(result.code);
  return result;
}

async function collectOutputs(result: ChildSuccess, scratch: string): Promise<readonly MediaRenderedAsset[]> {
  const outputs: MediaRenderedAsset[] = [];
  for (const expected of result.outputs) {
    const path = join(scratch, expected.file);
    const stat = await lstat(path);
    const resolved = await realpath(path);
    const limit = OUTPUT_LIMITS[expected.kind];
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !resolved.startsWith(`${scratch}${sep}`)
      || stat.size < 1 || stat.size > limit) throw new CloudMediaError("invalid_output");
    const bytes = await readFile(resolved);
    const info = inspectPng(bytes, { output: true });
    if (info.width !== expected.width || info.height !== expected.height || info.srgbIntent !== 0
      || Math.max(info.width, info.height) > (expected.kind === "thumbnail" ? PHOTO_LIMITS.thumbnailMaxEdge : PHOTO_LIMITS.previewMaxEdge)) {
      throw new CloudMediaError("invalid_output");
    }
    outputs.push(Object.freeze({
      kind: expected.kind,
      bytes: new Uint8Array(bytes),
      sha256: sha256(bytes) as Sha256,
      contentType: "image/png",
      width: info.width,
      height: info.height,
      colorSpace: "srgb",
      orientationApplied: true,
      privateMetadataRemoved: true,
    }));
  }
  return Object.freeze(outputs);
}

export function createPinnedMediaProvider(options: PinnedMediaProviderOptions): PinnedMediaProvider {
  const config: PinnedMediaProviderOptions = Object.freeze({
    scratchRoot: options.scratchRoot,
    timeoutMs: options.timeoutMs,
    maxInputBytes: options.maxInputBytes,
    maxMaskTotalBytes: options.maxMaskTotalBytes,
    validateRecipe: options.validateRecipe,
  });
  if (!isAbsolute(config.scratchRoot) || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120_000
    || !Number.isSafeInteger(config.maxInputBytes) || config.maxInputBytes < 1 || config.maxInputBytes > PHOTO_LIMITS.maxFileBytes
    || !Number.isSafeInteger(config.maxMaskTotalBytes) || config.maxMaskTotalBytes < 0
    || config.maxMaskTotalBytes > PHOTO_LIMITS.maxMaskBytes * 8
    || typeof config.validateRecipe !== "function") throw new TypeError("photo-cloud-media: invalid provider options");
  let active = false;
  return {
    async render(request): Promise<MediaRenderResult> {
      if (active) throw new CloudMediaError("renderer_unavailable");
      active = true;
      let job: ProviderRenderRequest;
      try {
        job = {
          source: immutable(structuredClone(request.source)),
          input: immutable(structuredClone(request.input)),
          masks: immutable(structuredClone(request.masks)),
          readAsset: request.readAsset,
          signal: request.signal,
        };
      } catch {
        active = false;
        throw new CloudMediaError("invalid_input");
      }
      let scratch: string | null = null;
      const controller = new AbortController();
      const cancel = (): void => controller.abort(new CloudMediaError("cancelled"));
      job.signal.addEventListener("abort", cancel, { once: true });
      if (job.signal.aborted) cancel();
      const timer = setTimeout(() => controller.abort(new CloudMediaError("timeout")), config.timeoutMs);
      try {
        const validated = await abortable(validateRequest(job, config), controller.signal);
        const rootStat = await abortable(lstat(config.scratchRoot), controller.signal);
        const root = await abortable(realpath(config.scratchRoot), controller.signal);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new CloudMediaError("renderer_unavailable");
        const scratchPrefix = join(root, "niho-cloud-media-");
        scratch = await abortable(mkdtemp(scratchPrefix), controller.signal, (lateScratch) => {
          if (lateScratch.startsWith(scratchPrefix)) void rm(lateScratch, { recursive: true, force: true }).catch(() => {});
        });
        await abortable(chmod(scratch, 0o700), controller.signal);
        await spoolAsset(job, job.input.asset, join(scratch, "input.bin"), controller.signal);
        const sortedMasks = [...job.masks].sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));
        for (let index = 0; index < sortedMasks.length; index += 1) {
          await spoolAsset(job, sortedMasks[index]!.asset, join(scratch, `mask-${index}.png`), controller.signal);
        }
        const payload = JSON.stringify({
          input: {
            file: "input.bin",
            kind: job.input.kind,
            format: job.input.kind === "original" ? job.input.format : job.input.encoding,
            sha256: job.input.asset.sha256,
            sizeBytes: job.input.asset.sizeBytes,
            width: job.input.asset.width,
            height: job.input.asset.height,
            exportMaxEdge: job.input.exportMaxEdge,
            baseVersion: job.input.kind === "workingCopy" ? job.input.baseVersion : null,
            metaJson: job.input.kind === "workingCopy" ? JSON.stringify(job.input.meta) : null,
          },
          canonicalSettings: validated.canonicalSettings,
          settingsSha256: validated.settingsSha256,
          masks: sortedMasks.map((mask, index) => ({
            id: mask.surfaceId, file: `mask-${index}.png`, sizeBytes: mask.asset.sizeBytes,
            width: mask.asset.width, height: mask.asset.height,
          })),
        });
        const child = await runChild(payload, scratch, controller.signal);
        const assets = await abortable(collectOutputs(child, scratch), controller.signal);
        const identity = createMediaIdentity(job.source, job.input, validated, child.renderer.manifestSha256);
        return Object.freeze({ identity, identityKey: mediaIdentityKey(identity), renderer: child.renderer, assets });
      } catch (error) {
        if (controller.signal.aborted) throw activeError(controller.signal);
        throw sanitizedError(error, "renderer_unavailable");
      } finally {
        clearTimeout(timer);
        job.signal.removeEventListener("abort", cancel);
        active = false;
        if (scratch) {
          try { await rm(scratch, { recursive: true, force: true }); }
          catch { throw new CloudMediaError("renderer_unavailable"); }
        }
      }
    },
  };
}
