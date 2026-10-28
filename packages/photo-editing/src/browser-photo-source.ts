import { readJpegPixelSize, readPngPixelSize } from "./image-bytes-metadata";

import {
  applyBrowserPhotoAdjustments,
  type BrowserPhotoAdjustments,
} from "./browser-photo-adjustments";

export const BROWSER_PHOTO_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
/**
 * クラウドの JPEG のオリジナルを読む上限（64MiB。K5-a 移行元設計）。JPEG は大きさによらずオリジナルから直接描くが、ブラウザは 1 枚を
 * 丸ごと持つので、写真置き場の上限（200MiB）までは読まない。超える JPEG は作業コピーで直す（`isDevelopWorkTarget`）。
 */
export const BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES = 64 * 1024 * 1024;
export const BROWSER_PHOTO_MAX_DECODE_PIXELS = 40_000_000;
export const BROWSER_PHOTO_PREVIEW_LONG_EDGE = 1280;
export const BROWSER_PHOTO_EXPORT_LONG_EDGE = 2048;
/**
 * 書き出しの大きさ「大きく」の長辺の上限（niho-photo#134）。JPEG / PNG のオリジナルは長辺 4096px に収めて読む（wasm の一発の描画の
 * `decodeCap`）ので、その大きさまで。作業コピー（RAW など）は作業コピーの長辺（2560px）まで（段 2 は拡大しない）。
 */
export const BROWSER_PHOTO_EXPORT_LARGE_LONG_EDGE = 4096;
/** 作業コピー（RAW・HEIC / HEIF・TIFF・大きな PNG）の長辺（「大きく」の上限。ワーカーの作業コピーと同じ）。 */
export const BROWSER_PHOTO_WORKING_COPY_LONG_EDGE = 2560;
export const BROWSER_PHOTO_JPEG_QUALITY = 0.9;
const HEADER_BYTES = 1024 * 1024;

export type BrowserDecodedPhoto = {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
};

export class BrowserPhotoSourceError extends Error {
  constructor(readonly reason: "unsupported" | "too_large" | "decode_failed" | "fetch_failed" | "encode_failed") {
    super(reason);
    this.name = "BrowserPhotoSourceError";
  }
}

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ACCEPTED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

export function isBrowserPhotoFile(file: Pick<File, "name" | "type">): boolean {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ACCEPTED_TYPES.has(file.type.toLowerCase()) || ACCEPTED_EXTENSIONS.has(extension);
}

function assertSize(width: number, height: number): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > BROWSER_PHOTO_MAX_DECODE_PIXELS
  ) {
    throw new BrowserPhotoSourceError("too_large");
  }
}

function bytesEqual(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readWebpPixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 12 || !bytesEqual(bytes, 0, "RIFF") || !bytesEqual(bytes, 8, "WEBP")) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const name = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const payloadSize = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    const available = bytes.length - payload;

    // 画像の圧縮データ全体が先頭1MiBに収まらなくても、寸法ヘッダだけで検査できる。
    if (name === "VP8X" && payloadSize >= 10 && available >= 10) {
      return {
        width: readUint24LE(bytes, payload + 4) + 1,
        height: readUint24LE(bytes, payload + 7) + 1,
      };
    }
    if (name === "VP8L" && payloadSize >= 5 && available >= 5 && bytes[payload] === 0x2f) {
      const packed = view.getUint32(payload + 1, true);
      return {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      };
    }
    if (
      name === "VP8 " &&
      payloadSize >= 10 &&
      available >= 10 &&
      bytes[payload + 3] === 0x9d &&
      bytes[payload + 4] === 0x01 &&
      bytes[payload + 5] === 0x2a
    ) {
      const width = view.getUint16(payload + 6, true) & 0x3fff;
      const height = view.getUint16(payload + 8, true) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }

    const paddedSize = payloadSize + (payloadSize % 2);
    if (paddedSize > bytes.length - payload) return null;
    offset = payload + paddedSize;
  }
  return null;
}

/**
 * ヘッダの寸法（JPEG の SOF / PNG の IHDR / WebP の VP8*）を、デコードせずに読む。形式は中身で見分ける。読めなければ null。
 * 先頭 1MiB に JPEG の SOF が無ければ（SOF より前の ICC / XMP が大きい）、`fullReadMaxBytes` 以下のファイルだけ全体を読む。
 */
export async function readBrowserPhotoPixelSize(
  file: Blob,
  fullReadMaxBytes: number = BROWSER_PHOTO_MAX_SOURCE_BYTES,
): Promise<{ width: number; height: number } | null> {
  const bytes = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const webp = bytesEqual(bytes, 0, "RIFF") && bytesEqual(bytes, 8, "WEBP");
  const size = jpeg
    ? readJpegPixelSize(bytes)
    : png
      ? readPngPixelSize(bytes)
      : webp
        ? readWebpPixelSize(bytes)
        : null;
  if (size || !jpeg || file.size <= bytes.length || file.size > fullReadMaxBytes) return size;
  return readJpegPixelSize(new Uint8Array(await file.arrayBuffer()));
}

/** デコードしてよい寸法か（1px 以上・4,000 万画素以下）。 */
export function isBrowserPhotoDecodableSize(size: { width: number; height: number }): boolean {
  try {
    assertSize(size.width, size.height);
    return true;
  } catch {
    return false;
  }
}

/**
 * クラウドのオリジナルを読む上限（拡張子で決める）。JPEG は 64MiB、PNG / WebP は 10MB（K5-a 移行元設計。画素数の上限 4,000 万は
 * 形式によらず同じ）。
 */
export function browserCloudOriginalMaxBytes(fileExtension: string): number {
  const extension = fileExtension.trim().toLowerCase();
  return extension === "jpg" || extension === "jpeg" ? BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES : BROWSER_PHOTO_MAX_SOURCE_BYTES;
}

/** 読む大きさの上限（省けば 10MB。クラウドの JPEG のオリジナルは {@link browserCloudOriginalMaxBytes} を渡す）。 */
export type BrowserPhotoReadOptions = { maxBytes?: number };

/** object URL や画像デコーダへ渡す前に、対応形式・byte数・ヘッダ上の画素数を検査する。 */
export async function inspectBrowserPhotoFile(file: File, options: BrowserPhotoReadOptions = {}): Promise<void> {
  const maxBytes = options.maxBytes ?? BROWSER_PHOTO_MAX_SOURCE_BYTES;
  if (!isBrowserPhotoFile(file)) throw new BrowserPhotoSourceError("unsupported");
  if (file.size < 1 || file.size > maxBytes) throw new BrowserPhotoSourceError("too_large");
  // SOF より前の ICC / XMP が大きい JPEG も、byte 上限内で全ヘッダを確認してからデコードする。
  const size = await readBrowserPhotoPixelSize(file, maxBytes);
  if (!size) throw new BrowserPhotoSourceError("decode_failed");
  assertSize(size.width, size.height);
}

function decodeWithImageElement(file: Blob): Promise<BrowserDecodedPhoto> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        assertSize(image.naturalWidth, image.naturalHeight);
        resolve({
          source: image,
          width: image.naturalWidth,
          height: image.naturalHeight,
          cleanup: () => URL.revokeObjectURL(url),
        });
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new BrowserPhotoSourceError("decode_failed"));
    };
    image.src = url;
  });
}

export async function decodeBrowserPhoto(file: File, options: BrowserPhotoReadOptions = {}): Promise<BrowserDecodedPhoto> {
  await inspectBrowserPhotoFile(file, options);
  return decodeBrowserImageBlob(file);
}

/**
 * 画像をデコードする（向きは画素へ反映する）。形式・byte 数・ヘッダの寸法は呼び出し側が先に確かめる。デコードした寸法が
 * 4,000 万画素を超えたら解放して `too_large`。
 */
export async function decodeBrowserImageBlob(file: Blob): Promise<BrowserDecodedPhoto> {
  if (typeof createImageBitmap === "function") {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      assertSize(bitmap.width, bitmap.height);
      const decodedBitmap = bitmap;
      return { source: decodedBitmap, width: decodedBitmap.width, height: decodedBitmap.height, cleanup: () => decodedBitmap.close() };
    } catch (error) {
      bitmap?.close();
      if (error instanceof BrowserPhotoSourceError && error.reason === "too_large") throw error;
    }
  }
  try {
    return await decodeWithImageElement(file);
  } catch (error) {
    if (error instanceof BrowserPhotoSourceError) throw error;
    throw new BrowserPhotoSourceError("decode_failed");
  }
}

export async function fetchBrowserPhotoFile(
  url: string,
  fileName: string,
  signal: AbortSignal,
  options: BrowserPhotoReadOptions = {},
): Promise<File> {
  const maxBytes = options.maxBytes ?? BROWSER_PHOTO_MAX_SOURCE_BYTES;
  let response: Response;
  try {
    response = await fetch(url, { credentials: "omit", signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new BrowserPhotoSourceError("fetch_failed");
  }
  if (!response.ok) throw new BrowserPhotoSourceError("fetch_failed");
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? null : Number(contentLength);
  if (declared !== null && Number.isFinite(declared) && declared > maxBytes) {
    throw new BrowserPhotoSourceError("too_large");
  }
  let blob: Blob;
  if (response.body) {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new BrowserPhotoSourceError("fetch_failed");
    }
    const parts: ArrayBuffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // 上限超過を正として扱い、cancel 自体の失敗で通信エラーへ変えない。
          }
          throw new BrowserPhotoSourceError("too_large");
        }
        parts.push(new Uint8Array(value).buffer);
      }
    } catch (error) {
      if (signal.aborted || error instanceof BrowserPhotoSourceError) throw error;
      throw new BrowserPhotoSourceError("fetch_failed");
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // read/cancel の結果を優先する。
      }
    }
    blob = new Blob(parts, { type: response.headers.get("content-type") || "image/jpeg" });
  } else {
    try {
      blob = await response.blob();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new BrowserPhotoSourceError("fetch_failed");
    }
    if (blob.size > maxBytes) throw new BrowserPhotoSourceError("too_large");
  }
  return new File([blob], fileName, { type: blob.type || "image/jpeg", lastModified: Date.now() });
}

export function browserPhotoTargetSize(
  source: Pick<BrowserDecodedPhoto, "width" | "height">,
  maxLongEdge: number,
): { width: number; height: number } {
  const longEdge = Math.max(source.width, source.height);
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

function renderPixels(
  canvas: HTMLCanvasElement,
  decoded: BrowserDecodedPhoto,
  settings: BrowserPhotoAdjustments,
  original: boolean,
  maxLongEdge: number,
): void {
  const size = browserPhotoTargetSize(decoded, maxLongEdge);
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new BrowserPhotoSourceError("encode_failed");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, size.width, size.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(decoded.source, 0, 0, size.width, size.height);
  if (original) return;
  const frame = context.getImageData(0, 0, size.width, size.height);
  frame.data.set(applyBrowserPhotoAdjustments(frame.data, settings));
  context.putImageData(frame, 0, 0);
}

export function renderBrowserPhotoPreview(
  canvas: HTMLCanvasElement,
  decoded: BrowserDecodedPhoto,
  settings: BrowserPhotoAdjustments,
  original: boolean,
): void {
  renderPixels(canvas, decoded, settings, original, BROWSER_PHOTO_PREVIEW_LONG_EDGE);
}

export async function exportBrowserPhotoJpeg(
  decoded: BrowserDecodedPhoto,
  settings: BrowserPhotoAdjustments,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  try {
    renderPixels(canvas, decoded, settings, false, BROWSER_PHOTO_EXPORT_LONG_EDGE);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", BROWSER_PHOTO_JPEG_QUALITY));
    if (!blob) throw new BrowserPhotoSourceError("encode_failed");
    return blob;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

export function describeBrowserPhotoSourceError(error: unknown): string {
  if (!(error instanceof BrowserPhotoSourceError)) return "写真を読み込めませんでした。もう一度お試しください。";
  if (error.reason === "unsupported") return "ブラウザ編集では JPEG / PNG / WebP を使えます。";
  if (error.reason === "too_large") return "この写真は大きすぎます。10MB 以下・4,000万画素以下の写真を選んでください。";
  if (error.reason === "fetch_failed") return "写真を読み込めませんでした。通信状態を確かめて、もう一度お試しください。";
  return "写真を開けませんでした。別の写真をお試しください。";
}
