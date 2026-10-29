// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * マスクの道具を出す幅（niho-photo#93）。偽の写真の出どころと偽の wasm（マスクを描ける）で JPEG を 1 枚で開き、編集面をそのまま描く。
 *
 * - PC の幅: 右端の帯の「マスク」（今までどおり）
 * - スマホの幅で直せる拠点（`mobileEditingAllowed`）: 全画面の編集の層の道具の帯の「マスク」。押すと段にマスクの道具を出し、写真の
 *   上にマスクの操作を重ねる
 * - スマホの幅で直せない拠点: 出さない
 */

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  createEngine: vi.fn(),
  paint: vi.fn(),
}));

vi.mock("niho-ui/app-dialog", () => ({ appDialog: { confirm: mocks.confirm, alert: vi.fn(async () => undefined) } }));
vi.mock("../develop-engine/develop-engine-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../develop-engine/develop-engine-client")>();
  return { ...actual, createDevelopEngine: mocks.createEngine, photoDevelopDiagnosticsEnabled: () => false };
});
vi.mock("../develop-engine/develop-frame", () => ({ paintDevelopFrame: mocks.paint }));

import type { DevelopEngine, DevelopFrame } from "../develop-engine/develop-engine-client";
import type { DevelopSettings } from "../develop-engine/develop-settings";
import type {
  PhotoLibrary,
  PhotoLibraryCapabilities,
  PhotoLibraryFolder,
  PhotoLibraryItem,
  PhotoLibraryListPage,
  PhotoLibraryPhoto,
} from "../library/photo-library";
import { PhotoLibraryProvider, type PhotoEditingHost } from "../library/photo-library-context";

import { BrowserPhotoEditingWorkbench } from "./browser-photo-editing-workbench";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CAPABILITIES: PhotoLibraryCapabilities = {
  place: "local",
  rawWorkingCopy: true,
  nativeExport: true,
  nativeExportUpdateRequired: false,
  // 原寸の書き出しもマスクを描ける（描けないときは足すボタンを押せない）
  nativeExportMasks: true,
  exportFolder: true,
  cutout: false,
  favorites: false,
  albums: false,
  articleImages: false,
  multiSelect: true,
  mobile: false,
  editedPreview: false,
  addFiles: false,
  addFromDevice: false,
  addFromDeviceFolder: false,
};

/** 写真は画面の (100, 50) から 600 x 400。1 枚の表示の領域は (0, 0) から 800 x 500。 */
const PHOTO_RECT = { left: 100, top: 50, width: 600, height: 400 };
const AREA_RECT = { left: 0, top: 0, width: 800, height: 500 };

function photo(id: string, fileName: string): PhotoLibraryPhoto & PhotoLibraryItem {
  return {
    id,
    fileName,
    fileExtension: "jpg",
    sizeBytes: 23,
    contentSha256: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    capturedAt: "2026-10-01T00:00:00.000Z",
    uploadedBy: null,
    hasOriginal: true,
    hasPreview: true,
    hasWebImage: false,
    hasDevelopSettings: false,
    developSettings: null,
    developSettingsUpdatedAt: null,
    developRevision: 0,
    webRenderedRevision: null,
    previewUrl: `asset://preview/${id}.jpg`,
  } as unknown as PhotoLibraryPhoto & PhotoLibraryItem;
}

/** 幅・高さだけを持つ JPEG のヘッダ（中身は偽の wasm が読む）。 */
function jpeg(width: number, height: number): File {
  const bytes = new Uint8Array(23);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  bytes.set([0xff, 0xd9], 21);
  return new File([bytes], "IMG_0001.JPG", { type: "image/jpeg" });
}

function frame(): DevelopFrame {
  return { width: 3, height: 2, rgba: new Uint8ClampedArray(3 * 2 * 4).fill(128) };
}

function createEngine(options: { heal: boolean; masks?: boolean }) {
  const render = vi.fn(async (_settings: DevelopSettings) => frame());
  const engine = {
    ready: vi.fn(async () => true),
    open: vi.fn(async () => ({ width: 1200, height: 800 })),
    render,
    builtinPresets: vi.fn(async () => []),
    presetSettings: vi.fn(async () => ({ converted: false, name: "", unsupported: [], settings: null })),
    renderPresetThumbnail: vi.fn(async () => frame()),
    yieldToEdit: vi.fn(),
    supportsPresetAmount: vi.fn(async () => false),
    supportsSettingsToXmp: vi.fn(async () => false),
    supportsPresetThumbnails: vi.fn(async () => false),
    supportsPresetFromMeta: vi.fn(async () => false),
    supportsAuto: vi.fn(async () => false),
    supportsGeometry: vi.fn(async () => true),
    supportsPerspective: vi.fn(async () => false),
    supportsUpright: vi.fn(async () => false),
    supportsEffects: vi.fn(async () => false),
    supportsColorPoints: vi.fn(async () => false),
    supportsDetail: vi.fn(async () => false),
    supportsHeal: vi.fn(async () => options.heal),
    supportsMasks: vi.fn(async () => (options.masks ? { kinds: ["linear", "radial"], max: 8, maskPlane: true } : null)),
    maskPlane: vi.fn(async () => null),
    imageSize: vi.fn(async () => ({ width: 1200, height: 800 })),
    rasterDecodeSize: vi.fn(async () => 1280),
    geometryOutputSize: vi.fn(async () => ({ width: 1200, height: 800 })),
    close: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  return engine as typeof engine & DevelopEngine;
}

const FOLDER: PhotoLibraryFolder = { folderId: "f1", name: "旅行", children: [], truncated: false };

function fakeLibrary() {
  const target = photo("p1", "IMG_0001.JPG");
  const deletePhotos = vi.fn(async () => ({ deleted: [], errors: [] }));
  const saveDevelopSettings = vi.fn(async (photoId: string, settings: DevelopSettings) => ({
    kind: "saved" as const,
    photo: { ...photo(photoId, "IMG_0001.JPG"), hasDevelopSettings: true, developSettings: settings, developRevision: 1 },
  }));
  const library = {
    place: "local",
    initialCapabilities: CAPABILITIES,
    capabilities: vi.fn(async () => CAPABILITIES),
    rollout: vi.fn(async () => ({ crop: true, mobileEditing: false })),
    engineAssets: { manifestUrl: () => null },
    limits: { listPageSize: 60, lookupMaxCount: 100, referencesMaxCount: 100, photosPerRequest: 100 },
    errors: {
      describe: (_error: unknown, fallback: string) => fallback,
      describeStorageError: () => null,
      describeDeleteFailure: () => "",
      isNativeError: () => false,
      describeNative: () => "",
      isPermanentSaveFailure: () => false,
      isNotFound: () => false,
      readQuotaExceeded: () => null,
      describeQuotaExceeded: () => "",
      readDevelopRevisionStale: () => null,
      isExportFolderNotFound: () => false,
    },
    list: vi.fn(async (): Promise<PhotoLibraryListPage> => ({ items: [target], next: null, usage: null, counts: null })),
    get: vi.fn(async () => null),
    lookup: vi.fn(async () => []),
    delete: deletePhotos,
    openOriginal: vi.fn(async (photoId: string) => ({
      source: { ref: "original-ref", expiresAt: null },
      photo: photo(photoId, "IMG_0001.JPG"),
    })),
    loadOriginal: vi.fn(async () => jpeg(1200, 800)),
    saveDevelopSettings,
    presets: { nameMaxChars: 100, list: vi.fn(async () => []) },
    folders: {
      tree: vi.fn(async () => [FOLDER]),
      add: vi.fn(async () => null),
      forget: vi.fn(async () => undefined),
    },
  } as unknown as PhotoLibrary;
  return { library, deletePhotos, saveDevelopSettings };
}

const host: PhotoEditingHost = {
  notifyPhotosChanged: () => undefined,
  saveFile: async () => "saved",
  nativeFileSaveAvailable: () => false,
  isNativeViewport: () => false,
  isDesktopApp: () => true,
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
const initialInnerWidth = window.innerWidth;

function domRect(rect: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => rect,
  } as DOMRect;
}

/** 読み込み（react-query・木・写真を開く・wasm の確かめ）が落ち着くまで待つ（macrotask も挟む）。 */
async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(library: PhotoLibrary, canEdit = true, mobileEditingAllowed = false) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PhotoLibraryProvider library={library} host={host}>
          <BrowserPhotoEditingWorkbench
            spotId="local"
            canEdit={canEdit}
            cloudOriginalsAllowed
            active
            mobileEditingAllowed={mobileEditingAllowed}
            openCloudPhotoId={null}
            onOpenCloudPhotoHandled={() => undefined}
          />
        </PhotoLibraryProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("element not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

async function pointer(target: Element, type: string, clientX: number, clientY: number, init: PointerEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY, pointerId: 1, button: 0, ...init }),
    );
  });
}

function byLabel(label: string, scope: ParentNode = container): HTMLButtonElement | null {
  return scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === text);
}

function rail(): HTMLElement {
  const found = container.querySelector<HTMLElement>('nav[aria-label="道具"]');
  if (!found) throw new Error("tool rail not found");
  return found;
}

function railLabels(): Array<string | null> {
  return Array.from(rail().querySelectorAll("button")).map((button) => button.getAttribute("aria-label"));
}

function panel(): HTMLElement {
  const found = container.querySelector<HTMLElement>('aside[aria-label="補正"]');
  if (!found) throw new Error("panel not found");
  return found;
}

function brushArea(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="photo-heal-brush-area"]');
}

function markRows(): string[] {
  return Array.from(container.querySelectorAll('ol[aria-label="印の一覧"] > li > button:first-child')).map(
    (button) => button.textContent ?? "",
  );
}

async function openPhoto() {
  const target = Array.from(container.querySelectorAll<HTMLButtonElement>('section[aria-label="写真の一覧"] li > button')).find(
    (candidate) => candidate.title === "IMG_0001.JPG",
  );
  if (!target) throw new Error("tile not found");
  await act(async () => {
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  mocks.createEngine.mockReset();
  mocks.paint.mockReset();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this instanceof HTMLCanvasElement) return domRect(PHOTO_RECT);
    if (this.getAttribute("data-testid") === "photo-heal-brush-area") return domRect(AREA_RECT);
    return domRect({ left: 0, top: 0, width: 0, height: 0 });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: initialInnerWidth });
  window.localStorage.clear();
  vi.restoreAllMocks();
});


async function openOnPhone() {
  const target = Array.from(container.querySelectorAll<HTMLButtonElement>('section[aria-label="写真の一覧"] li > button')).find(
    (candidate) => candidate.title === "IMG_0001.JPG",
  );
  if (!target) throw new Error("tile not found");
  await click(target);
}

function layerToolStrip(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="region"] nav[aria-label="道具"]');
}

function layerTool(name: string): HTMLButtonElement | undefined {
  return Array.from(layerToolStrip()?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) =>
    button.textContent?.startsWith(name),
  );
}

describe("マスクの道具を出す幅（niho-photo#93）", () => {
  it("PC の幅は今までどおり右端の帯の「マスク」", async () => {
    mocks.createEngine.mockImplementation(() => createEngine({ heal: false, masks: true }));
    await render(fakeLibrary().library);
    await openPhoto();
    expect(railLabels()).toContain("マスク");
    expect(layerToolStrip()).toBeNull();
  });

  it("スマホの幅で直せる拠点は、編集の層の道具の帯に「マスク」を出し、押すと段と写真の上の操作を出す", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    mocks.createEngine.mockImplementation(() => createEngine({ heal: false, masks: true }));
    await render(fakeLibrary().library, true, true);
    await openOnPhone();
    const mask = layerTool("マスク");
    expect(mask).toBeDefined();
    expect(document.body.querySelector('[data-testid="photo-mask-overlay"]')).toBeNull();
    await click(mask);
    expect(layerTool("マスク")?.getAttribute("aria-current")).toBe("true");
    const band = document.body.querySelector<HTMLElement>('[data-testid="photo-editing-mobile-mask"]');
    expect(band?.querySelector('[role="toolbar"][aria-label="マスクを追加"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="photo-mask-overlay"]')).not.toBeNull();
    // 足すと一覧に入り、選んだマスクの補正を出す
    await click(band?.querySelector('button[aria-label="線形グラデーション"]'));
    expect(band?.querySelector('[role="toolbar"][aria-label="マスクの一覧"]')?.textContent).toContain("線形 1");
    expect(band?.querySelector('[role="toolbar"][aria-label="線形 1 の補正"]')).not.toBeNull();
    // 「初期化」はマスクだけを外す
    const reset = Array.from(band?.querySelectorAll<HTMLButtonElement>('[aria-label="マスクを追加"] button') ?? []).find(
      (button) => button.textContent === "初期化",
    );
    await click(reset);
    expect(band?.querySelector('[role="toolbar"][aria-label="マスクの一覧"]')).toBeNull();
    // ほかの道具に移ると、写真の上の操作も外す
    await click(layerTool("ライト"));
    expect(document.body.querySelector('[data-testid="photo-mask-overlay"]')).toBeNull();
  });

  it("スマホの幅で直せない拠点には出さない", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    mocks.createEngine.mockImplementation(() => createEngine({ heal: false, masks: true }));
    await render(fakeLibrary().library, true, false);
    await openOnPhone();
    expect(layerToolStrip()).toBeNull();
    expect(Array.from(document.body.querySelectorAll("button")).some((button) => button.getAttribute("aria-label") === "マスク")).toBe(
      false,
    );
  });
});
