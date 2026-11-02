import {
  PhotoSessionHostError,
  type PhotoSessionHostBridge,
} from "./controller.ts";
import { parsePhotoIdentity } from "./identity.ts";

const BROWSER_AUTH_PATHS = {
  read: "/auth/session",
  refresh: "/auth/refresh",
  logout: "/auth/logout",
  cancel: "/auth/cancel",
} as const;
const MAX_IDENTITY_RESPONSE_BYTES = 8 * 1024;
const BROWSER_REQUEST_TIMEOUT_MS = 10_000;

export interface BrowserPhotoSessionHostOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // The fixed public error is authoritative.
  }
}

async function parseIdentityResponse(
  response: Response,
  signal: AbortSignal,
  now: () => number,
): Promise<unknown> {
  if (response.status === 401) {
    discard(response);
    throw new PhotoSessionHostError("unauthenticated");
  }
  if (response.status === 503) {
    discard(response);
    throw new PhotoSessionHostError("temporarily-unavailable");
  }
  if (response.status !== 200
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type")?.trim() ?? "")) {
    discard(response);
    throw new PhotoSessionHostError("invalid-response");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_IDENTITY_RESPONSE_BYTES)) {
    discard(response);
    throw new PhotoSessionHostError("invalid-response");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new PhotoSessionHostError("invalid-response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  let rejectAbort: (() => void) | undefined;
  const abortGate = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new PhotoSessionHostError("cancelled"));
  });
  const abort = () => rejectAbort?.();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), abortGate]);
      if (chunk.done) {
        completed = true;
        break;
      }
      total += chunk.value.byteLength;
      if (total > MAX_IDENTITY_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new PhotoSessionHostError("invalid-response");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof PhotoSessionHostError) throw error;
    throw new PhotoSessionHostError("temporarily-unavailable");
  } finally {
    signal.removeEventListener("abort", abort);
    if (completed) reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (signal.aborted) throw new PhotoSessionHostError("cancelled");
    const identity = parsePhotoIdentity(value, { now: now(), requiredTransport: "browser-session" });
    if (identity === null) throw new PhotoSessionHostError("invalid-response");
    return identity;
  } catch {
    if (signal.aborted) throw new PhotoSessionHostError("cancelled");
    throw new PhotoSessionHostError("invalid-response");
  }
}

async function request<T>(
  fetchFn: typeof fetch,
  path: string,
  method: "GET" | "POST",
  callerSignal: AbortSignal,
  setTimer: (callback: () => void, milliseconds: number) => unknown,
  clearTimer: (timer: unknown) => void,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  if (callerSignal.aborted) controller.abort();
  const timer = setTimer(() => controller.abort(), BROWSER_REQUEST_TIMEOUT_MS);
  let rejectAbort: (() => void) | undefined;
  const abortGate = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new PhotoSessionHostError(callerSignal.aborted ? "cancelled" : "temporarily-unavailable"));
  });
  const rejectOnAbort = () => rejectAbort?.();
  controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  if (controller.signal.aborted) rejectOnAbort();
  try {
    if (controller.signal.aborted) return await abortGate;
    const fetchRequest = fetchFn(path, {
      method,
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: controller.signal,
    });
    const response = await Promise.race([fetchRequest, abortGate]);
    const value = await Promise.race([consume(response, controller.signal), abortGate]);
    if (controller.signal.aborted) throw new PhotoSessionHostError(callerSignal.aborted ? "cancelled" : "temporarily-unavailable");
    return value;
  } catch (error) {
    if (error instanceof PhotoSessionHostError) throw error;
    throw new PhotoSessionHostError(callerSignal.aborted ? "cancelled" : "temporarily-unavailable");
  } finally {
    clearTimer(timer);
    controller.signal.removeEventListener("abort", rejectOnAbort);
    callerSignal.removeEventListener("abort", abortFromCaller);
  }
}

async function consumeMutation(response: Response): Promise<void> {
  if (response.status === 204) {
    discard(response);
    return;
  }
  discard(response);
  if (response.status === 401) throw new PhotoSessionHostError("unauthenticated");
  if (response.status === 503) throw new PhotoSessionHostError("temporarily-unavailable");
  throw new PhotoSessionHostError("invalid-response");
}

/** Fixed same-origin bridge. It never reads or returns the HttpOnly Photo cookie. */
export function createBrowserPhotoSessionHost(
  options: BrowserPhotoSessionHostOptions = {},
): PhotoSessionHostBridge {
  const fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  return {
    async read(signal) {
      return request(fetchFn, BROWSER_AUTH_PATHS.read, "GET", signal, setTimer, clearTimer, async (response, requestSignal) => {
        if (response.status === 401) {
          discard(response);
          return null;
        }
        return parseIdentityResponse(response, requestSignal, now);
      });
    },
    async refresh(signal) {
      return request(fetchFn, BROWSER_AUTH_PATHS.refresh, "POST", signal, setTimer, clearTimer,
        (response, requestSignal) => parseIdentityResponse(response, requestSignal, now));
    },
    async logout(signal) {
      await request(fetchFn, BROWSER_AUTH_PATHS.logout, "POST", signal, setTimer, clearTimer, consumeMutation);
    },
    async cancel(signal) {
      await request(fetchFn, BROWSER_AUTH_PATHS.cancel, "POST", signal, setTimer, clearTimer, consumeMutation);
    },
  };
}
