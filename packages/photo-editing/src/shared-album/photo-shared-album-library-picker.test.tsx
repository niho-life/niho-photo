// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PhotoSharedAlbumLibraryPicker } from "./photo-shared-album-library-picker";
import type { PhotoSharedAlbumLibraryPage } from "./photo-shared-album-port";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); });
}

const button = (text: string) => Array.from(document.body.querySelectorAll("button")).find((element) => element.textContent?.trim() === text);
const tiles = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>("ul[aria-label='写真から選ぶ'] button"));
const page = (from: number, count: number, next: string | null): PhotoSharedAlbumLibraryPage => ({
  items: Array.from({ length: count }, (_, index) => ({ photoId: `photo-${from + index}`, thumbnailUrl: null, label: `IMG_${from + index}.JPG` })),
  next,
});

describe("PhotoSharedAlbumLibraryPicker", () => {
  it("選んだ写真を「n枚を追加」でそのまま足し、閉じる。続きは「もっと見る」で読む", async () => {
    const onAdd = vi.fn();
    const onOpenChange = vi.fn();
    const loadPage = vi.fn(async (cursor: string | null) => (cursor === null ? page(1, 3, "page-2") : page(4, 2, null)));
    await act(async () => root.render(<PhotoSharedAlbumLibraryPicker open onOpenChange={onOpenChange} loadPage={loadPage} onAdd={onAdd} />));
    await flush();
    expect(tiles().map((tile) => tile.getAttribute("aria-label"))).toEqual(["IMG_1.JPG", "IMG_2.JPG", "IMG_3.JPG"]);
    // Nothing selected: the button only says 追加 and does nothing.
    expect(button("追加")?.disabled).toBe(true);

    await act(async () => button("もっと見る")?.click());
    await flush();
    expect(loadPage).toHaveBeenLastCalledWith("page-2", expect.any(AbortSignal));
    expect(tiles()).toHaveLength(5);
    expect(button("もっと見る")).toBeUndefined();

    await act(async () => tiles()[4]?.click());
    await act(async () => tiles()[0]?.click());
    expect(tiles()[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(tiles()[1]?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => button("2枚を追加")?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onAdd).toHaveBeenCalledWith(["photo-5", "photo-1"]);
  });

  it("読めなければ再試行を出し、写真が無ければそう伝える。開き直すと選択を持ち越さない", async () => {
    let fail = true;
    const loadPage = vi.fn(async () => {
      if (fail) throw new Error("synthetic failure");
      return page(1, 2, null);
    });
    const props = { onOpenChange: vi.fn(), loadPage, onAdd: vi.fn() };
    await act(async () => root.render(<PhotoSharedAlbumLibraryPicker open {...props} />));
    await flush();
    expect(document.body.querySelector("[role='alert']")?.textContent).toContain("写真を読み込めませんでした");
    fail = false;
    await act(async () => button("再試行")?.click());
    await flush();
    expect(tiles()).toHaveLength(2);
    await act(async () => tiles()[0]?.click());
    expect(button("1枚を追加")).toBeDefined();

    await act(async () => root.render(<PhotoSharedAlbumLibraryPicker open={false} {...props} />));
    await flush();
    await act(async () => root.render(<PhotoSharedAlbumLibraryPicker open {...props} />));
    await flush();
    expect(tiles().every((tile) => tile.getAttribute("aria-pressed") === "false")).toBe(true);

    await act(async () => root.render(<PhotoSharedAlbumLibraryPicker open={false} {...props} />));
    const empty = { ...props, loadPage: vi.fn(async () => page(1, 0, null)) };
    await act(async () => root.render(<PhotoSharedAlbumLibraryPicker open {...empty} />));
    await flush();
    expect(document.body.textContent).toContain("写真がありません");
  });

  it("閉じた後に届いたページは出さない", async () => {
    let resolve!: (value: PhotoSharedAlbumLibraryPage) => void;
    const props = { onOpenChange: vi.fn(), onAdd: vi.fn(), loadPage: vi.fn(async () => await new Promise<PhotoSharedAlbumLibraryPage>((done) => { resolve = done; })) };
    await act(async () => root.render(<PhotoSharedAlbumLibraryPicker open {...props} />));
    const firstSignal = (props.loadPage.mock.calls[0] as unknown as [string | null, AbortSignal])[1];
    await act(async () => root.render(<PhotoSharedAlbumLibraryPicker open={false} {...props} />));
    expect(firstSignal.aborted).toBe(true);
    await act(async () => resolve(page(1, 2, null)));
    await flush();
    expect(tiles()).toHaveLength(0);
  });
});
