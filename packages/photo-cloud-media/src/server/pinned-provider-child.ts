import { isDeepStrictEqual } from "node:util";
import { lstat, open, readFile } from "node:fs/promises";
import { PHOTO_LIMITS } from "../../../photo-library-contract/src/v2.ts";
import type { JsonObject, RenderCapability } from "../../../photo-library-contract/src/v2.ts";
import { inspectPng, markSrgbPng } from "./png.ts";
import { loadVerifiedContract, loadVerifiedDevelopRuntime, sha256 } from "./runtime.ts";

const HASH = /^[a-f0-9]{64}$/;
const OUTPUT_LIMITS = { thumbnail: 2 * 1024 ** 2, preview: 8 * 1024 ** 2 } as const;
class InvalidOutputError extends Error {}
type Kind = "thumbnail" | "preview";
type Request = {
  readonly input: {
    readonly file: "input.bin";
    readonly kind: "original" | "workingCopy";
    readonly format: "jpeg" | "png" | "png16" | "jpeg8";
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly width: number;
    readonly height: number;
    readonly exportMaxEdge: number;
    readonly baseVersion: string | null;
    readonly metaJson: string | null;
  };
  readonly canonicalSettings: string;
  readonly settingsSha256: string;
  readonly masks: readonly {
    readonly id: string;
    readonly file: string;
    readonly sizeBytes: number;
    readonly width: number;
    readonly height: number;
  }[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readRequest(): Promise<Request> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > PHOTO_LIMITS.maxRecipeBytes + PHOTO_LIMITS.maxWorkingCopyMetaBytes + 32 * 1024) throw new Error();
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!record(value) || !record(value.input) || !Array.isArray(value.masks)
    || typeof value.canonicalSettings !== "string" || typeof value.settingsSha256 !== "string") throw new Error();
  return value as unknown as Request;
}

async function regularFile(name: string, expectedBytes: number): Promise<Buffer> {
  if (!/^(input\.bin|mask-[0-7]\.png)$/.test(name)) throw new Error();
  const stat = await lstat(name);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== expectedBytes) throw new Error();
  return readFile(name);
}

function dimensions(value: unknown): { readonly width: number; readonly height: number } {
  if (!record(value) || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || (value.width as number) < 1 || (value.height as number) < 1) throw new Error();
  return { width: value.width as number, height: value.height as number };
}

async function writeExclusive(name: string, bytes: Uint8Array): Promise<void> {
  const file = await open(name, "wx", 0o600);
  try { await file.writeFile(bytes); } finally { await file.close(); }
}

async function render(): Promise<
  | { readonly ok: true; readonly renderer: RenderCapability; readonly outputs: readonly { readonly kind: Kind; readonly file: string; readonly width: number; readonly height: number }[] }
  | { readonly ok: false; readonly code: "unsupported_settings" | "renderer_unavailable" | "decoder_failed" | "invalid_output" }
> {
  let request: Request;
  try { request = await readRequest(); } catch { return { ok: false, code: "unsupported_settings" }; }
  let contract;
  let runtimeBundle;
  try {
    [contract, runtimeBundle] = await Promise.all([loadVerifiedContract(), loadVerifiedDevelopRuntime()]);
  } catch {
    return { ok: false, code: "renderer_unavailable" };
  }
  const { runtime, renderer } = runtimeBundle;

  let settings: Record<string, unknown>;
  let meta: JsonObject | undefined;
  try {
    const parsed: unknown = JSON.parse(request.canonicalSettings);
    if (!record(parsed) || !HASH.test(request.settingsSha256)
      || sha256(request.canonicalSettings) !== request.settingsSha256
      || !contract.supportsDevelopSettingsWrite(parsed) || !contract.readDevelopSettings(parsed)
      || !contract.isEditableDevelopSettings(parsed)) throw new Error();
    settings = parsed;
    if (request.input.kind === "original") {
      if (request.input.baseVersion !== null || request.input.metaJson !== null || settings.base !== null) throw new Error();
    } else {
      if (typeof request.input.baseVersion !== "string" || request.input.baseVersion.length === 0
        || typeof request.input.metaJson !== "string") throw new Error();
      const parsedMeta: unknown = JSON.parse(request.input.metaJson);
      if (!record(parsedMeta)) throw new Error();
      meta = parsedMeta as JsonObject;
      const compatible = contract.developSettingsOnWorkingCopy(settings, request.input.baseVersion, meta);
      if (!isDeepStrictEqual(compatible, settings)) throw new Error();
    }
    const errors: unknown = JSON.parse(runtime.validateSettings(request.canonicalSettings));
    if (!Array.isArray(errors) || errors.length !== 0) throw new Error();
  } catch {
    return { ok: false, code: "unsupported_settings" };
  }

  try {
    const spec = request.input;
    const byteLimit = spec.kind === "original"
      ? (spec.format === "jpeg" ? 64 * 1024 ** 2 : spec.format === "png" ? 10 * 1024 ** 2 : 0)
      : PHOTO_LIMITS.maxFileBytes;
    const pixelLimit = spec.kind === "original" ? PHOTO_LIMITS.browserDirectMaxPixels : PHOTO_LIMITS.maxPixels;
    if (spec.file !== "input.bin" || !HASH.test(spec.sha256) || !Number.isSafeInteger(spec.sizeBytes) || spec.sizeBytes < 1
      || spec.sizeBytes > byteLimit
      || !Number.isSafeInteger(spec.width) || !Number.isSafeInteger(spec.height) || spec.width < 1 || spec.height < 1
      || spec.width * spec.height > pixelLimit || (spec.kind === "workingCopy" && Math.max(spec.width, spec.height) > PHOTO_LIMITS.workingCopyMaxEdge)
      || !Number.isSafeInteger(spec.exportMaxEdge) || spec.exportMaxEdge < 1) throw new Error();
    const input = await regularFile(spec.file, spec.sizeBytes);
    if (sha256(input) !== spec.sha256) throw new Error();
    if (spec.format === "png" || spec.format === "png16") {
      const info = inspectPng(input, { allowExif: spec.kind === "original" });
      // Original PNG headers describe stored pixels; the SDK applies EXIF before imageSize below.
      // Canonical working copies already use their final pixel space and must not apply EXIF again.
      if (spec.format === "png16" && (info.width !== spec.width || info.height !== spec.height || info.bitDepth !== 16)) throw new Error();
    } else if (input[0] !== 0xff || input[1] !== 0xd8) throw new Error();
    const probed = dimensions(runtime.imageSize(input));
    if (probed.width !== spec.width || probed.height !== spec.height) throw new Error();

    const maskBytes: Array<{ readonly id: string; readonly bytes: Uint8Array }> = [];
    if (request.masks.length > 8) throw new Error();
    for (let index = 0; index < request.masks.length; index += 1) {
      const mask = request.masks[index]!;
      if (mask.file !== `mask-${index}.png` || !HASH.test(mask.id) || !Number.isSafeInteger(mask.sizeBytes)
        || mask.sizeBytes < 1 || mask.sizeBytes > PHOTO_LIMITS.maxMaskBytes || !Number.isSafeInteger(mask.width)
        || !Number.isSafeInteger(mask.height) || mask.width < 1 || mask.height < 1
        || Math.max(mask.width, mask.height) > PHOTO_LIMITS.maxMaskEdge) throw new Error();
      const bytes = await regularFile(mask.file, mask.sizeBytes);
      const info = inspectPng(bytes);
      if (sha256(bytes) !== mask.id || info.width !== mask.width || info.height !== mask.height) throw new Error();
      maskBytes.push({ id: mask.id, bytes });
    }

    const developer = spec.format === "png16"
      ? runtime.Developer.openWorkingCopy(input, JSON.stringify(meta))
      : new runtime.Developer(input, PHOTO_LIMITS.workingCopyMaxEdge);
    try {
      if (developer.width < 1 || developer.height < 1
        || developer.width > spec.width || developer.height > spec.height
        || Math.max(developer.width, developer.height) > Math.min(spec.exportMaxEdge, PHOTO_LIMITS.workingCopyMaxEdge)) throw new Error();
      for (const mask of maskBytes) {
        developer.setMaskSurface(mask.id, mask.bytes);
        if (!developer.hasMaskSurface(mask.id)) throw new Error();
      }
      const outputs: Array<{ readonly kind: Kind; readonly file: string; readonly width: number; readonly height: number }> = [];
      for (const [kind, policyEdge] of [["thumbnail", PHOTO_LIMITS.thumbnailMaxEdge], ["preview", PHOTO_LIMITS.previewMaxEdge]] as const) {
        const maxEdge = Math.min(policyEdge, spec.exportMaxEdge, Math.max(developer.width, developer.height));
        const raw = developer.exportPng(request.canonicalSettings, maxEdge);
        let output: Uint8Array;
        let info;
        let sdkInfo;
        try {
          output = markSrgbPng(raw);
          if (output.byteLength < 1 || output.byteLength > OUTPUT_LIMITS[kind]) throw new InvalidOutputError();
          info = inspectPng(output, { output: true });
          sdkInfo = dimensions(runtime.imageSize(output));
          if (info.srgbIntent !== 0 || info.width !== sdkInfo.width || info.height !== sdkInfo.height
            || Math.max(info.width, info.height) > maxEdge) throw new InvalidOutputError();
        } catch (error) {
          throw error instanceof InvalidOutputError ? error : new InvalidOutputError();
        }
        const file = `${kind}.png`;
        await writeExclusive(file, output);
        outputs.push({ kind, file, width: info.width, height: info.height });
      }
      return { ok: true, renderer, outputs };
    } finally {
      developer.free();
    }
  } catch (error) {
    return { ok: false, code: error instanceof InvalidOutputError ? "invalid_output" : "decoder_failed" };
  }
}

const result = await render();
process.stdout.write(JSON.stringify(result));
