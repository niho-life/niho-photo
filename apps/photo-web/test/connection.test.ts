import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { IDS, library as fixtureLibrary, original as fixtureOriginal, page as fixturePage, responses } from "@niho/photo-personal-cloud-contract/fixtures";
import type { Photo, PersonalPhotoLibrary } from "@niho/photo-personal-cloud-contract";
import type { PhotoLibraryPresets } from "niho-photo-editing/library/photo-library";
import { PhotoSessionController, type PhotoIdentity, type PhotoSessionHostBridge } from "@niho/photo-cloud-session";
import { PHOTO_CAPTURE_HEADERS, PHOTO_CONTENT_HEADERS } from "../../../packages/photo-cloud-library/src/wire.ts";
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

import { createPhotoWebConnectionFactory } from "../src/browser/connection.ts";
import { createPhotoWebMaskSurfaceValidator } from "../src/browser/renderer.ts";

const NOW = Date.parse("2026-11-03T00:00:00.000Z");
const ORIGIN = "https://photo.example.test";
const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const digest = createHash("sha256").update(bytes).digest("hex");

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
      if (path === "/library") return json(currentLibrary);
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
      if (contentPath !== null && (contentPath[1] === IDS.photo && contentPath[2] === currentPhoto.original.id
        || addedPhoto !== null && contentPath[1] === addedPhoto.id && contentPath[2] === addedPhoto.original.id)) {
        return new Response(bytes, { status: 200, headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": String(bytes.byteLength),
          [PHOTO_CONTENT_HEADERS.sha256]: digest,
          [PHOTO_CONTENT_HEADERS.totalBytes]: String(bytes.byteLength),
        } });
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
      let reloaded;
      try {
        reloaded = await binding.library.get(IDS.photo);
      } catch (error) {
        expect(error).toMatchObject({ code: "unavailable" });
        reloaded = await binding.library.get(IDS.photo);
      }
      expect(reloaded).toMatchObject({ developRevision: 1, hasDevelopSettings: true });
      await expect(composition.guards.canLeave(actor, { release: false, signal: scope.signal })).resolves.toBe(true);

      const exported = await binding.library.downloadOriginal({
        id: IDS.photo,
        fileName: "synthetic-photo.jpg",
        sizeBytes: bytes.byteLength,
        hasOriginal: true,
      });
      expect(new Uint8Array(await exported.blob.arrayBuffer())).toEqual(bytes);

      await expect(binding.library.delete([IDS.photo, addedPhotoId])).resolves.toMatchObject({ deleted: [IDS.photo, addedPhotoId], errors: [] });
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
      scope.abort();
      connection.dispose();
      expect(maskValidatorFixture.dispose).toHaveBeenCalledOnce();
      connection = null;
      await composition.guards.onScopeRevoked(actor, "revoked");
      expect(purged).toEqual([actor]);
    } finally {
      releaseProvider();
      connection?.dispose();
      scope.abort();
      session.dispose();
    }
  });
});
