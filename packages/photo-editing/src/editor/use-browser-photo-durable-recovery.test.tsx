// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { PhotoLibrary } from "../library/photo-library";
import type { PhotoLibraryDevelopDraftSnapshot, PhotoLibraryDevelopDraftWriter, PhotoLibraryDurableDevelopDrafts } from "../library/photo-library-durable-drafts";
import { PhotoLibraryProvider, type PhotoEditingHost } from "../library/photo-library-context";
import { PHOTO_EDITING_DURABLE_DRAFT_COPY } from "../photo-editing-copy";
import type { BrowserPhotoAccess, DevelopSession } from "./browser-photo-editing-model";
import { useBrowserPhotoDevelop } from "./use-browser-photo-develop";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("reuses the active writer when opening its current draft during the autosave debounce", async () => {
  const token = Object.freeze({ kind: "develop-draft" as const });
  const stage = { committed: Promise.resolve("committed" as const) };
  const candidate = { settings: { v: 1, engine: "niho-1", exposure: 0.2 }, baseVersion: null, maskSurfaceIds: [] };
  let pending = false;
  let snapshot: PhotoLibraryDevelopDraftSnapshot = {
    latest: null, latestStage: null, attempted: null, conflicts: [],
    hasUnknownAttempt: false, hasPendingResolution: false, terminalReason: null,
  };
  let notify: (() => void) | null = null;
  const writer: PhotoLibraryDevelopDraftWriter = {
    photoId: "photo", sourceSha256: "a".repeat(64), token,
    stage: vi.fn(() => {
      pending = true;
      snapshot = { ...snapshot, latest: candidate, latestStage: stage };
      notify?.();
      return stage;
    }),
    save: vi.fn(),
    retry: vi.fn(async () => {
      pending = false;
      snapshot = { latest: null, latestStage: null, attempted: null, conflicts: [], hasUnknownAttempt: false, hasPendingResolution: false, terminalReason: null };
      notify?.();
      return { kind: "saved" as const, revision: 1, updatedAt: null };
    }),
    read: vi.fn(async () => snapshot), compare: vi.fn(), resolve: vi.fn(), retryResolution: vi.fn(),
    discard: vi.fn(), dispose: vi.fn(),
  };
  const reopen = vi.fn(async () => writer);
  const port: PhotoLibraryDurableDevelopDrafts = {
    isCurrent: () => true,
    subscribe: (listener) => { notify = listener; return () => { notify = null; }; },
    open: () => writer,
    reopen,
    list: async () => ({
      items: pending ? [{ token, photoId: "photo", hasLatest: true, hasUnknownAttempt: false, conflictCount: 0 }] : [],
      nextCursor: null,
    }),
  };
  const photo = { id: "photo", contentSha256: "a".repeat(64), developRevision: 1 };
  const library = { place: "cloud", durableDevelopDrafts: port, get: async () => photo } as unknown as PhotoLibrary;
  const host: PhotoEditingHost = { notifyPhotosChanged() {}, saveFile: async () => "saved", nativeFileSaveAvailable: () => false, isNativeViewport: () => false, isDesktopApp: () => false, isScopeCurrent: () => true };
  let current!: ReturnType<typeof useBrowserPhotoDevelop>;
  function Harness() {
    const mountedRef = useRef(true);
    const latestAccessRef = useRef({ canEdit: true, spotId: "test-context", actorId: "user" } as unknown as BrowserPhotoAccess);
    const queryClient = useRef(new QueryClient());
    current = useBrowserPhotoDevelop({ spotId: "test-context", deviceClass: "pc", actorId: "user", mountedRef, latestAccessRef, queryClient: queryClient.current, setStatus: vi.fn(), replaceCloudPhoto: vi.fn(), markEditedPreviewPending: vi.fn() });
    return null;
  }
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(PhotoLibraryProvider, { library, host, children: createElement(Harness) }));
      for (let n = 0; n < 10; n++) await Promise.resolve();
    });
    const saver = current.createSaver("test-context", "photo", 0, "a".repeat(64));
    if (!saver) throw new Error("durable saver missing");
    const acknowledge = vi.spyOn(saver, "acknowledgeDurableInput");
    await act(async () => {
      current.startSession({ key: "photo", spotId: "test-context", photoId: "photo", saver, photo } as DevelopSession);
      saver.schedule({ v: 1, engine: "niho-1", exposure: 0.2 });
      for (let n = 0; n < 20; n++) await Promise.resolve();
    });
    await act(async () => {
      current.durableRecovery.actions.find((action) => action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.check)?.onClick();
      for (let n = 0; n < 20; n++) await Promise.resolve();
    });
    expect(reopen).not.toHaveBeenCalled();
    expect(writer.read).toHaveBeenCalled();
    await act(async () => {
      current.durableRecovery.actions.find((action) => action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.save)?.onClick();
      for (let n = 0; n < 30; n++) await Promise.resolve();
    });
    expect(writer.retry).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveReturnedWith(true);
    expect(writer.dispose).not.toHaveBeenCalled();
    expect(saver.hasPendingWork()).toBe(false);
    await expect(saver.flush()).resolves.toMatchObject({ ok: true });
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it.each(["none", "committed", "unsaved"] as const)("after unknown A confirmation settles only A and preserves later B (%s)", async (later) => {
  const token = { kind: "develop-draft" as const };
  const candidate = { settings: { v: 1, engine: "niho-1", exposure: 0.2 }, baseVersion: null, maskSurfaceIds: [] };
  const stage = { committed: Promise.resolve("committed" as const) };
  let snapshot: PhotoLibraryDevelopDraftSnapshot = { latest: null, latestStage: null, attempted: null, conflicts: [], hasUnknownAttempt: false, hasPendingResolution: false, terminalReason: null };
  let pending = false;
  let onPortChange: (() => void) | null = null;
  const writer: PhotoLibraryDevelopDraftWriter = {
    photoId: "photo", sourceSha256: "a".repeat(64), token,
    stage: (value) => {
      if (later !== "none" && value.exposure === 0.4) {
        return { committed: Promise.resolve(later === "committed" ? "committed" as const : "unsaved" as const) };
      }
      pending = true;
      snapshot = { ...snapshot, latest: candidate, latestStage: stage };
      onPortChange?.();
      return stage;
    },
    save: async () => { snapshot = { ...snapshot, attempted: candidate, hasUnknownAttempt: true }; return { kind: "unknown" }; },
    retry: vi.fn(async () => { pending = false; snapshot = { latest: null, latestStage: null, attempted: null, conflicts: [], hasUnknownAttempt: false, hasPendingResolution: false, terminalReason: null }; return { kind: "saved" as const, revision: 1, updatedAt: null }; }),
    read: async () => snapshot,
    compare: async () => { throw new Error("no conflict"); }, resolve: async () => { throw new Error("no conflict"); },
    retryResolution: async () => { throw new Error("no resolution"); }, discard: async () => undefined, dispose: vi.fn(),
  };
  const port: PhotoLibraryDurableDevelopDrafts = {
    isCurrent: () => true, subscribe: (listener) => { onPortChange = listener; return () => { onPortChange = null; }; }, open: () => writer, reopen: async () => writer,
    list: async () => ({ items: pending ? [{ token, photoId: "photo", hasLatest: true, hasUnknownAttempt: true, conflictCount: 0 }] : [], nextCursor: null }),
  };
  const library = { place: "cloud", durableDevelopDrafts: port, get: async () => ({ id: "photo", contentSha256: "a".repeat(64), developRevision: 1 }) } as unknown as PhotoLibrary;
  const host: PhotoEditingHost = { notifyPhotosChanged() {}, saveFile: async () => "saved", nativeFileSaveAvailable: () => false, isNativeViewport: () => false, isDesktopApp: () => false, isScopeCurrent: () => true };
  let current!: ReturnType<typeof useBrowserPhotoDevelop>;
  function Harness() {
    const mountedRef = useRef(true);
    const latestAccessRef = useRef({ canEdit: true, spotId: "test-context", actorId: "user" } as unknown as BrowserPhotoAccess);
    const queryClient = useRef(new QueryClient());
    current = useBrowserPhotoDevelop({ spotId: "test-context", deviceClass: "pc", actorId: "user", mountedRef, latestAccessRef, queryClient: queryClient.current, setStatus: vi.fn(), replaceCloudPhoto: vi.fn(), markEditedPreviewPending: vi.fn() });
    return null;
  }
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(PhotoLibraryProvider, { library, host, children: createElement(Harness) })); });
    const saver = current.createSaver("test-context", "photo", 0, "a".repeat(64));
    if (!saver) throw new Error("durable saver missing");
    await act(async () => {
      current.startSession({
        key: "photo", spotId: "test-context", photoId: "photo", saver,
        photo: { id: "photo", contentSha256: "a".repeat(64) },
      } as DevelopSession);
      saver.schedule({ v: 1, engine: "niho-1", exposure: 0.2 });
      for (let n = 0; n < 10; n++) await Promise.resolve();
      expect(saver.hasPendingWork()).toBe(true);
      expect(current.durableRecovery.blocksCurrentPhoto).toBe(false);
      expect(await saver.flush()).toMatchObject({ ok: false });
    });
    if (later !== "none") await act(async () => { saver.schedule({ v: 1, engine: "niho-1", exposure: 0.4 }); for (let n = 0; n < 10; n++) await Promise.resolve(); });
    expect(current.durableRecovery.pending).toBe(true);
    const confirm = current.durableRecovery.actions.find(action => action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.confirmSave);
    expect(confirm).toBeDefined();
    await act(async () => { confirm?.onClick(); for (let n = 0; n < 20; n++) await Promise.resolve(); });
    expect(writer.retry).toHaveBeenCalledOnce();
    expect(current.durableRecovery.pending).toBe(later !== "none");
    expect(current.developSessionRef.current?.saver?.hasPendingWork()).toBe(later !== "none");
    let canLeave = false;
    await act(async () => { canLeave = await current.leaveEditing({ release: false }); });
    expect(canLeave).toBe(later === "none");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("reopens the active edit session after saving a recovered draft", async () => {
  const token = { kind: "develop-draft" as const };
  const candidate = { settings: { v: 1, engine: "niho-1", exposure: 0.2 }, baseVersion: null, maskSurfaceIds: [] };
  let retained = true;
  let snapshot: PhotoLibraryDevelopDraftSnapshot = {
    latest: candidate,
    latestStage: { committed: Promise.resolve("committed") },
    attempted: candidate,
    conflicts: [],
    hasUnknownAttempt: true,
    hasPendingResolution: false,
    terminalReason: null,
  };
  const writer: PhotoLibraryDevelopDraftWriter = {
    photoId: "photo", sourceSha256: "a".repeat(64), token,
    stage: vi.fn(), save: vi.fn(),
    retry: vi.fn(async () => {
      retained = false;
      snapshot = { latest: null, latestStage: null, attempted: null, conflicts: [], hasUnknownAttempt: false, hasPendingResolution: false, terminalReason: null };
      return { kind: "saved" as const, revision: 1, updatedAt: null };
    }),
    read: async () => snapshot,
    compare: vi.fn(), resolve: vi.fn(), retryResolution: vi.fn(), discard: vi.fn(), dispose: vi.fn(),
  };
  const port: PhotoLibraryDurableDevelopDrafts = {
    isCurrent: () => true, subscribe: () => () => undefined, open: () => writer, reopen: async () => writer,
    list: async () => ({
      items: retained ? [{ token, photoId: "photo", hasLatest: true, hasUnknownAttempt: true, conflictCount: 0 }] : [],
      nextCursor: null,
    }),
  };
  const photo = { id: "photo", contentSha256: "a".repeat(64), developRevision: 1 };
  const library = { place: "cloud", durableDevelopDrafts: port, get: vi.fn(async () => photo) } as unknown as PhotoLibrary;
  const host: PhotoEditingHost = { notifyPhotosChanged() {}, saveFile: async () => "saved", nativeFileSaveAvailable: () => false, isNativeViewport: () => false, isDesktopApp: () => false, isScopeCurrent: () => true };
  let current!: ReturnType<typeof useBrowserPhotoDevelop>;
  function Harness() {
    const mountedRef = useRef(true);
    const latestAccessRef = useRef({ canEdit: true, spotId: "test-context", actorId: "user" } as unknown as BrowserPhotoAccess);
    const queryClient = useRef(new QueryClient());
    current = useBrowserPhotoDevelop({ spotId: "test-context", deviceClass: "pc", actorId: "user", mountedRef, latestAccessRef, queryClient: queryClient.current, setStatus: vi.fn(), replaceCloudPhoto: vi.fn(), markEditedPreviewPending: vi.fn() });
    return null;
  }
  const reload = vi.fn();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(PhotoLibraryProvider, { library, host, children: createElement(Harness) }));
      for (let n = 0; n < 10; n++) await Promise.resolve();
    });
    current.saveDurableRecoveryHandlerRef.current = reload;
    await act(async () => {
      current.startSession({
        key: "photo", spotId: "test-context", photoId: "photo", saver: null,
        photo,
      } as DevelopSession);
    });
    await act(async () => {
      current.durableRecovery.actions.find((action) => action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.check)?.onClick();
      for (let n = 0; n < 20; n++) await Promise.resolve();
    });
    await act(async () => {
      current.durableRecovery.actions.find((action) => action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.confirmSave)?.onClick();
      for (let n = 0; n < 30; n++) await Promise.resolve();
    });
    expect(writer.retry).toHaveBeenCalledOnce();
    expect(library.get).toHaveBeenCalledWith("photo", undefined);
    expect(reload).toHaveBeenCalledWith(photo);
    expect(current.durableRecovery.blocksCurrentPhoto).toBe(false);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("exports latest B and unknown attempted A without dropping either complete settings object", async () => {
  const token = { kind: "develop-draft" as const };
  const latest = { settings: { v: 1, engine: "niho-1", exposure: 0.8, unknownB: { nested: [1, 2, 3] } }, baseVersion: null, maskSurfaceIds: [] };
  const attempted = { settings: { v: 1, engine: "niho-1", exposure: 0.2, unknownA: { opaque: true } }, baseVersion: null, maskSurfaceIds: [] };
  const snapshot: PhotoLibraryDevelopDraftSnapshot = {
    latest, latestStage: { committed: Promise.resolve("committed") }, attempted,
    conflicts: [], hasUnknownAttempt: true, hasPendingResolution: false, terminalReason: null,
  };
  const writer: PhotoLibraryDevelopDraftWriter = {
    photoId: "photo", sourceSha256: "a".repeat(64), token,
    stage: vi.fn(), save: vi.fn(), retry: vi.fn(), read: async () => snapshot,
    compare: vi.fn(), resolve: vi.fn(), retryResolution: vi.fn(), discard: vi.fn(), dispose: vi.fn(),
  };
  const port: PhotoLibraryDurableDevelopDrafts = {
    isCurrent: () => true, subscribe: () => () => undefined, open: () => writer, reopen: async () => writer,
    list: async () => ({ items: [{ token, photoId: "photo", hasLatest: true, hasUnknownAttempt: true, conflictCount: 0 }], nextCursor: null }),
  };
  const saveFile = vi.fn(async (_file: { blob: Blob; fileName: string }) => "saved" as const);
  const library = { place: "cloud", durableDevelopDrafts: port } as PhotoLibrary;
  const host: PhotoEditingHost = { notifyPhotosChanged() {}, saveFile, nativeFileSaveAvailable: () => false, isNativeViewport: () => false, isDesktopApp: () => false, isScopeCurrent: () => true };
  let current!: ReturnType<typeof useBrowserPhotoDevelop>;
  function Harness() {
    const mountedRef = useRef(true);
    const latestAccessRef = useRef({ canEdit: true, spotId: "test-context", actorId: "user" } as unknown as BrowserPhotoAccess);
    const queryClient = useRef(new QueryClient());
    current = useBrowserPhotoDevelop({ spotId: "test-context", deviceClass: "pc", actorId: "user", mountedRef, latestAccessRef, queryClient: queryClient.current, setStatus: vi.fn(), replaceCloudPhoto: vi.fn(), markEditedPreviewPending: vi.fn() });
    return null;
  }
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(PhotoLibraryProvider, { library, host, children: createElement(Harness) })); for (let n = 0; n < 10; n++) await Promise.resolve(); });
    await act(async () => { current.durableRecovery.actions.find(action => action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.check)?.onClick(); for (let n = 0; n < 20; n++) await Promise.resolve(); });
    await act(async () => { current.durableRecovery.actions.find(action => action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.saveData)?.onClick(); for (let n = 0; n < 10; n++) await Promise.resolve(); });
    expect(saveFile).toHaveBeenCalledOnce();
    const saved = saveFile.mock.calls[0]?.[0];
    const envelope = JSON.parse(await saved!.blob.text()) as { version: number; latest: typeof latest; attempted: typeof attempted };
    expect(envelope.version).toBe(1);
    expect(envelope.latest.settings.unknownB).toEqual({ nested: [1, 2, 3] });
    expect(envelope.attempted.settings.unknownA).toEqual({ opaque: true });
  } finally { await act(async () => root.unmount()); container.remove(); }
});
