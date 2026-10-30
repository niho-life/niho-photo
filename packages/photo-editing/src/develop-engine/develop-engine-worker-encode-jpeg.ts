/**
 * 作業コピーから描いた画素を Worker の中で JPEG にする（移行元設計。sRGB のまま・撮影情報なし）。`OffscreenCanvas` が無ければ null
 * （画素を返し、メインスレッドが canvas で JPEG にする）。描画の Worker と使い捨ての書き出しの worker（#155）が同じ bytes を作るよう、
 * 両方の殻がこれを使う。
 */
export async function encodeJpegInWorker(
  width: number,
  height: number,
  rgba: ArrayBuffer,
  quality: number,
): Promise<ArrayBuffer | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
  return blob.arrayBuffer();
}
