"use client";

import { useEffect, useState, type MutableRefObject } from "react";

import { BROWSER_PHOTO_EXPORT_LARGE_LONG_EDGE } from "../browser-photo-source";
import type { DevelopEngine } from "../develop-engine/develop-engine-client";
import type { DevelopSettings } from "../develop-engine/develop-settings";
import { readDevelopSize, type DevelopSize } from "../photo-editing-crop";
import type { DevelopSession } from "./browser-photo-editing-model";
import { readCropSource } from "./use-browser-photo-crop";

/**
 * 書き出しの大きさ「大きく」（niho-photo#134）で書き出す画の寸法を、1 枚で wasm で開いている写真の今の補正から読む（カードの長辺と、
 * スマホで wasm のメモリに収まるかの見積もりに使う）。切り抜きの道具の「書き出しは長辺 N px まで」と同じ読み方: 書き出しが読む大きさ
 * （作業コピーはその大きさ、JPEG / PNG のオリジナルは長辺 4096px に収めた大きさ。{@link readCropSource}）を、今の切り抜き・回転で
 * 長辺 4096px までに描いたときの出力の寸法（`geometryOutputSize`）。
 *
 * 書き出しのシートを開いている間（`active`）だけ、写真と補正が変わるたびに読む。読めない（wasm に幾何の口が無い・写真を離れた）
 * ときと読み終わるまでは null（カードは上限を出す）。
 */
export function useBrowserPhotoExportLargeSize(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  developSessionRef: MutableRefObject<DevelopSession | null>;
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null） */
  photoKey: string | null;
  settingsKey: string;
  settingsRef: MutableRefObject<DevelopSettings>;
  active: boolean;
}): DevelopSize | null {
  const { mountedRef, engineRef, developSessionRef, photoKey, settingsKey, settingsRef, active } = params;
  const [read, setRead] = useState<{ key: string; size: DevelopSize } | null>(null);
  const requestKey = active && photoKey !== null ? `${photoKey}\u001f${settingsKey}` : null;

  useEffect(() => {
    const engine = engineRef.current;
    const session = developSessionRef.current;
    if (requestKey === null || !engine || !session || session.key !== photoKey) return;
    let cancelled = false;
    void (async () => {
      const source = await readCropSource(engine, session);
      if (!source || cancelled) return;
      const output = readDevelopSize(
        await engine.geometryOutputSize(settingsRef.current, source.exportInput, BROWSER_PHOTO_EXPORT_LARGE_LONG_EDGE),
      );
      if (!output || cancelled || !mountedRef.current) return;
      setRead({ key: requestKey, size: output });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [developSessionRef, engineRef, mountedRef, photoKey, requestKey, settingsRef]);

  return read !== null && read.key === requestKey ? read.size : null;
}
