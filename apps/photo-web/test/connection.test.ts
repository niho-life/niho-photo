import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { IDS, library as fixtureLibrary, original as fixtureOriginal, page as fixturePage, responses } from "@niho/photo-personal-cloud-contract/fixtures";
import type { Photo, PersonalPhotoLibrary } from "@niho/photo-personal-cloud-contract";
import type { PhotoLibraryPresets } from "niho-photo-editing/library/photo-library";
import { PhotoSessionController, type PhotoIdentity, type PhotoSessionHostBridge } from "@niho/photo-cloud-session";
import { PHOTO_CAPTURE_HEADERS, PHOTO_CONTENT_HEADERS } from "../../../packages/photo-cloud-library/src/wire.ts";
import { syntheticPng } from "../../../packages/photo-cloud-media/test/synthetic-png.mjs";
import { IndexedDbRecipeSyncJournal } from "@niho/photo-cloud-sync/browser";
import type { RecipeJournalScope } from "@niho/photo-cloud-sync";
import { IndexedDbTransferJournal, PERSONAL_PHOTO_TRANSFER_DATABASE_NAME } from "@niho/photo-cloud-library/browser";
import type { PhotoWebTransferBinding } from "../src/view/types.ts";
import { describe, expect, it, vi } from "vitest";

const maskValidatorFixture = vi.hoisted(() => ({
  validateMaskSurface: vi.fn(async () => ({ id: "a".repeat(64), width: 2, height: 2 })),
  dispose: vi.fn(),
}));

vi.mock("../src/browser/renderer.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/browser/renderer.ts")>("../src/browser/renderer.ts");
  return {
    ...actual,
    createPhotoWebMaskSurfaceValidator: vi.fn(async () => maskValidatorFixture),
    probePhotoWebRenderer: vi.fn(async ({ proof, signal }: { proof: { manifestUrl: string }; signal: AbortSignal }) => signal.aborted
      ? null
      : ({
        capability: fixtureLibrary.capabilities.renderer,
        engineAssets: { manifestUrl: () => proof.manifestUrl, preferNative: false },
      })),
  };
});

import { closeUnconnectedMediaJobCapabilities, createPhotoWebConnectionFactory } from "../src/browser/connection.ts";
import { createPhotoWebMaskSurfaceValidator } from "../src/browser/renderer.ts";

const NOW = Date.parse("2026-11-03T00:00:00.000Z");
const ORIGIN = "https://photo.example.test";
const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const digest = createHash("sha256").update(bytes).digest("hex");
const thumbnailBytes = syntheticPng(3, 2);
const previewBytes = syntheticPng(6, 4);
const thumbnailAsset = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  kind: "thumbnail",
  sha256: createHash("sha256").update(thumbnailBytes).digest("hex"),
  sizeBytes: thumbnailBytes.byteLength,
  contentType: "image/png",
  width: 3,
  height: 2,
} as const;
const previewAsset = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  kind: "preview",
  sha256: createHash("sha256").update(previewBytes).digest("hex"),
  sizeBytes: previewBytes.byteLength,
  contentType: "image/png",
  width: 6,
  height: 4,
} as const;

function readyMedia(revision: number): Extract<Photo["media"], { state: "ready" }> {
  return {
    state: "ready",
    thumbnail: thumbnailAsset,
    preview: previewAsset,
    workingCopy: null,
    recipeRevision: revision,
    rendererManifestSha256: fixtureLibrary.capabilities.renderer.manifestSha256,
  };
}

function identity(overrides: Partial<PhotoIdentity> = {}): PhotoIdentity {
  return {
    userId: IDS.userA,
    sessionId: "synthetic-session-web",
    sessionEpoch: "synthetic-web-epoch",
    transport: "browser-session",
    expiresAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, { ...init, headers: { "Cache-Control": "no-store", ...init.headers } });
}

function testPresets(): PhotoLibraryPresets {
  const unsupported = async (): Promise<never> => { throw new Error("preset API not connected in fixture"); };
  return {
    list: unsupported,
    create: unsupported,
    rename: unsupported,
    delete: unsupported,
    nameMaxChars: 40,
    xmpMaxBytes: 4096,
    describeError: (_error, fallback) => fallback,
    isNameTaken: () => false,
  };
}

function locks(): LockManager {
  return {
    request: async (_name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<unknown>) => {
      if (options.signal?.aborted) throw options.signal.reason;
      return await callback({ name: "fixture-lock", mode: "exclusive" } as Lock);
    },
  } as LockManager;
}

describe("Photo Web product composition", () => {
  it("connects the same-origin client, C02 library/media, C03 saved drafts, transfer, export and delete in one scope", async () => {
    const actor = identity();
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    const sessionHost: PhotoSessionHostBridge = {
      read: async () => actor,
      refresh: async () => actor,
      logout: async () => undefined,
      cancel: async () => undefined,
    };
    const session = new PhotoSessionController(sessionHost, {
      now: () => NOW,
      setTimer: () => Object.freeze({}),
      clearTimer: () => undefined,
    });
    await session.read();
    const scope = new AbortController();
    const notifyPhotosChanged = vi.fn();
    let refreshUsage: (() => Promise<void>) | null = null;
    const host = {
      scopeSignal: scope.signal,
      isScopeCurrent: () => !scope.signal.aborted,
      notifyPhotosChanged: () => {
        notifyPhotosChanged();
        if (refreshUsage !== null) void refreshUsage();
      },
      nativeFileSaveAvailable: () => false,
      isDesktopApp: () => false,
      isNativeViewport: () => false,
      saveFile: async () => "downloaded" as const,
    } as never;
    const addedPhotoId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const addedAssetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const deletedPhotoIds = new Set<string>();
    let addedPhoto: Photo | null = null;
    let uploadRecord: Record<string, unknown> | null = null;
    let providerReached!: () => void;
    const providerWasReached = new Promise<void>((resolve) => { providerReached = resolve; });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let currentPhoto: Photo = {
      ...responses["photos.get"],
      original: { ...fixtureOriginal, sizeBytes: bytes.byteLength, sha256: digest },
      media: { state: "processing", jobId: IDS.job },
    };
    let currentLibrary: PersonalPhotoLibrary = {
      ...fixtureLibrary,
      usage: {
        ...fixtureLibrary.usage,
        usedBytes: bytes.byteLength,
        originalBytes: bytes.byteLength,
        maskBytes: 0,
        reservedBytes: 0,
        availableBytes: fixtureLibrary.usage.quotaBytes - bytes.byteLength,
      },
    };
    const currentPage = () => ({
      ...fixturePage,
      items: [currentPhoto, ...(addedPhoto === null ? [] : [addedPhoto])].filter((photo) => !deletedPhotoIds.has(photo.id)),
      usage: currentLibrary.usage,
    });
    const cloudRequests: string[] = [];
    let pauseInitialLibraryProbe = true;
    let libraryProbeStarted!: () => void;
    const libraryProbeEntered = new Promise<void>((resolve) => { libraryProbeStarted = resolve; });
    let releaseLibraryProbe!: () => void;
    const libraryProbeGate = new Promise<void>((resolve) => { releaseLibraryProbe = resolve; });
    const cloudFetch: typeof fetch = async (input, init) => {
      const request = new Request(new URL(String(input), ORIGIN), init);
      const url = new URL(request.url);
      const path = url.pathname.replace("/cloud/v2", "");
      cloudRequests.push(`${request.method} ${path}`);
      expect(request.headers.get(PHOTO_CAPTURE_HEADERS.actorId)).toBe(actor.userId);
      expect(request.headers.get(PHOTO_CAPTURE_HEADERS.sessionId)).toBe(actor.sessionId);
      expect(request.headers.get(PHOTO_CAPTURE_HEADERS.sessionEpoch)).toBe(actor.sessionEpoch);
      expect(request.headers.get("Authorization")).toBeNull();
      expect(request.headers.get("Cookie")).toBeNull();
      expect(init?.cache).toBe("no-store");
      expect(init?.credentials).toBe("same-origin");
      if (path === "/library") {
        if (pauseInitialLibraryProbe) {
          pauseInitialLibraryProbe = false;
          libraryProbeStarted();
          await libraryProbeGate;
        }
        return json(currentLibrary);
      }
      if (path === "/photos" && request.method === "GET") return json(currentPage());
      const photoPath = /^\/photos\/([^/]+)$/u.exec(path);
      if (photoPath !== null && request.method === "GET") {
        const photoId = photoPath[1]!;
        const photo = photoId === IDS.photo ? currentPhoto : addedPhoto?.id === photoId ? addedPhoto : null;
        return photo === null || deletedPhotoIds.has(photoId)
          ? json({ error: { code: "not_found", requestId: "fixture", retryable: false } }, { status: 404 })
          : json(photo);
      }
      const contentPath = /^\/photos\/([^/]+)\/assets\/([^/]+)\/content$/u.exec(path);
      if (contentPath !== null) {
        const photoId = contentPath[1]!;
        const photo = photoId === IDS.photo ? currentPhoto : addedPhoto?.id === photoId ? addedPhoto : null;
        const assetId = contentPath[2]!;
        const asset = photo === null ? null : assetId === photo.original.id ? photo.original
          : photo.media.state === "ready" ? [photo.media.thumbnail, photo.media.preview, photo.media.workingCopy?.asset]
            .find((candidate) => candidate?.id === assetId) ?? null
            : null;
        const body = asset === null ? null : assetId === thumbnailAsset.id ? thumbnailBytes
          : assetId === previewAsset.id ? previewBytes
            : assetId === photo?.original.id ? bytes : null;
        if (asset !== null && body !== null) {
          const range = request.headers.get("Range");
          const headers = new Headers({
            "Content-Type": asset.contentType,
            "Content-Length": String(body.byteLength),
            [PHOTO_CONTENT_HEADERS.sha256]: asset.sha256,
            [PHOTO_CONTENT_HEADERS.totalBytes]: String(asset.sizeBytes),
          });
          if (range !== null) headers.set("Content-Range", `bytes 0-${asset.sizeBytes - 1}/${asset.sizeBytes}`);
          return new Response(body, { status: range === null ? 200 : 206, headers });
        }
      }
      if (path === "/uploads" && request.method === "POST") {
        const start = await request.json() as { target: { fileName: string; format: string }; sizeBytes: number; sha256: string; contentType: string };
        const expiresAt = new Date(NOW + 60_000).toISOString();
        uploadRecord = {
          id: IDS.upload,
          target: { kind: "original", fileName: start.target.fileName, format: start.target.format },
          sizeBytes: start.sizeBytes,
          sha256: start.sha256,
          expiresAt,
          state: "reserved",
          uploadedBytes: 0,
        };
        return json({ value: {
          kind: "upload", upload: uploadRecord,
          ticket: { url: "https://storage.googleapis.com/synthetic-upload", method: "PUT", headers: { "Content-Type": start.contentType }, expiresAt, resumeOffsetBytes: 0 },
        }, replayed: false });
      }
      if (path === `/uploads/${IDS.upload}` && request.method === "GET" && uploadRecord !== null) {
        return json({ ...uploadRecord, uploadedBytes: bytes.byteLength });
      }
      if (path === `/uploads/${IDS.upload}/complete` && request.method === "POST" && uploadRecord !== null) {
        addedPhoto = {
          ...currentPhoto,
          id: addedPhotoId,
          fileName: "uploaded-photo.jpg",
          original: { ...currentPhoto.original, id: addedAssetId, sha256: digest, sizeBytes: bytes.byteLength },
        };
        currentLibrary = { ...currentLibrary, usage: {
          ...currentLibrary.usage,
          usedBytes: bytes.byteLength * 2,
          originalBytes: bytes.byteLength * 2,
          availableBytes: currentLibrary.usage.quotaBytes - bytes.byteLength * 2,
        } };
        const stored = { ...uploadRecord, state: "stored", uploadedBytes: bytes.byteLength, result: { kind: "original", photo: addedPhoto } };
        uploadRecord = stored;
        return json({ value: stored, replayed: false });
      }
      if (path === `/photos/${IDS.photo}/recipe` && request.method === "PUT") {
        const candidate = await request.json() as { expectedRevision: number; settings: Photo["recipe"]["settings"]; baseVersion: string | null };
        expect(candidate.expectedRevision).toBe(currentPhoto.recipe.revision);
        currentPhoto = {
          ...currentPhoto,
          hasEdits: true,
          recipe: { ...currentPhoto.recipe, revision: currentPhoto.recipe.revision + 1, settings: candidate.settings, baseVersion: candidate.baseVersion },
        };
        return json({ value: currentPhoto, replayed: false });
      }
      if (photoPath !== null && request.method === "DELETE") {
        deletedPhotoIds.add(photoPath[1]!);
        const remaining = currentPage().items.length;
        const used = remaining * bytes.byteLength;
        currentLibrary = { ...currentLibrary, usage: { ...currentLibrary.usage, usedBytes: used, originalBytes: used, maskBytes: 0, reservedBytes: 0, availableBytes: currentLibrary.usage.quotaBytes - used } };
        return json({ state: "purged" });
      }
      return json({ error: { code: "not_found", requestId: "fixture", retryable: false } }, { status: 404 });
    };
    const purged: PhotoIdentity[] = [];
    const composition = createPhotoWebConnectionFactory({
      origin: ORIGIN,
      rendererProof: {
        sdkVersion: fixtureLibrary.capabilities.renderer.sdkVersion,
        crateVersion: fixtureLibrary.capabilities.renderer.crateVersion,
        sourceCommit: "a".repeat(40),
        manifestSha256: fixtureLibrary.capabilities.renderer.manifestSha256,
        manifestUrl: `/develop-engine/${fixtureLibrary.capabilities.renderer.manifestSha256}/manifest-${fixtureLibrary.capabilities.renderer.crateVersion}.json`,
      },
      presets: testPresets(),
      memoryBudgets: { originalBytes: 4096, workingCopyBytes: 4096, previewBytes: 4096 },
      clearRevokedScope: async (old) => { purged.push(old); },
      cloudFetch,
      indexedDB,
      recipeLocks: locks(),
      transferIndexedDB: indexedDB,
      transferLocks: locks(),
      providerFetch: async (input, init) => {
        expect(String(input)).toBe("https://storage.googleapis.com/synthetic-upload");
        expect(init?.method).toBe("PUT");
        expect(init?.credentials).toBe("omit");
        expect(init?.cache).toBe("no-store");
        expect(init?.redirect).toBe("manual");
        providerReached();
        await providerGate;
        return new Response(null, { status: 200 });
      },
      now: () => NOW,
      transferCopy: {
        toolbar: "transfer toolbar", pendingTitle: "pending", add: "add", resume: "resume", chooseSameFile: "choose",
        cancel: "cancel", refresh: "refresh", next: "next", first: "first", busy: "busy", failed: "failed",
        unsupported: "unsupported", refreshFailed: "refresh failed",
        phaseLabels: Object.fromEntries([
          "start-pending", "uploading", "complete-pending", "verifying", "pending-recipe", "done", "cancel-pending",
          "cancelled", "expired", "rejected", "purged", "failed", "needs-file",
        ].map((phase) => [phase, phase])) as PhotoWebTransferBinding["copy"]["phaseLabels"],
      },
    });

    let connection: Awaited<ReturnType<typeof composition.connect>> | null = null;
    try {
      const partialScope = new AbortController();
      const partialConnect = composition.connect({
        identity: actor,
        signal: partialScope.signal,
        host,
        session,
        onAuthenticationRejected: vi.fn(),
      });
      await libraryProbeEntered;
      partialScope.abort();
      await expect(composition.guards.onScopeRevoked(actor, "revoked")).resolves.toBeUndefined();
      expect(purged).toEqual([actor]);
      purged.length = 0;
      releaseLibraryProbe();
      await expect(partialConnect).rejects.toThrow();

      connection = await composition.connect({
        identity: actor,
        signal: scope.signal,
        host,
        session,
        onAuthenticationRejected: vi.fn(),
      });
      expect(createPhotoWebMaskSurfaceValidator).toHaveBeenCalledOnce();
      expect(createPhotoWebMaskSurfaceValidator).toHaveBeenCalledWith({
        engineAssets: expect.objectContaining({ preferNative: false }),
        signal: scope.signal,
      });
      refreshUsage = connection.refreshUsage ?? null;
      const binding = connection.getSnapshot();
      expect(binding.actorId).toBe(actor.userId);
      expect(binding.canEdit).toBe(true);
      expect(binding.disableCloudDelete).toBe(false);
      expect(binding.transfer).toBeDefined();
      const libraryCapabilities = await binding.library.capabilities({ signal: scope.signal });
      expect(libraryCapabilities.rawWorkingCopy).toBe(false);
      expect(binding.transfer!.formats.find((format) => format.format === "raw")?.workingCopy).toBe(false);
      expect(binding.transfer!.formats.find((format) => format.format === "jpeg")?.ingest).toBe(true);
      await expect(binding.library.ensureWorkingCopy(IDS.photo, { signal: scope.signal }))
        .resolves.toMatchObject({ kind: "notApplicable" });
      await expect(binding.transfer!.controller.checkCapability("jpeg")).resolves.toBe(true);

      const adding = binding.transfer!.controller.start({
        intentId: "composition-transfer-1",
        file: new File([bytes], "uploaded-photo.jpg", { type: "image/jpeg" }),
        format: "jpeg",
        fullRecipeCandidate: null,
      });
      await providerWasReached;
      await expect(composition.guards.canLeave(actor, { release: false, signal: scope.signal })).resolves.toBe(false);
      releaseProvider();
      const added = await adding;
      expect(added).toMatchObject({ phase: "done", photoId: addedPhotoId });
      await binding.transfer!.onSettled(added);
      expect(notifyPhotosChanged).toHaveBeenCalledOnce();
      expect(connection?.getSnapshot().usage?.usedBytes).toBe(bytes.byteLength * 2);

      const listed = await binding.library.list({});
      expect(listed.items).toHaveLength(2);
      const opened = await binding.library.openOriginal(IDS.photo);
      const file = await binding.library.loadOriginal(IDS.photo, opened.source, {
        signal: scope.signal,
        fileName: "synthetic-photo.jpg",
        maxBytes: 4096,
      });
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);

      const drafts = binding.library.durableDevelopDrafts!;
      const writer = drafts.open({ photoId: IDS.photo, sourceSha256: digest, expectedRevision: 0 });
      const staged = writer.stage(structuredClone(responses["photos.get"].recipe.settings) as never);
      await expect(staged.committed).resolves.toBe("committed");
      await expect(composition.guards.canLeave(actor, { release: false, signal: scope.signal })).resolves.toBe(false);
      await expect(writer.save(staged, { signal: scope.signal })).resolves.toMatchObject({ kind: "saved", revision: 1 });
      writer.dispose();
      currentPhoto = { ...currentPhoto, media: readyMedia(currentPhoto.recipe.revision) };
      let reloaded;
      try {
        reloaded = await binding.library.get(IDS.photo);
      } catch (error) {
        expect(error).toMatchObject({ code: "unavailable" });
        reloaded = await binding.library.get(IDS.photo);
      }
      expect(reloaded).toMatchObject({ developRevision: 1, hasDevelopSettings: true });
      expect(reloaded?.editedPreview).toMatchObject({
        revision: 1,
        thumbUrl: expect.stringMatching(/^blob:/u),
        url: null,
      });

      // Explicit selection owns preview loading. openOriginal can consume that lease, while
      // metadata-only get() calls do not cancel or revoke it.
      const selectedPreview = await binding.library.loadSelectedEditedPreview!(IDS.photo, { signal: scope.signal });
      expect(selectedPreview).toMatchObject({ revision: 1, url: expect.stringMatching(/^blob:/u) });
      const selected = await binding.library.openOriginal(IDS.photo, { signal: scope.signal });
      expect(selected.photo.editedPreview).toMatchObject({
        revision: 1,
        url: expect.stringMatching(/^blob:/u),
      });
      const fullPreviewUrl = selected.photo.editedPreview?.url;
      await binding.library.get(IDS.photo, { signal: scope.signal });
      expect(revokeObjectURL).not.toHaveBeenCalledWith(fullPreviewUrl);
      await expect(binding.library.loadSelectedEditedPreview!(addedPhotoId, { signal: scope.signal })).resolves.toBeNull();
      expect(revokeObjectURL).toHaveBeenCalledWith(fullPreviewUrl);
      expect(cloudRequests).toContain(`GET /photos/${IDS.photo}/assets/${previewAsset.id}/content`);
      await expect(composition.guards.canLeave(actor, { release: false, signal: scope.signal })).resolves.toBe(true);

      const exported = await binding.library.downloadOriginal({
        id: IDS.photo,
        fileName: "synthetic-photo.jpg",
        sizeBytes: bytes.byteLength,
        hasOriginal: true,
      });
      expect(new Uint8Array(await exported.blob.arrayBuffer())).toEqual(bytes);

      await expect(binding.library.delete([IDS.photo, addedPhotoId])).resolves.toMatchObject({ deleted: [IDS.photo, addedPhotoId], errors: [] });
      expect(revokeObjectURL).toHaveBeenCalledWith(fullPreviewUrl);
      expect((await binding.library.list({})).items).toHaveLength(0);
      host.notifyPhotosChanged();
      await connection.refreshUsage?.();
      expect(connection.getSnapshot().usage?.usedBytes).toBe(0);
      expect(notifyPhotosChanged).toHaveBeenCalledTimes(2);
      expect(cloudRequests).toContain("POST /uploads");
      expect(cloudRequests).toContain("POST /uploads/44444444-4444-4444-8444-444444444444/complete");
      expect(cloudRequests).toContain(`GET /photos/${IDS.photo}/assets/${currentPhoto.original.id}/content`);
      expect(cloudRequests).toContain(`PUT /photos/${IDS.photo}/recipe`);
      expect(cloudRequests).toContain(`DELETE /photos/${IDS.photo}`);

      const recipeScope: RecipeJournalScope = {
        actorId: actor.userId,
        libraryId: fixtureLibrary.id,
        sessionId: actor.sessionId,
        sessionEpoch: actor.sessionEpoch,
        transport: actor.transport,
      };
      const transferScope = {
        actorId: actor.userId,
        libraryId: fixtureLibrary.id,
        sessionId: actor.sessionId,
        sessionEpoch: actor.sessionEpoch,
      };
      const otherScope = { ...transferScope, sessionId: "another-session", sessionEpoch: "another-epoch" };
      const journal = new IndexedDbTransferJournal(indexedDB, PERSONAL_PHOTO_TRANSFER_DATABASE_NAME);
      const completed = await journal.get(transferScope, added.intentId);
      expect(completed).not.toBeNull();
      let lastHistoryEntry = completed!;
      for (let index = 0; index < 16; index += 1) {
        const intentId = `composition-history-${String(index).padStart(2, "0")}`;
        const historyEntry = {
          ...completed!,
          id: JSON.stringify([transferScope.actorId, transferScope.libraryId, transferScope.sessionId, transferScope.sessionEpoch, intentId]),
          revision: 0,
          intentId,
          phase: "done" as const,
          startKey: `history-start-${index}`,
          completeKey: `history-complete-${index}`,
          cancelKey: `history-cancel-${index}`,
        };
        await journal.add(historyEntry);
        lastHistoryEntry = historyEntry;
      }
      const firstTransferPage = await binding.transfer!.controller.list({ limit: 16 });
      expect(firstTransferPage.nextCursor).not.toBeNull();
      expect(firstTransferPage.items.every(({ phase, hasPendingRecipe }) => phase === "done" && !hasPendingRecipe)).toBe(true);
      const secondTransferPage = await binding.transfer!.controller.list({ limit: 16, cursor: firstTransferPage.nextCursor! });
      expect(secondTransferPage.nextCursor).toBeNull();
      expect(secondTransferPage.items).toHaveLength(1);
      expect(secondTransferPage.items[0]?.phase).toBe("done");
      await expect(composition.guards.canLeave(actor, { release: false, signal: scope.signal })).resolves.toBe(true);
      await journal.compareAndSet(lastHistoryEntry, { ...lastHistoryEntry, revision: 1, phase: "complete-pending" });
      await expect(composition.guards.canLeave(actor, { release: false, signal: scope.signal })).resolves.toBe(false);
      const pendingHistoryEntry = await journal.get(transferScope, lastHistoryEntry.intentId);
      expect(pendingHistoryEntry).not.toBeNull();
      await journal.compareAndSet(pendingHistoryEntry!, { ...pendingHistoryEntry!, revision: pendingHistoryEntry!.revision + 1, phase: "done" });
      await expect(composition.guards.canLeave(actor, { release: false, signal: scope.signal })).resolves.toBe(true);
      const revokedDraft = drafts.open({ photoId: IDS.photo, sourceSha256: digest, expectedRevision: 1 });
      const revokedStage = revokedDraft.stage(structuredClone(responses["photos.get"].recipe.settings) as never);
      await expect(revokedStage.committed).resolves.toBe("committed");
      const recipeJournal = new IndexedDbRecipeSyncJournal(indexedDB);
      await expect(recipeJournal.list(recipeScope)).resolves.toMatchObject({ writers: [{ photoId: IDS.photo }] });
      await journal.compareAndSet(completed!, { ...completed!, revision: completed!.revision + 1, phase: "complete-pending" });
      await journal.add({
        ...completed!,
        ...otherScope,
        id: JSON.stringify([otherScope.actorId, otherScope.libraryId, otherScope.sessionId, otherScope.sessionEpoch, "other-intent"]),
        revision: 0,
        intentId: "other-intent",
        phase: "complete-pending",
        startKey: "other-start",
        completeKey: "other-complete",
        cancelKey: "other-cancel",
      });
      await expect(composition.guards.canLeave(actor, { release: false, signal: scope.signal })).resolves.toBe(false);
      scope.abort();
      connection.dispose();
      expect(maskValidatorFixture.dispose).toHaveBeenCalledOnce();
      connection = null;
      await composition.guards.onScopeRevoked(actor, "revoked");
      expect(purged).toEqual([actor]);
      await expect(journal.get(transferScope, added.intentId)).rejects.toMatchObject({ code: "scope_changed" });
      expect(await journal.get(otherScope, "other-intent")).not.toBeNull();
      await expect(recipeJournal.list(recipeScope)).rejects.toThrow();
      await expect(recipeJournal.listPrevious({
        ...recipeScope,
        sessionId: "new-session",
        sessionEpoch: "new-epoch",
      })).resolves.toMatchObject({ writers: [], nextCursor: null });
      recipeJournal.dispose();
      journal.dispose();
    } finally {
      releaseProvider();
      connection?.dispose();
      scope.abort();
      session.dispose();
      revokeObjectURL.mockRestore();
    }
  });
});

describe("personal cloud client of the Photo Web library", () => {
  it("tells the shared-album render jobs when a correction reached the cloud, and only then", async () => {
    const saved = vi.fn();
    let fail = false;
    const raw = {
      scope: { actorId: "user", libraryId: "library", sessionEpoch: "epoch" },
      request: vi.fn(async (operation: string) => {
        if (fail) throw new Error("synthetic failure");
        return { operation } as never;
      }),
      dispose: vi.fn(),
    } as unknown as Parameters<typeof closeUnconnectedMediaJobCapabilities>[0];
    const client = closeUnconnectedMediaJobCapabilities(raw, saved);
    const signal = new AbortController().signal;
    await client.request("photos.get", { photoId: "p1" } as never, { signal } as never);
    expect(saved).not.toHaveBeenCalled();
    await client.request("recipes.put", {} as never, { signal, idempotencyKey: "k" } as never);
    expect(saved).toHaveBeenCalledTimes(1);
    fail = true;
    await expect(client.request("recipes.put", {} as never, { signal, idempotencyKey: "k2" } as never)).rejects.toThrow("synthetic failure");
    expect(saved).toHaveBeenCalledTimes(1);
    // A failing listener never changes the save's result.
    fail = false;
    const throwing = closeUnconnectedMediaJobCapabilities(raw, () => { throw new Error("listener"); });
    await expect(throwing.request("recipes.put", {} as never, { signal, idempotencyKey: "k3" } as never)).resolves.toEqual({ operation: "recipes.put" });
  });
});
