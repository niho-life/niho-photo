// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 編集面の選別（niho-photo#47。Lightroom のフラグ）。偽の写真の出どころ（この Mac・フォルダ 1 つ）で編集面をそのまま描く。
 *
 * - 一覧で P / X / U を押すと、選んでいる写真（複数選択なら全部）にフラグが付き、タイルに印・却下は薄く出る。下段のボタンも同じ
 * - 絞り込みの「採用だけ」「却下を隠す」は一覧の問い合わせで渡し、外すと却下した写真が戻る（却下は消さない）。複数枚の書き出しの
 *   対象は絞り込んだ写真だけ
 * - 1 枚の編集中（フィルムストリップ）でもキーが効く
 * - 選別を持たない写真の出どころ・閲覧のみでは出さない・効かない。保存できなければ元に戻して 1 行
 */

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  createEngine: vi.fn(),
  deviceClasses: [] as Array<"pc" | "mobile">,
}));

vi.mock("niho-ui/app-dialog", () => ({ appDialog: { confirm: mocks.confirm, alert: vi.fn(async () => undefined) } }));
vi.mock("../develop-engine/develop-engine-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../develop-engine/develop-engine-client")>();
  return { ...actual, createDevelopEngine: mocks.createEngine };
});
vi.mock("./use-browser-photo-develop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-browser-photo-develop")>();
  return {
    ...actual,
    useBrowserPhotoDevelop(params: Parameters<typeof actual.useBrowserPhotoDevelop>[0]) {
      mocks.deviceClasses.push(params.deviceClass);
      return actual.useBrowserPhotoDevelop(params);
    },
  };
});

import type {
  PhotoLibrary,
  PhotoLibraryCapabilities,
  PhotoLibraryFlag,
  PhotoLibraryItem,
  PhotoLibraryListPage,
  PhotoLibraryListQuery,
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

function photo(id: string, fileName: string, createdAt: string): PhotoLibraryItem {
  return {
    id,
    fileName,
    fileExtension: "jpg",
    sizeBytes: 1024,
    contentSha256: null,
    createdAt,
    capturedAt: createdAt,
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
  };
}

/** 新しい順（一覧の並び） */
const PHOTOS = [
  photo("p1", "ONE.JPG", "2026-10-03T00:00:00.000Z"),
  photo("p2", "TWO.JPG", "2026-10-02T00:00:00.000Z"),
  photo("p3", "THREE.JPG", "2026-10-01T00:00:00.000Z"),
];

type SetFlags = NonNullable<PhotoLibrary["flags"]>["set"];

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakeLibrary(options: { flags?: boolean; initial?: Record<string, PhotoLibraryFlag>; set?: SetFlags } = {}) {
  const withFlags = options.flags !== false;
  const stored = new Map(Object.entries(options.initial ?? {}));
  const list = vi.fn(async (query: PhotoLibraryListQuery): Promise<PhotoLibraryListPage> => {
    const items = (query.folderId === "f1" ? PHOTOS : [])
      .map((item) => (withFlags ? { ...item, flag: stored.get(item.id) ?? null } : item))
      .filter((item) => {
        if (query.flag === "pick") return item.flag === "pick";
        if (query.flag === "notRejected") return item.flag !== "reject";
        return true;
      });
    return { items, next: null, usage: null, counts: null };
  });
  const set = vi.fn<SetFlags>(
    options.set ??
      (async (photoIds, flag) => {
        for (const photoId of photoIds) {
          if (flag) stored.set(photoId, flag);
          else stored.delete(photoId);
        }
        return { updated: photoIds.length, skipped: { notFound: 0, noOriginal: 0 } };
      }),
  );
  const capabilities = { ...CAPABILITIES, ...(withFlags ? { flags: true } : {}) };
  const library = {
    place: "local",
    initialCapabilities: capabilities,
    capabilities: vi.fn(async () => capabilities),
    rollout: vi.fn(async () => ({ crop: false, mobileEditing: false })),
    engineAssets: { manifestUrl: () => null },
    limits: { listPageSize: 60, lookupMaxCount: 100, referencesMaxCount: 0, photosPerRequest: 50 },
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
    list,
    get: vi.fn(async () => null),
    lookup: vi.fn(async () => []),
    delete: vi.fn(async () => ({ deleted: [], errors: [] })),
    presets: { nameMaxChars: 100, list: vi.fn(async () => []) },
    folders: {
      tree: vi.fn(async () => [{ folderId: "f1", name: "SD", children: [], truncated: false }]),
      add: vi.fn(async () => null),
      forget: vi.fn(async () => undefined),
    },
    ...(withFlags ? { flags: { set } } : {}),
  } as unknown as PhotoLibrary;
  return { library, list, set, stored };
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

async function settle() {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(library: PhotoLibrary, extra: { canEdit?: boolean } = {}, editingHost = host) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PhotoLibraryProvider library={library} host={editingHost}>
          <BrowserPhotoEditingWorkbench
            spotId="local"
            canEdit={extra.canEdit ?? true}
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

async function click(element: Element | null | undefined, init: MouseEventInit = {}) {
  if (!element) throw new Error("element not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

async function keyDown(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

function tiles(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('section[aria-label="写真の一覧"] li > button'));
}

function tile(fileName: string): HTMLButtonElement {
  const found = tiles().find((candidate) => candidate.title === fileName);
  if (!found) throw new Error(`tile not found: ${fileName}`);
  return found;
}

/** タイルの右下の選別の印（無ければ null） */
function mark(fileName: string): string | null {
  const found = Array.from(tile(fileName).querySelectorAll<HTMLElement>("span.absolute")).find((span) =>
    span.className.includes("right-[5px]"),
  );
  return found?.textContent ?? null;
}

function flagGroup(): HTMLElement | null {
  return container.querySelector<HTMLElement>('footer [role="group"][aria-label="選別"]');
}

function flagButton(label: string): HTMLButtonElement {
  const found = flagGroup()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`flag button not found: ${label}`);
  return found;
}

function filmstrip(): HTMLElement | null {
  return container.querySelector<HTMLElement>('nav[aria-label="この一覧の写真"]');
}

function stripLabels(): string[] {
  return Array.from(filmstrip()?.querySelectorAll("button") ?? []).map((button) => button.getAttribute("aria-label") ?? "");
}

async function chooseFilter(label: string) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="絞り込み"]');
  if (trigger?.getAttribute("aria-expanded") !== "true") await click(trigger);
  const option = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="選別"] [role="radio"]'),
  ).find((candidate) => candidate.textContent === label);
  await click(option);
}

async function openFromGrid(fileName: string) {
  await act(async () => {
    tile(fileName).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
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
  mocks.deviceClasses.length = 0;
  mocks.createEngine.mockImplementation(() => ({
    ready: vi.fn(async () => false),
    dispose: vi.fn(),
    close: vi.fn(async () => undefined),
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  document.body.querySelectorAll('[role="dialog"]').forEach((element) => element.remove());
  Object.defineProperty(window, "innerWidth", { configurable: true, value: initialInnerWidth });
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("現像 Worker の端末区分", () => {
  it.each([
    { initialWidth: 1280, resizedWidth: 768, expectedClass: "pc" },
    { initialWidth: 768, resizedWidth: 1280, expectedClass: "mobile" },
  ] as const)(
    "画面幅が $initialWidth から $resizedWidth へ変わっても $expectedClass を保つ",
    async ({ initialWidth, resizedWidth, expectedClass }) => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: initialWidth });
      await render(fakeLibrary().library, {}, { ...host, isDesktopApp: () => false });
      const beforeResize = mocks.deviceClasses.length;
      expect(beforeResize).toBeGreaterThan(0);
      expect(mocks.deviceClasses.at(-1)).toBe(expectedClass);

      Object.defineProperty(window, "innerWidth", { configurable: true, value: resizedWidth });
      await act(async () => window.dispatchEvent(new Event("resize")));
      await settle();
      expect(mocks.deviceClasses.length).toBeGreaterThan(beforeResize);
      expect(mocks.deviceClasses.at(-1)).toBe(expectedClass);
    },
  );
});

describe("一覧の選別", () => {
  it("P / X / U で選んでいる写真に採用・却下を付け外しし、タイルの印と薄さ・下段のボタンに出す（同じキーでは入れ替えない）", async () => {
    const fake = fakeLibrary();
    await render(fake.library);
    expect(tiles().map((button) => button.title)).toEqual(["ONE.JPG", "TWO.JPG", "THREE.JPG"]);
    // 何も選んでいなければ効かない
    await keyDown(document.body, { key: "p" });
    expect(fake.set).not.toHaveBeenCalled();
    expect(flagButton("採用").disabled).toBe(true);

    await click(tile("TWO.JPG"));
    await keyDown(document.body, { key: "p" });
    expect(fake.set).toHaveBeenLastCalledWith(["p2"], "pick");
    expect(mark("TWO.JPG")).toBe("採用");
    expect(flagButton("採用").getAttribute("aria-pressed")).toBe("true");
    // もう一度 P を押しても入れ替えない（送らない）
    await keyDown(tile("TWO.JPG"), { key: "P" });
    expect(fake.set).toHaveBeenCalledTimes(1);

    await keyDown(tile("TWO.JPG"), { key: "x" });
    expect(fake.set).toHaveBeenLastCalledWith(["p2"], "reject");
    expect(mark("TWO.JPG")).toBe("却下");
    expect(tile("TWO.JPG").querySelector("img")?.parentElement?.className).toContain("opacity-40");
    expect(flagButton("却下").getAttribute("aria-pressed")).toBe("true");
    // 却下しても写真は消えない（一覧に残り、選んだまま）
    expect(tiles()).toHaveLength(3);
    expect(tile("TWO.JPG").getAttribute("aria-pressed")).toBe("true");

    await keyDown(document.body, { key: "u" });
    expect(fake.set).toHaveBeenLastCalledWith(["p2"], null);
    expect(mark("TWO.JPG")).toBeNull();
    // 修飾キーつき（⌘X など）は扱わない
    await keyDown(document.body, { key: "x", metaKey: true });
    expect(fake.set).toHaveBeenCalledTimes(3);
  });

  it("複数選択の間は選んだ写真すべてに付ける。下段のボタンも同じ写真に効く", async () => {
    const fake = fakeLibrary({ initial: { p1: "pick" } });
    await render(fake.library);
    await click(tile("ONE.JPG"));
    await click(tile("THREE.JPG"), { metaKey: true });
    // 混ざっている間はどちらも押していない状態
    expect(flagButton("採用").getAttribute("aria-pressed")).toBe("false");
    await keyDown(document.body, { key: "x" });
    expect(fake.set).toHaveBeenCalledTimes(1);
    expect(new Set(fake.set.mock.calls[0]?.[0])).toEqual(new Set(["p1", "p3"]));
    expect(fake.set.mock.calls[0]?.[1]).toBe("reject");
    expect(mark("ONE.JPG")).toBe("却下");
    expect(mark("THREE.JPG")).toBe("却下");
    expect(mark("TWO.JPG")).toBeNull();
    expect(flagButton("却下").getAttribute("aria-pressed")).toBe("true");

    await click(flagButton("採用・却下を外す"));
    expect(new Set(fake.set.mock.calls[1]?.[0])).toEqual(new Set(["p1", "p3"]));
    expect(fake.set.mock.calls[1]?.[1]).toBeNull();
    expect(mark("ONE.JPG")).toBeNull();
  });

  it("絞り込みの「却下を隠す」「採用だけ」は一覧の問い合わせで渡し、外すと却下した写真が戻る。書き出しの対象は絞った写真だけ", async () => {
    const fake = fakeLibrary({ initial: { p1: "pick", p2: "reject" } });
    await render(fake.library);
    expect(mark("TWO.JPG")).toBe("却下");

    await chooseFilter("却下を隠す");
    expect(fake.list.mock.calls.at(-1)?.[0]).toMatchObject({ folderId: "f1", flag: "notRejected" });
    expect(tiles().map((button) => button.title)).toEqual(["ONE.JPG", "THREE.JPG"]);
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="絞り込み"]');
    expect(trigger?.textContent).toBe("1");

    // ⌘A は絞り込んだ写真だけを選ぶ（複数枚の書き出しの対象と件数も同じ）
    await keyDown(document.body, { key: "Escape" });
    await keyDown(document.body, { key: "a", metaKey: true });
    expect(container.textContent).toContain("2 枚を選択");
    const exportButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "書き出す" && button.closest("footer") === null,
    );
    await click(exportButton);
    const sheet = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(sheet?.textContent).toContain("選んだ 2 枚");
    expect(sheet?.textContent).not.toContain("選んだ 3 枚");
    // シートを閉じ、選択を解く（選択バーの間は絞り込みのボタンを出さない）
    await keyDown(document.body, { key: "Escape" });
    await keyDown(document.body, { key: "Escape" });

    await chooseFilter("採用だけ");
    expect(fake.list.mock.calls.at(-1)?.[0]).toMatchObject({ folderId: "f1", flag: "pick" });
    expect(tiles().map((button) => button.title)).toEqual(["ONE.JPG"]);

    await chooseFilter("すべて");
    expect(fake.list.mock.calls.at(-1)?.[0]).not.toHaveProperty("flag");
    expect(tiles().map((button) => button.title)).toEqual(["ONE.JPG", "TWO.JPG", "THREE.JPG"]);
    expect(mark("TWO.JPG")).toBe("却下");
  });

  it("「却下を隠す」の間に一覧で却下すると、その写真は隠れ、隣の写真を選んで続けられる", async () => {
    const fake = fakeLibrary();
    await render(fake.library);
    await chooseFilter("却下を隠す");
    await keyDown(document.body, { key: "Escape" });
    await click(tile("TWO.JPG"));
    await keyDown(document.body, { key: "x" });
    expect(fake.set).toHaveBeenLastCalledWith(["p2"], "reject");
    expect(tiles().map((button) => button.title)).toEqual(["ONE.JPG", "THREE.JPG"]);
    expect(tile("THREE.JPG").getAttribute("aria-pressed")).toBe("true");
    await keyDown(document.body, { key: "p" });
    expect(fake.set).toHaveBeenLastCalledWith(["p3"], "pick");
  });

  it("保存中にP/Xを続けて押しても、無視された変更で選択だけ進まない", async () => {
    const pending = deferred<Awaited<ReturnType<SetFlags>>>();
    const fake = fakeLibrary({ set: vi.fn<SetFlags>(() => pending.promise) });
    await render(fake.library);
    await chooseFilter("却下を隠す");
    await keyDown(document.body, { key: "Escape" });
    await click(tile("TWO.JPG"));

    await keyDown(document.body, { key: "p" });
    expect(fake.set).toHaveBeenCalledTimes(1);
    expect(mark("TWO.JPG")).toBe("採用");
    expect(tile("TWO.JPG").getAttribute("aria-pressed")).toBe("true");

    await keyDown(document.body, { key: "x" });
    expect(fake.set).toHaveBeenCalledTimes(1);
    expect(mark("TWO.JPG")).toBe("採用");
    expect(tile("TWO.JPG").getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      pending.resolve({ updated: 1, skipped: { notFound: 0, noOriginal: 0 } });
    });
    await settle();
    expect(tile("TWO.JPG").getAttribute("aria-pressed")).toBe("true");
  });

  it("保存できなければ印を戻し、状態欄に 1 行出す", async () => {
    const fake = fakeLibrary({ set: async () => Promise.reject(new Error("disk full")) });
    await render(fake.library);
    await click(tile("ONE.JPG"));
    await keyDown(document.body, { key: "p" });
    expect(fake.set).toHaveBeenCalledTimes(1);
    expect(mark("ONE.JPG")).toBeNull();
    expect(container.querySelector('footer [role="alert"]')?.textContent).toBe("採用・却下を変更できませんでした。");
  });
});

describe("1 枚の編集中（フィルムストリップ）の選別", () => {
  it("開いている写真に P / X / U が効き、帯の升にも印。「却下を隠す」の間は別の写真へ移るまで出したまま", async () => {
    const fake = fakeLibrary();
    await render(fake.library);
    await openFromGrid("ONE.JPG");
    expect(filmstrip()).not.toBeNull();
    expect(stripLabels()).toEqual(["ONE.JPG", "TWO.JPG", "THREE.JPG"]);

    await keyDown(document.body, { key: "p" });
    expect(fake.set).toHaveBeenLastCalledWith(["p1"], "pick");
    expect(stripLabels()[0]).toBe("ONE.JPG（採用）");
    expect(flagButton("採用").getAttribute("aria-pressed")).toBe("true");

    // 下段のボタン（押すと付き、付いている方をもう一度押すと外れる）
    await click(flagButton("却下"));
    expect(fake.set).toHaveBeenLastCalledWith(["p1"], "reject");
    expect(stripLabels()[0]).toBe("ONE.JPG（却下）");
    await click(flagButton("却下"));
    expect(fake.set).toHaveBeenLastCalledWith(["p1"], null);

    // 帯の升の上でも効く
    await keyDown(document.body, { key: "ArrowRight" });
    const current = filmstrip()?.querySelector<HTMLButtonElement>('button[aria-current="true"]');
    expect(current?.getAttribute("aria-label")).toBe("TWO.JPG");
    if (!current) throw new Error("current strip tile not found");
    await keyDown(current, { key: "x" });
    expect(fake.set).toHaveBeenLastCalledWith(["p2"], "reject");
    expect(stripLabels()[1]).toBe("TWO.JPG（却下）");
  });

  it("「却下を隠す」の間に開いている写真を却下しても閉じず、次の写真へ移ると帯から外れる", async () => {
    const fake = fakeLibrary();
    await render(fake.library);
    await chooseFilter("却下を隠す");
    await keyDown(document.body, { key: "Escape" });
    await openFromGrid("ONE.JPG");
    await keyDown(document.body, { key: "x" });
    expect(fake.set).toHaveBeenLastCalledWith(["p1"], "reject");
    expect(stripLabels()).toEqual(["ONE.JPG（却下）", "TWO.JPG", "THREE.JPG"]);
    await keyDown(document.body, { key: "ArrowRight" });
    expect(stripLabels()).toEqual(["TWO.JPG", "THREE.JPG"]);
    expect(filmstrip()?.querySelector('button[aria-current="true"]')?.getAttribute("aria-label")).toBe("TWO.JPG");
  });
});

describe("選別を使えないとき", () => {
  it("選別を持たない写真の出どころでは、ボタン・絞り込みの群を出さず、キーも効かない", async () => {
    const fake = fakeLibrary({ flags: false });
    await render(fake.library);
    await click(tile("ONE.JPG"));
    expect(flagGroup()).toBeNull();
    await keyDown(document.body, { key: "p" });
    expect(mark("ONE.JPG")).toBeNull();
    expect(fake.set).not.toHaveBeenCalled();
    await click(container.querySelector('button[aria-label="絞り込み"]'));
    expect(document.body.querySelector('[role="radiogroup"][aria-label="選別"]')).toBeNull();
    expect(document.body.querySelector('[role="radiogroup"][aria-label="種類"]')).not.toBeNull();
  });

  it("閲覧のみではキーが効かず、ボタンは押せない", async () => {
    const fake = fakeLibrary();
    await render(fake.library, { canEdit: false });
    await click(tile("ONE.JPG"));
    await keyDown(document.body, { key: "p" });
    expect(fake.set).not.toHaveBeenCalled();
    expect(flagButton("採用").disabled).toBe(true);
    expect(flagButton("却下").disabled).toBe(true);
  });
});
