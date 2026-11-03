// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import type { PhotoLibrary } from "../library/photo-library";
import type {
  PhotoLibraryDevelopConflictComparison,
  PhotoLibraryDevelopDraftSnapshot,
  PhotoLibraryDevelopDraftWriter,
  PhotoLibraryDurableDevelopDrafts,
} from "../library/photo-library-durable-drafts";
import { PhotoLibraryProvider, type PhotoEditingHost } from "../library/photo-library-context";
import { PHOTO_EDITING_DURABLE_DRAFT_COPY } from "../photo-editing-copy";
import type { BrowserPhotoAccess, DevelopSession } from "./browser-photo-editing-model";
import { useBrowserPhotoDevelop } from "./use-browser-photo-develop";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function emptySnapshot(): PhotoLibraryDevelopDraftSnapshot {
  return {
    latest: null, latestStage: null, attempted: null, conflicts: [],
    hasUnknownAttempt: false, hasPendingResolution: false, terminalReason: null,
  };
}

function renderDevelop(input: {
  port: PhotoLibraryDurableDevelopDrafts;
  host?: Partial<PhotoEditingHost>;
  get?: PhotoLibrary["get"];
}) {
  const library = {
    place: "cloud",
    durableDevelopDrafts: input.port,
    get: input.get ?? vi.fn(async (photoId: string) => ({
      id: photoId, fileName: "以前の写真.jpg", contentSha256: "a".repeat(64), developRevision: 0,
    })),
  } as unknown as PhotoLibrary;
  const host: PhotoEditingHost = {
    notifyPhotosChanged() {}, saveFile: async () => "saved", nativeFileSaveAvailable: () => false,
    isNativeViewport: () => false, isDesktopApp: () => false, isScopeCurrent: () => true,
    ...input.host,
  };
  let current!: ReturnType<typeof useBrowserPhotoDevelop>;
  function Harness() {
    const mountedRef = useRef(true);
    const latestAccessRef = useRef({ canEdit: true, spotId: "spot", actorId: "user" } as unknown as BrowserPhotoAccess);
    const queryClient = useRef(new QueryClient());
    current = useBrowserPhotoDevelop({
      spotId: "spot", deviceClass: "pc", actorId: "user", mountedRef, latestAccessRef,
      queryClient: queryClient.current, setStatus: vi.fn(), replaceCloudPhoto: vi.fn(), markEditedPreviewPending: vi.fn(),
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    get current() { return current; },
    async mount() {
      await act(async () => {
        root.render(createElement(PhotoLibraryProvider, { library, host, children: createElement(Harness) }));
        for (let n = 0; n < 10; n++) await Promise.resolve();
      });
    },
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}

it("does not list previous drafts before the explicit entry and keeps them out of current recovery", async () => {
  const token = Object.freeze({ kind: "develop-draft" as const });
  const previousList = vi.fn(async () => ({
    items: [{ token, photoId: "photo", hasLatest: true, hasUnknownAttempt: false, conflictCount: 0 }],
    nextCursor: null,
  }));
  const writer = { dispose: vi.fn() } as unknown as PhotoLibraryDevelopDraftWriter;
  const port: PhotoLibraryDurableDevelopDrafts = {
    isCurrent: () => true, subscribe: () => () => undefined, open: vi.fn(),
    list: async () => ({ items: [], nextCursor: null }), reopen: vi.fn(),
    previous: { list: previousList, reopen: vi.fn(async () => writer) },
  };
  const fixture = renderDevelop({ port });
  try {
    await fixture.mount();
    act(() => fixture.current.startSession({
      key: "photo", spotId: "spot", photoId: "photo", saver: null,
      photo: { id: "photo", fileName: "現在の写真.jpg", contentSha256: "a".repeat(64) },
    } as DevelopSession));
    expect(previousList).not.toHaveBeenCalled();
    expect(fixture.current.durableRecovery.pending).toBe(false);
    expect(fixture.current.durableRecovery.blocksCurrentPhoto).toBe(false);
    expect(fixture.current.previousDrafts.blocksCurrentPhoto).toBe(false);

    await act(async () => {
      fixture.current.previousDrafts.entryAction?.onClick();
      for (let n = 0; n < 20; n++) await Promise.resolve();
    });
    expect(previousList).toHaveBeenCalledWith({ limit: 16 }, undefined);
    expect(fixture.current.previousDrafts.dialog?.items).toHaveLength(1);
    expect(fixture.current.previousDrafts.dialog?.items[0]?.photoName).toBe("以前の写真.jpg");
    expect(fixture.current.durableRecovery.pending).toBe(false);
    expect(fixture.current.durableRecovery.blocksCurrentPhoto).toBe(false);
  } finally { await fixture.unmount(); }
});

it("opens only the chosen previous writer, retries unknown with its fixed request, and exports every snapshot", async () => {
  const token = Object.freeze({ kind: "develop-draft" as const });
  const conflict = Object.freeze({ kind: "develop-conflict" as const });
  const choice = Object.freeze({ kind: "develop-choice" as const });
  const latest = { settings: { v: 1, engine: "niho-1", unknownLatest: { n: 1 } }, baseVersion: null, maskSurfaceIds: [] };
  const attempted = { settings: { v: 1, engine: "niho-1", unknownAttempt: [1, 2] }, baseVersion: null, maskSurfaceIds: [] };
  const comparison: PhotoLibraryDevelopConflictComparison = {
    choice,
    candidate: { settings: { v: 1, engine: "niho-1", unknownCandidate: true }, baseVersion: null, maskSurfaceIds: [] },
    current: { settings: { v: 1, engine: "niho-1", unknownCurrent: true }, baseVersion: null, maskSurfaceIds: [] },
    historicalCurrent: { settings: { v: 1, engine: "niho-1", unknownHistorical: true }, baseVersion: null, maskSurfaceIds: [] },
    expectedRevision: 3, canAdopt: false,
  };
  const snapshot: PhotoLibraryDevelopDraftSnapshot = {
    latest, latestStage: { committed: Promise.resolve("committed") }, attempted, conflicts: [conflict],
    hasUnknownAttempt: true, hasPendingResolution: false, terminalReason: null,
  };
  const writer: PhotoLibraryDevelopDraftWriter = {
    photoId: "photo", sourceSha256: "a".repeat(64), token,
    stage: vi.fn(() => { throw new Error("previous stage must stay closed"); }), save: vi.fn(),
    retry: vi.fn(async () => ({ kind: "unknown" as const })), read: vi.fn(async () => snapshot),
    compare: vi.fn(async () => comparison), resolve: vi.fn(), retryResolution: vi.fn(),
    discard: vi.fn(), dispose: vi.fn(),
  };
  const previousReopen = vi.fn(async () => writer);
  const saveFile = vi.fn(async () => "saved" as const);
  const port: PhotoLibraryDurableDevelopDrafts = {
    isCurrent: () => true, subscribe: () => () => undefined, open: vi.fn(),
    list: async () => ({ items: [], nextCursor: null }), reopen: vi.fn(),
    previous: {
      list: async () => ({ items: [{ token, photoId: "photo", hasLatest: true, hasUnknownAttempt: true, conflictCount: 1 }], nextCursor: null }),
      reopen: previousReopen,
    },
  };
  const fixture = renderDevelop({ port, host: { saveFile } });
  try {
    await fixture.mount();
    await act(async () => {
      fixture.current.previousDrafts.entryAction?.onClick();
      for (let n = 0; n < 20; n++) await Promise.resolve();
    });
    await act(async () => {
      fixture.current.previousDrafts.dialog?.items[0]?.onOpen();
      for (let n = 0; n < 20; n++) await Promise.resolve();
    });
    expect(previousReopen).toHaveBeenCalledOnce();
    expect(writer.save).not.toHaveBeenCalled();
    expect(writer.retry).not.toHaveBeenCalled();
    expect(writer.stage).not.toHaveBeenCalled();
    expect(fixture.current.previousDrafts.dialog?.selected?.actions.some((action) =>
      action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.discard)).toBe(false);

    await act(async () => {
      fixture.current.previousDrafts.dialog?.selected?.actions.find((action) =>
        action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.compare)?.onClick();
      for (let n = 0; n < 20; n++) await Promise.resolve();
    });
    await act(async () => {
      fixture.current.previousDrafts.comparison?.onSaveData?.();
      for (let n = 0; n < 10; n++) await Promise.resolve();
    });
    const saved = saveFile.mock.calls[0]?.[0];
    const envelope = JSON.parse(await saved!.blob.text()) as Record<string, any>;
    expect(envelope.latest.settings.unknownLatest).toEqual({ n: 1 });
    expect(envelope.attempted.settings.unknownAttempt).toEqual([1, 2]);
    expect(envelope.comparison.candidate.settings.unknownCandidate).toBe(true);
    expect(envelope.comparison.current.settings.unknownCurrent).toBe(true);
    expect(envelope.comparison.historicalCurrent.settings.unknownHistorical).toBe(true);

    act(() => fixture.current.previousDrafts.comparison?.onClose());
    await act(async () => {
      fixture.current.previousDrafts.dialog?.selected?.actions.find((action) =>
        action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.previousSave)?.onClick();
      for (let n = 0; n < 20; n++) await Promise.resolve();
    });
    expect(writer.retry).toHaveBeenCalledOnce();
    expect(writer.save).not.toHaveBeenCalled();
  } finally { await fixture.unmount(); }
});

it("pauses current B while manual A is open and resumes B without a fresh-photo reload", async () => {
  const currentToken = Object.freeze({ kind: "develop-draft" as const });
  const previousToken = Object.freeze({ kind: "develop-draft" as const });
  let commitB!: (outcome: "committed") => void;
  const stageB = { committed: new Promise<"committed">((resolve) => { commitB = resolve; }) };
  const saveB = vi.fn(async () => ({ kind: "saved" as const, revision: 8, updatedAt: null }));
  const currentWriter: PhotoLibraryDevelopDraftWriter = {
    photoId: "photo", sourceSha256: "a".repeat(64), token: currentToken,
    stage: vi.fn(() => stageB), save: saveB, retry: vi.fn(), read: vi.fn(async () => emptySnapshot()),
    compare: vi.fn(), resolve: vi.fn(), retryResolution: vi.fn(), discard: vi.fn(), dispose: vi.fn(),
  };
  const candidate = { settings: { v: 1, engine: "niho-1", exposure: 0.1 }, baseVersion: null, maskSurfaceIds: [] };
  let previousSnapshot: PhotoLibraryDevelopDraftSnapshot = {
    latest: candidate, latestStage: { committed: Promise.resolve("committed") }, attempted: candidate,
    conflicts: [], hasUnknownAttempt: true, hasPendingResolution: false, terminalReason: null,
  };
  const previousWriter: PhotoLibraryDevelopDraftWriter = {
    photoId: "photo", sourceSha256: "a".repeat(64), token: previousToken,
    stage: vi.fn(), save: vi.fn(),
    retry: vi.fn(async () => {
      previousSnapshot = emptySnapshot();
      return { kind: "saved" as const, revision: 7, updatedAt: null };
    }),
    read: vi.fn(async () => previousSnapshot), compare: vi.fn(), resolve: vi.fn(), retryResolution: vi.fn(),
    discard: vi.fn(), dispose: vi.fn(),
  };
  const get = vi.fn(async (photoId: string) => ({
    id: photoId, fileName: "写真.jpg", contentSha256: "a".repeat(64), developRevision: 7,
  })) as unknown as PhotoLibrary["get"];
  const port: PhotoLibraryDurableDevelopDrafts = {
    isCurrent: () => true, subscribe: () => () => undefined, open: () => currentWriter,
    list: async () => ({ items: [], nextCursor: null }), reopen: vi.fn(),
    previous: {
      list: async () => ({
        items: [{ token: previousToken, photoId: "photo", hasLatest: true, hasUnknownAttempt: true, conflictCount: 0 }],
        nextCursor: null,
      }),
      reopen: async () => previousWriter,
    },
  };
  const fixture = renderDevelop({ port, get });
  try {
    await fixture.mount();
    const saver = fixture.current.createSaver("spot", "photo", 6, "a".repeat(64));
    if (!saver) throw new Error("durable saver missing");
    act(() => {
      fixture.current.startSession({
        key: "photo", spotId: "spot", photoId: "photo", saver,
        photo: { id: "photo", fileName: "写真.jpg", contentSha256: "a".repeat(64) },
      } as DevelopSession);
      saver.schedule({ v: 1, engine: "niho-1", exposure: 0.8 });
      fixture.current.previousDrafts.entryAction?.onClick();
    });
    await act(async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); });
    await act(async () => {
      fixture.current.previousDrafts.dialog?.items[0]?.onOpen();
      for (let n = 0; n < 20; n++) await Promise.resolve();
    });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let n = 0; n < 10; n++) await Promise.resolve();
    });
    visibility.mockRestore();
    let pausedFlush: Awaited<ReturnType<typeof saver.flush>> | undefined;
    await act(async () => { pausedFlush = await saver.flush(); });
    expect(pausedFlush).toMatchObject({ ok: false });
    expect(saveB).not.toHaveBeenCalled();
    expect(fixture.current.previousDrafts.blocksCurrentPhoto).toBe(true);

    await act(async () => {
      fixture.current.previousDrafts.dialog?.selected?.actions.find((action) =>
        action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.previousSave)?.onClick();
      for (let n = 0; n < 20; n++) await Promise.resolve();
    });
    expect(previousWriter.retry).toHaveBeenCalledOnce();
    expect(saveB).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledOnce();
    expect(saver.hasPendingWork()).toBe(true);

    commitB("committed");
    let resumedFlush: Awaited<ReturnType<typeof saver.flush>> | undefined;
    await act(async () => { resumedFlush = await saver.flush(); });
    expect(resumedFlush).toMatchObject({ ok: true, saved: { developRevision: 8 } });
    expect(saveB).toHaveBeenCalledOnce();
  } finally { await fixture.unmount(); }
});

it("drops late previous list and open results after scope revocation and disposes the late writer", async () => {
  const token = Object.freeze({ kind: "develop-draft" as const });
  let resolveList!: (page: { items: any[]; nextCursor: null }) => void;
  const previousList = vi.fn(() => new Promise<{ items: any[]; nextCursor: null }>((resolve) => { resolveList = resolve; }));
  let resolveOpen!: (writer: PhotoLibraryDevelopDraftWriter) => void;
  const previousReopen = vi.fn(() => new Promise<PhotoLibraryDevelopDraftWriter>((resolve) => { resolveOpen = resolve; }));
  const controller = new AbortController();
  const port: PhotoLibraryDurableDevelopDrafts = {
    isCurrent: () => !controller.signal.aborted, subscribe: () => () => undefined, open: vi.fn(),
    list: async () => ({ items: [], nextCursor: null }), reopen: vi.fn(),
    previous: { list: previousList, reopen: previousReopen },
  };
  const fixture = renderDevelop({ port, host: { scopeSignal: controller.signal } });
  try {
    await fixture.mount();
    act(() => fixture.current.previousDrafts.entryAction?.onClick());
    act(() => controller.abort());
    await act(async () => {
      resolveList({ items: [{ token, photoId: "secret", hasLatest: true, hasUnknownAttempt: false, conflictCount: 0 }], nextCursor: null });
      for (let n = 0; n < 10; n++) await Promise.resolve();
    });
    expect(fixture.current.previousDrafts.dialog).toBeNull();

    const lateWriter = { dispose: vi.fn() } as unknown as PhotoLibraryDevelopDraftWriter;
    const secondController = new AbortController();
    const openFixture = renderDevelop({
      port: { ...port, isCurrent: () => !secondController.signal.aborted },
      host: { scopeSignal: secondController.signal },
    });
    try {
      await openFixture.mount();
      act(() => openFixture.current.previousDrafts.entryAction?.onClick());
      await act(async () => {
        resolveList({ items: [{ token, photoId: "photo", hasLatest: true, hasUnknownAttempt: false, conflictCount: 0 }], nextCursor: null });
        for (let n = 0; n < 10; n++) await Promise.resolve();
      });
      await act(async () => {
        openFixture.current.previousDrafts.dialog?.items[0]?.onOpen();
        for (let n = 0; n < 5; n++) await Promise.resolve();
      });
      act(() => secondController.abort());
      await act(async () => { resolveOpen(lateWriter); for (let n = 0; n < 10; n++) await Promise.resolve(); });
      expect(lateWriter.dispose).toHaveBeenCalledOnce();
      expect(openFixture.current.previousDrafts.dialog).toBeNull();
    } finally { await openFixture.unmount(); }
  } finally { await fixture.unmount(); }
});
