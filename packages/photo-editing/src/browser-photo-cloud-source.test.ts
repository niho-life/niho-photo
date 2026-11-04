import { describe, expect, it, vi } from "vitest";

import type { PhotoLibraryItem } from "./library/photo-library";
import * as cloudSource from "./browser-photo-cloud-source";
import {
  BROWSER_CLOUD_NO_LIST_FILTER,
  BROWSER_NO_ORIGINAL_LOCKED_MESSAGE,
  DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE,
  appliedBrowserCloudListFilter,
  browserCloudAlbumPlace,
  browserCloudListParams,
  browserCloudLockedReason,
  browserCloudPhotoKind,
  browserCloudPhotoPlace,
  browserCloudPlaceListFilter,
  browserCloudPlaceAlbumId,
  browserFolderPlace,
  browserPlaceFolderId,
  canFavoriteBrowserCloudPhoto,
  canFilterBrowserCloudPlace,
  countBrowserCloudListFilter,
  isBrowserCloudPhotoInFilter,
  isBrowserCloudPhotoInPlace,
  isBrowserCloudRawPhoto,
  isBrowserSelectedPhotosPlace,
  type BrowserCloudListFilter,
} from "./browser-photo-cloud-source";

function cloudPhoto(overrides: Partial<PhotoLibraryItem> = {}): PhotoLibraryItem {
  return {
    id: "cloud-1",
    contentSha256: "a".repeat(64),
    fileName: "IMG_1.jpg",
    fileExtension: "jpg",
    sizeBytes: 100,
    previewUrl: "https://storage.test/preview.jpg",
    hasOriginal: true,
    hasPreview: true,
    hasWebImage: false,
    hasDevelopSettings: false,
    developSettings: null,
    developSettingsUpdatedAt: null,
    developRevision: 0,
    webRenderedRevision: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    uploadedBy: null,
    ...overrides,
  };
}

describe("木と印", () => {
  it("「写真」はオリジナルのある行だけ。Desktop の「オリジナルを置かない」写真（補正あり）も「記事の画像」", () => {
    expect(browserCloudPhotoPlace(cloudPhoto())).toBe("photos");
    expect(browserCloudPhotoPlace(cloudPhoto({ hasOriginal: false, hasPreview: true, hasDevelopSettings: true }))).toBe("articleImages");
    expect(browserCloudPhotoPlace(cloudPhoto({ hasOriginal: false, hasWebImage: true }))).toBe("articleImages");
  });

  it("場所の一覧はサーバーで絞る条件と、手元の写真を選り分ける条件が同じ。「お気に入り」は元の写真のある ♥ の写真だけ（F5b #17125）", () => {
    expect(browserCloudPlaceListFilter("photos")).toEqual({ hasOriginal: true });
    expect(browserCloudPlaceListFilter("favorites")).toEqual({ hasOriginal: true, favorite: true });
    expect(browserCloudPlaceListFilter("articleImages")).toEqual({ hasOriginal: false });
    expect(browserCloudAlbumPlace("album-1")).toBe("album:album-1");
    expect(browserCloudPlaceAlbumId("album:album-1")).toBe("album-1");
    expect(browserCloudPlaceListFilter("album:album-1")).toEqual({ hasOriginal: true, albumId: "album-1" });

    const favorite = cloudPhoto({ favorite: true });
    expect(isBrowserCloudPhotoInPlace(favorite, "photos")).toBe(true);
    expect(isBrowserCloudPhotoInPlace(favorite, "favorites")).toBe(true);
    expect(isBrowserCloudPhotoInPlace(cloudPhoto(), "favorites")).toBe(false);
    expect(isBrowserCloudPhotoInPlace(cloudPhoto({ hasOriginal: false, favorite: true }), "favorites")).toBe(false);
    expect(isBrowserCloudPhotoInPlace(cloudPhoto({ hasOriginal: false }), "articleImages")).toBe(true);
    expect(canFavoriteBrowserCloudPhoto(cloudPhoto())).toBe(true);
    expect(canFavoriteBrowserCloudPhoto(cloudPhoto({ hasOriginal: false }))).toBe(false);
  });

  it("RAW の印は拡張子で決め、記事から取り込んだ WebP は RAW にしない", () => {
    expect(isBrowserCloudRawPhoto(cloudPhoto({ fileExtension: "rw2" }))).toBe(true);
    expect(isBrowserCloudRawPhoto(cloudPhoto({ fileExtension: "webp" }))).toBe(false);
    expect(isBrowserCloudRawPhoto(cloudPhoto({ fileExtension: "heic" }))).toBe(false);
  });

  it("絞り込み（種類・補正済み。F5b #17125）は「写真」「お気に入り」だけに掛け、サーバーへ送る条件と手元の写真を選り分ける条件が同じ", () => {
    const both: BrowserCloudListFilter = { kind: "raw", edited: true };
    expect(canFilterBrowserCloudPlace("photos")).toBe(true);
    expect(canFilterBrowserCloudPlace("favorites")).toBe(true);
    expect(canFilterBrowserCloudPlace("articleImages")).toBe(false);
    expect(canFilterBrowserCloudPlace("album:album-1")).toBe(false);
    expect(browserCloudListParams("photos", both)).toEqual({ hasOriginal: true, kind: "raw", edited: true });
    expect(browserCloudListParams("favorites", { kind: null, edited: false })).toEqual({
      hasOriginal: true,
      favorite: true,
      edited: false,
    });
    // 記事の画像では送らない。条件が無ければ場所の分だけ（今までと同じ）
    expect(browserCloudListParams("articleImages", both)).toEqual({ hasOriginal: false });
    expect(browserCloudListParams("album:album-1", both)).toEqual({ hasOriginal: true, albumId: "album-1" });
    expect(browserCloudListParams("photos", BROWSER_CLOUD_NO_LIST_FILTER)).toEqual({ hasOriginal: true });
    expect(appliedBrowserCloudListFilter("articleImages", both)).toEqual(BROWSER_CLOUD_NO_LIST_FILTER);
    expect(appliedBrowserCloudListFilter("favorites", both)).toBe(both);
    expect(countBrowserCloudListFilter(BROWSER_CLOUD_NO_LIST_FILTER)).toBe(0);
    expect(countBrowserCloudListFilter({ kind: "jpeg", edited: null })).toBe(1);
    expect(countBrowserCloudListFilter({ kind: null, edited: false })).toBe(1);
    expect(countBrowserCloudListFilter(both)).toBe(2);
  });

  it("この Mac のフォルダの場所（NIHO camera C3 #18391）はフォルダだけで読み、クラウドの条件を付けない。絞り込みは掛ける", () => {
    const both: BrowserCloudListFilter = { kind: "raw", edited: true };
    expect(browserFolderPlace("folder-1")).toBe("folder:folder-1");
    expect(browserPlaceFolderId("folder:folder-1")).toBe("folder-1");
    expect(browserPlaceFolderId("photos")).toBeNull();
    expect(browserPlaceFolderId("album:folder-1")).toBeNull();
    expect(browserCloudPlaceAlbumId("folder:folder-1")).toBeNull();
    expect(browserCloudPlaceListFilter("folder:folder-1")).toEqual({ folderId: "folder-1" });
    expect(canFilterBrowserCloudPlace("folder:folder-1")).toBe(true);
    expect(browserCloudListParams("folder:folder-1", both)).toEqual({ folderId: "folder-1", kind: "raw", edited: true });
    expect(browserCloudListParams("folder:folder-1", BROWSER_CLOUD_NO_LIST_FILTER)).toEqual({ folderId: "folder-1" });
    // 一覧に載ったかは画面が見る（行だけでは分からない）
    expect(isBrowserCloudPhotoInPlace(cloudPhoto({ hasOriginal: false }), "folder:folder-1")).toBe(true);

    // 種類は拡張子で決める（RAW は JPEG / PNG / TIFF / HEIC / HEIF 以外。PNG / TIFF・記事の WebP はどの種類でもない）
    expect(browserCloudPhotoKind(cloudPhoto({ fileExtension: "JPG" }))).toBe("jpeg");
    expect(browserCloudPhotoKind(cloudPhoto({ fileExtension: "jpeg" }))).toBe("jpeg");
    expect(browserCloudPhotoKind(cloudPhoto({ fileExtension: "heif" }))).toBe("heic");
    expect(browserCloudPhotoKind(cloudPhoto({ fileExtension: "rw2" }))).toBe("raw");
    expect(browserCloudPhotoKind(cloudPhoto({ fileExtension: "png" }))).toBeNull();
    expect(browserCloudPhotoKind(cloudPhoto({ fileExtension: "tif" }))).toBeNull();
    expect(browserCloudPhotoKind(cloudPhoto({ fileExtension: "webp" }))).toBeNull();

    const editedRaw = cloudPhoto({ fileExtension: "rw2", hasEdits: true });
    expect(isBrowserCloudPhotoInFilter(editedRaw, both)).toBe(true);
    expect(isBrowserCloudPhotoInFilter(editedRaw, { kind: "jpeg", edited: null })).toBe(false);
    expect(isBrowserCloudPhotoInFilter(editedRaw, { kind: null, edited: false })).toBe(false);
    // hasEdits の無い古い行・保存したことの無い写真は未補正
    expect(isBrowserCloudPhotoInFilter(cloudPhoto(), { kind: null, edited: false })).toBe(true);
    expect(isBrowserCloudPhotoInFilter(cloudPhoto(), { kind: null, edited: true })).toBe(false);
    // PNG は絞り込まないときだけ
    expect(isBrowserCloudPhotoInFilter(cloudPhoto({ fileExtension: "png" }), BROWSER_CLOUD_NO_LIST_FILTER)).toBe(true);
    expect(isBrowserCloudPhotoInFilter(cloudPhoto({ fileExtension: "png" }), { kind: "jpeg", edited: null })).toBe(false);
  });

  it("選別（採用だけ / 却下を隠す。niho-photo#47）は種類・補正済みと一緒に掛かり、サーバーへ送る条件と手元の写真を選り分ける条件が同じ", () => {
    const picks: BrowserCloudListFilter = { kind: null, edited: null, flag: "pick" };
    const kept: BrowserCloudListFilter = { kind: "raw", edited: null, flag: "notRejected" };
    expect(browserCloudListParams("folder:folder-1", picks)).toEqual({ folderId: "folder-1", flag: "pick" });
    expect(browserCloudListParams("selected", kept)).toEqual({ localSource: "selected", kind: "raw", flag: "notRejected" });
    expect(browserCloudListParams("photos", { ...picks, flag: null })).toEqual({ hasOriginal: true });
    // 記事の画像では送らない
    expect(browserCloudListParams("articleImages", picks)).toEqual({ hasOriginal: false });
    expect(countBrowserCloudListFilter(picks)).toBe(1);
    expect(countBrowserCloudListFilter(kept)).toBe(2);
    expect(countBrowserCloudListFilter({ kind: "jpeg", edited: true, flag: "pick" })).toBe(3);
    expect(BROWSER_CLOUD_NO_LIST_FILTER.flag ?? null).toBeNull();

    const picked = cloudPhoto({ flag: "pick" });
    const rejected = cloudPhoto({ flag: "reject" });
    const unflagged = cloudPhoto({ flag: null });
    // フラグの無い古い行（`flag` を省いた行）はフラグなし
    const legacy = cloudPhoto();
    expect([picked, rejected, unflagged, legacy].map((photo) => isBrowserCloudPhotoInFilter(photo, picks))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    const notRejected = { ...picks, flag: "notRejected" as const };
    expect([picked, rejected, unflagged, legacy].map((photo) => isBrowserCloudPhotoInFilter(photo, notRejected))).toEqual([
      true,
      false,
      true,
      true,
    ]);
    // 絞らなければ却下した写真も出る（却下は消さない）
    expect(isBrowserCloudPhotoInFilter(rejected, BROWSER_CLOUD_NO_LIST_FILTER)).toBe(true);
    // 種類と一緒に
    expect(isBrowserCloudPhotoInFilter(cloudPhoto({ fileExtension: "rw2", flag: "pick" }), kept)).toBe(true);
    expect(isBrowserCloudPhotoInFilter(cloudPhoto({ fileExtension: "jpg", flag: "pick" }), kept)).toBe(false);
  });

  it("「選んだ写真」は folderId と混ぜず明示的な localSource で読み、一覧内の行だけを絞り込む", () => {
    const filter: BrowserCloudListFilter = { kind: "jpeg", edited: false };
    expect(isBrowserSelectedPhotosPlace("selected")).toBe(true);
    expect(isBrowserSelectedPhotosPlace("folder:selected")).toBe(false);
    expect(browserCloudPlaceListFilter("selected")).toEqual({ localSource: "selected" });
    expect(browserCloudListParams("selected", filter)).toEqual({ localSource: "selected", kind: "jpeg", edited: false });
    expect(canFilterBrowserCloudPlace("selected")).toBe(true);
    expect(isBrowserCloudPhotoInPlace(cloudPhoto({ hasOriginal: false }), "selected")).toBe(true);
  });

  it("開かずに分かる直せない理由: 記事の画像・RAW・TIFF / HEIC・10MiB 超の PNG・64MiB 超の JPEG。JPEG / PNG は開くまで分からない（null）", () => {
    expect(browserCloudLockedReason(cloudPhoto({ hasOriginal: false }))).toBe(BROWSER_NO_ORIGINAL_LOCKED_MESSAGE);
    // 元の写真が無い行（記事の画像）は次の一歩を添えない 1 行（K4 移行元設計）
    expect(BROWSER_NO_ORIGINAL_LOCKED_MESSAGE).toBe("元の写真が無いため編集できません");
    expect(browserCloudLockedReason(cloudPhoto({ fileExtension: "nef" }))).toBe(DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE);
    expect(browserCloudLockedReason(cloudPhoto({ fileExtension: "tif" }))).toBe(DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE);
    expect(browserCloudLockedReason(cloudPhoto({ fileExtension: "png", sizeBytes: 10 * 1024 * 1024 + 1 }))).toBe(
      DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE,
    );
    // JPEG は 64MiB まで読む（K5-a 移行元設計）
    expect(browserCloudLockedReason(cloudPhoto({ sizeBytes: 10 * 1024 * 1024 + 1 }))).toBeNull();
    expect(browserCloudLockedReason(cloudPhoto({ sizeBytes: 64 * 1024 * 1024 }))).toBeNull();
    expect(browserCloudLockedReason(cloudPhoto({ sizeBytes: 64 * 1024 * 1024 + 1 }))).toBe(
      DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE,
    );
    expect(browserCloudLockedReason(cloudPhoto({ fileExtension: "png", hasDevelopSettings: true }))).toBeNull();
  });

  it("閲覧だけにする理由は新しい版・準備失敗・編集元不一致・原本欠落。NIHO Desktopへ送る文を持たない", () => {
    const lockedMessages = Object.entries(cloudSource)
      .filter(([name, value]) => name.endsWith("_LOCKED_MESSAGE") && typeof value === "string")
      .map(([name]) => name)
      .sort();
    // オリジナルの無い写真の 1 行は K4 移行元設計 で見直す
    expect(lockedMessages).toEqual([
      "BROWSER_NO_ORIGINAL_LOCKED_MESSAGE",
      "DEVELOP_ENGINE_BASE_MISMATCH_LOCKED_MESSAGE",
      "DEVELOP_ENGINE_NEWER_LOCKED_MESSAGE",
      "DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE",
    ]);
    for (const [name, value] of Object.entries(cloudSource)) {
      if (typeof value === "string" && name.endsWith("_MESSAGE")) expect(value).not.toContain("NIHO Desktop");
    }
  });
});

describe("クラウド写真を開く", () => {
  it("編集不可の選択表示では原本を読まず、選択済みの補正済みpreviewを表示する", async () => {
    const editedPreview = { revision: 2, width: 1200, height: 800, url: "blob:verified-preview", thumbUrl: null };
    const openOriginal = vi.fn();
    const signal = new AbortController().signal;
    const result = await cloudSource.loadBrowserCloudPhotoSource({
      openOriginal,
      loadOriginal: vi.fn(),
      readArticleImage: vi.fn(),
    } as never, cloudPhoto(), signal, { allowEditing: false, selectedEditedPreview: editedPreview });

    expect(openOriginal).not.toHaveBeenCalled();
    expect(result).toMatchObject({ file: null, viewUrl: "blob:verified-preview", lockedReason: null, photo: null });
  });
});
