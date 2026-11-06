// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));

vi.mock("niho-ui/app-dialog", () => ({ appDialog: { confirm: mocks.confirm } }));
vi.mock("niho-ui/components/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div data-testid="add-menu">{children}</div>,
}));

import {
  PHOTO_SHARED_ALBUM_FIXTURE_ALBUM,
  PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE,
  photoSharedAlbumFixtureItem,
  photoSharedAlbumFixtureItems,
  photoSharedAlbumFixtureUploads,
} from "./photo-shared-album-fixtures";
import type { PhotoSharedAlbum, PhotoSharedAlbumItem, PhotoSharedAlbumUpload } from "./photo-shared-album-model";
import { PhotoSharedAlbumView, type PhotoSharedAlbumViewProps } from "./photo-shared-album-view";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.confirm.mockReset();
  mocks.confirm.mockImplementation(async () => true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function props(overrides: Partial<PhotoSharedAlbumViewProps> = {}): PhotoSharedAlbumViewProps {
  return {
    album: PHOTO_SHARED_ALBUM_FIXTURE_ALBUM,
    items: photoSharedAlbumFixtureItems(),
    uploads: [],
    showOriginalsNote: false,
    onBack: vi.fn(),
    onOpenShare: vi.fn(),
    onAddFiles: vi.fn(),
    onSave: vi.fn(),
    onRetryUpload: vi.fn(),
    onDismissUploads: vi.fn(),
    ...overrides,
  };
}

function render(viewProps: PhotoSharedAlbumViewProps) {
  act(() => root.render(<PhotoSharedAlbumView {...viewProps} />));
}

function album(overrides: Partial<PhotoSharedAlbum>): PhotoSharedAlbum {
  return { ...PHOTO_SHARED_ALBUM_FIXTURE_ALBUM, ...overrides };
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((element) => element.textContent?.trim() === text);
}

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((element) => element.getAttribute("aria-label") === label);
}

function tiles(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("ul[aria-label] button"));
}

function click(element: Element | undefined | null) {
  if (!element) throw new Error("element not found");
  act(() => (element as HTMLElement).click());
}

describe("PhotoSharedAlbumView", () => {
  it("写真のグリッドを主役にし、削除済みは出さず、新着には追加者の名前を載せる", () => {
    render(props());
    const labels = tiles().map((tile) => tile.getAttribute("aria-label"));
    expect(labels).toHaveLength(11);
    expect(labels[0]).toBe("写真 1/11、佐藤 花子さんが追加、新着");
    expect(container.textContent).toContain("佐藤 花子");
    expect(container.textContent).toContain("とても長い名前の拠点スタッフ山田太郎");
    expect(container.textContent).not.toMatch(/ownerPhoto|memberEdit|fileUpload|preparing|published|updatePending|contributor|viewer/);
  });

  it("自分が足した新着には追加者の札を付けない", () => {
    const items = [
      photoSharedAlbumFixtureItem(0, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributorSelf, isNew: true }),
      photoSharedAlbumFixtureItem(1, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.owner, isNew: true }),
    ];
    render(props({ album: album({ role: "contributor" }), items }));
    const [mine, others] = tiles();
    expect(mine.textContent).not.toContain("あなた");
    expect(others.textContent).toContain("中村");
  });

  it("見るだけのメンバーには「追加」を出さず、役割を見出しの下に出す", () => {
    const items = photoSharedAlbumFixtureItems().map((item) => ({ ...item, addedBy: { ...item.addedBy, isSelf: false } }));
    render(props({ album: album({ role: "viewer" }), items }));
    expect(buttonByText("追加")).toBeUndefined();
    expect(container.querySelector("input[type=file]")).not.toBeNull();
    expect(container.textContent).toContain("見るだけ");
    // 準備中（他人の写真）は見るだけのメンバーに見せない
    expect(tiles().some((tile) => tile.getAttribute("aria-label")?.includes("準備中"))).toBe(false);
    expect(buttonByLabel("メンバー")).toBeDefined();
  });

  it("「追加」はファイルを選ぶ画面を開き、選んだファイルを確認なしでそのまま渡す", () => {
    const onAddFiles = vi.fn();
    render(props({ album: album({ role: "contributor" }), onAddFiles }));
    const input = container.querySelector<HTMLInputElement>("input[type=file]");
    if (!input) throw new Error("input not found");
    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);
    const inputClick = vi.spyOn(input, "click").mockImplementation(() => undefined);
    click(buttonByText("追加"));
    expect(inputClick).toHaveBeenCalledTimes(1);

    const file = new File([new Uint8Array([1, 2, 3])], "IMG_0001.JPG", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onAddFiles).toHaveBeenCalledWith([file]);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("フォルダを落としたあと別アルバムへ移ったら、遅れて読めた写真を追加しない", async () => {
    const pendingRead: { release?: (entries: Array<{ isFile: boolean; isDirectory: boolean; name: string }>) => void } = {};
    let readCount = 0;
    const file = new File([new Uint8Array([1, 2, 3])], "IMG_0002.JPG", { type: "image/jpeg" });
    const fileEntry = {
      isFile: true,
      isDirectory: false,
      name: file.name,
      file: (onFile: (value: File) => void) => onFile(file),
    };
    const directory = {
      isFile: false,
      isDirectory: true,
      name: "photos",
      createReader: () => ({
        readEntries: (onEntries: (entries: Array<{ isFile: boolean; isDirectory: boolean; name: string }>) => void) => {
          if (readCount++ === 0) pendingRead.release = onEntries;
          else onEntries([]);
        },
      }),
    };
    const onAddFiles = vi.fn();
    const firstAlbum = album({ albumId: "album-a" });
    const viewProps = props({ album: firstAlbum, onAddFiles });
    render(viewProps);

    const section = container.querySelector("section");
    if (!section) throw new Error("section not found");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: ["Files"],
        items: [{ kind: "file", webkitGetAsEntry: () => directory }],
        files: [],
      },
    });
    act(() => section.dispatchEvent(drop));
    if (!pendingRead.release) throw new Error("directory enumeration did not start");

    render({ ...viewProps, album: album({ albumId: "album-b" }) });
    const release = pendingRead.release;
    await act(async () => {
      release([fileEntry]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onAddFiles).not.toHaveBeenCalled();
  });

  it("本人の「写真」から選べるときは、写真とファイルの 2 つの出どころを出す", () => {
    const onAddFromLibrary = vi.fn();
    render(props({ onAddFromLibrary }));
    const menu = container.querySelector("[data-testid=add-menu]");
    expect(menu?.querySelector("[role=menu]")).not.toBeNull();
    click(Array.from(menu?.querySelectorAll("button") ?? []).find((element) => element.textContent?.includes("写真から選ぶ")));
    expect(onAddFromLibrary).toHaveBeenCalledTimes(1);
  });

  it("容量がいっぱいのときは「追加」を押せず、メンバーには短い理由だけを出す", () => {
    render(props({ album: album({ role: "contributor", capacity: { state: "full", ownerUsage: null } }) }));
    expect(buttonByText("追加")?.disabled).toBe(true);
    expect(container.querySelector("[role=alert]")?.textContent).toBe("アルバムがいっぱいです");
  });

  it("容量がいっぱいのとき、オーナーには使用量と次の操作を出す", () => {
    const onOpenStorage = vi.fn();
    render(props({
      album: album({ capacity: { state: "full", ownerUsage: { usedBytes: 5 * 1024 ** 3, quotaBytes: 5 * 1024 ** 3 } } }),
      onOpenStorage,
    }));
    expect(container.querySelector("[role=alert]")?.textContent).toContain("容量がいっぱいです（5 / 5 GB）");
    click(buttonByText("容量を確認"));
    expect(onOpenStorage).toHaveBeenCalledTimes(1);
  });

  it("常設 Mac の起動待ちは「Mac の起動後に更新」を出し、一覧と保存は止めない", () => {
    const items = photoSharedAlbumFixtureItems().map((item) =>
      item.state === "preparing" || item.state === "updatePending" ? { ...item, pendingReason: "waitingForHost" as const } : item);
    render(props({ items }));
    expect(container.querySelector("[role=status]")?.textContent).toBe("Mac の起動後に更新");
    expect(tiles().filter((tile) => tile.getAttribute("aria-label")?.includes("Mac の起動後に更新"))).toHaveLength(2);
    expect(buttonByText("選択")).toBeDefined();
  });

  it("追加した端末の起動待ちは「追加した端末の起動後に更新」を出す", () => {
    const items = [
      photoSharedAlbumFixtureItem(0),
      photoSharedAlbumFixtureItem(1, {
        addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributorSelf,
        kind: "memberEdit",
        state: "preparing",
        thumbnailUrl: null,
        pendingReason: "waitingForDevice",
      }),
    ];
    render(props({ album: album({ role: "contributor" }), items }));
    expect(container.querySelector("[role=status]")?.textContent).toBe("追加した端末の起動後に更新");
    expect(tiles()[1].getAttribute("aria-label")).toBe("写真 2/2、あなたが追加、追加した端末の起動後に更新");
    // タイルの字は短いまま（全文は読み上げ名と 1 行）
    expect(tiles()[1].textContent).toBe("準備中");
  });

  it("容量不足で止めた項目は、オーナーには「容量が足りません」、追加したメンバーには「アルバムがいっぱいです」を 1 行で示す", () => {
    const stopped = (addedBy: typeof PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE[keyof typeof PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE]) => [
      photoSharedAlbumFixtureItem(0),
      photoSharedAlbumFixtureItem(1, { addedBy, kind: "fileUpload", state: "preparing", thumbnailUrl: null, pendingReason: "quotaExceeded" }),
    ];
    const onOpenStorage = vi.fn();
    render(props({ items: stopped(PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributor), onOpenStorage }));
    expect(container.querySelector("[role=alert]")?.textContent).toContain("容量が足りません");
    expect(tiles()[1].textContent).toBe("容量が足りません");
    click(buttonByText("容量を確認"));
    expect(onOpenStorage).toHaveBeenCalledTimes(1);

    render(props({ album: album({ role: "contributor" }), items: stopped(PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributorSelf) }));
    expect(container.querySelector("[role=alert]")?.textContent).toBe("アルバムがいっぱいです");
    expect(tiles()[1].getAttribute("aria-label")).toBe("写真 2/2、あなたが追加、アルバムがいっぱいです");
    expect(buttonByText("容量を確認")).toBeUndefined();
    expect(container.textContent).not.toMatch(/quotaExceeded/);
  });

  it("選択すると主操作が「保存」になり、準備中の項目は選べない", () => {
    const onSave = vi.fn();
    render(props({ onSave }));
    click(buttonByText("選択"));
    expect(buttonByText("追加")).toBeUndefined();
    const save = buttonByText("保存");
    expect(save?.disabled).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("選択を終了");

    const all = tiles();
    click(all[0]);
    click(all[3]);
    const preparing = all.find((tile) => tile.getAttribute("aria-label")?.includes("準備中"));
    expect(preparing?.getAttribute("aria-disabled")).toBe("true");
    click(preparing);
    expect(all[0].getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("2枚を選択");
    click(buttonByText("保存"));
    expect(onSave).toHaveBeenCalledWith(["fixture-item-0", "fixture-item-3"]);
  });

  it("Escape で選択を終え、フォーカスを「選択」へ戻す", () => {
    render(props());
    click(buttonByText("選択"));
    click(tiles()[0]);
    act(() => {
      container.querySelector("section")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(buttonByText("保存")).toBeUndefined();
    expect(document.activeElement?.textContent).toBe("選択");
    expect(tiles()[0].hasAttribute("aria-pressed")).toBe(false);
  });

  it("1 枚を開けないときは、タイルを押すとその写真を選んで選択を始める", () => {
    render(props());
    click(tiles()[1]);
    expect(container.textContent).toContain("1枚を選択");
    expect(tiles()[1].getAttribute("aria-pressed")).toBe("true");
  });

  it("1 枚を開けるときは、タイルを押すとその写真を開く", () => {
    const onOpenItem = vi.fn();
    render(props({ onOpenItem }));
    click(tiles()[2]);
    expect(onOpenItem).toHaveBeenCalledWith("fixture-item-2");
    expect(buttonByText("保存")).toBeUndefined();
  });

  it("「写真を追加できる」は自分の項目だけを選んでいるときに外せ、確認してから外す", async () => {
    const mine = PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributorSelf;
    const items: PhotoSharedAlbumItem[] = [
      photoSharedAlbumFixtureItem(0, { addedBy: mine, kind: "memberEdit" }),
      photoSharedAlbumFixtureItem(1, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.owner }),
    ];
    const onRemove = vi.fn(async () => undefined);
    render(props({ album: album({ role: "contributor" }), items, onRemove }));
    click(buttonByText("選択"));
    click(tiles()[0]);
    expect(buttonByText("アルバムから外す")).toBeDefined();
    click(tiles()[1]);
    expect(buttonByText("アルバムから外す")).toBeUndefined();
    click(tiles()[1]);

    await act(async () => {
      buttonByText("アルバムから外す")?.click();
    });
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "1枚をアルバムから外しますか？", description: "元の写真は消えません。", variant: "danger" }));
    expect(onRemove).toHaveBeenCalledWith(["fixture-item-0"]);
    expect(buttonByText("保存")).toBeUndefined();
  });

  it("外せなかったときは選択を残して短く知らせる", async () => {
    const onRemove = vi.fn(async () => {
      throw new Error("denied");
    });
    render(props({ onRemove }));
    click(buttonByText("選択"));
    click(tiles()[0]);
    await act(async () => {
      buttonByText("アルバムから外す")?.click();
    });
    expect(container.querySelector("[role=alert]")?.textContent).toBe("できませんでした。もう一度お試しください。");
    expect(buttonByText("保存")).toBeDefined();
  });

  it("確認でやめたら外さない", async () => {
    mocks.confirm.mockImplementation(async () => false);
    const onRemove = vi.fn(async () => undefined);
    render(props({ onRemove }));
    click(buttonByText("選択"));
    click(tiles()[0]);
    await act(async () => {
      buttonByText("アルバムから外す")?.click();
    });
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("アルバムが替わったら選択を捨てる", () => {
    const viewProps = props();
    render(viewProps);
    click(buttonByText("選択"));
    click(tiles()[0]);
    render({ ...viewProps, album: album({ albumId: "another-album", name: "別のアルバム" }) });
    expect(buttonByText("保存")).toBeUndefined();
    expect(tiles()[0].hasAttribute("aria-pressed")).toBe(false);
  });

  it("解除後は理由と戻る操作だけを出し、追加・共有・選択を出さない", () => {
    const onBack = vi.fn();
    render(props({ album: album({ role: "contributor", accessEnded: true }), onBack }));
    expect(container.querySelector("[role=alert]")?.textContent).toContain("このアルバムは見られなくなりました");
    // 手元に残った縮小画像も出さない
    expect(tiles()).toHaveLength(0);
    expect(container.querySelector("img")).toBeNull();
    expect(buttonByText("追加")).toBeUndefined();
    expect(buttonByText("選択")).toBeUndefined();
    expect(buttonByLabel("メンバー")).toBeUndefined();
    click(buttonByText("共有アルバムへ"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("解除後は追加中の写真があっても、アルバム名・進捗・再試行を出さない", () => {
    render(props({ album: album({ role: "contributor", accessEnded: true }), uploads: photoSharedAlbumFixtureUploads(), showOriginalsNote: true }));
    expect(container.textContent).not.toContain(PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.name);
    expect(container.querySelector("section[aria-label='追加の進捗']")).toBeNull();
    expect(buttonByText("再試行")).toBeUndefined();
    expect(container.textContent).not.toContain("IMG_0412.JPG");
    expect(container.querySelector("h1")?.textContent).toBe("このアルバムは見られなくなりました");
  });

  it("選択している間はドロップを受けない（保存の操作と混ぜない）", () => {
    render(props({ album: album({ role: "contributor" }) }));
    const section = container.querySelector("section");
    const dragEnter = () => {
      const event = new Event("dragenter", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], dropEffect: "none" } });
      act(() => {
        section?.dispatchEvent(event);
      });
    };
    const dragLeave = () => {
      const event = new Event("dragleave", { bubbles: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"] } });
      act(() => {
        section?.dispatchEvent(event);
      });
    };
    dragEnter();
    expect(container.querySelector("[data-testid=photo-shared-album-drop-overlay]")).not.toBeNull();
    dragLeave();
    click(buttonByText("選択"));
    dragEnter();
    expect(container.querySelector("[data-testid=photo-shared-album-drop-overlay]")).toBeNull();
  });

  it("外している途中にアルバムが替わったら、前のアルバムの結果を今のアルバムへ反映しない", async () => {
    let settleRemove: (failed: boolean) => void = () => undefined;
    const onRemove = vi.fn(() => new Promise<void>((resolve, reject) => {
      settleRemove = (failed) => (failed ? reject(new Error("denied")) : resolve());
    }));
    const viewProps = props({ onRemove });
    render(viewProps);
    click(buttonByText("選択"));
    click(tiles()[0]);
    await act(async () => {
      buttonByText("アルバムから外す")?.click();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);

    const another = { ...viewProps, album: album({ albumId: "another-album", name: "別のアルバム" }) };
    render(another);
    click(buttonByText("選択"));
    click(tiles()[1]);
    // 前のアルバムの処理中でも、今のアルバムの保存は押せる
    expect(buttonByText("保存")?.disabled).toBe(false);
    await act(async () => {
      settleRemove(true);
      await Promise.resolve();
    });
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(container.textContent).toContain("1枚を選択");
    expect(tiles()[1].getAttribute("aria-pressed")).toBe("true");
  });

  it("確かめている間にアルバムが替わったら、前のアルバムの項目を外さない", async () => {
    let answer: (value: boolean) => void = () => undefined;
    mocks.confirm.mockImplementation(() => new Promise<boolean>((resolve) => {
      answer = resolve;
    }));
    const onRemove = vi.fn(async () => undefined);
    const viewProps = props({ onRemove });
    render(viewProps);
    click(buttonByText("選択"));
    click(tiles()[0]);
    act(() => buttonByText("アルバムから外す")?.click());
    render({ ...viewProps, album: album({ albumId: "another-album", name: "別のアルバム" }) });
    await act(async () => {
      answer(true);
      await Promise.resolve();
    });
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("空のアルバムは、追加できる人には「追加」、見るだけには短い状態を出す", () => {
    render(props({ items: [], album: album({ role: "contributor" }) }));
    expect(Array.from(container.querySelectorAll("button")).filter((element) => element.textContent?.trim() === "追加")).toHaveLength(2);
    render(props({ items: [], album: album({ role: "viewer" }) }));
    expect(container.textContent).toContain("まだ写真はありません");
  });
});

describe("PhotoSharedAlbumUploadPanel（アルバムの下端）", () => {
  function renderUploads(uploads: PhotoSharedAlbumUpload[], extra: Partial<PhotoSharedAlbumViewProps> = {}) {
    render(props({ uploads, ...extra }));
  }

  it("初めて追加するときだけ「元データはこの端末に残ります」を出す", () => {
    renderUploads(photoSharedAlbumFixtureUploads(), { showOriginalsNote: true });
    expect(container.textContent).toContain("元データはこの端末に残ります");
    renderUploads(photoSharedAlbumFixtureUploads(), { showOriginalsNote: false });
    expect(container.textContent).not.toContain("元データはこの端末に残ります");
  });

  it("見出しで全体の進み具合を伝え、追加できなかった項目があれば最初から開く", () => {
    renderUploads(photoSharedAlbumFixtureUploads());
    const region = container.querySelector("section[aria-label='追加の進捗']");
    expect(region?.querySelector("[role=status]")?.textContent).toBe("追加中 3/6");
    const toggle = region?.querySelector("button[aria-expanded]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(region?.textContent).toContain("この形式は追加できません");
    expect(region?.textContent).toContain("確認中");
    expect(region?.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("62");
    // 動いている間は閉じられない
    expect(Array.from(region?.querySelectorAll("button") ?? []).some((element) => element.textContent === "閉じる")).toBe(false);
  });

  it("失敗した項目だけ再試行でき、結果が分からない項目からは送り直さない", () => {
    const onRetryUpload = vi.fn();
    renderUploads(photoSharedAlbumFixtureUploads(), { onRetryUpload });
    const retries = Array.from(container.querySelectorAll("button")).filter((element) => element.textContent === "再試行");
    expect(retries).toHaveLength(1);
    expect(retries[0].getAttribute("aria-label")).toBe("IMG_0416.JPG、再試行");
    click(retries[0]);
    expect(onRetryUpload).toHaveBeenCalledWith("fixture-upload-6");
  });

  it("全部追加できたら畳んで結果を出し、閉じられる", () => {
    const onDismissUploads = vi.fn();
    const done = photoSharedAlbumFixtureUploads().slice(0, 2).map((upload) => ({ ...upload, phase: "added" as const, fraction: null }));
    renderUploads(done, { onDismissUploads });
    const region = container.querySelector("section[aria-label='追加の進捗']");
    expect(region?.querySelector("[role=status]")?.textContent).toBe("2枚を追加しました");
    expect(region?.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
    expect(region?.querySelector("ul")?.hidden).toBe(true);
    click(Array.from(region?.querySelectorAll("button") ?? []).find((element) => element.textContent === "閉じる"));
    expect(onDismissUploads).toHaveBeenCalledTimes(1);
  });
});
