import { samePhotoIdentityScope } from "@niho/photo-cloud-session";
import { PHOTO_LIMITS, type PersonalPhotoCloudClient, type VerifiedPhotoActor } from "@niho/photo-personal-cloud-contract";
import type { PersonalPhotoCloudMaskUploader, PersonalPhotoCloudIdentity } from "@niho/photo-cloud-library";
import type { PersonalPhotoResumableUploadState } from "@niho/photo-cloud-library/browser";
import { PersonalPhotoCloudError, awaitBounded, hashMaskSurface, linkedAbortController } from "@niho/photo-cloud-library/protocol";

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const SHA256 = /^[0-9a-f]{64}$/u;
const MASK_UPLOAD_HEADER = "x-niho-photo-mask-upload-input";

export type NativePhotoBinaryInvoke = (
  command: string,
  bytes: Uint8Array,
  headers: Readonly<Record<string, string>>,
) => Promise<unknown>;

export type NativePersonalPhotoCloudMaskUploader = PersonalPhotoCloudMaskUploader & { dispose(): void };

/** Native upload port. PNG bytes cross IPC; bearer tickets, URLs and provider requests remain in Rust. */
export function createNativePersonalPhotoCloudMaskUploader(options: {
  readonly client: PersonalPhotoCloudClient;
  readonly identity: PersonalPhotoCloudIdentity;
  readonly invokeBinary: NativePhotoBinaryInvoke;
}): NativePersonalPhotoCloudMaskUploader {
  const captured = currentActor(options.identity);
  assertClientScope(options.client, captured);
  const lifecycle = new AbortController();
  const unsubscribe = options.identity.subscribe(() => {
    const next = options.identity.getSnapshot();
    if (next === null || !samePhotoIdentityScope(captured, next)) lifecycle.abort(new PersonalPhotoCloudError("scope_changed"));
  });
  let disposed = false;

  return {
    async upload(input) {
      if (disposed) throw new PersonalPhotoCloudError("disposed");
      if (!input.photoId.trim() || input.photoId.length > 512 || !SHA256.test(input.surfaceId) ||
        !(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 ||
        input.bytes.byteLength > PHOTO_LIMITS.maxMaskBytes || !/^[\x21-\x7e]{1,128}$/u.test(input.idempotencyKey) ||
        hashMaskSurface(input.bytes) !== input.surfaceId || input.uploadState === null || input.uploadState.target?.kind !== "mask" || input.uploadState.target.photoId !== input.photoId ||
        input.uploadState.sizeBytes !== input.bytes.byteLength || input.uploadState.sha256 !== input.surfaceId ||
        input.uploadState.contentType !== "image/png" || input.uploadState.startKey !== input.idempotencyKey ||
        ![input.uploadState.completeKey, input.uploadState.cancelKey].every((key) => typeof key === "string" && /^[\x21-\x7e]{1,128}$/u.test(key)) ||
        !["start-pending", "uploading", "complete-pending", "verifying", "cancel-pending"].includes(input.uploadState.phase)) {
        throw new PersonalPhotoCloudError("invalid_response");
      }
      const link = linkedAbortController(lifecycle.signal, input.signal);
      try {
        assertCurrent(options.identity, options.client, captured);
        const initialState = input.uploadState;
        if (!await input.compareAndSetUploadState(initialState, initialState, link.controller.signal)) {
          throw new PersonalPhotoCloudError("unavailable");
        }
        assertCurrent(options.identity, options.client, captured);
        if (link.controller.signal.aborted) throw link.controller.signal.reason;
        const outcome = await awaitBounded(options.invokeBinary(
          "camera_photo_mask_upload",
          input.bytes,
          {
            [MASK_UPLOAD_HEADER]: JSON.stringify({
              scope: {
                userId: captured.userId,
                libraryId: options.client.scope.libraryId,
                sessionId: captured.sessionId,
                sessionEpoch: captured.sessionEpoch,
                transport: captured.transport,
              },
              photoId: input.photoId,
              surfaceId: input.surfaceId,
              idempotencyKey: input.idempotencyKey,
              completeKey: initialState.completeKey,
              cancelKey: initialState.cancelKey,
              phase: initialState.phase,
            }),
          },
        ), { signal: link.controller.signal, timeoutMs: UPLOAD_TIMEOUT_MS });
        assertCurrent(options.identity, options.client, captured);
        if (outcome === "expired" || outcome === "cancelled") {
          const terminalState: PersonalPhotoResumableUploadState = { ...initialState, phase: outcome };
          if (!await input.compareAndSetUploadState(initialState, terminalState, link.controller.signal)) {
            throw new PersonalPhotoCloudError("unavailable");
          }
          throw new PersonalPhotoCloudError("unavailable");
        }
        if (outcome !== "stored") throw new PersonalPhotoCloudError("invalid_response");
        const verifyingState = { ...initialState, phase: "verifying" as const, offsetBytes: initialState.sizeBytes };
        if (!await input.compareAndSetUploadState(initialState, verifyingState, link.controller.signal)) {
          throw new PersonalPhotoCloudError("unavailable");
        }
      } finally { link.dispose(); }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      lifecycle.abort(new PersonalPhotoCloudError("disposed"));
    },
  };
}

function currentActor(identity: PersonalPhotoCloudIdentity): VerifiedPhotoActor {
  const actor = identity.getSnapshot();
  if (actor === null || actor.transport !== "mac-bearer" || !unexpired(actor)) throw new PersonalPhotoCloudError("invalid_identity");
  return actor;
}

function assertClientScope(client: PersonalPhotoCloudClient, actor: VerifiedPhotoActor): void {
  if (client.scope.actorId !== actor.userId || client.scope.sessionEpoch !== actor.sessionEpoch || client.scope.libraryId.length === 0) {
    throw new PersonalPhotoCloudError("invalid_identity");
  }
}

function assertCurrent(identity: PersonalPhotoCloudIdentity, client: PersonalPhotoCloudClient, captured: VerifiedPhotoActor): void {
  const current = identity.getSnapshot();
  if (current === null || !samePhotoIdentityScope(captured, current) || current.transport !== "mac-bearer" || !unexpired(current) ||
    client.scope.actorId !== captured.userId || client.scope.sessionEpoch !== captured.sessionEpoch) {
    throw new PersonalPhotoCloudError("scope_changed");
  }
}

function unexpired(actor: VerifiedPhotoActor): boolean {
  const expiresAt = Date.parse(actor.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

