// @vitest-environment jsdom

import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PhotoEditingGrid,
  PhotoEditingTileImage,
  countPhotoEditingGridColumns,
  type PhotoEditingGridItem,
  type PhotoEditingGridMore,
} from "./photo-editing-grid";
import { PhotoEditingImageCorsProvider } from "./photo-editing-image-cors";

const ITEMS: PhotoEditingGridItem[] = [
  { key: "c1", fileName: "P1524180.RW2", thumbnail: { url: "https://example.test/c1.jpg", failed: false }, raw: true, cloud: false },
  { key: "c2", fileName: "IMG_0002.JPG", thumbnail: { url: null, failed: true }, raw: false, cloud: true },
  { key: "c3", fileName: "IMG_0003.JPG", thumbnail: { url: null, failed: false }, raw: false, cloud: false, opening: true },
];

/** 下まで見たら続きを読むための IntersectionObserver（テストで交差を起こす） */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit | undefined;
  readonly targets: Element[] = [];
  disconnected = false;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  static latest(): FakeIntersectionObserver | undefined {
    return FakeIntersectionObserver.instances.filter((observer) => !observer.disconnected).at(-1);
  }

  intersect(): void {
    this.callback(
      this.targets.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

let container: HTMLDivElement;
let root: Root;
let onTileClick: ReturnType<typeof vi.fn<(key: string, event: { metaKey: boolean; shiftKey: boolean }) => void>>;
let onTileOpen: ReturnType<typeof vi.fn<(key: string) => void>>;
let onTileKeyDown: ReturnType<typeof vi.fn<(key: string, event: { key: string }) => void>>;
let tileRefs: Map<string, HTMLButtonElement>;
let originalIntersectionObserver: typeof IntersectionObserver | undefined;

async function renderGrid(
  options: {
    items?: PhotoEditingGridItem[];
    selectedKeys?: string[];
    activeKey?: string | null;
    loading?: boolean;
    meta?: ReactNode;
    placeholder?: ReactNode;
    more?: PhotoEditingGridMore;
  } = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <PhotoEditingGrid
        items={options.items ?? ITEMS}
        selectedKeys={new Set(options.selectedKeys ?? [])}
        activeKey={options.activeKey ?? null}
        loading={options.loading}
        meta={options.meta}
        placeholder={options.placeholder}
        more={options.more}
        listRef={createRef<HTMLUListElement>() as { current: HTMLUListElement | null }}
        tileRef={(key, element) => {
          if (element) tileRefs.set(key, element);
          else tileRefs.delete(key);
        }}
        onTileClick={(key, event) => onTileClick(key, { metaKey: event.metaKey, shiftKey: event.shiftKey })}
        onTileOpen={onTileOpen}
        onTileKeyDown={(key, event) => onTileKeyDown(key, { key: event.key })}
      />,
    );
  });
}

function tiles(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('section[aria-label="写真の一覧"] li > button'));
}

function tile(fileName: string): HTMLButtonElement {
  const found = tiles().find((button) => button.title === fileName);
  if (!found) throw new Error(`tile not found: ${fileName}`);
  return found;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onTileClick = vi.fn();
  onTileOpen = vi.fn();
  onTileKeyDown = vi.fn();
  tileRefs = new Map();
  FakeIntersectionObserver.instances = [];
  originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  if (originalIntersectionObserver) globalThis.IntersectionObserver = originalIntersectionObserver;
  else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

describe("PhotoEditingGrid", () => {
  it("4:3 のタイルにセルいっぱいのサムネイル・RAW の印・雲の印・ファイル名を並べ、選んだ写真は緑の枠と印を付ける", async () => {
    await renderGrid({ selectedKeys: ["c2"], meta: <p>使用量</p> });

    expect(tiles().map((button) => button.title)).toEqual(["P1524180.RW2", "IMG_0002.JPG", "IMG_0003.JPG"]);
    const cell = tile("P1524180.RW2").querySelector<HTMLElement>("span.aspect-\\[4\\/3\\]");
    expect(cell?.className).toContain("rounded-[10px]");
    const image = cell?.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://example.test/c1.jpg");
    expect(image?.getAttribute("alt")).toBe("");
    expect(image?.className).toContain("object-cover");
    // RAW の印は読ませない（写真名の拡張子と重なる）
    const raw = Array.from(cell?.querySelectorAll("span") ?? []).find((span) => span.textContent === "RAW");
    expect(raw?.getAttribute("aria-hidden")).toBe("true");
    expect(tile("IMG_0003.JPG").textContent).not.toContain("RAW");

    // 読み上げは写真名が先（見た目ではタイルの下）、雲の印は「クラウドの写真」
    const selected = tile("IMG_0002.JPG");
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(selected.firstElementChild?.textContent).toBe("IMG_0002.JPG");
    expect(selected.firstElementChild?.className).toContain("order-last");
    expect(selected.querySelector('[aria-label="クラウドの写真"]')).not.toBeNull();
    const selectedCell = selected.querySelector<HTMLElement>("span.aspect-\\[4\\/3\\]");
    expect(selectedCell?.className).toContain("ring-niho-accent-ink");
    expect(selectedCell?.querySelector(".niho-accent-surface")).not.toBeNull();
    // 作れなかったサムネイルは写真名の頭の 1 文字
    expect(selectedCell?.querySelector("img")).toBeNull();
    expect(Array.from(selectedCell?.querySelectorAll("span") ?? []).some((span) => span.textContent === "I")).toBe(true);
    expect(tile("P1524180.RW2").getAttribute("aria-pressed")).toBe("false");
    expect(tile("P1524180.RW2").querySelector(".niho-accent-surface")).toBeNull();
    // 開いている途中のタイルには Spinner
    expect(tile("IMG_0003.JPG").querySelector(".animate-spin")).not.toBeNull();
    // 右上の 1 行
    expect(container.textContent).toContain("使用量");
  });

  it("タイルにはサムネイル・ファイル名・RAW の印だけを出し、「元の写真なし」「プレビューなし」の印は付けない（S7 #16946。記事の画像は木で分ける）", async () => {
    const items: PhotoEditingGridItem[] = [
      {
        key: "c1",
        fileName: "P1524180.RW2",
        thumbnail: { url: "https://example.test/c1.jpg", failed: false },
        raw: true,
        cloud: false,
      },
      { key: "c2", fileName: "IMG_0002.JPG", thumbnail: { url: null, failed: true }, raw: false, cloud: false },
    ];
    await renderGrid({ items, selectedKeys: ["c1"] });

    for (const fileName of ["P1524180.RW2", "IMG_0002.JPG"]) {
      expect(tile(fileName).textContent).not.toContain("元の写真なし");
      expect(tile(fileName).textContent).not.toContain("プレビューなし");
      expect(tile(fileName).textContent).not.toContain("オリジナル");
    }
    // サムネイルはそのまま出し、選ぶこともできる
    expect(tile("P1524180.RW2").querySelector("img")?.getAttribute("src")).toBe("https://example.test/c1.jpg");
    expect(tile("P1524180.RW2").getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      tile("P1524180.RW2").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onTileClick).toHaveBeenCalledWith("c1", { metaKey: false, shiftKey: false });
  });

  it("幾何（切り抜き・回転）を渡したタイルは、画像の実寸が分かるまで透明にし、読み込んだら切り抜きの箱に入れて行列を当てる（#17138）", async () => {
    await renderGrid({
      items: [
        {
          key: "g1",
          fileName: "P1.RW2",
          thumbnail: { url: "https://example.test/g1.jpg", failed: false },
          raw: true,
          cloud: false,
          geometry: { rotate: 90 },
        },
        { key: "g2", fileName: "P2.JPG", thumbnail: { url: "https://example.test/g2.jpg", failed: false }, raw: false, cloud: false },
      ],
    });
    const [cropped, plain] = Array.from(container.querySelectorAll("img"));
    expect(cropped.style.opacity).toBe("0");
    expect(cropped.className).toContain("object-cover");
    expect(plain.style.opacity).toBe("");
    Object.defineProperty(cropped, "naturalWidth", { value: 3000 });
    Object.defineProperty(cropped, "naturalHeight", { value: 2000 });
    await act(async () => {
      cropped.dispatchEvent(new Event("load"));
    });
    const loaded = container.querySelector<HTMLImageElement>('img[src="https://example.test/g1.jpg"]');
    expect(loaded?.style.opacity).toBe("");
    expect(loaded?.style.transform).toContain("matrix(0, 1, -1, 0, 0, 0)");
    expect(loaded?.parentElement?.style.aspectRatio).toBe("2000 / 3000");
    expect(loaded?.parentElement?.style.overflow).toBe("hidden");
  });

  it("追加している途中の写真（adding）には薄い幕と回転を重ね、送った割合を下端の細い帯で出す。上げ終わるまで押せない", async () => {
    await renderGrid({
      items: [
        {
          key: "adding",
          fileName: "IMG_0412.JPG",
          thumbnail: { url: "blob:preview", failed: false },
          raw: false,
          cloud: false,
          adding: { fraction: 0.42 },
        },
        { key: "waiting", fileName: "P1.RW2", thumbnail: { url: null, failed: true }, raw: true, cloud: false, adding: { fraction: null } },
        { key: "done", fileName: "IMG_0001.JPG", thumbnail: { url: null, failed: true }, raw: false, cloud: false },
      ],
    });

    const adding = tile("IMG_0412.JPG");
    expect(adding.disabled).toBe(true);
    expect(adding.querySelector("img")?.getAttribute("src")).toBe("blob:preview");
    expect(adding.querySelector(".animate-spin")).not.toBeNull();
    // 読み上げは写真名と「追加中」
    expect(adding.textContent).toContain("追加中");
    const bar = adding.querySelector<HTMLElement>(".bg-niho-accent-ink");
    expect(bar?.style.width).toBe("42%");
    // 割合が分からない間は帯を出さない。RAW の印はそのまま（ほかの印は無い）
    const waiting = tile("P1.RW2");
    expect(waiting.disabled).toBe(true);
    expect(waiting.querySelector(".bg-niho-accent-ink")).toBeNull();
    expect(waiting.textContent).toContain("RAW");
    expect(waiting.textContent).not.toContain("元の写真なし");
    // 追加し終えた写真は押せる
    expect(tile("IMG_0001.JPG").disabled).toBe(false);
    expect(tile("IMG_0001.JPG").querySelector(".animate-spin")).toBeNull();
    expect(tile("IMG_0001.JPG").textContent).not.toContain("追加中");
  });

  it("押す・ダブルクリック・キーは画面へ伝える（どれを選ぶかは画面が決める）。タイルの要素も渡す", async () => {
    await renderGrid();

    await act(async () => {
      tile("IMG_0002.JPG").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    });
    expect(onTileClick).toHaveBeenCalledWith("c2", { metaKey: true, shiftKey: false });

    await act(async () => {
      tile("IMG_0003.JPG").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onTileOpen).toHaveBeenCalledWith("c3");

    await act(async () => {
      tile("P1524180.RW2").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(onTileKeyDown).toHaveBeenCalledWith("c1", { key: "ArrowDown" });
    expect([...tileRefs.keys()]).toEqual(["c1", "c2", "c3"]);
  });

  it("写真が無いときは中央に空状態を出し（右上の 1 行は出さない）、読み込み中はタイルの形の仮の面を並べる", async () => {
    await renderGrid({ items: [], meta: <p>使用量</p>, placeholder: <p>クラウドに写真はありません</p> });
    expect(tiles()).toHaveLength(0);
    expect(container.textContent).toContain("クラウドに写真はありません");
    expect(container.textContent).not.toContain("使用量");

    await renderGrid({ items: [], loading: true, placeholder: <p>空</p> });
    expect(container.querySelector('section[aria-label="写真の一覧"]')?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("空");
  });

  it("右上の 1 行（使用量・「クラウドから消す」）は一覧を下へ送っても上に残り、送った先のタイルはその下に来る（#16687）", async () => {
    await renderGrid({ meta: <button type="button">クラウドから消す</button> });
    const section = container.querySelector<HTMLElement>('section[aria-label="写真の一覧"]');
    const row = Array.from(section?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "クラウドから消す",
    )?.parentElement;
    // 上の余白の分も白で覆い、ボタン（32px）の高さで固定する（写真を選んでボタンが出ても一覧を動かさない）
    expect(row?.className).toContain("sticky");
    expect(row?.className).toContain("-top-2.5");
    expect(row?.className).toContain("bg-[var(--photo-editing-surface,white)]");
    expect(row?.className).toContain("h-8");
    expect(section?.className).toContain("scroll-pt-12");

    // 右上の 1 行が無ければ、送り先の余白も付けない
    await renderGrid();
    expect(container.querySelector('section[aria-label="写真の一覧"]')?.className).not.toContain("scroll-pt-12");
  });

  it("下まで見たら続きを読み、読めなければ理由と「再読み込み」を出す。続きが無ければ見張らない", async () => {
    const onLoad = vi.fn();
    await renderGrid({ more: { hasMore: true, loading: false, failedMessage: null, onLoad } });

    const observer = FakeIntersectionObserver.latest();
    expect(observer?.options?.root).toBe(container.querySelector('section[aria-label="写真の一覧"]'));
    await act(async () => {
      observer?.intersect();
    });
    expect(onLoad).toHaveBeenCalledTimes(1);

    await renderGrid({ more: { hasMore: true, loading: true, failedMessage: null, onLoad } });
    expect(FakeIntersectionObserver.latest()).toBeUndefined();
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("続きを読み込み中");

    await renderGrid({ more: { hasMore: true, loading: false, failedMessage: "読み込めませんでした。", onLoad } });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("読み込めませんでした。");
    await act(async () => {
      alert?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onLoad).toHaveBeenCalledTimes(2);

    await renderGrid({ more: { hasMore: false, loading: false, failedMessage: null, onLoad } });
    expect(FakeIntersectionObserver.latest()).toBeUndefined();
  });

  it("出した直後は表示中の写真が見える位置まで送る", async () => {
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      await renderGrid({ activeKey: "c3" });
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(tile("IMG_0003.JPG"));
      // 出した後に表示中の写真が変わっても送らない（押した・キーで移ったタイルは見えている）
      await renderGrid({ activeKey: "c1" });
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});

describe("countPhotoEditingGridColumns", () => {
  it("1 行目に並んでいるタイルの数を、タイルの縦の位置から数える", () => {
    const list = document.createElement("ul");
    const tops = [0, 0, 0, 120, 120];
    for (const top of tops) {
      const item = document.createElement("li");
      Object.defineProperty(item, "offsetTop", { value: top });
      list.appendChild(item);
    }
    expect(countPhotoEditingGridColumns(list)).toBe(3);
    expect(countPhotoEditingGridColumns(null)).toBe(1);
    expect(countPhotoEditingGridColumns(document.createElement("ul"))).toBe(1);
  });
});

describe("PhotoEditingTileImage（幾何が後から付いたタイル）", () => {
  let tileContainer: HTMLDivElement;
  let tileRoot: Root;

  beforeEach(() => {
    tileContainer = document.createElement("div");
    document.body.appendChild(tileContainer);
    tileRoot = createRoot(tileContainer);
  });

  afterEach(async () => {
    await act(async () => tileRoot.unmount());
    tileContainer.remove();
  });

  /** jsdom は画像を読み込まないので、読み込み済み（`complete`・実寸）の状態を要素に与える */
  function markLoaded(image: HTMLImageElement | null, width: number, height: number) {
    if (!image) throw new Error("img not found");
    Object.defineProperty(image, "complete", { value: true, configurable: true });
    Object.defineProperty(image, "naturalWidth", { value: width, configurable: true });
    Object.defineProperty(image, "naturalHeight", { value: height, configurable: true });
  }

  it("画像を読み込んだ後で幾何が付いても、実寸を読んで幾何を当てる（空白のまま残らない）", async () => {
    const url = "https://example.test/tile.jpg";
    await act(async () => tileRoot.render(<PhotoEditingTileImage url={url} geometry={null} />));
    markLoaded(tileContainer.querySelector("img"), 512, 341);
    expect(tileContainer.querySelector("img")?.style.opacity).toBe("");
    // 1 枚で 90° 回転を確定した直後: 画像は読み込み済みで load は来ない
    await act(async () =>
      tileRoot.render(<PhotoEditingTileImage url={url} geometry={{ rotate: 90, flipH: false, flipV: false, angle: 0 }} />),
    );
    const image = tileContainer.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.style.opacity).not.toBe("0");
    expect(image?.parentElement?.tagName).toBe("SPAN");
  });

  it("まだ読み込んでいない間は、幾何があっても透明にする（切り抜く前の画を見せない）", async () => {
    const url = "https://example.test/tile.jpg";
    await act(async () =>
      tileRoot.render(<PhotoEditingTileImage url={url} geometry={{ rotate: 90, flipH: false, flipV: false, angle: 0 }} />),
    );
    expect(tileContainer.querySelector("img")?.style.opacity).toBe("0");
  });

  it("分離文書用 provider は CORS 属性を src より前に付ける", async () => {
    await act(async () =>
      tileRoot.render(
        <PhotoEditingImageCorsProvider enabled>
          <PhotoEditingTileImage url="https://example.test/signed.jpg?token=fixture" geometry={null} />
        </PhotoEditingImageCorsProvider>,
      ),
    );
    const image = tileContainer.querySelector("img");
    const attributes = image?.getAttributeNames() ?? [];
    expect(image?.getAttribute("crossorigin")).toBe("anonymous");
    expect(attributes.indexOf("crossorigin")).toBeLessThan(attributes.indexOf("src"));
  });

  it("provider が無いときは非分離文書の画像属性を変えない", async () => {
    await act(async () => tileRoot.render(<PhotoEditingTileImage url="https://example.test/a.jpg" geometry={null} />));
    expect(tileContainer.querySelector("img")?.hasAttribute("crossorigin")).toBe(false);
  });

  it("URL が替わったら、前の画像の実寸は使わず読み直す", async () => {
    const geometry = { rotate: 90, flipH: false, flipV: false, angle: 0 };
    await act(async () => tileRoot.render(<PhotoEditingTileImage url="https://example.test/a.jpg" geometry={geometry} />));
    markLoaded(tileContainer.querySelector("img"), 512, 341);
    await act(async () => tileRoot.render(<PhotoEditingTileImage url="https://example.test/a.jpg" geometry={{ ...geometry }} />));
    expect(tileContainer.querySelector("img")?.parentElement?.tagName).toBe("SPAN");
    // 別の画像（まだ読み込んでいない）に替わる
    await act(async () => tileRoot.render(<PhotoEditingTileImage url="https://example.test/b.jpg" geometry={geometry} />));
    const next = tileContainer.querySelector("img");
    expect(next?.getAttribute("src")).toBe("https://example.test/b.jpg");
    expect(next?.parentElement?.tagName).not.toBe("SPAN");
    expect(next?.style.opacity).toBe("0");
  });
});
