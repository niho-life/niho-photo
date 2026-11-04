import { sha256 } from "@noble/hashes/sha2.js";
import { samePhotoIdentityScope } from "@niho/photo-cloud-session";
import { PHOTO_LIMITS, type PersonalPhotoCloudClient, type VerifiedPhotoActor } from "@niho/photo-personal-cloud-contract";

import { PersonalPhotoCloudError, publicError } from "../errors";
import { abortReason as sharedAbortReason, linkedAbortController } from "../await";
import { TRUSTED_GCS_UPLOAD_ORIGIN } from "../wire";
import { runPersonalPhotoResumableUpload } from "./resumable-upload";
import type { PersonalPhotoCloudIdentity, PersonalPhotoCloudMaskUploader } from "../types";

const VERIFY_DELAY_MS = 150;
const VERIFY_ATTEMPTS = 24;

export type CreateBrowserPersonalPhotoCloudMaskUploaderOptions = {
  readonly client: PersonalPhotoCloudClient;
  readonly identity: PersonalPhotoCloudIdentity;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly trustedUploadOrigin?: string;
};

export type BrowserPersonalPhotoCloudMaskUploader = PersonalPhotoCloudMaskUploader & { dispose(): void };

/** Browser-only binary transport for the shared adapter. Tickets never leave this host port. */
export function createBrowserPersonalPhotoCloudMaskUploader(
  options: CreateBrowserPersonalPhotoCloudMaskUploaderOptions,
): BrowserPersonalPhotoCloudMaskUploader {
  const captured = currentActor(options.identity);
  if (captured.userId !== options.client.scope.actorId || captured.sessionEpoch !== options.client.scope.sessionEpoch) {
    throw new PersonalPhotoCloudError("scope_changed");
  }
  const fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
  const now = options.now ?? Date.now;
  const trustedOrigin = options.trustedUploadOrigin ?? TRUSTED_GCS_UPLOAD_ORIGIN;
  const lifecycle = new AbortController();
  const unsubscribe = options.identity.subscribe(() => {
    const next = options.identity.getSnapshot();
    if (next === null || !samePhotoIdentityScope(captured, next)) lifecycle.abort(new PersonalPhotoCloudError("scope_changed"));
  });
  let disposed = false;

  return {
    async upload(input) {
      if (disposed) throw new PersonalPhotoCloudError("disposed");
      assertInput(input);
      assertCurrent(options, captured);
      const link = linkedAbortController(lifecycle.signal, input.signal);
      try {
        await uploadMask(options, fetchFn, now, trustedOrigin, captured, input, link.controller.signal);
        assertCurrent(options, captured);
      } finally {
        link.dispose();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      lifecycle.abort(new PersonalPhotoCloudError("disposed"));
    },
  };
}

async function uploadMask(
  options: CreateBrowserPersonalPhotoCloudMaskUploaderOptions,
  fetchFn: typeof fetch,
  now: () => number,
  trustedOrigin: string,
  captured: VerifiedPhotoActor,
  input: Parameters<PersonalPhotoCloudMaskUploader["upload"]>[0],
  signal: AbortSignal,
): Promise<void> {
  let state = input.uploadState;
  const source = new Blob([input.bytes.slice()]);
  for (let attempt = 0; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    const result = await runPersonalPhotoResumableUpload({
      client: options.client,
      state,
      source,
      store: {
        async compareAndSet(expected, next, storeSignal) {
          if (!await input.compareAndSetUploadState(expected, next, storeSignal)) {
            throw new PersonalPhotoCloudError("unavailable");
          }
        },
      },
      signal,
      fetch: fetchFn,
      now,
      trustedUploadOrigin: trustedOrigin,
      assertCurrent: () => assertCurrent(options, captured),
    });
    if (result.error !== null) throw publicError(result.error);
    if (result.stored !== null || result.existingPhoto !== null) return;
    state = result.state;
    if (state.phase === "rejected") throw new PersonalPhotoCloudError("unsupported");
    if (state.phase !== "verifying") throw new PersonalPhotoCloudError("unavailable");
    if (attempt === VERIFY_ATTEMPTS) break;
    await delay(VERIFY_DELAY_MS, signal);
  }
  throw new PersonalPhotoCloudError("unavailable");
}

function assertInput(input: Parameters<PersonalPhotoCloudMaskUploader["upload"]>[0]): void {
  if (!input.photoId.trim() || !/^[0-9a-f]{64}$/u.test(input.surfaceId) || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 ||
    input.bytes.byteLength > PHOTO_LIMITS.maxMaskBytes || !/^[\x21-\x7e]{1,128}$/u.test(input.idempotencyKey) ||
    hash(input.bytes) !== input.surfaceId || typeof input.compareAndSetUploadState !== "function" ||
    input.uploadState === null || input.uploadState.target?.kind !== "mask" || input.uploadState.target.photoId !== input.photoId ||
    input.uploadState.sizeBytes !== input.bytes.byteLength || input.uploadState.sha256 !== input.surfaceId ||
    input.uploadState.contentType !== "image/png" || input.uploadState.startKey !== input.idempotencyKey) {
    throw new PersonalPhotoCloudError("invalid_response");
  }
}

function assertCurrent(options: CreateBrowserPersonalPhotoCloudMaskUploaderOptions, captured: VerifiedPhotoActor): void {
  const next = options.identity.getSnapshot();
  if (next === null || !samePhotoIdentityScope(captured, next) || options.client.scope.actorId !== captured.userId ||
    options.client.scope.sessionEpoch !== captured.sessionEpoch) throw new PersonalPhotoCloudError("scope_changed");
}

function currentActor(identity: PersonalPhotoCloudIdentity): VerifiedPhotoActor {
  const actor = identity.getSnapshot();
  if (actor === null) throw new PersonalPhotoCloudError("invalid_identity");
  return actor;
}

function hash(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      globalThis.clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return sharedAbortReason(signal);
}
