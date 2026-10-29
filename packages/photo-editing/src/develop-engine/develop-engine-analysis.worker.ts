import {
  createDevelopAnalysisWorkerHandler,
  type DevelopAnalysisHelperRequest,
  type DevelopAnalysisHelperResponse,
} from "./develop-engine-analysis-worker-core";

/**
 * 先回りの解析を作る補助の Web Worker の殻（#155）。描画の worker（`develop-engine.worker.ts`）がその中で作る。中身は
 * {@link createDevelopAnalysisWorkerHandler}。glue は描画の worker と同じく公開物の置き場（manifest が指す URL）から実行時に読み込むので、
 * bundler には解決させない。
 */

/** tsconfig に webworker の lib が無いので、使う分だけの局所の型へ寄せる。 */
type DevelopAnalysisWorkerScope = {
  postMessage: (message: DevelopAnalysisHelperResponse, transfer: Transferable[]) => void;
  addEventListener: (type: "message", listener: (event: MessageEvent<DevelopAnalysisHelperRequest>) => void) => void;
};

const scope = self as unknown as DevelopAnalysisWorkerScope;

const handler = createDevelopAnalysisWorkerHandler({
  fetch: (url, init) => fetch(url, init),
  importModule: (url) => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url),
  post: (message, transfer) => scope.postMessage(message, transfer ?? []),
});

scope.addEventListener("message", (event) => {
  void handler(event.data);
});
