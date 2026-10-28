// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 編集面の修復の道具（niho-photo#44 後半）。偽の写真の出どころ（この Mac のフォルダ）と偽の wasm で JPEG を 1 枚で開き、編集面を
 * そのまま描く。
 *
 * - 右端の帯の「修復」は、wasm が印を描ける・直せる（閲覧のみでない）写真を 1 枚で見ている間だけ、切り抜きの次に置く
 * - 押すと右パネルが修復の面（見出し行は「修復」と ↶ ↷。ヒストグラムは一番上）になり、写真の上にブラシを置く。もう一度押す・Esc で
 *   補正へ戻る。修復の間は「比較」「補正前」を押せない
 * - ブラシでなぞると印が 1 つ（取り消しの 1 単位）。一覧に残り、Delete は選んでいる印を消す（写真は消さない）。⌘Z で戻る
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

function createEngine(options: { heal: boolean }) {
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
    supportsLens: vi.fn(async () => true),
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

async function render(library: PhotoLibrary, canEdit = true) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PhotoLibraryProvider library={library} host={host}>
          <BrowserPhotoEditingWorkbench
            spotId="local"
            canEdit={canEdit}
            cloudOriginalsAllowed
            active
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

describe("右端の帯の「修復」", () => {
  it("印を描ける wasm で直せる写真を 1 枚で見ている間だけ、切り抜きの次に置く", async () => {
    mocks.createEngine.mockImplementation(() => createEngine({ heal: true }));
    const fake = fakeLibrary();
    await render(fake.library);
    // 一覧の間は帯も出さない
    expect(container.querySelector('nav[aria-label="道具"]')).toBeNull();
    await openPhoto();
    expect(railLabels()).toEqual(["プリセット", "補正", "切り抜き", "修復", "情報"]);
    expect(byLabel("修復", rail())?.getAttribute("aria-pressed")).toBe("false");
  });

  it("古い wasm（印を描けない）・閲覧のみには出さない", async () => {
    mocks.createEngine.mockImplementation(() => createEngine({ heal: false }));
    await render(fakeLibrary().library);
    await openPhoto();
    expect(railLabels()).not.toContain("修復");

    await act(async () => root.unmount());
    client.clear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    mocks.createEngine.mockImplementation(() => createEngine({ heal: true }));
    await render(fakeLibrary().library, false);
    await openPhoto();
    expect(railLabels()).not.toContain("修復");
  });

  it("押すと修復の面とブラシ（幾何なしの画）。もう一度押す・Esc で補正へ戻る。修復の間は比較・補正前を押せない", async () => {
    const engine = createEngine({ heal: true });
    mocks.createEngine.mockImplementation(() => engine);
    await render(fakeLibrary().library);
    await openPhoto();
    expect(byLabel("比較")?.disabled).toBe(false);

    await click(byLabel("修復", rail()));
    expect(byLabel("修復", rail())?.getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("補正", rail())?.getAttribute("aria-pressed")).toBe("false");
    expect(panel().querySelector("h2")?.textContent).toBe("修復");
    // ヒストグラムは一番上、見出し行は ↶ ↷ だけ（初期化・⋯ は出さない）
    expect(panel().firstElementChild?.querySelector('[data-testid="photo-histogram"]')).not.toBeNull();
    expect(byLabel("取り消す", panel())).not.toBeNull();
    expect(byLabel("補正のメニュー", panel())).toBeNull();
    expect(panel().querySelector('ol[aria-label="印の一覧"]')).toBeNull();
    expect(panel().textContent).toContain("写真の上をなぞると赤い印が付き");
    expect(brushArea()?.getAttribute("aria-disabled")).toBeNull();
    // 幾何なしの画を描いている（色は当てる）
    const rendered = engine.render.mock.calls.at(-1)?.[0];
    expect(rendered?.geometry).toBeUndefined();
    expect(byLabel("比較")?.disabled).toBe(true);
    expect(buttonByText("補正前")?.disabled).toBe(true);

    // もう一度押すと補正へ戻る
    await click(byLabel("修復", rail()));
    expect(panel().querySelector("h2")?.textContent).toBe("補正");
    expect(brushArea()).toBeNull();
    expect(byLabel("比較")?.disabled).toBe(false);

    // Esc でも補正へ戻る（もう一度の Esc は一覧へ）
    await click(byLabel("修復", rail()));
    expect(brushArea()).not.toBeNull();
    await press("Escape");
    expect(panel().querySelector("h2")?.textContent).toBe("補正");
    expect(brushArea()).toBeNull();
  });

  it("なぞると印が 1 つ（1 単位）。Delete は選んでいる印を消し、写真は消さない。⌘Z で戻る。Esc は選択を外してから補正へ", async () => {
    const engine = createEngine({ heal: true });
    mocks.createEngine.mockImplementation(() => engine);
    const fake = fakeLibrary();
    await render(fake.library);
    await openPhoto();
    await click(byLabel("修復", rail()));
    const area = brushArea();
    if (!area) throw new Error("brush area not found");

    await pointer(area, "pointerdown", 160, 250);
    await pointer(area, "pointermove", 400, 250);
    await pointer(area, "pointerup", 400, 250);
    await settle();
    expect(markRows()).toEqual(["1 消す"]);
    const healed = engine.render.mock.calls.at(-1)?.[0];
    expect(healed?.heal).toEqual([
      expect.objectContaining({ id: "h1", mode: "remove", points: [[0.1, 0.5], [0.5, 0.5]] }),
    ]);
    expect(healed?.geometry).toBeUndefined();
    // 新しい印を選んでいる
    expect(container.querySelector('ol[aria-label="印の一覧"] button[aria-pressed="true"]')?.textContent).toBe("1 消す");

    // 選んでいる印を Delete で消す（写真は消さない）
    await press("Delete");
    expect(markRows()).toEqual([]);
    expect(fake.deletePhotos).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    // 選んでいなければ Delete は何もしない
    await press("Backspace");
    expect(fake.deletePhotos).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();

    // ⌘Z で戻る
    await press("z", { metaKey: true });
    expect(markRows()).toEqual(["1 消す"]);

    // 一覧から選び、Esc で選択を外す（道具はそのまま）→ もう一度の Esc で補正へ
    await click(container.querySelector('ol[aria-label="印の一覧"] > li > button:first-child'));
    expect(container.querySelector('ol[aria-label="印の一覧"] button[aria-pressed="true"]')).not.toBeNull();
    await press("Escape");
    expect(container.querySelector('ol[aria-label="印の一覧"] button[aria-pressed="true"]')).toBeNull();
    expect(panel().querySelector("h2")?.textContent).toBe("修復");
    await press("Escape");
    expect(panel().querySelector("h2")?.textContent).toBe("補正");
  });

  it("埋まるまでは濃い赤の印のまま。描画が遅くてもブラシは待たずに次の印を描け、描けた画に入った印から薄い赤に替わる", async () => {
    const engine = createEngine({ heal: true });
    const pending: Array<(value: DevelopFrame) => void> = [];
    mocks.createEngine.mockImplementation(() => engine);
    await render(fakeLibrary().library);
    await openPhoto();
    await click(byLabel("修復", rail()));
    const area = brushArea();
    if (!area) throw new Error("brush area not found");
    // ここからの描画は止めておく
    engine.render.mockImplementation(
      () =>
        new Promise<DevelopFrame>((resolve) => {
          pending.push(resolve);
        }),
    );
    const state = (id: string) => container.querySelector(`[data-heal-mark="${id}"]`)?.getAttribute("data-heal-state");

    await pointer(area, "pointerdown", 400, 250);
    await pointer(area, "pointerup", 400, 250);
    await settle();
    expect(state("h1")).toBe("pending");
    // 描き終える前に次の印
    await pointer(area, "pointerdown", 200, 150);
    await pointer(area, "pointerup", 200, 150);
    await settle();
    expect(markRows()).toEqual(["1 消す", "2 消す"]);
    expect(state("h2")).toBe("pending");

    // 古い要求（印 1 つ）の画は捨て、最新の要求（印 2 つ）の画で両方が埋まる
    await act(async () => {
      for (const resolve of pending) resolve(frame());
    });
    await settle();
    expect(state("h1")).toBe("painted");
    expect(state("h2")).toBe("painted");
    expect(engine.render.mock.calls.at(-1)?.[0].heal).toHaveLength(2);
  });

  it("[ ] でブラシの大きさ、O で印の表示を切り替える", async () => {
    mocks.createEngine.mockImplementation(() => createEngine({ heal: true }));
    await render(fakeLibrary().library);
    await openPhoto();
    await click(byLabel("修復", rail()));
    const size = () => panel().querySelector<HTMLInputElement>('input[type="range"][aria-label="ブラシの大きさ"]');
    expect(size()?.getAttribute("aria-valuetext")).toBe("2%");
    await press("]");
    expect(size()?.getAttribute("aria-valuetext")).not.toBe("2%");
    await press("[");
    expect(size()?.getAttribute("aria-valuetext")).toBe("2%");
    expect(buttonByText("印を表示", panel())?.getAttribute("aria-pressed")).toBe("true");
    await press("o");
    expect(buttonByText("印を表示", panel())?.getAttribute("aria-pressed")).toBe("false");
  });
});
