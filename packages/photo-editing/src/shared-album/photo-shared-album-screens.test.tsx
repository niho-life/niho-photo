// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PHOTO_STORAGE_LOCATION_FIXTURES, photoSharedAlbumFixtureSummaries } from "./photo-shared-album-fixtures";
import { PhotoSharedAlbumInvite } from "./photo-shared-album-invite";
import { PhotoLibraryScreenTabs, PhotoSharedAlbumList } from "./photo-shared-album-list";
import { PhotoStorageLocationSettings } from "./photo-storage-location-settings";

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
});

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((element) => element.textContent?.trim() === text);
}

describe("PhotoLibraryScreenTabs", () => {
  it("「写真」と「共有アルバム」だけを切り替え、今の画面を示す", () => {
    const onChange = vi.fn();
    act(() => root.render(<PhotoLibraryScreenTabs current="photos" onChange={onChange} />));
    const buttons = Array.from(container.querySelectorAll("nav button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["写真", "共有アルバム"]);
    expect(buttons[0].getAttribute("aria-current")).toBe("page");
    act(() => (buttons[0] as HTMLElement).click());
    expect(onChange).not.toHaveBeenCalled();
    act(() => (buttons[1] as HTMLElement).click());
    expect(onChange).toHaveBeenCalledWith("sharedAlbums");
  });
});

describe("PhotoSharedAlbumList", () => {
  it("自分のアルバムは枚数と人数、共有されたアルバムはオーナーと役割を出す", () => {
    const onOpenAlbum = vi.fn();
    act(() => root.render(<PhotoSharedAlbumList albums={photoSharedAlbumFixtureSummaries()} onOpenAlbum={onOpenAlbum} onCreateAlbum={vi.fn()} />));
    const cards = Array.from(container.querySelectorAll("ul button"));
    expect(cards).toHaveLength(4);
    expect(cards[0].textContent).toContain("12枚・3人");
    expect(cards[1].textContent).toContain("佐藤 花子さん・写真を追加できる");
    expect(cards[2].textContent).toContain("見るだけ");
    expect(cards[3].textContent).toContain("準備中 12/40");
    act(() => (cards[1] as HTMLElement).click());
    expect(onOpenAlbum).toHaveBeenCalledWith("fixture-album-2");
    expect(buttonByText("新しいアルバム")).toBeDefined();
  });

  it("空のときは状態と、作れるなら主ボタンだけを出す", () => {
    const onCreateAlbum = vi.fn();
    act(() => root.render(<PhotoSharedAlbumList albums={[]} onOpenAlbum={vi.fn()} onCreateAlbum={onCreateAlbum} />));
    expect(container.textContent).toContain("共有アルバムはまだありません");
    const create = Array.from(container.querySelectorAll("button")).filter((element) => element.textContent === "新しいアルバム");
    expect(create).toHaveLength(1);
    act(() => create[0].click());
    expect(onCreateAlbum).toHaveBeenCalledTimes(1);
  });
});

describe("PhotoSharedAlbumInvite", () => {
  it("参加の前はアルバム名・オーナー・役割と「参加する」だけを出す", () => {
    const onJoin = vi.fn();
    act(() => root.render(<PhotoSharedAlbumInvite phase="ready" albumName="週末のワークショップ" ownerName="佐藤 花子" role="contributor" onJoin={onJoin} />));
    expect(container.querySelector("h1")?.textContent).toBe("週末のワークショップ");
    expect(container.textContent).toContain("佐藤 花子さんのアルバム");
    expect(container.textContent).toContain("写真を追加できる");
    act(() => buttonByText("参加する")?.click());
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it("参加の途中は押せず、失敗したら短く知らせてもう一度押せる", () => {
    act(() => root.render(<PhotoSharedAlbumInvite phase="joining" albumName="A" ownerName="B" role="viewer" onJoin={vi.fn()} />));
    expect(buttonByText("参加しています")?.disabled).toBe(true);
    act(() => root.render(<PhotoSharedAlbumInvite phase="failed" albumName="A" ownerName="B" role="viewer" onJoin={vi.fn()} />));
    expect(container.querySelector("[role=alert]")?.textContent).toBe("参加できませんでした。もう一度お試しください。");
    expect(buttonByText("参加する")?.disabled).toBe(false);
  });

  it("使えないリンクは「このリンクは使えません」とオーナーに頼むことだけを出す", () => {
    const onGoToAlbums = vi.fn();
    act(() => root.render(<PhotoSharedAlbumInvite phase="unavailable" onGoToAlbums={onGoToAlbums} />));
    expect(container.querySelector("h1")?.textContent).toBe("このリンクは使えません");
    expect(container.textContent).toContain("オーナーに新しいリンクを頼んでください。");
    expect(buttonByText("参加する")).toBeUndefined();
    act(() => buttonByText("共有アルバムへ")?.click());
    expect(onGoToAlbums).toHaveBeenCalledTimes(1);
  });
});

describe("PhotoStorageLocationSettings", () => {
  it("NIHO クラウドを先頭に標準として出し、自前サーバーは状態だけを短く出す", () => {
    const onAddHostedMac = vi.fn();
    act(() => root.render(<PhotoStorageLocationSettings locations={PHOTO_STORAGE_LOCATION_FIXTURES} onAddHostedMac={onAddHostedMac} />));
    expect(container.querySelector("h2")?.textContent).toBe("保存先");
    const rows = Array.from(container.querySelectorAll("li")).map((row) => row.textContent);
    expect(rows[0]).toBe("NIHO クラウド1.2 / 5 GB標準");
    expect(rows[1]).toBe("自宅の Mac mini休止中・Mac の起動後に更新");
    expect(rows[2]).toBe("この Mac");
    act(() => buttonByText("自前サーバーを追加")?.click());
    expect(onAddHostedMac).toHaveBeenCalledTimes(1);
  });

  it("追加の流れが無ければ追加ボタンを出さない", () => {
    act(() => root.render(<PhotoStorageLocationSettings locations={PHOTO_STORAGE_LOCATION_FIXTURES.slice(1, 2)} />));
    expect(buttonByText("自前サーバーを追加")).toBeUndefined();
  });
});
