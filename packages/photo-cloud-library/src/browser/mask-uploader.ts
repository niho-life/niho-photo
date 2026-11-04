import { sha256 } from "@noble/hashes/sha2.js";
import { samePhotoIdentityScope } from "@niho/photo-cloud-session";
import {
  PHOTO_LIMITS,
  type PersonalPhotoCloudClient,
  type PhotoAsset,
  type Upload,
  type VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";

import { PersonalPhotoCloudError } from "../errors";
import { abortReason as sharedAbortReason, linkedAbortController } from "../await";
import { GCS_CHUNK_BYTES, TRUSTED_GCS_UPLOAD_ORIGIN, validateTicket } from "../wire";
import { validateAsset, validateUpload } from "../validation";
import type { PersonalPhotoCloudIdentity, PersonalPhotoCloudMaskUploader } from "../types";

const MAX_UPLOAD_STEPS = 64;
const MAX_NO_PROGRESS = 3;
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
        await uploadMask(options.client, fetchFn, now, trustedOrigin, input, link.controller.signal);
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
  client: PersonalPhotoCloudClient,
  fetchFn: typeof fetch,
  now: () => number,
  trustedOrigin: string,
  input: Parameters<PersonalPhotoCloudMaskUploader["upload"]>[0],
  signal: AbortSignal,
): Promise<void> {
  const started = await client.request("uploads.start", {
    target: { kind: "mask", photoId: input.photoId },
    sizeBytes: input.bytes.byteLength,
    sha256: input.surfaceId,
    contentType: "image/png",
  }, { signal, idempotencyKey: input.idempotencyKey });
  if (started.value.kind === "existing") {
    // The adapter will read masks.get + content.get and SDK-validate exact bytes before reporting success.
    if (started.value.photo.id !== input.photoId) throw new PersonalPhotoCloudError("invalid_response");
    return;
  }
  let upload = validateMaskUpload(started.value.upload, client.scope.libraryId, input);
  let ticket = started.value.ticket === null
    ? null
    : validateTicket(started.value.ticket, {
        trustedOrigin,
        expectedContentType: "image/png",
        expectedSize: upload.sizeBytes,
        now: now(),
      });
  if (ticket !== null && (upload.state !== "reserved" || ticket.resumeOffsetBytes !== upload.uploadedBytes)) {
    throw new PersonalPhotoCloudError("invalid_response");
  }
  let noProgress = 0;

  for (let step = 0; step < MAX_UPLOAD_STEPS; step += 1) {
    if (upload.state === "stored") {
      assertStoredMask(upload, input);
      return;
    }
    if (upload.state === "verifying") {
      if (step >= VERIFY_ATTEMPTS) throw new PersonalPhotoCloudError("unavailable");
      await delay(VERIFY_DELAY_MS, signal);
      upload = await readUpload(client, upload.id, input, signal);
      continue;
    }
    if (upload.state === "cancelled" || upload.state === "expired") throw new PersonalPhotoCloudError("unavailable");
    if (upload.state === "rejected") throw new PersonalPhotoCloudError("unsupported");
    if (upload.state !== "reserved") throw new PersonalPhotoCloudError("invalid_response");

    if (upload.uploadedBytes === upload.sizeBytes) {
      const complete = await client.request("uploads.complete", { uploadId: upload.id }, {
        signal,
        idempotencyKey: `${input.idempotencyKey}-complete`,
      });
      upload = validateMaskUpload(complete.value, client.scope.libraryId, input);
      ticket = null;
      continue;
    }

    if (ticket === null || ticket.resumeOffsetBytes !== upload.uploadedBytes || Date.parse(ticket.expiresAt) <= now()) {
      upload = await readUpload(client, upload.id, input, signal);
      if (upload.state !== "reserved" || upload.uploadedBytes === upload.sizeBytes) {
        ticket = null;
        continue;
      }
      const renewed = await client.request("uploads.renew", { uploadId: upload.id }, { signal });
      upload = validateMaskUpload(renewed.upload, client.scope.libraryId, input);
      if (upload.state !== "reserved" || renewed.ticket.resumeOffsetBytes !== upload.uploadedBytes) {
        throw new PersonalPhotoCloudError("invalid_response");
      }
      ticket = validateTicket(renewed.ticket, {
        trustedOrigin,
        expectedContentType: "image/png",
        expectedSize: upload.sizeBytes,
        now: now(),
      });
    }

    const offset = upload.uploadedBytes;
    const end = Math.min(offset + GCS_CHUNK_BYTES, upload.sizeBytes);
    try {
      const response = await fetchFn(ticket.url, {
        method: "PUT",
        headers: {
          ...ticket.headers,
          "Content-Range": `bytes ${offset}-${end - 1}/${upload.sizeBytes}`,
        },
        body: input.bytes.slice(offset, end),
        signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        redirect: "manual",
      });
      void response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      upload = await readUpload(client, upload.id, input, signal);
      ticket = null;
      if (upload.state === "reserved" && upload.uploadedBytes === offset) {
        noProgress += 1;
        if (noProgress >= MAX_NO_PROGRESS) throw new PersonalPhotoCloudError("unavailable");
      } else noProgress = 0;
      continue;
    }

    upload = await readUpload(client, upload.id, input, signal);
    ticket = null;
    if (upload.state === "reserved" && upload.uploadedBytes === offset) {
      noProgress += 1;
      if (noProgress >= MAX_NO_PROGRESS) throw new PersonalPhotoCloudError("unavailable");
    } else noProgress = 0;
  }
  throw new PersonalPhotoCloudError("unavailable");
}

async function readUpload(
  client: PersonalPhotoCloudClient,
  uploadId: string,
  input: Parameters<PersonalPhotoCloudMaskUploader["upload"]>[0],
  signal: AbortSignal,
): Promise<Upload> {
  return validateMaskUpload(
    await client.request("uploads.get", { uploadId }, { signal }),
    client.scope.libraryId,
    input,
  );
}

function validateMaskUpload(
  value: Upload,
  libraryId: string,
  input: Parameters<PersonalPhotoCloudMaskUploader["upload"]>[0],
): Upload {
  const upload = validateUpload(value, libraryId);
  if (upload.target.kind !== "mask" || upload.target.photoId !== input.photoId ||
    upload.sizeBytes !== input.bytes.byteLength || upload.sha256 !== input.surfaceId) {
    throw new PersonalPhotoCloudError("invalid_response");
  }
  return upload;
}

function assertStoredMask(upload: Extract<Upload, { state: "stored" }>, input: Parameters<PersonalPhotoCloudMaskUploader["upload"]>[0]): PhotoAsset {
  if (upload.result.kind !== "mask" || upload.result.photoId !== input.photoId) throw new PersonalPhotoCloudError("invalid_response");
  const asset = validateAsset(upload.result.asset, "mask");
  if (asset.sha256 !== input.surfaceId || asset.sizeBytes !== input.bytes.byteLength || asset.contentType !== "image/png") {
    throw new PersonalPhotoCloudError("invalid_response");
  }
  return asset;
}

function assertInput(input: Parameters<PersonalPhotoCloudMaskUploader["upload"]>[0]): void {
  if (!input.photoId.trim() || !/^[0-9a-f]{64}$/u.test(input.surfaceId) || input.bytes.byteLength === 0 ||
    input.bytes.byteLength > PHOTO_LIMITS.maxMaskBytes || !/^[\x21-\x7e]{1,128}$/u.test(input.idempotencyKey) ||
    hash(input.bytes) !== input.surfaceId) throw new PersonalPhotoCloudError("invalid_response");
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
