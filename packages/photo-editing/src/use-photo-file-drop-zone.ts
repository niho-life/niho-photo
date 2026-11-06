"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";

import {
  capturePhotoDrop,
  collectPhotoDropFiles,
  isPhotoFileDrag,
  sortPhotoDropFiles,
  type SortedPhotoDrop,
} from "./photo-file-drop";

/**
 * 写真編集の面の落とし口の今の状態（移行元設計）。`accept` は受けられる（`queued` は追加している途中で、続けて追加する）、
 * `reject` は受けられない（幕を薄くして理由だけ出し、落としても何もしない）。
 */
export type PhotoFileDropZoneState = { kind: "accept"; queued: boolean } | { kind: "reject"; reason: string };

export type PhotoFileDropZoneProps = {
  onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
};

/**
 * 写真編集の面全体を、Finder などから写真を落とす口にする（移行元設計・owner 決定 2026-09-29）。
 *
 * - 受けるのは `Files` を運ぶドラッグだけ（記事制作の画像ライブラリのタイルなど、ページ内のドラッグには反応しない）
 * - 面の中の要素をまたぐ dragenter / dragleave で幕がちらつかないよう、入った深さを数える
 * - 落としたら、ハンドラの中で項目と `captureDropContext` を同期的に取り出してからフォルダの中身を辿り、形式でふるって
 *   `onDropFiles` に渡す。非同期の読み取り中に表示先が替わった場合の判定に使う
 * - 面が有効な間（`enabled`）は、面の外に落としてもページがファイルを開いて離れないよう、window で `Files` のドラッグを
 *   止める（面の外では `dropEffect = "none"`）。面や他の落とし口が先に止めたイベント（`defaultPrevented`）には触らない
 *
 * `zone` が null のとき（閲覧のみ）は幕を出さず受けないが、ページを離れないようにだけする。
 */
export function usePhotoFileDropZone<TDropContext = undefined>(options: {
  enabled: boolean;
  zone: PhotoFileDropZoneState | null;
  /** `drop` イベント中に同期して保存する宛先などの文脈 */
  captureDropContext?: () => TDropContext;
  onDropFiles: (dropped: SortedPhotoDrop, context: TDropContext) => void;
}): { overlay: PhotoFileDropZoneState | null; zoneProps: PhotoFileDropZoneProps } {
  const { enabled, zone } = options;
  const [dragging, setDragging] = useState(false);
  const depthRef = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const zoneRef = useRef(zone);
  zoneRef.current = zone;
  const onDropFilesRef = useRef(options.onDropFiles);
  onDropFilesRef.current = options.onDropFiles;
  const captureDropContextRef = useRef(options.captureDropContext);
  captureDropContextRef.current = options.captureDropContext;
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resetDragging = useCallback(() => {
    depthRef.current = 0;
    setDragging(false);
  }, []);

  // 面を隠したら（設定サブタブ）幕を下ろす
  useEffect(() => {
    if (!enabled) resetDragging();
  }, [enabled, resetDragging]);

  // 面の外に落としてもページを離れない（面が有効な間だけ）
  useEffect(() => {
    if (!enabled) return;
    const onDragOver = (event: DragEvent) => {
      if (event.defaultPrevented || !event.dataTransfer || !isPhotoFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "none";
    };
    const onDrop = (event: DragEvent) => {
      // 面の外に落とした・Esc で止めたときも幕を下ろす
      resetDragging();
      if (event.defaultPrevented || !event.dataTransfer || !isPhotoFileDrag(event.dataTransfer)) return;
      event.preventDefault();
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", resetDragging);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", resetDragging);
    };
  }, [enabled, resetDragging]);

  const zoneProps = useMemo<PhotoFileDropZoneProps>(() => {
    /** 受けられるときは copy、受けられないときは none（止めて、ページが開かないようにする）。閲覧のみは window に任せる */
    const claim = (event: ReactDragEvent<HTMLElement>): boolean => {
      const current = zoneRef.current;
      if (!current) return false;
      event.preventDefault();
      event.dataTransfer.dropEffect = current.kind === "accept" ? "copy" : "none";
      return true;
    };
    return {
      onDragEnter: (event) => {
        if (!enabledRef.current || !isPhotoFileDrag(event.dataTransfer)) return;
        depthRef.current += 1;
        if (depthRef.current === 1) setDragging(true);
        claim(event);
      },
      onDragOver: (event) => {
        if (!enabledRef.current || !isPhotoFileDrag(event.dataTransfer)) return;
        // dragenter を取りこぼしたとき（面を開く前から持っていたなど）も幕を出す
        if (depthRef.current === 0) {
          depthRef.current = 1;
          setDragging(true);
        }
        claim(event);
      },
      onDragLeave: (event) => {
        if (!isPhotoFileDrag(event.dataTransfer) || depthRef.current === 0) return;
        depthRef.current -= 1;
        if (depthRef.current === 0) setDragging(false);
      },
      onDrop: (event) => {
        if (!isPhotoFileDrag(event.dataTransfer)) return;
        depthRef.current = 0;
        setDragging(false);
        if (!enabledRef.current || !claim(event)) return;
        if (zoneRef.current?.kind !== "accept") return;
        // ハンドラを抜けると dataTransfer は読めなくなるので、項目はここで取り出す
        const captured = capturePhotoDrop(event.dataTransfer);
        const context = captureDropContextRef.current?.() as TDropContext;
        void collectPhotoDropFiles(captured).then((files) => {
          if (!mountedRef.current || !enabledRef.current) return;
          onDropFilesRef.current(sortPhotoDropFiles(files), context);
        });
      },
    };
  }, []);

  return { overlay: enabled && dragging ? zone : null, zoneProps };
}
