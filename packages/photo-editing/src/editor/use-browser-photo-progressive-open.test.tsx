// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopEngine, DevelopFrame, DevelopRenderOptions } from "../develop-engine/develop-engine-client";
import { writeDevelopGeometry } from "../develop-engine/develop-geometry";
import { addDevelopHealMark } from "../develop-engine/develop-heal-editing";
import { neutralDevelopSettings, type DevelopSettings } from "../develop-engine/develop-settings";
import type { BrowserCloudPlace } from "../browser-photo-cloud-source";
import type {
  PhotoLibrary,
  PhotoLibraryCapabilities,
  PhotoLibraryPhoto,
  PhotoLibraryProvisionalDraft,
  PhotoLibraryWorkingCopyResult,
} from "../library/photo-library";
import {
  PhotoLibraryProvider,
  type PhotoEditingHost,
} from "../library/photo-library-context";

import type {
  BrowserItem,
  BrowserPhotoAccess,
  BrowserPhotoOperationKind,
  BrowserViewMode,
} from "./browser-photo-editing-model";
import { useBrowserPhotoDevelop } from "./use-browser-photo-develop";
import { useBrowserPhotoOpen, type BrowserPhotoOpen } from "./use-browser-photo-open";
import { BROWSER_PRESET_PREVIEW_FINAL_DELAY_MS } from "./use-browser-photo-presets";

const engineFactory = vi.hoisted(() => vi.fn());
const paintFrame = vi.hoisted(() => vi.fn());
/** 描いた画を右パネルのヒストグラムへ渡す口（niho-photo#36）の代わり */
const framePainted = vi.hoisted(() => vi.fn());

vi.mock("../develop-engine/develop-engine-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../develop-engine/develop-engine-client")>();
  return { ...actual, createDevelopEngine: engineFactory, photoDevelopDiagnosticsEnabled: () => false };
});

vi.mock("../develop-engine/develop-frame", () => ({ paintDevelopFrame: paintFrame }));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function frame(marker: number): DevelopFrame {
  return { width: 1, height: 1, rgba: new Uint8ClampedArray([marker, 0, 0, 255]) };
}

const CAPABILITIES: PhotoLibraryCapabilities = {
  place: "local",
  rawWorkingCopy: true,
  nativeExport: true,
  nativeExportUpdateRequired: false,
  exportFolder: false,
  nativeExportRaster: true,
  cutout: false,
  favorites: false,
  albums: false,
  articleImages: false,
  multiSelect: false,
  mobile: false,
  editedPreview: false,
  addFiles: false,
  addFromDevice: false,
  addFromDeviceFolder: false,
};

const BASE_VERSION = "raw-apple.d8.p3.e4.cal-sony-ilme-fx30-apple-v4.lens-apple";
const WORK_META = {
  kind: "raw",
  encoding: { kind: "signed-gamma18-v1", ceiling: 2 },
  dcpSha256: "apple-ciraw8/linear-prophoto-d50/cal-sony-ilme-fx30-apple-v4",
};
const HASH = "a".repeat(64);

function photo(id: string): PhotoLibraryPhoto {
  return {
    id,
    fileName: `${id}.rw2`,
    fileExtension: "rw2",
    sizeBytes: 24_000_000,
    contentSha256: HASH,
    createdAt: "2026-10-20T00:00:00.000Z",
    capturedAt: "2026-10-19T00:00:00.000Z",
    uploadedBy: null,
    hasOriginal: true,
    hasPreview: true,
    hasWebImage: false,
    hasDevelopSettings: false,
    developSettings: null,
    developSettingsUpdatedAt: null,
    developRevision: 0,
    webRenderedRevision: null,
    workStatus: "ready",
    workQueuedAt: null,
    favorite: false,
    hasEdits: false,
    editedPreview: null,
  };
}

function item(id: string): BrowserItem {
  return {
    key: `cloud:${id}`,
    photo: { ...photo(id), previewUrl: `https://example.invalid/${id}.jpg` },
    localPreviewUrl: null,
    adding: false,
  };
}

function readyWork(): PhotoLibraryWorkingCopyResult {
  return {
    kind: "ready",
    download: {
      ref: "work-ref",
      expiresAt: "2026-10-21T00:00:00.000Z",
      work: {
        baseVersion: BASE_VERSION,
        sizeBytes: 2_000,
        width: 3000,
        height: 2000,
        meta: WORK_META,
        renderedAt: "2026-10-20T00:00:00.000Z",
      },
    },
  };
}

type EngineOptions = {
  marker: number;
  ready?: boolean;
  render?: (settings: DevelopSettings, call: number) => Promise<DevelopFrame | null>;
};

function createEngine(options: EngineOptions): DevelopEngine {
  let renderCall = 0;
  const render = vi.fn((settings: DevelopSettings) => {
    renderCall += 1;
    return options.render?.(settings, renderCall) ?? Promise.resolve(frame(options.marker));
  });
  return {
    ready: vi.fn(async () => options.ready ?? true),
    open: vi.fn(async () => ({ width: 1600, height: 1067 })),
    render,
    exportJpeg: vi.fn(async () => new Uint8Array([1, 2, 3])),
    openWorkingCopy: vi.fn(async () => ({ width: 3000, height: 2000 })),
    exportWorkingCopyJpeg: vi.fn(async () => new Uint8Array([1, 2, 3])),
    convertEditSettings: vi.fn(async () => ({ ok: false, error: "unsupported" })),
    presetSettings: vi.fn(async (_xmp: string, base: object | null) => ({
      converted: true,
      name: "明るい",
      unsupported: [],
      settings: { ...(base ?? neutralDevelopSettings()), contrast: 40 },
    })),
    builtinPresets: vi.fn(async () => []),
    applyPreset: vi.fn(async (_xmp: string, base: object, amount: number) => ({
      converted: true,
      name: "明るい",
      unsupported: [],
      settings: { ...(base as DevelopSettings), contrast: Math.round(amount * 100) },
    })),
    settingsToXmp: vi.fn(async () => ({ name: "test", xmp: "<xmp />" })),
    renderPresetThumbnail: vi.fn(async () => frame(options.marker)),
    yieldToEdit: vi.fn(),
    supportsPresetAmount: vi.fn(async () => true),
    supportsSettingsToXmp: vi.fn(async () => true),
    supportsPresetThumbnails: vi.fn(async () => true),
    supportsPresetFromMeta: vi.fn(async () => true),
    autoSettings: vi.fn(async (settings: object) => settings as DevelopSettings),
    supportsAuto: vi.fn(async () => true),
    supportsGeometry: vi.fn(async () => true),
    supportsPerspective: vi.fn(async () => true),
    supportsEffects: vi.fn(async () => true),
    supportsColorPoints: vi.fn(async () => false),
    supportsDetail: vi.fn(async () => false),
    supportsHeal: vi.fn(async () => true),
    supportsLens: vi.fn(async () => true),
    imageSize: vi.fn(async () => ({ width: 3000, height: 2000 })),
    rasterDecodeSize: vi.fn(async () => 1280),
    geometryOutputSize: vi.fn(async () => ({ width: 1280, height: 853 })),
    withCaptureExif: vi.fn(async (bytes: Uint8Array<ArrayBuffer>) => bytes),
    close: vi.fn(async () => undefined),
    dispose: vi.fn(),
  } as unknown as DevelopEngine;
}

type LibraryFixture = {
  library: PhotoLibrary;
  ensureWorkingCopy: ReturnType<typeof vi.fn>;
  saveDevelopSettings: ReturnType<typeof vi.fn>;
  saveProvisionalDraft: ReturnType<typeof vi.fn>;
  signals: AbortSignal[];
};

function createLibrary(
  ensure: (photoId: string, signal: AbortSignal | undefined) => Promise<PhotoLibraryWorkingCopyResult>,
  options: { draftGateAt?: number; draftGate?: Deferred<PhotoLibraryProvisionalDraft> } = {},
): LibraryFixture {
  let draftGeneration = 0;
  const signals: AbortSignal[] = [];
  const ensureWorkingCopy = vi.fn((photoId: string, options?: { signal?: AbortSignal }) => {
    if (options?.signal) signals.push(options.signal);
    return ensure(photoId, options?.signal);
  });
  const saveDevelopSettings = vi.fn(async (photoId: string, settings: DevelopSettings) => ({
    kind: "saved" as const,
    photo: { ...photo(photoId), hasDevelopSettings: true, developSettings: settings, developRevision: 1 },
  }));
  const saveProvisionalDraft = vi.fn(async (_photoId: string, contentSha256: string, settings: DevelopSettings) => {
    const draft = {
      contentSha256,
      settings,
      generation: ++draftGeneration,
      updatedAt: "2026-10-20T00:00:00.000Z",
    };
    if (draft.generation === options.draftGateAt && options.draftGate) return options.draftGate.promise;
    return draft;
  });
  const library = {
    place: "local",
    initialCapabilities: CAPABILITIES,
    capabilities: vi.fn(async () => CAPABILITIES),
    rollout: vi.fn(async () => ({ crop: true, mobileEditing: true })),
    engineAssets: { manifestUrl: () => "/engine/manifest.json" },
    limits: { listPageSize: 100, lookupMaxCount: 100, referencesMaxCount: 100, photosPerRequest: 100 },
    errors: {
      describe: (_error: unknown, fallback: string) => fallback,
      describeStorageError: () => null,
      describeDeleteFailure: () => "delete failed",
      isNativeError: () => false,
      describeNative: () => "native failed",
      isPermanentSaveFailure: () => false,
      isNotFound: () => false,
      readQuotaExceeded: () => null,
      describeQuotaExceeded: () => "quota",
      readDevelopRevisionStale: () => null,
      isExportFolderNotFound: () => false,
    },
    list: vi.fn(async () => ({ items: [], next: null, usage: null, counts: null })),
    get: vi.fn(async (photoId: string) => ({ ...photo(photoId), previewUrl: null })),
    lookup: vi.fn(async () => []),
    openOriginal: vi.fn(async (photoId: string) => ({
      source: { ref: "original-ref", expiresAt: null },
      photo: photo(photoId),
    })),
    loadOriginal: vi.fn(async () => new File([new Uint8Array([1])], "raw.rw2")),
    ensureWorkingCopy,
    loadWorkingCopy: vi.fn(async (photoId: string) => ({
      photoId,
      baseVersion: BASE_VERSION,
      bytes: new ArrayBuffer(8),
      encoding: "png16" as const,
      metaJson: JSON.stringify(WORK_META),
    })),
    loadInteractivePreview: vi.fn(async (photoId: string) => ({
      photo: photo(photoId),
      file: new File([new Uint8Array([1, 2, 3])], "interactive.jpg", { type: "image/jpeg" }),
      width: 1600,
      height: 1067,
    })),
    loadProvisionalDraft: vi.fn(async () => null),
    saveProvisionalDraft,
    removeProvisionalDraft: vi.fn(async () => true),
    retryWorkingCopy: vi.fn(async () => ({ kind: "notFailed" as const, workStatus: "ready" as const })),
    saveDevelopSettings,
    downloadOriginal: vi.fn(async (target: PhotoLibraryPhoto) => ({
      blob: new Blob([new Uint8Array([1])]),
      fileName: target.fileName,
    })),
    delete: vi.fn(async () => ({ deleted: [], errors: [] })),
    presets: {
      list: vi.fn(async () => []),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
      nameMaxChars: 80,
      xmpMaxBytes: 1_000_000,
      describeError: (_error: unknown, fallback: string) => fallback,
      isNameTaken: () => false,
    },
  } as unknown as PhotoLibrary;
  return { library, ensureWorkingCopy, saveDevelopSettings, saveProvisionalDraft, signals };
}

const host: PhotoEditingHost = {
  notifyPhotosChanged: vi.fn(),
  saveFile: vi.fn(async () => "saved" as const),
  nativeFileSaveAvailable: () => false,
  isNativeViewport: () => false,
  isDesktopApp: () => true,
};

let container: HTMLDivElement;
let root: Root;
let current: BrowserPhotoOpen;
let currentViewMode: BrowserViewMode;
/** 補正前と補正後を見比べる 2 枚目の canvas を置く / 外す（niho-photo#41） */
let setHarnessCompare: (compare: boolean) => void = () => undefined;

function Harness(props: { library: PhotoLibrary; items: BrowserItem[] }) {
  const mountedRef = useRef(true);
  const latestAccessRef = useRef<BrowserPhotoAccess>({ canEdit: true, cloudOriginalsAllowed: true, spotId: "spot" });
  const operationRef = useRef<BrowserPhotoOperationKind | null>(null);
  const saveGenerationRef = useRef(0);
  const allItemsRef = useRef(props.items);
  allItemsRef.current = props.items;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const framePaintedRef = useRef<((key: string, frame: DevelopFrame) => void) | null>(framePainted);
  const [viewMode, setViewMode] = useState<BrowserViewMode>("grid");
  const [place, setPlace] = useState<BrowserCloudPlace>("photos");
  const [compare, setCompare] = useState(false);
  const [compareCanvas, setCompareCanvas] = useState<HTMLCanvasElement | null>(null);
  setHarnessCompare = setCompare;
  currentViewMode = viewMode;
  const queryClientRef = useRef(new QueryClient());
  const develop = useBrowserPhotoDevelop({
    spotId: "spot",
    actorId: null,
    queryClient: queryClientRef.current,
    mountedRef,
    latestAccessRef,
    setStatus: vi.fn(),
    replaceCloudPhoto: vi.fn(),
    markEditedPreviewPending: vi.fn(),
  });
  current = useBrowserPhotoOpen({
    spotId: "spot",
    canEdit: true,
    openCloudPhotoId: null,
    onOpenCloudPhotoHandled: vi.fn(),
    mountedRef,
    latestAccessRef,
    develop,
    items: {
      allItemsRef,
      place,
      setPlace,
      setSelectedKey: vi.fn(),
      setDeepLinkedPhoto: vi.fn(),
      clearFilter: vi.fn(),
    },
    refetchCloudPhotos: vi.fn(),
    replaceCloudPhoto: vi.fn(),
    viewMode,
    setViewMode,
    cropRollout: true,
    healAllowed: true,
    editingAllowed: true,
    canvasSurface: "page",
    setExportSheetOpen: vi.fn(),
    canvasRef,
    operationRef,
    busy: false,
    saveGenerationRef,
    setStatus: vi.fn(),
    onFramePaintedRef: framePaintedRef,
    compareCanvas,
  });
  return (
    <>
      <canvas ref={canvasRef} />
      {compare ? <canvas data-testid="compare-before" ref={setCompareCanvas} /> : null}
    </>
  );
}

async function mount(library: PhotoLibrary, items: BrowserItem[]) {
  await act(async () => {
    root.render(
      <PhotoLibraryProvider library={library} host={host}>
        <Harness library={library} items={items} />
      </PhotoLibraryProvider>,
    );
  });
}

async function settleUntil(predicate: () => boolean, message: string) {
  for (let index = 0; index < 40; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    if (predicate()) return;
  }
  throw new Error(`settle timeout: ${message}`);
}

async function run(action: () => void | Promise<void>) {
  await act(async () => {
    await action();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  engineFactory.mockReset();
  paintFrame.mockReset();
  framePainted.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useBrowserPhotoOpen progressive RAW integration", () => {
  it("同じ内容hashの端末draftを再表示し、canonical base確定後に既存saverへ保存する", async () => {
    const work = deferred<PhotoLibraryWorkingCopyResult>();
    engineFactory.mockImplementationOnce(() => createEngine({ marker: 1 })).mockImplementationOnce(() => createEngine({ marker: 9 }));
    const fixture = createLibrary(async () => work.promise);
    const settings = { ...neutralDevelopSettings(), exposure: 0.9, contrast: 23 };
    vi.mocked(fixture.library.loadProvisionalDraft!).mockResolvedValue({
      contentSha256: HASH, settings, generation: 12, updatedAt: "2026-10-20T00:00:00.000Z",
    });
    const target = item("restored-draft");
    await mount(fixture.library, [target]);
    let opening!: Promise<void>;
    await run(() => { opening = current.openItem(target); });
    await settleUntil(() => current.opened?.input?.kind === "provisional", "restored provisional");
    expect(fixture.library.loadProvisionalDraft).toHaveBeenCalledWith(target.photo.id, HASH);
    expect(current.settings).toMatchObject({ base: null, exposure: 0.9, contrast: 23 });
    expect(fixture.saveDevelopSettings).not.toHaveBeenCalled();
    await run(() => work.resolve(readyWork()));
    await run(async () => { await opening; });
    expect(current.settings).toMatchObject({ base: BASE_VERSION, exposure: 0.9, contrast: 23 });
    await run(async () => { expect(await current.returnToGrid()).toBe(true); });
    expect(fixture.saveDevelopSettings).toHaveBeenCalledWith(target.photo.id,
      expect.objectContaining({ base: BASE_VERSION, exposure: 0.9, contrast: 23 }), expect.anything());
  });

  it("保留中の露光・preset・amountをdraftだけへ保存し、最新値と選択/historyをcanonicalへ渡して旧engineの遅延frameを捨てる", async () => {
    const firstCanonical = deferred<DevelopFrame | null>();
    const lateProvisional = deferred<DevelopFrame | null>();
    const draftGate = deferred<PhotoLibraryProvisionalDraft>();
    let delayProvisional = false;
    const provisional = createEngine({
      marker: 1,
      render: async (settings) => {
        if (delayProvisional && Number(settings.exposure ?? 0) !== 0) return lateProvisional.promise;
        return frame(1);
      },
    });
    const canonical = createEngine({
      marker: 9,
      render: async (_settings, call) => call === 1 ? firstCanonical.promise : frame(9),
    });
    engineFactory.mockImplementationOnce(() => provisional).mockImplementationOnce(() => canonical);
    const fixture = createLibrary(async () => readyWork(), { draftGateAt: 2, draftGate });
    const target = item("one");
    await mount(fixture.library, [target]);

    let opening: Promise<void> | undefined;
    await run(() => {
      opening = current.openItem(target);
    });
    await settleUntil(() => current.opened?.input?.kind === "provisional", "provisional open");
    await settleUntil(() => vi.mocked(canonical.render).mock.calls.length === 1, "canonical render pending");
    expect(fixture.saveDevelopSettings).not.toHaveBeenCalled();

    delayProvisional = true;
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.4 }), "commit"));
    await run(() => current.presets.apply({ key: "builtin:bright", name: "明るい", xmp: "<xmp />" }));
    await run(() => current.presets.changeAmount(65, "drag"));
    await settleUntil(() => fixture.saveProvisionalDraft.mock.calls.length >= 2, "draft flush");
    await settleUntil(
      () => vi.mocked(provisional.render).mock.calls.some(([settings]) => Number((settings as DevelopSettings).exposure ?? 0) !== 0),
      "late provisional render",
    );
    expect(fixture.saveDevelopSettings).not.toHaveBeenCalled();

    await run(() => firstCanonical.resolve(frame(8)));
    await act(async () => Promise.resolve());
    expect(current.opened?.input?.kind).toBe("provisional");
    const pendingDraftSettings = fixture.saveProvisionalDraft.mock.calls[1]?.[2] as DevelopSettings;
    await run(() => draftGate.resolve({
      contentSha256: HASH,
      settings: pendingDraftSettings,
      generation: 2,
      updatedAt: "2026-10-20T00:00:00.000Z",
    }));
    await settleUntil(() => current.opened?.input?.kind === "workingCopy", "canonical handoff");
    await run(async () => {
      await opening;
    });

    const canonicalSettings = vi.mocked(canonical.render).mock.calls.at(-1)?.[0] as DevelopSettings;
    expect(canonicalSettings).toMatchObject({ base: BASE_VERSION, exposure: 0.4, contrast: 65 });
    expect(current.settings).toMatchObject({ base: BASE_VERSION, exposure: 0.4, contrast: 40 });
    expect(current.presets).toMatchObject({ appliedPresetKey: "builtin:bright", amount: 65 });
    expect(current.canUndo).toBe(true);
    expect(paintFrame).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), expect.objectContaining({ rgba: frame(9).rgba }));

    const paintsAfterSwap = paintFrame.mock.calls.length;
    await run(() => lateProvisional.resolve(frame(2)));
    expect(paintFrame.mock.calls.slice(paintsAfterSwap).some(([, painted]) => (painted as DevelopFrame).rgba[0] === 2)).toBe(false);

    await run(() => current.presets.changeAmount(65, "commit"));
    await settleUntil(() => current.presets.amount === 65 && current.presets.amountActive === false, "amount commit");
    await run(() => current.undo());
    expect(current.settings.base).toBe(BASE_VERSION);
  });

  it("未解決のpreset適用は旧engineで確定してからcanonicalへ引き継ぐ", async () => {
    const canonicalFrame = deferred<DevelopFrame | null>();
    const presetResult = deferred<void>();
    const provisional = createEngine({ marker: 1 });
    vi.mocked(provisional.presetSettings).mockImplementation(async (_xmp, base) => {
      await presetResult.promise;
      return { converted: true, name: "明るい", unsupported: [], settings: { ...neutralDevelopSettings(), ...base, contrast: 40 } };
    });
    const canonical = createEngine({ marker: 9, render: async (_settings, call) => call === 1 ? canonicalFrame.promise : frame(9) });
    engineFactory.mockImplementationOnce(() => provisional).mockImplementationOnce(() => canonical);
    const fixture = createLibrary(async () => readyWork());
    const target = item("pending-preset");
    await mount(fixture.library, [target]);
    await run(() => { void current.openItem(target); });
    await settleUntil(() => vi.mocked(canonical.render).mock.calls.length === 1, "canonical frame");
    let applying: Promise<void> | undefined;
    await run(() => { applying = current.presets.apply({ key: "builtin:bright", name: "明るい", xmp: "<xmp />" }); });
    await run(() => canonicalFrame.resolve(frame(8)));
    expect(current.opened?.input?.kind).toBe("provisional");
    expect(provisional.dispose).not.toHaveBeenCalled();
    await run(() => presetResult.resolve(undefined));
    await run(async () => { await applying; });
    await settleUntil(() => current.opened?.input?.kind === "workingCopy", "pending preset handoff");
    expect(current.settings).toMatchObject({ base: BASE_VERSION, engine: "niho-11", contrast: 40 });
    expect(current.presets.appliedPresetKey).toBe("builtin:bright");
    expect(current.canUndo).toBe(true);
  });

  it.each(["drag", "commit"] as const)("未解決の適用量 %s もcanonical切替で捨てない", async (phase) => {
    const canonicalFrame = deferred<DevelopFrame | null>();
    const amountResult = deferred<void>();
    const provisional = createEngine({ marker: 1 });
    vi.mocked(provisional.applyPreset).mockImplementation(async (_xmp, base, amount) => {
      await amountResult.promise;
      return { converted: true, name: "明るい", unsupported: [], settings: { ...(base as DevelopSettings), contrast: Math.round(amount * 100) } };
    });
    const canonical = createEngine({ marker: 9, render: async (_settings, call) => call === 1 ? canonicalFrame.promise : frame(9) });
    engineFactory.mockImplementationOnce(() => provisional).mockImplementationOnce(() => canonical);
    const fixture = createLibrary(async () => readyWork());
    const target = item(`pending-amount-${phase}`);
    await mount(fixture.library, [target]);
    await run(() => { void current.openItem(target); });
    await settleUntil(() => vi.mocked(canonical.render).mock.calls.length === 1, "canonical frame");
    await run(() => current.presets.apply({ key: "builtin:bright", name: "明るい", xmp: "<xmp />" }));
    await run(() => current.presets.changeAmount(65, phase));
    await run(() => canonicalFrame.resolve(frame(8)));
    expect(current.opened?.input?.kind).toBe("provisional");
    await run(() => amountResult.resolve(undefined));
    await settleUntil(() => current.opened?.input?.kind === "workingCopy", "pending amount handoff");
    const shown = vi.mocked(canonical.render).mock.calls.at(-1)?.[0] as DevelopSettings;
    expect(shown).toMatchObject({ base: BASE_VERSION, contrast: 65 });
    expect(current.presets).toMatchObject({ amount: 65, amountActive: phase === "drag", appliedPresetKey: "builtin:bright" });
    if (phase === "drag") await run(() => current.presets.changeAmount(65, "commit"));
    await settleUntil(() => current.presets.amountActive === false, "amount commit");
    expect(current.settings).toMatchObject({ base: BASE_VERSION, contrast: 65 });
    await run(() => current.undo());
    expect(current.settings).toMatchObject({ base: BASE_VERSION, contrast: 40 });
  });

  it("canvas に描いた画を、写真の key と一緒にヒストグラムの口へ渡す（仮の画 → canonical の画の差し替え・補正前の画も）", async () => {
    const firstCanonical = deferred<DevelopFrame | null>();
    const provisional = createEngine({ marker: 1 });
    const canonical = createEngine({
      marker: 9,
      render: async (_settings, call) => call === 1 ? firstCanonical.promise : frame(9),
    });
    engineFactory.mockImplementationOnce(() => provisional).mockImplementationOnce(() => canonical);
    const fixture = createLibrary(async () => readyWork());
    const target = item("histogram");
    await mount(fixture.library, [target]);

    await run(() => {
      void current.openItem(target);
    });
    await settleUntil(() => current.opened?.input?.kind === "provisional", "provisional open");
    await settleUntil(() => framePainted.mock.calls.length > 0, "provisional frame painted");
    // 仮の画も、描いた画として渡す（canvas に描いたのと同じ画・同じ key）
    expect(framePainted.mock.calls[0]?.[0]).toBe(target.key);
    expect((framePainted.mock.calls[0]?.[1] as DevelopFrame).rgba[0]).toBe(1);

    await run(() => firstCanonical.resolve(frame(8)));
    await settleUntil(() => current.opened?.input?.kind === "workingCopy", "canonical handoff");
    expect(framePainted).toHaveBeenLastCalledWith(target.key, expect.objectContaining({ rgba: frame(8).rgba }));
    // 渡した回数は canvas に描いた回数と同じ（描いていない画は渡さない）
    expect(framePainted).toHaveBeenCalledTimes(paintFrame.mock.calls.length);

    // 補正前を押している間は、補正前の画を渡す
    await run(() => current.setCompareOriginal(true));
    await settleUntil(() => paintFrame.mock.calls.length === framePainted.mock.calls.length && framePainted.mock.calls.length > 2, "compare frame painted");
    const comparing = framePainted.mock.calls.at(-1);
    expect(comparing?.[0]).toBe(target.key);
    expect(comparing?.[1]).toBe(paintFrame.mock.calls.at(-1)?.[1]);
  });

  it("比較の間は補正前の画を 2 枚目の canvas に 1 回だけ描き、色を動かしても描き直さない。ヒストグラムの口には渡さない（niho-photo#41）", async () => {
    const canonical = createEngine({ marker: 9 });
    // 補正前（background の描画）は 5、補正後は 9 の画
    vi.mocked(canonical.render).mockImplementation(async (_settings, options) => frame(options.priority === "background" ? 5 : 9));
    engineFactory.mockReturnValue(canonical);
    const fixture = createLibrary(async () => readyWork());
    vi.mocked(fixture.library.loadInteractivePreview!).mockRejectedValue(new Error("preview unavailable"));
    const target = item("compare-view");
    await mount(fixture.library, [target]);
    await run(() => current.openItem(target));
    expect(current.opened?.input?.kind).toBe("workingCopy");
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.4 }), "commit"));

    const beforeRenders = () =>
      vi.mocked(canonical.render).mock.calls.filter(([, options]) => options.priority === "background");
    const compareCanvas = () => container.querySelector<HTMLCanvasElement>('[data-testid="compare-before"]');
    const beforePaints = () => paintFrame.mock.calls.filter(([canvas]) => canvas === compareCanvas());
    expect(beforeRenders()).toHaveLength(0);

    await run(() => setHarnessCompare(true));
    await settleUntil(() => beforePaints().length === 1, "before painted");
    expect(beforeRenders()).toHaveLength(1);
    // 切り抜いた枠のまま色だけ補正前（露光は 0）。編集の描画の「次」を取り合わない優先度
    expect(beforeRenders()[0]?.[0]).toMatchObject({ base: BASE_VERSION, exposure: 0 });
    expect(beforeRenders()[0]?.[1]).toMatchObject({ interactive: false, priority: "background" });
    expect((beforePaints()[0]?.[1] as DevelopFrame).rgba[0]).toBe(5);
    // 補正後の canvas には補正前を描かない
    expect(paintFrame.mock.calls.some(([canvas, painted]) => canvas !== compareCanvas() && (painted as DevelopFrame).rgba[0] === 5)).toBe(false);

    // 比較の間に補正を動かすと補正後の側だけが変わる（補正前は描き直さない）
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.6 }), "drag"));
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.7, contrast: 12 }), "commit"));
    await settleUntil(
      () => vi.mocked(canonical.render).mock.calls.some(([settings]) => (settings as DevelopSettings).contrast === 12),
      "after rendered",
    );
    await act(async () => Promise.resolve());
    expect(beforeRenders()).toHaveLength(1);
    expect(beforePaints()).toHaveLength(1);
    // ヒストグラムの口に渡すのは補正後の画だけ
    expect(framePainted.mock.calls.length).toBeGreaterThan(0);
    expect(framePainted.mock.calls.some(([, painted]) => (painted as DevelopFrame).rgba[0] === 5)).toBe(false);

    // 閉じて開き直しても、同じ補正前の画（覚えている画）を描くだけ
    await run(() => setHarnessCompare(false));
    await run(() => setHarnessCompare(true));
    await settleUntil(() => beforePaints().length === 1, "before repainted");
    expect(beforeRenders()).toHaveLength(1);
  });

  it("比較の間に段階 open の canonical へ替わったら、補正前の画も canonical で描き直す（niho-photo#41）", async () => {
    const firstCanonical = deferred<DevelopFrame | null>();
    const provisional = createEngine({ marker: 1 });
    vi.mocked(provisional.render).mockImplementation(async (_settings, options) => frame(options.priority === "background" ? 2 : 1));
    const canonical = createEngine({ marker: 9 });
    let canonicalCalls = 0;
    vi.mocked(canonical.render).mockImplementation(async (_settings, options) => {
      canonicalCalls += 1;
      if (canonicalCalls === 1) return firstCanonical.promise;
      return frame(options.priority === "background" ? 8 : 9);
    });
    engineFactory.mockImplementationOnce(() => provisional).mockImplementationOnce(() => canonical);
    const fixture = createLibrary(async () => readyWork());
    const target = item("compare-handoff");
    await mount(fixture.library, [target]);
    await run(() => {
      void current.openItem(target);
    });
    await settleUntil(() => current.opened?.input?.kind === "provisional", "provisional open");
    const compareCanvas = () => container.querySelector<HTMLCanvasElement>('[data-testid="compare-before"]');
    const lastBeforePaint = () => paintFrame.mock.calls.filter(([canvas]) => canvas === compareCanvas()).at(-1);

    await run(() => setHarnessCompare(true));
    await settleUntil(() => lastBeforePaint() !== undefined, "provisional before painted");
    expect((lastBeforePaint()?.[1] as DevelopFrame).rgba[0]).toBe(2);
    expect(vi.mocked(provisional.render).mock.calls.at(-1)?.[1]).toMatchObject({ interactive: true, priority: "background" });

    await run(() => firstCanonical.resolve(frame(7)));
    await settleUntil(() => current.opened?.input?.kind === "workingCopy", "canonical handoff");
    await settleUntil(() => (lastBeforePaint()?.[1] as DevelopFrame | undefined)?.rgba[0] === 8, "canonical before painted");
    const canonicalBefore = vi.mocked(canonical.render).mock.calls.find(([, options]) => options.priority === "background");
    expect(canonicalBefore?.[0]).toMatchObject({ base: BASE_VERSION });
    expect(framePainted.mock.calls.some(([, painted]) => [2, 8].includes((painted as DevelopFrame).rgba[0] ?? 0))).toBe(false);
  });

  it("暫定previewを取得できないRAWも正規入力で開き、補正と通常保存を続ける", async () => {
    const canonical = createEngine({ marker: 9 });
    engineFactory.mockReturnValue(canonical);
    const fixture = createLibrary(async () => readyWork());
    vi.mocked(fixture.library.loadInteractivePreview!).mockRejectedValue(new Error("preview unavailable"));
    const target = item("fallback");
    await mount(fixture.library, [target]);
    await run(() => current.openItem(target));
    expect(current.opened?.input?.kind).toBe("workingCopy");
    expect(current.settings).toMatchObject({ engine: "niho-11", base: BASE_VERSION });
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.4 }), "commit"));
    expect(current.settings.exposure).toBe(0.4);
    expect(fixture.saveProvisionalDraft).not.toHaveBeenCalled();
    await run(async () => { expect(await current.returnToGrid()).toBe(true); });
    expect(fixture.saveDevelopSettings).toHaveBeenCalledWith(
      target.photo.id, expect.objectContaining({ exposure: 0.4, base: BASE_VERSION }), expect.any(Object),
    );
  });

  it("canonical待ちのcrop操作とundoを実hookで処理し、crop表示をcanonical engineで描いてactive/historyを保つ", async () => {
    const canonicalFrame = deferred<DevelopFrame | null>();
    const provisional = createEngine({ marker: 1 });
    const canonical = createEngine({
      marker: 9,
      render: async (_settings, call) => call === 1 ? canonicalFrame.promise : frame(9),
    });
    engineFactory.mockImplementationOnce(() => provisional).mockImplementationOnce(() => canonical);
    const fixture = createLibrary(async () => readyWork());
    const target = item("crop");
    await mount(fixture.library, [target]);

    await run(() => {
      void current.openItem(target);
    });
    await settleUntil(() => current.opened?.input?.kind === "provisional" && current.crop.available, "crop available");
    await settleUntil(() => vi.mocked(canonical.render).mock.calls.length === 1, "canonical render pending");
    await run(() => current.crop.enter());
    await settleUntil(() => current.crop.active, "crop active");
    const geometry = {
      rotate: 0 as const,
      flipH: false,
      flipV: false,
      angle: 0,
      crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
      aspect: "free",
    };
    await run(() => current.crop.commit(geometry));
    await run(() => current.undo());
    await run(() => current.crop.commit(geometry));
    expect(current.settings.geometry).toBeDefined();

    await run(() => canonicalFrame.resolve(frame(8)));
    await settleUntil(() => current.opened?.input?.kind === "workingCopy", "crop handoff");
    const rendered = vi.mocked(canonical.render).mock.calls.at(-1)?.[0] as DevelopSettings;
    expect(rendered.base).toBe(BASE_VERSION);
    expect(rendered.geometry).toBeUndefined();
    expect(current.settings).toMatchObject({ base: BASE_VERSION, geometry });
    expect(current.crop.active).toBe(true);
    expect(current.canUndo).toBe(true);
  });

  it("canonical失敗から同じprovisional編集を保って再試行できる", async () => {
    const provisional = createEngine({ marker: 1 });
    const failedCanonical = createEngine({ marker: 7, ready: false });
    const retryCanonical = createEngine({ marker: 9 });
    engineFactory
      .mockImplementationOnce(() => provisional)
      .mockImplementationOnce(() => failedCanonical)
      .mockImplementationOnce(() => retryCanonical);
    const fixture = createLibrary(async () => readyWork());
    const target = item("retry");
    await mount(fixture.library, [target]);

    await run(() => current.openItem(target));
    await settleUntil(
      () => current.opened?.input?.kind === "provisional" && current.opened?.canonicalPending === false,
      "canonical fail",
    );
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.7 }), "commit"));
    expect(current.settings.exposure).toBe(0.7);
    await run(() => current.retryCanonical());
    await settleUntil(() => current.opened?.input?.kind === "workingCopy", "canonical retry");
    expect(current.settings).toMatchObject({ base: BASE_VERSION, exposure: 0.7 });
    expect(current.canUndo).toBe(true);
  });

  it("修復の道具（niho-photo#44）は仮の入力の間は出さず、正式な入力で幾何を外した画（色・印は当てる）を描き、抜けると幾何のある画に戻る", async () => {
    const firstCanonical = deferred<DevelopFrame | null>();
    const provisional = createEngine({ marker: 1 });
    const canonical = createEngine({
      marker: 9,
      render: async (_settings, call) => call === 1 ? firstCanonical.promise : frame(9),
    });
    engineFactory.mockImplementationOnce(() => provisional).mockImplementationOnce(() => canonical);
    const fixture = createLibrary(async () => readyWork());
    const target = item("heal");
    await mount(fixture.library, [target]);
    await run(() => {
      void current.openItem(target);
    });
    await settleUntil(() => current.opened?.input?.kind === "provisional", "provisional open");
    await act(async () => Promise.resolve());
    expect(current.heal.available).toBe(false);

    await run(() => firstCanonical.resolve(frame(8)));
    await settleUntil(() => current.opened?.input?.kind === "workingCopy" && current.heal.available, "heal available");
    const geometry = {
      rotate: 90 as const,
      flipH: true,
      flipV: false,
      angle: 3,
      crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
    };
    await run(() =>
      current.changeSettings((settings) => writeDevelopGeometry({ ...(settings as DevelopSettings), exposure: 0.5 }, geometry), "commit"),
    );
    const lastRender = () => vi.mocked(canonical.render).mock.calls.at(-1)?.[0] as DevelopSettings;
    await settleUntil(() => lastRender().geometry !== undefined, "edited render");

    await run(() => current.heal.enter());
    await settleUntil(() => current.heal.ready, "heal frame painted");
    // 幾何を全部外し、色は当てる（ポインタの位置 = 印の座標）
    expect(lastRender().geometry).toBeUndefined();
    expect(lastRender().exposure).toBe(0.5);
    expect(framePainted).toHaveBeenLastCalledWith(target.key, expect.objectContaining({ rgba: frame(9).rgba }));

    await run(() => {
      current.heal.addMark(
        [
          [0.2, 0.3],
          [0.4, 0.3],
        ],
        { width: 3000, height: 2000 },
      );
    });
    expect(current.canUndo).toBe(true);
    await settleUntil(() => Array.isArray(lastRender().heal), "healed render");
    expect(lastRender().geometry).toBeUndefined();
    expect(lastRender().v).toBe(8);
    await settleUntil(() => current.heal.paintedMarks.size === 1, "mark painted");
    // 編集内容の幾何はそのまま
    expect(current.settings).toMatchObject({ geometry: expect.objectContaining({ rotate: 90, angle: 3 }) });

    await run(() => current.heal.leave());
    await settleUntil(() => lastRender().geometry !== undefined, "geometry render");
    expect(Array.isArray(lastRender().heal)).toBe(true);
    // 取り消すと印も消える
    await run(() => current.undo());
    expect(current.settings.heal).toBeUndefined();
  });

  it("「補正前」と比較の補正前は、修復の印を外して描く（幾何は保つ。niho-photo#44）", async () => {
    const canonical = createEngine({ marker: 9 });
    engineFactory.mockReturnValue(canonical);
    const fixture = createLibrary(async () => readyWork());
    vi.mocked(fixture.library.loadInteractivePreview!).mockRejectedValue(new Error("preview unavailable"));
    const target = item("heal-before");
    await mount(fixture.library, [target]);
    await run(() => current.openItem(target));
    await run(() =>
      current.changeSettings(
        (settings) =>
          addDevelopHealMark(
            writeDevelopGeometry(settings as DevelopSettings, {
              rotate: 90,
              flipH: false,
              flipV: false,
              angle: 0,
              crop: { left: 0, top: 0, right: 1, bottom: 1 },
            }),
            { id: "h1", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.5, 0.5]] },
          ),
        "commit",
      ),
    );
    expect(current.settings.heal).toBeDefined();
    // 比較の補正前（2 枚目の canvas。background の描画は 5 の画）
    vi.mocked(canonical.render).mockImplementation(async (_settings, options) => frame(options.priority === "background" ? 5 : 9));
    const compareCanvas = () => container.querySelector<HTMLCanvasElement>('[data-testid="compare-before"]');
    await run(() => setHarnessCompare(true));
    await settleUntil(() => paintFrame.mock.calls.some(([canvas]) => canvas === compareCanvas()), "compare before painted");
    const compareBefore = vi.mocked(canonical.render).mock.calls.find(([, options]) => options.priority === "background")?.[0];
    expect((compareBefore as DevelopSettings).heal).toBeUndefined();
    expect((compareBefore as DevelopSettings).geometry).toMatchObject({ rotate: 90 });
    expect((compareBefore as DevelopSettings).v).toBe(2);
    await run(() => setHarnessCompare(false));

    // 「補正前」（押している間）も同じ設定（印を外し、幾何は保つ）なので、覚えている補正前の画をそのまま描く
    const rendersBefore = vi.mocked(canonical.render).mock.calls.length;
    await run(() => current.setCompareOriginal(true));
    await settleUntil(() => (paintFrame.mock.calls.at(-1)?.[1] as DevelopFrame | undefined)?.rgba[0] === 5, "before painted");
    expect(vi.mocked(canonical.render).mock.calls.length).toBe(rendersBefore);
  });

  it("写真切替で前のpreview/canonical生成をabortし、遅れて返った結果を開かない", async () => {
    const firstWork = deferred<PhotoLibraryWorkingCopyResult>();
    const provisional = createEngine({ marker: 1 });
    const staleCanonical = createEngine({ marker: 8 });
    const secondCanonical = createEngine({ marker: 9 });
    engineFactory
      .mockImplementationOnce(() => provisional)
      .mockImplementationOnce(() => staleCanonical)
      .mockImplementationOnce(() => secondCanonical);
    const fixture = createLibrary(async (photoId) => photoId === "first" ? firstWork.promise : readyWork());
    const first = item("first");
    const second = item("second");
    await mount(fixture.library, [first, second]);

    await run(() => {
      void current.openItem(first);
    });
    await settleUntil(
      () => current.opened?.key === first.key && current.opened?.input?.kind === "provisional",
      "first provisional",
    );
    await run(() => {
      void current.openItem(second);
    });
    await settleUntil(() => current.opened?.key === second.key, "second selected");
    expect(fixture.signals.some((signal) => signal.aborted)).toBe(true);
    await run(() => firstWork.resolve(readyWork()));
    await settleUntil(() => currentViewMode === "loupe", "second remains open");
    expect(current.opened?.key).toBe(second.key);
  });
});

describe("useBrowserPhotoOpen の描いた順（つまみを動かしている間の途中の画）", () => {
  type HeldRender = { settings: DevelopSettings; options: DevelopRenderOptions; result: Deferred<DevelopFrame | null> };

  const mainCanvas = () => container.querySelector<HTMLCanvasElement>("canvas:not([data-testid])");
  /** 1 枚の表示の canvas に描いた画の印（`frame(marker)` の marker）を描いた順に */
  const mainPaints = () =>
    paintFrame.mock.calls.filter(([canvas]) => canvas === mainCanvas()).map(([, painted]) => (painted as DevelopFrame).rgba[0]);
  const sleep = (ms: number) => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

  /**
   * 正式な入力（作業コピー）で開き、開いた画を描き終えた後の描画（比較の 2 枚目の background を除く）を手で返せるエンジン。
   * `editedPreview` は、保存済みの同じ版の補正後のプレビューを見せて開く（開くだけでは描かない）
   */
  async function openHeld(id: string, options: { editedPreview?: boolean } = {}) {
    const engine = createEngine({ marker: 9 });
    const held: HeldRender[] = [];
    let holding = options.editedPreview === true;
    vi.mocked(engine.render).mockImplementation(async (settings, renderOptions) => {
      if (!holding || renderOptions.priority === "background") return frame(9);
      const result = deferred<DevelopFrame | null>();
      held.push({ settings: settings as DevelopSettings, options: renderOptions, result });
      return result.promise;
    });
    engineFactory.mockReturnValue(engine);
    const fixture = createLibrary(async () => readyWork());
    vi.mocked(fixture.library.loadInteractivePreview!).mockRejectedValue(new Error("preview unavailable"));
    const base = item(id);
    let target = base;
    if (options.editedPreview) {
      const edited = { revision: 0, width: 1280, height: 853, url: `https://example.invalid/${id}-edited.jpg`, thumbUrl: null };
      target = { ...base, photo: { ...base.photo, editedPreview: edited } };
      vi.mocked(fixture.library.openOriginal).mockImplementation(async (photoId: string) => ({
        source: { ref: "original-ref", expiresAt: null },
        photo: { ...photo(photoId), editedPreview: edited },
      }));
    }
    await mount(fixture.library, [target]);
    await run(() => current.openItem(target));
    expect(current.opened?.input?.kind).toBe("workingCopy");
    if (!options.editedPreview) await settleUntil(() => mainPaints().length > 0, "opened frame painted");
    holding = true;
    return { engine, held, target };
  }

  it("つまみを動かしている間は、描き終えた途中の画を古い順に描き、後の要求に追い越された古い画は描かない", async () => {
    const { held } = await openHeld("drag-progress");
    const before = mainPaints().length;
    const drag = (exposure: number) => run(() => current.changeSettings((settings) => ({ ...settings, exposure }), "drag"));
    await drag(0.1);
    await drag(0.2);
    await drag(0.3);
    expect(held.map(({ settings, options }) => [settings.exposure, options.interactive])).toEqual([
      [0.1, true],
      [0.2, true],
      [0.3, true],
    ]);

    // 操作が描画より速くても（まだ新しい要求がある）、描き終えた途中の画を描く（最新の要求だけを描くと、離すまで 1 枚も描けない）
    await run(() => held[0]!.result.resolve(frame(11)));
    expect(mainPaints().slice(before)).toEqual([11]);
    await drag(0.4);
    await run(() => held[1]!.result.resolve(frame(12)));
    expect(mainPaints().slice(before)).toEqual([11, 12]);
    // 後から出した要求（0.4）が先に描き終えたら、それより古い要求（0.3）の画は後から返っても描かない（描いた順を戻さない）
    await run(() => held[3]!.result.resolve(frame(14)));
    await run(() => held[2]!.result.resolve(frame(13)));
    expect(mainPaints().slice(before)).toEqual([11, 12, 14]);
    // 描いた画だけをヒストグラムの口へ渡す
    expect(framePainted.mock.calls.slice(-3).map(([, painted]) => (painted as DevelopFrame).rgba[0])).toEqual([11, 12, 14]);
    expect(framePainted).toHaveBeenCalledTimes(paintFrame.mock.calls.length);
  });

  it("離したら丁寧な画を最後に描き、途中の速い画は丁寧な画として覚えない", async () => {
    const { held } = await openHeld("drag-release");
    const before = mainPaints().length;
    const drag = (exposure: number) => run(() => current.changeSettings((settings) => ({ ...settings, exposure }), "drag"));
    await drag(0.1);
    await drag(0.2);
    await run(() => held[0]!.result.resolve(frame(21)));
    await drag(0.1);
    await run(() => held[1]!.result.resolve(frame(22)));
    // 0.1 で離す（描き途中の 0.1 の速い画がある）
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.1 }), "commit"));
    expect(held.map(({ settings, options }) => [settings.exposure, options.interactive])).toEqual([
      [0.1, true],
      [0.2, true],
      [0.1, true],
      [0.1, false],
    ]);
    // 離す前に出した速い画は、離した後に描き終えても描く（丁寧な画より古い要求だが、まだ描いた画より新しい）
    await run(() => held[2]!.result.resolve(frame(23)));
    await run(() => held[3]!.result.resolve(frame(31)));
    expect(mainPaints().slice(before)).toEqual([21, 22, 23, 31]);

    // 覚えているのは丁寧な画（31）: 別の値を確定してから取り消すと、wasm に描かせずにその画を描き、描き途中の画は描かない
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.6 }), "commit"));
    expect(held).toHaveLength(5);
    await run(() => current.undo());
    expect(current.settings.exposure).toBe(0.1);
    expect(held).toHaveLength(5);
    expect(mainPaints().at(-1)).toBe(31);
    await run(() => held[4]!.result.resolve(frame(40)));
    expect(mainPaints().slice(before)).toEqual([21, 22, 23, 31, 31]);
  });

  it("途中の速い画で丁寧な画の覚えを汚さない（同じ設定で離したら丁寧に描き直す）", async () => {
    const { held } = await openHeld("drag-cache");
    const before = mainPaints().length;
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.3 }), "drag"));
    await run(() => held[0]!.result.resolve(frame(51)));
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.3 }), "commit"));
    // 0.3 の速い画（51）は描いたが覚えていない: 離したら丁寧な画を描かせる
    expect(held.map(({ options }) => options.interactive)).toEqual([true, false]);
    await run(() => held[1]!.result.resolve(frame(52)));
    expect(mainPaints().slice(before)).toEqual([51, 52]);
  });

  it("覚えている画へ戻した（取り消した・つまみを元の値へ戻した）ら、進行中の古い描画を描かない", async () => {
    const { held } = await openHeld("undo-cache");
    const before = mainPaints().length;
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.5 }), "commit"));
    await run(() => current.undo());
    // 開いたときの丁寧な画（9）を描き直す
    expect(mainPaints().slice(before)).toEqual([9]);
    await run(() => held[0]!.result.resolve(frame(15)));
    expect(mainPaints().slice(before)).toEqual([9]);

    // つまみを動かしている途中で、覚えている画の値に戻した
    const opened = current.settings.exposure;
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.2 }), "drag"));
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: opened }), "drag"));
    expect(held).toHaveLength(2);
    expect(mainPaints().slice(before)).toEqual([9, 9]);
    await run(() => held[1]!.result.resolve(frame(16)));
    expect(mainPaints().slice(before)).toEqual([9, 9]);
    // その後に動かした分は、また途中の画を描く
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.3 }), "drag"));
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.4 }), "drag"));
    await run(() => held[2]!.result.resolve(frame(17)));
    expect(mainPaints().slice(before)).toEqual([9, 9, 17]);
  });

  it("保存済みの同じ版のプレビューを見せている間に元へ戻したら、進行中の古い描画を描かない", async () => {
    const { held } = await openHeld("undo-saved-preview", { editedPreview: true });
    expect(current.opened?.previewPending).toBe(true);
    expect(current.opened?.previewCurrent).toBe(true);
    // 開いただけでは描かない（保存済みの同じ版の補正後のプレビューのまま）
    expect(held).toHaveLength(0);
    expect(mainPaints()).toEqual([]);
    const opened = current.settings.exposure;

    // 動かしてから元の値へ戻す（ドラッグの途中）
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.3 }), "drag"));
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: opened }), "drag"));
    expect(held).toHaveLength(1);
    await run(() => held[0]!.result.resolve(frame(61)));
    expect(mainPaints()).toEqual([]);
    expect(current.opened?.previewPending).toBe(true);
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: opened }), "commit"));

    // 確定してから取り消す
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.5 }), "commit"));
    expect(held).toHaveLength(2);
    await run(() => current.undo());
    expect(current.settings.exposure).toBe(opened);
    expect(held).toHaveLength(2);
    await run(() => held[1]!.result.resolve(frame(62)));
    expect(mainPaints()).toEqual([]);
    expect(current.opened?.previewPending).toBe(true);
  });

  it("「補正前」を押している間は、押す前の途中の画を描かない（離した後はまた途中の画を描く）", async () => {
    const { held } = await openHeld("compare-original");
    const before = mainPaints().length;
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.2 }), "drag"));
    await run(() => current.setCompareOriginal(true));
    expect(held).toHaveLength(2);
    expect(held[1]!.settings.exposure ?? 0).toBe(0);
    await run(() => held[0]!.result.resolve(frame(71)));
    expect(mainPaints().slice(before)).toEqual([]);
    await run(() => held[1]!.result.resolve(frame(5)));
    expect(mainPaints().slice(before)).toEqual([5]);
    await run(() => current.setCompareOriginal(false));
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.3 }), "drag"));
    expect(held.slice(2).map(({ options }) => options.interactive)).toEqual([true, true]);
    await run(() => held[2]!.result.resolve(frame(72)));
    expect(mainPaints().slice(before)).toEqual([5, 72]);
    await run(() => held[3]!.result.resolve(frame(73)));
    expect(mainPaints().slice(before)).toEqual([5, 72, 73]);
  });

  it("切り抜きの道具に入ったら、入る前の途中の画・丁寧な画を描かない。道具の中でつまみを動かす間は途中の画を描く", async () => {
    const { held } = await openHeld("crop-tool");
    const before = mainPaints().length;
    await settleUntil(() => current.crop.available, "crop available");
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.3 }), "drag"));
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.3 }), "commit"));
    expect(held).toHaveLength(2);
    await run(() => current.crop.enter());
    await settleUntil(() => current.crop.active && held.length === 3, "crop frame requested");
    await run(() => held[0]!.result.resolve(frame(74)));
    await run(() => held[1]!.result.resolve(frame(75)));
    expect(mainPaints().slice(before)).toEqual([]);
    await run(() => held[2]!.result.resolve(frame(81)));
    expect(mainPaints().slice(before)).toEqual([81]);

    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.4 }), "drag"));
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.5 }), "drag"));
    expect(held.slice(3).map(({ options }) => options.interactive)).toEqual([true, true]);
    await run(() => held[3]!.result.resolve(frame(82)));
    expect(mainPaints().slice(before)).toEqual([81, 82]);
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.5 }), "commit"));
    expect(held[5]!.options.interactive).toBe(false);
    await run(() => held[4]!.result.resolve(frame(83)));
    await run(() => held[5]!.result.resolve(frame(84)));
    expect(mainPaints().slice(before)).toEqual([81, 82, 83, 84]);
  });

  it("修復の道具に入ったら、入る前の途中の画・丁寧な画を描かない", async () => {
    const { held, target } = await openHeld("heal-tool");
    await settleUntil(() => current.heal.available, "heal available");
    const before = mainPaints().length;
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.6 }), "drag"));
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.6 }), "commit"));
    expect(held).toHaveLength(2);
    await run(() => current.heal.enter());
    await settleUntil(() => held.length === 3, "heal frame requested");
    await run(() => held[0]!.result.resolve(frame(91)));
    await run(() => held[1]!.result.resolve(frame(92)));
    expect(mainPaints().slice(before)).toEqual([]);
    await run(() => held[2]!.result.resolve(frame(93)));
    expect(mainPaints().slice(before)).toEqual([93]);
    expect(framePainted).toHaveBeenLastCalledWith(target.key, expect.objectContaining({ rgba: frame(93).rgba }));
    expect(current.heal.ready).toBe(true);
  });

  /** プリセットごとに違う結果（「暗い」はコントラスト −30、ほかは 40）にする（同じ結果だと、覚えた画がほかのプリセットにも当たる）。 */
  const distinctPresets = (engine: DevelopEngine) => {
    vi.mocked(engine.presetSettings).mockImplementation(async (xmp: string, base: object | null) => ({
      converted: true,
      name: xmp.includes("dark") ? "暗い" : "明るい",
      unsupported: [],
      settings: { ...((base as DevelopSettings | null) ?? neutralDevelopSettings()), contrast: xmp.includes("dark") ? -30 : 40 },
    }));
  };

  it("行に載せたプリセットの仮の表示は、粗い画を先に出して止まっていれば丁寧な画に差し替え、前の仮の表示・補正の描き途中の画を描かない。押したら粗い画→丁寧な画。適用量を動かす間は途中の画を描く（#127）", async () => {
    const { engine, held } = await openHeld("preview");
    distinctPresets(engine);
    const before = mainPaints().length;
    const bright = { key: "builtin:bright", name: "明るい", xmp: "<xmp />" };
    const dark = { key: "builtin:dark", name: "暗い", xmp: "<xmp dark />" };
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.2 }), "commit"));
    expect(held).toHaveLength(1);
    await run(() => current.presets.requestPreview(bright));
    await sleep(200);
    await settleUntil(() => held.length === 2, "bright preview requested");
    // 載せている行を替えたら、前の行の丁寧な画は出さない
    await run(() => current.presets.requestPreview(dark));
    await sleep(200);
    await settleUntil(() => held.length === 3, "dark preview requested");
    // 仮の表示は粗い画から
    expect(held.slice(1).map(({ options }) => [options.maxDimension, options.interactive])).toEqual([
      [640, true],
      [640, true],
    ]);
    await run(() => held[0]!.result.resolve(frame(101)));
    await run(() => held[1]!.result.resolve(frame(102)));
    expect(mainPaints().slice(before)).toEqual([]);
    await run(() => held[2]!.result.resolve(frame(103)));
    expect(mainPaints().slice(before)).toEqual([103]);
    // 止まったままなら丁寧な画に差し替える
    await sleep(BROWSER_PRESET_PREVIEW_FINAL_DELAY_MS + 50);
    await settleUntil(() => held.length === 4, "dark final requested");
    expect(held[3]!.options.maxDimension).toBe(1280);
    expect(held.map(({ settings, options }) => [settings.contrast ?? 0, options.interactive])).toEqual([
      [0, false],
      [40, true],
      [-30, true],
      [-30, false],
    ]);
    await run(() => held[3]!.result.resolve(frame(113)));
    expect(mainPaints().slice(before)).toEqual([103, 113]);
    await run(() => current.presets.requestPreview(null));
    await sleep(200);
    await settleUntil(() => held.length === 5, "back to settings");
    await run(() => held[4]!.result.resolve(frame(104)));
    expect(mainPaints().slice(before)).toEqual([103, 113, 104]);

    // 押したら粗い画を出してから丁寧な画（丁寧な画は粗い画を描き終えてから出す）
    await run(() => current.presets.apply(bright));
    await settleUntil(() => current.presets.appliedPresetKey === bright.key && held.length === 6, "preset applied");
    expect(held[5]!.options.interactive).toBe(true);
    expect(held[5]!.options.maxDimension).toBe(640);
    expect(held[5]!.options.fastPresetPreview).toBe(true);
    await run(() => held[5]!.result.resolve(frame(105)));
    await settleUntil(() => held.length === 7, "applied final requested");
    expect(held[6]!.options.interactive).toBe(false);
    expect(held[6]!.options.maxDimension).toBe(1280);
    await run(() => held[6]!.result.resolve(frame(115)));
    expect(mainPaints().slice(before)).toEqual([103, 113, 104, 105, 115]);

    // 適用量（仮の表示を速い描き方で描く間）
    await run(() => current.presets.changeAmount(60, "drag"));
    await settleUntil(() => held.length === 8, "amount 60");
    await run(() => current.presets.changeAmount(70, "drag"));
    await settleUntil(() => held.length === 9, "amount 70");
    expect(held.slice(7).map(({ settings, options }) => [settings.contrast, options.interactive])).toEqual([
      [60, true],
      [70, true],
    ]);
    await run(() => held[7]!.result.resolve(frame(106)));
    expect(mainPaints().slice(before)).toEqual([103, 113, 104, 105, 115, 106]);
    await run(() => held[8]!.result.resolve(frame(107)));
    expect(mainPaints().slice(before)).toEqual([103, 113, 104, 105, 115, 106, 107]);
  });

  it("載せてから押したときは、載せて描いた丁寧な画を使って描き直さない（届く前に押しても待って使う。#127）", async () => {
    const { engine, held } = await openHeld("preview-apply");
    distinctPresets(engine);
    const before = mainPaints().length;
    const bright = { key: "builtin:bright", name: "明るい", xmp: "<xmp />" };
    await run(() => current.presets.requestPreview(bright));
    await sleep(200);
    await settleUntil(() => held.length === 1, "coarse preview requested");
    await run(() => held[0]!.result.resolve(frame(121)));
    await sleep(BROWSER_PRESET_PREVIEW_FINAL_DELAY_MS + 50);
    await settleUntil(() => held.length === 2, "final preview requested");
    await run(() => held[1]!.result.resolve(frame(122)));
    expect(mainPaints().slice(before)).toEqual([121, 122]);
    await run(() => current.presets.apply(bright));
    await settleUntil(() => current.presets.appliedPresetKey === bright.key, "preset applied");
    expect(held).toHaveLength(2);
    expect(mainPaints().at(-1)).toBe(122);

    // 載せた丁寧な画がまだ届かないうちに押した: 押した粗い画の後、届いた丁寧な画を使う（同じ設定を描き直さない）
    const dark = { key: "builtin:dark", name: "暗い", xmp: "<xmp dark />" };
    await run(() => current.presets.requestPreview(dark));
    await sleep(200);
    await settleUntil(() => held.length === 3, "dark coarse requested");
    await run(() => held[2]!.result.resolve(frame(131)));
    await sleep(BROWSER_PRESET_PREVIEW_FINAL_DELAY_MS + 50);
    await settleUntil(() => held.length === 4, "dark final requested");
    await run(() => current.presets.apply(dark));
    await settleUntil(() => current.presets.appliedPresetKey === dark.key && held.length === 5, "dark applied");
    expect(held[4]!.options.interactive).toBe(true);
    await run(() => held[3]!.result.resolve(frame(132)));
    await run(() => held[4]!.result.resolve(frame(133)));
    await sleep(0);
    expect(held).toHaveLength(5);
    expect(mainPaints().slice(-2)).toEqual([133, 132]);
  });
});
