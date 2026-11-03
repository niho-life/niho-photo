import { beforeEach, describe, expect, it, vi } from "vitest";

// 端末への保存はアプリの都合（`PhotoEditingHost.saveFile`。web は saveFileToDevice）を受け取る（移行元設計）
const saveFileMock = vi.fn<(file: { blob: Blob; fileName: string }) => Promise<"saved" | "cancelled" | "downloaded">>();

import {
  PHOTO_SAVE_MAX_FILES,
  photoSaveEnv,
  photoSaveActionLabel,
  resolvePhotoSaveRoute,
  savePhotosToDevice,
} from "./save-photos-to-device";

/** スマホで書き出した写真を端末に保存する（F6c 移行元設計・F6a 移行元設計 の実測）。 */

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";

function jpeg(name: string): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], name, { type: "image/jpeg" });
}

function shareNavigator(options: { canShare?: boolean; share?: () => Promise<void>; active?: boolean; userAgent?: string } = {}) {
  return {
    userAgent: options.userAgent ?? IPHONE_UA,
    canShare: vi.fn(() => options.canShare ?? true),
    share: vi.fn(options.share ?? (async () => undefined)),
    ...(options.active === undefined ? {} : { userActivation: { isActive: options.active } }),
  };
}

function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

beforeEach(() => {
  saveFileMock.mockReset();
});

describe("resolvePhotoSaveRoute", () => {
  it("JPEG のファイルを共有シートに渡せるなら share", () => {
    const nav = shareNavigator();
    expect(resolvePhotoSaveRoute({ navigator: nav, nativeFileSaveAvailable: () => true })).toBe("share");
    expect(nav.canShare).toHaveBeenCalledWith({ files: [expect.any(File)] });
  });

  it("共有シートが無い Android の NIHO アプリは native の保存（device-file）、どちらも無ければ download", () => {
    const noShare = { userAgent: ANDROID_UA };
    expect(resolvePhotoSaveRoute({ navigator: noShare, nativeFileSaveAvailable: () => true })).toBe("device-file");
    expect(resolvePhotoSaveRoute({ navigator: noShare, nativeFileSaveAvailable: () => false })).toBe("download");
    const cannot = shareNavigator({ canShare: false });
    expect(resolvePhotoSaveRoute({ navigator: cannot, nativeFileSaveAvailable: () => false })).toBe("download");
  });

  it("文言は iPhone の共有シートが「写真に保存」、Android と保存先を選ぶ経路は「端末に保存」", () => {
    expect(photoSaveActionLabel("share", { navigator: { userAgent: IPHONE_UA } })).toBe("写真に保存");
    expect(photoSaveActionLabel("share", { navigator: { userAgent: ANDROID_UA } })).toBe("端末に保存");
    expect(photoSaveActionLabel("device-file", { navigator: { userAgent: ANDROID_UA } })).toBe("端末に保存");
  });
});

describe("savePhotosToDevice（share）", () => {
  const env = (nav: ReturnType<typeof shareNavigator>) => ({
    navigator: nav,
    nativeFileSaveAvailable: () => false,
    saveFile: saveFileMock,
  });

  it("操作の中なら全部を 1 回の共有シートに渡す", async () => {
    const nav = shareNavigator({ active: true });
    const files = [jpeg("a.jpg"), jpeg("b.jpg")];
    await expect(savePhotosToDevice(files, "share", env(nav))).resolves.toEqual({ kind: "shared" });
    expect(nav.share).toHaveBeenCalledWith({ files });
  });

  it("操作から時間が経っていたら共有シートを呼ばず needs-tap（もう一度押してもらう）", async () => {
    const nav = shareNavigator({ active: false });
    await expect(savePhotosToDevice([jpeg("a.jpg")], "share", env(nav))).resolves.toEqual({ kind: "needs-tap" });
    expect(nav.share).not.toHaveBeenCalled();
  });

  it("userActivation の無い端末では NotAllowedError を needs-tap、AbortError を cancelled にし、他は日本語の Error", async () => {
    const notAllowed = shareNavigator({ share: async () => Promise.reject(domError("NotAllowedError")) });
    await expect(savePhotosToDevice([jpeg("a.jpg")], "share", env(notAllowed))).resolves.toEqual({ kind: "needs-tap" });
    const aborted = shareNavigator({ share: async () => Promise.reject(domError("AbortError")) });
    await expect(savePhotosToDevice([jpeg("a.jpg")], "share", env(aborted))).resolves.toEqual({ kind: "cancelled" });
    const broken = shareNavigator({ share: async () => Promise.reject(domError("DataError")) });
    await expect(savePhotosToDevice([jpeg("a.jpg")], "share", env(broken))).rejects.toThrow("写真を保存できませんでした");
  });

  it(`${PHOTO_SAVE_MAX_FILES} 枚を超えたら保存しない`, async () => {
    const nav = shareNavigator({ active: true });
    const files = Array.from({ length: PHOTO_SAVE_MAX_FILES + 1 }, (_, index) => jpeg(`${index}.jpg`));
    await expect(savePhotosToDevice(files, "share", env(nav))).rejects.toThrow(`${PHOTO_SAVE_MAX_FILES} 枚まで`);
    expect(nav.share).not.toHaveBeenCalled();
  });
});

describe("savePhotosToDevice（device-file / download）", () => {
  const env = { navigator: { userAgent: ANDROID_UA }, nativeFileSaveAvailable: () => true, saveFile: saveFileMock };

  it("1 枚ずつアプリの端末への保存（saveFile）に渡し、保存できた枚数を返す", async () => {
    saveFileMock.mockResolvedValue("saved");
    const files = [jpeg("a.jpg"), jpeg("b.jpg")];
    await expect(savePhotosToDevice(files, "device-file", env)).resolves.toEqual({ kind: "saved", saved: 2 });
    expect(saveFileMock.mock.calls.map(([file]) => file.fileName)).toEqual(["a.jpg", "b.jpg"]);
    expect(saveFileMock.mock.calls[0]?.[0].blob).toBe(files[0]);
  });

  it("途中で保存先の選択をやめたら、そこで止める（1 枚目なら cancelled）", async () => {
    saveFileMock.mockResolvedValueOnce("cancelled");
    await expect(savePhotosToDevice([jpeg("a.jpg"), jpeg("b.jpg")], "device-file", env)).resolves.toEqual({ kind: "cancelled" });
    saveFileMock.mockReset();
    saveFileMock.mockResolvedValueOnce("saved").mockResolvedValueOnce("cancelled");
    await expect(savePhotosToDevice([jpeg("a.jpg"), jpeg("b.jpg"), jpeg("c.jpg")], "device-file", env)).resolves.toEqual({
      kind: "saved",
      saved: 1,
    });
    expect(saveFileMock).toHaveBeenCalledTimes(2);
  });
});

describe("savePhotosToDeviceの本人scope", () => {
  it("photoSaveEnvが同じsignalとhostに束縛した同期検証を渡す", () => {
    const host = {
      scopeSignal: new AbortController().signal,
      current: true,
      isScopeCurrent() { return this.current; },
      nativeFileSaveAvailable: () => false,
      saveFile: saveFileMock,
    };
    const env = photoSaveEnv(host);
    expect(env.scopeSignal).toBe(host.scopeSignal);
    expect(env.isScopeCurrent?.()).toBe(true);
    host.current = false;
    expect(env.isScopeCurrent?.()).toBe(false);
  });

  it.each(["aborted", "verifying", "throws"])("%sのscopeでOSへ渡さない", async (state) => {
    const controller = new AbortController();
    if (state === "aborted") controller.abort();
    const nav = shareNavigator({ active: true });
    const env = {
      navigator: nav, saveFile: saveFileMock, scopeSignal: controller.signal,
      isScopeCurrent: () => { if (state === "throws") throw new Error("unavailable"); return state !== "verifying"; },
    };
    for (const route of ["share", "device-file", "download"] as const) {
      await expect(savePhotosToDevice([jpeg("a.jpg")], route, env)).resolves.toEqual({ kind: "cancelled" });
    }
    expect(nav.share).not.toHaveBeenCalled();
    expect(saveFileMock).not.toHaveBeenCalled();
  });

  it("OS共有直前にscopeを再確認する", async () => {
    let current = true;
    const nav = shareNavigator();
    Object.defineProperty(nav, "userActivation", { get: () => { current = false; return { isActive: true }; } });
    await expect(savePhotosToDevice([jpeg("a.jpg")], "share", {
      navigator: nav, saveFile: saveFileMock, isScopeCurrent: () => current,
    })).resolves.toEqual({ kind: "cancelled" });
    expect(nav.share).not.toHaveBeenCalled();
  });

  it.each([false, true])("開始済み共有の遅着%sを新scopeの成功/再タップにしない", async (reject) => {
    const controller = new AbortController();
    const nav = shareNavigator({ share: async () => {
      controller.abort();
      if (reject) throw domError("NotAllowedError");
    } });
    await expect(savePhotosToDevice([jpeg("a.jpg")], "share", {
      navigator: nav, saveFile: saveFileMock, scopeSignal: controller.signal,
    })).resolves.toEqual({ kind: "cancelled" });
    expect(nav.share).toHaveBeenCalledOnce();
  });

  it.each(["device-file", "download"] as const)("%sで1枚目のawait後に失効したら次へ渡さない", async (route) => {
    let current = true;
    saveFileMock.mockImplementation(async () => { current = false; return "saved"; });
    await expect(savePhotosToDevice([jpeg("a.jpg"), jpeg("b.jpg")], route, {
      navigator: null, saveFile: saveFileMock, isScopeCurrent: () => current,
    })).resolves.toEqual({ kind: "cancelled" });
    expect(saveFileMock).toHaveBeenCalledOnce();
  });

  it("保存の失敗が失効後に届いたら取消しにし、現在のscopeの失敗は維持する", async () => {
    const controller = new AbortController();
    saveFileMock.mockImplementationOnce(async () => { controller.abort(); throw new Error("old failure"); });
    await expect(savePhotosToDevice([jpeg("a.jpg")], "device-file", {
      navigator: null, saveFile: saveFileMock, scopeSignal: controller.signal,
    })).resolves.toEqual({ kind: "cancelled" });
    saveFileMock.mockRejectedValueOnce(new Error("current failure"));
    await expect(savePhotosToDevice([jpeg("a.jpg")], "download", {
      navigator: null, saveFile: saveFileMock, isScopeCurrent: () => true,
    })).rejects.toThrow("current failure");
  });
});
