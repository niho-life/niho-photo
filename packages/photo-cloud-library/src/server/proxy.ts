import { PHOTO_LIMITS, type PhotoErrorCode } from "@niho/photo-personal-cloud-contract";
import {
  NIHO_PRODUCTION_ORIGIN,
  PhotoAuthorizationError,
  type CapturedPhotoActor,
  type PhotoAuthService,
} from "@niho/photo-cloud-session/server";

import { PersonalPhotoCloudError } from "../errors";
import { abortReason, awaitBounded, cancelResponse, linkedAbortController } from "../await";
import {
  JSON_LIMITS,
  PHOTO_CAPTURE_HEADERS,
  PHOTO_CONTENT_HEADERS,
  PHOTO_IDEMPOTENCY_HEADER,
  TRANSPORT_TIMEOUT_MS,
  TRUSTED_GCS_UPLOAD_ORIGIN,
  parseIncomingOperation,
  parsePhotoError,
  readAndEncodeIncomingBody,
  readBoundedJson,
  responseJsonLimit,
  validateOperationResponse,
  validateResponseTickets,
  type EncodedOperation,
} from "../wire";

export const PERSONAL_PHOTO_CLOUD_HOST_LIMITS = Object.freeze({
  maxResponseBytes: PHOTO_LIMITS.maxFileBytes,
  requestTimeoutMs: 600_000,
});

export interface CreatePersonalPhotoCloudProxyOptions {
  readonly authService: Pick<PhotoAuthService, "withAuthorizedCredential">;
  readonly upstreamOrigin: typeof NIHO_PRODUCTION_ORIGIN;
  readonly upstreamPathPrefix: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly trustedUploadOrigin?: typeof TRUSTED_GCS_UPLOAD_ORIGIN;
}

export function createPersonalPhotoCloudProxy(
  options: CreatePersonalPhotoCloudProxyOptions,
): (request: Request) => Promise<Response | null> {
  const prefix = validateStartup(options);
  const fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
  const now = options.now ?? Date.now;
  const trustedUploadOrigin = options.trustedUploadOrigin ?? TRUSTED_GCS_UPLOAD_ORIGIN;
  return async (request): Promise<Response | null> => {
    try {
      const route = parseIncomingOperation(request);
      if (route === null) return null;
      const encoded = await readAndEncodeIncomingBody(request, route);
      const capture = readCapture(request.headers);
      let upstream: Response;
      const dispatchLink = linkedAbortController(request.signal);
      try {
        const authorized = options.authService.withAuthorizedCredential(request, capture, async (credential, actor) => {
          if (dispatchLink.controller.signal.aborted) throw abortReason(dispatchLink.controller.signal);
          const headers = new Headers({
            Authorization: `Bearer ${credential}`,
            [PHOTO_CAPTURE_HEADERS.actorId]: actor.userId,
            [PHOTO_CAPTURE_HEADERS.sessionId]: actor.sessionId,
            [PHOTO_CAPTURE_HEADERS.sessionEpoch]: actor.sessionEpoch,
          });
          if (encoded.body !== null) headers.set("Content-Type", "application/json");
          if (encoded.range !== null) headers.set("Range", encoded.range);
          if (encoded.idempotencyKey !== null) headers.set(PHOTO_IDEMPOTENCY_HEADER, encoded.idempotencyKey);
          return await awaitBounded(Promise.resolve().then(async () => await fetchFn(`${options.upstreamOrigin}${prefix}${encoded.suffix}${encoded.query === "" ? "" : `?${encoded.query}`}`, {
              method: encoded.method,
              headers,
              body: encoded.body,
              signal: dispatchLink.controller.signal,
              cache: "no-store",
              credentials: "omit",
              redirect: "manual",
              referrerPolicy: "no-referrer",
            })), {
            signal: dispatchLink.controller.signal,
            timeoutMs: TRANSPORT_TIMEOUT_MS,
            onTimeout: () => dispatchLink.controller.abort(new PersonalPhotoCloudError("unavailable")),
            onLateResolve: cancelResponse,
          });
        });
        upstream = await awaitBounded(authorized, {
          signal: request.signal,
          timeoutMs: TRANSPORT_TIMEOUT_MS,
          onTimeout: () => dispatchLink.controller.abort(new PersonalPhotoCloudError("unavailable")),
          onLateResolve: cancelResponse,
        });
      } catch (error) {
        return authorizationError(error);
      } finally { dispatchLink.dispose(); }
      if (encoded.operation === "content.get") return await publishContent(request, capture, encoded, upstream, options.authService);
      const limit = upstream.ok ? responseJsonLimit(encoded.operation) : JSON_LIMITS.error;
      let parsed: { readonly bytes: Uint8Array<ArrayBuffer>; readonly value: unknown };
      try { parsed = await readBoundedJson(upstream, limit, request.signal); }
      catch { void upstream.body?.cancel().catch(() => undefined); return closedError("temporarily_unavailable", 503); }
      try {
        if (upstream.ok) {
          const libraryId = responseLibraryId(parsed.value);
          validateOperationResponse(encoded.operation, parsed.value, capture.userId, libraryId, encoded.responseContext);
          validateResponseTickets(encoded.operation, parsed.value, encoded.responseContext, trustedUploadOrigin, now());
        } else parsePhotoError(parsed.value, upstream.status);
        await awaitAuthorization(options.authService, request, capture);
      } catch (error) {
        void upstream.body?.cancel().catch(() => undefined);
        return error instanceof PhotoAuthorizationError ? authorizationError(error) : closedError("temporarily_unavailable", 503);
      }
      return new Response(parsed.bytes, {
        status: upstream.status,
        headers: { "Cache-Control": "no-store", "Content-Type": "application/json", "Referrer-Policy": "no-referrer" },
      });
    } catch {
      return closedError("invalid_request", 400);
    }
  };
}

async function publishContent(
  request: Request,
  capture: CapturedPhotoActor,
  encoded: EncodedOperation,
  upstream: Response,
  auth: Pick<PhotoAuthService, "withAuthorizedCredential">,
): Promise<Response> {
  if (!upstream.ok) {
    try {
      const parsed = await readBoundedJson(upstream, JSON_LIMITS.error, request.signal);
      parsePhotoError(parsed.value, upstream.status);
      await awaitAuthorization(auth, request, capture);
      return new Response(parsed.bytes, { status: upstream.status, headers: jsonHeaders() });
    } catch (error) { void upstream.body?.cancel().catch(() => undefined); return error instanceof PhotoAuthorizationError ? authorizationError(error) : closedError("temporarily_unavailable", 503); }
  }
  if ((upstream.status !== 200 && upstream.status !== 206) || upstream.body === null) { void upstream.body?.cancel().catch(() => undefined); return closedError("temporarily_unavailable", 503); }
  const metadata = parseContentMetadata(upstream, encoded.range);
  if (metadata === null) { void upstream.body.cancel().catch(() => undefined); return closedError("temporarily_unavailable", 503); }
  try { await awaitAuthorization(auth, request, capture); }
  catch (error) { void upstream.body.cancel().catch(() => undefined); return authorizationError(error); }
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Length": String(metadata.length),
    "Content-Type": metadata.contentType,
    [PHOTO_CONTENT_HEADERS.sha256]: metadata.sha256,
    [PHOTO_CONTENT_HEADERS.totalBytes]: String(metadata.totalBytes),
    "Referrer-Policy": "no-referrer",
  });
  if (metadata.contentRange !== null) headers.set("Content-Range", metadata.contentRange);
  return new Response(boundStream(upstream.body, metadata.length, request.signal), { status: upstream.status, headers });
}

function parseContentMetadata(response: Response, requestedRange: string | null): {
  readonly length: number; readonly totalBytes: number; readonly sha256: string; readonly contentType: string; readonly contentRange: string | null;
} | null {
  const length = integerHeader(response.headers, "Content-Length");
  const totalBytes = integerHeader(response.headers, PHOTO_CONTENT_HEADERS.totalBytes);
  const sha256 = response.headers.get(PHOTO_CONTENT_HEADERS.sha256);
  const contentType = response.headers.get("Content-Type");
  if (length === null || totalBytes === null || totalBytes <= 0 || totalBytes > PHOTO_LIMITS.maxFileBytes || sha256 === null || !/^[0-9a-f]{64}$/u.test(sha256) || contentType === null || contentType.includes(",")) return null;
  if (response.status === 200) return requestedRange === null && length === totalBytes && !response.headers.has("Content-Range") ? { length, totalBytes, sha256, contentType, contentRange: null } : null;
  if (requestedRange === null) return null;
  const range = /^bytes=(\d+)-(\d*)$/u.exec(requestedRange);
  const contentRange = response.headers.get("Content-Range");
  const actual = contentRange === null ? null : /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange);
  if (!range || !actual) return null;
  const start = Number(actual[1]); const end = Number(actual[2]); const total = Number(actual[3]);
  const requestedEnd = range[2] === "" ? null : Number(range[2]);
  if (![start, end, total].every(Number.isSafeInteger) || start !== Number(range[1]) || (requestedEnd !== null && end !== requestedEnd) || total !== totalBytes || end < start || end >= total || length !== end - start + 1) return null;
  return { length, totalBytes, sha256, contentType, contentRange };
}

function boundStream(source: ReadableStream<Uint8Array>, expected: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = source.getReader(); let read = 0; let empty = 0; let output: ReadableStreamDefaultController<Uint8Array> | null = null; let finished = false;
  const finish = (): void => { if (!finished) { finished = true; signal.removeEventListener("abort", abort); try { reader.releaseLock(); } catch { /* pending read */ } } };
  function abort(): void { void reader.cancel().catch(() => undefined); finish(); try { output?.error(new PersonalPhotoCloudError("unavailable")); } catch { /* consumer already cancelled */ } }
  return new ReadableStream({
    start(controller) { output = controller; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    async pull(controller) {
      try {
        while (true) {
          const item = await idleRead(reader, signal);
          if (item.done) { if (read !== expected) throw new Error("short"); finish(); controller.close(); return; }
          if (!(item.value instanceof Uint8Array)) throw new Error("chunk");
          if (item.value.byteLength === 0) { if (++empty > 64) throw new Error("empty"); continue; }
          empty = 0;
          const nextTotal = read + item.value.byteLength;
          if (nextTotal > expected) throw new Error("long");
          if (nextTotal < expected) { read = nextTotal; controller.enqueue(item.value); return; }
          const finalChunk = item.value;
          const terminal = await nextMeaningfulRead(reader, signal);
          if (!terminal.done) throw new Error("long");
          read = nextTotal;
          controller.enqueue(finalChunk);
          finish();
          controller.close();
          return;
        }
      } catch { void reader.cancel().catch(() => undefined); finish(); controller.error(new PersonalPhotoCloudError("unavailable")); }
    },
    cancel(reason) { void reader.cancel(reason).catch(() => undefined); finish(); },
  });
}

function readCapture(headers: Headers): CapturedPhotoActor {
  const actorId = oneHeader(headers, PHOTO_CAPTURE_HEADERS.actorId);
  const sessionId = oneHeader(headers, PHOTO_CAPTURE_HEADERS.sessionId);
  const sessionEpoch = oneHeader(headers, PHOTO_CAPTURE_HEADERS.sessionEpoch);
  return { userId: actorId, sessionId, sessionEpoch, transport: "browser-session" };
}
function oneHeader(headers: Headers, name: string): string { const value = headers.get(name); if (value === null || value.length === 0 || value.length > 256 || value.includes(",") || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error("header"); return value; }
function validateStartup(options: CreatePersonalPhotoCloudProxyOptions): string {
  if (options.upstreamOrigin !== NIHO_PRODUCTION_ORIGIN || options.trustedUploadOrigin !== undefined && options.trustedUploadOrigin !== TRUSTED_GCS_UPLOAD_ORIGIN) throw new Error("invalid photo cloud startup configuration");
  const value = options.upstreamPathPrefix;
  if (!/^\/[A-Za-z0-9._~/-]+$/u.test(value) || value.endsWith("/") || value.startsWith("//") || value.split("/").some((item) => item === "." || item === "..") || new URL(value, NIHO_PRODUCTION_ORIGIN).pathname !== value) throw new Error("invalid photo cloud startup configuration");
  return value;
}
function responseLibraryId(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.id === "string" && isRecord(value.owner)) return value.id;
  if (typeof value.libraryId === "string") return value.libraryId;
  if (Array.isArray(value.items)) return isRecord(value.items[0]) && typeof value.items[0].libraryId === "string" ? value.items[0].libraryId : "";
  if (isRecord(value.value)) return responseLibraryId(value.value);
  if (isRecord(value.photo)) return responseLibraryId(value.photo);
  if (isRecord(value.upload)) return responseLibraryId(value.upload);
  if (isRecord(value.result) && isRecord(value.result.photo)) return responseLibraryId(value.result.photo);
  return "";
}
function authorizationError(error: unknown): Response { if (error instanceof PhotoAuthorizationError) return closedError(error.code === "scope_changed" ? "unauthenticated" : error.code === "unavailable" ? "temporarily_unavailable" : "unauthenticated", error.code === "unavailable" ? 503 : 401); return closedError("temporarily_unavailable", 503); }
function closedError(code: PhotoErrorCode, status: number): Response { return Response.json({ error: { code, requestId: "photo-cloud", retryable: status === 429 || status === 503 } }, { status, headers: jsonHeaders() }); }
function jsonHeaders(): HeadersInit { return { "Cache-Control": "no-store", "Content-Type": "application/json", "Referrer-Policy": "no-referrer" }; }
function integerHeader(headers: Headers, name: string): number | null { const value = headers.get(name); if (value === null || !/^\d+$/u.test(value) || value.includes(",")) return null; const result = Number(value); return Number.isSafeInteger(result) ? result : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
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
    if (++empty > 64) throw new PersonalPhotoCloudError("unavailable");
  }
}
async function awaitAuthorization(
  auth: Pick<PhotoAuthService, "withAuthorizedCredential">,
  request: Request,
  capture: CapturedPhotoActor,
): Promise<void> {
  await awaitBounded(auth.withAuthorizedCredential(request, capture, async () => undefined), {
    signal: request.signal,
    timeoutMs: TRANSPORT_TIMEOUT_MS,
  });
}
