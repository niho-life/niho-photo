import type { DevelopAnalysisHelper, DevelopAnalysisHelperResponse } from "./develop-engine-analysis-worker-core";
import { createBrowserDevelopAnalysisStore, createNativeDevelopAnalysisStore } from "./develop-engine-analysis-store";
import { createNativeDevelopGlue, NativeDevelopUnavailableError } from "./develop-engine-native-glue";
import { encodeJpegInWorker } from "./develop-engine-worker-encode-jpeg";
import {
  createDevelopEngineWorkerHandler,
  readThreadsEnvironment,
  type DevelopEngineExportWorker,
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
 * 開く入力の bytes の SHA-256（#129。同じ写真を開き直したときに保っている写真を使い回す鍵）。`crypto.subtle` が無い（安全でない
 * 文脈）なら null（写真を保たない）。
 */
async function digest(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const hash = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 先回りの解析を作る補助の worker（#155）をこの worker の中に作る。応答を `receive` に渡し、読み込めない・落ちたら null を渡す。
 * 作れなければ null（描画の worker で作る #129 の先回りに戻る）。この worker が終わる（terminate）と、中で作った補助の worker も
 * ブラウザが終わらせる。
 */
function createAnalysisHelper(receive: (response: DevelopAnalysisHelperResponse | null) => void): DevelopAnalysisHelper | null {
  try {
    const worker = new Worker(new URL("./develop-engine-analysis.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<DevelopAnalysisHelperResponse>) => receive(event.data));
    worker.addEventListener("error", () => receive(null));
    worker.addEventListener("messageerror", () => receive(null));
    return {
      post: (message, transfer) => worker.postMessage(message, transfer),
      terminate: () => worker.terminate(),
    };
  } catch {
    return null;
  }
}

/**
 * 予算に収まらない書き出しを描く使い捨ての worker（#155）をこの worker の中に作る。応答を `receive` に渡し、読み込めない・落ちたら
 * null を渡す。作れなければ null（持つ物を手放してこの worker で描く）。殻は別のファイル（自分自身を入れ子に起こすと bundler が
 * 循環させるおそれがある）。
 */
function createExportWorker(receive: (response: DevelopEngineWorkerResponse | null) => void): DevelopEngineExportWorker | null {
  try {
    const worker = new Worker(new URL("./develop-engine-export.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<DevelopEngineWorkerResponse>) => receive(event.data));
    worker.addEventListener("error", () => receive(null));
    worker.addEventListener("messageerror", () => receive(null));
    return {
      post: (message, transfer) => worker.postMessage(message, transfer),
      terminate: () => worker.terminate(),
    };
  } catch {
    return null;
  }
}

const analysisStore = createBrowserDevelopAnalysisStore();
const nativeAnalysisStore = createNativeDevelopAnalysisStore();

const handler = createDevelopEngineWorkerHandler({
  fetch: (url, init) => fetch(url, init),
  importModule: (url) => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url),
  threadsEnvironment: () => readThreadsEnvironment(self),
  post: (message, transfer) => scope.postMessage(message, transfer ?? []),
  createNativeGlue: () => createNativeDevelopGlue(),
  isNativeUnavailableError: (error) => error instanceof NativeDevelopUnavailableError,
  // Chrome のメイン画面からも Worker の時間と Wasm 容量を読めるようにする。
  // 診断フラグがないと handler はこの口を呼ばない。
  logPerf: (record) => scope.postMessage({ type: "perf", id: 0, record }, []),
  encodeJpeg: encodeJpegInWorker,
  digest,
  ...(analysisStore ? { analysisStore } : {}),
  ...(nativeAnalysisStore ? { nativeAnalysisStore } : {}),
  // worker の中で Worker を使えない環境（古い WebKit など）は今までどおり描画の worker で先回りを作り、書き出しもここで描く
  ...(typeof Worker === "function" ? { createAnalysisHelper, createExportWorker } : {}),
});

scope.addEventListener("message", (event) => {
  void handler(event.data);
});
