import type { Photo, PhotoAsset, PhotoContent, PhotoOperationMap } from "@niho/photo-personal-cloud-contract";
import { IDS, original, page, readyPhoto } from "@niho/photo-personal-cloud-contract/fixtures";
import { describe, expect, it, vi } from "vitest";

import { PersonalPhotoCloudError } from "../src/index";
import { FakeClient, FakeIdentity, defaultActor, defaultResponse, makeHandle, stream } from "./support";

type PreviewCall = "list" | "get";

describe("shared preview waiters", () => {
  it.each([
    ["list", "list", 0],
    ["list", "list", 1],
    ["list", "get", 0],
    ["list", "get", 1],
    ["get", "get", 0],
    ["get", "get", 1],
  ] as const)(
    "keeps the shared %s/%s fetch alive when waiter %i aborts",
    async (firstKind, secondKind, abortedIndex) => {
      const client = new FakeClient();
      const content = deferred<PhotoContent>();
      const revoke = vi.fn();
      client.dispatch = async (operation, request) => {
        if (operation === "content.get") return content.promise;
        return defaultResponse(operation, request);
      };
      const handle = makeHandle(client, new FakeIdentity(), {
        urls: { createObjectURL: () => "blob:shared-waiter", revokeObjectURL: revoke },
      });
      const controllers = [new AbortController(), new AbortController()];
      const pending = [
        previewCall(handle.library, firstKind, controllers[0].signal),
        previewCall(handle.library, secondKind, controllers[1].signal),
      ];
      await waitForPreviewEntrypoints(client, firstKind, secondKind);
      await vi.waitFor(() => expect(contentCalls(client)).toHaveLength(1));
      await Promise.resolve();

      controllers[abortedIndex].abort();
      await expect(pending[abortedIndex]).rejects.toMatchObject({ name: "AbortError" });
      expect(client.calls.find((call) => call.operation === "content.get")?.signal.aborted).toBe(false);

      content.resolve(assetResponse(thumbnail()));
      const survivor = await pending[1 - abortedIndex];
      expect(previewUrl(survivor)).toBe("blob:shared-waiter");
      expect(contentCalls(client)).toHaveLength(1);
      expect(revoke).not.toHaveBeenCalled();
      await expect(handle.library.info!(IDS.photo)).resolves.toMatchObject({});

      handle.releasePreviewResources([IDS.photo]);
      expect(revoke).toHaveBeenCalledOnce();
    },
  );

  it("aborts only the last detached waiter, releases its budget, and isolates a fresh same-key pending entry", async () => {
    const client = new FakeClient();
    const firstContent = deferred<PhotoContent>();
    const freshContent = deferred<PhotoContent>();
    const lateCancelled = vi.fn();
    const underlyingAborted = vi.fn();
    let contentIndex = 0;
    client.dispatch = async (operation, request, options) => {
      if (operation !== "content.get") return defaultResponse(operation, request);
      contentIndex += 1;
      if (contentIndex === 1) {
        options.signal.addEventListener("abort", underlyingAborted, { once: true });
        return firstContent.promise;
      }
      if (contentIndex === 2) return freshContent.promise;
      throw new Error("unexpected third preview fetch");
    };
    const created: string[] = [];
    const handle = makeHandle(client, new FakeIdentity(), {
      memoryBudgets: {
        originalBytes: 4 * 1024 ** 2,
        workingCopyBytes: 2 * 1024 ** 2,
        previewBytes: thumbnail().sizeBytes * 3,
      },
      urls: {
        createObjectURL: () => {
          const url = `blob:fresh-${created.length + 1}`;
          created.push(url);
          return url;
        },
        revokeObjectURL: () => undefined,
      },
    });
    const firstControllers = [new AbortController(), new AbortController()];
    const old = firstControllers.map((controller) => handle.library.get(IDS.photo, { signal: controller.signal }));
    await vi.waitFor(() => expect(contentCalls(client)).toHaveLength(1));
    firstControllers[0].abort();
    await expect(old[0]).rejects.toMatchObject({ name: "AbortError" });
    expect(underlyingAborted).not.toHaveBeenCalled();
    firstControllers[1].abort();
    await expect(old[1]).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(underlyingAborted).toHaveBeenCalledOnce());

    const fresh = handle.library.get(IDS.photo);
    await vi.waitFor(() => expect(contentCalls(client)).toHaveLength(2));
    firstContent.resolve(
      assetResponse(thumbnail(), new ReadableStream<Uint8Array>({ cancel: lateCancelled })),
    );
    await vi.waitFor(() => expect(lateCancelled).toHaveBeenCalledOnce());

    const joinedFresh = handle.library.get(IDS.photo);
    await vi.waitFor(() => expect(client.calls.filter((call) => call.operation === "photos.get")).toHaveLength(4));
    freshContent.resolve(assetResponse(thumbnail()));
    await expect(Promise.all([fresh, joinedFresh])).resolves.toEqual([
      expect.objectContaining({ editedPreview: expect.objectContaining({ thumbUrl: "blob:fresh-1" }) }),
      expect.objectContaining({ editedPreview: expect.objectContaining({ thumbUrl: "blob:fresh-1" }) }),
    ]);
    expect(contentCalls(client)).toHaveLength(2);
    expect(created).toEqual(["blob:fresh-1"]);
  });

  it("keeps a cached unpublished URL claimed by get when the creating list later fails", async () => {
    const second = secondPhoto();
    const secondContent = deferred<PhotoContent>();
    const secondCancelled = vi.fn();
    const revoke = vi.fn();
    const client = new FakeClient();
    client.dispatch = async (operation, request) => {
      if (operation === "photos.list") return { ...page, items: [readyPhoto, second], nextCursor: null };
      if (operation === "photos.get") return readyPhoto;
      if (operation === "content.get") {
        const assetId = (request as PhotoOperationMap["content.get"]["request"]).assetId;
        if (assetId === thumbnail().id) return assetResponse(thumbnail());
        return secondContent.promise;
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client, new FakeIdentity(), {
      urls: { createObjectURL: () => "blob:provisional", revokeObjectURL: revoke },
    });
    const controller = new AbortController();
    const stalledList = handle.library.list({ limit: 2 }, { signal: controller.signal });
    await vi.waitFor(() => expect(contentCalls(client)).toHaveLength(2));

    await expect(handle.library.get(IDS.photo)).resolves.toMatchObject({
      editedPreview: { thumbUrl: "blob:provisional" },
    });
    controller.abort();
    await expect(stalledList).rejects.toMatchObject({ name: "AbortError" });
    expect(revoke).not.toHaveBeenCalled();

    secondContent.resolve(
      assetResponse(secondThumbnail(second), new ReadableStream<Uint8Array>({ cancel: secondCancelled })),
    );
    await vi.waitFor(() => expect(secondCancelled).toHaveBeenCalledOnce());
    handle.releasePreviewResources([IDS.photo]);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:provisional");
  });

  it("revokes an unpublished URL only after every projecting list has failed", async () => {
    const second = secondPhoto();
    const secondContent = deferred<PhotoContent>();
    const revoke = vi.fn();
    const client = new FakeClient();
    client.dispatch = async (operation, request) => {
      if (operation === "photos.list") return { ...page, items: [readyPhoto, second], nextCursor: null };
      if (operation === "content.get") {
        const assetId = (request as PhotoOperationMap["content.get"]["request"]).assetId;
        if (assetId === thumbnail().id) return assetResponse(thumbnail());
        return secondContent.promise;
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client, new FakeIdentity(), {
      urls: { createObjectURL: () => "blob:all-failed", revokeObjectURL: revoke },
    });
    const controllers = [new AbortController(), new AbortController()];
    const lists = controllers.map((controller) =>
      handle.library.list({ limit: 2 }, { signal: controller.signal }),
    );
    await vi.waitFor(() => expect(contentCalls(client)).toHaveLength(2));

    controllers[0].abort();
    await expect(lists[0]).rejects.toMatchObject({ name: "AbortError" });
    expect(revoke).not.toHaveBeenCalled();
    controllers[1].abort();
    await expect(lists[1]).rejects.toMatchObject({ name: "AbortError" });
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:all-failed");

    secondContent.resolve(assetResponse(secondThumbnail(second)));
  });

  it.each(["explicit-release", "not-found"] as const)(
    "%s cancels one shared fetch for all pending callers without publishing a URL",
    async (invalidation) => {
      const content = deferred<PhotoContent>();
      const lateCancelled = vi.fn();
      const underlyingAborted = vi.fn();
      const create = vi.fn(() => "blob:must-not-publish");
      const client = new FakeClient();
      let notFound = false;
      client.dispatch = async (operation, request, options) => {
        if (operation === "photos.get" && notFound) {
          throw { error: { code: "not_found", requestId: "synthetic-missing", retryable: false } };
        }
        if (operation === "content.get") {
          options.signal.addEventListener("abort", underlyingAborted, { once: true });
          return content.promise;
        }
        return defaultResponse(operation, request);
      };
      const handle = makeHandle(client, new FakeIdentity(), {
        urls: { createObjectURL: create, revokeObjectURL: () => undefined },
      });
      const pending = [handle.library.get(IDS.photo), handle.library.get(IDS.photo)];
      await vi.waitFor(() => expect(contentCalls(client)).toHaveLength(1));

      if (invalidation === "explicit-release") {
        handle.releasePreviewResources([IDS.photo]);
      } else {
        notFound = true;
        await expect(handle.library.get(IDS.photo)).resolves.toBeNull();
      }
      if (invalidation === "not-found") await expect(Promise.all(pending)).resolves.toEqual([null, null]);
      else await expect(Promise.all(pending)).rejects.toBeInstanceOf(Error);
      await vi.waitFor(() => expect(underlyingAborted).toHaveBeenCalledOnce());
      expect(create).not.toHaveBeenCalled();

      content.resolve(assetResponse(thumbnail(), new ReadableStream<Uint8Array>({ cancel: lateCancelled })));
      await vi.waitFor(() => expect(lateCancelled).toHaveBeenCalledOnce());
    },
  );

  it("scope epoch change revokes a published URL once and cancels every waiter on another photo", async () => {
    const second = secondPhoto();
    const secondContent = deferred<PhotoContent>();
    const lateCancelled = vi.fn();
    const revoke = vi.fn();
    const identity = new FakeIdentity();
    const client = new FakeClient();
    client.dispatch = async (operation, request) => {
      if (operation === "photos.list") {
        const cursor = (request as PhotoOperationMap["photos.list"]["request"]).cursor;
        return { ...page, items: [cursor ? second : readyPhoto], nextCursor: null };
      }
      if (operation === "photos.get") return second;
      if (operation === "content.get") {
        const assetId = (request as PhotoOperationMap["content.get"]["request"]).assetId;
        if (assetId === thumbnail().id) return assetResponse(thumbnail());
        return secondContent.promise;
      }
      return defaultResponse(operation, request);
    };
    let created = 0;
    const handle = makeHandle(client, identity, {
      urls: { createObjectURL: () => `blob:scope-${++created}`, revokeObjectURL: revoke },
    });
    await handle.library.list({ limit: 1 });
    const pending = [
      handle.library.list({ cursor: "second", limit: 1 }),
      handle.library.get(second.id),
    ];
    await vi.waitFor(() => expect(contentCalls(client)).toHaveLength(2));

    identity.set(defaultActor({ sessionEpoch: "epoch-2" }));
    await expect(Promise.all(pending)).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:scope-1");

    secondContent.resolve(
      assetResponse(secondThumbnail(second), new ReadableStream<Uint8Array>({ cancel: lateCancelled })),
    );
    await vi.waitFor(() => expect(lateCancelled).toHaveBeenCalledOnce());
    expect(created).toBe(1);
  });

  it("invalidates the scope for a genuine backend unauthenticated failure shared by all waiters", async () => {
    const content = deferred<PhotoContent>();
    const client = new FakeClient();
    client.dispatch = async (operation, request) => {
      if (operation === "content.get") return content.promise;
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client);
    const pending = [handle.library.get(IDS.photo), handle.library.get(IDS.photo)];
    await vi.waitFor(() => expect(contentCalls(client)).toHaveLength(1));

    content.reject({ error: { code: "unauthenticated", requestId: "synthetic-auth", retryable: false } });
    await expect(Promise.all(pending)).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
    await expect(handle.library.info!(IDS.photo)).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
  });
});

function previewCall(
  library: ReturnType<typeof makeHandle>["library"],
  kind: PreviewCall,
  signal: AbortSignal,
): Promise<unknown> {
  return kind === "list" ? library.list({ limit: 1 }, { signal }) : library.get(IDS.photo, { signal });
}

async function waitForPreviewEntrypoints(client: FakeClient, first: PreviewCall, second: PreviewCall): Promise<void> {
  const expectedLists = Number(first === "list") + Number(second === "list");
  const expectedGets = Number(first === "get") + Number(second === "get");
  await vi.waitFor(() => {
    expect(client.calls.filter((call) => call.operation === "photos.list")).toHaveLength(expectedLists);
    expect(client.calls.filter((call) => call.operation === "photos.get")).toHaveLength(expectedGets);
  });
}

function previewUrl(result: unknown): string | null | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  if ("items" in result && Array.isArray(result.items)) return result.items[0]?.editedPreview?.thumbUrl;
  if ("editedPreview" in result) {
    return (result as { editedPreview?: { thumbUrl?: string | null } | null }).editedPreview?.thumbUrl;
  }
  return undefined;
}

function contentCalls(client: FakeClient) {
  return client.calls.filter((call) => call.operation === "content.get");
}

function thumbnail(): PhotoAsset {
  if (readyPhoto.media.state !== "ready") throw new Error("expected ready fixture");
  return readyPhoto.media.thumbnail;
}

function secondThumbnail(photo: Photo): PhotoAsset {
  if (photo.media.state !== "ready") throw new Error("expected ready second photo");
  return photo.media.thumbnail;
}

function secondPhoto(): Photo {
  if (readyPhoto.media.state !== "ready") throw new Error("expected ready fixture");
  return {
    ...readyPhoto,
    id: "preview-waiter-second-photo",
    fileName: "second.jpg",
    original: { ...original, id: "preview-waiter-second-original", sha256: "1".repeat(64) },
    media: {
      ...readyPhoto.media,
      thumbnail: {
        ...readyPhoto.media.thumbnail,
        id: "preview-waiter-second-thumbnail",
        sha256: "2".repeat(64),
      },
      preview: {
        ...readyPhoto.media.preview,
        id: "preview-waiter-second-preview",
        sha256: "3".repeat(64),
      },
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve = (_value: T): void => undefined;
  let reject = (_error: unknown): void => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
