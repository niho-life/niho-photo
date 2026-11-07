/**
 * The Photo Web BFF for the shared-album routes (`/cloud/sharing/v1`, B00 `SHARING_ROUTES`), built like the personal
 * `/cloud/v2` proxy (docs/architecture/personal-photo-transfers.md):
 *
 * - Routes come from the contract's table only. An unknown path, method or operation the package cannot check
 *   (`SharingProxyOperations`) is `not_found`; path IDs are single opaque segments in their canonical encoding.
 * - The request is decoded with the contract (placement, closed shape), checked with the client's own value rules and
 *   re-encoded, so only the canonical suffix, query and body reach the upstream. `Idempotency-Key` is required on
 *   mutations and refused otherwise; `Range` only on content routes; the caller's `Authorization` is refused.
 * - The auth service verifies the user, parent session and epoch against the capture headers (`withAuthorizedCredential`)
 *   and the fresh credential goes only to the fixed upstream (`NIHO_PRODUCTION_ORIGIN` + a trusted prefix from the
 *   private startup configuration). Caller cookies and headers are never forwarded.
 * - JSON is limited in bytes before parsing and checked with the client's response rules; errors must be the contract's
 *   envelope with the matching status; upload tickets must point at the trusted provider for exactly that upload.
 *   Content streams follow the v2 rules (200 whole or 206 for the requested range, total size and SHA-256 headers,
 *   exact length, never buffered whole).
 * - The session is checked again before anything is published; on failure the upstream body is cancelled.
 * - Every answer is `no-store`. Upstream error bodies other than the contract's envelope, URLs and provider answers are
 *   never shown.
 */
import {
  NIHO_PRODUCTION_ORIGIN,
  PhotoAuthorizationError,
  type CapturedPhotoActor,
  type PhotoAuthService,
} from "@niho/photo-cloud-session/server";

import { abortReason, awaitBounded, cancelResponse, linkedAbortController } from "../await";
import { PersonalPhotoCloudError } from "../errors";
import {
  SHARING_CLOUD_PATH_PREFIX,
  SHARING_ERROR_STATUS,
  decodeSharingRequest,
  decodeUserRenderRequest,
  encodeSharingRequest,
  encodeUserRenderRequest,
  matchSharingRoute,
  matchUserRenderRoute,
  type SharingErrorCode,
} from "../sharing/contract";
import { parseSharingError } from "../sharing/membership-wire";
import {
  JSON_LIMITS,
  PHOTO_CAPTURE_HEADERS,
  PHOTO_CONTENT_HEADERS,
  PHOTO_IDEMPOTENCY_HEADER,
  TRANSPORT_TIMEOUT_MS,
  TRUSTED_GCS_UPLOAD_ORIGIN,
  isValidIdempotencyKey,
  parseJsonBytes,
  readBoundedBody,
  readBoundedJson,
  validateTicket,
} from "../wire";
import { boundStream, isValidUpstreamPathPrefix, parseContentMetadata } from "./proxy";
import { SHARING_PROXY_OPERATIONS, type SharingProxyContentOperation, type SharingProxyOperations } from "./sharing-operations";

export interface CreateSharingCloudProxyOptions {
  readonly authService: Pick<PhotoAuthService, "withAuthorizedCredential">;
  readonly upstreamOrigin: typeof NIHO_PRODUCTION_ORIGIN;
  /** Trusted upstream prefix from the private startup configuration; the suffix after `/cloud/sharing/v1` follows it. */
  readonly upstreamPathPrefix: string;
  /** The operations forwarded (default: every one this package can check). */
  readonly operations?: SharingProxyOperations;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly trustedUploadOrigin?: typeof TRUSTED_GCS_UPLOAD_ORIGIN;
}

/**
 * The contract's two tables under the prefix: the user's sharing routes and render jobs on the user's own device (B07).
 * Each placement is decoded and re-encoded by the table it matched.
 */
type DecodeInput = Parameters<typeof decodeSharingRequest>[1];
const ROUTE_TABLES = [
  {
    match: (method: string, path: string) => matchSharingRoute(method, path),
    decode: (operation: string, input: DecodeInput) => decodeSharingRequest(operation as never, input),
    encode: (operation: string, request: unknown) => encodeSharingRequest(operation as never, request as never),
  },
  {
    match: (method: string, path: string) => matchUserRenderRoute(method, path),
    decode: (operation: string, input: DecodeInput) => decodeUserRenderRequest(operation as never, input),
    encode: (operation: string, request: unknown) => encodeUserRenderRequest(operation as never, request as never),
  },
] as const;

function matchRoute(method: string, path: string): { readonly table: (typeof ROUTE_TABLES)[number]; readonly operation: string; readonly params: Readonly<Record<string, string>> } | null {
  for (const table of ROUTE_TABLES) {
    const matched = table.match(method, path);
    if (matched !== null) return { table, operation: matched.operation, params: matched.params };
  }
  return null;
}

/** Thrown for a request that must not be sent; answered `invalid_request` without contacting the upstream. */
class RejectedRequest extends Error {}

export function createSharingCloudProxy(options: CreateSharingCloudProxyOptions): (request: Request) => Promise<Response | null> {
  if (options === null || typeof options !== "object" || options.upstreamOrigin !== NIHO_PRODUCTION_ORIGIN
    || !isValidUpstreamPathPrefix(options.upstreamPathPrefix)
    || (options.trustedUploadOrigin !== undefined && options.trustedUploadOrigin !== TRUSTED_GCS_UPLOAD_ORIGIN)
    || typeof options.authService?.withAuthorizedCredential !== "function") {
    throw new Error("invalid photo sharing startup configuration");
  }
  const upstreamBase = `${options.upstreamOrigin}${options.upstreamPathPrefix}`;
  const operations = options.operations ?? SHARING_PROXY_OPERATIONS;
  const fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
  const now = options.now ?? Date.now;
  const trustedUploadOrigin = options.trustedUploadOrigin ?? TRUSTED_GCS_UPLOAD_ORIGIN;

  /** The session must still be the captured one when the answer is published. */
  async function reauthorize(request: Request, capture: CapturedPhotoActor): Promise<void> {
    await awaitBounded(options.authService.withAuthorizedCredential(request, capture, async () => undefined), {
      signal: request.signal,
      timeoutMs: TRANSPORT_TIMEOUT_MS,
    });
  }

  return async (request: Request): Promise<Response | null> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    if (url.pathname !== SHARING_CLOUD_PATH_PREFIX && !url.pathname.startsWith(`${SHARING_CLOUD_PATH_PREFIX}/`)) return null;
    try {
      const matched = matchRoute(request.method.toUpperCase(), url.pathname);
      const entry = matched === null ? undefined : operations[matched.operation as keyof SharingProxyOperations];
      if (matched === null || entry === undefined) {
        cancelRequestBody(request);
        return sharingError("not_found");
      }
      const operation = matched.operation;

      // Placement and headers.
      if (url.hash !== "" || request.headers.has("authorization")) throw new RejectedRequest();
      const capture = readCapture(request.headers);
      const key = request.headers.get(PHOTO_IDEMPOTENCY_HEADER);
      const rangeHeader = request.headers.get("range");
      const range = rangeHeader === null ? null : parseRange(rangeHeader);
      let body: unknown = null;
      if (request.body !== null) {
        if (entry.kind !== "json" || request.headers.get("content-type")?.toLowerCase() !== "application/json") throw new RejectedRequest();
        try {
          body = parseJsonBytes(await readBoundedBody(request.body, entry.requestLimit, request.signal));
        } catch (error) {
          if (request.signal.aborted) throw error;
          throw new RejectedRequest();
        }
      }
      let decoded: Record<string, unknown>;
      let encoded: ReturnType<typeof encodeSharingRequest>;
      const table = matched.table;
      try {
        decoded = table.decode(operation, { params: matched.params, query: url.searchParams, body, range }) as Record<string, unknown>;
        entry.validateRequest(decoded);
        encoded = table.encode(operation, decoded);
      } catch {
        throw new RejectedRequest();
      }
      // The canonical encoding must be what arrived; the key is required on mutations and refused otherwise.
      if (encoded.path !== url.pathname || (encoded.idempotencyKey ? !isValidIdempotencyKey(key) : key !== null)) throw new RejectedRequest();
      if ((encoded.body === null) !== (body === null)) throw new RejectedRequest();
      const upstreamRange = encoded.range === null ? null : `bytes=${encoded.range.start}-${encoded.range.endInclusive ?? ""}`;
      const target = `${upstreamBase}${encoded.path.slice(SHARING_CLOUD_PATH_PREFIX.length)}${encoded.query === "" ? "" : `?${encoded.query}`}`;

      // Dispatch under the verified session, to the fixed upstream only.
      let upstream: Response;
      const dispatch = linkedAbortController(request.signal);
      try {
        const authorized = options.authService.withAuthorizedCredential(request, capture, async (credential, actor) => {
          if (dispatch.controller.signal.aborted) throw abortReason(dispatch.controller.signal);
          const headers = new Headers({
            Authorization: `Bearer ${credential}`,
            [PHOTO_CAPTURE_HEADERS.actorId]: actor.userId,
            [PHOTO_CAPTURE_HEADERS.sessionId]: actor.sessionId,
            [PHOTO_CAPTURE_HEADERS.sessionEpoch]: actor.sessionEpoch,
          });
          if (encoded.body !== null) headers.set("Content-Type", "application/json");
          if (upstreamRange !== null) headers.set("Range", upstreamRange);
          if (encoded.idempotencyKey) headers.set(PHOTO_IDEMPOTENCY_HEADER, key as string);
          return await awaitBounded(Promise.resolve().then(async () => await fetchFn(target, {
            method: encoded.method,
            headers,
            body: encoded.body === null ? null : JSON.stringify(encoded.body),
            signal: dispatch.controller.signal,
            cache: "no-store",
            credentials: "omit",
            redirect: "manual",
            referrerPolicy: "no-referrer",
          })), {
            signal: dispatch.controller.signal,
            timeoutMs: TRANSPORT_TIMEOUT_MS,
            onTimeout: () => dispatch.controller.abort(new PersonalPhotoCloudError("unavailable")),
            onLateResolve: cancelResponse,
          });
        });
        upstream = await awaitBounded(authorized, {
          signal: request.signal,
          timeoutMs: TRANSPORT_TIMEOUT_MS,
          onTimeout: () => dispatch.controller.abort(new PersonalPhotoCloudError("unavailable")),
          onLateResolve: cancelResponse,
        });
      } catch (error) {
        return authorizationError(error);
      } finally {
        dispatch.dispose();
      }

      if (entry.kind === "content") return await publishContent(request, capture, entry, upstream, upstreamRange, reauthorize);

      if (upstream.ok && upstream.status !== 200) {
        cancelResponse(upstream);
        return sharingError("temporarily_unavailable");
      }
      let parsed: { readonly bytes: Uint8Array<ArrayBuffer>; readonly value: unknown };
      try {
        parsed = await readBoundedJson(upstream, upstream.ok ? entry.responseLimit : JSON_LIMITS.error, request.signal);
      } catch {
        cancelResponse(upstream);
        return sharingError("temporarily_unavailable");
      }
      try {
        if (upstream.ok) {
          entry.validateResponse(decoded, parsed.value);
          for (const ticket of entry.tickets?.(decoded, parsed.value) ?? []) {
            validateTicket(ticket.ticket, {
              trustedOrigin: trustedUploadOrigin,
              ...(ticket.contentType === undefined ? {} : { expectedContentType: ticket.contentType }),
              expectedSize: ticket.sizeBytes,
              now: now(),
            });
          }
        } else {
          parseSharingError(parsed.value, upstream.status);
        }
        await reauthorize(request, capture);
      } catch (error) {
        return error instanceof PhotoAuthorizationError ? authorizationError(error) : sharingError("temporarily_unavailable");
      }
      return new Response(parsed.bytes, { status: upstream.status, headers: jsonHeaders() });
    } catch (error) {
      if (error instanceof RejectedRequest) {
        cancelRequestBody(request);
        return sharingError("invalid_request");
      }
      return sharingError("temporarily_unavailable");
    }
  };
}

async function publishContent(
  request: Request,
  capture: CapturedPhotoActor,
  entry: SharingProxyContentOperation,
  upstream: Response,
  requestedRange: string | null,
  reauthorize: (request: Request, capture: CapturedPhotoActor) => Promise<void>,
): Promise<Response> {
  if (!upstream.ok) {
    try {
      const parsed = await readBoundedJson(upstream, JSON_LIMITS.error, request.signal);
      parseSharingError(parsed.value, upstream.status);
      await reauthorize(request, capture);
      return new Response(parsed.bytes, { status: upstream.status, headers: jsonHeaders() });
    } catch (error) {
      cancelResponse(upstream);
      return error instanceof PhotoAuthorizationError ? authorizationError(error) : sharingError("temporarily_unavailable");
    }
  }
  if ((upstream.status !== 200 && upstream.status !== 206) || upstream.body === null) {
    cancelResponse(upstream);
    return sharingError("temporarily_unavailable");
  }
  const metadata = parseContentMetadata(upstream, requestedRange);
  if (metadata === null || metadata.contentType !== entry.contentType) {
    cancelResponse(upstream);
    return sharingError("temporarily_unavailable");
  }
  try {
    await reauthorize(request, capture);
  } catch (error) {
    cancelResponse(upstream);
    return authorizationError(error);
  }
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

/** The capture headers: all three, one value each (fences checked against the verified session, never proof). */
function readCapture(headers: Headers): CapturedPhotoActor {
  const one = (name: string): string => {
    const value = headers.get(name);
    if (value === null || value.length === 0 || value.length > 256 || value.includes(",") || /[\p{Cc}\p{Cf}]/u.test(value)) throw new RejectedRequest();
    return value;
  };
  return {
    userId: one(PHOTO_CAPTURE_HEADERS.actorId),
    sessionId: one(PHOTO_CAPTURE_HEADERS.sessionId),
    sessionEpoch: one(PHOTO_CAPTURE_HEADERS.sessionEpoch),
    transport: "browser-session",
  };
}

/** `bytes=start-` or `bytes=start-end`, one range, safe integers. */
function parseRange(value: string): { readonly start: number; readonly endInclusive?: number } {
  const match = /^bytes=(\d{1,16})-(\d{0,16})$/u.exec(value);
  if (!match) throw new RejectedRequest();
  const start = Number(match[1]);
  const end = match[2] === "" ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(start) || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) throw new RejectedRequest();
  return end === undefined ? { start } : { start, endInclusive: end };
}

function cancelRequestBody(request: Request): void {
  if (request.body !== null && !request.bodyUsed) void request.body.cancel().catch(() => undefined);
}

function authorizationError(error: unknown): Response {
  if (error instanceof PhotoAuthorizationError && error.code !== "unavailable") return sharingError("unauthenticated");
  return sharingError("temporarily_unavailable");
}

function sharingError(code: SharingErrorCode): Response {
  return new Response(JSON.stringify({ error: { code, requestId: "photo-sharing", retryable: code === "temporarily_unavailable" || code === "rate_limited" } }), {
    status: SHARING_ERROR_STATUS[code],
    headers: jsonHeaders(),
  });
}

function jsonHeaders(): HeadersInit {
  return { "Cache-Control": "no-store", "Content-Type": "application/json", "Referrer-Policy": "no-referrer" };
}
