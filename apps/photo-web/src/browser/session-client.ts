import type {
  PersonalPhotoCloudClient,
  PhotoContent,
  PhotoOperation,
  PhotoOperationMap,
  PhotoRequestOptions,
  PhotoSessionScope,
} from "@niho/photo-personal-cloud-contract";
import type { PersonalPhotoCloudIdentity } from "@niho/photo-cloud-library";
import {
  samePhotoIdentityScope,
  type PhotoIdentity,
  type PhotoSessionController,
} from "@niho/photo-cloud-session";

import { abortReason, linkedAbortController } from "../../../../packages/photo-cloud-library/src/await.ts";
import { PersonalPhotoCloudError } from "../../../../packages/photo-cloud-library/src/errors.ts";

type RequestBox<T> = { readonly value: T } | { readonly error: unknown };
type AbortLink = ReturnType<typeof linkedAbortController>;

export function createPhotoWebCloudIdentity(options: {
  readonly session: PhotoSessionController;
  readonly identity: PhotoIdentity;
  readonly scopeSignal: AbortSignal;
}): PersonalPhotoCloudIdentity {
  const { session, scopeSignal } = options;
  const expected = snapshotIdentity(options.identity);

  return {
    getSnapshot() {
      if (scopeSignal.aborted || expected.transport !== "browser-session") return null;
      const snapshot = session.getSnapshot();
      if ((snapshot.phase !== "ready" && snapshot.phase !== "verifying")
        || snapshot.identity === null
        || !samePhotoIdentityScope(expected, snapshot.identity)) return null;
      return snapshot.identity;
    },
    subscribe(listener) {
      let active = true;
      const notify = (): void => { if (active) listener(); };
      const unsubscribeSession = session.subscribe(notify);
      scopeSignal.addEventListener("abort", notify, { once: true });
      return () => {
        if (!active) return;
        active = false;
        unsubscribeSession();
        scopeSignal.removeEventListener("abort", notify);
      };
    },
    subscribeScopeRevoked(listener) {
      return session.onEvent((event) => {
        if (event.type !== "scope-invalidated" || event.reason === "disposed"
          || !samePhotoIdentityScope(expected, event.previous)) return;
        listener();
      });
    },
  };
}

export function createCapturedPhotoWebCloudClient(options: {
  readonly client: PersonalPhotoCloudClient;
  readonly session: PhotoSessionController;
  readonly identity: PhotoIdentity;
  readonly scopeSignal: AbortSignal;
}): PersonalPhotoCloudClient {
  const { client, session, scopeSignal } = options;
  const expected = snapshotIdentity(options.identity);
  const rawScope = client.scope;
  const scope = snapshotScope(rawScope);
  const requestRaw = client.request.bind(client);
  const disposeRaw = client.dispose.bind(client);
  const lifecycle = new AbortController();
  let disposed = false;

  if (expected.transport !== "browser-session"
    || scope.actorId !== expected.userId
    || scope.sessionEpoch !== expected.sessionEpoch) invalidIdentity();

  const assertRawScope = (): void => {
    const current = client.scope;
    if (current !== rawScope
      || current.actorId !== scope.actorId
      || current.libraryId !== scope.libraryId
      || current.sessionEpoch !== scope.sessionEpoch) {
      throw new PersonalPhotoCloudError("scope_changed");
    }
  };

  return {
    scope,
    async request<K extends PhotoOperation>(
      operation: K,
      request: PhotoOperationMap[K]["request"],
      requestOptions: PhotoRequestOptions<K>,
    ): Promise<PhotoOperationMap[K]["response"]> {
      const callerSignal = requestOptions.signal;
      const idempotencyKey = "idempotencyKey" in requestOptions ? requestOptions.idempotencyKey : undefined;
      const before = session.getSnapshot();
      if (disposed) throw new PersonalPhotoCloudError("disposed");
      if (scopeSignal.aborted
        || before.phase !== "ready"
        || before.identity === null
        || !samePhotoIdentityScope(expected, before.identity)) {
        throw fenceError(callerSignal, scopeSignal, lifecycle.signal);
      }
      assertRawScope();

      let completed: RequestBox<PhotoOperationMap[K]["response"]> | null = null;
      const publicLink = linkedAbortController(...new Set([callerSignal, scopeSignal, lifecycle.signal]));
      const capturedPromise = session.runCaptured(async (capture) => {
        let link: AbortLink | null = null;
        let allocatedContent: PhotoContent | null = null;
        let contentOwnsLink = false;
        try {
          if (!samePhotoIdentityScope(expected, capture.identity)) {
            throw new PersonalPhotoCloudError("scope_changed");
          }
          assertRawScope();
          link = linkedAbortController(...new Set([callerSignal, scopeSignal, capture.signal, lifecycle.signal]));
          if (link.controller.signal.aborted) throw fenceError(callerSignal, scopeSignal, lifecycle.signal, capture.signal);
          const linkedOptions = idempotencyKey === undefined
            ? { signal: link.controller.signal }
            : { signal: link.controller.signal, idempotencyKey };
          const pending = requestRaw(operation, request, linkedOptions as PhotoRequestOptions<K>);
          const value = await awaitAbortable(pending, link.controller.signal, (late) => {
            if (operation === "content.get") cancelContent(late as PhotoContent, link?.controller.signal.reason);
          });
          if (operation === "content.get") allocatedContent = value as PhotoContent;
          if (link.controller.signal.aborted) {
            throw fenceError(callerSignal, scopeSignal, lifecycle.signal, capture.signal);
          }
          assertRawScope();
          const exposed = operation === "content.get"
            ? finalizeContent(
              allocatedContent!,
              link,
              () => fenceError(callerSignal, scopeSignal, lifecycle.signal, capture.signal),
            ) as PhotoOperationMap[K]["response"]
            : value;
          contentOwnsLink = operation === "content.get";
          allocatedContent = null;
          completed = { value: exposed };
          return completed;
        } catch (error) {
          const boxedError = fenceErrorOr(error, callerSignal, scopeSignal, lifecycle.signal, capture.signal);
          if (allocatedContent !== null) cancelContent(allocatedContent, boxedError);
          completed = { error: boxedError };
          return completed;
        } finally {
          if (!contentOwnsLink) link?.dispose();
        }
      });
      let captured: Awaited<typeof capturedPromise>;
      try {
        captured = await awaitAbortable(capturedPromise, publicLink.controller.signal, (late) => {
          const reason = fenceError(callerSignal, scopeSignal, lifecycle.signal);
          if (late.status === "accepted") cancelBoxContent(operation, late.value, reason);
          else cancelBoxContent(operation, completed, reason);
        });
      } catch (error) {
        throw fenceErrorOr(error, callerSignal, scopeSignal, lifecycle.signal);
      } finally {
        publicLink.dispose();
      }

      if (captured.status !== "accepted") {
        cancelBoxContent(operation, completed, new PersonalPhotoCloudError("scope_changed"));
        throw disposed
          ? new PersonalPhotoCloudError("disposed")
          : fenceError(callerSignal, scopeSignal, lifecycle.signal);
      }
      const afterFence = currentFenceError(callerSignal, scopeSignal, lifecycle.signal);
      try {
        assertRawScope();
      } catch (error) {
        cancelBoxContent(operation, captured.value, error);
        throw error;
      }
      if (afterFence !== null) {
        cancelBoxContent(operation, captured.value, afterFence);
        throw afterFence;
      }
      if ("error" in captured.value) throw captured.value.error;
      return captured.value.value;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifecycle.abort(new PersonalPhotoCloudError("disposed"));
      disposeRaw();
    },
  };
}

function snapshotIdentity(identity: PhotoIdentity): Readonly<PhotoIdentity> {
  return Object.freeze({
    userId: identity.userId,
    sessionId: identity.sessionId,
    sessionEpoch: identity.sessionEpoch,
    transport: identity.transport,
    expiresAt: identity.expiresAt,
  });
}

function snapshotScope(scope: PhotoSessionScope): Readonly<PhotoSessionScope> {
  if (!nonEmpty(scope.actorId) || !nonEmpty(scope.libraryId) || !nonEmpty(scope.sessionEpoch)) invalidIdentity();
  return Object.freeze({
    actorId: scope.actorId,
    libraryId: scope.libraryId,
    sessionEpoch: scope.sessionEpoch,
  });
}

function invalidIdentity(): never {
  throw new PersonalPhotoCloudError("invalid_identity");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function currentFenceError(...signals: readonly AbortSignal[]): Error | null {
  const [caller, host, lifecycle, capture] = signals;
  if (lifecycle?.aborted) return new PersonalPhotoCloudError("disposed");
  if (host?.aborted || capture?.aborted) return new PersonalPhotoCloudError("scope_changed");
  return caller?.aborted ? abortReason(caller) : null;
}

function fenceError(...signals: readonly AbortSignal[]): Error {
  return currentFenceError(...signals) ?? new PersonalPhotoCloudError("scope_changed");
}

function fenceErrorOr(error: unknown, ...signals: readonly AbortSignal[]): unknown {
  return currentFenceError(...signals) ?? error;
}

async function awaitAbortable<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
  onLateResolve: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    void Promise.resolve(promise).then(onLateResolve, () => undefined);
    throw abortReason(signal);
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(promise).then((value) => {
      if (settled) {
        try { onLateResolve(value); } catch { /* best-effort late disposal */ }
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function finalizeContent(content: PhotoContent, link: AbortLink, readAbortError: () => Error): PhotoContent {
  const source = content.body;
  const reader = source.getReader();
  const signal = link.controller.signal;
  let output: ReadableStreamDefaultController<Uint8Array> | null = null;
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", onAbort);
    link.dispose();
    try { reader.releaseLock(); } catch { /* a pending read still owns the lock */ }
  };
  const cancelSource = (reason: unknown): void => {
    void reader.cancel(reason).catch(() => undefined);
  };
  const onAbort = (): void => {
    if (finished) return;
    const error = readAbortError();
    cancelSource(error);
    finish();
    try { output?.error(error); } catch { /* the consumer already cancelled */ }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      if (finished) return;
      try {
        const result = await reader.read();
        if (finished || signal.aborted) {
          if (!finished) onAbort();
          return;
        }
        if (result.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        if (finished) return;
        finish();
        controller.error(error);
      }
    },
    cancel(reason) {
      if (finished) return;
      cancelSource(reason);
      finish();
    },
  });

  return Object.freeze({
    body,
    contentType: content.contentType,
    sha256: content.sha256,
    totalBytes: content.totalBytes,
    range: Object.freeze({ start: content.range.start, endInclusive: content.range.endInclusive }),
  });
}

function cancelContent(content: PhotoContent, reason: unknown): void {
  void content.body.cancel(reason).catch(() => undefined);
}

function cancelBoxContent<K extends PhotoOperation>(
  operation: K,
  box: RequestBox<PhotoOperationMap[K]["response"]> | null,
  reason: unknown,
): void {
  if (operation === "content.get" && box !== null && "value" in box) {
    cancelContent(box.value as PhotoContent, reason);
  }
}
