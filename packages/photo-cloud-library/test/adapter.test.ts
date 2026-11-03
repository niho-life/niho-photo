import { describe, expect, it, vi } from "vitest";
import {
  HASH,
  IDS,
  futureRecipePhoto,
  library,
  page,
  readyPhoto,
  responses,
} from "@niho/photo-personal-cloud-contract/fixtures";
import type { PhotoOperationMap } from "@niho/photo-personal-cloud-contract";

import { PersonalPhotoCloudError } from "../src/index";
import { FakeClient, FakeIdentity, defaultActor, makeHandle } from "./support";

describe("personal photo cloud adapter", () => {
  it("validates identity, preserves same-parent refresh caches, and invalidates late responses", async () => {
    const mismatched = new FakeIdentity(defaultActor({ userId: IDS.userB }));
    expect(() => makeHandle(new FakeClient(), mismatched)).toThrowError(new PersonalPhotoCloudError("invalid_identity"));

    const wrongOwnerClient = new FakeClient();
    wrongOwnerClient.dispatch = async (operation) => {
      if (operation === "library.get") return { ...library, owner: { type: "user", userId: IDS.userB } };
      return defaultFor(operation);
    };
    await expect(makeHandle(wrongOwnerClient).library.capabilities()).rejects.toEqual(
      new PersonalPhotoCloudError("invalid_response"),
    );

    const client = new FakeClient();
    const identity = new FakeIdentity();
    const handle = makeHandle(client, identity);
    await expect(handle.rawPhoto(IDS.photo)).resolves.toEqual(readyPhoto);
    identity.set(defaultActor({ expiresAt: "2031-01-01T00:00:00.000Z" }));
    await expect(handle.rawPhoto(IDS.photo)).resolves.toEqual(readyPhoto);
    expect(client.calls.filter((call) => call.operation === "photos.get")).toHaveLength(2);

    const lateClient = new FakeClient();
    const lateIdentity = new FakeIdentity();
    let resolvePhoto: (photo: typeof readyPhoto) => void = () => {
      throw new Error("synthetic resolver was not installed");
    };
    lateClient.dispatch = async (operation) => {
      if (operation !== "photos.get") return defaultFor(operation);
      return new Promise<typeof readyPhoto>((resolve) => {
        resolvePhoto = resolve;
      });
    };
    const late = makeHandle(lateClient, lateIdentity);
    const pending = late.rawPhoto(IDS.photo);
    lateIdentity.set(defaultActor({ sessionEpoch: "epoch-2" }));
    resolvePhoto(readyPhoto);
    await expect(pending).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
    late.dispose();
    late.dispose();
    expect(lateClient.disposeCount).toBe(1);
  });

  it("intersects renderer capabilities, retains unknown recipe JSON, and revokes genuine preview URLs", async () => {
    const client = new FakeClient();
    const create = vi.fn(() => "blob:genuine-preview");
    const revoke = vi.fn();
    const handle = makeHandle(client, new FakeIdentity(), {
      urls: { createObjectURL: create, revokeObjectURL: revoke },
    });
    await expect(handle.library.capabilities()).resolves.toMatchObject({ rawWorkingCopy: true, info: true, versions: false, addFiles: false });
    const listed = await handle.library.list({ limit: 1 });
    expect(listed.items[0]).toMatchObject({
      previewUrl: null,
      hasPreview: true,
      editedPreview: { url: null, thumbUrl: "blob:genuine-preview" },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(listed.usage).toEqual({
      usedBytes: page.usage.usedBytes + page.usage.reservedBytes,
      quotaBytes: 5 * 1024 ** 3,
    });
    handle.dispose();
    expect(revoke).toHaveBeenCalledWith("blob:genuine-preview");

    const futureClient = new FakeClient();
    futureClient.dispatch = async (operation) => {
      if (operation === "photos.get") return futureRecipePhoto;
      return defaultFor(operation);
    };
    const future = makeHandle(futureClient);
    const raw = await future.rawPhoto(IDS.photo);
    expect(raw?.recipe.settings).toEqual(futureRecipePhoto.recipe.settings);
    await expect(future.library.openOriginal(IDS.photo)).rejects.toEqual(new PersonalPhotoCloudError("unsupported"));

    const downloaded = await future.library.downloadOriginal({
      id: IDS.photo,
      fileName: futureRecipePhoto.fileName,
      sizeBytes: futureRecipePhoto.original.sizeBytes,
      hasOriginal: true,
    });
    expect(downloaded.blob.size).toBe(futureRecipePhoto.original.sizeBytes);
    expect(downloaded.fileName).toBe(futureRecipePhoto.fileName);
    future.dispose();
  });
});

function defaultFor(operation: keyof PhotoOperationMap): unknown {
  if (operation === "library.get") return library;
  if (operation === "photos.list") return page;
  if (operation === "photos.get") return readyPhoto;
  if (operation === "photos.info") return responses["photos.info"];
  if (operation === "photos.lookup") return responses["photos.lookup"];
  if (operation === "photos.delete") return responses["photos.delete"];
  if (operation === "media.ensure") return responses["media.ensure"];
  if (operation === "content.get") {
    return {
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(readyPhoto.original.sizeBytes)); controller.close(); } }),
      contentType: readyPhoto.original.contentType,
      sha256: HASH.original,
      totalBytes: readyPhoto.original.sizeBytes,
      range: { start: 0, endInclusive: readyPhoto.original.sizeBytes - 1 },
    } satisfies PhotoOperationMap["content.get"]["response"];
  }
  throw new Error(`unexpected synthetic operation: ${operation}`);
}
