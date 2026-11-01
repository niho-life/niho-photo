import type { PersonalCloudPhotoBinding } from "./App";

/** Issued by the trusted native session, never inferred from a login snapshot or a default actor. */
export type MacPhotoCloudScope = Readonly<{ actorId: string; libraryId: string; sessionEpoch: string }>;
export type MacPhotoCopyStatus = Readonly<{
  requestId: string;
  photoId: string;
  phase: "pending" | "copying" | "verifying" | "stored" | "cancelled" | "failed";
  fraction: number | null;
  /** Only native may assert this after original, referenced masks and recipe reconciliation. */
  completed?: { original: true; masks: true; recipe: true; cloudPhotoId: string };
}>;

/**
 * Opaque IPC boundary for a future formally authenticated native transport. Native owns file identity,
 * digest, credentials, upload tickets and durable recovery. These values never cross this interface.
 * start must journal requestId + source identity before uploads.start, and retain that identity on retry.
 * A lost start/complete reply is reconciled using the same requestId, never a new registration.
 */
export type MacPhotoCopyNative = {
  /** Recover only this session's operation for the selected opaque photo; return no credential/source data. */
  recover(scope: MacPhotoCloudScope, photoId: string): Promise<{ requestId: string; photoId: string } | null>;
  start(scope: MacPhotoCloudScope, request: { requestId: string; photoId: string }): Promise<void>;
  status(scope: MacPhotoCloudScope, requestId: string): Promise<MacPhotoCopyStatus | null>;
  cancel(scope: MacPhotoCloudScope, requestId: string): Promise<void>;
};

export class MacPhotoCopyError extends Error {
  constructor(readonly code: "not_connected" | "scope_changed" | "invalid_result" | "incomplete" | "cancelled") {
    super(code);
    this.name = "MacPhotoCopyError";
  }
}

function sameScope(left: MacPhotoCloudScope | null, right: MacPhotoCloudScope) {
  return left?.actorId === right.actorId && left.libraryId === right.libraryId && left.sessionEpoch === right.sessionEpoch;
}

type Connection = {
  scope: MacPhotoCloudScope;
  currentScope: () => MacPhotoCloudScope | null;
  subscribeScopeChange: (listener: () => void) => () => void;
  native: MacPhotoCopyNative;
  /** P08's immutable, verified adapter is supplied by the trusted host; no mutable source import. */
  library: PersonalCloudPhotoBinding["library"];
  host: PersonalCloudPhotoBinding["host"];
};

/** No production connection exists until P01/P03/P08 provide all of these dependencies. */
export function createMacPersonalCloudPhotoBinding(connection: Connection | null): {
  state: "not_connected";
  binding: undefined;
  dispose: () => void;
} | {
  state: "connected";
  binding: PersonalCloudPhotoBinding;
  dispose: () => void;
} {
  if (!connection) return { state: "not_connected", binding: undefined, dispose: () => {} };
  const { native, library, host } = connection;
  const scope = Object.freeze({ ...connection.scope });
  if (!scope.actorId.trim() || !scope.libraryId.trim() || !scope.sessionEpoch.trim() || library.place !== "cloud" || !sameScope(connection.currentScope(), scope)) {
    return { state: "not_connected", binding: undefined, dispose: () => {} };
  }
  let disposed = false;
  let invalidated = false;
  const pending = new Map<string, string>();
  const active = new Map<string, AbortController>();
  const assertCurrent = () => {
    if (disposed || invalidated || !sameScope(connection.currentScope(), scope)) throw new MacPhotoCopyError("scope_changed");
  };
  const abortAll = () => { for (const controller of active.values()) controller.abort(); };
  const unsubscribe = connection.subscribeScopeChange(() => {
    if (!sameScope(connection.currentScope(), scope)) { invalidated = true; abortAll(); }
  });

  const binding: PersonalCloudPhotoBinding = {
    library, host, actorId: scope.actorId,
    scopeKey: `personal:${scope.libraryId}:${scope.actorId}`,
    async copyLocalPhoto(photoId, options) {
      assertCurrent();
      if (options.signal.aborted) throw new MacPhotoCopyError("cancelled");
      // A second click cannot create a second operation. UI retries reuse the native journal key.
      if (!photoId.trim() || active.has(photoId)) throw new MacPhotoCopyError("incomplete");
      let requestId = pending.get(photoId) ?? null;
      const controller = new AbortController();
      active.set(photoId, controller);
      const cancel = () => controller.abort();
      options.signal.addEventListener("abort", cancel, { once: true });
      let cancelSent = false;
      const abortNative = () => {
        if (cancelSent || requestId === null) return;
        cancelSent = true;
        // Always address the captured scope; never cancel a new user's operation.
        void native.cancel(scope, requestId).catch(() => {});
      };
      controller.signal.addEventListener("abort", abortNative, { once: true });
      const check = () => {
        assertCurrent();
        if (controller.signal.aborted) throw new MacPhotoCopyError("cancelled");
      };
      try {
        check();
        if (requestId === null) {
          const recovered = await abortable(native.recover(scope, photoId), controller.signal);
          check();
          if (recovered && (recovered.photoId !== photoId || !recovered.requestId.trim())) throw new MacPhotoCopyError("invalid_result");
          requestId = recovered?.requestId ?? crypto.randomUUID();
          pending.set(photoId, requestId);
        }
        // This lookup also covers an unknown result after network loss or UI remount/retry.
        let status = await abortable(native.status(scope, requestId), controller.signal);
        check();
        if (status && (status.requestId !== requestId || status.photoId !== photoId)) throw new MacPhotoCopyError("invalid_result");
        if (status?.phase === "cancelled") {
          // Cancellation is confirmed; a new explicit retry starts a fresh journal entry.
          requestId = crypto.randomUUID();
          pending.set(photoId, requestId);
          status = null;
        }
        if (status === null || status.phase === "failed") {
          await abortable(native.start(scope, { requestId, photoId }), controller.signal);
          check();
          status = null;
        }
        for (;;) {
          if (status === null) status = await abortable(native.status(scope, requestId), controller.signal);
          check();
          if (!status || status.requestId !== requestId || status.photoId !== photoId ||
            !["pending", "copying", "verifying", "stored", "cancelled", "failed"].includes(status.phase)) throw new MacPhotoCopyError("invalid_result");
          if (status.phase === "stored") {
            const complete = status.completed;
            if (!complete || complete.original !== true || complete.masks !== true || complete.recipe !== true || !complete.cloudPhotoId.trim()) {
              throw new MacPhotoCopyError("incomplete");
            }
            pending.delete(photoId);
            return { cloudPhotoId: complete.cloudPhotoId };
          }
          if (status.phase === "cancelled") {
            // A confirmed cancellation may start afresh; an unconfirmed cancel retains the old key.
            pending.delete(photoId);
            throw new MacPhotoCopyError("cancelled");
          }
          if (status.phase === "failed") throw new MacPhotoCopyError("incomplete");
          options.onProgress(status.fraction === null || !Number.isFinite(status.fraction) ? null : Math.min(1, Math.max(0, status.fraction)));
          await delay(controller.signal);
          status = null;
        }
      } finally {
        options.signal.removeEventListener("abort", cancel);
        controller.signal.removeEventListener("abort", abortNative);
        active.delete(photoId);
      }
    },
  };
  return {
    state: "connected", binding,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      abortAll();
      pending.clear();
    },
  };
}

function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new MacPhotoCopyError("cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A non-cooperating IPC promise must not keep a cancelled UI operation alive. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new MacPhotoCopyError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
