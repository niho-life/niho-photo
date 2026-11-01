"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient, type InfiniteData, type QueryClient, type QueryKey } from "@tanstack/react-query";

import type { PhotoCloudListPage } from "./use-photo-cloud-photos";
import { photoEditingQueryKeys } from "./photo-editing-query-keys";
import type { PhotoLibraryItem } from "./library/photo-library";
import { usePhotoLibrary } from "./library/photo-library-context";

/**
 * お気に入り（♥）の付け外し（F5b 移行元設計 の画面 1 本目・移行時の設計文書「画面（お気に入り）」）。
 * 1 枚ずつ送る（接続口 `PhotoLibrary` の `favorites.set` は配列で受けるので `[photoId]`。移行元設計）。お気に入りは拠点のスタッフで共有する。
 *
 * - 押した直後に、読み込んであるすべての一覧（`cloudPhotos` の接頭辞。場所・並び・絞り込みごとの一覧）でその写真の `favorite` と、最初の
 *   ページの件数 `counts.favorites`（±1・0 未満にしない）を書き換える。♥ で絞った一覧（「お気に入り」）からは、外した写真を外す。
 *   一覧の外の写真（URL で開いた・このタブで追加した）は `applyLocal` で同じく書き換える
 * - 付けた写真が ♥ で絞った一覧に無ければ、送り終えてからその一覧を読み直す（送る前に読むと、まだ付いていない一覧が返る）。
 *   送っている間に読み直した一覧（前の値のまま）も、送り終えたら書き換え直す
 * - 同じ写真への 2 回目は、送り終えるまで受けない（`pendingIds`）
 * - 楽観更新の前後で一覧の取得を止め、古い応答が新しい値を上書きしないようにする。成功後は既知の一覧を更新し、追加が必要な絞り込みだけ読み直す
 * - 送れなかった・変えられなかった（`updated` が 0 = ほかのスタッフが消した・記事の画像）ら、逆の書き換えと行の再挿入で戻し、
 *   一覧を読み直して並びと件数を合わせてから `onError` を呼ぶ
 * - ほかのスタッフの変更は、画面を出したときの一覧の読み直し（`staleTime: 0`）で見える。追加の同期はしない
 */

type PhotoCloudPages = InfiniteData<PhotoCloudListPage, string | null>;
type CachedPhotoPlacement = {
  queryKey: QueryKey;
  pageIndex: number;
  photoIndex: number;
  photo: PhotoLibraryItem;
};

/** 一覧の query key の末尾（`cloudPhotosList` の絞り込み）。無ければ絞らない（null）。 */
export function photoCloudListFilter(queryKey: QueryKey): {
  hasOriginal: boolean | null;
  favorite: boolean | null;
  kind: "raw" | "jpeg" | "heic" | null;
  edited: boolean | null;
} {
  const list = queryKey.at(-1) as
    | {
        hasOriginal?: boolean | null;
        favorite?: boolean | null;
        kind?: "raw" | "jpeg" | "heic" | null;
        edited?: boolean | null;
      }
    | undefined;
  return {
    hasOriginal: list?.hasOriginal ?? null,
    favorite: list?.favorite ?? null,
    kind: list?.kind ?? null,
    edited: list?.edited ?? null,
  };
}

/** 楽観削除の前に、読込済みqueryごとに対象写真の位置だけを控える。 */
function snapshotPhotoPlacements(
  queryClient: QueryClient,
  queryKey: QueryKey,
  photoId: string,
): CachedPhotoPlacement[] {
  const placements: CachedPhotoPlacement[] = [];
  for (const [listQueryKey, data] of queryClient.getQueriesData<PhotoCloudPages>({ queryKey })) {
    if (!data) continue;
    for (let pageIndex = 0; pageIndex < data.pages.length; pageIndex += 1) {
      const photos = data.pages[pageIndex]?.photos ?? [];
      const photoIndex = photos.findIndex((photo) => photo.id === photoId);
      if (photoIndex < 0) continue;
      placements.push({ queryKey: listQueryKey, pageIndex, photoIndex, photo: photos[photoIndex]! });
      break;
    }
  }
  return placements;
}

/** 失敗時は他の行・更新を保ち、消えてしまった対象行だけを元のページへ戻す。 */
function restorePhotoPlacements(queryClient: QueryClient, photoId: string, placements: CachedPhotoPlacement[]): void {
  for (const placement of placements) {
    queryClient.setQueryData<PhotoCloudPages>(placement.queryKey, (data) => {
      if (!data || data.pages.length === 0) return data;
      const currentPhoto = data.pages.flatMap((page) => page.photos ?? []).find((photo) => photo.id === photoId);
      const restoredPhoto = currentPhoto ? { ...currentPhoto, favorite: placement.photo.favorite } : placement.photo;
      const pageIndex = Math.min(placement.pageIndex, data.pages.length - 1);
      const pages = data.pages.map((page) => ({
        ...page,
        photos: (page.photos ?? []).filter((photo) => photo.id !== photoId),
      }));
      const photos = [...(pages[pageIndex]?.photos ?? [])];
      photos.splice(Math.min(placement.photoIndex, photos.length), 0, restoredPhoto);
      pages[pageIndex] = { ...pages[pageIndex]!, photos };
      return { ...data, pages };
    });
  }
}

/** 一覧のその写真を `favorite` にし（`leaves` なら一覧から外し）、最初のページの件数を ±1 する。 */
function rewritePages(data: PhotoCloudPages, photoId: string, favorite: boolean, leaves: boolean): PhotoCloudPages {
  const delta = favorite ? 1 : -1;
  return {
    ...data,
    pages: data.pages.map((page, index) => ({
      ...page,
      photos: leaves
        ? (page.photos ?? []).filter((photo) => photo.id !== photoId)
        : (page.photos ?? []).map((photo) => (photo.id === photoId ? { ...photo, favorite } : photo)),
      ...(index === 0 && page.counts
        ? { counts: { ...page.counts, favorites: Math.max(0, (page.counts.favorites ?? 0) + delta) } }
        : {}),
    })),
  };
}

export type PhotoCloudFavorite = {
  /** 送っている写真の ID（同じ写真への 2 回目は受けない） */
  pendingIds: ReadonlySet<string>;
  /** その写真のお気に入りを `favorite` にする（今の値と同じ・送っている途中なら何もしない） */
  setFavorite: (photo: Pick<PhotoLibraryItem, "id" | "favorite">, favorite: boolean) => Promise<void>;
};

export function usePhotoCloudFavorite(options: {
  spotId: string;
  scopeKey?: string;
  /** 一覧の外の写真（URL で開いた・このタブで追加した）にも同じ書き換えを当てる（戻すときも呼ぶ） */
  applyLocal?: (photoId: string, favorite: boolean) => void;
  /** 変えられなかった（元に戻した後に呼ぶ） */
  onError?: (error: unknown) => void;
}): PhotoCloudFavorite {
  const { spotId, scopeKey } = options;
  const favoritesTool = usePhotoLibrary().favorites;
  const queryClient = useQueryClient();
  const callbacksRef = useRef(options);
  callbacksRef.current = options;
  const pendingRef = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * 読み込んである一覧すべてで、その写真を `favorite` にする。もうその値の一覧は変えない。`press`（押したとき）は載っていない一覧の
   * 件数も書き換え、`settle`（送り終えたとき）は載っていない一覧を変えず、付けた写真が入るはずの一覧（♥ で絞った一覧）を返す。
   */
  const write = useCallback(
    (photoId: string, favorite: boolean, phase: "press" | "settle"): QueryKey[] => {
      const missing: QueryKey[] = [];
      for (const [listQueryKey, data] of queryClient.getQueriesData<PhotoCloudPages>({
        queryKey: photoEditingQueryKeys.cloudPhotos(spotId, scopeKey),
      })) {
        if (!data) continue;
        const filter = photoCloudListFilter(listQueryKey);
        // ♥ で絞った一覧のうち、この値の写真が入らない一覧（「お気に入り」から外した写真）
        const leaves = filter.favorite !== null && filter.favorite !== favorite;
        const listed = data.pages.flatMap((page) => page.photos ?? []).find((photo) => photo.id === photoId);
        if (listed === undefined) {
          if (phase === "settle") {
            // 元の写真の無い一覧（記事の画像）には入らない（お気に入りにできるのは「写真」だけ）
            if (filter.favorite === favorite && filter.hasOriginal !== false) missing.push(listQueryKey);
            continue;
          }
        } else if (!leaves && listed.favorite === favorite) {
          continue;
        }
        queryClient.setQueryData<PhotoCloudPages>(listQueryKey, rewritePages(data, photoId, favorite, leaves));
      }
      callbacksRef.current.applyLocal?.(photoId, favorite);
      return missing;
    },
    [queryClient, scopeKey, spotId],
  );

  const setFavorite = useCallback(
    async (photo: Pick<PhotoLibraryItem, "id" | "favorite">, favorite: boolean): Promise<void> => {
      const photoId = photo.id;
      if ((photo.favorite === true) === favorite || pendingRef.current.has(photoId)) return;
      pendingRef.current.add(photoId);
      setPendingIds(new Set(pendingRef.current));
      const cacheKey = photoEditingQueryKeys.cloudPhotos(spotId, scopeKey);
      // cancelQueries は呼出時点で対象fetchを同期的にcancelし、promiseは停止処理の完了を返す。
      // UIの楽観更新をすぐ反映しつつ、cancel完了後にPOSTを送る。
      const cancelBeforeMutation = queryClient.cancelQueries({ queryKey: cacheKey });
      const placements = snapshotPhotoPlacements(queryClient, cacheKey, photoId);
      write(photoId, favorite, "press");
      await cancelBeforeMutation;
      let failure: unknown = null;
      try {
        // お気に入りを持たない写真の出どころでは ♥ を出さない（`capabilities.favorites`）。押されたら変えられなかったとして戻す
        if (!favoritesTool) throw new Error("photo library has no favorites");
        const result = await favoritesTool.set([photoId], favorite);
        // 変えられなかった（ほかのスタッフが消した・元の写真が無い）
        if (result.updated < 1) failure = new Error("photo favorite was not updated");
      } catch (error) {
        failure = error;
      }
      if (failure === null) {
        // 送信中に始まった手動読み直し・ポーリングを止め、確定した値を全一覧へ書き直す。載るはずの絞り込みに写真が無い場合だけ読み直す。
        await queryClient.cancelQueries({ queryKey: cacheKey });
        const missing = write(photoId, favorite, "settle");
        for (const listQueryKey of missing) {
          void queryClient.invalidateQueries({ queryKey: listQueryKey, exact: true });
        }
      } else {
        await queryClient.cancelQueries({ queryKey: cacheKey });
        // 逆向きの書き換えは件数を戻し、snapshot はお気に入り一覧から消えた行も復元する。
        write(photoId, !favorite, "press");
        restorePhotoPlacements(queryClient, photoId, placements);
        void queryClient.invalidateQueries({ queryKey: cacheKey });
      }
      pendingRef.current.delete(photoId);
      if (mountedRef.current) setPendingIds(new Set(pendingRef.current));
      if (failure !== null && mountedRef.current) callbacksRef.current.onError?.(failure);
    },
    [favoritesTool, queryClient, scopeKey, spotId, write],
  );

  return { pendingIds, setFavorite };
}
