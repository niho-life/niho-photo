import { PersonalPhotoCloudError } from "./errors";

export interface BoundedAwaitOptions<T> {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly onTimeout?: () => void;
  readonly onAbort?: () => void;
  readonly onLateResolve?: (value: T) => void;
}

export async function awaitBounded<T>(
  promise: PromiseLike<T>,
  options: BoundedAwaitOptions<T>,
): Promise<T> {
  if (options.signal.aborted) {
    try { options.onAbort?.(); } catch { /* best-effort disposal */ }
    void Promise.resolve(promise).then((value) => {
      try { options.onLateResolve?.(value); } catch { /* best-effort late disposal */ }
    }, () => undefined);
    throw abortReason(options.signal);
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
    };
    const resolveOnce = (value: T): void => {
      if (settled) {
        try { options.onLateResolve?.(value); } catch { /* best-effort late disposal */ }
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = (): void => {
      try { options.onAbort?.(); } finally { rejectOnce(abortReason(options.signal)); }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      try { options.onTimeout?.(); } finally {
        rejectOnce(new PersonalPhotoCloudError("unavailable"));
      }
    }, options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve(promise).then(resolveOnce, rejectOnce);
  });
}

export function linkedAbortController(...signals: readonly AbortSignal[]): {
  readonly controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of signals) {
    const abort = (): void => controller.abort(abortReason(signal));
    listeners.set(signal, abort);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  let disposed = false;
  return {
    controller,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [signal, abort] of listeners) signal.removeEventListener("abort", abort);
      listeners.clear();
    },
  };
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

export function cancelResponse(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}
