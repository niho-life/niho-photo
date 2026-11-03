import type {
  PersonalPhotoCloudClient,
  PhotoAsset,
  PhotoByteRange,
  PhotoContent,
} from "@niho/photo-personal-cloud-contract";

import { PersonalPhotoCloudError, publicError, readPhotoError } from "./errors";
import type { PersonalPhotoScope } from "./scope";
import { validateAsset } from "./validation";

const MAX_CONSECUTIVE_EMPTY_CHUNKS = 64;

export async function readCheckedAsset(
  client: PersonalPhotoCloudClient,
  scope: PersonalPhotoScope,
  photoId: string,
  asset: PhotoAsset,
  range: PhotoByteRange | undefined,
  externalSignal: AbortSignal | undefined,
  onRelease: (() => void) | undefined = undefined,
): Promise<PhotoContent> {
  validateAsset(asset);
  if (typeof photoId !== "string" || photoId.length === 0) throw invalidResponse();
  const expected = expectedRange(asset.sizeBytes, range);
  const request = scope.begin(externalSignal);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    request.release();
    onRelease?.();
  };
  let rawResponse: unknown;
  try {
    const response = client.request(
      "content.get",
      range === undefined ? { photoId, assetId: asset.id } : { photoId, assetId: asset.id, range },
      { signal: request.signal },
    );
    rawResponse = await responseBeforeAbort(response, request.signal);
  } catch (error) {
    const aborted = error instanceof ContentResponseAborted;
    const cause = aborted ? error.reason : error;
    if (!aborted && readPhotoError(cause)?.code === "unauthenticated") scope.invalidateAuthentication();
    const safe = publicError(cause);
    release();
    throw safe;
  }

  try {
    request.assertCurrent();
  } catch (error) {
    cancelResponseBody(rawResponse, error);
    release();
    throw publicError(error);
  }

  if (!isValidContentResponse(rawResponse, asset, expected)) {
    cancelResponseBody(rawResponse, invalidResponse());
    release();
    throw invalidResponse();
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = rawResponse.body.getReader();
  } catch {
    cancelResponseBody(rawResponse, invalidResponse());
    release();
    throw invalidResponse();
  }

  const expectedBytes = expected.endInclusive - expected.start + 1;
  let receivedBytes = 0;
  let finished = false;
  let output: ReadableStreamDefaultController<Uint8Array> | null = null;

  const releaseReader = (): void => {
    try {
      reader.releaseLock();
    } catch {
      // A pending provider read owns the lock until its ignored promise settles.
    }
  };
  const finish = (): void => {
    if (finished) return;
    finished = true;
    request.signal.removeEventListener("abort", abortActiveRead);
    release();
    releaseReader();
  };
  const cancelReader = (reason: unknown): void => {
    let cancellation: Promise<void>;
    try {
      cancellation = reader.cancel(reason);
    } catch {
      releaseReader();
      return;
    }
    void cancellation.then(releaseReader, releaseReader);
  };
  const fail = (reason: unknown): void => {
    if (finished) return;
    const authenticationFailure = readPhotoError(reason)?.code === "unauthenticated";
    const safe = publicError(reason);
    cancelReader(safe);
    finish();
    if (authenticationFailure) scope.invalidateAuthentication();
    try {
      output?.error(safe);
    } catch {
      // The consumer may already have cancelled the wrapper.
    }
  };
  function abortActiveRead(): void {
    fail(abortReason(request.signal));
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      if (request.signal.aborted) abortActiveRead();
    },
    async pull(controller) {
      if (finished) return;
      try {
        request.assertCurrent();
        const result = await readMeaningful(reader, request.assertCurrent, MAX_CONSECUTIVE_EMPTY_CHUNKS);
        if (finished) return;
        if (result.done) {
          if (receivedBytes !== expectedBytes) throw invalidResponse();
          finish();
          controller.close();
          return;
        }
        const nextTotal = receivedBytes + result.value.byteLength;
        if (nextTotal > expectedBytes) throw invalidResponse();
        if (nextTotal === expectedBytes) {
          const terminal = await readMeaningful(reader, request.assertCurrent, MAX_CONSECUTIVE_EMPTY_CHUNKS);
          if (!terminal.done) throw invalidResponse();
        }
        receivedBytes = nextTotal;
        controller.enqueue(result.value);
        if (receivedBytes === expectedBytes) {
          finish();
          controller.close();
        }
      } catch (error) {
        fail(error);
      }
    },
    cancel(reason) {
      cancelReader(reason);
      finish();
    },
  });

  request.signal.addEventListener("abort", abortActiveRead, { once: true });
  if (request.signal.aborted) abortActiveRead();

  return {
    body,
    contentType: rawResponse.contentType,
    sha256: rawResponse.sha256,
    totalBytes: rawResponse.totalBytes,
    range: rawResponse.range,
  };
}

async function responseBeforeAbort<T>(response: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    const reason = abortReason(signal);
    void response.then((late) => cancelResponseBody(late, reason), () => undefined);
    throw new ContentResponseAborted(reason);
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      const reason = abortReason(signal);
      void response.then((late) => cancelResponseBody(late, reason), () => undefined);
      reject(new ContentResponseAborted(reason));
    };
    signal.addEventListener("abort", abort, { once: true });
    void response.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

class ContentResponseAborted {
  constructor(readonly reason: unknown) {}
}

/** Exact-size preallocation; chunks are copied once and are not retained. */
export async function contentBytes(content: PhotoContent): Promise<Uint8Array<ArrayBuffer>> {
  const length = content.range.endInclusive - content.range.start + 1;
  const bytes = new Uint8Array(new ArrayBuffer(length));
  const reader = content.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        if (offset !== length) throw invalidResponse();
        return bytes;
      }
      if (!(result.value instanceof Uint8Array) || offset + result.value.byteLength > length) throw invalidResponse();
      bytes.set(result.value, offset);
      offset += result.value.byteLength;
    }
  } catch (error) {
    try {
      void reader.cancel(error).catch(() => undefined);
    } catch {
      // Preserve the safe read error.
    }
    throw publicError(error);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may still be settling in an uncooperative provider.
    }
  }
}

async function readMeaningful(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  assertCurrent: () => void,
  maximumEmptyChunks: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  for (let emptyChunks = 0; emptyChunks <= maximumEmptyChunks; emptyChunks += 1) {
    const result = await reader.read();
    assertCurrent();
    if (result.done) return result;
    if (!(result.value instanceof Uint8Array)) throw invalidResponse();
    if (result.value.byteLength > 0) return result;
  }
  throw invalidResponse();
}

function isValidContentResponse(
  value: unknown,
  asset: PhotoAsset,
  expected: { start: number; endInclusive: number },
): value is PhotoContent {
  if (!isRecord(value) || !isRecord(value.range)) return false;
  return (
    value.body instanceof ReadableStream &&
    value.sha256 === asset.sha256 &&
    value.contentType === asset.contentType &&
    value.totalBytes === asset.sizeBytes &&
    Number.isSafeInteger(value.range.start) &&
    Number.isSafeInteger(value.range.endInclusive) &&
    value.range.start === expected.start &&
    value.range.endInclusive === expected.endInclusive
  );
}

function expectedRange(sizeBytes: number, range: unknown): { start: number; endInclusive: number } {
  if (range === undefined) return { start: 0, endInclusive: sizeBytes - 1 };
  if (!isRecord(range)) throw invalidResponse();
  const start = range.start;
  const endInclusive = range.endInclusive ?? sizeBytes - 1;
  if (
    typeof start !== "number" ||
    typeof endInclusive !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endInclusive) ||
    start < 0 ||
    endInclusive < start ||
    endInclusive >= sizeBytes
  ) {
    throw invalidResponse();
  }
  return { start, endInclusive };
}

function cancelResponseBody(value: unknown, reason: unknown): void {
  if (!isRecord(value) || !(value.body instanceof ReadableStream)) return;
  try {
    void value.body.cancel(reason).catch(() => undefined);
  } catch {
    // Invalid or locked late bodies must not replace the adapter error.
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function invalidResponse(): PersonalPhotoCloudError {
  return new PersonalPhotoCloudError("invalid_response");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
