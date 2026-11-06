import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhotoLibrary } from "niho-photo-editing/library/photo-library";
import { App, PHOTO_BENCH_NOTICE_DISMISSED_KEY, PHOTO_BENCH_NOTICE_TEXT, PHOTO_TREE_HIDDEN_KEY } from "./App";
import { createCameraCommands, type Invoke } from "./local-library/commands";
import { createLocalPhotoEditingHost } from "./local-library/local-photo-editing-host";
import { createLocalPhotoLibrary } from "./local-library/local-photo-library";

// React 18 の act を jsdom で使う
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const initialInnerWidth = window.innerWidth;

beforeEach(() => {
  window.localStorage.clear();
  // 窓の最小幅は 1024px（PC の面）
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: initialInnerWidth });
});

function fakeCommands(options: { photoBenchEdits: boolean; rememberedFolder?: boolean; rememberedPhoto?: boolean }) {
  const calls: string[] = [];
  const photo = {
    entryId: "opaque-local-photo",
    fileName: "海辺.jpg",
    kind: "raster" as const,
    sizeBytes: 1024,
    modifiedAt: "2026-10-20T00:00:00.000Z",
    hasEdits: false,
  };
  const folder = {
    folderId: "test-folder",
    name: "検証用",
    children: [],
    photos: options.rememberedPhoto ? [photo] : [],
    truncated: false,
  };
  let folders = options.rememberedFolder ? [folder] : [];
  const invoke: Invoke = async <T,>(command: string) => {
    calls.push(command);
    if (command === "camera_library_forget_folder") {
      folders = [];
      return {} as T;
    }
    const answers: Record<string, unknown> = {
      camera_library_remembered: { folders, photos: [] },
      camera_library_selected_photos: { photos: [] },
      camera_library_list_folder: { folder },
      camera_develop_status: { available: true, raster: true },
      camera_cutout_status: { available: true },
      camera_photo_bench_edits: { found: options.photoBenchEdits },
      camera_presets_list: { presets: [] },
    };
    if (!(command in answers)) throw { code: "internal", message: `unexpected ${command}` };
    return answers[command] as T;
  };
  return { calls, commands: createCameraCommands(invoke) };
}

function cloudLibrary(commands: ReturnType<typeof fakeCommands>["commands"]): PhotoLibrary {
  const local = createLocalPhotoLibrary(commands);
  const { folders: _folders, selectedPhotos: _selectedPhotos, ...shared } = local;
  return {
    ...shared,
    place: "cloud",
    initialCapabilities: { ...local.initialCapabilities, place: "cloud" },
    capabilities: async () => ({ ...(await local.capabilities()), place: "cloud" }),
  };
}

/** 読み込み（react-query・木）が落ち着くまで待つ。 */
async function settle() {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(
  commands: ReturnType<typeof fakeCommands>["commands"],
  appVersion: string | null = "0.1.4",
) {
  await act(async () => {
    root.render(
      <App
        commands={commands}
        loadAppInfo={async () => (appVersion ? { appVersion } : null)}
        watchUpdate={async () => () => undefined}
      />,
    );
  });
  await settle();
}

async function remount(commands: ReturnType<typeof fakeCommands>["commands"]) {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(commands);
}

function notice(): HTMLElement | null {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="status"]')).find((element) =>
    element.textContent?.includes(PHOTO_BENCH_NOTICE_TEXT),
  ) ?? null;
}

describe("App", () => {
  it("forgets a folder only after the shared confirmation is accepted", async () => {
    const { commands, calls } = fakeCommands({ photoBenchEdits: false, rememberedFolder: true });
    await render(commands);

    const openMenu = async () => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="検証用 のメニュー"]')?.click();
      });
      await act(async () => {
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
          .find((item) => item.textContent === "一覧から外す")?.click();
      });
    };

    await openMenu();
    expect(document.body.textContent).toContain("「検証用」を一覧から外します。フォルダと写真は消えません。");
    await act(async () => {
      Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent === "キャンセル")?.click();
    });
    expect(calls).not.toContain("camera_library_forget_folder");

    await openMenu();
    await act(async () => {
      Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent === "外す")?.click();
    });
    await settle();
    expect(calls).toContain("camera_library_forget_folder");
    expect(container.querySelector('button[aria-label="検証用 のメニュー"]')).toBeNull();
  });

  it("draws the shared editing surface with one app name in the titlebar, the place and the version", async () => {
    const { commands, calls } = fakeCommands({ photoBenchEdits: false });
    await render(commands);

    expect(container.querySelector(".photo-titlebar")?.textContent).toBe("NIHO photo");
    expect(container.querySelector(".photo-titlebar")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(container.querySelector("header")?.textContent).not.toContain("NIHO photo");
    expect(container.querySelector("header")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(container.querySelector('button[aria-label="アカウント"]')).toBeNull();
    // 編集面（空の「この Mac」ではフォルダと写真を追加するメニューを出す）
    expect(container.querySelector('section[aria-label="ブラウザ写真編集"]')).not.toBeNull();
    expect(container.querySelector('aside[aria-label="写真の場所"] h3')?.textContent).toBe("この Mac");
    expect(
      Array.from(container.querySelectorAll('button[aria-haspopup="menu"]')).some((button) =>
        button.textContent?.includes("フォルダや写真を追加"),
      ),
    ).toBe(true);
    // 窓の上の帯に表示中の場所
    expect(container.querySelector('nav[aria-label="表示中の場所"]')?.textContent).toBe("この Mac");
    // 版は左の木の底（下段の帯は無い）
    expect(container.querySelector(":scope > div > footer")).toBeNull();
    expect(container.querySelector('aside[aria-label="写真の場所"]')?.textContent).toContain("版 0.1.4");
    // 編集面は窓いっぱい（web の角丸の枠と固定の高さを使わない）
    const surface = container.querySelector('section[aria-label="ブラウザ写真編集"]');
    expect(surface?.className).toContain("flex-1");
    expect(surface?.className).not.toContain("rounded-2xl");
    expect(notice()).toBeNull();
    expect(calls).toContain("camera_library_remembered");
    expect(calls).toContain("camera_develop_status");
    expect(container.querySelector('[role="group"][aria-label="写真の保存先"]')).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "クラウドにコピー")).toBe(false);
  });

  it("shows personal cloud tabs only for an explicit trusted binding and remounts the shared workbench by source", async () => {
    const { commands } = fakeCommands({ photoBenchEdits: false });
    const library = cloudLibrary(commands);
    await act(async () => {
      root.render(
        <App
          commands={commands}
          loadAppInfo={async () => null}
          watchUpdate={async () => () => undefined}
          cloudBinding={{
            library,
            host: createLocalPhotoEditingHost(commands),
            actorId: "personal-user-1",
            copyLocalPhoto: async () => ({ cloudPhotoId: null }),
          }}
        />,
      );
    });
    await settle();

    const sourceSwitch = () => container.querySelector('[role="group"][aria-label="写真の保存先"]');
    expect(sourceSwitch()).not.toBeNull();
    const sourceButton = (label: string) => Array.from(sourceSwitch()?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent === label);
    const cloudTab = sourceButton("クラウド");
    expect(sourceButton("この Mac")?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => cloudTab?.click());
    await settle();
    expect(sourceButton("クラウド")?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('nav[aria-label="表示中の場所"]')?.textContent).toContain("クラウド");
  });

  it("shows 写真 / 共有アルバム and 設定 only when the trusted binding carries an open shared-album port", async () => {
    const { commands } = fakeCommands({ photoBenchEdits: false });
    const library = cloudLibrary(commands);
    const base = { library, host: createLocalPhotoEditingHost(commands), actorId: "personal-user-1" };
    const render = async (cloudBinding: Parameters<typeof App>[0]["cloudBinding"]) => {
      await act(async () => {
        root.render(<App commands={commands} loadAppInfo={async () => null} watchUpdate={async () => () => undefined} cloudBinding={cloudBinding} />);
      });
      await settle();
    };
    const screens = () => Array.from(container.querySelectorAll("nav button")).map((button) => button.textContent).filter((text) => text === "写真" || text === "共有アルバム");
    await render(base);
    expect(screens()).toEqual([]);
    expect(container.querySelector('button[aria-label="設定"]')).toBeNull();

    const sharedAlbums = {
      listAlbums: vi.fn(async () => []), storageLocations: vi.fn(async () => []), originalsNoteShown: () => false, markOriginalsNoteShown: vi.fn(), dispose: vi.fn(),
    } as unknown as NonNullable<NonNullable<Parameters<typeof App>[0]["cloudBinding"]>["sharedAlbums"]>;
    await render({ ...base, sharedAlbums });
    expect(screens()).toEqual(["写真", "共有アルバム"]);
    expect(container.querySelector('button[aria-label="設定"]')).not.toBeNull();
    const shared = Array.from(container.querySelectorAll<HTMLButtonElement>("nav button")).find((button) => button.textContent === "共有アルバム");
    await act(async () => shared?.click());
    await settle();
    expect(sharedAlbums.listAlbums).toHaveBeenCalled();
    expect(container.textContent).toContain("共有アルバムはまだありません");
    // The local/cloud source switch belongs to 写真 only.
    expect(container.querySelector('[role="group"][aria-label="写真の保存先"]')).toBeNull();

    // Settings opened for one cloud scope are never shown for another, not even for one render.
    await act(async () => (container.querySelector('button[aria-label="設定"]') as HTMLButtonElement).click());
    await settle();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    const nextLibrary = cloudLibrary(commands);
    // Same person, another logical scope (e.g. a new session epoch).
    const nextShared = { ...sharedAlbums, storageLocations: vi.fn(async () => []) } as typeof sharedAlbums;
    await render({ ...base, library: nextLibrary, scopeKey: "scope-2", sharedAlbums: nextShared });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    // The dialog was never open for the new scope, not even for the render before the reset.
    expect(nextShared.storageLocations).not.toHaveBeenCalled();
  });

  it("copies only the selected local photo, blocks duplicates, and offers the returned cloud photo", async () => {
    const { commands } = fakeCommands({ photoBenchEdits: false, rememberedFolder: true, rememberedPhoto: true });
    const progress: Array<(fraction: number | null) => void> = [];
    let finish: ((result: { cloudPhotoId: string | null }) => void) | null = null;
    const copyLocalPhoto = vi.fn((_photoId: string, options: { onProgress: (fraction: number | null) => void }) => {
      progress.push(options.onProgress);
      return new Promise<{ cloudPhotoId: string | null }>((resolve) => {
        finish = resolve;
      });
    });
    await act(async () => {
      root.render(
        <App
          commands={commands}
          loadAppInfo={async () => null}
          watchUpdate={async () => () => undefined}
          cloudBinding={{
            library: cloudLibrary(commands),
            host: createLocalPhotoEditingHost(commands),
            actorId: "personal-user-1",
            copyLocalPhoto,
          }}
        />,
      );
    });
    await settle();

    const sourceSwitch = () => container.querySelector('[role="group"][aria-label="写真の保存先"]');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="海辺.jpg"]')?.click();
    });
    const copyButton = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "クラウドにコピー");
    expect(copyButton()).not.toBeUndefined();

    await act(async () => {
      copyButton()?.click();
      copyButton()?.click();
      await Promise.resolve();
    });
    expect(copyLocalPhoto).toHaveBeenCalledTimes(1);
    expect(copyLocalPhoto.mock.calls[0]?.[0]).toBe("opaque-local-photo");
    expect(copyButton()?.disabled).toBe(true);

    await act(async () => progress[0]?.(0.42));
    expect(container.textContent).toContain("クラウドにコピー中… 42%");
    await act(async () => {
      Array.from(sourceSwitch()?.querySelectorAll<HTMLButtonElement>("button") ?? [])
        .find((button) => button.textContent === "クラウド")?.click();
      await Promise.resolve();
    });
    expect(Array.from(sourceSwitch()?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.getAttribute("aria-pressed") === "true")?.textContent).toBe("この Mac");
    await act(async () => finish?.({ cloudPhotoId: "opaque-cloud-photo" }));
    await settle();
    expect(container.textContent).toContain("クラウドにコピーしました。");
    const openButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "クラウドで開く");
    expect(openButton).not.toBeUndefined();
    await act(async () => openButton?.click());
    await settle();
    expect(container.querySelector('nav[aria-label="表示中の場所"]')?.textContent).toContain("クラウド");
  });

  it("keeps a rejected cloud copy as a failure and does not offer opening cloud", async () => {
    const { commands } = fakeCommands({ photoBenchEdits: false, rememberedFolder: true, rememberedPhoto: true });
    await act(async () => {
      root.render(
        <App
          commands={commands}
          loadAppInfo={async () => null}
          watchUpdate={async () => () => undefined}
          cloudBinding={{
            library: cloudLibrary(commands),
            host: createLocalPhotoEditingHost(commands),
            actorId: "personal-user-1",
            copyLocalPhoto: async () => { throw new Error("private detail"); },
          }}
        />,
      );
    });
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="海辺.jpg"]')?.click());
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent === "クラウドにコピー")?.click();
      await Promise.resolve();
    });
    await settle();
    expect(container.textContent).toContain("クラウドにコピーできませんでした。もう一度お試しください。");
    expect(container.textContent).not.toContain("クラウドにコピーしました。");
    expect(container.textContent).not.toContain("クラウドで開く");
  });

  it("leaves out the version line when the app info is unavailable", async () => {
    const { commands } = fakeCommands({ photoBenchEdits: false });
    await render(commands, null);
    expect(container.querySelector('aside[aria-label="写真の場所"]')?.textContent).not.toContain("版");
  });

  it("hides and shows the left panel from the header and remembers it on this Mac", async () => {
    const { commands } = fakeCommands({ photoBenchEdits: false });
    await render(commands);
    const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-label="左のパネル"]');
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('aside[aria-label="写真の場所"]')).not.toBeNull();

    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('aside[aria-label="写真の場所"]')).toBeNull();
    expect(window.localStorage.getItem(PHOTO_TREE_HIDDEN_KEY)).toBe("1");

    await act(async () => toggle()?.click());
    expect(container.querySelector('aside[aria-label="写真の場所"]')).not.toBeNull();
    expect(window.localStorage.getItem(PHOTO_TREE_HIDDEN_KEY)).toBeNull();
  });

  it("shows the Photo Bench notice once and never again after it is closed on this Mac", async () => {
    const first = fakeCommands({ photoBenchEdits: true });
    await render(first.commands);
    const shown = notice();
    expect(shown).not.toBeNull();
    // 編集面の上に出す
    const surface = container.querySelector('section[aria-label="ブラウザ写真編集"]');
    expect(shown && surface ? shown.compareDocumentPosition(surface) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();

    await act(async () => {
      shown?.querySelector<HTMLButtonElement>('button[aria-label="案内を閉じる"]')?.click();
    });
    expect(notice()).toBeNull();
    expect(window.localStorage.getItem(PHOTO_BENCH_NOTICE_DISMISSED_KEY)).not.toBeNull();

    const second = fakeCommands({ photoBenchEdits: true });
    await remount(second.commands);
    expect(notice()).toBeNull();
    expect(second.calls).not.toContain("camera_photo_bench_edits");
  });

});
