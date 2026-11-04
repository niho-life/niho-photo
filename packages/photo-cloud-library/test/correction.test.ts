import { describe, expect, it, vi } from "vitest";
import type {
  PersonalPhotoLibrary,
  Photo,
  PhotoAsset,
  PhotoContent,
  PhotoOperationMap,
  RenderCapability,
  WorkingCopy,
} from "@niho/photo-personal-cloud-contract";
import {
  HASH,
  IDS,
  emptyPage,
  library,
  mask,
  maskedPhoto,
  original,
  page,
  readyPhoto,
  recipe,
} from "@niho/photo-personal-cloud-contract/fixtures";
import { PHOTO_EDITING_PERSONAL_CLOUD_COPY } from "niho-photo-editing/photo-editing-copy";

import { PersonalPhotoCloudError } from "../src/index";
import type { PersonalPhotoCloudMaskUploader } from "../src/index";
import { FakeClient, FakeIdentity, defaultActor, defaultResponse, makeHandle, maskPngFixture, MemoryMaskJournal, stream, testMaskValidator } from "./support";

describe("scope and per-photo authority fences", () => {
  it("invalidates URLs, refs, and a stalled body when the client library binding changes", async () => {
    const client = new FakeClient();
    const identity = new FakeIdentity();
    const revoke = vi.fn();
    const cancelled = vi.fn();
    const handle = makeHandle(client, identity, {
      urls: { createObjectURL: () => "blob:scope", revokeObjectURL: revoke },
    });
    await handle.library.list({ limit: 1 });
    const opened = await handle.library.openOriginal(IDS.photo);

    client.dispatch = async (operation) => {
      if (operation !== "content.get") return defaultResponse(operation, {});
      return assetResponse(
        original,
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
          cancel: cancelled,
        }),
      );
    };
    const content = await handle.readAsset(IDS.photo, original);
    const read = content.body.getReader().read();
    client.scope.libraryId = "changed-library";
    identity.set(defaultActor({ expiresAt: "2031-01-01T00:00:00.000Z" }));

    await expect(read).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(revoke).toHaveBeenCalledWith("blob:scope");
    await expect(
      handle.library.loadOriginal(IDS.photo, opened.source, {
        signal: new AbortController().signal,
        fileName: "x.jpg",
        maxBytes: original.sizeBytes,
      }),
    ).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
  });

  it("preserves unchanged refs and live preview leases across a normal refresh", async () => {
    const identity = new FakeIdentity();
    const revoke = vi.fn();
    const handle = makeHandle(new FakeClient(), identity, {
      urls: { createObjectURL: () => "blob:stable", revokeObjectURL: revoke },
    });
    await handle.library.list({ limit: 1 });
    const opened = await handle.library.openOriginal(IDS.photo);
    identity.set(defaultActor({ expiresAt: "2031-01-01T00:00:00.000Z" }));

    await expect(
      handle.library.loadOriginal(IDS.photo, opened.source, {
        signal: new AbortController().signal,
        fileName: "stable.jpg",
        maxBytes: original.sizeBytes,
      }),
    ).resolves.toBeInstanceOf(File);
    expect(revoke).not.toHaveBeenCalled();
    handle.releasePreviewResources([IDS.photo]);
    expect(revoke).toHaveBeenCalledWith("blob:stable");
  });

  it("drops superseded resources after a newly observed recipe/media identity", async () => {
    const client = new FakeClient();
    const revoke = vi.fn();
    const handle = makeHandle(client, new FakeIdentity(), {
      urls: { createObjectURL: () => "blob:old", revokeObjectURL: revoke },
    });
    await handle.library.list({ limit: 1 });
    const opened = await handle.library.openOriginal(IDS.photo);
    const changed: Photo = {
      ...readyPhoto,
      hasEdits: true,
      recipe: { ...recipe, revision: 1, settingsSha256: "9".repeat(64) },
      media: { state: "processing", jobId: IDS.job },
    };
    client.dispatch = async (operation, request) =>
      operation === "photos.get" ? changed : defaultResponse(operation, request);

    await expect(handle.rawPhoto(IDS.photo)).rejects.toEqual(new PersonalPhotoCloudError("unavailable"));
    await expect(handle.rawPhoto(IDS.photo)).resolves.toEqual(changed);
    expect(revoke).toHaveBeenCalledWith("blob:old");
    await expect(
      handle.library.loadOriginal(IDS.photo, opened.source, {
        signal: new AbortController().signal,
        fileName: "old.jpg",
        maxBytes: original.sizeBytes,
      }),
    ).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
  });

  it("treats a fresh 404 and mismatched lookup readback as authority changes", async () => {
    const client = new FakeClient();
    const handle = makeHandle(client);
    const opened = await handle.library.openOriginal(IDS.photo);
    client.dispatch = async (operation, request) => {
      if (operation === "photos.get") {
        throw { error: { code: "not_found", requestId: "synthetic", retryable: false } };
      }
      return defaultResponse(operation, request);
    };
    await expect(handle.rawPhoto(IDS.photo)).resolves.toBeNull();
    await expect(
      handle.library.loadOriginal(IDS.photo, opened.source, {
        signal: new AbortController().signal,
        fileName: "gone.jpg",
        maxBytes: original.sizeBytes,
      }),
    ).rejects.toEqual(new PersonalPhotoCloudError("not_found"));

    const lookupClient = new FakeClient();
    const lookup = makeHandle(lookupClient);
    lookupClient.dispatch = async (operation, request) => {
      if (operation === "photos.get") return { ...readyPhoto, recipe: { ...recipe, revision: 1 } };
      return defaultResponse(operation, request);
    };
    await expect(lookup.library.lookup([HASH.original])).rejects.toEqual(
      new PersonalPhotoCloudError("invalid_response"),
    );
  });

  it("invalidates prior refs when content readback reports the photo missing", async () => {
    const client = new FakeClient();
    const handle = makeHandle(client);
    const opened = await handle.library.openOriginal(IDS.photo);
    client.dispatch = async (operation, request) => {
      if (operation === "content.get") {
        throw { error: { code: "not_found", requestId: "synthetic", retryable: false } };
      }
      return defaultResponse(operation, request);
    };
    await expect(handle.readAsset(IDS.photo, original)).rejects.toEqual(new PersonalPhotoCloudError("not_found"));
    const callsBefore = client.calls.length;
    await expect(
      handle.library.loadOriginal(IDS.photo, opened.source, {
        signal: new AbortController().signal,
        fileName: "gone.jpg",
        maxBytes: original.sizeBytes,
      }),
    ).rejects.toEqual(new PersonalPhotoCloudError("not_found"));
    expect(client.calls).toHaveLength(callsBefore);
  });

  it("does not resurrect a get that began before a successful local purge", async () => {
    const client = new FakeClient();
    let resolvePhoto: (photo: Photo) => void = () => undefined;
    client.dispatch = async (operation, request) => {
      if (operation === "photos.get") {
        return new Promise<Photo>((resolve) => {
          resolvePhoto = resolve;
        });
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client);
    const pending = handle.library.get(IDS.photo);
    await vi.waitFor(() => expect(client.calls.some((call) => call.operation === "photos.get")).toBe(true));
    await expect(handle.library.delete([IDS.photo])).resolves.toMatchObject({ deleted: [IDS.photo] });
    resolvePhoto(readyPhoto);
    await expect(pending).resolves.toBeNull();
    expect(client.calls.filter((call) => call.operation === "content.get")).toHaveLength(0);
  });

  it.each(["list", "lookup"] as const)("does not return an empty %s result after scope invalidation", async (kind) => {
    const client = new FakeClient();
    const identity = new FakeIdentity();
    client.dispatch = async (operation, request) => {
      if ((kind === "list" && operation === "photos.list") || (kind === "lookup" && operation === "photos.lookup")) {
        identity.set(null);
        return operation === "photos.list" ? emptyPage : { matches: [] };
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client, identity);
    const result = kind === "list" ? handle.library.list({ limit: 1 }) : handle.library.lookup([]);
    await expect(result).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
  });
});

describe("recipe-specific renderer and media intersection", () => {
  const geometryPhoto: Photo = {
    ...readyPhoto,
    hasEdits: true,
    recipe: {
      ...recipe,
      revision: 1,
      settingsSha256: "8".repeat(64),
      settings: { ...recipe.settings, v: 2, geometry: { rotate: 90 } },
    },
    media: { state: "processing", jobId: IDS.job },
  };

  it.each([
    ["settings version", readyPhoto, { ...library.capabilities.renderer, settingsVersions: [2] }, library],
    ["engine", readyPhoto, { ...library.capabilities.renderer, engines: ["niho-13"] }, library],
    ["geometry feature", geometryPhoto, { ...library.capabilities.renderer, features: ["masks"] }, library],
    ["mask kind", maskedPhoto, { ...library.capabilities.renderer, maskKinds: ["linear"] }, library],
    ["mask surfaces", maskedPhoto, { ...library.capabilities.renderer, maskSurfaces: false }, library],
    [
      "server mask surfaces",
      maskedPhoto,
      library.capabilities.renderer,
      { ...library, capabilities: { ...library.capabilities, maskSurfaces: false } },
    ],
  ] satisfies readonly (readonly [string, Photo, RenderCapability, PersonalPhotoLibrary])[])(
    "fails closed for a %s mismatch",
    async (_name, photo, hostRenderer, cloud) => {
      const client = new FakeClient();
      client.dispatch = async (operation, request) => {
        if (operation === "photos.get") return photo;
        if (operation === "library.get") return cloud;
        return defaultResponse(operation, request);
      };
      const handle = makeHandle(client, new FakeIdentity(), { hostRenderer });
      await expect(handle.library.openOriginal(photo.id)).rejects.toEqual(new PersonalPhotoCloudError("unsupported"));
    },
  );

  it("retains unknown current-version JSON but keeps it read-only while original download remains available", async () => {
    const unknown: Photo = {
      ...readyPhoto,
      hasEdits: true,
      recipe: {
        ...recipe,
        revision: 2,
        settingsSha256: "7".repeat(64),
        settings: { ...recipe.settings, futureField: { opaque: [1, "keep"] } },
      },
      media: { state: "unsupported", code: "unsupported_settings" },
    };
    const client = new FakeClient();
    client.dispatch = async (operation, request) =>
      operation === "photos.get" ? unknown : defaultResponse(operation, request);
    const handle = makeHandle(client);
    await expect(handle.rawPhoto(IDS.photo)).resolves.toMatchObject({ recipe: { settings: unknown.recipe.settings } });
    await expect(handle.library.openOriginal(IDS.photo)).rejects.toEqual(new PersonalPhotoCloudError("unsupported"));
    await expect(
      handle.library.downloadOriginal({ id: IDS.photo, fileName: unknown.fileName, sizeBytes: original.sizeBytes, hasOriginal: true }),
    ).resolves.toMatchObject({ fileName: unknown.fileName });
  });

  it.each(["manifest", "recipe base", "settings base"] as const)(
    "rejects a ready working copy with a mismatched %s association",
    async (kind) => {
      const working = workingCopy();
      const photo: Photo = {
        ...readyPhoto,
        recipe: {
          ...recipe,
          baseVersion: kind === "recipe base" ? "raster.other" : null,
          settings:
            kind === "settings base"
              ? { ...recipe.settings, base: "raster.other" }
              : recipe.settings,
        },
        media: {
          state: "ready",
          thumbnail: readyMedia().thumbnail,
          preview: readyMedia().preview,
          workingCopy: working,
          recipeRevision: recipe.revision,
          rendererManifestSha256: kind === "manifest" ? "6".repeat(64) : HASH.manifest,
        },
      };
      const client = new FakeClient();
      client.dispatch = async (operation, request) =>
        operation === "photos.get" ? photo : defaultResponse(operation, request);
      const handle = makeHandle(client);
      await expect(handle.library.ensureWorkingCopy(IDS.photo)).resolves.toMatchObject({ kind: "incompatible" });
    },
  );

  it.each([
    ["thumbnail", { ...readyMedia().thumbnail, width: 513 }],
    ["preview", { ...readyMedia().preview, height: 1281 }],
    ["working-copy", { ...workingCopy().asset, width: 2561 }],
  ] satisfies readonly (readonly [string, PhotoAsset])[])("rejects an oversized %s edge", async (kind, asset) => {
    const media = readyMedia();
    const photo: Photo = {
      ...readyPhoto,
      media: {
        ...media,
        thumbnail: kind === "thumbnail" ? asset : media.thumbnail,
        preview: kind === "preview" ? asset : media.preview,
        workingCopy: kind === "working-copy" ? { ...workingCopy(), asset } : null,
      },
    };
    const client = new FakeClient();
    client.dispatch = async (operation, request) =>
      operation === "photos.get" ? photo : defaultResponse(operation, request);
    await expect(makeHandle(client).rawPhoto(IDS.photo)).rejects.toEqual(
      new PersonalPhotoCloudError("invalid_response"),
    );
  });

  it("rejects oversized mask dimensions and bytes before content.get", async () => {
    const client = new FakeClient();
    const handle = makeHandle(client);
    const before = client.calls.length;
    await expect(
      handle.readAsset(IDS.photo, {
        id: IDS.mask,
        kind: "mask",
        sha256: HASH.mask,
        sizeBytes: 8 * 1024 ** 2 + 1,
        contentType: "image/png",
        width: 4097,
        height: 1,
      }),
    ).rejects.toEqual(new PersonalPhotoCloudError("invalid_response"));
    expect(client.calls).toHaveLength(before);
  });

  it("keeps mask capability closed without a real uploader and verifies exact stored/read bytes when enabled", async () => {
    const closed = makeHandle();
    await expect(closed.library.capabilities()).resolves.toMatchObject({ maskSurfaces: false });
    expect(closed.library.saveMaskSurface).toBeUndefined();
    closed.dispose();

    const uploaderOnly = makeHandle(new FakeClient(), new FakeIdentity(), {
      maskUploader: { upload: vi.fn(async () => undefined) },
    });
    await expect(uploaderOnly.library.capabilities()).resolves.toMatchObject({ maskSurfaces: false });
    expect(uploaderOnly.library.saveMaskSurface).toBeUndefined();
    uploaderOnly.dispose();

    const missingJournal = makeHandle(new FakeClient(), new FakeIdentity(), {
      maskUploader: { upload: vi.fn(async () => undefined) },
      maskValidator: testMaskValidator,
      omitMaskJournal: true,
    });
    await expect(missingJournal.library.capabilities()).resolves.toMatchObject({ maskSurfaces: false });
    expect(missingJournal.library.saveMaskSurface).toBeUndefined();
    missingJournal.dispose();

    const missingLock = makeHandle(new FakeClient(), new FakeIdentity(), {
      maskUploader: { upload: vi.fn(async () => undefined) },
      maskValidator: testMaskValidator,
      omitMaskLocks: true,
    });
    await expect(missingLock.library.capabilities()).resolves.toMatchObject({ maskSurfaces: false });
    expect(missingLock.library.saveMaskSurface).toBeUndefined();
    missingLock.dispose();

    const { bytes, surfaceId } = maskPngFixture();
    const asset: PhotoAsset = { ...mask, sha256: surfaceId, sizeBytes: bytes.byteLength, width: 1, height: 1 };
    let stored = false;
    let storedBytes = bytes.slice();
    let assertJournalBeforeNetwork = false;
    const client = new FakeClient();
    const journal = new MemoryMaskJournal();
    client.dispatch = async (operation, request) => {
      if (assertJournalBeforeNetwork) {
        expect(journal.calls).toContain("put");
        expect(journal.calls).toContain("cas");
      }
      if (operation === "photos.get") return readyPhoto;
      if (operation === "library.get") return library;
      if (operation === "masks.get") {
        if (!stored) throw new PersonalPhotoCloudError("not_found");
        expect(request).toEqual({ photoId: IDS.photo, surfaceId });
        return asset;
      }
      if (operation === "content.get") return assetResponse(asset, stream(storedBytes));
      throw new Error(`unexpected ${operation}`);
    };
    const upload = vi.fn(async (input: { bytes: Uint8Array; surfaceId: string }) => {
      expect(input.surfaceId).toBe(surfaceId);
      storedBytes = input.bytes.slice();
      stored = true;
    });
    const handle = makeHandle(client, new FakeIdentity(), {
      maskUploader: { upload }, maskValidator: testMaskValidator, maskJournal: journal,
    });
    try {
      await expect(handle.library.capabilities()).resolves.toMatchObject({ maskSurfaces: true });
      const save = handle.library.saveMaskSurface;
      if (save === undefined) throw new Error("mask upload port was not exposed");
      assertJournalBeforeNetwork = true;
      await expect(save(IDS.photo, bytes)).resolves.toEqual({ id: surfaceId, width: 1, height: 1 });
      expect(upload).toHaveBeenCalledOnce();
      const persisted = await journal.getMaskSurface({
        actorId: IDS.userA,
        libraryId: IDS.library,
        sessionId: "parent-1",
        sessionEpoch: "epoch-1",
        transport: "browser-session",
      }, IDS.photo, surfaceId);
      expect(persisted?.bytes).toEqual(bytes);
      expect(persisted?.pinned).toBe(true);
      expect(persisted?.uploadState).toBeNull();
      await expect(handle.library.loadMaskSurface?.(IDS.photo, surfaceId)).resolves.toEqual(bytes);

      storedBytes = storedBytes.slice();
      storedBytes[storedBytes.byteLength - 1] ^= 1;
      await expect(handle.library.loadMaskSurface?.(IDS.photo, surfaceId)).resolves.toEqual(bytes);
      const cloudOnly = makeHandle(client, new FakeIdentity(), {
        maskValidator: testMaskValidator,
        omitMaskJournal: true,
        omitMaskLocks: true,
      });
      try {
        await expect(cloudOnly.library.loadMaskSurface?.(IDS.photo, surfaceId)).rejects.toEqual(
          new PersonalPhotoCloudError("invalid_response"),
        );
      } finally { cloudOnly.dispose(); }
    } finally { handle.dispose(); }
  });

  it("retains the exact local PNG and resumable state after an unknown result, then settles after readback", async () => {
    const { bytes, surfaceId } = maskPngFixture(141);
    const asset: PhotoAsset = { ...mask, sha256: surfaceId, sizeBytes: bytes.byteLength, width: 1, height: 1 };
    const journal = new MemoryMaskJournal();
    const client = new FakeClient();
    let stored = false;
    client.dispatch = async (operation, request) => {
      if (operation === "photos.get") return readyPhoto;
      if (operation === "library.get") return library;
      if (operation === "masks.get") {
        if (!stored) throw new PersonalPhotoCloudError("not_found");
        expect(request).toEqual({ photoId: IDS.photo, surfaceId });
        return asset;
      }
      if (operation === "content.get") return assetResponse(asset, stream(bytes));
      throw new Error(`unexpected ${operation}`);
    };
    let attempts = 0;
    const upload = vi.fn(async (input: Parameters<PersonalPhotoCloudMaskUploader["upload"]>[0]) => {
      attempts += 1;
      if (attempts === 1) {
        const interrupted = { ...input.uploadState, phase: "uploading" as const, uploadId: "mask-upload-1", deadline: "2030-01-01T00:00:00.000Z" };
        expect(await input.compareAndSetUploadState(input.uploadState, interrupted, input.signal)).toBe(true);
        throw new PersonalPhotoCloudError("unavailable");
      }
      expect(input.uploadState).toMatchObject({ phase: "uploading", uploadId: "mask-upload-1" });
      const verifying = { ...input.uploadState, phase: "verifying" as const, offsetBytes: input.uploadState.sizeBytes };
      expect(await input.compareAndSetUploadState(input.uploadState, verifying, input.signal)).toBe(true);
      stored = true;
    });
    const handle = makeHandle(client, new FakeIdentity(), {
      maskUploader: { upload }, maskValidator: testMaskValidator, maskJournal: journal,
    });
    const journalScope = {
      actorId: IDS.userA,
      libraryId: IDS.library,
      sessionId: "parent-1",
      sessionEpoch: "epoch-1",
      transport: "browser-session" as const,
    };
    try {
      const save = handle.library.saveMaskSurface;
      if (save === undefined) throw new Error("mask upload port was not exposed");
      await expect(save(IDS.photo, bytes)).rejects.toEqual(new PersonalPhotoCloudError("unavailable"));
      const pending = await journal.getMaskSurface(journalScope, IDS.photo, surfaceId);
      expect(pending?.bytes).toEqual(bytes);
      expect(pending?.uploadState).toMatchObject({ phase: "uploading", uploadId: "mask-upload-1" });
      await expect(handle.library.loadMaskSurface?.(IDS.photo, surfaceId)).resolves.toEqual(bytes);

      await expect(save(IDS.photo, bytes)).resolves.toEqual({ id: surfaceId, width: 1, height: 1 });
      expect(upload).toHaveBeenCalledTimes(2);
      const settled = await journal.getMaskSurface(journalScope, IDS.photo, surfaceId);
      expect(settled?.bytes).toEqual(bytes);
      expect(settled?.uploadState).toBeNull();
    } finally { handle.dispose(); }
  });
});

describe("materialization budgets and explicit preview leases", () => {
  it("deduplicates concurrent preview fetches and keeps published URLs until explicit release", async () => {
    const client = new FakeClient();
    const create = vi.fn(() => "blob:shared");
    const revoke = vi.fn();
    let resolveContent: (value: PhotoContent) => void = () => undefined;
    client.dispatch = async (operation, request) => {
      if (operation === "content.get") {
        return new Promise<PhotoContent>((resolve) => {
          resolveContent = resolve;
        });
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client, new FakeIdentity(), {
      urls: { createObjectURL: create, revokeObjectURL: revoke },
    });
    const first = handle.library.list({ limit: 1 });
    const second = handle.library.list({ limit: 1 });
    await vi.waitFor(() => expect(client.calls.filter((call) => call.operation === "content.get")).toHaveLength(1));
    resolveContent(assetResponse(readyMedia().thumbnail));
    const [a, b] = await Promise.all([first, second]);
    expect(a.items[0]?.editedPreview?.thumbUrl).toBe("blob:shared");
    expect(b.items[0]?.editedPreview?.thumbUrl).toBe("blob:shared");
    expect(create).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    handle.releasePreviewResources();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("rejects cumulative preview pressure before the next port call and cleans only unpublished leases", async () => {
    const second = secondPhoto();
    const client = new FakeClient();
    const revoke = vi.fn();
    client.dispatch = async (operation, request) => {
      if (operation === "photos.list") return { ...page, items: [readyPhoto, second] };
      if (operation === "content.get") {
        const assetId = (request as PhotoOperationMap["content.get"]["request"]).assetId;
        const asset = assetId === readyMedia().thumbnail.id ? readyMedia().thumbnail : readyMediaOf(second).thumbnail;
        return assetResponse(asset);
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client, new FakeIdentity(), {
      memoryBudgets: { originalBytes: 4 * 1024 ** 2, workingCopyBytes: 2 * 1024 ** 2, previewBytes: 65_535 },
      urls: { createObjectURL: () => "blob:unpublished", revokeObjectURL: revoke },
    });
    await expect(handle.library.list({ limit: 2 })).rejects.toEqual(new PersonalPhotoCloudError("too_large"));
    expect(client.calls.filter((call) => call.operation === "content.get")).toHaveLength(1);
    expect(revoke).toHaveBeenCalledWith("blob:unpublished");
  });

  it("rejects the 65th live preview before fetch without revoking URLs published by an earlier page", async () => {
    const photos = Array.from({ length: 65 }, (_, index) => indexedPhoto(index + 1));
    const assets = new Map(photos.map((photo) => [readyMediaOf(photo).thumbnail.id, readyMediaOf(photo).thumbnail]));
    const client = new FakeClient();
    const revoke = vi.fn();
    let created = 0;
    client.dispatch = async (operation, request) => {
      if (operation === "photos.list") {
        const cursor = (request as PhotoOperationMap["photos.list"]["request"]).cursor;
        return { ...page, items: cursor ? photos.slice(60) : photos.slice(0, 60), nextCursor: cursor ? null : "next" };
      }
      if (operation === "content.get") {
        const asset = assets.get((request as PhotoOperationMap["content.get"]["request"]).assetId);
        if (!asset) throw new Error("missing indexed synthetic asset");
        return assetResponse(asset);
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client, new FakeIdentity(), {
      memoryBudgets: { originalBytes: 4 * 1024 ** 2, workingCopyBytes: 2 * 1024 ** 2, previewBytes: 2 * 1024 ** 2 },
      urls: {
        createObjectURL: () => `blob:${++created}`,
        revokeObjectURL: revoke,
      },
    });
    await expect(handle.library.list({ limit: 60 })).resolves.toHaveProperty("items.length", 60);
    await expect(handle.library.list({ cursor: "next", limit: 5 })).rejects.toEqual(
      new PersonalPhotoCloudError("too_large"),
    );
    expect(client.calls.filter((call) => call.operation === "content.get")).toHaveLength(64);
    expect(revoke.mock.calls.flat()).toEqual(["blob:61", "blob:62", "blob:63", "blob:64"]);
    handle.releasePreviewResources();
    expect(revoke).toHaveBeenCalledTimes(64);
  });

  it("rejects a concurrent original reservation before a second content.get", async () => {
    const client = new FakeClient();
    let resolveContent: (value: PhotoContent) => void = () => undefined;
    client.dispatch = async (operation, request) => {
      if (operation === "content.get") {
        return new Promise<PhotoContent>((resolve) => {
          resolveContent = resolve;
        });
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
    const requested = { id: IDS.photo, fileName: readyPhoto.fileName, sizeBytes: original.sizeBytes, hasOriginal: true };
    const first = handle.library.downloadOriginal(requested);
    await vi.waitFor(() => expect(client.calls.filter((call) => call.operation === "content.get")).toHaveLength(1));
    await expect(handle.library.downloadOriginal(requested)).rejects.toEqual(new PersonalPhotoCloudError("too_large"));
    expect(client.calls.filter((call) => call.operation === "content.get")).toHaveLength(1);
    resolveContent(assetResponse(original));
    await expect(first).resolves.toMatchObject({ fileName: readyPhoto.fileName });
  });

  it("rejects a concurrent working-copy reservation before a second content.get", async () => {
    const working = workingCopy();
    const photo = photoWithWorkingCopy(working);
    const client = new FakeClient();
    let resolveContent: (value: PhotoContent) => void = () => undefined;
    client.dispatch = async (operation, request) => {
      if (operation === "photos.get") return photo;
      if (operation === "content.get") {
        return new Promise<PhotoContent>((resolve) => {
          resolveContent = resolve;
        });
      }
      return defaultResponse(operation, request);
    };
    const handle = makeHandle(client, new FakeIdentity(), {
      memoryBudgets: { originalBytes: 4 * 1024 ** 2, workingCopyBytes: working.asset.sizeBytes * 2, previewBytes: 1024 ** 2 },
    });
    const ensured = await handle.library.ensureWorkingCopy(IDS.photo);
    if (ensured.kind !== "ready") throw new Error("expected ready synthetic working copy");
    const first = handle.library.loadWorkingCopy(IDS.photo, ensured.download, { signal: new AbortController().signal });
    await vi.waitFor(() => expect(client.calls.filter((call) => call.operation === "content.get")).toHaveLength(1));
    await expect(
      handle.library.loadWorkingCopy(IDS.photo, ensured.download, { signal: new AbortController().signal }),
    ).rejects.toEqual(new PersonalPhotoCloudError("too_large"));
    expect(client.calls.filter((call) => call.operation === "content.get")).toHaveLength(1);
    resolveContent(assetResponse(working.asset, stream(new Uint8Array(working.asset.sizeBytes))));
    await expect(first).resolves.toMatchObject({ baseVersion: working.baseVersion });
  });

  it("keeps the recently resolved ref when the 256-entry ref bound evicts the true oldest", async () => {
    const client = new FakeClient();
    const handle = makeHandle(client);
    const first = (await handle.library.openOriginal(IDS.photo)).source;
    const oldest = (await handle.library.openOriginal(IDS.photo)).source;
    await handle.library.loadOriginal(IDS.photo, first, {
      signal: new AbortController().signal,
      fileName: "first.jpg",
      maxBytes: original.sizeBytes,
    });
    for (let index = 0; index < 255; index += 1) await handle.library.openOriginal(IDS.photo);
    const callsBefore = client.calls.length;
    await expect(
      handle.library.loadOriginal(IDS.photo, oldest, {
        signal: new AbortController().signal,
        fileName: "oldest.jpg",
        maxBytes: original.sizeBytes,
      }),
    ).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
    expect(client.calls).toHaveLength(callsBefore);
    await expect(
      handle.library.loadOriginal(IDS.photo, first, {
        signal: new AbortController().signal,
        fileName: "first-again.jpg",
        maxBytes: original.sizeBytes,
      }),
    ).resolves.toBeInstanceOf(File);
  });
});

describe("content response runtime and cancellation", () => {
  it.each([
    ["missing", undefined],
    ["string", "0-3"],
    ["null", null],
  ] as const)("cancels a body whose range is %s", async (_name, range) => {
    const client = new FakeClient();
    const cancelled = vi.fn();
    client.dispatch = async () => ({
      body: new ReadableStream<Uint8Array>({ cancel: cancelled }),
      contentType: original.contentType,
      sha256: original.sha256,
      totalBytes: original.sizeBytes,
      ...(range === undefined ? {} : { range }),
    });
    const handle = makeHandle(client);
    await expect(handle.readAsset(IDS.photo, original)).rejects.toEqual(
      new PersonalPhotoCloudError("invalid_response"),
    );
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });

  it("cancels a late body returned after scope invalidation", async () => {
    const client = new FakeClient();
    const identity = new FakeIdentity();
    const cancelled = vi.fn();
    let resolveContent: (value: PhotoContent) => void = () => undefined;
    client.dispatch = async () =>
      new Promise<PhotoContent>((resolve) => {
        resolveContent = resolve;
      });
    const handle = makeHandle(client, identity);
    const pending = handle.readAsset(IDS.photo, original);
    identity.set(null);
    resolveContent(assetResponse(original, new ReadableStream<Uint8Array>({ cancel: cancelled })));
    await expect(pending).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });

  it("promptly cancels a stalled provider when the external signal aborts before consumer pull", async () => {
    const client = new FakeClient();
    const cancelled = vi.fn();
    client.dispatch = async () =>
      assetResponse(
        original,
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
          cancel: cancelled,
        }),
      );
    const handle = makeHandle(client);
    const controller = new AbortController();
    const content = await handle.readAsset(IDS.photo, original, undefined, { signal: controller.signal });
    controller.abort();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    await expect(content.body.getReader().read()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("accepts bounded empty chunks around exact data and rejects truncated or extra bytes", async () => {
    const client = new FakeClient();
    const handle = makeHandle(client);
    client.dispatch = async () =>
      assetResponse(
        { ...original, sizeBytes: 2 },
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array());
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array());
            controller.close();
          },
        }),
      );
    await expect(readAll(await handle.readAsset(IDS.photo, { ...original, sizeBytes: 2 }))).resolves.toEqual([1, 2]);

    for (const bytes of [new Uint8Array([1]), new Uint8Array([1, 2, 3])]) {
      client.dispatch = async () => assetResponse({ ...original, sizeBytes: 2 }, stream(bytes));
      await expect(readAll(await handle.readAsset(IDS.photo, { ...original, sizeBytes: 2 }))).rejects.toEqual(
        new PersonalPhotoCloudError("invalid_response"),
      );
    }
  });
});

describe("safe public errors", () => {
  it("maps unauthenticated without exposing a backend message and uses the shared plural delete copy", async () => {
    const client = new FakeClient();
    client.dispatch = async () => {
      throw {
        error: { code: "unauthenticated", requestId: "synthetic", retryable: false },
        message: "secret backend detail",
      };
    };
    const handle = makeHandle(client);
    await expect(handle.usage()).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
    expect(handle.library.errors.describe(new PersonalPhotoCloudError("scope_changed"), "fallback")).toBe(
      PHOTO_EDITING_PERSONAL_CLOUD_COPY.notConnected,
    );
    expect(handle.library.errors.describeDeleteFailure([new Error("a"), new Error("b")])).toBe(
      PHOTO_EDITING_PERSONAL_CLOUD_COPY.deleteFailedCount(2),
    );
  });
});

function readyMedia(): Extract<Photo["media"], { state: "ready" }> {
  if (readyPhoto.media.state !== "ready") throw new Error("invalid synthetic fixture");
  return readyPhoto.media;
}

function readyMediaOf(photo: Photo): Extract<Photo["media"], { state: "ready" }> {
  if (photo.media.state !== "ready") throw new Error("expected ready synthetic photo");
  return photo.media;
}

function workingCopy(): WorkingCopy {
  return {
    asset: {
      id: "working-asset",
      kind: "working-copy",
      sha256: "e".repeat(64),
      sizeBytes: 4,
      contentType: "image/png",
      width: 2,
      height: 2,
    },
    baseVersion: "raster.synthetic",
    encoding: "png16",
    meta: { opaque: { values: [1, "keep"] } },
  };
}

function photoWithWorkingCopy(working: WorkingCopy): Photo {
  const media = readyMedia();
  return { ...readyPhoto, media: { ...media, workingCopy: working } };
}

function secondPhoto(): Photo {
  const media = readyMedia();
  return {
    ...readyPhoto,
    id: "synthetic-photo-two",
    original: { ...original, id: "synthetic-original-two", sha256: "1".repeat(64) },
    media: {
      ...media,
      thumbnail: { ...media.thumbnail, id: "synthetic-thumbnail-two", sha256: "2".repeat(64) },
      preview: { ...media.preview, id: "synthetic-preview-two", sha256: "3".repeat(64) },
    },
  };
}

function indexedPhoto(index: number): Photo {
  const media = readyMedia();
  const hex = index.toString(16).padStart(64, "0");
  const previewHex = (index + 256).toString(16).padStart(64, "0");
  const originalHex = (index + 512).toString(16).padStart(64, "0");
  return {
    ...readyPhoto,
    id: `synthetic-photo-${index}`,
    original: { ...original, id: `synthetic-original-${index}`, sha256: originalHex },
    media: {
      ...media,
      thumbnail: { ...media.thumbnail, id: `synthetic-thumbnail-${index}`, sha256: hex },
      preview: { ...media.preview, id: `synthetic-preview-${index}`, sha256: previewHex },
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

async function readAll(content: PhotoContent): Promise<number[]> {
  const reader = content.body.getReader();
  const bytes: number[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) return bytes;
    bytes.push(...result.value);
  }
}
