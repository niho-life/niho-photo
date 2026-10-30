import { encodeJpegInWorker } from "./develop-engine-worker-encode-jpeg";
import {
  createDevelopEngineWorkerHandler,
  type DevelopEngineWorkerRequest,
  type DevelopEngineWorkerResponse,
} from "./develop-engine-worker-core";

/**
 * 予算に収まらない書き出しを 1 回だけ描く使い捨ての Web Worker の殻（#155）。描画の worker（`develop-engine.worker.ts`）がその中で
 * 作り、`init`（`disposable: true`）と書き出しの要求を 1 つずつ送って、結果を受け取ったら terminate する。中身は描画の worker と
 * 同じ {@link createDevelopEngineWorkerHandler}（単一スレッドの wasm）で、補助の worker・使い捨ての worker・解析の保存先・native は
 * 渡さない。書き出しの JPEG を同じ bytes にするため、JPEG にする口は描画の worker と同じものを渡す。
 */

/** tsconfig に webworker の lib が無いので、使う分だけの局所の型へ寄せる。 */
type DevelopEngineExportWorkerScope = {
  postMessage: (message: DevelopEngineWorkerResponse, transfer: Transferable[]) => void;
  addEventListener: (type: "message", listener: (event: MessageEvent<DevelopEngineWorkerRequest>) => void) => void;
};

const scope = self as unknown as DevelopEngineExportWorkerScope;

const handler = createDevelopEngineWorkerHandler({
  fetch: (url, init) => fetch(url, init),
  importModule: (url) => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url),
  post: (message, transfer) => scope.postMessage(message, transfer ?? []),
  encodeJpeg: encodeJpegInWorker,
});

scope.addEventListener("message", (event) => {
  void handler(event.data);
});
