import { createHash, randomBytes } from "node:crypto";

import { isPhotoIdentityExpired, samePhotoIdentityScope, type PhotoIdentity } from "../identity.ts";
import {
  parsePhotoAuthConfiguration,
  type PhotoAuthConfiguration,
} from "./config.ts";
import {
  clearCredentialCookie,
  clearPendingCookie,
  readAuthCookies,
  sameSecret,
  setCredentialCookie,
  setPendingCookie,
  type PendingAttempt,
} from "./cookies.ts";
import {
  AUTH_PUBLIC_PATHS,
  autoFormResponse,
  hasEmptyBody,
  readCallbackFields,
  relayFormCopy,
  startFormCopy,
  validateFixedRequest,
  type CallbackBodyOptions,
} from "./http.ts";
import {
  ATTEMPT_MAX_LIFETIME_MS,
  parseProducerActor,
  parseProducerBegin,
  parseProducerCredential,
} from "./protocol.ts";
import { ProducerRequestError, ProducerTransport } from "./transport.ts";

export interface CapturedPhotoActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly sessionEpoch: string;
  readonly transport: PhotoIdentity["transport"];
}

export class PhotoAuthorizationError extends Error {
  override readonly name = "PhotoAuthorizationError";
  readonly status: 401 | 403 | 503;
  readonly code: "unauthenticated" | "scope_changed" | "unavailable";

  constructor(status: 401 | 403 | 503, code: "unauthenticated" | "scope_changed" | "unavailable") {
    super("photo authorization failed");
    this.status = status;
    this.code = code;
  }
}

export interface PhotoAuthServiceOptions {
  readonly configuration: unknown;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomValue?: () => string;
  readonly transportSetTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly transportClearTimer?: (timer: unknown) => void;
  readonly callbackBody?: CallbackBodyOptions;
}

export interface PhotoAuthService {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
  session(request: Request): Promise<Response>;
  refresh(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
  cancel(request: Request): Promise<Response>;
  authorize(request: Request): Promise<PhotoIdentity>;
  /**
   * Re-introspects immediately before invoking server-only work and never returns the credential.
   * The backend must still recheck parent revocation at mutation commit time; this is not a TOCTOU solution.
   */
  withAuthorizedCredential<T>(
    request: Request,
    captured: CapturedPhotoActor | null,
    perform: (credential: string, actor: PhotoIdentity) => Promise<T>,
  ): Promise<T>;
}

function responseHeaders(): Headers {
  return new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
}

function unavailable(): Response {
  return Response.json(
    { error: "temporarily_unavailable", retryable: true },
    { status: 503, headers: responseHeaders() },
  );
}

function badRequest(): Response {
  return Response.json({ error: "bad_request" }, { status: 400, headers: responseHeaders() });
}

function unauthenticated(): Response {
  return Response.json({ error: "unauthenticated" }, { status: 401, headers: responseHeaders() });
}

function noContent(cookies: readonly string[] = []): Response {
  const headers = responseHeaders();
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 204, headers });
}

function identityResponse(actor: PhotoIdentity, credentialCookie?: string): Response {
  const headers = responseHeaders();
  if (credentialCookie !== undefined) headers.append("Set-Cookie", credentialCookie);
  return Response.json(actor, { status: 200, headers });
}

function callbackRedirect(cookies: readonly string[]): Response {
  const headers = responseHeaders();
  headers.set("Location", "/");
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function validBrowserRequest(
  request: Request,
  config: PhotoAuthConfiguration,
  options: { readonly allowQuery: boolean },
): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  const origin = request.headers.get("origin");
  const safeMethod = request.method === "GET" || request.method === "HEAD";
  return url.origin === config.photoOrigin
    && (options.allowQuery || url.search === "")
    && url.hash === ""
    && request.headers.get("host")?.toLowerCase() === new URL(config.photoOrigin).host
    && (safeMethod ? origin === null || origin === config.photoOrigin : origin === config.photoOrigin);
}

function upstreamFailure(error: unknown): Response {
  return error instanceof ProducerRequestError && error.kind === "rejected" ? badRequest() : unavailable();
}

function actorMatchesCapture(actor: PhotoIdentity, captured: CapturedPhotoActor): boolean {
  return actor.userId === captured.userId
    && actor.sessionId === captured.sessionId
    && actor.sessionEpoch === captured.sessionEpoch
    && actor.transport === captured.transport;
}

function safeRandom(randomValue: () => string): string | null {
  const value = randomValue();
  return /^[A-Za-z0-9_-]{43,128}$/.test(value) ? value : null;
}

export function createPhotoAuthService(options: PhotoAuthServiceOptions): PhotoAuthService {
  const config = parsePhotoAuthConfiguration(options.configuration);
  const now = options.now ?? Date.now;
  const randomValue = options.randomValue ?? (() => randomBytes(32).toString("base64url"));
  const fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
  const transport = config === null ? null : new ProducerTransport({
    fetch: fetchFn,
    origin: config.nihoOrigin,
    ...(options.transportSetTimer === undefined ? {} : { setTimer: options.transportSetTimer }),
    ...(options.transportClearTimer === undefined ? {} : { clearTimer: options.transportClearTimer }),
  });

  async function introspectCredential(credential: string, signal?: AbortSignal): Promise<PhotoIdentity> {
    if (config === null || transport === null) throw new PhotoAuthorizationError(503, "unavailable");
    let raw: unknown;
    try {
      raw = await transport.post(config.endpoints.introspect, {
        clientId: config.clientId,
        audience: config.audience,
        credential,
      }, signal);
    } catch (error) {
      if (error instanceof ProducerRequestError && error.kind === "rejected") {
        throw new PhotoAuthorizationError(401, "unauthenticated");
      }
      throw new PhotoAuthorizationError(503, "unavailable");
    }
    const actor = parseProducerActor(raw, config, now());
    if (actor === null) throw new PhotoAuthorizationError(503, "unavailable");
    return actor;
  }

  async function cancelAttempt(pending: PendingAttempt, signal?: AbortSignal): Promise<void> {
    if (config === null || transport === null) throw new ProducerRequestError("unavailable", 503);
    const result = await transport.post(config.endpoints.cancel, {
      clientId: config.clientId,
      attemptId: pending.attemptId,
      codeVerifier: pending.verifier,
    }, signal);
    if (result !== null) throw new ProducerRequestError("unavailable", 502);
  }

  async function revokeCredential(credential: string, signal?: AbortSignal): Promise<void> {
    if (config === null || transport === null) throw new ProducerRequestError("unavailable", 503);
    const result = await transport.post(config.endpoints.revoke, {
      clientId: config.clientId,
      audience: config.audience,
      credential,
    }, signal);
    if (result !== null) throw new ProducerRequestError("unavailable", 502);
  }

  return {
    async start(request) {
      if (config === null || transport === null) return unavailable();
      if (!validateFixedRequest(request, config.photoOrigin, AUTH_PUBLIC_PATHS.start, [config.photoOrigin])
        || !hasEmptyBody(request)) return badRequest();
      const cookies = readAuthCookies(request);
      if (!cookies.ok) return badRequest();
      try {
        if (cookies.pending !== null) await cancelAttempt(cookies.pending, request.signal);
        const state = safeRandom(randomValue);
        const verifier = safeRandom(randomValue);
        const nonce = safeRandom(randomValue);
        if (state === null || verifier === null || nonce === null) return unavailable();
        const codeChallenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
        const raw = await transport.post(config.endpoints.begin, {
          clientId: config.clientId,
          protocolVersion: 2,
          responseMode: "form_post",
          state,
          codeChallenge,
          codeChallengeMethod: "S256",
        }, request.signal);
        const begin = parseProducerBegin(raw, config, now());
        if (begin === null) return unavailable();
        const pending: PendingAttempt = {
          attemptId: begin.attemptId,
          state,
          verifier,
          expiresAt: Date.parse(begin.expiresAt),
        };
        const response = autoFormResponse({
          target: `${config.nihoOrigin}${config.endpoints.confirmation}`,
          formAction: config.nihoOrigin,
          fields: { attemptId: begin.attemptId, state },
          nonce,
          ...startFormCopy(config.copy),
        });
        response.headers.append("Set-Cookie", setPendingCookie(pending, now()));
        return response;
      } catch (error) {
        return upstreamFailure(error);
      }
    },

    async callback(request) {
      if (config === null || transport === null) return unavailable();
      if (!validateFixedRequest(
        request,
        config.photoOrigin,
        AUTH_PUBLIC_PATHS.callback,
        [config.nihoOrigin, config.photoOrigin],
      )) return badRequest();
      const fields = await readCallbackFields(request, options.callbackBody);
      if (fields instanceof Response) return fields;
      const origin = request.headers.get("origin");
      if (origin === config.nihoOrigin) {
        const nonce = safeRandom(randomValue);
        if (nonce === null) return unavailable();
        return autoFormResponse({
          target: `${config.photoOrigin}${config.callbackPath}`,
          formAction: "'self'",
          fields: { code: fields.code, state: fields.state },
          nonce,
          ...relayFormCopy(config.copy),
        });
      }
      const cookies = readAuthCookies(request);
      if (!cookies.ok || cookies.pending === null || cookies.pending.expiresAt <= now()
        || cookies.pending.expiresAt > now() + ATTEMPT_MAX_LIFETIME_MS
        || !sameSecret(fields.state, cookies.pending.state)) return badRequest();
      try {
        const raw = await transport.post(config.endpoints.exchange, {
          clientId: config.clientId,
          audience: config.audience,
          attemptId: cookies.pending.attemptId,
          code: fields.code,
          codeVerifier: cookies.pending.verifier,
          ...(cookies.credential === null ? {} : { replaceCredential: cookies.credential }),
        }, request.signal);
        const payload = parseProducerCredential(raw, config, now());
        if (payload === null) return unavailable();
        return callbackRedirect([
          clearPendingCookie(),
          setCredentialCookie(payload.credential, payload.actor.expiresAt, now()),
        ]);
      } catch (error) {
        return upstreamFailure(error);
      }
    },

    async session(request) {
      if (config === null) return unavailable();
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return badRequest();
      }
      if (!validBrowserRequest(request, config, { allowQuery: false })
        || request.method !== "GET"
        || url.pathname !== AUTH_PUBLIC_PATHS.session
        || request.body !== null) return badRequest();
      const cookies = readAuthCookies(request);
      if (!cookies.ok || cookies.credential === null) return unauthenticated();
      try {
        return identityResponse(await introspectCredential(cookies.credential, request.signal));
      } catch (error) {
        return error instanceof PhotoAuthorizationError && error.status === 401 ? unauthenticated() : unavailable();
      }
    },

    async refresh(request) {
      if (config === null || transport === null) return unavailable();
      if (!validateFixedRequest(request, config.photoOrigin, AUTH_PUBLIC_PATHS.refresh, [config.photoOrigin])
        || !hasEmptyBody(request)) return badRequest();
      const cookies = readAuthCookies(request);
      if (!cookies.ok || cookies.credential === null) return unauthenticated();
      try {
        const previous = await introspectCredential(cookies.credential, request.signal);
        const raw = await transport.post(config.endpoints.refresh, {
          clientId: config.clientId,
          audience: config.audience,
          credential: cookies.credential,
        }, request.signal);
        const refreshed = parseProducerCredential(raw, config, now());
        if (refreshed === null || !samePhotoIdentityScope(previous, refreshed.actor)) return unavailable();
        return identityResponse(
          refreshed.actor,
          setCredentialCookie(refreshed.credential, refreshed.actor.expiresAt, now()),
        );
      } catch (error) {
        if (error instanceof PhotoAuthorizationError && error.status === 401) return unauthenticated();
        if (error instanceof ProducerRequestError && (error.status === 401 || error.status === 403)) {
          return unauthenticated();
        }
        return upstreamFailure(error);
      }
    },

    async logout(request) {
      if (config === null || transport === null) return unavailable();
      if (!validateFixedRequest(request, config.photoOrigin, AUTH_PUBLIC_PATHS.logout, [config.photoOrigin])
        || !hasEmptyBody(request)) return badRequest();
      const cookies = readAuthCookies(request);
      if (!cookies.ok) return badRequest();
      try {
        await Promise.all([
          cookies.pending === null ? Promise.resolve() : cancelAttempt(cookies.pending, request.signal),
          cookies.credential === null ? Promise.resolve() : revokeCredential(cookies.credential, request.signal),
        ]);
        return noContent([clearPendingCookie(), clearCredentialCookie()]);
      } catch {
        return unavailable();
      }
    },

    async cancel(request) {
      if (config === null) return unavailable();
      if (!validateFixedRequest(request, config.photoOrigin, AUTH_PUBLIC_PATHS.cancel, [config.photoOrigin])
        || !hasEmptyBody(request)) return badRequest();
      const cookies = readAuthCookies(request);
      if (!cookies.ok) return badRequest();
      if (cookies.pending === null) return noContent();
      try {
        await cancelAttempt(cookies.pending, request.signal);
        return noContent([clearPendingCookie()]);
      } catch {
        return unavailable();
      }
    },

    async authorize(request) {
      if (config === null || !validBrowserRequest(request, config, { allowQuery: true })) {
        throw new PhotoAuthorizationError(503, "unavailable");
      }
      const cookies = readAuthCookies(request);
      if (!cookies.ok || cookies.credential === null) throw new PhotoAuthorizationError(401, "unauthenticated");
      return introspectCredential(cookies.credential, request.signal);
    },

    async withAuthorizedCredential(request, captured, perform) {
      if (config === null || !validBrowserRequest(request, config, { allowQuery: true })) {
        throw new PhotoAuthorizationError(503, "unavailable");
      }
      const cookies = readAuthCookies(request);
      if (!cookies.ok || cookies.credential === null) throw new PhotoAuthorizationError(401, "unauthenticated");
      const actor = await introspectCredential(cookies.credential, request.signal);
      if (captured !== null && !actorMatchesCapture(actor, captured)) {
        throw new PhotoAuthorizationError(403, "scope_changed");
      }
      if (isPhotoIdentityExpired(actor, now())) throw new PhotoAuthorizationError(401, "unauthenticated");
      return perform(cookies.credential, actor);
    },
  };
}
