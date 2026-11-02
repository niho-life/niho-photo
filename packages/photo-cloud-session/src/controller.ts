import {
  isPhotoIdentityExpired,
  parsePhotoIdentity,
  samePhotoIdentityScope,
  type PhotoIdentity,
} from "./identity.ts";

export type PhotoSessionError =
  | "not-configured"
  | "temporarily-unavailable"
  | "unauthenticated"
  | "invalid-response"
  | "cancelled";

export class PhotoSessionHostError extends Error {
  override readonly name = "PhotoSessionHostError";
  readonly code: PhotoSessionError;

  constructor(code: PhotoSessionError) {
    super("photo session operation failed");
    this.code = code;
  }
}

export interface PhotoSessionHostBridge {
  read(signal: AbortSignal): Promise<unknown | null>;
  refresh(signal: AbortSignal): Promise<unknown>;
  logout(signal: AbortSignal): Promise<void>;
  cancel(signal: AbortSignal): Promise<void>;
}

export type PhotoSessionPhase =
  | "signed-out"
  | "verifying"
  | "ready"
  | "unavailable"
  | "logging-out"
  | "cancelling"
  | "expired"
  | "disposed";

export interface PhotoSessionSnapshot {
  readonly phase: PhotoSessionPhase;
  readonly identity: PhotoIdentity | null;
  readonly cloudOperationsAvailable: boolean;
  readonly localEditingAvailable: true;
  readonly error: PhotoSessionError | null;
}

export type PhotoSessionEvent =
  | {
      readonly type: "operations-invalidated";
      readonly reason: "identity-changed" | "revoked" | "verification-unavailable" | "logout-started" | "cancelled" | "expired" | "disposed";
      readonly generation: number;
    }
  | {
      readonly type: "scope-invalidated";
      readonly reason: "identity-changed" | "revoked" | "logout-complete" | "expired" | "disposed";
      readonly previous: PhotoIdentity;
    }
  | { readonly type: "verification-unavailable"; readonly error: PhotoSessionError };

export type CapturedOperationResult<T> =
  | { readonly status: "accepted"; readonly value: T }
  | { readonly status: "discarded"; readonly reason: "stale" | "expired" | "disposed" }
  | { readonly status: "failed"; readonly error: "operation-failed" };

export interface PhotoSessionControllerOptions {
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const EMPTY_SNAPSHOT: PhotoSessionSnapshot = Object.freeze({
  phase: "signed-out",
  identity: null,
  cloudOperationsAvailable: false,
  localEditingAvailable: true,
  error: null,
});

function immutableSnapshot(snapshot: PhotoSessionSnapshot): PhotoSessionSnapshot {
  const identity = snapshot.identity === null ? null : Object.freeze({ ...snapshot.identity });
  return Object.freeze({ ...snapshot, identity });
}

function publicError(error: unknown): PhotoSessionError {
  return error instanceof PhotoSessionHostError ? error.code : "temporarily-unavailable";
}

export class PhotoSessionController {
  readonly #host: PhotoSessionHostBridge;
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, milliseconds: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  readonly #listeners = new Set<(snapshot: PhotoSessionSnapshot) => void>();
  readonly #eventListeners = new Set<(event: PhotoSessionEvent) => void>();
  readonly #operationControllers = new Set<AbortController>();
  #snapshot: PhotoSessionSnapshot = EMPTY_SNAPSHOT;
  #requestGeneration = 0;
  #operationGeneration = 0;
  #requestController: AbortController | null = null;
  #expiryTimer: unknown | null = null;
  #expiryTimerGeneration = 0;
  #verificationBarrier: Promise<void> | null = null;
  #destructiveTail: Promise<void> = Promise.resolve();
  #destructivePending = 0;
  #logoutPromise: Promise<PhotoSessionSnapshot> | null = null;
  #disposed = false;

  constructor(host: PhotoSessionHostBridge, options: PhotoSessionControllerOptions = {}) {
    this.#host = host;
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  getSnapshot(): PhotoSessionSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: PhotoSessionSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onEvent(listener: (event: PhotoSessionEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  async read(): Promise<PhotoSessionSnapshot> {
    return this.#verify("read");
  }

  async refresh(): Promise<PhotoSessionSnapshot> {
    return this.#verify("refresh");
  }

  logout(): Promise<PhotoSessionSnapshot> {
    if (this.#logoutPromise !== null) return this.#logoutPromise;
    const pending = this.#enqueueDestructive(() => this.#performLogout());
    this.#logoutPromise = pending;
    const clear = () => {
      if (this.#logoutPromise === pending) this.#logoutPromise = null;
    };
    void pending.then(clear, clear);
    return pending;
  }

  cancel(): Promise<PhotoSessionSnapshot> {
    if (this.#logoutPromise !== null) return this.#logoutPromise;
    return this.#enqueueDestructive(() => this.#performCancel());
  }

  async #performLogout(): Promise<PhotoSessionSnapshot> {
    if (this.#disposed) return this.#snapshot;
    const previous = this.#snapshot.identity;
    const request = this.#beginRequest();
    this.#invalidateOperations("logout-started");
    this.#publish({
      phase: "logging-out",
      identity: previous,
      cloudOperationsAvailable: false,
      localEditingAvailable: true,
      error: null,
    });
    try {
      await this.#host.logout(request.signal);
      if (!this.#isCurrentRequest(request.generation)) return this.#snapshot;
      this.#clearExpiryTimer();
      if (previous !== null) this.#emit({ type: "scope-invalidated", reason: "logout-complete", previous });
      this.#publish(EMPTY_SNAPSHOT);
    } catch (error) {
      if (!this.#isCurrentRequest(request.generation)) return this.#snapshot;
      const code = publicError(error);
      this.#emit({ type: "verification-unavailable", error: code });
      this.#publishUnavailable(previous, code);
    }
    return this.#snapshot;
  }

  async #performCancel(): Promise<PhotoSessionSnapshot> {
    if (this.#disposed) return this.#snapshot;
    const previous = this.#snapshot.identity;
    const request = this.#beginRequest();
    this.#invalidateOperations("cancelled");
    this.#publish({
      phase: "cancelling",
      identity: previous,
      cloudOperationsAvailable: false,
      localEditingAvailable: true,
      error: null,
    });
    try {
      await this.#host.cancel(request.signal);
      if (!this.#isCurrentRequest(request.generation)) return this.#snapshot;
      const value = await this.#host.read(request.signal);
      if (!this.#isCurrentRequest(request.generation)) return this.#snapshot;
      if (value === null) {
        this.#revoke(previous);
        return this.#snapshot;
      }
      const identity = parsePhotoIdentity(value, { now: this.#now() });
      if (identity === null) throw new PhotoSessionHostError("invalid-response");
      if (previous !== null && !samePhotoIdentityScope(previous, identity)) {
        this.#invalidateOperations("identity-changed");
        this.#emit({ type: "scope-invalidated", reason: "identity-changed", previous });
      }
      this.#publishReady(identity);
    } catch (error) {
      if (!this.#isCurrentRequest(request.generation)) return this.#snapshot;
      const code = publicError(error);
      this.#emit({ type: "verification-unavailable", error: code });
      this.#publishUnavailable(previous, code);
    }
    return this.#snapshot;
  }

  cancelCapturedOperations(): void {
    if (!this.#disposed) this.#invalidateOperations("cancelled");
  }

  async runCaptured<T>(
    task: (capture: { readonly identity: PhotoIdentity; readonly signal: AbortSignal }) => Promise<T>,
  ): Promise<CapturedOperationResult<T>> {
    if (this.#disposed) return { status: "discarded", reason: "disposed" };
    const identity = this.#snapshot.phase === "ready" ? this.#snapshot.identity : null;
    if (identity === null || isPhotoIdentityExpired(identity, this.#now())) {
      return { status: "discarded", reason: "expired" };
    }
    const generation = this.#operationGeneration;
    const controller = new AbortController();
    this.#operationControllers.add(controller);
    try {
      const value = await task({ identity, signal: controller.signal });
      if (generation !== this.#operationGeneration) return { status: "discarded", reason: "stale" };
      await this.#waitForVerification();
      if (this.#disposed) return { status: "discarded", reason: "disposed" };
      if (generation !== this.#operationGeneration
        || this.#snapshot.identity === null
        || !samePhotoIdentityScope(identity, this.#snapshot.identity)) {
        return { status: "discarded", reason: "stale" };
      }
      if (this.#snapshot.phase !== "ready") return { status: "discarded", reason: "stale" };
      if (isPhotoIdentityExpired(this.#snapshot.identity, this.#now())) return { status: "discarded", reason: "expired" };
      return { status: "accepted", value };
    } catch {
      if (this.#disposed) return { status: "discarded", reason: "disposed" };
      if (generation !== this.#operationGeneration) return { status: "discarded", reason: "stale" };
      return { status: "failed", error: "operation-failed" };
    } finally {
      this.#operationControllers.delete(controller);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    const previous = this.#snapshot.identity;
    this.#disposed = true;
    this.#requestGeneration += 1;
    this.#requestController?.abort();
    this.#requestController = null;
    this.#clearExpiryTimer();
    this.#invalidateOperations("disposed");
    if (previous !== null) this.#emit({ type: "scope-invalidated", reason: "disposed", previous });
    this.#publish({ ...EMPTY_SNAPSHOT, phase: "disposed" });
    this.#listeners.clear();
    this.#eventListeners.clear();
  }

  async #verify(operation: "read" | "refresh"): Promise<PhotoSessionSnapshot> {
    if (this.#disposed) return this.#snapshot;
    if (this.#destructivePending > 0) return this.#snapshot;
    const previous = this.#snapshot.identity;
    const request = this.#beginRequest();
    let settleVerification: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { settleVerification = resolve; });
    // A host may ignore abort. Results waiting for verification must still be released
    // when logout, expiry, disposal, or a newer verification supersedes this request.
    const releaseOnAbort = () => settleVerification?.();
    request.signal.addEventListener("abort", releaseOnAbort, { once: true });
    this.#verificationBarrier = barrier;
    this.#publish({
      phase: "verifying",
      identity: previous,
      cloudOperationsAvailable: false,
      localEditingAvailable: true,
      error: null,
    });
    try {
      const value = operation === "read"
        ? await this.#host.read(request.signal)
        : await this.#host.refresh(request.signal);
      if (!this.#isCurrentRequest(request.generation)) return this.#snapshot;
      if (value === null) {
        this.#revoke(previous);
        return this.#snapshot;
      }
      const identity = parsePhotoIdentity(value, { now: this.#now() });
      if (identity === null) {
        this.#invalidateOperations("verification-unavailable");
        this.#emit({ type: "verification-unavailable", error: "invalid-response" });
        this.#publishUnavailable(previous, "invalid-response");
        return this.#snapshot;
      }
      if (previous !== null && !samePhotoIdentityScope(previous, identity)) {
        this.#invalidateOperations("identity-changed");
        this.#emit({ type: "scope-invalidated", reason: "identity-changed", previous });
      }
      this.#publishReady(identity);
    } catch (error) {
      if (!this.#isCurrentRequest(request.generation)) return this.#snapshot;
      const code = publicError(error);
      if (code === "unauthenticated") {
        this.#revoke(previous);
      } else {
        this.#invalidateOperations("verification-unavailable");
        this.#emit({ type: "verification-unavailable", error: code });
        this.#publishUnavailable(previous, code);
      }
    } finally {
      request.signal.removeEventListener("abort", releaseOnAbort);
      settleVerification?.();
      if (this.#verificationBarrier === barrier) this.#verificationBarrier = null;
    }
    return this.#snapshot;
  }

  #revoke(previous: PhotoIdentity | null): void {
    this.#clearExpiryTimer();
    if (previous !== null) {
      this.#invalidateOperations("revoked");
      this.#emit({ type: "scope-invalidated", reason: "revoked", previous });
    }
    this.#publish({ ...EMPTY_SNAPSHOT, error: "unauthenticated" });
  }

  #beginRequest(): { readonly generation: number; readonly signal: AbortSignal } {
    this.#requestGeneration += 1;
    this.#requestController?.abort();
    const controller = new AbortController();
    this.#requestController = controller;
    return { generation: this.#requestGeneration, signal: controller.signal };
  }

  #isCurrentRequest(generation: number): boolean {
    return !this.#disposed && generation === this.#requestGeneration;
  }

  #enqueueDestructive(operation: () => Promise<PhotoSessionSnapshot>): Promise<PhotoSessionSnapshot> {
    if (this.#disposed) return Promise.resolve(this.#snapshot);
    if (this.#destructivePending === 0) {
      this.#requestGeneration += 1;
      this.#requestController?.abort();
      this.#requestController = null;
    }
    this.#destructivePending += 1;
    const result = this.#destructiveTail.then(operation);
    this.#destructiveTail = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.#destructivePending -= 1;
    });
  }

  async #waitForVerification(): Promise<void> {
    for (;;) {
      const barrier = this.#verificationBarrier;
      if (barrier === null || this.#snapshot.phase !== "verifying") return;
      await barrier;
    }
  }

  #publishReady(identity: PhotoIdentity): void {
    this.#scheduleExpiry(identity);
    this.#publish({
      phase: "ready",
      identity,
      cloudOperationsAvailable: true,
      localEditingAvailable: true,
      error: null,
    });
  }

  #publishUnavailable(identity: PhotoIdentity | null, error: PhotoSessionError): void {
    this.#publish({
      phase: "unavailable",
      identity,
      cloudOperationsAvailable: false,
      localEditingAvailable: true,
      error,
    });
  }

  #scheduleExpiry(identity: PhotoIdentity): void {
    this.#clearExpiryTimer();
    const generation = this.#expiryTimerGeneration;
    const callback = () => {
      if (this.#disposed || generation !== this.#expiryTimerGeneration || this.#snapshot.identity === null
        || !samePhotoIdentityScope(identity, this.#snapshot.identity)) return;
      const current = this.#snapshot.identity;
      const remaining = Date.parse(current.expiresAt) - this.#now();
      if (remaining > 0) {
        this.#expiryTimer = this.#setTimer(callback, Math.min(remaining, MAX_TIMER_DELAY_MS));
        return;
      }
      this.#expiryTimer = null;
      this.#requestGeneration += 1;
      this.#requestController?.abort();
      this.#invalidateOperations("expired");
      this.#emit({ type: "scope-invalidated", reason: "expired", previous: current });
      this.#publish({
        phase: "expired",
        identity: null,
        cloudOperationsAvailable: false,
        localEditingAvailable: true,
        error: "unauthenticated",
      });
    };
    const delay = Math.max(0, Date.parse(identity.expiresAt) - this.#now());
    this.#expiryTimer = this.#setTimer(callback, Math.min(delay, MAX_TIMER_DELAY_MS));
  }

  #clearExpiryTimer(): void {
    this.#expiryTimerGeneration += 1;
    if (this.#expiryTimer !== null) this.#clearTimer(this.#expiryTimer);
    this.#expiryTimer = null;
  }

  #invalidateOperations(reason: Extract<PhotoSessionEvent, { type: "operations-invalidated" }>["reason"]): void {
    this.#operationGeneration += 1;
    for (const controller of this.#operationControllers) controller.abort();
    this.#operationControllers.clear();
    this.#emit({ type: "operations-invalidated", reason, generation: this.#operationGeneration });
  }

  #publish(snapshot: PhotoSessionSnapshot): void {
    const immutable = immutableSnapshot(snapshot);
    this.#snapshot = immutable;
    for (const listener of this.#listeners) listener(immutable);
  }

  #emit(event: PhotoSessionEvent): void {
    const immutable = Object.freeze({ ...event }) as PhotoSessionEvent;
    for (const listener of this.#eventListeners) listener(immutable);
  }
}
