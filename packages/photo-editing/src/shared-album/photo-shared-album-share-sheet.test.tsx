// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));

vi.mock("niho-ui/app-dialog", () => ({ appDialog: { confirm: mocks.confirm } }));
vi.mock("niho-ui/components/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <>{children}</> : null),
  DialogContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div role="dialog" className={className}>
      {children}
    </div>
  ),
  DialogDescription: ({ children, className }: { children: ReactNode; className?: string }) => <p className={className}>{children}</p>,
  DialogHeader: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  DialogTitle: ({ children, className }: { children: ReactNode; className?: string }) => <h2 className={className}>{children}</h2>,
}));

import {
  PHOTO_SHARED_ALBUM_FIXTURE_LINKS,
  PHOTO_SHARED_ALBUM_FIXTURE_MEMBERS,
  PHOTO_SHARED_ALBUM_FIXTURE_NOW,
  PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE,
} from "./photo-shared-album-fixtures";
import { PhotoSharedAlbumShareSheet, type PhotoSharedAlbumShareSheetProps } from "./photo-shared-album-share-sheet";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const writeText = vi.fn(async (_text: string) => undefined);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.confirm.mockReset();
  mocks.confirm.mockImplementation(async () => true);
  writeText.mockClear();
  // jsdom には ClipboardItem が無いので、文字のコピーの経路を通る
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function props(overrides: Partial<PhotoSharedAlbumShareSheetProps> = {}): PhotoSharedAlbumShareSheetProps {
  return {
    open: true,
    onOpenChange: vi.fn(),
    albumName: "鎌倉の拠点 2026 秋",
    role: "owner",
    members: PHOTO_SHARED_ALBUM_FIXTURE_MEMBERS,
    inviteLinks: PHOTO_SHARED_ALBUM_FIXTURE_LINKS,
    now: PHOTO_SHARED_ALBUM_FIXTURE_NOW,
    onCopyLink: vi.fn(async () => "https://example.invalid/invite/fixture"),
    onRevokeLink: vi.fn(async () => undefined),
    onChangeRole: vi.fn(async () => undefined),
    onRemoveMember: vi.fn(async () => undefined),
    ...overrides,
  };
}

function render(sheetProps: PhotoSharedAlbumShareSheetProps) {
  act(() => root.render(<PhotoSharedAlbumShareSheet {...sheetProps} />));
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((element) => element.textContent?.trim() === text);
}

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((element) => element.getAttribute("aria-label") === label);
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

describe("PhotoSharedAlbumShareSheet", () => {
  it("オーナーにはメンバーと役割、主操作「リンクをコピー」と有効期限の短いラベルだけを出す", () => {
    render(props());
    expect(container.querySelector("h2")?.textContent).toBe("共有");
    expect(buttonByText("リンクをコピー")).toBeDefined();
    const radios = Array.from(container.querySelectorAll("[role=radio]"));
    expect(radios.map((radio) => radio.textContent)).toEqual(["写真を追加できる", "見るだけ"]);
    // 使えるリンクが「写真を追加できる」だけなので、その役割で開く
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("[role=status]")?.textContent).toBe("あと7日");
    // オーナーが先頭
    const rows = Array.from(container.querySelectorAll("li"));
    expect(rows[0].textContent).toContain("中村");
    expect(rows[0].textContent).toContain("（あなた）");
    expect(rows[0].textContent).toContain("オーナー");
    expect(container.textContent).toContain("メンバー4人");
    expect(container.textContent).not.toMatch(/contributor|viewer|owner/);
  });

  it("期限切れのリンクしか無い役割では期限を出さず、無効にする操作も出さない", () => {
    render(props());
    act(() => (container.querySelectorAll("[role=radio]")[1] as HTMLElement).click());
    expect(container.querySelector("[role=status]")?.textContent).toBe("");
    expect(buttonByText("リンクを無効にする")).toBeUndefined();
  });

  it("使えるリンクが無ければ「見るだけ」で開く（広く渡っても写真は足されない）", () => {
    render(props({ inviteLinks: [] }));
    expect(container.querySelectorAll("[role=radio]")[1].getAttribute("aria-checked")).toBe("true");
  });

  it("「リンクをコピー」は選んだ役割の URL をコピーし、コピーしたことと期限を出す", async () => {
    const onCopyLink = vi.fn(async () => "https://example.invalid/invite/fixture");
    render(props({ onCopyLink }));
    act(() => buttonByText("リンクをコピー")?.click());
    expect(onCopyLink).toHaveBeenCalledWith("contributor");
    await settle();
    expect(writeText).toHaveBeenCalledWith("https://example.invalid/invite/fixture");
    expect(container.querySelector("[role=status]")?.textContent).toBe("コピーしました・あと7日");
  });

  it("ClipboardItem が使えるときは、操作の中で Promise のまま書き込みを始める（Safari）", async () => {
    const write = vi.fn(async (items: { types: string[]; getType: (type: string) => Promise<Blob> }[]) => {
      await items[0].getType("text/plain");
    });
    class FakeClipboardItem {
      readonly types: string[];
      constructor(private readonly data: Record<string, Promise<Blob>>) {
        this.types = Object.keys(data);
      }
      getType(type: string): Promise<Blob> {
        return this.data[type];
      }
    }
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write, writeText } });
    try {
      render(props());
      act(() => buttonByText("リンクをコピー")?.click());
      // 書き込みは URL を待たずに、押した操作の中で始まる
      expect(write).toHaveBeenCalledTimes(1);
      await settle();
      expect(writeText).not.toHaveBeenCalled();
      expect(container.querySelector("[role=status]")?.textContent).toBe("コピーしました・あと7日");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("閉じて開き直したあとに届いた前のコピーの結果は出さない", async () => {
    let resolveUrl: (url: string) => void = () => undefined;
    const sheetProps = props({ onCopyLink: vi.fn(() => new Promise<string>((resolve) => { resolveUrl = resolve; })) });
    render(sheetProps);
    act(() => buttonByText("リンクをコピー")?.click());
    render({ ...sheetProps, open: false });
    render(sheetProps);
    await act(async () => {
      resolveUrl("https://example.invalid/invite/late");
    });
    await settle();
    expect(container.querySelector("[role=status]")?.textContent).toBe("あと7日");
    expect(buttonByText("リンクをコピー")?.disabled).toBe(false);
  });

  it("招待の役割は radio と同じく、Tab では選んでいる方にだけ止まり、矢印キーで選び直す", () => {
    render(props());
    const radios = () => Array.from(container.querySelectorAll<HTMLButtonElement>("[role=radio]"));
    expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1]);
    act(() => {
      radios()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0]);
    expect(document.activeElement).toBe(radios()[1]);
  });

  it("コピーできなかったら短く知らせる", async () => {
    render(props({ onCopyLink: vi.fn(async () => { throw new Error("offline"); }) }));
    act(() => buttonByText("リンクをコピー")?.click());
    await settle();
    expect(writeText).not.toHaveBeenCalled();
    expect(container.querySelector("[role=status]")?.textContent).toBe("コピーできませんでした。もう一度お試しください。");
  });

  it("リンクを無効にするときは、参加済みのメンバーはそのままだと確かめてから無効にする", async () => {
    const onRevokeLink = vi.fn(async () => undefined);
    render(props({ onRevokeLink }));
    await act(async () => {
      buttonByText("リンクを無効にする")?.click();
    });
    await settle();
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "リンクを無効にしますか？", description: "参加済みのメンバーはそのままです。", variant: "danger" }));
    expect(onRevokeLink).toHaveBeenCalledWith("fixture-link-contributor");
  });

  it("オーナーはメンバーの役割を変えられ、外すときは追加した写真が残ることを確かめる", async () => {
    const onChangeRole = vi.fn(async () => undefined);
    const onRemoveMember = vi.fn(async () => undefined);
    render(props({ onChangeRole, onRemoveMember }));
    const select = container.querySelector<HTMLSelectElement>("select[id]");
    if (!select) throw new Error("select not found");
    expect(container.querySelector(`label[for="${select.id}"]`)?.textContent).toBe("佐藤 花子さんの役割");
    await act(async () => {
      select.value = "viewer";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(onChangeRole).toHaveBeenCalledWith("fixture-contributor", "viewer");

    await act(async () => {
      buttonByLabel("鈴木さんを外す")?.click();
    });
    await settle();
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "鈴木さんをアルバムから外しますか？", description: "追加した写真はアルバムに残ります。" }));
    expect(onRemoveMember).toHaveBeenCalledWith("fixture-viewer");
    // オーナー本人の行は変えられない
    expect(buttonByLabel("中村さんを外す")).toBeUndefined();
  });

  it("変更できなかったら短く知らせる", async () => {
    render(props({ onRemoveMember: vi.fn(async () => { throw new Error("denied"); }) }));
    await act(async () => {
      buttonByLabel("鈴木さんを外す")?.click();
    });
    await settle();
    expect(container.querySelector("[role=alert]")?.textContent).toBe("できませんでした。もう一度お試しください。");
  });

  it("オーナー以外は一覧を見るだけで、招待・役割の変更・外す操作を出さず、本人は抜けられる", async () => {
    const onLeave = vi.fn(async () => undefined);
    const members = PHOTO_SHARED_ALBUM_FIXTURE_MEMBERS.map((member) => ({
      ...member,
      isSelf: member.userId === PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.viewer.userId,
    }));
    render(props({ role: "viewer", members, onLeave }));
    expect(buttonByText("リンクをコピー")).toBeUndefined();
    expect(container.querySelector("select")).toBeNull();
    expect(buttonByLabel("佐藤 花子さんを外す")).toBeUndefined();
    expect(container.textContent).toContain("見るだけ");
    await act(async () => {
      buttonByText("アルバムから抜ける")?.click();
    });
    await settle();
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "このアルバムから抜けますか？", description: "追加した写真はアルバムに残ります。" }));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("閉じるボタンに読み上げ名がある", () => {
    const onOpenChange = vi.fn();
    render(props({ onOpenChange }));
    act(() => buttonByLabel("閉じる")?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
