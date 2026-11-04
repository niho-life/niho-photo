import { describe, expect, it, vi } from "vitest";
import { IDS } from "@niho/photo-personal-cloud-contract/fixtures";
import { sha256 } from "@noble/hashes/sha2.js";
import type { PersonalPhotoCloudClient, VerifiedPhotoActor } from "@niho/photo-personal-cloud-contract";
import type { PersonalPhotoCloudIdentity } from "@niho/photo-cloud-library";
import type { PersonalPhotoResumableUploadState } from "@niho/photo-cloud-library/browser";

import { createNativePersonalPhotoCloudMaskUploader } from "./native-photo-mask-uploader";
import type { NativePhotoBinaryInvoke } from "./native-photo-mask-uploader";

const actor: VerifiedPhotoActor = {
  userId: IDS.userA,
  sessionId: "synthetic-session",
  sessionEpoch: "synthetic-epoch",
  transport: "mac-bearer",
  expiresAt: "2026-11-05T00:00:00.000Z",
};

function identity() {
  let current: VerifiedPhotoActor | null = actor;
  const listeners = new Set<() => void>();
  return {
    port: {
      getSnapshot: () => current,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies PersonalPhotoCloudIdentity,
    set(next: VerifiedPhotoActor | null) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

function client(): PersonalPhotoCloudClient {
  return {
    scope: { actorId: actor.userId, libraryId: IDS.library, sessionEpoch: actor.sessionEpoch },
  } as PersonalPhotoCloudClient;
}

const bytes = new Uint8Array([1, 2, 3]);
const surfaceId = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const input = (signal = new AbortController().signal) => ({
  photoId: IDS.photo,
  surfaceId,
  bytes,
  idempotencyKey: "mask-synthetic-key",
  uploadState: {
    target: { kind: "mask", photoId: IDS.photo },
    sizeBytes: bytes.byteLength,
    sha256: surfaceId,
    contentType: "image/png",
    startKey: "mask-synthetic-key",
    completeKey: "mask-synthetic-key-complete",
    cancelKey: "mask-synthetic-key-cancel",
    uploadId: null,
    deadline: null,
    offsetBytes: 0,
    phase: "start-pending",
  } satisfies PersonalPhotoResumableUploadState,
  async compareAndSetUploadState(_expected: PersonalPhotoResumableUploadState, _next: PersonalPhotoResumableUploadState) {
    return true;
  },
  signal,
});

describe("native cloud mask uploader", () => {
  it("passes only the captured Mac scope, photo, content address and bytes to the native port", async () => {
    const source = identity();
    const invokeBinary = vi.fn<NativePhotoBinaryInvoke>(async () => undefined);
    const uploader = createNativePersonalPhotoCloudMaskUploader({ client: client(), identity: source.port, invokeBinary });
    const uploadInput = input(new AbortController().signal);
    const compareAndSet = vi.spyOn(uploadInput, "compareAndSetUploadState");

    await expect(uploader.upload(uploadInput)).resolves.toBeUndefined();
    expect(compareAndSet).toHaveBeenCalledTimes(2);
    expect(invokeBinary).toHaveBeenCalledWith("camera_photo_mask_upload", bytes, {
      "x-niho-photo-mask-upload-input": JSON.stringify({
        scope: {
          userId: IDS.userA,
          libraryId: IDS.library,
          sessionId: actor.sessionId,
          sessionEpoch: actor.sessionEpoch,
          transport: "mac-bearer",
        },
        photoId: IDS.photo,
        surfaceId,
        idempotencyKey: "mask-synthetic-key",
      }),
    });
    uploader.dispose();
  });

  it("aborts an in-flight native upload as soon as the identity scope changes", async () => {
    const source = identity();
    let finish!: (value: unknown) => void;
    const invokeBinary = vi.fn<NativePhotoBinaryInvoke>(() => new Promise((resolve) => { finish = resolve; }));
    const uploader = createNativePersonalPhotoCloudMaskUploader({ client: client(), identity: source.port, invokeBinary });
    const pending = uploader.upload(input());
    source.set({ ...actor, userId: IDS.userB, sessionId: "other-session", sessionEpoch: "other-epoch" });

    await expect(pending).rejects.toMatchObject({ code: "scope_changed" });
    expect(invokeBinary).toHaveBeenCalledTimes(1);
    finish(undefined);
    uploader.dispose();
  });
});
