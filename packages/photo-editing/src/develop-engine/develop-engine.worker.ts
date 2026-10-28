import {
  createDevelopEngineWorkerHandler,
  type DevelopEngineWorkerRequest,
  type DevelopEngineWorkerResponse,
} from "./develop-engine-worker-core";

/**
 * 段 2 の wasm を動かす Web Worker の殻（移行元設計）。中身は {@link createDevelopEngineWorkerHandler}。glue は公開物の置き場
 * （manifest が指す URL）から実行時に読み込むので、bundler には解決させない。
 */

/** tsconfig に webworker の lib が無いので、使う分だけの局所の型へ寄せる。 */
type DevelopEngineWorkerScope = {
  postMessage: (message: DevelopEngineWorkerResponse, transfer: Transferable[]) => void;
  addEventListener: (type: "message", listener: (event: MessageEvent<DevelopEngineWorkerRequest>) => void) => void;
};

const scope = self as unknown as DevelopEngineWorkerScope;

/**
 * 作業コピーから描いた画素を Worker の中で JPEG にする（移行元設計。sRGB のまま・撮影情報なし）。`OffscreenCanvas` が無ければ null
 * （画素を返し、メインスレッドが canvas で JPEG にする）。
 */
async function encodeJpeg(width: number, height: number, rgba: ArrayBuffer, quality: number): Promise<ArrayBuffer | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
  return blob.arrayBuffer();
}

/**
 * 開く入力の bytes の SHA-256（#129。同じ写真を開き直したときに保っている写真を使い回す鍵）。`crypto.subtle` が無い（安全でない
 * 文脈）なら null（写真を保たない）。
 */
async function digest(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const hash = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const handler = createDevelopEngineWorkerHandler({
  fetch: (url, init) => fetch(url, init),
  importModule: (url) => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url),
  post: (message, transfer) => scope.postMessage(message, transfer ?? []),
  // Chrome のメイン画面からも Worker の時間と Wasm 容量を読めるようにする。
  // 診断フラグがないと handler はこの口を呼ばない。
  logPerf: (record) => scope.postMessage({ type: "perf", id: 0, record }, []),
  encodeJpeg,
  digest,
});

scope.addEventListener("message", (event) => {
  void handler(event.data);
});
