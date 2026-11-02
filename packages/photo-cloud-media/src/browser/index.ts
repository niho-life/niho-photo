import { PHOTO_LIMITS } from "../../../photo-library-contract/src/v2.ts";
import type { PersonalPhotoCloudClient, Photo, PhotoAsset, PhotoSessionScope } from "../../../photo-library-contract/src/v2.ts";
import { selectCloudRenderInput } from "../index.ts";
import { CloudMediaError } from "../types.ts";
import type { CloudMediaErrorCode, CloudRenderSelection } from "../types.ts";
import type { LoadedCloudRenderInput, VerifiedMediaBytes } from "./types.ts";

export * from "./types.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_TIMEOUT_MS = 120_000;
const ERROR_CODES = new Set<CloudMediaErrorCode>([
  "invalid_input", "input_limit", "content_mismatch", "unsupported_settings", "renderer_unavailable",
  "decoder_failed", "invalid_output", "timeout", "cancelled",
]);
const boundedId = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && !/[\u0000-\u001f\u007f]/.test(value) && new TextEncoder().encode(value).byteLength <= 512;

function sameScope(current: PhotoSessionScope, captured: PhotoSessionScope): boolean {
  return current.actorId === captured.actorId && current.libraryId === captured.libraryId
    && current.sessionEpoch === captured.sessionEpoch;
}

function abortError(signal: AbortSignal): CloudMediaError {
  const code = signal.reason instanceof CloudMediaError && ERROR_CODES.has(signal.reason.code)
    ? signal.reason.code
    : "cancelled";
  return new CloudMediaError(code);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  let onAbort = (): void => {};
  let abandoned = false;
  let disposed = false;
  const dispose = (value: T): void => {
    if (disposed || !onLate) return;
    disposed = true;
    try { onLate(value); } catch { /* best-effort disposal must not cross the error boundary */ }
  };
  void promise.then((value) => { if (abandoned) dispose(value); }, () => {});
  try {
    const value = await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          abandoned = true;
          reject(abortError(signal));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (abandoned) {
      dispose(value);
      throw abortError(signal);
    }
    return value;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function sanitize(error: unknown, signal?: AbortSignal): CloudMediaError {
  if (signal?.aborted) return abortError(signal);
  if (error instanceof CloudMediaError && ERROR_CODES.has(error.code)) return new CloudMediaError(error.code);
  return new CloudMediaError("content_mismatch");
}

function cancelContent(value: unknown): void {
  if (!value || typeof value !== "object" || !("body" in value)) return;
  const body = value.body;
  if (!body || typeof body !== "object" || typeof (body as { cancel?: unknown }).cancel !== "function") return;
  try { void Promise.resolve((body as { cancel(): unknown }).cancel()).catch(() => {}); } catch { /* best effort */ }
}

/** Read one complete immutable asset with scope, range, byte, type and digest fences. */
export async function readVerifiedMediaAsset(
  client: PersonalPhotoCloudClient,
  photoId: string,
  asset: PhotoAsset,
  options: { readonly maxBytes: number; readonly timeoutMs: number; readonly signal: AbortSignal },
): Promise<VerifiedMediaBytes> {
  const expected = Object.freeze({ ...asset });
  const limits = Object.freeze({ maxBytes: options.maxBytes, timeoutMs: options.timeoutMs });
  const externalSignal = options.signal;
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > PHOTO_LIMITS.maxFileBytes
    || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > MAX_TIMEOUT_MS
    || !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 1 || expected.sizeBytes > limits.maxBytes
    || !SHA256.test(expected.sha256) || !boundedId(expected.id) || !boundedId(photoId)) {
    throw new CloudMediaError(expected.sizeBytes > limits.maxBytes ? "input_limit" : "invalid_input");
  }
  const captured = { ...client.scope };
  const assertScope = (): void => {
    const current = client.scope;
    if (externalSignal.aborted) throw new CloudMediaError("cancelled");
    if (!sameScope(current, captured)) throw new CloudMediaError("content_mismatch");
  };
  assertScope();
  if (externalSignal.aborted) throw new CloudMediaError("cancelled");

  const controller = new AbortController();
  let timedOut = false;
  let completed = false;
  let released = false;
  let output: Uint8Array<ArrayBuffer> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let responseForCleanup: unknown = null;
  const cancel = (): void => {
    controller.abort(new CloudMediaError("cancelled"));
    if (completed) release();
  };
  externalSignal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new CloudMediaError("timeout"));
  }, limits.timeoutMs);
  const release = (): void => {
    if (released) return;
    released = true;
    try { output?.fill(0); } catch { /* transferred/detached buffers are already inaccessible */ }
    clearTimeout(timer);
    externalSignal.removeEventListener("abort", cancel);
  };
  try {
    assertScope();
    const responsePromise = client.request("content.get", {
      photoId,
      assetId: expected.id,
      range: { start: 0, endInclusive: expected.sizeBytes - 1 },
    }, { signal: controller.signal });
    const response = await abortable(responsePromise, controller.signal, cancelContent);
    responseForCleanup = response;
    assertScope();
    if (response.sha256 !== expected.sha256 || response.totalBytes !== expected.sizeBytes
      || response.contentType !== expected.contentType || response.range.start !== 0
      || response.range.endInclusive !== expected.sizeBytes - 1) throw new CloudMediaError("content_mismatch");

    output = new Uint8Array(expected.sizeBytes);
    reader = response.body.getReader();
    let offset = 0;
    while (true) {
      assertScope();
      const result = await abortable(reader.read(), controller.signal);
      assertScope();
      if (result.done) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || offset + chunk.byteLength > output.byteLength) {
        throw new CloudMediaError("content_mismatch");
      }
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== output.byteLength) throw new CloudMediaError("content_mismatch");
    assertScope();
    if (!globalThis.crypto?.subtle) throw new CloudMediaError("renderer_unavailable");
    const digest = new Uint8Array(await abortable(globalThis.crypto.subtle.digest("SHA-256", output), controller.signal));
    assertScope();
    const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== expected.sha256) throw new CloudMediaError("content_mismatch");
    reader.releaseLock();
    reader = null;
    clearTimeout(timer);
    completed = true;
    const bytes = output.buffer;
    return { bytes, release };
  } catch (error) {
    release();
    if (reader) {
      try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
      try { reader.releaseLock(); } catch { /* a pending hostile read keeps the lock until it settles */ }
    } else cancelContent(responseForCleanup);
    if (timedOut) throw new CloudMediaError("timeout");
    throw sanitize(error, controller.signal);
  }
}

/** Select metadata first, then fetch exactly the selected immutable asset. */
export async function loadCloudRenderInput(
  client: PersonalPhotoCloudClient,
  photo: Photo,
  options: {
    readonly recipeWritable: boolean;
    readonly maxBytes: number;
    readonly maxPixels: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  },
): Promise<LoadedCloudRenderInput | Extract<CloudRenderSelection, { readonly state: "unavailable" }>> {
  const captured = { ...client.scope };
  if (captured.libraryId !== photo.libraryId || !sameScope(client.scope, captured)) throw new CloudMediaError("content_mismatch");
  const selection = selectCloudRenderInput(photo, options);
  if (selection.state === "unavailable") return selection;
  const verified = await readVerifiedMediaAsset(client, photo.id, selection.input.asset, options);
  if (selection.input.libraryId !== captured.libraryId || !sameScope(client.scope, captured)) {
    verified.release();
    throw new CloudMediaError("content_mismatch");
  }
  return { input: selection.input, bytes: verified.bytes, release: verified.release };
}
