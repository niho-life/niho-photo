import type { PhotoAuthCopy } from "./config.ts";

export const AUTH_PUBLIC_PATHS = {
  start: "/auth/start",
  callback: "/auth/callback",
  session: "/auth/session",
  refresh: "/auth/refresh",
  logout: "/auth/logout",
  cancel: "/auth/cancel",
} as const;

export interface AutoFormOptions {
  readonly target: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly formAction: string;
  readonly title: string;
  readonly message: string;
  readonly submitLabel: string;
  readonly nonce: string;
}

export interface CallbackFields {
  readonly code: string;
  readonly state: string;
}

export interface CallbackBodyOptions {
  readonly timeoutMilliseconds?: number;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

const MAX_CALLBACK_BODY_BYTES = 4 * 1024;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? "");
}

export function autoFormResponse(options: AutoFormOptions): Response {
  const inputs = Object.entries(options.fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(options.title)}</title></head><body><main><p>${escapeHtml(options.message)}</p><form id="auth-form" method="post" action="${escapeHtml(options.target)}">${inputs}<button type="submit">${escapeHtml(options.submitLabel)}</button></form></main><script nonce="${escapeHtml(options.nonce)}">document.getElementById("auth-form").submit();</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src 'nonce-${options.nonce}'`,
        `form-action ${options.formAction}`,
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ].join("; "),
      "Content-Type": "text/html; charset=utf-8",
      // Navigation POSTs need a non-null Origin while still withholding path/query secrets.
      // https://fetch.spec.whatwg.org/#append-a-request-origin-header
      "Referrer-Policy": "origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function startFormCopy(copy: PhotoAuthCopy): Pick<AutoFormOptions, "title" | "message" | "submitLabel"> {
  return { title: copy.startTitle, message: copy.startMessage, submitLabel: copy.startSubmitLabel };
}

export function relayFormCopy(copy: PhotoAuthCopy): Pick<AutoFormOptions, "title" | "message" | "submitLabel"> {
  return { title: copy.relayTitle, message: copy.relayMessage, submitLabel: copy.relaySubmitLabel };
}

export function validateFixedRequest(
  request: Request,
  expectedOrigin: string,
  expectedPath: string,
  allowedOrigins: readonly string[],
  method = "POST",
): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  return request.method === method
    && url.origin === expectedOrigin
    && url.pathname === expectedPath
    && url.search === ""
    && url.hash === ""
    && request.headers.get("host")?.toLowerCase() === new URL(expectedOrigin).host
    && allowedOrigins.includes(request.headers.get("origin") ?? "");
}

export function hasEmptyBody(request: Request): boolean {
  const length = request.headers.get("content-length");
  return request.body === null && (length === null || length === "0");
}

function badCallback(status = 400): Response {
  return Response.json(
    { error: status === 413 ? "payload_too_large" : "bad_request" },
    { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}

export async function readCallbackFields(
  request: Request,
  options: CallbackBodyOptions = {},
): Promise<CallbackFields | Response> {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) return badCallback();
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_CALLBACK_BODY_BYTES)) {
    return badCallback(Number(declared) > MAX_CALLBACK_BODY_BYTES ? 413 : 400);
  }
  if (request.signal.aborted || request.body === null) return badCallback();
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return badCallback();
  }
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 2_000;
  const setTimer = options.setTimer ?? ((callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let rejectAbort: (() => void) | undefined;
  const abortGate = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new Error("aborted"));
  });
  const abort = () => rejectAbort?.();
  request.signal.addEventListener("abort", abort, { once: true });
  let rejectTimeout: (() => void) | undefined;
  const timeoutGate = new Promise<never>((_resolve, reject) => {
    rejectTimeout = () => reject(new Error("timeout"));
  });
  const timer = setTimer(() => rejectTimeout?.(), timeoutMilliseconds);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), abortGate, timeoutGate]);
      if (chunk.done) {
        completed = true;
        break;
      }
      total += chunk.value.byteLength;
      if (total > MAX_CALLBACK_BODY_BYTES) return badCallback(413);
      chunks.push(chunk.value);
    }
  } catch {
    return badCallback();
  } finally {
    clearTimer(timer);
    request.signal.removeEventListener("abort", abort);
    if (!completed) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // The fixed 400 response is authoritative for hostile or already-used streams.
      }
    }
    if (completed) reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return badCallback();
  }
  const values = new Map<string, string>();
  const parts = body.split("&");
  if (parts.length !== 2) return badCallback();
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator <= 0) return badCallback();
    const name = part.slice(0, separator);
    if ((name !== "code" && name !== "state") || values.has(name)) return badCallback();
    try {
      values.set(name, decodeURIComponent(part.slice(separator + 1).replace(/\+/g, " ")));
    } catch {
      return badCallback();
    }
  }
  const code = values.get("code");
  const state = values.get("state");
  return code !== undefined && state !== undefined
    && /^[A-Za-z0-9._~-]{16,512}$/.test(code)
    && /^[A-Za-z0-9_-]{43,128}$/.test(state)
    ? { code, state }
    : badCallback();
}
