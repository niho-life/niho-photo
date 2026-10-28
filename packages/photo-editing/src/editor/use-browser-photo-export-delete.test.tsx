// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopEngine } from "../develop-engine/develop-engine-client";
import { developSettingsVersion, neutralDevelopSettings, type DevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoLibrary, PhotoLibraryCapabilities, PhotoLibraryPhoto } from "../library/photo-library";
import {
  PhotoLibraryProvider,
  type PhotoEditingHost,
} from "../library/photo-library-context";

import type { BrowserItem, DevelopSession, FooterStatus, OpenedSource } from "./browser-photo-editing-model";
import {
  useBrowserPhotoExportAndDelete,
  type BrowserPhotoExportResult,
} from "./use-browser-photo-export-delete";

const CAPABILITIES: PhotoLibraryCapabilities = {
  place: "local",
  rawWorkingCopy: true,
  nativeExport: false,
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

function photo(): PhotoLibraryPhoto {
  return {
    id: "raw",
    fileName: "raw.rw2",
    fileExtension: "rw2",
    sizeBytes: 1_000,
    contentSha256: "b".repeat(64),
    createdAt: "2026-10-20T00:00:00.000Z",
    capturedAt: null,
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

const target: BrowserItem = {
  key: "cloud:raw",
  photo: { ...photo(), previewUrl: "https://example.invalid/raw.jpg" },
  localPreviewUrl: null,
  adding: false,
};

function provisionalOpened(): OpenedSource {
  return {
    key: target.key,
    fileName: target.photo.fileName,
    decoded: null,
    viewUrl: target.photo.previewUrl,
    previewPending: false,
    previewCurrent: false,
    lockedReason: null,
    loadedForEditing: true,
    mode: "wasm",
    input: {
      kind: "provisional",
      file: new File([new Uint8Array([1])], "preview.jpg", { type: "image/jpeg" }),
      contentSha256: photo().contentSha256,
      width: 1600,
      height: 1067,
    },
    canonicalPending: true,
    work: { phase: "opening" },
    photo: photo(),
  };
}

function canonicalOpened(): OpenedSource {
  return {
    ...provisionalOpened(),
    input: {
      kind: "workingCopy",
      encoding: "png16",
      bytes: new ArrayBuffer(8),
      metaJson: "{}",
      baseVersion: "raw-apple.d1.p1.e1",
    },
    canonicalPending: false,
    work: null,
  };
}

let container: HTMLDivElement;
let root: Root;
let runExport: (
  format: "jpeg" | "png" | "original",
  options: { size: "long2048" | "width1080" | "full"; jpegRoute: "engine" | "canvas" | "webImage" | "native" | null },
) => Promise<BrowserPhotoExportResult>;
let openedRefForTest: { current: OpenedSource | null };
let operationRefForTest: { current: "export" | "delete" | "bulk" | null };
let pendingEdits: { hasPending: () => boolean; waitForPending: ReturnType<typeof vi.fn<() => Promise<void>>> };
let engine: DevelopEngine;
let downloadOriginal: ReturnType<typeof vi.fn>;
let openOriginal: ReturnType<typeof vi.fn<PhotoLibrary["openOriginal"]>>;
let saveFile = vi.fn<PhotoEditingHost["saveFile"]>();
let capabilitiesForTest: PhotoLibraryCapabilities;
let settingsRefForTest: { current: DevelopSettings };
let statusForTest: ReturnType<typeof vi.fn<(status: FooterStatus | null) => void>>;
let nativeExport: ReturnType<typeof vi.fn>;

function Harness() {
  const mountedRef = useRef(true);
  const latestAccessRef = useRef({ canEdit: true, cloudOriginalsAllowed: true, spotId: "spot" });
  const operationRef = useRef<"export" | "delete" | "bulk" | null>(null);
  operationRefForTest = operationRef;
  const saveGenerationRef = useRef(0);
  const viewModeRef = useRef<"grid" | "loupe">("loupe");
  const engineRef = useRef(engine);
  const developSessionRef = useRef<DevelopSession | null>(null);
  const openedRef = useRef<OpenedSource | null>(provisionalOpened());
  openedRefForTest = openedRef;
  const settingsRef = useRef(neutralDevelopSettings("raw-apple.d1.p1.e1"));
  settingsRefForTest = settingsRef;
  const openingKeyRef = useRef<string | null>(null);
  const controller = useBrowserPhotoExportAndDelete({
    spotId: "spot",
    canEdit: true,
    mountedRef,
    latestAccessRef,
    selectedItem: target,
    pendingEdits,
    operationRef,
    setOperation: vi.fn(),
    saveGenerationRef,
    viewModeRef,
    setViewMode: vi.fn(),
    setExportSheetOpen: vi.fn(),
    setStatus: statusForTest,
    removeCloudPhotos: vi.fn(),
    develop: {
      engineRef,
      developSessionRef,
      releaseDevelopSession: vi.fn(),
      readyDevelopEngine: vi.fn(async () => engine),
    },
    open: {
      openedRef,
      openingKeyRef,
      settingsRef,
      setSavedSettingsKey: vi.fn(),
      setSourceError: vi.fn(),
      abortOpening: vi.fn(),
      clearOpened: vi.fn(),
    },
    items: {
      deepLinkedPhoto: null,
      setDeepLinkedPhoto: vi.fn(),
      setSelectedKey: vi.fn(),
      removeAddedPhoto: vi.fn(),
    },
    capabilities: capabilitiesForTest,
  });
  runExport = controller.runExport;
  return null;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  pendingEdits = { hasPending: () => false, waitForPending: vi.fn(async () => undefined) };
  capabilitiesForTest = { ...CAPABILITIES };
  statusForTest = vi.fn<(status: FooterStatus | null) => void>();
  nativeExport = vi.fn(async () => ({ saved: true, fileName: "raw.jpg" }));
  engine = {
    exportWorkingCopyJpeg: vi.fn(async () => new Uint8Array([1, 2, 3])),
    exportJpeg: vi.fn(async () => new Uint8Array([1, 2, 3])),
    imageSize: vi.fn(async () => ({ width: 3000, height: 2000 })),
    geometryOutputSize: vi.fn(async () => ({ width: 2048, height: 1365 })),
    withCaptureExif: vi.fn(async (bytes: Uint8Array<ArrayBuffer>) => bytes),
  } as unknown as DevelopEngine;
  downloadOriginal = vi.fn(async () => ({ blob: new Blob([new Uint8Array([7])]), fileName: "raw.rw2" }));
  openOriginal = vi.fn(async (photoId: string) => ({
    source: { ref: "original", expiresAt: null },
    photo: { ...photo(), id: photoId },
  }));
  const library = {
    downloadOriginal,
    openOriginal,
    exportNative: nativeExport,
    errors: {
      describe: (_error: unknown, fallback: string) => fallback,
      describeStorageError: () => null,
      isNativeError: () => false,
    },
  } as unknown as PhotoLibrary;
  saveFile = vi.fn(async () => "saved" as const);
  const host: PhotoEditingHost = {
    notifyPhotosChanged: vi.fn(),
    saveFile,
    nativeFileSaveAvailable: () => false,
    isNativeViewport: () => false,
    isDesktopApp: () => true,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <PhotoLibraryProvider library={library} host={host}>
        <Harness />
      </PhotoLibraryProvider>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useBrowserPhotoExportAndDelete canonical guard integration", () => {
  it("中間調・全体の輝度を原寸 native renderer に渡さない", async () => {
    capabilitiesForTest = { ...CAPABILITIES, nativeExport: true };
    settingsRefForTest.current = {
      ...neutralDevelopSettings("raw-apple.d1.p1.e1"),
      colorGrading: { global: { luminance: 20 } },
    };
    let result: BrowserPhotoExportResult | undefined;
    await act(async () => {
      result = await runExport("jpeg", { size: "full", jpegRoute: "native" });
    });
    expect(result).toBe("failed");
    expect(nativeExport).not.toHaveBeenCalled();
    expect(statusForTest).toHaveBeenCalledWith({
      kind: "error",
      text: "中間調・全体の輝度を使っている写真は、原寸で書き出せません。この Mac の NIHO photo を更新すると、原寸で書き出せます。",
    });
  });

  it.each([
    ["遠近", { geometry: { perspective: { vertical: -20 } } }, "遠近を使っている写真は、原寸で書き出せません。この Mac の NIHO photo を更新すると、原寸で書き出せます。"],
    [
      "修復",
      { heal: [{ id: "a", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.5, 0.5]] }] },
      "修復を使っている写真は、原寸で書き出せません。この Mac の NIHO photo を更新すると、原寸で書き出せます。",
    ],
    ["レンズ補正", { lens: { distortion: 10 } }, "レンズ補正を使っている写真は、原寸で書き出せません。この Mac の NIHO photo を更新すると、原寸で書き出せます。"],
  ])("%s を原寸 native renderer に渡さない", async (_name, extra, text) => {
    capabilitiesForTest = { ...CAPABILITIES, nativeExport: true };
    settingsRefForTest.current = { ...neutralDevelopSettings("raw-apple.d1.p1.e1"), ...extra };
    let result: BrowserPhotoExportResult | undefined;
    await act(async () => {
      result = await runExport("jpeg", { size: "full", jpegRoute: "native" });
    });
    expect(result).toBe("failed");
    expect(nativeExport).not.toHaveBeenCalled();
    expect(statusForTest).toHaveBeenCalledWith({ kind: "error", text });
  });

  it("描ける設定を答える描画には、遠近・修復・レンズ・輝度を原寸で渡す", async () => {
    capabilitiesForTest = {
      ...CAPABILITIES,
      nativeExport: true,
      nativeExportRenderer: {
        settingsVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
        engines: ["niho-1", "niho-2", "niho-3", "niho-4", "niho-14"],
        features: ["colorGradingLuminance"],
        maskKinds: ["linear", "radial", "brush", "subject", "sky"],
        maxPixels: 40_000_000,
      },
    };
    settingsRefForTest.current = {
      ...neutralDevelopSettings("raw-apple.d1.p1.e1"),
      geometry: { perspective: { vertical: -20 } },
      heal: [{ id: "a", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.5, 0.5]] }],
      lens: { distortion: 10 },
      colorGrading: { global: { luminance: 20 } },
    };
    openedRefForTest.current = canonicalOpened();
    await act(async () => {
      await runExport("jpeg", { size: "full", jpegRoute: "native" });
    });
    expect(statusForTest).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("原寸で書き出せません") }));
    expect(nativeExport).toHaveBeenCalledTimes(1);
  });

  it("原寸native exportは一覧の古い補正ではなくopenOriginalの最新補正を判定する", async () => {
    Object.assign(capabilitiesForTest, { nativeExport: true });
    openedRefForTest.current = null;
    settingsRefForTest.current = neutralDevelopSettings("raw-apple.d1.p1.e1");
    openOriginal.mockResolvedValue({
      source: { ref: "original", expiresAt: null },
      photo: {
        ...photo(),
        hasDevelopSettings: true,
        developSettings: {
          ...neutralDevelopSettings("raw-apple.d1.p1.e1"),
          geometry: { perspective: { vertical: -20 } },
          v: developSettingsVersion({ geometry: { perspective: { vertical: -20 } } }),
        },
        developSettingsUpdatedAt: "2026-10-21T00:00:00.000Z",
        developRevision: 1,
      },
    });

    let result: BrowserPhotoExportResult | undefined;
    await act(async () => {
      result = await runExport("jpeg", { size: "full", jpegRoute: "native" });
    });

    expect(result).toBe("failed");
    expect(openOriginal).toHaveBeenCalledTimes(1);
    expect(nativeExport).not.toHaveBeenCalled();
    expect(statusForTest).toHaveBeenCalledWith({ kind: "error", text: "遠近を使っている写真は、原寸で書き出せません。この Mac の NIHO photo を更新すると、原寸で書き出せます。" });
  });

  it("受け付けたプリセットを確定してから編集をロックし、同時の重複exportを抑える", async () => {
    let finish!: () => void;
    pendingEdits.hasPending = () => true;
    pendingEdits.waitForPending.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    openedRefForTest.current = canonicalOpened();
    const first = runExport("jpeg", { size: "long2048", jpegRoute: "engine" });
    const completeFirst = finish;
    const second = runExport("jpeg", { size: "long2048", jpegRoute: "engine" });
    expect(operationRefForTest.current).toBeNull();
    expect(engine.exportWorkingCopyJpeg).not.toHaveBeenCalled();
    await act(async () => {
      completeFirst();
      finish();
      expect(await first).toBe("done");
      expect(await second).toBe("skipped");
    });
    expect(engine.exportWorkingCopyJpeg).toHaveBeenCalledTimes(1);
  });

  it("補正を焼くfull-quality exportはcanonical handoffまでengineを呼ばない", async () => {
    let result: BrowserPhotoExportResult | undefined;
    const pending = runExport("jpeg", { size: "long2048", jpegRoute: "engine" }).then((value) => {
      result = value;
    });
    await act(async () => Promise.resolve());
    expect(engine.exportWorkingCopyJpeg).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();

    openedRefForTest.current = canonicalOpened();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      await pending;
    });
    expect(engine.exportWorkingCopyJpeg).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(result).toBe("done");
  });

  it("RAW original copyはprovisional中でもcanonicalを待たない", async () => {
    pendingEdits.hasPending = () => true;
    pendingEdits.waitForPending.mockImplementation(() => new Promise<void>(() => undefined));
    let result: BrowserPhotoExportResult | undefined;
    await act(async () => {
      result = await runExport("original", { size: "long2048", jpegRoute: null });
    });
    expect(downloadOriginal).toHaveBeenCalledTimes(1);
    expect(pendingEdits.waitForPending).not.toHaveBeenCalled();
    expect(engine.exportWorkingCopyJpeg).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(result).toBe("done");
  });
});
