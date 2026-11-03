import { describe, expect, it } from "vitest";
import { PHOTO_LIMITS, type PhotoContent, type PhotoOperationMap } from "@niho/photo-personal-cloud-contract";
import {
  HASH,
  IDS,
  library,
  original,
  pendingMediaPhoto,
  readyPhoto,
  recipe,
  responses,
} from "@niho/photo-personal-cloud-contract/fixtures";

import { PersonalPhotoCloudError } from "../src/index";
import { FakeClient, makeHandle, stream } from "./support";

describe("checked content and delete/working-copy semantics", () => {
  it("enforces exact ranges, truncation, overrun, cancellation, and rejects 200MiB+1 before the port", async () => {
    const client = new FakeClient();
    const handle = makeHandle(client);
    client.dispatch = async (operation, request) => {
      if (operation !== "content.get") throw new Error("unexpected operation");
      const contentRequest = request as PhotoOperationMap["content.get"]["request"];
      const start = contentRequest.range?.start ?? 0;
      const endInclusive = contentRequest.range?.endInclusive ?? original.sizeBytes - 1;
      return content(new Uint8Array(endInclusive - start + 1), start, endInclusive);
    };
    const ranged = await handle.readAsset(IDS.photo, original, { start: 3, endInclusive: 7 });
    await expect(readAll(ranged)).resolves.toHaveLength(5);

    client.dispatch = async () => content(new Uint8Array(4), 3, 7);
    await expect(readAll(await handle.readAsset(IDS.photo, original, { start: 3, endInclusive: 7 }))).rejects.toEqual(
      new PersonalPhotoCloudError("invalid_response"),
    );
    client.dispatch = async () => content(new Uint8Array(6), 3, 7);
    await expect(readAll(await handle.readAsset(IDS.photo, original, { start: 3, endInclusive: 7 }))).rejects.toEqual(
      new PersonalPhotoCloudError("invalid_response"),
    );

    let cancelled = false;
    let emitted = false;
    client.dispatch = async () => ({
      ...content(new Uint8Array(5), 3, 7),
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(new Uint8Array([1]));
          }
        },
        cancel() {
          cancelled = true;
        },
      }),
    });
    const cancellable = await handle.readAsset(IDS.photo, original, { start: 3, endInclusive: 7 });
    await cancellable.body.cancel();
    expect(cancelled).toBe(true);

    const callsBefore = client.calls.length;
    await expect(
      handle.readAsset(IDS.photo, { ...original, sizeBytes: PHOTO_LIMITS.maxFileBytes + 1 }),
    ).rejects.toEqual(new PersonalPhotoCloudError("invalid_response"));
    expect(client.calls).toHaveLength(callsBefore);
  });

  it("preserves working-copy metadata/null timestamps, stable keys, purge-only deletes, and exact quota", async () => {
    const workingAsset = {
      id: "working-asset",
      kind: "working-copy" as const,
      sha256: "e".repeat(64),
      sizeBytes: 4,
      contentType: "image/png",
      width: 2,
      height: 2,
    };
    const meta = { nested: { values: [1, "opaque"] }, profile: "synthetic" };
    const workingPhoto = {
      ...readyPhoto,
      media: {
        state: "ready" as const,
        thumbnail: readyPhoto.media.state === "ready" ? readyPhoto.media.thumbnail : original,
        preview: readyPhoto.media.state === "ready" ? readyPhoto.media.preview : original,
        workingCopy: { asset: workingAsset, baseVersion: "raster.synthetic", encoding: "png16" as const, meta },
        recipeRevision: recipe.revision,
        rendererManifestSha256: HASH.manifest,
      },
    };
    const client = new FakeClient();
    client.dispatch = async (operation, request) => {
      if (operation === "library.get") return library;
      if (operation === "photos.get") return workingPhoto;
      if (operation === "content.get") {
        const contentRequest = request as PhotoOperationMap["content.get"]["request"];
        if (contentRequest.assetId !== workingAsset.id) throw new Error("unexpected asset");
        return {
          body: stream(new Uint8Array([1, 2, 3, 4])),
          contentType: workingAsset.contentType,
          sha256: workingAsset.sha256,
          totalBytes: 4,
          range: { start: 0, endInclusive: 3 },
        } satisfies PhotoOperationMap["content.get"]["response"];
      }
      if (operation === "photos.delete") return responses["photos.delete"];
      throw new Error(`unexpected operation ${operation}`);
    };
    const handle = makeHandle(client);
    const ensured = await handle.library.ensureWorkingCopy(IDS.photo);
    expect(ensured.kind).toBe("ready");
    if (ensured.kind !== "ready") throw new Error("expected ready");
    expect(ensured.download.expiresAt).toBeNull();
    expect(ensured.download.work.renderedAt).toBeNull();
    const loaded = await handle.library.loadWorkingCopy(IDS.photo, ensured.download, { signal: new AbortController().signal });
    expect(JSON.parse(loaded.metaJson)).toEqual(meta);
    expect([...new Uint8Array(loaded.bytes)]).toEqual([1, 2, 3, 4]);

    const pendingClient = new FakeClient();
    pendingClient.dispatch = async (operation) => {
      if (operation === "library.get") return library;
      if (operation === "photos.get") return pendingMediaPhoto;
      if (operation === "media.ensure") return { value: { state: "pending" }, replayed: false };
      if (operation === "photos.delete") return { state: "pending" };
      throw new Error(`unexpected operation ${operation}`);
    };
    const pending = makeHandle(pendingClient);
    await expect(pending.library.ensureWorkingCopy(IDS.photo)).resolves.toMatchObject({ kind: "notReady", workStatus: "queued", workQueuedAt: null });
    await expect(pending.library.ensureWorkingCopy(IDS.photo)).resolves.toMatchObject({ kind: "notReady", workStatus: "queued" });
    const mediaKeys = pendingClient.calls.filter((call) => call.operation === "media.ensure").map((call) => call.idempotencyKey);
    expect(mediaKeys).toHaveLength(2);
    expect(mediaKeys[0]).toBe(mediaKeys[1]);
    const deletion = await pending.library.delete([IDS.photo]);
    expect(deletion.deleted).toEqual([]);
    expect(deletion.errors).toHaveLength(1);

    await expect(handle.usage()).resolves.toEqual(library.usage);
    expect(library.usage.quotaBytes).toBe(5 * 1024 ** 3);
    expect(library.usage.availableBytes).toBe(
      library.usage.quotaBytes - library.usage.usedBytes - library.usage.reservedBytes,
    );

    const deleteClient = new FakeClient();
    deleteClient.dispatch = async (operation, request) => {
      if (operation !== "photos.delete") throw new Error(`unexpected operation ${operation}`);
      const deletion = request as PhotoOperationMap["photos.delete"]["request"];
      if (deletion.photoId === "bad-photo") {
        throw { error: { code: "temporarily_unavailable", requestId: "synthetic-request", retryable: true } };
      }
      return { state: "purged" };
    };
    const deletes = makeHandle(deleteClient);
    await expect(deletes.library.delete(["good-photo", "bad-photo", "later-photo"])).resolves.toMatchObject({
      deleted: ["good-photo", "later-photo"],
      errors: [new PersonalPhotoCloudError("unavailable")],
    });
    await deletes.library.delete(["good-photo"]);
    const deleteKeys = deleteClient.calls
      .filter((call) => call.operation === "photos.delete" && (call.request as { photoId: string }).photoId === "good-photo")
      .map((call) => call.idempotencyKey);
    expect(deleteKeys).toHaveLength(2);
    expect(deleteKeys[0]).toBe(deleteKeys[1]);
  });
});

function content(bytes: Uint8Array, start: number, endInclusive: number): PhotoContent {
  return {
    body: stream(bytes),
    contentType: original.contentType,
    sha256: original.sha256,
    totalBytes: original.sizeBytes,
    range: { start, endInclusive },
  };
}

async function readAll(value: PhotoContent): Promise<number[]> {
  const reader = value.body.getReader();
  const result: number[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) return result;
    result.push(...next.value);
  }
}
