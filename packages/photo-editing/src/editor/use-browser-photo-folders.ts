"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { appDialog } from "niho-ui/app-dialog";
import {
  readLocalStorageItemSafely,
  removeLocalStorageItemSafely,
  writeLocalStorageItemSafely,
} from "niho-ui/local-storage-safe";

import {
  browserFolderPlace,
  browserPlaceFolderId,
  isBrowserSelectedPhotosPlace,
  type BrowserCloudPlace,
} from "../browser-photo-cloud-source";
import type { PhotoLibrary, PhotoLibraryFolder, PhotoLibraryPlace } from "../library/photo-library";
import {
  PHOTO_EDITING_ADD_FOLDER_FAILED_TEXT,
  PHOTO_EDITING_ADD_SELECTED_PHOTOS_FAILED_TEXT,
  PHOTO_EDITING_FORGET_SELECTED_PHOTOS_DESCRIPTION,
  PHOTO_EDITING_FORGET_SELECTED_PHOTOS_FAILED_TEXT,
  PHOTO_EDITING_FORGET_SELECTED_PHOTOS_LABEL,
  PHOTO_EDITING_FORGET_SELECTED_PHOTOS_TITLE,
  PHOTO_EDITING_FORGET_FOLDER_CONFIRM_LABEL,
  PHOTO_EDITING_FORGET_FOLDER_FAILED_TEXT,
  PHOTO_EDITING_FORGET_FOLDER_TITLE,
  photoEditingForgetFolderDescription,
} from "../photo-editing-copy";
import { photoEditingQueryKeys } from "../photo-editing-query-keys";

import type { FooterStatus } from "./browser-photo-editing-model";

/**
 * この Mac のフォルダの面の状態（写真の出どころに `folders` があるときだけ。NIHO camera C3 移行元設計。移行時の設計文書
 * niho-camera-app.md「画面」）。library は選んだフォルダを持たないので、選んだフォルダは一覧の場所（`folder:<folderId>`）として
 * 画面が持ち、一覧は `list` の `folderId` で読む。
 *
 * - 木は `folders.tree()` を react-query で読む（鍵は置き場ごと）。足した・外した後に読み直す
 * - 木を読んだら（読み直したら）、今のフォルダが木に無ければ選び直す: この端末に覚えた最後のフォルダ（木にあれば）、無ければ最初の
 *   根。フォルダが 1 つも無ければ選ばない（{@link BROWSER_NO_FOLDER_PLACE}。画面は空状態「フォルダを追加」を出す）
 * - 選んだフォルダはこの端末に覚える（localStorage。鍵は置き場を含む名前。UI の状態なので data-ownership の対象外）
 * - 足す: `folders.add()`（選ぶダイアログを閉じたら null で何もしない）。足したフォルダを木の最後に足して選び、木を読み直す
 * - 外す: 確かめ（appDialog。破壊的ではないので danger にしない）→ 選んでいたフォルダ（とその下）なら、外した後の木で上の決まりの
 *   フォルダか空へ先に移る（開いていた写真の保存・破棄の確認を済ませる。移れなければ外さない）→ `folders.forget()` → 木から外して
 *   読み直す（読み直しに失敗しても、外したフォルダは木に残さない）
 */

/**
 * フォルダのある写真の出どころで、フォルダを選んでいない場所（読み込み中・フォルダが無い）。一覧は読まない（フォルダの場所だけを
 * 読む）。クラウドの場所の既定と同じ値なので、フォルダの面では「フォルダの場所でない = 選んでいない」と読む。
 */
export const BROWSER_NO_FOLDER_PLACE: BrowserCloudPlace = "photos";
const BROWSER_SELECTED_SOURCE_STORAGE_VALUE = "source:selected";
const EMPTY_PHOTO_LIBRARY_FOLDERS: readonly PhotoLibraryFolder[] = [];

/** この端末に覚えた最後のフォルダの鍵（置き場ごと）。 */
export function browserPhotoLastFolderStorageKey(place: PhotoLibraryPlace): string {
  return `niho:photoEditing:${place}:lastFolder:v1`;
}

/** 木の根からそのフォルダまでの段（無ければ空）。 */
export function photoLibraryFolderPath(
  folders: readonly PhotoLibraryFolder[],
  folderId: string,
): PhotoLibraryFolder[] {
  for (const folder of folders) {
    if (folder.folderId === folderId) return [folder];
    const below = photoLibraryFolderPath(folder.children, folderId);
    if (below.length > 0) return [folder, ...below];
  }
  return [];
}

/** 木の中のフォルダ（無ければ null）。 */
export function findPhotoLibraryFolder(
  folders: readonly PhotoLibraryFolder[],
  folderId: string,
): PhotoLibraryFolder | null {
  return photoLibraryFolderPath(folders, folderId).at(-1) ?? null;
}

/** そのフォルダ（とその下）を外した木。 */
export function withoutPhotoLibraryFolder(
  folders: readonly PhotoLibraryFolder[],
  folderId: string,
): PhotoLibraryFolder[] {
  return folders
    .filter((folder) => folder.folderId !== folderId)
    .map((folder) => ({ ...folder, children: withoutPhotoLibraryFolder(folder.children, folderId) }));
}

/** 木を読んだときに選ぶフォルダ（今のフォルダが木にあればそのまま、無ければ覚えたフォルダ・最初の根。無ければ null）。 */
export function resolveBrowserPhotoFolder(
  folders: readonly PhotoLibraryFolder[],
  current: string | null,
  remembered: string | null,
): string | null {
  if (current && findPhotoLibraryFolder(folders, current)) return current;
  if (remembered && findPhotoLibraryFolder(folders, remembered)) return remembered;
  return folders[0]?.folderId ?? null;
}

/** 木と「選んだ写真」を読んだときに復元する、この Mac の場所。 */
export function resolveBrowserPhotoLocalSource(
  folders: readonly PhotoLibraryFolder[],
  selectedCount: number,
  current: BrowserCloudPlace,
  remembered: string | null,
): BrowserCloudPlace {
  if (isBrowserSelectedPhotosPlace(current) && selectedCount > 0) return "selected";
  const currentFolder = browserPlaceFolderId(current);
  if (currentFolder && findPhotoLibraryFolder(folders, currentFolder)) return current;
  if (remembered === BROWSER_SELECTED_SOURCE_STORAGE_VALUE && selectedCount > 0) return "selected";
  if (remembered && findPhotoLibraryFolder(folders, remembered)) return browserFolderPlace(remembered);
  if (folders[0]) return browserFolderPlace(folders[0].folderId);
  return selectedCount > 0 ? "selected" : BROWSER_NO_FOLDER_PLACE;
}

export function useBrowserPhotoFolders(params: {
  library: Pick<PhotoLibrary, "place" | "folders" | "selectedPhotos">;
  spotId: string;
  scopeKey?: string;
  /** 今の場所（`folder:<folderId>` のときだけフォルダを選んでいる） */
  place: BrowserCloudPlace;
  /** 場所を移る（開いていた写真の保存・破棄の確認を済ませる。移れなければ false） */
  selectPlace: (place: BrowserCloudPlace) => Promise<boolean>;
  setStatus: (status: FooterStatus | null) => void;
  mountedRef: MutableRefObject<boolean>;
}) {
  const { library, place, setStatus, mountedRef } = params;
  const foldersTool = library.folders;
  const selectedTool = library.selectedPhotos;
  const queryClient = useQueryClient();
  const queryKey = photoEditingQueryKeys.folders(library.place, params.spotId, params.scopeKey);
  const storageKey = browserPhotoLastFolderStorageKey(library.place);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => {
      if (!foldersTool) throw new Error("photo library has no folders");
      return foldersTool.tree({ signal });
    },
    enabled: foldersTool !== undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const selectedQueryKey = photoEditingQueryKeys.selectedPhotos(library.place, params.spotId, params.scopeKey);
  const selectedQuery = useQuery({
    queryKey: selectedQueryKey,
    queryFn: ({ signal }) => {
      if (!selectedTool) throw new Error("photo library has no selected photos");
      return selectedTool.count({ signal });
    },
    enabled: selectedTool !== undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const tree = foldersTool ? (query.data ?? null) : EMPTY_PHOTO_LIBRARY_FOLDERS;
  const selectedCount = selectedTool ? (selectedQuery.data ?? null) : 0;
  const selectedFolderId = foldersTool ? browserPlaceFolderId(place) : null;
  const selectedFolder = tree && selectedFolderId ? findPhotoLibraryFolder(tree, selectedFolderId) : null;

  const placeRef = useRef(place);
  placeRef.current = place;
  const selectPlaceRef = useRef(params.selectPlace);
  selectPlaceRef.current = params.selectPlace;

  // 選んだフォルダをこの端末に覚える
  useEffect(() => {
    if (isBrowserSelectedPhotosPlace(place)) writeLocalStorageItemSafely(storageKey, BROWSER_SELECTED_SOURCE_STORAGE_VALUE);
    else if (selectedFolderId) writeLocalStorageItemSafely(storageKey, selectedFolderId);
  }, [place, selectedFolderId, storageKey]);

  // 木を読んだら（読み直したら）、今のフォルダが木に無いときだけ選び直す（場所を替えただけでは走らない）
  useEffect(() => {
    if (!tree || selectedCount === null) return;
    const current = placeRef.current;
    const next = resolveBrowserPhotoLocalSource(tree, selectedCount, current, readLocalStorageItemSafely(storageKey));
    if (next === current) return;
    void selectPlaceRef.current(next);
  }, [selectedCount, storageKey, tree]);

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const run = useCallback(
    async (task: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await task();
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [mountedRef],
  );

  const reload = useCallback(() => queryClient.invalidateQueries({ queryKey }), [queryClient, queryKey]);
  const reloadSelected = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: selectedQueryKey }),
      queryClient.invalidateQueries({ queryKey: photoEditingQueryKeys.cloudPhotos(params.spotId, params.scopeKey) }),
    ]);
  }, [params.scopeKey, params.spotId, queryClient, selectedQueryKey]);

  const addFolder = useCallback(
    () =>
      run(async () => {
        if (!foldersTool) return;
        let folder: PhotoLibraryFolder | null;
        try {
          folder = await foldersTool.add();
        } catch {
          if (mountedRef.current) setStatus({ kind: "error", text: PHOTO_EDITING_ADD_FOLDER_FAILED_TEXT });
          return;
        }
        if (!folder || !mountedRef.current) return;
        const added = folder;
        // 読み直しを待たずに木の最後に足して選ぶ（足した順。既に覚えていたフォルダなら木はそのまま）
        queryClient.setQueryData<PhotoLibraryFolder[]>(queryKey, (current) =>
          current && !findPhotoLibraryFolder(current, added.folderId) ? [...current, added] : current,
        );
        writeLocalStorageItemSafely(storageKey, added.folderId);
        await selectPlaceRef.current(browserFolderPlace(added.folderId));
        await reload();
      }),
    [foldersTool, mountedRef, queryClient, queryKey, reload, run, setStatus, storageKey],
  );

  const addPhotos = useCallback(
    () =>
      run(async () => {
        if (!selectedTool) return;
        let photos;
        try {
          photos = await selectedTool.add();
        } catch {
          if (mountedRef.current) setStatus({ kind: "error", text: PHOTO_EDITING_ADD_SELECTED_PHOTOS_FAILED_TEXT });
          return;
        }
        if (photos.length === 0 || !mountedRef.current) return;
        writeLocalStorageItemSafely(storageKey, BROWSER_SELECTED_SOURCE_STORAGE_VALUE);
        await selectPlaceRef.current("selected");
        await reloadSelected();
      }),
    [mountedRef, reloadSelected, run, selectedTool, setStatus, storageKey],
  );

  const forgetFolder = useCallback(
    (folder: PhotoLibraryFolder) =>
      run(async () => {
        if (!foldersTool) return;
        const confirmed = await appDialog.confirm({
          title: PHOTO_EDITING_FORGET_FOLDER_TITLE,
          description: photoEditingForgetFolderDescription(folder.name),
          confirmLabel: PHOTO_EDITING_FORGET_FOLDER_CONFIRM_LABEL,
        });
        if (!confirmed || !mountedRef.current) return;
        const current = queryClient.getQueryData<PhotoLibraryFolder[]>(queryKey) ?? [];
        const remaining = withoutPhotoLibraryFolder(current, folder.folderId);
        const rememberedRaw = readLocalStorageItemSafely(storageKey);
        const remembered = rememberedRaw && findPhotoLibraryFolder([folder], rememberedRaw) ? null : rememberedRaw;
        // 選んでいたフォルダ（とその下）なら、外す前に移る。開いていた写真から離れられなければ外さない
        const selected = browserPlaceFolderId(placeRef.current);
        if (selected && findPhotoLibraryFolder([folder], selected)) {
          const next = resolveBrowserPhotoFolder(remaining, null, remembered);
          const moved = await selectPlaceRef.current(next ? browserFolderPlace(next) : BROWSER_NO_FOLDER_PLACE);
          if (!moved || !mountedRef.current) return;
        }
        try {
          await foldersTool.forget(folder.folderId);
        } catch {
          if (mountedRef.current) setStatus({ kind: "error", text: PHOTO_EDITING_FORGET_FOLDER_FAILED_TEXT });
          return;
        }
        // 覚えたフォルダが外したフォルダ（とその下）なら忘れる（移った先を覚えた後なら、そのまま残す）
        const rememberedNow = readLocalStorageItemSafely(storageKey);
        if (rememberedNow && findPhotoLibraryFolder([folder], rememberedNow)) removeLocalStorageItemSafely(storageKey);
        if (!mountedRef.current) return;
        // 読み直しを待たずに木から外す（読み直しに失敗しても、外したフォルダを古い木で出し続けない）
        queryClient.setQueryData<PhotoLibraryFolder[]>(queryKey, (tree) => (tree ? withoutPhotoLibraryFolder(tree, folder.folderId) : tree));
        await reload();
      }),
    [foldersTool, mountedRef, queryClient, queryKey, reload, run, setStatus, storageKey],
  );

  const forgetSelectedPhotos = useCallback(
    () =>
      run(async () => {
        if (!selectedTool || selectedCount === null || selectedCount === 0) return;
        const confirmed = await appDialog.confirm({
          title: PHOTO_EDITING_FORGET_SELECTED_PHOTOS_TITLE,
          description: PHOTO_EDITING_FORGET_SELECTED_PHOTOS_DESCRIPTION,
          confirmLabel: PHOTO_EDITING_FORGET_SELECTED_PHOTOS_LABEL,
        });
        if (!confirmed || !mountedRef.current) return;
        const remembered = readLocalStorageItemSafely(storageKey);
        const next = resolveBrowserPhotoLocalSource(tree ?? [], 0, BROWSER_NO_FOLDER_PLACE, remembered);
        if (isBrowserSelectedPhotosPlace(placeRef.current)) {
          const moved = await selectPlaceRef.current(next);
          if (!moved || !mountedRef.current) return;
        }
        try {
          await selectedTool.forget();
        } catch {
          if (mountedRef.current) setStatus({ kind: "error", text: PHOTO_EDITING_FORGET_SELECTED_PHOTOS_FAILED_TEXT });
          return;
        }
        if (readLocalStorageItemSafely(storageKey) === BROWSER_SELECTED_SOURCE_STORAGE_VALUE) {
          removeLocalStorageItemSafely(storageKey);
        }
        queryClient.setQueryData(selectedQueryKey, 0);
        await reloadSelected();
      }),
    [mountedRef, queryClient, reloadSelected, run, selectedCount, selectedQueryKey, selectedTool, setStatus, storageKey, tree],
  );

  return {
    /** フォルダの面を出す（写真の出どころに `folders` がある） */
    enabled: foldersTool !== undefined || selectedTool !== undefined,
    tree,
    pending: foldersTool !== undefined && query.isPending,
    error:
      (foldersTool !== undefined && query.isError && tree === null) ||
      (selectedTool !== undefined && selectedQuery.isError && selectedCount === null),
    selectedFolderId,
    selectedFolder,
    selected: selectedTool !== undefined && isBrowserSelectedPhotosPlace(place),
    selectedCount,
    busy,
    retry: () => {
      if (foldersTool) void query.refetch();
      if (selectedTool) void selectedQuery.refetch();
    },
    addFolder,
    addPhotos,
    forgetFolder,
    forgetSelectedPhotos,
  };
}

export type BrowserPhotoFolders = ReturnType<typeof useBrowserPhotoFolders>;
