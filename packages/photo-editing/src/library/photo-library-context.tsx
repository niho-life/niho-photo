"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { PhotoLibrary, PhotoLibraryCapabilities } from "./photo-library";

/**
 * 編集面を動かすホストの接続口。
 * 写真の読み書きはPhotoLibrary、保存方法・実行環境・画面への通知はここで受け取る。
 * 画面遷移とログインはホストの責務。下書きの持ち主はactorIdで受け取る。
 */
export type PhotoEditingHost = {
  /** 本人/接続の世代が失効したら同期的にabortする。ローカル専用hostでは省略できる。 */
  readonly scopeSignal?: AbortSignal;
  /** OSへ新たなファイルを渡せる本人/接続の状態か。検証中・期限切れもfalseにする。 */
  isScopeCurrent?(): boolean;
  /**
   * 写真の中身が変わった（足した・作業コピーができた・補正後のプレビューが付いた）ことを、編集面の外の画面へ知らせる
   * （web は記事制作の画像ライブラリを読み直す。外の画面が無いアプリは何もしない）。待たない・失敗しない
   */
  notifyPhotosChanged(): void;
  /**
   * 1 つのファイルを端末へ保存する（web はブラウザのダウンロード、スマホアプリは保存先を選ぶ画面、NIHO Desktop は保存ダイアログ）。
   * 保存先を選ぶ画面を閉じたら `cancelled`。保存できなければ画面に出せる 1 行の `Error` を投げる
   */
  saveFile(file: { blob: Blob; fileName: string }): Promise<PhotoEditingSaveFileResult>;
  /** スマホアプリの保存（保存先を選ぶ画面）を使えるか（スマホで書き出した写真の保存の経路を決める） */
  nativeFileSaveAvailable(): boolean;
  /** スマホアプリ（native の WebView）の中で開いているか（全画面の面の上下に安全領域の余白を足す） */
  isNativeViewport(): boolean;
  /**
   * Mac のアプリ（NIHO Desktop・NIHO camera）の WebView の中で開いているか。ブラウザだけが ZIP を保存し、PC の広い幅で一括の補正の
   * 入口とキーを出す（Mac のアプリは保存・一括をアプリの道具で行う）
   */
  isDesktopApp(): boolean;
};

/** `saved` はアプリが保存した、`cancelled` は保存先を選ぶ画面を閉じた、`downloaded` はブラウザのダウンロードに渡した。 */
export type PhotoEditingSaveFileResult = "saved" | "cancelled" | "downloaded";

type PhotoLibraryContextValue = { library: PhotoLibrary; host: PhotoEditingHost };

const PhotoLibraryContext = createContext<PhotoLibraryContextValue | null>(null);

/**
 * 編集面に写真の出どころ（{@link PhotoLibrary}）とアプリの都合（{@link PhotoEditingHost}）を渡す。編集面の外側（web は写真編集タブと
 * 記事制作の「画像を追加」、camera はアプリの根）で 1 回だけ包む。`library` は拠点（置き場）ごとに 1 つで、変わったら編集面を
 * 作り直す（web は拠点ごとに `key` を替える）。
 */
export function PhotoLibraryProvider(props: { library: PhotoLibrary; host: PhotoEditingHost; children: ReactNode }) {
  const { library, host } = props;
  const value = useMemo(() => ({ library, host }), [library, host]);
  return <PhotoLibraryContext.Provider value={value}>{props.children}</PhotoLibraryContext.Provider>;
}

function usePhotoLibraryContext(hookName: string): PhotoLibraryContextValue {
  const value = useContext(PhotoLibraryContext);
  if (!value) throw new Error(`${hookName} must be used inside PhotoLibraryProvider`);
  return value;
}

/** 写真の出どころ（{@link PhotoLibrary}）。{@link PhotoLibraryProvider} の外で呼ぶと投げる。 */
export function usePhotoLibrary(): PhotoLibrary {
  return usePhotoLibraryContext("usePhotoLibrary").library;
}

/** アプリの都合（{@link PhotoEditingHost}）。{@link PhotoLibraryProvider} の外で呼ぶと投げる。 */
export function usePhotoEditingHost(): PhotoEditingHost {
  return usePhotoLibraryContext("usePhotoEditingHost").host;
}

/**
 * 写真の出どころのできること（{@link PhotoLibrary.capabilities}）。読めるまでは `initialCapabilities`（すぐ分かる値か閉じた値）で、
 * 写真の出どころが変わったら読み直す（前の口の結果・unmount 後に届いた結果は捨てる）。読めなければ閉じた値のまま。
 */
export function usePhotoLibraryCapabilities(): PhotoLibraryCapabilities {
  const library = usePhotoLibrary();
  const [state, setState] = useState(() => ({ library, capabilities: library.initialCapabilities }));
  useEffect(() => {
    let cancelled = false;
    library.capabilities().then(
      (capabilities) => {
        if (!cancelled) setState({ library, capabilities });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [library]);
  return state.library === library ? state.capabilities : library.initialCapabilities;
}
