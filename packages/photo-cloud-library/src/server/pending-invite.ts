/**
 * The BFF half of an invite opened before signing in (B00 `PENDING_INVITE_ROUTES`, B05 #246). It answers only
 * `POST /cloud/sharing/v1/invites/pending` and `POST /cloud/sharing/v1/invites/pending/join`; every other request is
 * left to the next handler (`null`).
 *
 * - `invites.holdPending` (anyone, signed in or not): the page hands the secret over once. It is sealed with
 *   AES-256-GCM under a key from the private ops configuration and set as an httpOnly, Secure, SameSite=Lax cookie on
 *   the pending path for 15 minutes (`PENDING_INVITE_COOKIE`). JavaScript can read neither the secret nor the cookie.
 * - `invites.joinPending` (signed in): the cookie is opened, `decidePendingInviteJoin` decides, and an allowed one is
 *   sent upstream as the normal `invites.join` under the verified session. Once the session is verified the cookie is
 *   deleted whatever happens. Not signed in: `unauthenticated`, and the cookie stays for after sign-in.
 *
 * The secret never goes into a URL, a log line or an error. Used pending IDs are remembered in this process until they
 * expire (a copied cookie is refused); the upstream join is keyed by the pending ID, and an upstream replay of that key
 * (the same cookie used on another instance) is refused as well.
 *
 * The contract's path rules out a `__Host-` name, so another host under the parent domain could add a cookie of the same
 * name. A second, `__Host-` cookie (host only, `Path=/`) carries the pending ID: only the pending cookie whose sealed ID
 * matches it is opened, so a cookie planted from elsewhere is neither used nor able to block ours.
 */
import { Buffer } from "node:buffer";

import {
  NIHO_PRODUCTION_ORIGIN,
  PhotoAuthorizationError,
  type CapturedPhotoActor,
  type PhotoAuthService,
} from "@niho/photo-cloud-session/server";

import { awaitBounded, cancelResponse, linkedAbortController } from "../await";
import { PersonalPhotoCloudError } from "../errors";
import {
  PENDING_INVITE_COOKIE,
  SHARING_CLOUD_PATH_PREFIX,
  SHARING_ERROR_STATUS,
  SHARING_LIMITS,
  decidePendingInviteJoin,
  decodePendingInviteRequest,
  encodeSharingRequest,
  findUnexpectedPendingInviteFields,
  holdPendingInvite,
  matchPendingInviteRoute,
  type InviteJoinResult,
  type PendingInvite,
  type SharingErrorCode,
  type SharingErrorEnvelope,
} from "../sharing/contract";
import { isSecret, parseSharingError, validateJoinResult, validateReceipt } from "../sharing/membership-wire";
import {
  JSON_LIMITS,
  PHOTO_CAPTURE_HEADERS,
  PHOTO_IDEMPOTENCY_HEADER,
  TRANSPORT_TIMEOUT_MS,
  readBoundedBody,
  readBoundedJson,
} from "../wire";
import { isValidUpstreamPathPrefix } from "./proxy";

/** The BFF picks the name (B00). `__Secure-`: browsers refuse it without Secure; `__Host-` would force `Path=/`. */
export const PENDING_INVITE_COOKIE_NAME = "__Secure-niho-photo-pending-invite";
/** Host-only binding: the pending ID (not secret by itself; useless without the sealed cookie). */
export const PENDING_INVITE_BINDING_COOKIE_NAME = "__Host-niho-photo-pending-invite-id";

const SEAL_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** The current key seals; a previous one still opens cookies during a rotation (at most 15 minutes old). */
const MAX_KEYS = 2;
const MAX_REQUEST_BODY_BYTES = 2048;
const MAX_COOKIE_VALUE_BYTES = 3072;
/** Same-named pending cookies looked at (ours plus any planted from another host). */
const MAX_PENDING_COOKIES = 4;
const PENDING_ID_BYTES = 16;
const PENDING_ID = /^[A-Za-z0-9_-]{22}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DEFAULT_MAX_REMEMBERED_IDS = 10_000;
const CLOCK_SKEW_MS = 60_000;
const SEAL_CONTEXT = new TextEncoder().encode("niho-photo-pending-invite/v1");
const COOKIE_ATTRIBUTES = cookieAttributes();
const BINDING_ATTRIBUTES = `Path=/; HttpOnly; Secure; SameSite=${PENDING_INVITE_COOKIE.sameSite}`;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface CreatePendingInviteHandlerOptions {
  /** The exact Photo origin (the same value the auth service checks). */
  readonly photoOrigin: string;
  readonly authService: Pick<PhotoAuthService, "withAuthorizedCredential">;
  readonly upstreamOrigin: typeof NIHO_PRODUCTION_ORIGIN;
  /** Trusted upstream prefix for the sharing routes; the suffix after `/cloud/sharing/v1` is appended to it. */
  readonly upstreamPathPrefix: string;
  /**
   * AES-256 keys (32 bytes each) from the private ops configuration, never from source: the first seals, every one
   * opens. Two at most, for a rotation.
   */
  readonly keys: readonly Uint8Array[];
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array<ArrayBuffer>;
  /** Used pending IDs kept until they expire (default 10,000); when full the join is refused as unavailable. */
  readonly maxRememberedIds?: number;
}

type JoinOutcome =
  | { readonly kind: "refused"; readonly code: SharingErrorCode }
  | { readonly kind: "joined"; readonly result: InviteJoinResult }
  | { readonly kind: "upstreamError"; readonly status: number; readonly envelope: SharingErrorEnvelope };

export function createPendingInviteHandler(options: CreatePendingInviteHandlerOptions): (request: Request) => Promise<Response | null> {
  const config = validateConfiguration(options);
  const fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? ((length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length)));
  const maxRemembered = options.maxRememberedIds ?? DEFAULT_MAX_REMEMBERED_IDS;
  // Imported once, not extractable; the raw bytes are not kept by this handler.
  const keys = Promise.all(config.keys.map(async (key) => await globalThis.crypto.subtle.importKey("raw", Uint8Array.from(key), "AES-GCM", false, ["encrypt", "decrypt"])));
  void keys.catch(() => undefined);
  /** Pending ID → expiry (ms). */
  const used = new Map<string, number>();
  const instant = (): string => new Date(now()).toISOString();
  const requestId = (): string => `bff-${Buffer.from(randomBytes(12)).toString("base64url")}`;

  function errorResponse(code: SharingErrorCode, cookies: readonly string[] = []): Response {
    const envelope: SharingErrorEnvelope = { error: { code, requestId: requestId(), retryable: code === "temporarily_unavailable" } };
    return jsonResponse(SHARING_ERROR_STATUS[code], envelope, cookies);
  }

  function authorizationFailure(error: unknown, cookies: readonly string[] = []): Response {
    if (error instanceof PhotoAuthorizationError && error.code !== "unavailable") return errorResponse("unauthenticated", cookies);
    return errorResponse("temporarily_unavailable", cookies);
  }

  async function authorized<T>(request: Request, capture: CapturedPhotoActor | null, perform: (credential: string, actor: CapturedPhotoActor) => Promise<T>): Promise<T> {
    return await awaitBounded(options.authService.withAuthorizedCredential(request, capture, perform), {
      signal: request.signal,
      timeoutMs: TRANSPORT_TIMEOUT_MS,
    });
  }

  function remember(pending: PendingInvite): boolean {
    const current = now();
    if (used.size >= maxRemembered) {
      for (const [id, expiresAt] of used) if (expiresAt <= current) used.delete(id);
    }
    if (used.size >= maxRemembered) return false;
    used.set(pending.id, Date.parse(pending.expiresAt));
    return true;
  }

  async function hold(request: Request, capture: CapturedPhotoActor | null, body: Record<string, unknown>): Promise<Response> {
    const secret = body.secret;
    if (!isSecret(secret)) return errorResponse("invalid_request");
    let actorId: string | null = null;
    if (capture !== null) {
      try {
        actorId = await authorized(request, capture, async (_credential, actor) => actor.userId);
      } catch (error) {
        return authorizationFailure(error);
      }
    }
    const pending = holdPendingInvite({ id: Buffer.from(randomBytes(PENDING_ID_BYTES)).toString("base64url"), secret, actorId, now: instant() });
    const sealed = await seal((await keys)[0] as CryptoKey, pending, randomBytes);
    if (sealed.length > MAX_COOKIE_VALUE_BYTES) return errorResponse("invalid_request");
    const maxAge = `Max-Age=${PENDING_INVITE_COOKIE.maxAgeSeconds}`;
    return jsonResponse(200, { expiresAt: pending.expiresAt }, [
      `${PENDING_INVITE_COOKIE_NAME}=${sealed}; ${maxAge}; ${COOKIE_ATTRIBUTES}`,
      `${PENDING_INVITE_BINDING_COOKIE_NAME}=${pending.id}; ${maxAge}; ${BINDING_ATTRIBUTES}`,
    ]);
  }

  async function sendJoin(credential: string, actor: CapturedPhotoActor, pending: PendingInvite, signal: AbortSignal): Promise<JoinOutcome> {
    const route = encodeSharingRequest("invites.join", { secret: pending.secret });
    if (!route.path.startsWith(`${SHARING_CLOUD_PATH_PREFIX}/`) || route.query !== "" || route.body === null) return { kind: "refused", code: "temporarily_unavailable" };
    const link = linkedAbortController(signal);
    try {
      const headers = new Headers({
        Authorization: `Bearer ${credential}`,
        [PHOTO_CAPTURE_HEADERS.actorId]: actor.userId,
        [PHOTO_CAPTURE_HEADERS.sessionId]: actor.sessionId,
        [PHOTO_CAPTURE_HEADERS.sessionEpoch]: actor.sessionEpoch,
        "Content-Type": "application/json",
        // One pending invite, one join: a copy replayed elsewhere lands on the same key upstream.
        [PHOTO_IDEMPOTENCY_HEADER]: `pending-invite-${pending.id}`,
      });
      const upstream = await awaitBounded(Promise.resolve().then(async () => await fetchFn(`${config.upstreamOrigin}${config.upstreamPathPrefix}${route.path.slice(SHARING_CLOUD_PATH_PREFIX.length)}`, {
        method: route.method,
        headers,
        body: JSON.stringify(route.body),
        signal: link.controller.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
      })), {
        signal,
        timeoutMs: TRANSPORT_TIMEOUT_MS,
        onTimeout: () => link.controller.abort(new PersonalPhotoCloudError("unavailable")),
        onLateResolve: cancelResponse,
      });
      if (upstream.status === 200) {
        const { value } = await readBoundedJson(upstream, JSON_LIMITS.success, signal);
        const receipt = validateReceipt(value);
        const result = validateJoinResult(receipt.value);
        // A replay of this pending ID's key: the same cookie was already used (on another instance).
        if (receipt.replayed) return { kind: "refused", code: "invite_unavailable" };
        return { kind: "joined", result };
      }
      if (upstream.ok) {
        cancelResponse(upstream);
        return { kind: "refused", code: "temporarily_unavailable" };
      }
      const { value } = await readBoundedJson(upstream, JSON_LIMITS.error, signal);
      return { kind: "upstreamError", status: upstream.status, envelope: parseSharingError(value, upstream.status) };
    } catch {
      // Network, timeout or a malformed answer. The secret is in none of these errors and none is rethrown.
      return { kind: "refused", code: "temporarily_unavailable" };
    } finally {
      link.dispose();
    }
  }

  async function join(request: Request, capture: CapturedPhotoActor | null): Promise<Response> {
    const pending = await boundPending(request.headers.get("cookie"), await keys, now());
    let outcome: JoinOutcome;
    try {
      // The session decides who is joining; the capture headers, when sent, must match it.
      outcome = await authorized(request, capture, async (credential, actor): Promise<JoinOutcome> => {
        const decision = decidePendingInviteJoin({ actorId: actor.userId, pending, consumed: pending !== null && used.has(pending.id), now: instant() });
        if (!decision.ok) return { kind: "refused", code: decision.code };
        const allowed = pending as PendingInvite;
        if (!remember(allowed)) return { kind: "refused", code: "temporarily_unavailable" };
        return await sendJoin(credential, actor, allowed, request.signal);
      });
    } catch (error) {
      // Not signed in (or the session could not be checked): nothing was sent and the cookie stays.
      return authorizationFailure(error);
    }
    const cleared = [
      `${PENDING_INVITE_COOKIE_NAME}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`,
      `${PENDING_INVITE_BINDING_COOKIE_NAME}=; Max-Age=0; ${BINDING_ATTRIBUTES}`,
    ];
    if (outcome.kind === "refused") return errorResponse(outcome.code, cleared);
    // As the personal proxy does, the session must still be valid when the answer is published.
    try {
      await authorized(request, capture, async () => undefined);
    } catch (error) {
      return authorizationFailure(error, cleared);
    }
    if (outcome.kind === "upstreamError") return jsonResponse(outcome.status, outcome.envelope, cleared);
    return jsonResponse(200, outcome.result, cleared);
  }

  return async (request: Request): Promise<Response | null> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    const route = matchPendingInviteRoute(request.method, url.pathname);
    if (route === null) return null;
    try {
      // Same rules as the auth service for a state-changing request: exact origin, same-origin fetch, JSON only.
      if (url.origin !== config.photoOrigin || request.headers.get("origin") !== config.photoOrigin) return errorResponse("origin_rejected");
      const site = request.headers.get("sec-fetch-site");
      if (site !== null && site !== "same-origin") return errorResponse("origin_rejected");
      if (url.search !== "" || request.headers.has(PHOTO_IDEMPOTENCY_HEADER) || request.headers.has("range")
        || request.headers.get("content-type")?.toLowerCase() !== "application/json") return errorResponse("invalid_request");
      const capture = readCapture(request.headers);
      if (capture === false) return errorResponse("invalid_request");
      let body: Record<string, unknown>;
      try {
        const bytes = await readBoundedBody(request.body, MAX_REQUEST_BODY_BYTES, request.signal);
        const decoded: unknown = decodePendingInviteRequest(route.operation, {
          params: route.params,
          query: url.searchParams,
          body: JSON.parse(textDecoder.decode(bytes)),
          range: null,
        });
        if (!isRecord(decoded) || findUnexpectedPendingInviteFields(route.operation, decoded).length > 0) return errorResponse("invalid_request");
        body = decoded;
      } catch {
        if (request.signal.aborted) return errorResponse("temporarily_unavailable");
        return errorResponse("invalid_request");
      }
      return route.operation === "invites.holdPending" ? await hold(request, capture, body) : await join(request, capture);
    } catch {
      return errorResponse("temporarily_unavailable");
    }
  };
}

function validateConfiguration(options: CreatePendingInviteHandlerOptions): {
  readonly photoOrigin: string;
  readonly upstreamOrigin: string;
  readonly upstreamPathPrefix: string;
  readonly keys: readonly Uint8Array[];
} {
  const invalid = (): never => {
    throw new Error("invalid pending invite configuration");
  };
  if (options === null || typeof options !== "object") return invalid();
  let origin: URL;
  try {
    origin = new URL(options.photoOrigin);
  } catch {
    return invalid();
  }
  if (origin.protocol !== "https:" || origin.origin !== options.photoOrigin) invalid();
  if (options.upstreamOrigin !== NIHO_PRODUCTION_ORIGIN || !isValidUpstreamPathPrefix(options.upstreamPathPrefix)) invalid();
  if (typeof options.authService?.withAuthorizedCredential !== "function") invalid();
  if (!Array.isArray(options.keys) || options.keys.length < 1 || options.keys.length > MAX_KEYS) invalid();
  if (options.keys.some((key) => !(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES || key.every((byte) => byte === 0))) invalid();
  if (options.maxRememberedIds !== undefined && (!Number.isSafeInteger(options.maxRememberedIds) || options.maxRememberedIds < 1)) invalid();
  return { photoOrigin: origin.origin, upstreamOrigin: options.upstreamOrigin, upstreamPathPrefix: options.upstreamPathPrefix, keys: options.keys };
}

function cookieAttributes(): string {
  const cookie = PENDING_INVITE_COOKIE;
  // The contract's attributes, spelled out; a contract that loosened them would fail here rather than ship.
  if (cookie.httpOnly !== true || cookie.secure !== true || cookie.sameSite !== "Lax" || cookie.path !== `${SHARING_CLOUD_PATH_PREFIX}/invites/pending`
    || cookie.maxAgeSeconds !== SHARING_LIMITS.pendingInviteLifetimeSeconds) {
    throw new Error("unexpected pending invite cookie contract");
  }
  return `Path=${cookie.path}; HttpOnly; Secure; SameSite=${cookie.sameSite}`;
}

async function seal(key: CryptoKey, pending: PendingInvite, randomBytes: (length: number) => Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const sealed = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: SEAL_CONTEXT, tagLength: TAG_BYTES * 8 },
    key,
    textEncoder.encode(JSON.stringify(pending)),
  ));
  const output = new Uint8Array(1 + IV_BYTES + sealed.byteLength);
  output[0] = SEAL_VERSION;
  output.set(iv, 1);
  output.set(sealed, 1 + IV_BYTES);
  return Buffer.from(output).toString("base64url");
}

/** The cookie's pending invite, or null when it does not open with any key or does not have the exact shape. */
async function open(keys: readonly CryptoKey[], value: string, now: number): Promise<PendingInvite | null> {
  if (value.length === 0 || value.length > MAX_COOKIE_VALUE_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
  if (bytes.byteLength <= 1 + IV_BYTES + TAG_BYTES || bytes[0] !== SEAL_VERSION) return null;
  const iv = bytes.subarray(1, 1 + IV_BYTES);
  const sealed = bytes.subarray(1 + IV_BYTES);
  for (const key of keys) {
    let plain: ArrayBuffer;
    try {
      plain = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: SEAL_CONTEXT, tagLength: TAG_BYTES * 8 }, key, sealed);
    } catch {
      continue;
    }
    return parsePending(plain, now);
  }
  return null;
}

function parsePending(plain: ArrayBuffer, now: number): PendingInvite | null {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(plain));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "expiresAt,heldBy,id,secret") return null;
  const { id, secret, heldBy, expiresAt } = value;
  if (typeof id !== "string" || !PENDING_ID.test(id) || !isSecret(secret)) return null;
  if (heldBy !== null && (typeof heldBy !== "string" || heldBy.length === 0 || heldBy.length > 256 || /[\p{Cc}\p{Cf}]/u.test(heldBy))) return null;
  if (typeof expiresAt !== "string" || !ISO_INSTANT.test(expiresAt)) return null;
  const expires = Date.parse(expiresAt);
  // Never longer-lived than a hold made now (with some clock skew between instances).
  if (!Number.isFinite(expires) || expires > now + SHARING_LIMITS.pendingInviteLifetimeSeconds * 1000 + CLOCK_SKEW_MS) return null;
  return { id, secret, heldBy, expiresAt };
}

/**
 * This browser's pending invite: the one pending cookie whose sealed ID equals the host-only binding cookie. Cookies of
 * the same name planted from another host under the parent domain do not match and are ignored.
 */
async function boundPending(header: string | null, keys: readonly CryptoKey[], now: number): Promise<PendingInvite | null> {
  const bindings = cookieValues(header, PENDING_INVITE_BINDING_COOKIE_NAME);
  const binding = bindings.length === 1 ? (bindings[0] as string) : null;
  if (binding === null || !PENDING_ID.test(binding)) return null;
  const candidates = cookieValues(header, PENDING_INVITE_COOKIE_NAME);
  if (candidates.length > MAX_PENDING_COOKIES) return null;
  for (const candidate of candidates) {
    const pending = await open(keys, candidate, now);
    if (pending !== null && pending.id === binding) return pending;
  }
  return null;
}

function cookieValues(header: string | null, name: string): string[] {
  if (header === null) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) values.push(part.slice(separator + 1).trim());
  }
  return values;
}

/** The capture headers: all three or none (none: the session alone decides). */
function readCapture(headers: Headers): CapturedPhotoActor | null | false {
  const values = [PHOTO_CAPTURE_HEADERS.actorId, PHOTO_CAPTURE_HEADERS.sessionId, PHOTO_CAPTURE_HEADERS.sessionEpoch].map((name) => headers.get(name));
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null || value.length === 0 || value.length > 256 || value.includes(",") || /[\p{Cc}\p{Cf}]/u.test(value))) return false;
  const [userId, sessionId, sessionEpoch] = values as [string, string, string];
  return { userId, sessionId, sessionEpoch, transport: "browser-session" };
}

function jsonResponse(status: number, value: unknown, cookies: readonly string[] = []): Response {
  const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json", "Referrer-Policy": "no-referrer" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(value), { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
