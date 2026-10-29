import { parseDevelopEngineManifest } from "./develop-engine-manifest";

/**
 * 先回りの解析を作る補助の Web Worker の中身（#155）。描画の worker（`develop-engine-worker-core.ts`）が写真ごとに作り、先回りが
 * 尽きた・写真を替えた・閉じたら terminate する。テストできるよう、fetch・glue の読み込み・postMessage を外から渡す（Worker の殻は
 * `develop-engine-analysis.worker.ts`）。
 *
 * - `start` で描画の worker と同じ manifest を読み、glue を読み込んで wasm を起こし（描画の worker と同じ版でなければ使わない）、
 *   描画の worker が開いたのと同じ作業コピー（16bit PNG とメタデータの JSON。PNG は transfer で受け取る）を開いて持つ
 * - `analysis` ごとに 1 つの設定の H/S の解析（signed RAW の CNR の元・応答の係数・niho-7 の面）を `Developer.exportAnalysis` で
 *   作り、版付きの bytes を返す（transfer。作るものが無ければ null）。受け取った順に 1 つずつ処理する
 * - 起こせない・開けない・作れないときは `error` を返す（描画の worker はその写真では自分で作る #129 の先回りへ戻る）
 */

/** 描画の worker から補助の worker への要求。 */
export type DevelopAnalysisHelperRequest =
  /** 写真を開く（1 つの補助の worker で 1 回だけ。`png` は transfer。`version` は描画の worker が起こした glue の版） */
  | { type: "start"; manifestUrl: string; version: string; png: ArrayBuffer; metaJson: string }
  /** 1 つの設定の解析を bytes にする */
  | { type: "analysis"; id: number; settingsJson: string };

/** 補助の worker の応答（`bytes` は transfer。null は作るものが無い）。 */
export type DevelopAnalysisHelperResponse =
  | { type: "analysis"; id: number; bytes: ArrayBuffer | null }
  | { type: "error"; id: number; message: string };

/** 描画の worker から見た補助の worker（`Worker` の使う分だけ。テストでは偽物を渡す）。 */
export type DevelopAnalysisHelper = {
  post: (message: DevelopAnalysisHelperRequest, transfer: Transferable[]) => void;
  terminate: () => void;
};

export type DevelopAnalysisWorkerDeps = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  importModule: (url: string) => Promise<unknown>;
  post: (message: DevelopAnalysisHelperResponse, transfer?: Transferable[]) => void;
};

/** 補助の worker が使う glue の `Developer`（解析を bytes にする口だけ）。 */
type AnalysisDeveloper = {
  exportAnalysis: (settingsJson: string) => unknown;
};

type AnalysisGlue = {
  init: (options: { module_or_path: string }) => Promise<unknown>;
  version: () => unknown;
  openWorkingCopy: (png: Uint8Array, metaJson: string) => AnalysisDeveloper;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** glue の形（default・version・`Developer.openWorkingCopy`・`Developer.prototype.exportAnalysis`）を確かめてから使う。 */
function readAnalysisGlue(module: unknown): AnalysisGlue | null {
  if (!isRecord(module)) return null;
  const { default: init, version, Developer } = module;
  if (typeof init !== "function" || typeof version !== "function" || typeof Developer !== "function") return null;
  const openWorkingCopy: unknown = Reflect.get(Developer, "openWorkingCopy");
  const prototype: unknown = Reflect.get(Developer, "prototype");
  if (typeof openWorkingCopy !== "function" || !isRecord(prototype) || typeof Reflect.get(prototype, "exportAnalysis") !== "function") {
    return null;
  }
  return {
    init: init as AnalysisGlue["init"],
    version: version as AnalysisGlue["version"],
    openWorkingCopy: openWorkingCopy.bind(Developer) as AnalysisGlue["openWorkingCopy"],
  };
}

/** transfer してよい ArrayBuffer にする（一部だけを指している・SharedArrayBuffer ならコピーする）。 */
function ownedBuffer(view: Uint8Array): ArrayBuffer {
  const buffer = view.buffer;
  if (buffer instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === buffer.byteLength) return buffer;
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "develop engine analysis failed";
}

export function createDevelopAnalysisWorkerHandler(
  deps: DevelopAnalysisWorkerDeps,
): (message: DevelopAnalysisHelperRequest) => Promise<void> {
  // 開いた写真（`start` から。失敗したら以後の `analysis` は error）
  let opened: Promise<AnalysisDeveloper> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const open = async (message: Extract<DevelopAnalysisHelperRequest, { type: "start" }>): Promise<AnalysisDeveloper> => {
    const response = await deps.fetch(message.manifestUrl, { cache: "no-cache" });
    if (!response.ok) throw new Error(`develop engine manifest ${response.status}`);
    const manifest = parseDevelopEngineManifest(await response.json(), message.manifestUrl);
    if (!manifest) throw new Error("develop engine manifest is invalid");
    const glue = readAnalysisGlue(await deps.importModule(manifest.jsUrl));
    if (!glue) throw new Error("develop engine glue cannot export analyses");
    await glue.init({ module_or_path: manifest.wasmUrl });
    // 描画の worker と違う版の wasm の解析は取り込まない（画素が同じと言えない）
    const reported = glue.version();
    const version = typeof reported === "string" && reported ? reported : manifest.version;
    if (version !== message.version) throw new Error("develop engine analysis helper is another version");
    return glue.openWorkingCopy(new Uint8Array(message.png), message.metaJson);
  };

  const handle = async (message: DevelopAnalysisHelperRequest): Promise<void> => {
    if (message.type === "start") {
      if (opened) return;
      opened = open(message);
      // 失敗は次の `analysis` で返す
      opened.catch(() => undefined);
      return;
    }
    if (message.type !== "analysis") return;
    const id = message.id;
    try {
      if (!opened) throw new Error("no photo is open");
      const developer = await opened;
      const result = developer.exportAnalysis(message.settingsJson);
      if (result === undefined || result === null) {
        deps.post({ type: "analysis", id, bytes: null });
        return;
      }
      if (!(result instanceof Uint8Array)) throw new Error("develop engine returned no analysis");
      const bytes = ownedBuffer(result);
      deps.post({ type: "analysis", id, bytes }, [bytes]);
    } catch (error) {
      deps.post({ type: "error", id, message: errorMessage(error) });
    }
  };

  return (message) => {
    // 受け取った順に 1 つずつ（前の失敗で後を止めない）
    const next = chain.then(() => handle(message)).catch(() => undefined);
    chain = next;
    return next;
  };
}
