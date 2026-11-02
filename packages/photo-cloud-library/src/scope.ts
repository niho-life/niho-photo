import type { PersonalPhotoCloudClient, VerifiedPhotoActor } from "@niho/photo-personal-cloud-contract";

import { PersonalPhotoCloudError } from "./errors";
import type { PersonalPhotoCloudIdentity } from "./types";

type CapturedScope = {
  actorId: string;
  libraryId: string;
  sessionEpoch: string;
  sessionId: string;
  transport: VerifiedPhotoActor["transport"];
  expiresAtMs: number;
};

export type ScopedRequest = {
  signal: AbortSignal;
  assertCurrent(): void;
  release(): void;
};

export class PersonalPhotoScope {
  readonly captured: Readonly<CapturedScope>;

  private actor: VerifiedPhotoActor;
  private readonly controllers = new Set<AbortController>();
  private readonly invalidationListeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private failure: PersonalPhotoCloudError | null = null;
  private disposed = false;

  constructor(
    private readonly client: PersonalPhotoCloudClient,
    private readonly identity: PersonalPhotoCloudIdentity,
    private readonly now: () => number,
  ) {
    const actor = identity.getSnapshot();
    if (!actor) throw new PersonalPhotoCloudError("invalid_identity");
    const expiresAtMs = readExpiry(actor.expiresAt);
    assertActor(actor, expiresAtMs, now());
    if (
      !nonEmpty(client.scope.actorId) ||
      !nonEmpty(client.scope.libraryId) ||
      !nonEmpty(client.scope.sessionEpoch) ||
      client.scope.actorId !== actor.userId ||
      client.scope.sessionEpoch !== actor.sessionEpoch
    ) {
      throw new PersonalPhotoCloudError("invalid_identity");
    }
    this.actor = actor;
    this.captured = {
      actorId: actor.userId,
      libraryId: client.scope.libraryId,
      sessionEpoch: actor.sessionEpoch,
      sessionId: actor.sessionId,
      transport: actor.transport,
      expiresAtMs,
    };
    this.unsubscribe = identity.subscribe(() => this.handleIdentityChange());
    this.armExpiry(expiresAtMs);
  }

  begin(externalSignal?: AbortSignal): ScopedRequest {
    this.assertCurrent();
    const controller = new AbortController();
    const abortFromExternal = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    this.controllers.add(controller);
    let released = false;
    return {
      signal: controller.signal,
      assertCurrent: () => this.assertCurrent(externalSignal),
      release: () => {
        if (released) return;
        released = true;
        this.controllers.delete(controller);
        externalSignal?.removeEventListener("abort", abortFromExternal);
      },
    };
  }

  assertCurrent(externalSignal?: AbortSignal): void {
    if (externalSignal?.aborted) throw abortReason(externalSignal);
    if (!this.failure && this.now() >= readExpiry(this.actor.expiresAt)) {
      this.invalidate(new PersonalPhotoCloudError("scope_changed"));
    }
    if (this.failure) throw this.failure;
    const actor = this.identity.getSnapshot();
    if (!actor || !this.isSameLogicalScope(actor) || this.client.scope.libraryId !== this.captured.libraryId) {
      this.invalidate(new PersonalPhotoCloudError("scope_changed"));
      throw this.failure;
    }
  }

  onInvalidated(listener: () => void): () => void {
    if (this.failure) {
      listener();
      return () => undefined;
    }
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  invalidateAuthentication(): void {
    this.invalidate(new PersonalPhotoCloudError("scope_changed"));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.invalidate(new PersonalPhotoCloudError("disposed"));
  }

  private handleIdentityChange(): void {
    if (this.failure) return;
    const next = this.identity.getSnapshot();
    if (!next || !this.isSameLogicalScope(next)) {
      this.invalidate(new PersonalPhotoCloudError("scope_changed"));
      return;
    }
    const expiresAtMs = readExpiry(next.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      this.invalidate(new PersonalPhotoCloudError("scope_changed"));
      return;
    }
    this.actor = next;
    this.armExpiry(expiresAtMs);
  }

  private isSameLogicalScope(actor: VerifiedPhotoActor): boolean {
    return (
      actor.userId === this.captured.actorId &&
      actor.sessionEpoch === this.captured.sessionEpoch &&
      actor.sessionId === this.captured.sessionId &&
      actor.transport === this.captured.transport &&
      this.client.scope.actorId === this.captured.actorId &&
      this.client.scope.sessionEpoch === this.captured.sessionEpoch &&
      this.client.scope.libraryId === this.captured.libraryId
    );
  }

  private armExpiry(expiresAtMs: number): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const delay = Math.max(0, Math.min(2_147_483_647, expiresAtMs - this.now()));
    this.expiryTimer = setTimeout(() => {
      if (this.failure) return;
      if (this.now() >= readExpiry(this.actor.expiresAt)) this.invalidate(new PersonalPhotoCloudError("scope_changed"));
      else this.armExpiry(readExpiry(this.actor.expiresAt));
    }, delay);
  }

  private invalidate(error: PersonalPhotoCloudError): void {
    if (this.failure) return;
    this.failure = error;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    for (const controller of this.controllers) controller.abort(error);
    this.controllers.clear();
    for (const listener of this.invalidationListeners) listener();
    this.invalidationListeners.clear();
  }
}

function assertActor(actor: VerifiedPhotoActor, expiresAtMs: number, now: number): void {
  if (
    typeof actor !== "object" ||
    actor === null ||
    !nonEmpty(actor.userId) ||
    !nonEmpty(actor.sessionId) ||
    !nonEmpty(actor.sessionEpoch) ||
    (actor.transport !== "browser-session" && actor.transport !== "mac-bearer") ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= now
  ) {
    throw new PersonalPhotoCloudError("invalid_identity");
  }
}

function readExpiry(value: string): number {
  return Date.parse(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function abortReason(signal: AbortSignal): DOMException | Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
