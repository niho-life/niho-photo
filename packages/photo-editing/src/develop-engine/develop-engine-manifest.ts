/**
 * NIHO の現像エンジン（段 2 の wasm。移行時の設計文書「段 2」、移行元設計）の公開物の置き場と manifest。
 *
 * 公開物は `/develop-engine/<engine>/` に置き、manifest の `version` とファイル名に crate 版を含める（S3 PR3 移行元設計）。
 * versioned manifest の `files` が wasm-bindgen の glue（`.js`）・`.wasm`・型定義のファイル名を持つ。この画面が読む crate 版は
 * `DEVELOP_ENGINE_CRATE_VERSION` で決める。`engine` は bundle が読める最新の数式と置き場を表し、
 * 新規 `developSettings.engine` の既定とは独立して進む。保存済みの旧 engine は wasm の互換経路で描く。
 */

/** 公開 bundle が読める最新の数式の版（新規設定の既定とは別）。 */
export const DEVELOP_ENGINE_VERSION = "niho-14";

/** この画面が読む crate の版（manifest の `version` とファイル名）。 */
export const DEVELOP_ENGINE_CRATE_VERSION = "0.26.0";

/** バージョン付きのファイル名や診断表示で使う build ID。 */
export const DEVELOP_ENGINE_BUILD = `${DEVELOP_ENGINE_VERSION}-${DEVELOP_ENGINE_CRATE_VERSION}`;

export type DevelopEngineManifest = {
  engine: string;
  /** 公開物の crate 版（`DEVELOP_ENGINE_CRATE_VERSION` と同じ） */
  version: string;
  wasmUrl: string;
  jsUrl: string;
  threads: { wasmUrl: string; jsUrl: string } | null;
};

/** bundle固有manifestの置き場（旧bundle向けのmanifest.jsonは更新しない）。 */
export function developEngineManifestPath(): string {
  return `/develop-engine/${DEVELOP_ENGINE_VERSION}/manifest-${DEVELOP_ENGINE_CRATE_VERSION}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `files` の中から pattern に合うファイル名をちょうど 1 つ選び、manifest の場所から URL を解決する。
 * 無い・2 つ以上ある・単純なファイル名でない（`/`・`..`・絶対 URL）なら null。
 */
function pickFile(files: Record<string, unknown>, name: string, manifestUrl: string): string | null {
  if (!isRecord(files[name])) return null;
  try {
    return new URL(name, manifestUrl).href;
  } catch {
    return null;
  }
}

/**
 * manifest（`{ engine, version: DEVELOP_ENGINE_CRATE_VERSION, files: { <ファイル名>: { sha256, bytes } }, ... }`）を読む。engine・version がこの画面の読む版と
 * 違う・`files` に `.wasm` と `.js` がちょうど 1 つずつ無ければ null（使えない扱い）。URL は manifest の場所から解決する。
 */
export function parseDevelopEngineManifest(value: unknown, manifestUrl: string): DevelopEngineManifest | null {
  if (!isRecord(value)) return null;
  if (value.engine !== DEVELOP_ENGINE_VERSION || value.version !== DEVELOP_ENGINE_CRATE_VERSION) return null;
  if (!isRecord(value.files)) return null;
  const wasmUrl = pickFile(value.files, `niho_develop_wasm_bg-${DEVELOP_ENGINE_CRATE_VERSION}.wasm`, manifestUrl);
  const jsUrl = pickFile(value.files, `niho_develop_wasm-${DEVELOP_ENGINE_CRATE_VERSION}.js`, manifestUrl);
  if (!wasmUrl || !jsUrl) return null;
  const threadFiles = isRecord(value.threads) && isRecord(value.threads.files) ? value.threads.files : {};
  const threadsWasm = pickFile(threadFiles, `niho_develop_wasm_threads_bg-${DEVELOP_ENGINE_CRATE_VERSION}.wasm`, manifestUrl);
  const threadsJs = pickFile(threadFiles, `niho_develop_wasm_threads-${DEVELOP_ENGINE_CRATE_VERSION}.js`, manifestUrl);
  const threads = threadsWasm && threadsJs ? { wasmUrl: threadsWasm, jsUrl: threadsJs } : null;
  return { engine: DEVELOP_ENGINE_VERSION, version: DEVELOP_ENGINE_CRATE_VERSION, wasmUrl, jsUrl, threads };
}
