import { describe, expect, it, vi } from "vitest";
import { IDS, HASH } from "@niho/photo-personal-cloud-contract/fixtures";
import type { PersonalPhotoCloudClient, VerifiedPhotoActor } from "@niho/photo-personal-cloud-contract";
import type { PersonalPhotoCloudIdentity } from "@niho/photo-cloud-library";

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

const input = (signal = new AbortController().signal) => ({
  photoId: IDS.photo,
  surfaceId: HASH.mask,
  bytes: new Uint8Array([1, 2, 3]),
  idempotencyKey: "mask-synthetic-key",
  signal,
});

describe("native cloud mask uploader", () => {
  it("passes only the captured Mac scope, photo, content address and bytes to the native port", async () => {
    const source = identity();
    const bytes = new Uint8Array([1, 2, 3]);
    const invokeBinary = vi.fn<NativePhotoBinaryInvoke>(async () => undefined);
    const uploader = createNativePersonalPhotoCloudMaskUploader({ client: client(), identity: source.port, invokeBinary });

    await expect(uploader.upload(input(new AbortController().signal))).resolves.toBeUndefined();
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
        surfaceId: HASH.mask,
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
