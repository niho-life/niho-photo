// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(async () => null as string | null),
  confirm: vi.fn(async () => true),
  alert: vi.fn(async () => undefined),
}));
vi.mock("niho-ui/app-dialog", () => ({ appDialog: { prompt: mocks.prompt, confirm: mocks.confirm, alert: mocks.alert } }));

import {
  PHOTO_SHARED_ALBUM_FIXTURE_ALBUM,
  PHOTO_SHARED_ALBUM_FIXTURE_LINKS,
  PHOTO_SHARED_ALBUM_FIXTURE_MEMBERS,
  PHOTO_SHARED_ALBUM_FIXTURE_NOW,
  photoSharedAlbumFixtureItems,
  photoSharedAlbumFixtureSummaries,
} from "./photo-shared-album-fixtures";
import type { PhotoSharedAlbumOpened, PhotoSharedAlbumPermissions, PhotoSharedAlbumPort } from "./photo-shared-album-port";
import { PhotoSharedAlbumWorkspace } from "./photo-shared-album-workspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER_PERMISSIONS: PhotoSharedAlbumPermissions = { addItem: true, removeOwnItem: true, removeOthersItem: true, manageInvites: true, leave: false, download: true };
const VIEWER_PERMISSIONS: PhotoSharedAlbumPermissions = { addItem: false, removeOwnItem: false, removeOthersItem: false, manageInvites: false, leave: true, download: true };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.prompt.mockReset();
  mocks.prompt.mockImplementation(async () => null);
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function opened(overrides: Partial<PhotoSharedAlbumOpened> = {}): PhotoSharedAlbumOpened {
  return { album: PHOTO_SHARED_ALBUM_FIXTURE_ALBUM, items: photoSharedAlbumFixtureItems(), permissions: OWNER_PERMISSIONS, ...overrides };
}

function fakePort(overrides: Partial<PhotoSharedAlbumPort> = {}): PhotoSharedAlbumPort {
  let noteShown = false;
  return {
    listAlbums: vi.fn(async () => photoSharedAlbumFixtureSummaries()),
    createAlbum: vi.fn(async () => PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId),
    openAlbum: vi.fn(async () => opened()),
    people: vi.fn(async () => ({ members: PHOTO_SHARED_ALBUM_FIXTURE_MEMBERS, inviteLinks: PHOTO_SHARED_ALBUM_FIXTURE_LINKS })),
    copyInviteLink: vi.fn(async () => "https://photo.example.test/#invite=synthetic"),
    revokeInviteLink: vi.fn(async () => undefined),
    changeRole: vi.fn(async () => undefined),
    removeMember: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    addFile: vi.fn(async () => ({ ok: true as const })),
    save: vi.fn(async () => ({ failed: 0 })),
    remove: vi.fn(async () => ({ failed: 0 })),
    join: vi.fn(async () => ({ kind: "joined" as const, albumId: PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId })),
    joinHeld: vi.fn(async () => ({ kind: "joined" as const, albumId: PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId })),
    storageLocations: vi.fn(async () => []),
    originalsNoteShown: () => noteShown,
    markOriginalsNoteShown: () => { noteShown = true; },
    dispose: vi.fn(),
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); });
}

function buttonByText(text: string, scope: ParentNode = document.body): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll("button")).find((element) => element.textContent?.trim() === text);
}

async function pickFiles(files: File[]): Promise<void> {
  const input = container.querySelector("input[type=file]") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
}

describe("PhotoSharedAlbumWorkspace", () => {
  it("opens an album from the list, adds picked files one by one and reloads the album", async () => {
    const port = fakePort();
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={port} now={() => PHOTO_SHARED_ALBUM_FIXTURE_NOW} />));
    await flush();
    const card = Array.from(container.querySelectorAll("ul button"))[0] as HTMLButtonElement;
    await act(async () => card.click());
    await flush();
    expect(port.openAlbum).toHaveBeenCalledWith(PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId, expect.any(AbortSignal));
    expect(container.textContent).toContain(PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.name);

    const files = [new File(["a"], "IMG_1.JPG", { type: "image/jpeg" }), new File(["b"], "IMG_2.JPG", { type: "image/jpeg" })];
    await pickFiles(files);
    expect(port.addFile).toHaveBeenCalledTimes(2);
    expect((port.addFile as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[1] as File).name)).toEqual(["IMG_1.JPG", "IMG_2.JPG"]);
    expect(container.textContent).toContain("2枚を追加しました");
    // The first addition shows that originals stay on this device.
    expect(container.textContent).toContain("元データはこの端末に残ります");
    expect((port.openAlbum as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("shows why a photo was not added and retries a failed one", async () => {
    let attempt = 0;
    const port = fakePort({
      addFile: vi.fn(async (_albumId: string, file: File) => {
        if (file.name === "full.jpg") return { ok: false as const, reason: "albumFull" as const };
        attempt += 1;
        return attempt === 1 ? { ok: false as const, reason: null } : { ok: true as const };
      }),
    });
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={port} />));
    await flush();
    await act(async () => (Array.from(container.querySelectorAll("ul button"))[0] as HTMLButtonElement).click());
    await flush();
    await pickFiles([new File(["a"], "full.jpg", { type: "image/jpeg" }), new File(["b"], "retry.jpg", { type: "image/jpeg" })]);
    expect(container.textContent).toContain("2枚を追加できませんでした");
    expect(container.textContent).toContain("アルバムがいっぱいです");
    await act(async () => buttonByText("再試行", container)?.click());
    await flush();
    expect(port.addFile).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("1枚を追加できませんでした");
  });

  it("gates operations on the server's permissions: a viewer gets no add, no removal, but can leave", async () => {
    const port = fakePort({ openAlbum: vi.fn(async () => opened({ album: { ...PHOTO_SHARED_ALBUM_FIXTURE_ALBUM, role: "viewer" }, permissions: VIEWER_PERMISSIONS })) });
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={port} />));
    await flush();
    await act(async () => (Array.from(container.querySelectorAll("ul button"))[0] as HTMLButtonElement).click());
    await flush();
    expect(buttonByText("追加", container)).toBeUndefined();
    // Even a file that reaches the view (e.g. a drop) is not sent.
    await pickFiles([new File(["a"], "drop.jpg", { type: "image/jpeg" })]);
    expect(port.addFile).not.toHaveBeenCalled();
  });

  it("joins once from an invite link and opens the album; an unusable link says so", async () => {
    const onInviteHandled = vi.fn();
    const port = fakePort();
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={port} invite={{ kind: "link", secret: "synthetic-secret" }} onInviteHandled={onInviteHandled} />));
    await flush();
    // A re-render with the same secret does not join again.
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={port} invite={{ kind: "link", secret: "synthetic-secret" }} onInviteHandled={onInviteHandled} />));
    await flush();
    expect(port.join).toHaveBeenCalledTimes(1);
    expect(onInviteHandled).toHaveBeenCalledTimes(1);
    expect(port.openAlbum).toHaveBeenCalledWith(PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId, expect.any(AbortSignal));

    act(() => root.unmount());
    root = createRoot(container);
    const unusable = fakePort({ join: vi.fn(async () => ({ kind: "unavailable" as const })) });
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={unusable} invite={{ kind: "link", secret: "expired-secret" }} />));
    await flush();
    expect(container.querySelector("h1")?.textContent).toBe("このリンクは使えません");
    await act(async () => buttonByText("共有アルバムへ", container)?.click());
    await flush();
    expect(unusable.listAlbums).toHaveBeenCalled();
  });

  it("joins once with an invite held from before sign-in, even across a remount; a lost answer shows the albums", async () => {
    const onInviteHandled = vi.fn();
    let answer!: (result: { readonly kind: "joined"; readonly albumId: string }) => void;
    const port = fakePort({ joinHeld: vi.fn(async () => await new Promise<{ readonly kind: "joined"; readonly albumId: string }>((resolve) => { answer = resolve; })) });
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={port} invite={{ kind: "held" }} onInviteHandled={onInviteHandled} />));
    await flush();
    expect(container.textContent).toContain("参加しています");
    // A re-render before the answer does not ask the BFF again (it deletes what it holds on the first attempt).
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={port} invite={{ kind: "held" }} onInviteHandled={onInviteHandled} />));
    await act(async () => answer({ kind: "joined", albumId: PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId }));
    await flush();
    expect(port.joinHeld).toHaveBeenCalledTimes(1);
    expect(port.join).not.toHaveBeenCalled();
    expect(onInviteHandled).toHaveBeenCalledTimes(1);
    expect(port.openAlbum).toHaveBeenCalledWith(PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId, expect.any(AbortSignal));

    // Unmounted and mounted again with the same port before the answer: still one request, and the new mount gets it.
    act(() => root.unmount());
    root = createRoot(container);
    let later!: (result: { readonly kind: "joined"; readonly albumId: string }) => void;
    const remounted = fakePort({ joinHeld: vi.fn(async () => await new Promise<{ readonly kind: "joined"; readonly albumId: string }>((resolve) => { later = resolve; })) });
    const remountHandled = vi.fn();
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={remounted} invite={{ kind: "held" }} onInviteHandled={remountHandled} />));
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={remounted} invite={{ kind: "held" }} onInviteHandled={remountHandled} />));
    await act(async () => later({ kind: "joined", albumId: PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId }));
    await flush();
    expect(remounted.joinHeld).toHaveBeenCalledTimes(1);
    expect(remountHandled).toHaveBeenCalledTimes(1);
    expect(remounted.openAlbum).toHaveBeenCalledWith(PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId, expect.any(AbortSignal));

    act(() => root.unmount());
    root = createRoot(container);
    const lost = fakePort({ joinHeld: vi.fn(async () => await Promise.reject(new Error("synthetic lost answer"))) });
    const handled = vi.fn();
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={lost} invite={{ kind: "held" }} onInviteHandled={handled} />));
    await flush();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(lost.listAlbums).toHaveBeenCalled();
    expect(lost.joinHeld).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    root = createRoot(container);
    const unusable = fakePort({ joinHeld: vi.fn(async () => ({ kind: "unavailable" as const })) });
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={unusable} invite={{ kind: "held" }} />));
    await flush();
    expect(container.querySelector("h1")?.textContent).toBe("このリンクは使えません");
  });

  it("shows the album as ended when it can no longer be opened, and creates an album by name", async () => {
    let gone = false;
    const port = fakePort({ openAlbum: vi.fn(async () => (gone ? null : opened())) });
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={port} />));
    await flush();
    await act(async () => (Array.from(container.querySelectorAll("ul button"))[0] as HTMLButtonElement).click());
    await flush();
    gone = true;
    await pickFiles([new File(["a"], "late.jpg", { type: "image/jpeg" })]);
    expect(container.textContent).toContain("このアルバムは見られなくなりました");

    act(() => root.unmount());
    root = createRoot(container);
    mocks.prompt.mockImplementation(async () => "  週末の写真  ");
    const creating = fakePort();
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={creating} />));
    await flush();
    await act(async () => buttonByText("新しいアルバム", container)?.click());
    await flush();
    expect(creating.createAlbum).toHaveBeenCalledWith("週末の写真", expect.any(AbortSignal));
    expect(creating.openAlbum).toHaveBeenCalled();
  });

  it("copies an invite link through the port from the share sheet", async () => {
    const port = fakePort();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={port} now={() => PHOTO_SHARED_ALBUM_FIXTURE_NOW} />));
    await flush();
    await act(async () => (Array.from(container.querySelectorAll("ul button"))[0] as HTMLButtonElement).click());
    await flush();
    await act(async () => (container.querySelector("button[aria-label='共有']") as HTMLButtonElement | null)?.click());
    await flush();
    expect(port.people).toHaveBeenCalledWith(PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId, expect.any(AbortSignal));
    await act(async () => buttonByText("リンクをコピー")?.click());
    await flush();
    expect(port.copyInviteLink).toHaveBeenCalledWith(PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId, expect.any(String), expect.any(AbortSignal));
  });

  it("keeps the invite after a failed join so the same link can be tried again", async () => {
    const onInviteHandled = vi.fn();
    let attempts = 0;
    const port = fakePort({
      join: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw { error: { code: "rate_limited", requestId: "synthetic", retryable: true } };
        return { kind: "joined" as const, albumId: PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId };
      }),
    });
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={port} invite={{ kind: "link", secret: "synthetic-secret" }} onInviteHandled={onInviteHandled} />));
    await flush();
    expect(container.querySelector("[role=alert]")?.textContent).toBe("参加できませんでした。もう一度お試しください。");
    expect(onInviteHandled).not.toHaveBeenCalled();
    await act(async () => buttonByText("参加する", container)?.click());
    await flush();
    expect(port.join).toHaveBeenCalledTimes(2);
    expect(onInviteHandled).toHaveBeenCalledTimes(1);
    expect(port.openAlbum).toHaveBeenCalledWith(PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId, expect.any(AbortSignal));
  });

  it("joins and opens the album under development double effects without losing the invite", async () => {
    const onInviteHandled = vi.fn();
    const port = fakePort();
    await act(async () => root.render(<StrictMode><PhotoSharedAlbumWorkspace port={port} invite={{ kind: "link", secret: "synthetic-secret" }} onInviteHandled={onInviteHandled} /></StrictMode>));
    await flush();
    expect(onInviteHandled).toHaveBeenCalledTimes(1);
    expect(port.openAlbum).toHaveBeenCalledWith(PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId, expect.any(AbortSignal));
    expect(container.textContent).toContain(PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.name);
  });

  it("keeps additions with the album they were started in, and retries them there", async () => {
    const other = { ...PHOTO_SHARED_ALBUM_FIXTURE_ALBUM, albumId: "fixture-album-other", name: "別のアルバム" };
    const port = fakePort({
      openAlbum: vi.fn(async (albumId: string) => opened(albumId === other.albumId ? { album: other, items: [] } : {})),
      listAlbums: vi.fn(async () => [PHOTO_SHARED_ALBUM_FIXTURE_ALBUM, other]),
      addFile: vi.fn(async () => ({ ok: false as const, reason: null })),
    });
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={port} />));
    await flush();
    await act(async () => (Array.from(container.querySelectorAll("ul button"))[0] as HTMLButtonElement).click());
    await flush();
    await pickFiles([new File(["a"], "a.jpg", { type: "image/jpeg" })]);
    expect(container.textContent).toContain("1枚を追加できませんでした");
    await act(async () => (container.querySelector("button[aria-label='共有アルバムに戻る']") as HTMLButtonElement).click());
    await flush();
    await act(async () => (Array.from(container.querySelectorAll("ul button"))[1] as HTMLButtonElement).click());
    await flush();
    expect(container.textContent).toContain("別のアルバム");
    expect(container.textContent).not.toContain("追加できませんでした");
    expect(buttonByText("再試行", container)).toBeUndefined();
    await act(async () => (container.querySelector("button[aria-label='共有アルバムに戻る']") as HTMLButtonElement).click());
    await flush();
    await act(async () => (Array.from(container.querySelectorAll("ul button"))[0] as HTMLButtonElement).click());
    await flush();
    await act(async () => buttonByText("再試行", container)?.click());
    await flush();
    expect((port.addFile as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId, PHOTO_SHARED_ALBUM_FIXTURE_ALBUM.albumId]);
  });

  it("tells when photos could not be saved and saves them again on retry", async () => {
    let calls = 0;
    const port = fakePort({ save: vi.fn(async () => ({ failed: calls++ === 0 ? 1 : 0 })) });
    await act(async () => root.render(<PhotoSharedAlbumWorkspace port={port} />));
    await flush();
    await act(async () => (Array.from(container.querySelectorAll("ul button"))[0] as HTMLButtonElement).click());
    await flush();
    await act(async () => buttonByText("選択", container)?.click());
    const tile = container.querySelector("[aria-pressed]") as HTMLElement | null;
    await act(async () => tile?.click());
    await act(async () => buttonByText("保存", container)?.click());
    await flush();
    expect(port.save).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("できませんでした。もう一度お試しください。");
    await act(async () => buttonByText("再試行", container)?.click());
    await flush();
    expect(port.save).toHaveBeenCalledTimes(2);
    expect((port.save as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toEqual((port.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(container.querySelector("[role=alert]")).toBeNull();
  });
});
