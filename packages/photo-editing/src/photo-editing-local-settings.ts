"use client";

import { useSyncExternalStore } from "react";

import {
  readLocalStorageItemSafely,
  removeLocalStorageItemSafely,
  writeLocalStorageItemSafely,
} from "niho-ui/local-storage-safe";

import type { BrowserPhotoExportSize, BrowserPhotoExportSizeOption } from "./browser-photo-export";

/**
 * 写真編集の「この Mac の設定」（移行元設計、移行時の設計文書「ページの呼び方（設定）」）。
 * サーバーのデータでもファイルでもない、この Mac のページの保存領域（localStorage）に置く UI の設定なので、
 * ホスト側のデータ所有権ポリシー（拠点かユーザーか）の対象外。写真編集の面の開閉（`photo-editing-panels.ts`）と同じ考え方。
 *
 * - クラウドに元の写真も置くか: 既定はオン。オフのときだけ `"off"` を保存する（無い = オン）
 * - macOS 現像の知らせを閉じたか: 閉じたときだけ `"1"` を保存する（無い = まだ閉じていない）
 * - 一覧の並び（撮影日 / 最近追加。移行元設計）: 切り替えた値をそのまま保存する（無い・知らない値 = 既定の撮影日）
 * - 書き出しの大きさ（長辺 2048px / 幅 1080px。F7b 移行元設計。NIHO Desktop の原寸も。K2-3a 移行元設計）: 選んだ値をそのまま保存する
 *   （無い・知らない値 = 既定の長辺 2048px。原寸を出さないシート・環境では長辺 2048px として読む）
 *
 * storage が使えない・書けない（プライベートウィンドウ・容量超過など）ときは例外を投げず、そのページを開いている間だけ
 * 有効なメモリ上の値で動く。同じページの中の複数箇所（設定パネルのスイッチ・ワークベンチの知らせ）が同じ値を見るよう
 * `useSyncExternalStore` の小さな store にし、別のウィンドウの変更は `storage` イベントで拾う。
 */
export const PHOTO_EDITING_CLOUD_ORIGINALS_STORAGE_KEY = "niho:host:photoEditing:cloudOriginals:v1";
export const PHOTO_EDITING_PROFILE_NOTICE_DISMISSED_STORAGE_KEY = "niho:host:photoEditing:profileNoticeDismissed:v1";
export const PHOTO_EDITING_LIST_SORT_STORAGE_KEY = "niho:host:photoEditing:listSort:v1";
export const PHOTO_EDITING_EXPORT_SIZE_STORAGE_KEY = "niho:host:photoEditing:exportSize:v1";

const CLOUD_ORIGINALS_OFF_VALUE = "off";
const PROFILE_NOTICE_DISMISSED_VALUE = "1";

/** ブラウザ版の一覧の並び（`captured` は撮影日、`added` は最近追加）。既定は撮影日（F5a-2 移行元設計）。 */
export type PhotoEditingListSort = "added" | "captured";
export const DEFAULT_PHOTO_EDITING_LIST_SORT: PhotoEditingListSort = "captured";

/** 書き出しの大きさの既定（長辺 2048px。F7b 移行元設計）。 */
export const DEFAULT_PHOTO_EDITING_EXPORT_SIZE: BrowserPhotoExportSize = "long2048";

const STORAGE_KEYS: ReadonlySet<string> = new Set([
  PHOTO_EDITING_CLOUD_ORIGINALS_STORAGE_KEY,
  PHOTO_EDITING_PROFILE_NOTICE_DISMISSED_STORAGE_KEY,
  PHOTO_EDITING_LIST_SORT_STORAGE_KEY,
  PHOTO_EDITING_EXPORT_SIZE_STORAGE_KEY,
]);

const listeners = new Set<() => void>();
/**
 * storage に書けなかった値（null は「保存なし」= 既定）。書けたら消す。あるあいだは storage より先に読む
 * （書けなかったのに storage の古い値が勝つと、押したスイッチが元に戻って見える）。
 */
const memoryValues = new Map<string, string | null>();

function readValue(key: string): string | null {
  if (memoryValues.has(key)) return memoryValues.get(key) ?? null;
  return readLocalStorageItemSafely(key);
}

/** `null` は保存を消す（既定に戻す）。書けても書けなくても、同じページの購読者へ知らせる。 */
function writeValue(key: string, value: string | null): void {
  const stored = value === null ? removeLocalStorageItemSafely(key) : writeLocalStorageItemSafely(key, value);
  if (stored) memoryValues.delete(key);
  else memoryValues.set(key, value);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // 同じ storage を見ている別のウィンドウが書いた（key が null は clear）。そのウィンドウの値を正にする
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== null && !STORAGE_KEYS.has(event.key)) return;
    if (event.key === null) memoryValues.clear();
    else memoryValues.delete(event.key);
    listener();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

/** クラウドに元の写真も置くか（この Mac の切り替え。既定はオン）。 */
export function readPhotoEditingCloudOriginalsEnabled(): boolean {
  return readValue(PHOTO_EDITING_CLOUD_ORIGINALS_STORAGE_KEY) !== CLOUD_ORIGINALS_OFF_VALUE;
}

export function writePhotoEditingCloudOriginalsEnabled(enabled: boolean): void {
  writeValue(PHOTO_EDITING_CLOUD_ORIGINALS_STORAGE_KEY, enabled ? null : CLOUD_ORIGINALS_OFF_VALUE);
}

/** macOS 現像の知らせを閉じたか（閉じたら二度と出さない）。 */
export function readPhotoEditingProfileNoticeDismissed(): boolean {
  return readValue(PHOTO_EDITING_PROFILE_NOTICE_DISMISSED_STORAGE_KEY) === PROFILE_NOTICE_DISMISSED_VALUE;
}

export function dismissPhotoEditingProfileNotice(): void {
  writeValue(PHOTO_EDITING_PROFILE_NOTICE_DISMISSED_STORAGE_KEY, PROFILE_NOTICE_DISMISSED_VALUE);
}

/** ブラウザ版の一覧の並び（この端末の切り替え。既定は撮影日）。 */
export function readPhotoEditingListSort(): PhotoEditingListSort {
  const value = readValue(PHOTO_EDITING_LIST_SORT_STORAGE_KEY);
  return value === "added" || value === "captured" ? value : DEFAULT_PHOTO_EDITING_LIST_SORT;
}

export function writePhotoEditingListSort(sort: PhotoEditingListSort): void {
  writeValue(PHOTO_EDITING_LIST_SORT_STORAGE_KEY, sort);
}

/** 書き出しの大きさ（この端末で最後に選んだ値。既定は長辺 2048px）。 */
export function readPhotoEditingExportSize(): BrowserPhotoExportSizeOption {
  const value = readValue(PHOTO_EDITING_EXPORT_SIZE_STORAGE_KEY);
  return value === "long2048" || value === "width1080" || value === "large" || value === "full"
    ? value
    : DEFAULT_PHOTO_EDITING_EXPORT_SIZE;
}

export function writePhotoEditingExportSize(size: BrowserPhotoExportSizeOption): void {
  writeValue(PHOTO_EDITING_EXPORT_SIZE_STORAGE_KEY, size);
}

/** server で描くときの値（既定: 元の写真も置く）。 */
function getServerCloudOriginalsEnabled(): boolean {
  return true;
}

/** server で描くときの値（既定の並び）。 */
function getServerListSort(): PhotoEditingListSort {
  return DEFAULT_PHOTO_EDITING_LIST_SORT;
}

/** server で描くときの値（既定の書き出しの大きさ）。 */
function getServerExportSize(): BrowserPhotoExportSizeOption {
  return DEFAULT_PHOTO_EDITING_EXPORT_SIZE;
}

/** server で描くときの値（既定: まだ閉じていない）。 */
function getServerProfileNoticeDismissed(): boolean {
  return false;
}

/** クラウドに元の写真も置くか（この Mac の切り替え）と、それを書き換える関数。同じページの読み手すべてに反映する。 */
export function usePhotoEditingCloudOriginalsEnabled(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(
    subscribe,
    readPhotoEditingCloudOriginalsEnabled,
    getServerCloudOriginalsEnabled,
  );
  return [enabled, writePhotoEditingCloudOriginalsEnabled];
}

/** macOS 現像の知らせを閉じたかと、閉じる関数（押すと二度と出さない）。 */
export function usePhotoEditingProfileNoticeDismissed(): [boolean, () => void] {
  const dismissed = useSyncExternalStore(
    subscribe,
    readPhotoEditingProfileNoticeDismissed,
    getServerProfileNoticeDismissed,
  );
  return [dismissed, dismissPhotoEditingProfileNotice];
}

/** ブラウザ版の一覧の並びと、それを書き換える関数（同じページの読み手すべてに反映する）。 */
export function usePhotoEditingListSort(): [PhotoEditingListSort, (sort: PhotoEditingListSort) => void] {
  const sort = useSyncExternalStore(subscribe, readPhotoEditingListSort, getServerListSort);
  return [sort, writePhotoEditingListSort];
}

/** 書き出しの大きさと、それを書き換える関数（PC とスマホのシートが同じ値を見る）。 */
export function usePhotoEditingExportSize(): [
  BrowserPhotoExportSizeOption,
  (size: BrowserPhotoExportSizeOption) => void,
] {
  const size = useSyncExternalStore(subscribe, readPhotoEditingExportSize, getServerExportSize);
  return [size, writePhotoEditingExportSize];
}

/** テスト用: storage に書けなかったときのメモリ上の値を捨てる。 */
export function resetPhotoEditingLocalSettingsForTest(): void {
  memoryValues.clear();
}
