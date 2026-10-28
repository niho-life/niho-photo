import { readJpegPixelSize } from "./image-bytes-metadata";

import {
  BROWSER_PHOTO_EXPORT_CAPTURE_OFFSET_MINUTES,
  browserPhotoExportLongEdge,
  type BrowserPhotoExportSize,
} from "./browser-photo-export";
import { BROWSER_PHOTO_EXPORT_LARGE_LONG_EDGE, BROWSER_PHOTO_EXPORT_LONG_EDGE } from "./browser-photo-source";
import {
  DevelopMaskSurfaceError,
  type DevelopEngine,
  type DevelopMaskSurfaceSource,
} from "./develop-engine/develop-engine-client";
import { PHOTO_EDITING_MASK_SURFACE_EXPORT_FAILED_TEXT } from "./photo-editing-copy";
import type { DevelopSettings } from "./develop-engine/develop-settings";
import {
  DEVELOP_WEB_IMAGE_JPEG_QUALITY,
  exportDevelopJpeg,
  type DevelopRenderInput,
} from "./develop-engine/develop-render-input";

/**
 * 書き出しの JPEG を段 2 の wasm で入力（オリジナルか作業コピー）から描く（F7b 移行元設計。移行時の設計文書
 * 「書き出す」）。記事用の画像を縮めて代わりに使わない（K3 移行元設計・Epic 決まりごと 1）。1 枚で開いている写真も、一覧で選んだだけの
 * 写真も同じ部品で描く。
 */

export type BrowserPhotoExportRendered = {
  bytes: Uint8Array<ArrayBuffer>;
  /** 描いた JPEG の実寸（読めなければ 0） */
  width: number;
  height: number;
  /**
   * 選んだ大きさに届いたか。`width1080` で、写真が小さくて求めた長辺に届かなかった（段 2 は拡大しない）ときだけ false
   * （状態欄に「小さい写真は拡大しません」を足す）。縦に長すぎて長辺 2048px で頭打ちになった写真は、写真が小さいのではないので
   * true。`long2048`・`large` は常に true
   */
  reachedWidth: boolean;
};

/**
 * 描いて、撮影日時の EXIF を付ける。
 *
 * 1. 長辺を決める: `long2048` は 2048、`large` は 4096（元・作業コピーの大きさで頭打ち。niho-photo#134）。`width1080` は、元の寸法（`imageSize`。向きを反映）から長辺 2048px で描いたときの出力の寸法
 *    （`geometryOutputSize`。切り抜き・回転の後）を読み、幅が 1080 になる長辺（{@link browserPhotoExportLongEdge}）
 * 2. その長辺で描く（`exportDevelopJpeg`。`input` は Worker へ渡して手放すので、呼び出し側がコピーを渡す）
 * 3. `capturedAt` があれば NIHO の EXIF（撮影日時を +09:00 で・向き 1・sRGB。位置情報・カメラは付けない）を付ける。付けられ
 *    なかったら（古い wasm など）EXIF 無しのまま書き出す
 * 4. 実寸を JPEG のヘッダーから読む
 */
export async function renderBrowserPhotoExportJpeg(params: {
  engine: DevelopEngine;
  input: DevelopRenderInput;
  settings: DevelopSettings;
  size: BrowserPhotoExportSize;
  /** 写真の撮影日時（ISO 8601・UTC。無ければ EXIF を付けない） */
  capturedAt: string | null;
  /** JPEG の画質（省略 = 記事用の画像と同じ 90。背景除去を当てる前の画は 100。C4 移行元設計） */
  quality?: number;
  /**
   * 描かれる面のマスク（ブラシ・被写体・空。M4 #68）の面の読み口（書き出す写真のもの）。省略 = engine が覚えた面と開いている写真の
   * 読み口（1 枚で開いている写真）
   */
  maskSurfaces?: DevelopMaskSurfaceSource | null;
}): Promise<BrowserPhotoExportRendered> {
  const { engine, input, settings, size } = params;
  let longEdge = size === "large" ? BROWSER_PHOTO_EXPORT_LARGE_LONG_EDGE : BROWSER_PHOTO_EXPORT_LONG_EDGE;
  if (size === "width1080") {
    // imageSize は bytes をコピーで渡す（この後 exportDevelopJpeg が同じ bytes を手放す）
    const source = await engine.imageSize(input.bytes);
    const frame = await engine.geometryOutputSize(settings, source, BROWSER_PHOTO_EXPORT_LONG_EDGE);
    longEdge = browserPhotoExportLongEdge(size, frame);
  }
  let rendered: Uint8Array<ArrayBuffer>;
  try {
    rendered = await exportDevelopJpeg(engine, input, settings, {
      maxDimension: longEdge,
      quality: params.quality ?? DEVELOP_WEB_IMAGE_JPEG_QUALITY,
      ...(params.maskSurfaces !== undefined ? { maskSurfaces: params.maskSurfaces } : {}),
    });
  } catch (error) {
    // 面を読めないマスクは外して書き出さない（理由と次の一歩を出す）
    if (error instanceof DevelopMaskSurfaceError) throw new Error(PHOTO_EDITING_MASK_SURFACE_EXPORT_FAILED_TEXT);
    throw error;
  }
  const bytes = params.capturedAt ? await withCaptureExifOrPlain(engine, rendered, params.capturedAt) : rendered;
  const pixelSize = readJpegPixelSize(bytes);
  // 寸法を読めない JPEG でも書き出しは止めない（届かなかったとは言わない）
  if (!pixelSize) return { bytes, width: 0, height: 0, reachedWidth: true };
  return {
    bytes,
    width: pixelSize.width,
    height: pixelSize.height,
    reachedWidth: size !== "width1080" || Math.max(pixelSize.width, pixelSize.height) >= longEdge,
  };
}

/**
 * 撮影日時の EXIF を付ける。付けられなかったら EXIF 無しの JPEG のまま（Worker へはコピーを渡し、元の JPEG は手元に残す）。
 * 背景除去を当てた JPEG（C4 移行元設計）も同じ引数で付ける。
 */
export async function withCaptureExifOrPlain(
  engine: DevelopEngine,
  jpeg: Uint8Array<ArrayBuffer>,
  capturedAt: string,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await engine.withCaptureExif(jpeg.slice(), capturedAt, BROWSER_PHOTO_EXPORT_CAPTURE_OFFSET_MINUTES);
  } catch (error) {
    console.warn("[photo-editing] export capture EXIF skipped", error);
    return jpeg;
  }
}
