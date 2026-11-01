"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";

import type { PhotoCloudListPage } from "./use-photo-cloud-photos";
import { photoEditingQueryKeys } from "./photo-editing-query-keys";
import type { PhotoLibraryFlag, PhotoLibraryItem } from "./library/photo-library";
import { usePhotoLibrary } from "./library/photo-library-context";

/**
 * 選別のフラグ（採用 / 却下。niho-photo#47。Lightroom のフラグ）の付け外し。お気に入り（♥。`usePhotoCloudFavorite`）と同じく、押した
 * 直後に画面を書き換え、送れなかったら戻す。1 枚でも複数枚でも同じ（一覧で選んだ写真をまとめて）。
 *
 * - 押した直後に、読み込んであるすべての一覧（`cloudPhotos` の接頭辞。場所・並び・絞り込みごとの一覧）でその写真の `flag` を書き換える。
 *   選別で絞った一覧からも行は外さない（合わなくなった写真を出さないのは画面の選り分け `isBrowserCloudPhotoInFilter`。1 枚で見ている
 *   写真は、別の写真へ移るまで出したままにできる）。一覧の外の写真（URL で開いた・このタブで追加した）は `applyLocal` で同じく書き換える
 * - 今の値と同じ写真・送っている途中の写真は飛ばす（同じキーをもう一度押しても入れ替えない。2 回目は送り終えるまで受けない）
 * - `limits.photosPerRequest` 枚ずつ送る。楽観更新の前後で一覧の取得を止め、古い応答が新しい値を上書きしないようにする（送り終えたら
 *   確定した値を書き直す）。絞った一覧を読み直すのは、その一覧を次に出したとき（`staleTime: 0`）
 * - 送れなかった・変えられなかった写真があれば（`updated` が送った数より少ない）、書き換えた写真を元の値に戻し、一覧を読み直して
 *   から `onError` を呼ぶ
 */

type PhotoCloudPages = InfiniteData<PhotoCloudListPage, string | null>;

export type PhotoLibraryFlagsControl = {
  /** 送っている写真の ID（同じ写真への 2 回目は受けない） */
  pendingIds: ReadonlySet<string>;
  /** React の再描画を待たず、指定写真の書き込み中状態を読む */
  isPending: (photoId: string) => boolean;
  /** 写真のフラグを `flag` にする（null は外す）。今の値と同じ写真・送っている途中の写真は飛ばす */
  setFlag: (photos: ReadonlyArray<Pick<PhotoLibraryItem, "id" | "flag">>, flag: PhotoLibraryFlag | null) => Promise<void>;
};

export function usePhotoLibraryFlags(options: {
  spotId: string;
  scopeKey?: string;
  /** 一覧の外の写真（URL で開いた・このタブで追加した）にも同じ書き換えを当てる（戻すときも呼ぶ） */
  applyLocal?: (photoId: string, flag: PhotoLibraryFlag | null) => void;
  /** 変えられなかった（元に戻した後に呼ぶ） */
  onError?: (error: unknown) => void;
}): PhotoLibraryFlagsControl {
  const { spotId, scopeKey } = options;
  const library = usePhotoLibrary();
  const flagsTool = library.flags;
  const photosPerRequest = Math.max(1, library.limits.photosPerRequest);
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

  /** 読み込んであるすべての一覧と一覧の外の写真で、写真ごとのフラグを書き換える（もうその値の写真は変えない）。 */
  const write = useCallback(
    (changes: ReadonlyMap<string, PhotoLibraryFlag | null>) => {
      queryClient.setQueriesData<PhotoCloudPages>({ queryKey: photoEditingQueryKeys.cloudPhotos(spotId, scopeKey) }, (data) => {
        if (!data) return data;
        let changed = false;
        const pages = data.pages.map((page) => {
          let pageChanged = false;
          const photos = (page.photos ?? []).map((photo) => {
            if (!changes.has(photo.id)) return photo;
            const flag = changes.get(photo.id) ?? null;
            if ((photo.flag ?? null) === flag) return photo;
            pageChanged = true;
            return { ...photo, flag };
          });
          if (!pageChanged) return page;
          changed = true;
          return { ...page, photos };
        });
        return changed ? { ...data, pages } : data;
      });
      for (const [photoId, flag] of changes) callbacksRef.current.applyLocal?.(photoId, flag);
    },
    [queryClient, scopeKey, spotId],
  );

  const setFlag = useCallback(
    async (photos: ReadonlyArray<Pick<PhotoLibraryItem, "id" | "flag">>, flag: PhotoLibraryFlag | null) => {
      const previous = new Map<string, PhotoLibraryFlag | null>();
      for (const photo of photos) {
        if ((photo.flag ?? null) === flag || pendingRef.current.has(photo.id) || previous.has(photo.id)) continue;
        previous.set(photo.id, photo.flag ?? null);
      }
      if (previous.size === 0) return;
      const photoIds = Array.from(previous.keys());
      for (const photoId of photoIds) pendingRef.current.add(photoId);
      setPendingIds(new Set(pendingRef.current));
      const cacheKey = photoEditingQueryKeys.cloudPhotos(spotId, scopeKey);
      const next = new Map(photoIds.map((photoId) => [photoId, flag] as const));
      // cancelQueries は呼んだ時点で取得を止める（promise は止め終わり）。画面はすぐ書き換え、止め終えてから送る
      const cancelBeforeMutation = queryClient.cancelQueries({ queryKey: cacheKey });
      write(next);
      await cancelBeforeMutation;
      let failure: unknown = null;
      try {
        // 選別を持たない写真の出どころではキー・ボタンを出さない（`capabilities.flags`）。押されたら変えられなかったとして戻す
        if (!flagsTool) throw new Error("photo library has no flags");
        let updated = 0;
        for (let index = 0; index < photoIds.length; index += photosPerRequest) {
          const result = await flagsTool.set(photoIds.slice(index, index + photosPerRequest), flag);
          updated += result.updated;
        }
        if (updated < photoIds.length) failure = new Error("photo flag was not updated");
      } catch (error) {
        failure = error;
      }
      await queryClient.cancelQueries({ queryKey: cacheKey });
      if (failure === null) {
        // 送っている間に始まった読み直し（前の値のまま）も、確定した値に書き直す
        write(next);
      } else {
        // 一部だけ変わったかもしれないので、元の値に戻してから一覧を読み直す
        write(previous);
        await queryClient.invalidateQueries({ queryKey: cacheKey });
      }
      for (const photoId of photoIds) pendingRef.current.delete(photoId);
      if (mountedRef.current) setPendingIds(new Set(pendingRef.current));
      if (failure !== null && mountedRef.current) callbacksRef.current.onError?.(failure);
    },
    [flagsTool, photosPerRequest, queryClient, scopeKey, spotId, write],
  );

  const isPending = useCallback((photoId: string) => pendingRef.current.has(photoId), []);

  return { pendingIds, isPending, setFlag };
}
