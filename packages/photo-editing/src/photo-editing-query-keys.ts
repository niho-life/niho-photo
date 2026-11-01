/**
 * 写真編集の react-query の鍵（NIHO camera C1 移行元設計）。編集面（packages/photo-editing）とアプリ（web の `queryKeys.admin.photoEditing`）が
 * 同じ鍵で読み書きする（読み直し・書き換えの接頭辞がそろう）。既存名の `spotId` は認可上の拠点 ID ではなく写真の出どころの
 * namespace（web は拠点、NIHO photo の個人クラウドは本人と local / cloud の組）として扱う。個人ライブラリは互換追加の `scopeKey` で別rootに分ける。
 */
function withPhotoLibraryScope(key: readonly unknown[], scopeKey?: string): readonly unknown[] {
  if (scopeKey === undefined) return key;
  return [...key.slice(0, 2), "scope", scopeKey, ...key.slice(2)];
}

export const photoEditingQueryKeys = {
  /** 拠点で取り込んだプリセット（API） */
  spotPresets: (spotId: string | null | undefined, scopeKey?: string) =>
    withPhotoLibraryScope(["admin", "photoEditing", "spotPresets", spotId], scopeKey),
  /** 段 2 の wasm crate に同梱したプリセット（拠点によらない） */
  developBuiltinPresets: () => ["admin", "photoEditing", "builtinPresets", "develop"] as const,
  /** クラウドの写真置き場の一覧と使用量（API、ページ送り）。 */
  cloudPhotos: (spotId: string | null | undefined, scopeKey?: string) =>
    withPhotoLibraryScope(["admin", "photoEditing", "cloudPhotos", spotId], scopeKey),
  /**
   * 並び（追加日 / 撮影日）と元の写真の有無・お気に入り・種類・補正済みで絞った一覧（移行元設計 / 移行元設計。`cloudPhotos` の下。
   * null は絞らない。種類・補正済みは省くと null にそろえる）。この Mac のフォルダの一覧（NIHO camera C3 移行元設計）は `folderId` も
   * 持つ（フォルダの無い一覧は鍵に入れない = クラウドの鍵は変わらない）。選別（niho-photo#47）で絞った一覧だけ `flag` を持つ（絞らない
   * 一覧の鍵は変わらない）
   */
  cloudPhotosList: (
    spotId: string | null | undefined,
    list: {
      sort: "added" | "captured";
      hasOriginal: boolean | null;
      favorite: boolean | null;
      albumId?: string | null;
      kind?: "raw" | "jpeg" | "heic" | null;
      edited?: boolean | null;
      flag?: "pick" | "notRejected" | null;
      folderId?: string | null;
      localSource?: "selected" | null;
    },
    scopeKey?: string,
  ) =>
    withPhotoLibraryScope(
      [
      "admin",
      "photoEditing",
      "cloudPhotos",
      spotId,
      {
        sort: list.sort,
        hasOriginal: list.hasOriginal,
        favorite: list.favorite,
        albumId: list.albumId ?? null,
        kind: list.kind ?? null,
        edited: list.edited ?? null,
        ...(list.flag ? { flag: list.flag } : {}),
        ...(list.folderId ? { folderId: list.folderId } : {}),
        ...(list.localSource ? { localSource: list.localSource } : {}),
      },
      ],
      scopeKey,
    ),
  /** クラウドのアルバム一覧（名前順、表紙と写真件数を含む） */
  cloudAlbums: (spotId: string | null | undefined, scopeKey?: string) =>
    withPhotoLibraryScope(["admin", "photoEditing", "cloudAlbums", spotId], scopeKey),
  /** クラウドの使用量と上限（設定サブタブの「クラウド」。一覧の 1 件だけを読んで `usage` を使う） */
  cloudUsage: (spotId: string | null | undefined, scopeKey?: string) =>
    withPhotoLibraryScope(["admin", "photoEditing", "cloudUsage", spotId], scopeKey),
  /** 写真のフォルダの木（`PhotoLibrary.folders.tree`。置き場ごと。NIHO camera C3 移行元設計） */
  folders: (place: "cloud" | "local", ownerScope?: string, scopeKey?: string) =>
    withPhotoLibraryScope(["admin", "photoEditing", "folders", place, ownerScope ?? null], scopeKey),
  /** この Mac の「選んだ写真」の現在も読める件数。 */
  selectedPhotos: (place: "cloud" | "local", ownerScope?: string, scopeKey?: string) =>
    withPhotoLibraryScope(["admin", "photoEditing", "selectedPhotos", place, ownerScope ?? null], scopeKey),
  /** 写真の情報（`PhotoLibrary.info`。右パネルの「情報」。置き場・写真・中身ごと。niho-photo#43） */
  photoInfo: (place: "cloud" | "local", photoId: string, contentSha256: string | null, scopeKey?: string) =>
    withPhotoLibraryScope(["admin", "photoEditing", "photoInfo", place, photoId, contentSha256], scopeKey),
};
