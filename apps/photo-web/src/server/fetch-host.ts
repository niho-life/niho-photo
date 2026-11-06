import { AUTH_PUBLIC_PATHS } from "../../../../packages/photo-cloud-session/src/server/http.ts";
import type { PhotoAuthService } from "../../../../packages/photo-cloud-session/src/server/service.ts";
import type { PhotoWebFetchHostOptions, PhotoWebNavigationErrorCopy } from "./types.ts";

type Handler = (request: Request) => Promise<Response>;
type PortOutcome<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error" }
  | { readonly kind: "aborted" };
type PortWaitState<T> = {
  signal: AbortSignal | null;
  abort: (() => void) | null;
  resolve: ((outcome: PortOutcome<T>) => void) | null;
};
type Configuration = {
  readonly origin: string;
  readonly cloudEnabled: boolean;
  readonly staticGet: (path: string, head?: boolean) => Response | null;
  readonly auth: ReadonlyMap<string, Handler>;
  readonly cloud: ((request: Request) => Promise<Response | null>) | null;
  readonly documentHeaders: readonly (readonly [string, string])[];
  readonly copy: PhotoWebNavigationErrorCopy;
};

const AUTH_METHODS: Readonly<Record<string, keyof Pick<PhotoAuthService, "start" | "callback" | "session" | "refresh" | "logout" | "cancel">>> = Object.freeze({
  [AUTH_PUBLIC_PATHS.start]: "start",
  [AUTH_PUBLIC_PATHS.callback]: "callback",
  [AUTH_PUBLIC_PATHS.session]: "session",
  [AUTH_PUBLIC_PATHS.refresh]: "refresh",
  [AUTH_PUBLIC_PATHS.logout]: "logout",
  [AUTH_PUBLIC_PATHS.cancel]: "cancel",
});
const FORBIDDEN_DOCUMENT_HEADERS = new Set([
  "cache-control", "connection", "content-encoding", "content-length", "content-type", "etag",
  "service-worker-allowed", "set-cookie", "transfer-encoding", "vary",
]);

function failure(status: number, error: string, extra?: Readonly<Record<string, string>>): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  return Response.json({ error }, { status, headers });
}

function cancelled(): Response {
  return failure(499, "request_cancelled");
}

function validCopy(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 4096
    && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
}

function configuration(options: PhotoWebFetchHostOptions): Configuration | null {
  try {
    if (options === null || typeof options !== "object" || options.enabled !== true) return null;
    if (typeof options.origin !== "string") return null;
    const origin = new URL(options.origin);
    if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== "" || origin.pathname !== "/"
      || origin.search !== "" || origin.hash !== "" || origin.href !== `${origin.origin}/`) return null;
    if (options.staticStore === null || typeof options.staticStore !== "object" || typeof options.staticStore.get !== "function"
      || options.auth === null || typeof options.auth !== "object") return null;
    const staticGet = options.staticStore.get.bind(options.staticStore);
    const auth = new Map<string, Handler>();
    for (const [route, method] of Object.entries(AUTH_METHODS)) {
      const candidate = options.auth[method];
      if (typeof candidate !== "function") return null;
      auth.set(route, candidate.bind(options.auth));
    }
    const cloudValue = options.cloudHandler;
    if (cloudValue !== undefined && typeof cloudValue !== "function") return null;
    if (options.documentHeaders === null || typeof options.documentHeaders !== "object" || Array.isArray(options.documentHeaders)) return null;
    const documentHeaders: [string, string][] = [];
    const seenHeaders = new Set<string>();
    let hasCsp = false;
    const rawHeaders = Object.entries(options.documentHeaders);
    if (rawHeaders.length === 0 || rawHeaders.length > 64) return null;
    for (const [name, value] of rawHeaders) {
      const lower = name.toLowerCase();
      if (seenHeaders.has(lower) || FORBIDDEN_DOCUMENT_HEADERS.has(lower) || lower.startsWith("access-control-") || typeof value !== "string"
        || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > 8192 || /[\r\n\u0000]/u.test(value)) return null;
      const probe = new Headers({ [name]: value });
      const normalized = probe.get(name);
      if (normalized === null) return null;
      if (lower === "content-security-policy") hasCsp = true;
      seenHeaders.add(lower);
      documentHeaders.push([name, normalized]);
    }
    if (!hasCsp) return null;
    const copy = options.navigationErrorCopy;
    if (copy === null || typeof copy !== "object" || !validCopy(copy.title) || !validCopy(copy.message) || !validCopy(copy.homeLabel)) {
      return null;
    }
    return Object.freeze({
      origin: origin.origin,
      cloudEnabled: options.cloudEnabled === true,
      staticGet,
      auth,
      cloud: cloudValue === undefined ? null : cloudValue,
      documentHeaders: Object.freeze(documentHeaders.map((item) => Object.freeze(item))),
      copy: Object.freeze({ title: copy.title, message: copy.message, homeLabel: copy.homeLabel }),
    });
  } catch {
    return null;
  }
}

function fixedPublicResponse(pathname: string, head: boolean, cloudEnabled: boolean): Response | null {
  let bytes: Uint8Array;
  let contentType: string;
  if (pathname === "/healthz") {
    bytes = new TextEncoder().encode("ready\n");
    contentType = "text/plain; charset=utf-8";
  } else if (pathname === "/photo-runtime.json") {
    bytes = new TextEncoder().encode(`${JSON.stringify({ cloudEnabled })}\n`);
    contentType = "application/json; charset=utf-8";
  } else return null;
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(head ? null : body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(bytes.byteLength),
      "Content-Type": contentType,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function copyHeaders(source: Headers): Headers {
  const target = new Headers();
  for (const [name, value] of source) {
    if (name.toLowerCase() !== "set-cookie") target.append(name, value);
  }
  const cookieHeaders = source as Headers & { getSetCookie?: () => string[] };
  if (typeof cookieHeaders.getSetCookie === "function") {
    for (const cookie of cookieHeaders.getSetCookie()) target.append("Set-Cookie", cookie);
  } else {
    const cookie = source.get("set-cookie");
    if (cookie !== null) target.append("Set-Cookie", cookie);
  }
  return target;
}

function cloneResponse(response: Response, mutate: (headers: Headers) => void): Response {
  const headers = copyHeaders(response.headers);
  mutate(headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function cancelBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    // Cleanup never controls the public response.
  }
}

function waitForPort<T>(pending: Promise<T>, signal: AbortSignal): Promise<PortOutcome<T>> {
  return new Promise((resolve) => {
    const state: PortWaitState<T> = { signal, abort: null, resolve };
    const finish = (outcome: PortOutcome<T>): boolean => {
      const complete = state.resolve;
      if (complete === null) return false;
      const activeSignal = state.signal;
      const abort = state.abort;
      state.signal = null;
      state.abort = null;
      state.resolve = null;
      if (activeSignal !== null && abort !== null) activeSignal.removeEventListener("abort", abort);
      complete(outcome);
      return true;
    };
    state.abort = () => { finish({ kind: "aborted" }); };
    signal.addEventListener("abort", state.abort, { once: true });
    if (signal.aborted) state.abort();
    void pending.then(
      (value) => {
        if (!finish({ kind: "value", value }) && value instanceof Response) cancelBody(value);
      },
      () => { finish({ kind: "error" }); },
    );
  });
}

type PortBudget = { pending: number };
const MAX_PENDING_PORTS = 16;

async function runPort<T>(signal: AbortSignal, invoke: () => Promise<T>, budget: PortBudget): Promise<PortOutcome<T>> {
  if (signal.aborted) return { kind: "aborted" };
  if (budget.pending >= MAX_PENDING_PORTS) return { kind: "error" };
  budget.pending += 1;
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(invoke());
  } catch {
    budget.pending -= 1;
    return signal.aborted ? { kind: "aborted" } : { kind: "error" };
  }
  // An aborted caller must not release a still-running dependency's retained slot.
  const settled = pending.then(
    (value) => { budget.pending -= 1; return value; },
    (error: unknown) => { budget.pending -= 1; throw error; },
  );
  return waitForPort(settled, signal);
}

function dynamicResponse(response: Response): Response {
  return cloneResponse(response, (headers) => {
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith("access-control-")) headers.delete(name);
    }
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
  });
}

function anonymousResponse(response: Response, headersToApply: Configuration["documentHeaders"]): Response {
  return cloneResponse(response, (headers) => {
    for (const [name, value] of headersToApply) headers.set(name, value);
  });
}

function safeResponse(response: Response, transform: (value: Response) => Response): Response {
  try {
    return transform(response);
  } catch {
    cancelBody(response);
    return failure(503, "temporarily_unavailable");
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? "");
}

function isHtmlNavigation(request: Request): boolean {
  return request.headers.get("sec-fetch-mode")?.toLowerCase() === "navigate"
    || request.headers.get("accept")?.split(",").some((item) => item.trim().toLowerCase().startsWith("text/html")) === true;
}

function navigationFailure(response: Response, copy: PhotoWebNavigationErrorCopy): Response {
  cancelBody(response);
  try {
    const headers = new Headers();
    const sourceCookies = response.headers as Headers & { getSetCookie?: () => string[] };
    if (typeof sourceCookies.getSetCookie === "function") {
      for (const cookie of sourceCookies.getSetCookie()) headers.append("Set-Cookie", cookie);
    } else {
      const cookie = response.headers.get("set-cookie");
      if (cookie !== null) headers.append("Set-Cookie", cookie);
    }
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(copy.title)}</title></head><body><main><h1>${escapeHtml(copy.title)}</h1><p>${escapeHtml(copy.message)}</p><a href="/">${escapeHtml(copy.homeLabel)}</a></main></body></html>`;
    return new Response(html, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return failure(503, "temporarily_unavailable");
  }
}

export function createPhotoWebFetchHost(options: PhotoWebFetchHostOptions): (request: Request) => Promise<Response> {
  const config = configuration(options);
  if (config === null) return async () => failure(503, "temporarily_unavailable");
  const budget: PortBudget = { pending: 0 };

  return async (request: Request): Promise<Response> => {
    if (request.signal.aborted) return cancelled();
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return failure(400, "bad_request");
    }
    if (url.origin !== config.origin || url.hash !== "") return failure(400, "bad_request");

    const fixed = fixedPublicResponse(url.pathname, request.method === "HEAD", config.cloudEnabled);
    if (fixed !== null) {
      if (url.search !== "") return failure(400, "bad_request");
      if (request.method !== "GET" && request.method !== "HEAD") {
        return failure(405, "method_not_allowed", { Allow: "GET, HEAD" });
      }
      return fixed;
    }

    let staticResponse: Response | null;
    try {
      staticResponse = config.staticGet(url.pathname, request.method === "HEAD");
    } catch {
      return failure(503, "temporarily_unavailable");
    }
    if (staticResponse !== null) {
      if (!(staticResponse instanceof Response)) return failure(503, "temporarily_unavailable");
      if (url.search !== "") {
        cancelBody(staticResponse);
        return failure(400, "bad_request");
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        cancelBody(staticResponse);
        return failure(405, "method_not_allowed", { Allow: "GET, HEAD" });
      }
      if (request.signal.aborted) {
        cancelBody(staticResponse);
        return cancelled();
      }
      return safeResponse(staticResponse, (response) => anonymousResponse(response, config.documentHeaders));
    }

    const auth = config.auth.get(url.pathname);
    if (auth !== undefined) {
      const outcome = await runPort(request.signal, () => auth(request), budget);
      if (outcome.kind === "aborted") return cancelled();
      if (outcome.kind === "error" || !(outcome.value instanceof Response)) return failure(503, "temporarily_unavailable");
      const response = outcome.value;
      if (request.signal.aborted) { cancelBody(response); return cancelled(); }
      if ((url.pathname === AUTH_PUBLIC_PATHS.start || url.pathname === AUTH_PUBLIC_PATHS.callback)
        && response.status >= 400 && isHtmlNavigation(request)) return navigationFailure(response, config.copy);
      return safeResponse(response, dynamicResponse);
    }

    if (config.cloud === null) return failure(404, "not_found");
    const cloud = config.cloud;
    const outcome = await runPort(request.signal, () => cloud(request), budget);
    if (outcome.kind === "aborted") return cancelled();
    if (outcome.kind === "error" || (outcome.value !== null && !(outcome.value instanceof Response))) {
      return failure(503, "temporarily_unavailable");
    }
    const response = outcome.value;
    if (request.signal.aborted) { if (response !== null) cancelBody(response); return cancelled(); }
    return response === null ? failure(404, "not_found") : safeResponse(response, dynamicResponse);
  };
}
