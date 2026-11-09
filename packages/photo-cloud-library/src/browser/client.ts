import {
  PHOTO_LIMITS,
  type PersonalPhotoCloudClient,
  type PhotoContent,
  type PhotoOperation,
  type PhotoOperationMap,
  type PhotoRequestOptions,
  type VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";
import { samePhotoIdentityScope } from "@niho/photo-cloud-session";

import { PersonalPhotoCloudError } from "../errors";
import { awaitBounded, cancelResponse, linkedAbortController } from "../await";
import { PersonalPhotoScope } from "../scope";
import type { PersonalPhotoCloudIdentity } from "../types";
import { validateLibrary } from "../validation";
import {
  JSON_LIMITS,
  PHOTO_CAPTURE_HEADERS,
  PHOTO_CLOUD_PATH_PREFIX,
  PHOTO_CONTENT_HEADERS,
  PHOTO_IDEMPOTENCY_HEADER,
  TRANSPORT_TIMEOUT_MS,
  TRUSTED_GCS_UPLOAD_ORIGIN,
  encodeOperation,
  parsePhotoError,
  readBoundedJson,
  responseJsonLimit,
  validateOperationResponse,
  validateResponseTickets,
  type WireOperation,
} from "../wire";

export interface CreateBrowserPersonalPhotoCloudClientOptions {
  readonly identity: PersonalPhotoCloudIdentity;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly pathPrefix?: typeof PHOTO_CLOUD_PATH_PREFIX;
}

export async function createBrowserPersonalPhotoCloudClient(
  options: CreateBrowserPersonalPhotoCloudClientOptions,
): Promise<PersonalPhotoCloudClient> {
  const actor = options.identity.getSnapshot();
  const now = options.now ?? Date.now;
  if (actor === null || actor.transport !== "browser-session" || Date.parse(actor.expiresAt) <= now()) invalidIdentity();
  const fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
  const prefix = options.pathPrefix ?? PHOTO_CLOUD_PATH_PREFIX;
  if (prefix !== PHOTO_CLOUD_PATH_PREFIX) throw new PersonalPhotoCloudError("invalid_identity");
  const lifecycle = new AbortController();
  const probeLink = linkedAbortController(lifecycle.signal);
  let probeInvalid = false;
  const unsubscribeProbe = options.identity.subscribe(() => {
    const next = options.identity.getSnapshot();
    if (next === null || !samePhotoIdentityScope(actor, next)) {
      probeInvalid = true;
      probeLink.controller.abort(new PersonalPhotoCloudError("scope_changed"));
    }
  });
  let libraryId: string;
  try {
    const response = await fetchWithHeaderDeadline(fetchFn, `${prefix}/library`, requestInit(actor, "GET", null, null, null, probeLink.controller.signal), lifecycle.signal, probeLink.controller);
    const raw = await readJsonResponse(response, "library.get", probeLink.controller.signal);
    if (!isRecord(raw) || typeof raw.id !== "string") throw new PersonalPhotoCloudError("invalid_response");
    const library = validateLibrary(raw as never, actor.userId, raw.id);
    const current = options.identity.getSnapshot();
    if (probeInvalid || current === null || !samePhotoIdentityScope(actor, current)) throw new PersonalPhotoCloudError("scope_changed");
    libraryId = library.id;
  } finally {
    unsubscribeProbe();
    probeLink.dispose();
  }

  let scope: PersonalPhotoScope;
  let disposed = false;
  const client: PersonalPhotoCloudClient = {
    scope: Object.freeze({ actorId: actor.userId, libraryId, sessionEpoch: actor.sessionEpoch }),
    async request<K extends PhotoOperation>(operation: K, request: PhotoOperationMap[K]["request"], requestOptions: PhotoRequestOptions<K>): Promise<PhotoOperationMap[K]["response"]> {
      if (disposed) throw new PersonalPhotoCloudError("disposed");
      const scoped = scope.begin(requestOptions.signal);
      let transportDispose = (): void => undefined;
      let contentOwnsScope = false;
      try {
        const encoded = encodeOperation(operation, request, "idempotencyKey" in requestOptions ? requestOptions.idempotencyKey : undefined);
        const capture = options.identity.getSnapshot();
        if (capture === null) throw new PersonalPhotoCloudError("scope_changed");
        const url = `${prefix}${encoded.suffix}${encoded.query === "" ? "" : `?${encoded.query}`}`;
        const link = linkedAbortController(scoped.signal);
        transportDispose = link.dispose;
        const response = await fetchWithHeaderDeadline(fetchFn, url, requestInit(capture, encoded.method, encoded.body, encoded.range, encoded.idempotencyKey, link.controller.signal), scoped.signal, link.controller);
        scoped.assertCurrent();
        if (operation === "content.get") {
          const content = await parseContentResponse(response, request as PhotoOperationMap["content.get"]["request"], scoped, link.controller, link.dispose);
          contentOwnsScope = true;
          return content as PhotoOperationMap[K]["response"];
        }
        const raw = await readJsonResponse(response, encoded.operation, scoped.signal);
        scoped.assertCurrent();
        const checked = validateOperationResponse(encoded.operation, raw, actor.userId, libraryId, encoded.responseContext);
        validateResponseTickets(encoded.operation, raw, encoded.responseContext, TRUSTED_GCS_UPLOAD_ORIGIN, now());
        return checked as PhotoOperationMap[K]["response"];
      } catch (error) {
        if (isErrorEnvelope(error) && error.error.code === "unauthenticated") scope.invalidateAuthentication();
        throw error;
      } finally {
        if (!contentOwnsScope) {
          transportDispose();
          scoped.release();
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifecycle.abort(new PersonalPhotoCloudError("disposed"));
      scope.dispose();
    },
  };
  scope = new PersonalPhotoScope(client, options.identity, now);
  return client;
}

/** Same-origin request with the captured session headers; shared with the shared-album client. */
export function requestInit(
  actor: VerifiedPhotoActor,
  method: string,
  body: Uint8Array<ArrayBuffer> | null,
  range: string | null,
  key: string | null,
  signal: AbortSignal,
): RequestInit {
  const headers = new Headers({
    [PHOTO_CAPTURE_HEADERS.actorId]: actor.userId,
    [PHOTO_CAPTURE_HEADERS.sessionId]: actor.sessionId,
    [PHOTO_CAPTURE_HEADERS.sessionEpoch]: actor.sessionEpoch,
  });
  if (body !== null) headers.set("Content-Type", "application/json");
  if (range !== null) headers.set("Range", range);
  if (key !== null) headers.set(PHOTO_IDEMPOTENCY_HEADER, key);
  return {
    method, headers, body, signal, cache: "no-store", credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer",
  };
}

async function readJsonResponse(response: Response, operation: WireOperation, signal: AbortSignal): Promise<unknown> {
  if (response.status >= 200 && response.status < 300) {
    const { value } = await readBoundedJson(response, responseJsonLimit(operation), signal);
    return value;
  }
  const { value } = await readBoundedJson(response, JSON_LIMITS.error, signal);
  throw parsePhotoError(value, response.status);
}

/** Bounded, hash-labelled content stream (also used for shared-album downloads, which share the content headers). */
export async function parseContentResponse(
  response: Response,
  request: Pick<PhotoOperationMap["content.get"]["request"], "range">,
  scope: ReturnType<PersonalPhotoScope["begin"]>,
  controller: AbortController,
  disposeTransport: () => void,
): Promise<PhotoContent> {
  if (!response.ok) {
    try { const { value } = await readBoundedJson(response, JSON_LIMITS.error, scope.signal); throw parsePhotoError(value, response.status); }
    finally { disposeTransport(); scope.release(); }
  }
  try {
    if (response.status !== 200 && response.status !== 206) throw new PersonalPhotoCloudError("invalid_response");
    const totalBytes = strictIntegerHeader(response.headers, PHOTO_CONTENT_HEADERS.totalBytes);
    const sha256 = response.headers.get(PHOTO_CONTENT_HEADERS.sha256);
    const contentLength = strictIntegerHeader(response.headers, "Content-Length");
    const contentType = response.headers.get("Content-Type");
    if (sha256 === null || !/^[0-9a-f]{64}$/u.test(sha256) || contentType === null || contentType.includes(",") || totalBytes <= 0 || totalBytes > PHOTO_LIMITS.maxFileBytes || response.body === null) throw new PersonalPhotoCloudError("invalid_response");
    let start: number;
    let endInclusive: number;
    if (response.status === 200) {
      if (request.range !== undefined || response.headers.has("Content-Range")) throw new PersonalPhotoCloudError("invalid_response");
      start = 0; endInclusive = totalBytes - 1;
    } else {
      if (request.range === undefined) throw new PersonalPhotoCloudError("invalid_response");
      const parsed = parseContentRange(response.headers.get("Content-Range"));
      if (parsed === null || parsed.total !== totalBytes || parsed.start !== request.range.start || (request.range.endInclusive !== undefined && parsed.endInclusive !== request.range.endInclusive)) throw new PersonalPhotoCloudError("invalid_response");
      start = parsed.start; endInclusive = parsed.endInclusive;
    }
    const expected = endInclusive - start + 1;
    if (contentLength !== expected) throw new PersonalPhotoCloudError("invalid_response");
    return {
      body: checkedStream(response.body, expected, scope, controller, disposeTransport), contentType, sha256, totalBytes, range: { start, endInclusive },
    };
  } catch (error) {
    void response.body?.cancel(error).catch(() => undefined);
    disposeTransport();
    scope.release();
    throw error;
  }
}

function checkedStream(
  source: ReadableStream<Uint8Array>,
  expectedBytes: number,
  scope: ReturnType<PersonalPhotoScope["begin"]>,
  lifecycle: AbortController,
  disposeTransport: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let received = 0;
  let empty = 0;
  let finished = false;
  let output: ReadableStreamDefaultController<Uint8Array> | null = null;
  const finish = (): void => { if (!finished) { finished = true; scope.signal.removeEventListener("abort", abort); disposeTransport(); scope.release(); try { reader.releaseLock(); } catch { /* pending read */ } } };
  function abort(): void { const error = scope.signal.reason instanceof Error ? scope.signal.reason : new DOMException("Aborted", "AbortError"); void reader.cancel(error).catch(() => undefined); finish(); try { output?.error(error); } catch { /* consumer already cancelled */ } }
  return new ReadableStream<Uint8Array>({
    start(controller) { output = controller; scope.signal.addEventListener("abort", abort, { once: true }); if (scope.signal.aborted) abort(); },
    async pull(controller) {
      try {
        while (true) {
          scope.assertCurrent();
          const result = await idleRead(reader, scope.signal);
          scope.assertCurrent();
          if (result.done) {
            if (received !== expectedBytes) throw new PersonalPhotoCloudError("invalid_response");
            finish(); controller.close(); return;
          }
          if (!(result.value instanceof Uint8Array)) throw new PersonalPhotoCloudError("invalid_response");
          if (result.value.byteLength === 0) { if (++empty > 64) throw new PersonalPhotoCloudError("invalid_response"); continue; }
          empty = 0;
          const nextTotal = received + result.value.byteLength;
          if (nextTotal > expectedBytes) throw new PersonalPhotoCloudError("invalid_response");
          if (nextTotal < expectedBytes) {
            received = nextTotal;
            controller.enqueue(result.value);
            return;
          }
          const finalChunk = result.value;
          const terminal = await nextMeaningfulRead(reader, scope.signal);
          scope.assertCurrent();
          if (!terminal.done) throw new PersonalPhotoCloudError("invalid_response");
          received = nextTotal;
          controller.enqueue(finalChunk);
          finish();
          controller.close();
          return;
        }
      } catch (error) {
        lifecycle.abort(error); void reader.cancel(error).catch(() => undefined); finish(); controller.error(error);
      }
    },
    cancel(reason) { lifecycle.abort(reason); void reader.cancel(reason).catch(() => undefined); finish(); },
  });
}

/** Bounds the wait for response headers (TRANSPORT_TIMEOUT_MS) and cancels a late response. */
export async function fetchWithHeaderDeadline(fetchFn: typeof fetch, url: string, init: RequestInit, signal: AbortSignal, controller: AbortController): Promise<Response> {
  return await awaitBounded(Promise.resolve().then(async () => await fetchFn(url, init)), {
    signal,
    timeoutMs: TRANSPORT_TIMEOUT_MS,
    onTimeout: () => controller.abort(new PersonalPhotoCloudError("unavailable")),
    onLateResolve: cancelResponse,
  });
}
async function idleRead(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  return await awaitBounded(reader.read(), {
    signal,
    timeoutMs: TRANSPORT_TIMEOUT_MS,
    onTimeout: () => { void reader.cancel(new PersonalPhotoCloudError("unavailable")).catch(() => undefined); },
  });
}
async function nextMeaningfulRead(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  let empty = 0;
  while (true) {
    const result = await idleRead(reader, signal);
    if (result.done || !(result.value instanceof Uint8Array) || result.value.byteLength > 0) return result;
    if (++empty > 64) throw new PersonalPhotoCloudError("invalid_response");
  }
}
function strictIntegerHeader(headers: Headers, name: string): number {
  const value = headers.get(name);
  if (value === null || !/^\d+$/u.test(value) || value.includes(",")) throw new PersonalPhotoCloudError("invalid_response");
  const number = Number(value); if (!Number.isSafeInteger(number)) throw new PersonalPhotoCloudError("invalid_response"); return number;
}
function parseContentRange(value: string | null): { start: number; endInclusive: number; total: number } | null {
  if (value === null || value.includes(",")) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value); if (!match) return null;
  const start = Number(match[1]); const endInclusive = Number(match[2]); const total = Number(match[3]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(endInclusive) && Number.isSafeInteger(total) && start >= 0 && endInclusive >= start && endInclusive < total ? { start, endInclusive, total } : null;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isErrorEnvelope(value: unknown): value is { error: { code: string } } { return isRecord(value) && isRecord(value.error) && typeof value.error.code === "string"; }
function invalidIdentity(): never { throw new PersonalPhotoCloudError("invalid_identity"); }
