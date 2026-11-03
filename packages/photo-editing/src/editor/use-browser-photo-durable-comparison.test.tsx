// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import type { DevelopEngine, DevelopFrame, DevelopRenderOptions } from "../develop-engine/develop-engine-client";
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

const frame = (marker: number): DevelopFrame => ({ width: 1, height: 1, rgba: new Uint8ClampedArray([marker, 0, 0, 255]) });

async function setupComparison(options: {
  render: DevelopEngine["render"];
  scopeSignal?: AbortSignal;
  isCurrent?: () => boolean;
  completeResolve?: boolean;
  retainLaterInput?: boolean;
}) {
  const token = { kind: "develop-draft" as const };
  const conflict = { kind: "develop-conflict" as const };
  const choice = { kind: "develop-choice" as const };
  const candidate = { settings: { v: 1, engine: "niho-1", exposure: 0.7 }, baseVersion: null, maskSurfaceIds: [] };
  const currentCandidate = { settings: { v: 1, engine: "niho-1", exposure: 0.1 }, baseVersion: null, maskSurfaceIds: [] };
  const comparison: PhotoLibraryDevelopConflictComparison = {
    choice, candidate, current: currentCandidate, historicalCurrent: currentCandidate, expectedRevision: 4, canAdopt: true,
  };
  let snapshot: PhotoLibraryDevelopDraftSnapshot = {
    latest: candidate, latestStage: { committed: Promise.resolve("committed") }, attempted: null,
    hasUnknownAttempt: false, hasPendingResolution: false, conflicts: [conflict], terminalReason: null,
  };
  let resolved = false;
  const resolve = vi.fn<PhotoLibraryDevelopDraftWriter["resolve"]>(async () => {
    if (!options.completeResolve) return { kind: "unknown" };
    resolved = true;
    snapshot = { latest: options.retainLaterInput ? { ...candidate, settings: { ...candidate.settings, exposure: 0.9 } } : null, latestStage: null, attempted: null, hasUnknownAttempt: false, hasPendingResolution: false, conflicts: [], terminalReason: null };
    return { kind: "resolved", revision: 4 };
  });
  const writer: PhotoLibraryDevelopDraftWriter = {
    photoId: "photo", sourceSha256: "a".repeat(64), token,
    stage: vi.fn(), save: vi.fn(), retry: vi.fn(), read: async () => snapshot,
    compare: async () => comparison, resolve, retryResolution: vi.fn(), discard: vi.fn(), dispose: vi.fn(),
  };
  const currentScope = options.isCurrent ?? (() => true);
  const port: PhotoLibraryDurableDevelopDrafts = {
    isCurrent: currentScope, subscribe: () => () => undefined, open: () => writer, reopen: async () => writer,
    list: async () => ({ items: resolved && !options.retainLaterInput ? [] : [{ token, photoId: "photo", hasLatest: true, hasUnknownAttempt: false, conflictCount: resolved ? 0 : 1 }], nextCursor: null }),
  };
  const library = { place: "cloud", durableDevelopDrafts: port, get: async () => ({ id: "photo", fileName: "海辺.jpg", contentSha256: "a".repeat(64), developSettings: currentCandidate.settings, developRevision: 4, developSettingsUpdatedAt: null }) } as unknown as PhotoLibrary;
  const host: PhotoEditingHost = {
    ...(options.scopeSignal === undefined ? {} : { scopeSignal: options.scopeSignal }),
    notifyPhotosChanged() {}, saveFile: async () => "saved", nativeFileSaveAvailable: () => false,
    isNativeViewport: () => false, isDesktopApp: () => false, isScopeCurrent: currentScope,
  };
  let current!: ReturnType<typeof useBrowserPhotoDevelop>;
  function Harness() {
    const mountedRef = useRef(true);
    const latestAccessRef = useRef({ canEdit: true, spotId: "test-context" } as BrowserPhotoAccess);
    const queryClient = useRef(new QueryClient());
    current = useBrowserPhotoDevelop({ spotId: "test-context", deviceClass: "pc", actorId: "user", mountedRef, latestAccessRef, queryClient: queryClient.current, setStatus: vi.fn(), replaceCloudPhoto: vi.fn(), markEditedPreviewPending: vi.fn() });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PhotoLibraryProvider, { library, host, children: createElement(Harness) }));
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
  current.engineRef.current = { render: options.render, dispose: vi.fn() } as unknown as DevelopEngine;
  await act(async () => {
    current.startSession({
      key: "photo", photoId: "photo", spotId: "test-context",
      input: { kind: "original", file: new File(["photo"], "海辺.jpg") },
      working: null, workSize: null,
      photo: { id: "photo", fileName: "海辺.jpg", contentSha256: "a".repeat(64) },
      settingsSource: "develop", saver: null,
    } as DevelopSession);
  });
  return {
    get current() { return current; },
    comparison,
    resolve,
    async open() {
      await act(async () => {
        current.durableRecovery.actions.find((action) => action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.check)?.onClick();
        for (let index = 0; index < 30; index += 1) await Promise.resolve();
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("renders the fixed candidate/current choice on the open canonical photo without replacing editor settings", async () => {
  const render = vi.fn(async (settings: object, _options: DevelopRenderOptions) =>
    frame((settings as { exposure: number }).exposure === 0.7 ? 7 : 1));
  const fixture = await setupComparison({ render });
  try {
    await fixture.open();
    const model = fixture.current.durableRecovery.comparison;
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls.map(([, options]) => options)).toEqual([
      expect.objectContaining({ maxDimension: 512, interactive: false }),
      expect.objectContaining({ maxDimension: 512, interactive: false }),
    ]);
    expect(model?.photoName).toBe("海辺.jpg");
    expect(model?.candidateFrame?.rgba[0]).toBe(7);
    expect(model?.currentFrame?.rgba[0]).toBe(1);
    await act(async () => { model?.onAdopt(); for (let index = 0; index < 20; index += 1) await Promise.resolve(); });
    expect(fixture.resolve).toHaveBeenCalledWith(fixture.comparison.choice, "adopt", undefined);
  } finally { await fixture.cleanup(); }
});

it("drops a late preview after scope revocation and never exposes its choice", async () => {
  const controller = new AbortController();
  let currentScope = true;
  let finishCandidate!: (value: DevelopFrame) => void;
  const render = vi.fn(async (_settings: object, _options: DevelopRenderOptions) =>
    await new Promise<DevelopFrame>((resolve) => { finishCandidate = resolve; }));
  const fixture = await setupComparison({ render, scopeSignal: controller.signal, isCurrent: () => currentScope });
  try {
    const opening = fixture.open();
    for (let index = 0; index < 30 && render.mock.calls.length === 0; index += 1) await Promise.resolve();
    currentScope = false;
    controller.abort();
    finishCandidate(frame(7));
    await opening;
    await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); });
    expect(render).toHaveBeenCalledOnce();
    expect(fixture.current.durableRecovery.comparison).toBeNull();
    expect(fixture.resolve).not.toHaveBeenCalled();
  } finally { await fixture.cleanup(); }
});


it.each([false, true])("after confirmed keep-current reloads that selected recipe only without later B (%s)", async (retainLaterInput) => {
  const render = vi.fn(async (settings: object, _options: DevelopRenderOptions) => frame((settings as { exposure: number }).exposure === 0.7 ? 7 : 1));
  const fixture = await setupComparison({ render, completeResolve: true, retainLaterInput });
  const reload = vi.fn();
  fixture.current.saveStaleHandlerRef.current = reload;
  try {
    await fixture.open();
    const model = fixture.current.durableRecovery.comparison;
    expect(model?.currentFrame?.rgba[0]).toBe(1);
    await act(async () => { model?.onKeepCurrent(); for (let index = 0; index < 30; index++) await Promise.resolve(); });
    expect(fixture.resolve).toHaveBeenCalledWith(fixture.comparison.choice, "keep-current", undefined);
    if (retainLaterInput) {
      expect(reload).not.toHaveBeenCalled();
      expect(fixture.current.durableRecovery.pending).toBe(true);
    } else {
      expect(reload).toHaveBeenCalledWith(expect.objectContaining({ id: "photo", contentSha256: "a".repeat(64), developRevision: 4, developSettings: expect.objectContaining({ exposure: 0.1 }) }));
    }
  } finally { await fixture.cleanup(); }
});
