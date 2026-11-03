import { describe, expect, it, vi } from "vitest";
import type { Photo, PhotoAsset, PhotoContent, PhotoOperationMap, WorkingCopy } from "@niho/photo-personal-cloud-contract";
import {
  HASH,
  IDS,
  library,
  maskedPhoto,
  original,
  page,
  readyPhoto,
  recipe,
  responses,
} from "@niho/photo-personal-cloud-contract/fixtures";

import { PersonalPhotoCloudError } from "../src/index";
import { FakeClient, FakeIdentity, defaultResponse, makeHandle, stream } from "./support";

describe("bounded per-photo lifecycle", () => {
  it("keeps published previews and issued refs alive across more than 512 unrelated metadata reads", async () => {
    const client = new FakeClient();
    const revoke = vi.fn();
    const handle = makeHandle(client, new FakeIdentity(), {
      urls: { createObjectURL: () => "blob:held", revokeObjectURL: revoke },
    });
    await handle.library.list({ limit: 1 });
    const opened = await handle.library.openOriginal(IDS.photo);

    for (let index = 0; index < 513; index += 1) {
      await handle.library.info!(`metadata-pressure-${index}`);
    }

    expect(revoke).not.toHaveBeenCalled();
    await expect(
      handle.library.loadOriginal(IDS.photo, opened.source, {
        signal: new AbortController().signal,
        fileName: "held.jpg",
        maxBytes: original.sizeBytes,
      }),
    ).resolves.toBeInstanceOf(File);
    handle.releasePreviewResources([IDS.photo]);
    expect(revoke).toHaveBeenCalledWith("blob:held");
  });

  it("rejects a 513th read before its port call while all 512 photo states are actively pinned", async () => {
    const client = new FakeClient();
    const pendingInfo = deferred<PhotoOperationMap["photos.info"]["response"]>();
    client.dispatch = async (operation, request) => {
      if (operation === "photos.info") return pendingInfo.promise;
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client);
    const active = Array.from({ length: 512 }, (_, index) => handle.library.info!(`pinned-${index}`));
    await vi.waitFor(() => expect(client.calls.filter((call) => call.operation === "photos.info")).toHaveLength(512));

    await expect(handle.library.info!("pinned-513")).rejects.toEqual(new PersonalPhotoCloudError("too_large"));
    expect(client.calls.filter((call) => call.operation === "photos.info")).toHaveLength(512);

    pendingInfo.resolve(responses["photos.info"]);
    await expect(Promise.all(active)).resolves.toHaveLength(512);
  });

  it("does not publish a delayed get after pressure and a successful local purge", async () => {
    const client = new FakeClient();
    const delayedPhoto = deferred<Photo>();
    client.dispatch = async (operation, request) => {
      if (operation === "photos.get" && (request as { photoId: string }).photoId === IDS.photo) {
        return delayedPhoto.promise;
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client);
    const pending = handle.library.get(IDS.photo);
    await vi.waitFor(() => expect(client.calls.some((call) => call.operation === "photos.get")).toBe(true));
    for (let index = 0; index < 511; index += 1) await handle.library.info!(`get-pressure-${index}`);
    await expect(handle.library.delete([IDS.photo])).resolves.toMatchObject({ deleted: [IDS.photo] });
    await handle.library.info!("get-pressure-extra");

    delayedPhoto.resolve(readyPhoto);
    await expect(pending).resolves.toBeNull();
    expect(client.calls.filter((call) => call.operation === "content.get")).toHaveLength(0);
  });

  it("does not resurrect an old list item after its purge tombstone is evicted by cache pressure", async () => {
    const client = new FakeClient();
    const delayedPage = deferred<PhotoOperationMap["photos.list"]["response"]>();
    client.dispatch = async (operation, request) => {
      if (operation === "photos.list") return delayedPage.promise;
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client);
    const pending = handle.library.list({ limit: 1 });
    await vi.waitFor(() => expect(client.calls.some((call) => call.operation === "photos.list")).toBe(true));
    await handle.library.delete([IDS.photo]);
    for (let index = 0; index < 512; index += 1) await handle.library.info!(`list-pressure-${index}`);

    delayedPage.resolve(page);
    await expect(pending).rejects.toEqual(new PersonalPhotoCloudError("unavailable"));
    expect(client.calls.filter((call) => call.operation === "content.get")).toHaveLength(0);
  });
});

describe("photo-bound content cancellation", () => {
  it("releases only photo A pending preview while photo B URL, ref, and metadata remain usable", async () => {
    const photoA = photoVariant("a", 1);
    const photoB = photoVariant("b", 2);
    if (photoA.media.state !== "ready" || photoB.media.state !== "ready") throw new Error("expected ready variants");
    const mediaA = photoA.media;
    const mediaB = photoB.media;
    const lateA = deferred<PhotoContent>();
    const cancelLateA = vi.fn();
    const revoke = vi.fn();
    const assets = new Map<PhotoAsset["id"], PhotoAsset>([
      [photoA.original.id, photoA.original],
      [mediaA.thumbnail.id, mediaA.thumbnail],
      [photoB.original.id, photoB.original],
      [mediaB.thumbnail.id, mediaB.thumbnail],
    ]);
    const photos = new Map([
      [photoA.id, photoA],
      [photoB.id, photoB],
    ]);
    const client = new FakeClient();
    client.dispatch = async (operation, request) => {
      if (operation === "photos.list") {
        const cursor = (request as PhotoOperationMap["photos.list"]["request"]).cursor;
        return { ...page, items: [cursor === "photo-a" ? photoA : photoB], nextCursor: null };
      }
      if (operation === "photos.get") {
        const photo = photos.get((request as PhotoOperationMap["photos.get"]["request"]).photoId);
        if (!photo) throw new Error("missing lifecycle photo");
        return photo;
      }
      if (operation === "content.get") {
        const assetId = (request as PhotoOperationMap["content.get"]["request"]).assetId;
        if (assetId === mediaA.thumbnail.id) return lateA.promise;
        const asset = assets.get(assetId);
        if (!asset) throw new Error("missing lifecycle asset");
        return assetResponse(asset);
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client, new FakeIdentity(), {
      urls: { createObjectURL: () => "blob:photo-b", revokeObjectURL: revoke },
    });
    await handle.library.list({ limit: 1 });
    const openedB = await handle.library.openOriginal(photoB.id);
    const pendingA = handle.library.list({ cursor: "photo-a", limit: 1 });
    await vi.waitFor(() =>
      expect(
        client.calls.some(
          (call) =>
            call.operation === "content.get" &&
            (call.request as PhotoOperationMap["content.get"]["request"]).assetId === mediaA.thumbnail.id,
        ),
      ).toBe(true),
    );

    handle.releasePreviewResources([photoA.id]);
    await expect(pendingA).rejects.toMatchObject({ name: "AbortError" });
    lateA.resolve(assetResponse(mediaA.thumbnail, new ReadableStream<Uint8Array>({ cancel: cancelLateA })));
    await vi.waitFor(() => expect(cancelLateA).toHaveBeenCalledOnce());

    expect(revoke).not.toHaveBeenCalled();
    await expect(
      handle.library.loadOriginal(photoB.id, openedB.source, {
        signal: new AbortController().signal,
        fileName: photoB.fileName,
        maxBytes: photoB.original.sizeBytes,
      }),
    ).resolves.toBeInstanceOf(File);
    await expect(handle.library.info!(photoB.id)).resolves.toMatchObject({});
  });

  it("invalidates every scoped asset when the trusted content port reports unauthenticated", async () => {
    const photoA = photoVariant("auth-a", 3);
    const photoB = photoVariant("auth-b", 4);
    if (photoB.media.state !== "ready") throw new Error("expected ready variant");
    const mediaB = photoB.media;
    const revoke = vi.fn();
    const client = new FakeClient();
    client.dispatch = async (operation, request) => {
      if (operation === "photos.list") return { ...page, items: [photoB], nextCursor: null };
      if (operation === "photos.get") return photoB;
      if (operation === "content.get") {
        const assetId = (request as PhotoOperationMap["content.get"]["request"]).assetId;
        if (assetId === photoA.original.id) {
          throw { error: { code: "unauthenticated", requestId: "synthetic-auth", retryable: false } };
        }
        const asset = assetId === photoB.original.id ? photoB.original : mediaB.thumbnail;
        return assetResponse(asset);
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client, new FakeIdentity(), {
      urls: { createObjectURL: () => "blob:auth-b", revokeObjectURL: revoke },
    });
    await handle.library.list({ limit: 1 });
    const openedB = await handle.library.openOriginal(photoB.id);

    await expect(handle.readAsset(photoA.id, photoA.original)).rejects.toEqual(
      new PersonalPhotoCloudError("scope_changed"),
    );
    expect(revoke).toHaveBeenCalledWith("blob:auth-b");
    await expect(
      handle.library.loadOriginal(photoB.id, openedB.source, {
        signal: new AbortController().signal,
        fileName: photoB.fileName,
        maxBytes: photoB.original.sizeBytes,
      }),
    ).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
    await expect(handle.library.info!(photoB.id)).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
  });

  it("preserves a caller AbortError before the provider response without invalidating the scope", async () => {
    const client = new FakeClient();
    const late = deferred<PhotoContent>();
    const cancelled = vi.fn();
    client.dispatch = async (operation, request) => {
      if (operation === "content.get") return late.promise;
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client);
    const controller = new AbortController();
    const pending = handle.readAsset(IDS.photo, original, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(client.calls.some((call) => call.operation === "content.get")).toBe(true));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    late.resolve(assetResponse(original, new ReadableStream<Uint8Array>({ cancel: cancelled })));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    await expect(handle.library.info!(IDS.photo)).resolves.toMatchObject({});
  });

  it("rejects promptly on purge when content.get ignores abort and cancels its eventual late body", async () => {
    const client = new FakeClient();
    const late = deferred<PhotoContent>();
    const cancelled = vi.fn();
    client.dispatch = async (operation, request) => {
      if (operation === "content.get") return late.promise;
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client);
    const pending = handle.readAsset(IDS.photo, original);
    await vi.waitFor(() => expect(client.calls.some((call) => call.operation === "content.get")).toBe(true));
    await handle.library.delete([IDS.photo]);

    await expect(pending).rejects.toEqual(new PersonalPhotoCloudError("not_found"));
    late.resolve(assetResponse(original, new ReadableStream<Uint8Array>({ cancel: cancelled })));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });

  it("cancels a stalled reader on purge even when the consumer has never pulled it", async () => {
    const client = new FakeClient();
    const cancelled = vi.fn();
    client.dispatch = async (operation, request) => {
      if (operation === "content.get") {
        return assetResponse(
          original,
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
            cancel: cancelled,
          }),
        );
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client);
    const content = await handle.readAsset(IDS.photo, original);
    await handle.library.delete([IDS.photo]);

    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    await expect(content.body.getReader().read()).rejects.toEqual(new PersonalPhotoCloudError("not_found"));
  });

  it.each(["load-original", "download-original", "working-copy"] as const)(
    "cancels a stalled %s materialization on purge and releases its retry pin",
    async (kind) => {
      const client = new FakeClient();
      const working = workingCopy();
      const workingPhoto = photoWithWorkingCopy(working);
      client.dispatch = async (operation, request) => {
        if (operation === "photos.get") return kind === "working-copy" ? workingPhoto : readyPhoto;
        return defaultResponse(operation, request);
      };
      const handle = makeHandle(client);
      const opened = kind === "load-original" ? await handle.library.openOriginal(IDS.photo) : null;
      const ensured = kind === "working-copy" ? await handle.library.ensureWorkingCopy(IDS.photo) : null;
      if (kind === "working-copy" && ensured?.kind !== "ready") throw new Error("expected ready working copy");
      const workingDownload = ensured?.kind === "ready" ? ensured.download : null;

      const late = deferred<PhotoContent>();
      const cancelled = vi.fn();
      client.dispatch = async (operation, request) => {
        if (operation === "photos.get") return kind === "working-copy" ? workingPhoto : readyPhoto;
        if (operation === "content.get") return late.promise;
        return defaultResponse(operation, request);
      };
      const signal = new AbortController().signal;
      const pending =
        kind === "load-original"
          ? handle.library.loadOriginal(IDS.photo, opened!.source, {
              signal,
              fileName: "stalled.jpg",
              maxBytes: original.sizeBytes,
            })
          : kind === "download-original"
            ? handle.library.downloadOriginal({
                id: IDS.photo,
                fileName: readyPhoto.fileName,
                sizeBytes: original.sizeBytes,
                hasOriginal: true,
              })
            : handle.library.loadWorkingCopy(IDS.photo, workingDownload!, { signal });
      await vi.waitFor(() => expect(client.calls.some((call) => call.operation === "content.get")).toBe(true));
      await handle.library.delete([IDS.photo]);

      await expect(pending).rejects.toBeInstanceOf(Error);
      late.resolve(
        assetResponse(
          kind === "working-copy" ? working.asset : original,
          new ReadableStream<Uint8Array>({ cancel: cancelled }),
        ),
      );
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
      const callsBeforeRetry = client.calls.length;
      const retry =
        kind === "load-original"
          ? handle.library.loadOriginal(IDS.photo, opened!.source, {
              signal: new AbortController().signal,
              fileName: "retry.jpg",
              maxBytes: original.sizeBytes,
            })
          : kind === "download-original"
            ? handle.library.downloadOriginal({
                id: IDS.photo,
                fileName: readyPhoto.fileName,
                sizeBytes: original.sizeBytes,
                hasOriginal: true,
              })
            : handle.library.loadWorkingCopy(IDS.photo, workingDownload!, {
                signal: new AbortController().signal,
              });
      await expect(retry).rejects.toEqual(new PersonalPhotoCloudError("not_found"));
      expect(client.calls).toHaveLength(callsBeforeRetry);
    },
  );

  it("preserves caller AbortError and releases the original budget for a successful retry", async () => {
    const client = new FakeClient();
    const cancelled = vi.fn();
    let first = true;
    client.dispatch = async (operation, request) => {
      if (operation === "content.get" && first) {
        first = false;
        return assetResponse(
          original,
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
            cancel: cancelled,
          }),
        );
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client, new FakeIdentity(), {
      memoryBudgets: {
        originalBytes: original.sizeBytes * 3,
        workingCopyBytes: 2 * 1024 ** 2,
        previewBytes: 1024 ** 2,
      },
    });
    const opened = await handle.library.openOriginal(IDS.photo);
    const controller = new AbortController();
    const pending = handle.library.loadOriginal(IDS.photo, opened.source, {
      signal: controller.signal,
      fileName: "first.jpg",
      maxBytes: original.sizeBytes,
    });
    await vi.waitFor(() => expect(client.calls.some((call) => call.operation === "content.get")).toBe(true));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    await expect(
      handle.library.loadOriginal(IDS.photo, opened.source, {
        signal: new AbortController().signal,
        fileName: "second.jpg",
        maxBytes: original.sizeBytes,
      }),
    ).resolves.toBeInstanceOf(File);
  });
});

describe("mask reader boundary", () => {
  it("fails closed for external bitmap masks despite advertised capabilities while retaining raw JSON and download", async () => {
    const client = new FakeClient();
    client.dispatch = async (operation, request) => {
      if (operation === "photos.get") return maskedPhoto;
      if (operation === "library.get") return library;
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client);

    await expect(handle.rawPhoto(maskedPhoto.id)).resolves.toMatchObject({ recipe: { settings: maskedPhoto.recipe.settings } });
    await expect(handle.library.openOriginal(maskedPhoto.id)).rejects.toEqual(new PersonalPhotoCloudError("unsupported"));
    await expect(handle.library.ensureWorkingCopy(maskedPhoto.id)).resolves.toMatchObject({ kind: "incompatible" });
    await expect(
      handle.library.downloadOriginal({
        id: maskedPhoto.id,
        fileName: maskedPhoto.fileName,
        sizeBytes: maskedPhoto.original.sizeBytes,
        hasOriginal: true,
      }),
    ).resolves.toMatchObject({ fileName: maskedPhoto.fileName });
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function workingCopy(): WorkingCopy {
  return {
    asset: {
      id: "lifecycle-working-asset",
      kind: "working-copy",
      sha256: "e".repeat(64),
      sizeBytes: 4,
      contentType: "image/png",
      width: 2,
      height: 2,
    },
    baseVersion: "raster.synthetic",
    encoding: "png16",
    meta: { lifecycle: true },
  };
}

function photoWithWorkingCopy(working: WorkingCopy): Photo {
  if (readyPhoto.media.state !== "ready") throw new Error("invalid ready fixture");
  return {
    ...readyPhoto,
    recipe: { ...recipe, baseVersion: null },
    media: {
      ...readyPhoto.media,
      workingCopy: working,
      recipeRevision: recipe.revision,
      rendererManifestSha256: HASH.manifest,
    },
  };
}

function photoVariant(label: string, index: number): Photo {
  if (readyPhoto.media.state !== "ready") throw new Error("invalid ready fixture");
  const hash = (offset: number): string => (index + offset).toString(16).padStart(64, "0");
  return {
    ...readyPhoto,
    id: `lifecycle-photo-${label}`,
    fileName: `${label}.jpg`,
    original: { ...readyPhoto.original, id: `lifecycle-original-${label}`, sha256: hash(0) },
    media: {
      ...readyPhoto.media,
      thumbnail: { ...readyPhoto.media.thumbnail, id: `lifecycle-thumbnail-${label}`, sha256: hash(100) },
      preview: { ...readyPhoto.media.preview, id: `lifecycle-preview-${label}`, sha256: hash(200) },
    },
  };
}

function assetResponse(asset: PhotoAsset, body = stream(new Uint8Array(asset.sizeBytes))): PhotoContent {
  return {
    body,
    contentType: asset.contentType,
    sha256: asset.sha256,
    totalBytes: asset.sizeBytes,
    range: { start: 0, endInclusive: asset.sizeBytes - 1 },
  };
}
