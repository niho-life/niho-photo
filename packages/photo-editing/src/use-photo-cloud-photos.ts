"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";

import { isWorkPending, workPollIntervalMs } from "./develop-engine/develop-work-wait";
import { describePhotoCloudDeleteArticleUsage } from "./photo-library-messages";
import { photoCloudListFilter } from "./use-photo-cloud-favorite";
import { photoEditingQueryKeys } from "./photo-editing-query-keys";
import type {
  PhotoLibrary,
  PhotoLibraryCounts,
  PhotoLibraryFlagFilter,
  PhotoLibraryItem,
  PhotoLibraryKindFilter,
  PhotoLibraryPhoto,
  PhotoLibrarySort,
  PhotoLibraryUsage,
} from "./library/photo-library";
import { usePhotoEditingHost, usePhotoLibrary } from "./library/photo-library-context";

/** 参照確認の応答を待つ上限（Desktop の「クラウドから消す」確認と同じ 3 秒。移行元設計） */
const PHOTO_CLOUD_REFERENCES_TIMEOUT_MS = 3000;

/**
 * クラウドの写真置き場の一覧（移行元設計 → 移行元設計）。写真編集の左の木の先頭「クラウド」の件数と、中央のグリッド・
 * フィルムストリップが読む。`GET .../photo-cloud/photos` を新しい順に 1 ページ 60 枚ずつ cursor で続けて読み、
 * 使用量（使用量 / 上限）は最初のページの値を使う。
 *
 * - 並び（追加日 / 撮影日）と元の写真の有無・お気に入り・アルバム（木の「写真」「お気に入り」「アルバム」「記事の画像」）・種類・補正済み（一覧の絞り込み）
 *   はサーバーで絞る（移行元設計 / 移行元設計 / 移行元設計）。条件ごとに別の問い合わせ（`cloudPhotosList`）で、木の件数（`counts`）は最初の
 *   ページの値。消した・読み直した写真は、どの条件の一覧からも同じように外す・替える（`cloudPhotos` の接頭辞で全部を書き換える。
 *   お気に入りの付け外しは `usePhotoCloudFavorite`）。読み直した写真の補正済み（`hasEdits`）が変わっても、補正済みで絞った一覧から
 *   外さない（直している 1 枚を一覧から消さない。一覧へ戻ったときに画面が読み直す）
 *
 * - 写真は接続口 `PhotoLibrary`（`list`。web は拠点のクラウドの写真置き場）から読む（移行元設計）。cache の 1 ページはクラウドの一覧の
 *   応答と同じ形（{@link PhotoCloudListPage}）
 * - 画面を出したときに読む（ほかのスタッフが入れた・消した写真）。窓に戻っただけでは読み直さない
 * - 消した写真は、読み直す前に一覧から外す（押した直後にタイルが消える）。使用量は読み直した値にする
 * - 別の端末で直した補正を読み直した写真は、その行を今の写真に替える（一覧の URL は残す。移行元設計）
 * - 作業コピーを待っている写真（{@link isWorkPending}）と、補正後のプレビューをワーカーが描くのを待っている写真
 *   （`editedPreviewPending`。K3-b 移行元設計。描けた順にタイルが替わる）がある間だけ、1 枚で確かめ直すのと同じ間隔の列
 *   （{@link workPollIntervalMs}）で読み直す（W1 移行元設計）。準備中の写真が増えたら（追加し終えた・再試行した）最初の間隔に戻し、0 枚になったら止める。タブを隠している
 *   間は読み直さない。プレビューの URL は期限を丸めた署名なので、読み直してもサムネイルは取り直さない
 */
/** 一覧の並び（`added` は追加日、`captured` は撮影日。どちらも新しい順）。 */
export type PhotoCloudListSort = PhotoLibrarySort;

/** 一覧の種類の絞り込み（RAW は JPEG / PNG / TIFF / HEIC / HEIF 以外。PNG / TIFF は絞り込まないときだけ出る。移行元設計）。 */
export type PhotoCloudListKind = PhotoLibraryKindFilter;

/**
 * 木の件数（最初のページだけ返る。移行元設計）。`favorites` は元の写真のある写真のうち ♥ の付いた数（移行元設計）、`matching` は今の
 * 条件での総数。
 */
export type PhotoCloudCounts = PhotoLibraryCounts;

/** 一覧の cache の 1 ページ（クラウドの一覧の応答と同じ形。使用量と木の件数は最初のページだけが使う）。 */
export type PhotoCloudListPage = {
  photos: PhotoLibraryItem[];
  nextCursor: string | null;
  usage: PhotoLibraryUsage | null;
  counts?: PhotoLibraryCounts | null;
};

export type PhotoCloudPhotos = {
  /** 読み込んだ写真（新しい順。ページをまたいだ重なりは 1 枚にまとめる） */
  photos: PhotoLibraryItem[];
  usage: PhotoLibraryUsage | null;
  /** 木の件数と今の条件での総数（最初のページを読むまで・古い API では null） */
  counts: PhotoCloudCounts | null;
  /** 最初のページを読んでいる */
  isPending: boolean;
  isSuccess: boolean;
  /** 最初のページを読めなかった */
  isError: boolean;
  error: unknown;
  /** 一覧取得中（区分切り替え時の再取得と追加読み込みを重ねない） */
  isFetching: boolean;
  /** 続きがある */
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** 続きを読めなかった */
  isFetchNextPageError: boolean;
  fetchNextPage: () => void;
  /** 読み直す（読み込んだページをすべて） */
  refetch: () => void;
  /** 消した写真を一覧から外し、使用量を読み直す */
  removePhotos: (photoIds: readonly string[]) => void;
  /** APIの確定応答で分かったオリジナル有無を、次の再取得まで一覧にも反映する */
  updateOriginalAvailability: (photoId: string, hasOriginal: boolean) => void;
  /** 補正保存直後から、ワーカーの補正後プレビューができるまで一覧の読み直しを始める */
  markEditedPreviewPending: (photoId: string) => void;
  /**
   * 読み込んだ行を今の写真に替える（プレビュー・記事用の画像の URL は一覧の値を残す。一覧に無ければ何もしない）。補正済み
   * （`hasEdits`）が変わっても、補正済みで絞った一覧から外さない
   */
  replacePhoto: (photo: PhotoLibraryPhoto) => void;
};

type PhotoCloudPages = InfiniteData<PhotoCloudListPage, string | null>;

/** 詳細取得が遅れて届いても、一覧行の補正・補正後プレビューの版を巻き戻さない。 */
function mergePhotoWithoutRevisionRegression(listed: PhotoLibraryItem, photo: PhotoLibraryPhoto): PhotoLibraryItem {
  const merged: PhotoLibraryItem = { ...listed, ...photo };
  if ((listed.developRevision ?? -1) > (photo.developRevision ?? -1)) {
    merged.developRevision = listed.developRevision;
    merged.hasEdits = listed.hasEdits;
  }
  const listedPreview = listed.editedPreview;
  if (listedPreview && listedPreview.revision >= (photo.editedPreview?.revision ?? -1)) {
    // 同じ版でも詳細応答には読み取りURLが無いことがあるので、一覧の署名付きURLを維持する。
    merged.editedPreview = listedPreview;
  }
  return merged;
}

/** 準備中の写真の読み直しの数え方: いま準備中の写真と、その集まりが最後に増えたときの読み込み回数（`dataUpdateCount`）。 */
type PendingWorkPoll = { photoIds: ReadonlySet<string>; since: number };

/**
 * 次に一覧を読み直すまでの間隔（準備中の写真が無ければ false）。準備中の写真が増えたら（前に無かった写真が準備中になった）数え直し、
 * 増えてから読み込んだ回数で {@link workPollIntervalMs} を引く。react-query が読み込み・描画のたびに呼ぶので、同じ状態なら何度呼んでも
 * 同じ値を返す。
 */
function nextPendingWorkPoll(
  previous: PendingWorkPoll,
  data: PhotoCloudPages | undefined,
  dataUpdateCount: number,
): { poll: PendingWorkPoll; intervalMs: number | false } {
  const photoIds = new Set<string>();
  for (const page of data?.pages ?? []) {
    for (const photo of page.photos ?? []) {
      if (isWorkPending(photo) || photo.editedPreviewPending === true) photoIds.add(photo.id);
    }
  }
  if (photoIds.size === 0) return { poll: { photoIds, since: dataUpdateCount }, intervalMs: false };
  const grew = [...photoIds].some((photoId) => !previous.photoIds.has(photoId));
  const since = grew ? dataUpdateCount : previous.since;
  return { poll: { photoIds, since }, intervalMs: workPollIntervalMs(dataUpdateCount - since) };
}

function uniquePhotos(photos: PhotoLibraryItem[]): PhotoLibraryItem[] {
  const seen = new Set<string>();
  return photos.filter((photo) => {
    if (seen.has(photo.id)) return false;
    seen.add(photo.id);
    return true;
  });
}

export function usePhotoCloudPhotos(options: {
  spotId: string;
  /** 拠点を持たない写真ライブラリの明示的なキャッシュscope。省略時は既存のspotIdだけを使う。 */
  scopeKey?: string;
  enabled: boolean;
  /** 並び（省くと追加日。NIHO Desktop の面は省く） */
  sort?: PhotoCloudListSort;
  /** 元の写真の有無で絞る（省くと絞らない） */
  hasOriginal?: boolean;
  /** お気に入り（♥）で絞る（省くと絞らない。木の「お気に入り」は true。移行元設計） */
  favorite?: boolean;
  /** アルバムで絞る（サーバー側で pagination する。移行元設計） */
  albumId?: string;
  /** 種類で絞る（省くと絞らない。NIHO Desktop の面は省く。移行元設計） */
  kind?: PhotoCloudListKind;
  /** 補正済み（true）/ 未補正（false）で絞る（省くと絞らない。NIHO Desktop の面は省く。移行元設計） */
  edited?: boolean;
  /** 選別で絞る（採用だけ / 却下を隠す。省くと絞らない。`capabilities.flags` の写真の出どころだけ。niho-photo#47） */
  flag?: PhotoLibraryFlagFilter;
  /** この Mac のフォルダ（`PhotoLibrary.folders` のある写真の出どころだけ。そのフォルダとその下の写真。NIHO camera C3 移行元設計） */
  folderId?: string;
  /** この Mac の「選んだ写真」。`folderId` と同時には渡さない。 */
  localSource?: "selected";
}): PhotoCloudPhotos {
  const { spotId, scopeKey, enabled, sort, hasOriginal, favorite, albumId, kind, edited, flag, folderId, localSource } = options;
  const library = usePhotoLibrary();
  const host = usePhotoEditingHost();
  const queryClient = useQueryClient();
  const queryKey = photoEditingQueryKeys.cloudPhotosList(spotId, {
    sort: sort ?? "added",
    hasOriginal: hasOriginal ?? null,
    favorite: favorite ?? null,
    albumId: albumId ?? null,
    kind: kind ?? null,
    edited: edited ?? null,
    flag: flag ?? null,
    folderId: folderId ?? null,
    localSource: localSource ?? null,
  }, scopeKey);
  const pendingWorkPollRef = useRef<PendingWorkPoll>({ photoIds: new Set(), since: 0 });
  const listQuery = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }): Promise<PhotoCloudListPage> => {
      const page = await library.list({
        cursor: pageParam,
        limit: library.limits.listPageSize,
        ...(sort === undefined ? {} : { sort }),
        ...(hasOriginal === undefined ? {} : { hasOriginal }),
        ...(favorite === undefined ? {} : { favorite }),
        ...(albumId === undefined ? {} : { albumId }),
        ...(kind === undefined ? {} : { kind }),
        ...(edited === undefined ? {} : { edited }),
        ...(flag === undefined ? {} : { flag }),
        ...(folderId === undefined ? {} : { folderId }),
        ...(localSource === undefined ? {} : { localSource }),
      });
      return { photos: page.items, nextCursor: page.next, usage: page.usage, counts: page.counts };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
    // 画面を出すたびに読み直す（ほかのスタッフが入れた・消した写真）
    staleTime: 0,
    refetchOnWindowFocus: false,
    // 作業コピーを待っている写真がある間だけ読み直す（タブを隠している間は読み直さない）
    refetchInterval: (query) => {
      const next = nextPendingWorkPoll(pendingWorkPollRef.current, query.state.data, query.state.dataUpdateCount);
      pendingWorkPollRef.current = next.poll;
      return next.intervalMs;
    },
    refetchIntervalInBackground: false,
  });
  const photos = useMemo(
    () => uniquePhotos(listQuery.data?.pages.flatMap((page) => page.photos ?? []) ?? []),
    [listQuery.data],
  );
  // 作業コピーが仕上がった写真の検出に使う、前に見た作業の状態。一覧の条件（場所・並び・絞り込み）ごとに持つ（「写真」から「記事の画像」へ
  // 切り替えて戻る間に仕上がった写真を、別の一覧の履歴で上書きして取りこぼさない）
  const previousWorkStatusRef = useRef(new Map<string, Map<string, string | null>>());
  const previousEditedPreviewStatusRef = useRef(
    new Map<string, Map<string, { pending: boolean; revision: number | null }>>(),
  );
  const listKey = JSON.stringify(queryKey);
  const hasListData = listQuery.data !== undefined;
  useEffect(() => {
    // まだ読んでいない（cache が消えて読み直している）間は、前に見た状態を残す（空で上書きすると、仕上がりを見落とす）
    if (!hasListData) return;
    const previousStatuses = previousWorkStatusRef.current.get(listKey) ?? new Map<string, string | null>();
    const previousPreviewStatuses = previousEditedPreviewStatusRef.current.get(listKey) ?? new Map();
    const becameReady = photos.some((photo) => {
      const previous = previousStatuses.get(photo.id);
      return photo.workStatus === "ready" && (previous === "queued" || previous === "rendering");
    });
    const editedPreviewBecameReady = photos.some((photo) => {
      const previous = previousPreviewStatuses.get(photo.id);
      const revision = photo.editedPreview?.revision ?? null;
      return (
        previous !== undefined &&
        ((previous.pending && photo.editedPreviewPending !== true) ||
          (revision !== null && revision > (previous.revision ?? -1)))
      );
    });
    previousWorkStatusRef.current.set(listKey, new Map(photos.map((photo) => [photo.id, photo.workStatus ?? null])));
    previousEditedPreviewStatusRef.current.set(
      listKey,
      new Map(
        photos.map((photo) => [
          photo.id,
          { pending: photo.editedPreviewPending === true, revision: photo.editedPreview?.revision ?? null },
        ]),
      ),
    );
    if (becameReady || editedPreviewBecameReady) {
      // 記事画像ライブラリ（編集面の外）は作業コピーや補正後プレビューの更新を一覧から検出して読み直す。
      host.notifyPhotosChanged();
    }
  }, [photos, listKey, hasListData, host]);
  const usage = listQuery.data?.pages[0]?.usage ?? null;
  const counts = listQuery.data?.pages[0]?.counts ?? null;

  const { fetchNextPage, refetch } = listQuery;
  const loadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  const removePhotos = useCallback(
    (photoIds: readonly string[]) => {
      if (photoIds.length === 0) return;
      const removed = new Set(photoIds);
      const key = photoEditingQueryKeys.cloudPhotos(spotId, scopeKey);
      queryClient.setQueriesData<PhotoCloudPages>({ queryKey: key }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                photos: (page.photos ?? []).filter((photo) => !removed.has(photo.id)),
              })),
            }
          : data,
      );
      void queryClient.invalidateQueries({ queryKey: key });
    },
    [queryClient, scopeKey, spotId],
  );
  const updateOriginalAvailability = useCallback(
    (photoId: string, nextHasOriginal: boolean) => {
      const key = photoEditingQueryKeys.cloudPhotos(spotId, scopeKey);
      // 一覧は元の写真の有無で絞ってあるので、有無が変わった写真は、合わなくなった一覧から外し（`hasOriginal` だけ書き換えると、
      // 別の場所の一覧に居座って、どちらの場所にも出なくなる）、移る先の一覧は読み直す（そこにはまだ載っていない。元の写真が
      // 入ったばかりの写真は ♥ が付いていないので、「お気に入り」の一覧は読み直さない）
      for (const [listQueryKey, data] of queryClient.getQueriesData<PhotoCloudPages>({ queryKey: key })) {
        if (!data) continue;
        const { hasOriginal: filter, favorite: favoriteFilter } = photoCloudListFilter(listQueryKey);
        const listed = data.pages.some((page) => (page.photos ?? []).some((photo) => photo.id === photoId));
        const fits = filter === null || filter === nextHasOriginal;
        if (fits && listed) {
          queryClient.setQueryData<PhotoCloudPages>(listQueryKey, {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              photos: (page.photos ?? []).map((photo) =>
                photo.id === photoId ? { ...photo, hasOriginal: nextHasOriginal } : photo,
              ),
            })),
          });
        } else if (!fits && listed) {
          queryClient.setQueryData<PhotoCloudPages>(listQueryKey, {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              photos: (page.photos ?? []).filter((photo) => photo.id !== photoId),
            })),
          });
          void queryClient.invalidateQueries({ queryKey: listQueryKey, exact: true });
        } else if (fits && !listed && filter !== null && favoriteFilter !== true) {
          void queryClient.invalidateQueries({ queryKey: listQueryKey, exact: true });
        }
      }
    },
    [queryClient, scopeKey, spotId],
  );
  const replacePhoto = useCallback(
    (photo: PhotoLibraryPhoto) => {
      const key = photoEditingQueryKeys.cloudPhotos(spotId, scopeKey);
      queryClient.setQueriesData<PhotoCloudPages>({ queryKey: key }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                photos: (page.photos ?? []).map((listed) =>
                  listed.id === photo.id ? mergePhotoWithoutRevisionRegression(listed, photo) : listed,
                ),
              })),
            }
          : data,
      );
    },
    [queryClient, scopeKey, spotId],
  );
  const markEditedPreviewPending = useCallback(
    (photoId: string) => {
      const key = photoEditingQueryKeys.cloudPhotos(spotId, scopeKey);
      queryClient.setQueriesData<PhotoCloudPages>({ queryKey: key }, (data) => {
        if (!data) return data;
        let changed = false;
        const pages = data.pages.map((page) => ({
          ...page,
          photos: (page.photos ?? []).map((photo) => {
            if (photo.id !== photoId || photo.editedPreviewPending === true) return photo;
            changed = true;
            return { ...photo, editedPreviewPending: true };
          }),
        }));
        return changed ? { ...data, pages } : data;
      });
    },
    [queryClient, scopeKey, spotId],
  );

  return {
    photos,
    usage,
    counts,
    isPending: enabled && listQuery.isPending,
    isSuccess: listQuery.isSuccess,
    isError: listQuery.isError,
    error: listQuery.error,
    isFetching: listQuery.isFetching,
    hasNextPage: listQuery.hasNextPage,
    isFetchingNextPage: listQuery.isFetchingNextPage,
    isFetchNextPageError: listQuery.isFetchNextPageError,
    fetchNextPage: loadMore,
    refetch: reload,
    removePhotos,
    updateOriginalAvailability,
    markEditedPreviewPending,
    replacePhoto,
  };
}

/**
 * 消す前に、その写真を記事で使っている数を確かめ、「クラウドから消す」の確かめに添える 1 文にする
 * （Desktop の確認と同じ 移行元設計）。読めない・待っても返らない・使っていない・記事の画像を持たない写真の出どころなら null
 * （確かめは件数の文なしで出す）。
 */
export async function readPhotoCloudDeleteArticleUsage(
  library: Pick<PhotoLibrary, "countArticleReferences">,
  photoId: string,
): Promise<string | null> {
  if (!library.countArticleReferences) return null;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PHOTO_CLOUD_REFERENCES_TIMEOUT_MS);
  try {
    const references = await library.countArticleReferences([photoId], { signal: controller.signal });
    const count = references?.find((reference) => reference.photoId === photoId)?.articleCount ?? 0;
    return describePhotoCloudDeleteArticleUsage([count]);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}
