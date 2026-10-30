import type { DevelopAnalysisHelper, DevelopAnalysisHelperResponse } from "./develop-engine-analysis-worker-core";
import { parseDevelopEngineManifest } from "./develop-engine-manifest";
import type { DevelopAnalysisStore } from "./develop-engine-analysis-store";
import {
  analysisAheadMemoryBytes,
  analysisHelperMemoryBytes,
  DEVELOP_MEMORY_BUDGET,
  developerMemoryBytes,
  developExportMemoryBytes,
  developRenderLoadFromJson,
  thumbnailSessionMemoryBytes,
  type DevelopMemoryDeviceClass,
} from "./develop-engine-memory-budget";

/**
 * 段 2 の wasm を動かす Web Worker の中身（移行元設計。移行時の設計文書「段 2」）。テストできるよう、
 * fetch・glue の読み込み・postMessage を外から渡す（Worker の殻は `develop-engine.worker.ts`）。
 *
 * - 通常のメッセージは受け取った順に 1 つずつ処理する（前の処理が失敗しても後は止めない）。自動の先読みだけは別枠で待たせ、通常の
 *   要求が来ている間は動かさず、取り消し・昇格を受け付ける
 * - `init` で manifest を読み、glue（wasm-bindgen `--target web`）を読み込んで wasm を起こす。どこかで失敗したら `unavailable`
 *   を返し、以後の要求はすべて `error`（呼び出し側は S1 の canvas に戻る）
 * - `open` は 1 回デコードして持つ（`Developer`）。前の写真は手放す。`render` はそれで描き、`exportJpeg` は持っている写真を
 *   変えずに別の bytes から描く（記事用の画像・書き出し）
 * - 同じ写真の使い回し（#129）: `digest` があれば、開く入力（開き方と bytes の SHA-256）を鍵に、手放した写真（`open` /
 *   `openWorkingCopy` で替えた・`close` した）を開いている写真と合わせて予算の `heldPhotos` 枚まで保つ。同じ鍵をもう一度開くと
 *   デコード・解析・cube・master を作り直さずにそれを使う（面は外し、新しく開いたのと同じく面を持たずに始める）。保つ前に見本用の
 *   session と先に作った別の設定の解析は手放す（メモリ）。新しい写真をデコードする前に古いほうから手放す。保っている間も描いた
 *   画素は同じ（engine の cache は鍵が同じときだけ使う）
 * - 解析を先に作る（#129）: 開いている写真を丁寧に（final）描いたら、その設定と同梱のプリセットを当てた設定で H/S が読む解析
 *   （signed RAW の CNR の元・応答の係数・niho-7 の面）のうちまだ作っていないものを、通常の要求が {@link ANALYSIS_AHEAD_QUIET_MS}
 *   来なかったら 1 件ずつ作る（今の写真の CNR と、違う CNR の 1 つまで）。通常の要求が来たら次の 1 件を始めない。写真を替えると
 *   捨てる。口の無い glue では何もしない。描く画素は同じ
 * - 先回りは補助の worker で作る（#155）: 補助の worker を作れて（`createAnalysisHelper`）、glue に `exportAnalysis` /
 *   `importAnalysis` があれば、signed RAW の作業コピーを開いた入力（PNG とメタデータ）の写しを先回りが残っている間だけ持ち、
 *   最初の 1 件で補助の worker を作って渡す（写しは transfer）。補助の worker は同じ wasm で同じ写真を開いて解析を版付きの bytes に
 *   して返し、この worker は同じ写真のままなら `importAnalysis` で取り込むだけ（コピー。列をふさぐのはその間だけで、補助の worker が
 *   計算している間の描画は待たない）。すでに持っている解析（`holdsAnalysis`）は作らない。補助の worker は先回りが尽きた・写真を
 *   替えた・閉じたら終わらせ（遅れて届いた結果は捨てる）、この worker が終わるとブラウザが一緒に終わらせる。補助の worker が
 *   作れない・失敗した・取り込めなかったら、その写真ではこの worker で `Developer.prepareAnalysis` で作る（#129 の先回り。動き出すと
 *   止められない）。compact bytes は Developer と分けた bounded LRU に残し、Developer eviction 後も同じ写真・解析設定の描画直前に
 *   import する。不一致・壊れた bytes・未対応 glue は捨てて通常の再計算へ戻る
 * - 物理メモリの予算（#155。`develop-engine-memory-budget.ts`）: 持つ物（開いている写真・保つ写真・見本の session・先回りの解析・
 *   JS に置いた解析の bytes・動いている補助の worker）を bytes で見積もり、新しい写真をデコードする前・見本の session を作る前・
 *   保つ写真や解析の bytes を足した後に、上限（`totalBytes - exportReserveBytes`。wasm の高水位が既に上がっていればそこまで）を
 *   超える間だけ、見本の session → 開いている写真の先回りの解析 → 保つ写真（古い順）→ 解析の bytes（古い順）の順に手放す。
 *   開いている写真は手放さない。補助の worker は高水位と合わせて `totalBytes` に収まるときだけ作り、この worker で先回りを作る・
 *   補助の worker の結果を取り込むのは何も手放さずに収まるときだけにする
 * - 書き出しの置き場所（#155）: 書き出し 1 回の見積もりが、wasm の高水位・開いている写真・解析の bytes と合わせて `totalBytes` を
 *   超え、端末の予算が `overflow: "worker"`（PC）なら、使い捨ての worker（`createExportWorker`。`init` の `disposable: true` で
 *   単一スレッドの wasm を起こす）で描いて終わらせる（持つ物は手放さない）。使い捨ての worker が作れない・起きない・失敗したら、
 *   持つ物を全部手放してこの worker で描く。それ以外はこの worker で、収まるまで手放してから描く。どこで描いても画素は同じ
 * - `openWorkingCopy` は作業コピー（16bit PNG とメタデータの JSON。RAW など、移行元設計）を開いて持つ（`open` と同じく前の写真は
 *   手放す。作業コピーは長辺 2560px のまま持ち、描く大きさは `render` で決める）。`exportWorkingCopyJpeg` は持っている写真を
 *   変えずに、別の作業コピーを一時的に開いて丁寧に描き（final）、`OffscreenCanvas` で JPEG にする（sRGB・撮影情報なし）。
 *   `OffscreenCanvas` が無ければ画素（`frame`）を返し、メインスレッドが canvas で JPEG にする
 * - 画素・JPEG の bytes は ArrayBuffer ごと transfer する（wasm の memory を指していればコピーしてから）
 * - `convertEditSettings` は Photo Bench `EditSettings` を crate の版付きの変換で `developSettings` にする（作業コピーの上で直す
 *   写真はその `baseVersion` を渡す。結果は JSON のまま返す）
 * - `presetSettings` は XMP のプリセットを `developSettings`（無ければ neutral）に当てた結果、`builtinPresets` は crate に同梱した
 *   プリセットの一覧を JSON のまま返す（NIHO Desktop の段 2 の写真。移行元設計 S7b）。glue に無ければ error（ほかは使える）
 * - 幾何（切り抜き・回転。F3 移行元設計）の口 `imageSize`・`rasterDecodeSize`・`geometryOutputSize`・`beforeSettings`（crate 0.5.0 から）が
 *   glue に揃っていれば `ready` に `geometry: true` を付ける。無い glue では 3 つの要求は error（ほかは使える）。`imageSize` の bytes は
 *   コピーで受け取る（呼び出し側は同じ bytes をこの後 `open` に渡す）
 * - `withCaptureExif` は書き出しの JPEG に NIHO の EXIF（撮影日時・向き 1・sRGB。位置情報・カメラは付けず、前の EXIF は外す。
 *   F7a 移行元設計 / F7b 移行元設計）を付けた JPEG を返す（crate 0.5.0 から。transfer）。glue に無ければ error（呼び出し側は EXIF 無しで続ける）
 * - 効果（白黒・周辺光量補正・粒子。E1 移行元設計）のある設定は `v: 3` で保存する。`v: 3` を読めない wasm は描画を断る
 *   （`unsupportedVersion`）ので、起こした wasm に `validateSettings` で小さな `v: 3` の設定を確かめさせ、読めるときだけ `ready` に
 *   `effects: true` を付ける（crate の版の比較では、画面と wasm の公開が前後したときに食い違った。移行元設計）
 * - 色ミキサーは `v: 4` の `colorPoints` を読めるときだけ `ready` に `colorPoints: true` を付ける。公開版番号だけで推測せず、
 *   `validateSettings` に実際の最小設定を渡して確かめる
 * - ディテール（シャープ・ノイズ軽減。Issue #32）も同じく、`v: 6` の `detail` を `validateSettings` が通すときだけ `ready` に
 *   `detail: true` を付ける
 * - 遠近（`v: 7` の `geometry.perspective`。niho-photo#46）も同じく、`validateSettings` が小さな `v: 7` の設定を通すときだけ `ready` に
 *   `perspective: true` を付ける（幾何の口が無い wasm には付けない）
 * - 修復（`v: 8` の `heal`。niho-photo#44）も同じく、`validateSettings` が小さな `v: 8` の設定を通すときだけ `ready` に `heal: true` を
 *   付ける（`heal` を知らない wasm が印を黙って落として描かないよう、版の比較でなく実際の設定で確かめる）
 * - レンズ補正（`v: 9` の `lens`。niho-photo#45）も同じく、`validateSettings` が小さな `v: 9` の設定を通すときだけ `ready` に
 *   `lens: true` を付ける
 * - Upright（niho-photo#46 後半）: `estimateUpright` は開いている写真の `Developer.estimateUpright(settingsJson, mode)` の結果の JSON を
 *   そのまま返す（描画と同じ列で順に処理する単発の問い合わせ。`sampleColor` と同じ）。`Developer` に口があり遠近も描けるとき
 *   だけ `ready` に `upright: true` を付け、無い glue・写真を開いていなければ error
 * - プリセットの適用量・書き出し・見本（F2a 移行元設計 の口。crate 0.5.0 から）: `applyPreset`（開いている写真の撮影時の白
 *   `asShotWhite()` を渡す）・`settingsToXmp`・`renderPresetThumbnail`（開いている写真の `thumbnail(256)` の別の session を初回に
 *   作って持ち、丁寧に〔final〕描く。親のengine/CNR設定が変わったら手放し、次回に現在の解析から作り直す。写真を手放すと一緒に手放す）。口が glue にあれば `ready` に `presetAmount` /
 *   `settingsToXmp` / `presetThumbnails` の true を付け、無い glue では要求は error（ほかは使える）
 * - 開いている写真なしのプリセット（一覧の一括。F5a-2 移行元設計）: `applyPreset` に `asShotMetaJson` が付いていれば、開いている
 *   写真の白は見ず、作業コピーのメタ（文字列）から `asShotWhiteFromMeta` で撮影時の白を引く（`null` は撮影時の白なし＝JPEG / PNG）。
 *   付いていなければ今までどおり開いている写真の白。`applyPreset` と `asShotWhiteFromMeta` が glue に揃っていれば `ready` に
 *   `presetFromMeta: true` を付け、無い glue でメタを渡すと error（開いている写真の白で当てて取り違えない）
 * - 自動（F4a 移行元設計 の口）: `autoSettings` は開いている写真の `Developer.autoSettings(settingsJson)` で、今の設定からライト 6 本と
 *   自然な彩度だけを決めた設定の JSON をそのまま返す（通常要求は順に処理し、先読みは低優先度で遅らせて取り消し・昇格できる）。
 *   `Developer` に口があれば `ready` に `auto: true` を付け、無い glue・写真を開いていなければ error（ほかは使える）
 * - 部分補正（マスク。`docs/local-adjustments.md`「版と互換」）: 起こしたときに glue の `capabilities()` を 1 回だけ読み、描ける種類が
 *   あれば `ready` に `masks: { kinds, max, maskPlane }` を付ける（`validateSettings` は M1 の wasm〔読めるが描かない〕でも通るので
 *   使わない。口の無い古い glue・読めない応答は付けない＝描けない）。`maskPlane` は開いている写真の 1 枚のマスクの面（重ね表示用。
 *   `{ width, height, data }`、data は transfer）で、通常の要求と同じ列で順に処理する（描画を取り消さない）
 * - 面（ブラシ・被写体・空のマスク。`docs/local-adjustments.md`「面の受け渡し」。M4 #68）: glue の `capabilities()` が `surfaces` を
 *   返し、`encodeMaskSurface`・`maskSurfaceId`・`Developer.setMaskSurface` / `dropMaskSurface` / `exportJpeg` が揃っているときだけ
 *   `masks.surfaces: true`（揃わない glue は面の種類を描けない扱いにして `kinds` から外す）。`setMaskSurface` は開いている写真の
 *   `Developer` へ面を渡し（形の違う面は `maskSurfaceInvalid`）、渡した PNG を覚えて見本用の session へも渡す（見本の session は
 *   面を持たずに始まる）。`dropMaskSurface` は両方から手放す。写真を手放すと面も手放す。`encodeMaskSurface` は面の値（`width·height`
 *   byte）を 8bit グレーの PNG と id（sha256）にする。`exportJpeg` / `exportWorkingCopyJpeg` に `surfaces` が付いていれば、
 *   一時的な `Developer`（JPEG / PNG は一発の書き出しと同じ作業サイズ）に面を渡して描く（一発の描画は面を持たない）
 */

export type DevelopEngineWorkerRequest =
  | {
      type: "init";
      id: number;
      manifestUrl: string;
      diagnostics?: boolean;
      preferNative?: boolean;
      /** 物理メモリの予算の端末別 profile（#155）。省略は既存互換の PC。 */
      deviceClass?: DevelopEngineDeviceClass;
      /**
       * 大きな書き出しを 1 回だけ描く使い捨ての worker（#155）。`preferNative` を無視して単一スレッドの wasm を起こし、補助の
       * worker・解析の保存先・使い捨ての worker を使わない
       */
      disposable?: boolean;
    }
  | { type: "open"; id: number; bytes: ArrayBuffer; workingMaxDimension: number }
  | { type: "render"; id: number; settingsJson: string; maxDimension: number; interactive: boolean }
  | { type: "sampleColor"; id: number; settingsJson: string; maxDimension: number; x: number; y: number }
  | { type: "maskPlane"; id: number; settingsJson: string; maskId: string; maxDimension: number }
/** Upright の推定（`mode`: 1 自動・2 水平・3 垂直・4 フル） */
  | { type: "estimateUpright"; id: number; settingsJson: string; mode: number }
/** 開いている写真の `Developer` へ面を渡す（`png` は transfer） */
  | { type: "setMaskSurface"; id: number; surfaceId: string; png: ArrayBuffer }
  | { type: "dropMaskSurface"; id: number; surfaceId: string }
  /** 面の値（`width·height` byte）を PNG と id にする（`data` は transfer） */
  | { type: "encodeMaskSurface"; id: number; width: number; height: number; data: ArrayBuffer }  | {
      type: "exportJpeg";
      id: number;
      bytes: ArrayBuffer;
      settingsJson: string;
      maxDimension: number;
      quality: number;
      /** 描かれる面のマスクの面（あれば一時的な `Developer` で描く） */
      surfaces?: DevelopMaskSurfacePng[];
    }
  | { type: "openWorkingCopy"; id: number; png: ArrayBuffer; metaJson: string }
  | {
      type: "exportWorkingCopyJpeg";
      id: number;
      png: ArrayBuffer;
      metaJson: string;
      settingsJson: string;
      maxDimension: number;
      quality: number;
      surfaces?: DevelopMaskSurfacePng[];
    }
  | { type: "close"; id: number }
  | { type: "convertEditSettings"; id: number; editSettingsJson: string; baseVersion?: string | null }
  | { type: "presetSettings"; id: number; xmp: string; baseSettingsJson: string | null }
  | { type: "builtinPresets"; id: number }
  | { type: "imageSize"; id: number; bytes: ArrayBuffer }
  | {
      type: "rasterDecodeSize";
      id: number;
      settingsJson: string;
      width: number;
      height: number;
      maxDimension: number;
      cap: number;
    }
  | {
      type: "geometryOutputSize";
      id: number;
      settingsJson: string;
      sourceWidth: number;
      sourceHeight: number;
      maxDimension: number;
    }
  | {
      type: "applyPreset";
      id: number;
      xmp: string;
      baseSettingsJson: string;
      amount: number;
      /**
       * 撮影時の白の出どころ（F5a-2 移行元設計）。省くと開いている写真の白、文字列は作業コピーのメタの JSON（`asShotWhiteFromMeta`
       * で引く）、null は撮影時の白なし（JPEG / PNG。開いている写真の白も使わない）
       */
      asShotMetaJson?: string | null;
    }
  | { type: "settingsToXmp"; id: number; settingsJson: string; optionsJson: string }
  | { type: "renderPresetThumbnail"; id: number; settingsJson: string; maxDimension: number }
  | { type: "withCaptureExif"; id: number; bytes: ArrayBuffer; capturedAt: string; offsetMinutes: number }
  | { type: "autoSettings"; id: number; settingsJson: string }
  /** pointer/focus の先読み。通常要求が待っていれば後へ回す。 */
  | { type: "warmAutoSettings"; id: number; settingsJson: string }
  | { type: "promoteAutoSettings"; id: number }
  | { type: "cancelAutoSettings"; id: number };

/** glue にある口（`ready` に付ける。無い口は付けない）。 */
export type DevelopEngineWorkerFeatures = {
  /** 幾何の口が揃っている（F3 移行元設計） */
  geometry?: true;
  /** wasm が効果のある設定（`v: 3`）を読める（E1b 移行元設計） */
  effects?: true;
  /** wasm が独立した色ミキサーの設定（`v: 4`）を読める。 */
  colorPoints?: true;
  /** wasm がディテール（シャープ・ノイズ軽減）の設定（`v: 6`）を読める（Issue #32）。 */
  detail?: true;
  /** wasm が遠近のある設定（`v: 7`。niho-photo#46）を読める。 */
  perspective?: true;
  /** `Developer.estimateUpright`（Upright。niho-photo#46 後半）があり、遠近も描ける */
  upright?: true;
  /** wasm が修復の印のある設定（`v: 8` の `heal`。niho-photo#44）を読める。 */
  heal?: true;
  /** wasm がレンズ補正のある設定（`v: 9` の `lens`。niho-photo#45）を読める。 */
  lens?: true;
  /** `applyPreset`（プリセットの適用量。F2a 移行元設計） */
  presetAmount?: true;
  /** `settingsToXmp`（今の補正をプリセットに書き出す） */
  settingsToXmp?: true;
  /** `Developer.thumbnail`（プリセットの見本の別の session） */
  presetThumbnails?: true;
  /** `Developer.autoSettings`（「自動」。F4a 移行元設計） */
  auto?: true;
  /** `applyPreset` と `asShotWhiteFromMeta`（開いている写真なしでプリセットを当てる。一覧の一括。F5a-2 移行元設計） */
  presetFromMeta?: true;
  /** 部分補正（マスク）を描ける種類と枚数（glue の `capabilities()`。無い・描けない glue では付けない） */
  masks?: DevelopMaskCapabilities;
};

/** wasm が描ける部分補正（`capabilities().masks`）。 */
export type DevelopMaskCapabilities = {
  /** 描ける種類（M2 は `linear` `radial`、M4 は `brush` `subject` `sky` も） */
  kinds: string[];
  /** 最大の枚数 */
  max: number;
  /** `Developer.maskPlane`（重ね表示の面）がある */
  maskPlane: boolean;
  /** 面（ブラシ・被写体・空）を受け渡せる（`setMaskSurface` など。M4。省略 = 受け渡せない） */
  surfaces?: boolean;
};

/** 書き出しに添える 1 枚の面（id と PNG）。 */
export type DevelopMaskSurfacePng = { id: string; png: ArrayBuffer };

export type DevelopEngineWorkerResponse =
  | { type: "perf"; id: 0; record: DevelopEnginePerfRecord }
  | ({ type: "ready"; id: number; version: string; runtime: DevelopEngineRuntime; wasmThreads?: number } & DevelopEngineWorkerFeatures)
  | { type: "unavailable"; id: number; reason: string }
  | { type: "opened"; id: number; width: number; height: number }
  | { type: "frame"; id: number; width: number; height: number; rgba: ArrayBuffer }
  /** `exportJpeg`・`exportWorkingCopyJpeg`・`withCaptureExif` の JPEG */
  | { type: "jpeg"; id: number; bytes: ArrayBuffer }
  | { type: "closed"; id: number }
  | { type: "converted"; id: number; resultJson: string }
  | { type: "preset"; id: number; resultJson: string }
  | { type: "builtinPresets"; id: number; presetsJson: string }
  /** `imageSize`（向きを反映した元の寸法）・`geometryOutputSize`（描かずに出力の寸法） */
  | { type: "size"; id: number; width: number; height: number }
  /** `rasterDecodeSize`（切り抜きが要求の大きさに届く作業サイズ＝`open` の長辺） */
  | { type: "decodeSize"; id: number; size: number }
  /** `settingsToXmp` の結果（`{ xmp, notWritten }` の JSON のまま） */
  | { type: "xmp"; id: number; resultJson: string }
  /** `autoSettings` の結果（完成した設定の JSON のまま） */
  | { type: "auto"; id: number; settingsJson: string }
  | { type: "sampledColor"; id: number; lightness: number; chroma: number; hue: number }
  /** `maskPlane` の面（`width·height` byte。行優先・`invert` 込み） */
  | { type: "maskPlane"; id: number; width: number; height: number; data: ArrayBuffer }
/** `estimateUpright` の結果（JSON のまま） */
  | { type: "upright"; id: number; resultJson: string }
| { type: "maskSurfaceSet"; id: number }
  | { type: "maskSurfaceDropped"; id: number; dropped: boolean }
  /** `encodeMaskSurface` の PNG と id（sha256） */
  | { type: "maskSurfaceEncoded"; id: number; surfaceId: string; png: ArrayBuffer }  | { type: "error"; id: number; message: string };

export type DevelopEngineWorkerDeps = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  importModule: (url: string) => Promise<unknown>;
  post: (message: DevelopEngineWorkerResponse, transfer?: Transferable[]) => void;
  /** camera が明示したときだけ試す native glue。作れない・初期化できない場合は同じ Worker で wasm へ戻る。 */
  createNativeGlue?: () => unknown;
  /** native の通信・handle 失効を表す error の判定（core を transport 実装から分離し、偽 glue で試験できるようにする）。 */
  isNativeUnavailableError?: (error: unknown) => boolean;
  /** Worker の実行環境。分離とブラウザを確認した場合だけスレッド版を試す。 */
  threadsEnvironment?: () => { isolated: boolean; hardwareConcurrency: number; userAgent: string };
  /** オプトイン診断だけで使う時計と、安全な定型フィールドだけを受け取るログ口。 */
  now?: () => number;
  logPerf?: (record: DevelopEnginePerfRecord) => void;
  /**
   * 描いた画素（sRGB 8bit RGBA）を JPEG にする（`quality` は 1〜100）。Worker の中で JPEG にできない（`OffscreenCanvas` が無い）
   * なら null（画素を返してメインスレッドで JPEG にする）
   */
  encodeJpeg?: (width: number, height: number, rgba: ArrayBuffer, quality: number) => Promise<ArrayBuffer | null>;
  /**
   * 開く入力の bytes の SHA-256（小文字の 16 進）。同じ写真を開き直したときに、保っている `Developer` を使い回す鍵にする（#129）。
   * 省略・null は写真を保たない（今までどおり手放す）
   */
  digest?: (bytes: ArrayBuffer) => Promise<string | null>;
  /** 再起動をまたいで compact 解析 bytes を保つ。失敗時は通常の再計算に戻す（#155）。 */
  analysisStore?: DevelopAnalysisStore;
  /** Mac native で WebKit storage が初期化されても残る作業コピー cache。 */
  nativeAnalysisStore?: DevelopAnalysisStore;
  /**
   * 先回りの解析を作る補助の worker を作る（#155）。応答を `receive` に渡し、読み込めない・落ちたら null を渡す。省略（worker の中で
   * `Worker` が使えない）・null を返したら、今までどおりこの worker で作る
   */
  createAnalysisHelper?: (receive: (response: DevelopAnalysisHelperResponse | null) => void) => DevelopAnalysisHelper | null;
  /**
   * 予算に収まらない書き出しを描く使い捨ての worker を作る（#155。同じ Worker の中身を `disposable: true` で起こす）。応答を
   * `receive` に渡し、読み込めない・落ちたら null を渡す。省略・null を返したら、持つ物を手放して同じ Worker で描く
   */
  createExportWorker?: (receive: (response: DevelopEngineWorkerResponse | null) => void) => DevelopEngineExportWorker | null;
};

/** 使い捨ての書き出しの worker（#155。1 回描いたら terminate する）。 */
export type DevelopEngineExportWorker = {
  post: (message: DevelopEngineWorkerRequest, transfer: Transferable[]) => void;
  terminate: () => void;
};

export type DevelopEngineRuntime = "native" | "wasm" | "wasm-threads";

/** Worker が物理メモリの予算を選ぶ端末 class（#155）。client が明示して init に渡す。 */
export type DevelopEngineDeviceClass = DevelopMemoryDeviceClass;

export type DevelopEnginePerfRecord = {
  stage:
    | "manifestFetch"
    | "glueImport"
    | "wasmInit"
    | "open"
    | "openWorkingCopy"
    | "renderFinal"
    | "renderInteractive"
    | "presetThumbnail"
    /** 見本用の別の session を作った（初回と、親の engine / CNR 設定が変わった後。`presetThumbnail` の中の内訳） */
    | "thumbnailSession"
    | "presetSettings"
    | "autoSettings"
    | "prepareAnalysis"
    /** 補助の worker が作った解析を取り込んだ（#155） */
    | "importAnalysis"
    /** 使い捨ての worker で書き出した（起こしてから結果が届くまでの往復。#155） */
    | "exportWorker";
  durationMs: number;
  wasmMemoryBytes: number | null;
  status: "ok" | "error";
};

/** glue の `Developer`（wasm-bindgen のクラス。使い終わったら `free`）。 */
type DevelopDeveloper = {
  render: (settingsJson: string, maxDimension: number, interactive: boolean) => unknown;
  sampleColor?: (settingsJson: string, maxDimension: number, x: number, y: number) => unknown;
  free: () => void;
  readonly width: number;
  readonly height: number;
  /** 見本用の別の session（crate 0.5.0 から。無い glue もある） */
  thumbnail?: (maxDimension: number) => DevelopDeveloper;
  /** 撮影時の白の `{ temperature, tint }` の JSON（JPEG / PNG は `"null"`。無い glue もある） */
  asShotWhite?: () => unknown;
  /** 「自動」: 今の設定の JSON から、ライト 6 本と自然な彩度だけを変えた設定の JSON（無い glue もある） */
  autoSettings?: (settingsJson: string) => unknown;
  /** 1 枚のマスクの面 `{ width, height, data }`（M2 の glue から。無い glue もある） */
  maskPlane?: (settingsJson: string, maskId: string, maxDimension: number) => unknown;
  /** Upright: 今の設定の枠で推定した遠近の JSON（crate 0.23.0 から。無い glue もある） */
  estimateUpright?: (settingsJson: string, mode: number) => unknown;
  /** H/S の解析だけを先に作る（描かない。画素は同じ。#129 の glue から。無い glue もある） */
  prepareAnalysis?: (settingsJson: string) => unknown;
  /** 先に作った別の設定の解析を手放す（保つ写真のメモリを減らす。画素は同じ。#129 の glue から） */
  releaseAnalysisAhead?: () => unknown;
  /** 補助の worker が作った解析の bytes を取り込む（コピー。画素は同じ。#155 の glue から。別の写真・壊れた bytes は throw） */
  importAnalysis?: (bytes: Uint8Array) => unknown;
  /** 保持中の解析を compact bytes にする（#155。無い glue では解析 bytes cache を使わない） */
  exportAnalysis?: (settingsJson: string) => unknown;
  /** その設定の解析をもう全部持っている（先回りで作っても見つけるだけ。#155 の glue から） */
  holdsAnalysis?: (settingsJson: string) => unknown;
/** 面の受け渡し（M4 の glue から。無い glue もある） */
  setMaskSurface?: (surfaceId: string, png: Uint8Array) => unknown;
  dropMaskSurface?: (surfaceId: string) => unknown;
  /** その Developer の面と層で描いた final の JPEG（M4 の glue から） */
  exportJpeg?: (settingsJson: string, maxDimension: number, quality: number) => unknown;};

/** 一発の書き出しが JPEG / PNG の原本を読む作業サイズの上限（crate の `DEFAULT_DECODE_CAP`）。 */
const ONE_SHOT_DECODE_CAP = 4096;

/** 見本用の session の長辺（見本 1 枚は、これを行の大きさに縮めて描く）。 */
const PRESET_THUMBNAIL_SESSION_MAX_DIMENSION = 256;

/**
 * 作業コピーの PNG から大きさを読めないときの見積もりの長辺（作業コピーは長辺 2560px で作る。#155 の見積もりを多めに倒す）。
 */
const WORKING_COPY_FALLBACK_DIMENSION = 2560;

/** 使い捨ての書き出しの worker が `ready` を返すまで待つ時間（Client 全体の初期化期限と同じ。#155）。 */
const EXPORT_WORKER_READY_TIMEOUT_MS = 20_000;

/**
 * Developer と分けて持つ compact 解析 bytes の上限。1 件が 16 MiB を超えたら保持せず、4 件・32 MiB のどちらかを超えたら
 * 最終利用が古い順に捨てる。750x750 の係数 5 面 + FX30 の 2 面（15,750,000 bytes）と形式の header が収まる。
 * 旧 v2 の full CNR source は通常ここで拒否される。
 */
const ANALYSIS_BYTES_ENTRY_LIMIT = 16 * 1024 * 1024;
const ANALYSIS_BYTES_TOTAL_LIMIT = 32 * 1024 * 1024;
const ANALYSIS_BYTES_COUNT_LIMIT = 4;

/** wasm-bindgen / native が明示した allocation failure だけを 1 回再試行する。一般の RangeError や decode error は含めない。 */
function isDevelopAllocationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "OutOfMemoryError" ||
    /(?:out of memory|memory allocation(?: of \d+ bytes)? failed|failed to allocate|allocation failed|array buffer allocation failed|WebAssembly\.Memory(?:\.prototype)?\.grow)/i.test(
      error.message,
    )
  );
}

/**
 * 解析を先に作る（#129）のは、通常の要求が来なくなってからこれだけたってから。この worker で作る 1 回は途中で止められない
 * （signed RAW 2560px で Studio の wasm 1.4〜2.4 秒）ので、操作の続いている間は始めない。補助の worker で作るとき（#155）も、
 * 操作の間は CPU とメモリを描画に回すため同じく待つ。
 */
const ANALYSIS_AHEAD_QUIET_MS = 500;

/**
 * 開いていないが手放さずに持っている写真（同じ入力をもう一度開いたら、デコード・解析・master を作り直さずに使う）。見本用の
 * session と、先に作った別の設定の解析は手放してから保つ（メモリ。使い回すときに作り直す）。
 */
type KeptPhoto = {
  /** 開き方と入力の bytes の鍵（{@link DevelopEngineWorkerDeps.digest}） */
  key: string;
  developer: DevelopDeveloper;
  analysisKey: string | null;
  analysisSettingsJson: string | null;
};

type CachedAnalysis = {
  bytes: ArrayBuffer;
};

/** native が途中で使えなくなったとき、同じ写真を wasm で開き直すために保つ入力。 */
type CurrentOpenInput =
  | { kind: "raster"; bytes: ArrayBuffer; workingMaxDimension: number }
  | { kind: "workingCopy"; png: ArrayBuffer; metaJson: string };

/**
 * 動いている補助の worker（#155。開いている写真に 1 つ）と、結果を待っている 1 件（取り込みが終わるまで）、作ったときの見積もり
 * （写真の寸法の {@link analysisHelperMemoryBytes}）。
 */
type AnalysisHelperState = {
  developer: DevelopDeveloper;
  helper: DevelopAnalysisHelper | null;
  waiting: { id: number; key: string | null } | null;
  memoryBytes: number;
};

/** 書き出しの要求（#155 の置き場所を決める）。 */
type DevelopExportRequest = Extract<DevelopEngineWorkerRequest, { type: "exportJpeg" | "exportWorkingCopyJpeg" }>;

/** 書き出しの結果（使い捨ての worker から受け取り、元の id に替えて送る）。 */
type DevelopExportResult =
  | { type: "jpeg"; bytes: ArrayBuffer }
  | { type: "frame"; width: number; height: number; rgba: ArrayBuffer };

/** 作業コピーのメタデータが signed RAW か（H/S の解析を先に作れるのはこれだけ。#155 の補助の worker はこのときだけ使う）。 */
function isSignedRawWorkingCopy(metaJson: string): boolean {
  try {
    const meta: unknown = JSON.parse(metaJson);
    return isRecord(meta) && meta.kind === "raw" && isRecord(meta.encoding) && meta.encoding.kind === "signed-gamma18-v1";
  } catch {
    return false;
  }
}

/** 型ガードで確かめた glue（`import init, * as dev from "<js>"`）。 */
type DevelopGlue = {
  init: (options: { module_or_path: string }) => Promise<unknown>;
  version: () => unknown;
  exportJpeg: (input: Uint8Array, settingsJson: string, maxDimension: number, quality: number) => unknown;
  convertEditSettings: (editSettingsJson: string, baseVersion?: string) => unknown;
  Developer: new (input: Uint8Array, workingMaxDimension: number) => DevelopDeveloper;
  /** `Developer.openWorkingCopy(png, metaJson)`（無い glue では作業コピーを開けない） */
  openWorkingCopy: ((png: Uint8Array, metaJson: string) => DevelopDeveloper) | null;
  /** `presetSettings(xmp, baseJson)`（無い glue ではプリセットを当てられない） */
  presetSettings: ((xmp: string, baseJson?: string | null) => unknown) | null;
  /** `builtinPresets()`（無い glue では同梱のプリセットを返せない） */
  builtinPresets: (() => unknown) | null;
  /** 幾何の口（crate 0.5.0 から。4 つ揃っていなければ null＝幾何のある写真の作業サイズ・出力の寸法を決められない） */
  geometry: DevelopGeometryGlue | null;
  /**
   * `withCaptureExif(jpeg, capturedAt, offsetMinutes)`（crate 0.5.0 から。無い glue では書き出しに EXIF を付けられない）。
   * `capturedAt` は ISO 8601（UTC）、`offsetMinutes` は表示する時差（日本は 540）
   */
  withCaptureExif: ((jpeg: Uint8Array, capturedAt: string, offsetMinutes: number) => unknown) | null;
  /**
   * `validateSettings(settingsJson)`: 設定の問題の一覧（JSON の配列。空なら読める）。効果を描けるかの確かめに使う
   * （無い glue では効果を出さない）
   */
  validateSettings: ((settingsJson: string) => unknown) | null;
  /** `applyPreset(xmp, baseJson, amount, asShotJson?)`（無い glue では適用量を変えられない） */
  applyPreset: ((xmp: string, baseJson: string, amount: number, asShotJson?: string) => unknown) | null;
  /**
   * `asShotWhiteFromMeta(metaJson)`: 作業コピーのメタの撮影時の白（`{ temperature, tint }` の JSON。無ければ `"null"`）。無い glue
   * では、開いている写真なしで RAW にプリセットを当てられない
   */
  asShotWhiteFromMeta: ((metaJson: string) => unknown) | null;
  /** `settingsToXmp(settingsJson, optionsJson?)`（無い glue では今の補正をプリセットにできない） */
  settingsToXmp: ((settingsJson: string, optionsJson?: string) => unknown) | null;
  /** `Developer.prototype.thumbnail` がある（無い glue では見本を描けない） */
  presetThumbnails: boolean;
  /** `Developer.prototype.autoSettings` がある（無い glue では「自動」を使えない） */
  auto: boolean;
  /** `Developer.prototype.sampleColor` がある。 */
  colorSampling: boolean;
  /** `capabilities()`（描ける部分補正の JSON。無い古い glue はマスクを描けない） */
  capabilities: (() => unknown) | null;
  /** `Developer.prototype.maskPlane` がある */
  maskPlane: boolean;
  /** `Developer.prototype.estimateUpright` がある（無い glue では Upright のボタンを出さない） */
  upright: boolean;
/** `encodeMaskSurface(width, height, data)`（面の PNG。無い glue では面を作れない） */
  encodeMaskSurface: ((width: number, height: number, data: Uint8Array) => unknown) | null;
  /** `maskSurfaceId(png)`（面の id = sha256） */
  maskSurfaceId: ((png: Uint8Array) => unknown) | null;
  /** `Developer.prototype` の `setMaskSurface`・`dropMaskSurface`・`exportJpeg` が揃っている */
  surfaces: boolean;
  /** `Developer.prototype` の `exportAnalysis`・`importAnalysis` が揃っている（先回りを補助の worker で作れる。#155） */
  analysisTransfer: boolean;};

/** 幾何（切り抜き・回転。F3 移行元設計）の口。 */
type DevelopGeometryGlue = {
  /** `imageSize(bytes)`: EXIF の向きを反映した `{ width, height }`（ヘッダーだけ読む） */
  imageSize: (input: Uint8Array) => unknown;
  /** `rasterDecodeSize(settingsJson, width, height, maxDimension, cap)`: `Developer` を開く長辺 */
  rasterDecodeSize: (settingsJson: string, width: number, height: number, maxDimension: number, cap: number) => unknown;
  /** `geometryOutputSize(settingsJson, sourceWidth, sourceHeight, maxDimension)`: 描かずに出力の `{ width, height }` */
  geometryOutputSize: (settingsJson: string, sourceWidth: number, sourceHeight: number, maxDimension: number) => unknown;
  /** `beforeSettings(settingsJson)`: 「補正前」（色だけ neutral・幾何は保つ）。画面は同じ規則を自前で持つので、揃っているかだけを見る */
  beforeSettings: (settingsJson: string) => unknown;
};

type RenderedFrame = { width: number; height: number; rgba: Uint8ClampedArray };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** glue の形（default が関数・render / exportJpeg / Developer / version がある）を確かめてから使う。 */
function readGlue(module: unknown): DevelopGlue | null {
  if (!isRecord(module)) return null;
  const init = module.default;
  const version = module.version;
  const render = module.render;
  const exportJpeg = module.exportJpeg;
  const convertEditSettings = module.convertEditSettings;
  const Developer = module.Developer;
  if (
    typeof init !== "function" ||
    typeof version !== "function" ||
    typeof render !== "function" ||
    typeof exportJpeg !== "function" ||
    typeof convertEditSettings !== "function" ||
    typeof Developer !== "function"
  ) {
    return null;
  }
  // 作業コピーを開く静的メソッド（無い glue でも、オリジナルから描く分は使う）
  const openWorkingCopy: unknown = Reflect.get(Developer, "openWorkingCopy");
  // プリセット（無い glue でも、描く分は使う）
  const presetSettings = module.presetSettings;
  const builtinPresets = module.builtinPresets;
  // 幾何の口（無い glue でも、幾何の無い写真は描ける）
  const { imageSize, rasterDecodeSize, geometryOutputSize, beforeSettings } = module;
  // 書き出しの EXIF（無い glue でも、EXIF 無しで書き出せる）
  const withCaptureExif = module.withCaptureExif;
  // 設定の検査（無い glue でも描ける。効果を出さないだけ）
  const validateSettings = module.validateSettings;
  // プリセットの適用量・書き出し・見本の口（無い glue でも、100% で当てる分は使う）
  const { applyPreset, settingsToXmp, asShotWhiteFromMeta } = module;
  const developerPrototype: unknown = Reflect.get(Developer, "prototype");
  const thumbnail: unknown = isRecord(developerPrototype) ? Reflect.get(developerPrototype, "thumbnail") : undefined;
  // 「自動」の口（無い glue でも、手で直す分は使う）
  const autoSettings: unknown = isRecord(developerPrototype) ? Reflect.get(developerPrototype, "autoSettings") : undefined;
  const sampleColor: unknown = isRecord(developerPrototype) ? Reflect.get(developerPrototype, "sampleColor") : undefined;
  // 部分補正の口（無い glue でも、マスクの無い写真は描ける）
  const capabilities = module.capabilities;
  const maskPlane: unknown = isRecord(developerPrototype) ? Reflect.get(developerPrototype, "maskPlane") : undefined;
const estimateUpright: unknown = isRecord(developerPrototype)
    ? Reflect.get(developerPrototype, "estimateUpright")
    : undefined;
// 面の受け渡しの口（無い glue でも、線形・円形は描ける）
  const { encodeMaskSurface, maskSurfaceId } = module;
  const surfaceMethods = ["setMaskSurface", "dropMaskSurface", "exportJpeg"].every(
    (name) => isRecord(developerPrototype) && typeof Reflect.get(developerPrototype, name) === "function",
  );
  // 解析の受け渡しの口（無い glue では、先回りをこの worker で作る）
  const analysisTransfer = ["exportAnalysis", "importAnalysis"].every(
    (name) => isRecord(developerPrototype) && typeof Reflect.get(developerPrototype, name) === "function",
  );  const geometry: DevelopGeometryGlue | null =
    typeof imageSize === "function" &&
    typeof rasterDecodeSize === "function" &&
    typeof geometryOutputSize === "function" &&
    typeof beforeSettings === "function"
      ? {
          imageSize: imageSize as DevelopGeometryGlue["imageSize"],
          rasterDecodeSize: rasterDecodeSize as DevelopGeometryGlue["rasterDecodeSize"],
          geometryOutputSize: geometryOutputSize as DevelopGeometryGlue["geometryOutputSize"],
          beforeSettings: beforeSettings as DevelopGeometryGlue["beforeSettings"],
        }
      : null;
  return {
    init: init as DevelopGlue["init"],
    version: version as DevelopGlue["version"],
    exportJpeg: exportJpeg as DevelopGlue["exportJpeg"],
    convertEditSettings: convertEditSettings as DevelopGlue["convertEditSettings"],
    Developer: Developer as DevelopGlue["Developer"],
    openWorkingCopy:
      typeof openWorkingCopy === "function" ? (openWorkingCopy.bind(Developer) as DevelopGlue["openWorkingCopy"]) : null,
    presetSettings: typeof presetSettings === "function" ? (presetSettings as DevelopGlue["presetSettings"]) : null,
    builtinPresets: typeof builtinPresets === "function" ? (builtinPresets as DevelopGlue["builtinPresets"]) : null,
    geometry,
    withCaptureExif: typeof withCaptureExif === "function" ? (withCaptureExif as DevelopGlue["withCaptureExif"]) : null,
    validateSettings: typeof validateSettings === "function" ? (validateSettings as DevelopGlue["validateSettings"]) : null,
    applyPreset: typeof applyPreset === "function" ? (applyPreset as DevelopGlue["applyPreset"]) : null,
    asShotWhiteFromMeta:
      typeof asShotWhiteFromMeta === "function" ? (asShotWhiteFromMeta as DevelopGlue["asShotWhiteFromMeta"]) : null,
    settingsToXmp: typeof settingsToXmp === "function" ? (settingsToXmp as DevelopGlue["settingsToXmp"]) : null,
    presetThumbnails: typeof thumbnail === "function",
    auto: typeof autoSettings === "function",
    colorSampling: typeof sampleColor === "function",
    capabilities: typeof capabilities === "function" ? (capabilities as () => unknown) : null,
    maskPlane: typeof maskPlane === "function",
    upright: typeof estimateUpright === "function",
encodeMaskSurface: typeof encodeMaskSurface === "function" ? (encodeMaskSurface as DevelopGlue["encodeMaskSurface"]) : null,
    maskSurfaceId: typeof maskSurfaceId === "function" ? (maskSurfaceId as DevelopGlue["maskSurfaceId"]) : null,
    surfaces: surfaceMethods,
    analysisTransfer,  };
}

/** 面（ブラシ・被写体・空）の種類。面の口の揃わない glue では描けない扱いにする。 */
const SURFACE_MASK_KINDS = ["brush", "subject", "sky"];

/** crate の `MAX_LOCAL_MASKS`（契約の上限。glue がこれより大きい値を返しても上限で止める）。 */
const MAX_MASKS_CONTRACT = 8;

/**
 * glue の `capabilities()` から描ける部分補正を読む（1 回だけ。口が無い・throw・JSON でない・種類が無い・形が違うなら null＝描けない）。
 * 知らない種類は落とし、`max` は 1〜8 の整数だけを受ける。
 */
function readMaskCapabilities(glue: DevelopGlue): DevelopMaskCapabilities | null {
  if (!glue.capabilities) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(glue.capabilities()));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.masks)) return null;
  const { kinds, max, maskPlane, surfaces } = parsed.masks;
  if (!Array.isArray(kinds) || !isPositiveInteger(max)) return null;
  const known = ["linear", "radial", "brush", "subject", "sky"];
  // 面の受け渡しは、応答と glue の口（作る・id・Developer の受け渡しと書き出し）が揃っているときだけ
  const surfacesReady = surfaces === true && glue.surfaces && glue.encodeMaskSurface !== null && glue.maskSurfaceId !== null;
  const readKinds = [
    ...new Set(
      kinds.filter(
        (kind): kind is string =>
          typeof kind === "string" && known.includes(kind) && (surfacesReady || !SURFACE_MASK_KINDS.includes(kind)),
      ),
    ),
  ];
  if (readKinds.length === 0) return null;
  return {
    kinds: readKinds,
    max: Math.min(max, MAX_MASKS_CONTRACT),
    // 面の口は、応答と Developer の両方にあるときだけ
    maskPlane: maskPlane === true && glue.maskPlane,
    ...(surfacesReady ? { surfaces: true } : {}),
  };
}

/** wasm が効果のある設定を読めるかを確かめる、効果が 1 つだけ効いている小さな設定（crate の `EFFECTS_SETTINGS_VERSION` = 3）。 */
const EFFECTS_PROBE_SETTINGS_JSON = JSON.stringify({
  v: 3,
  engine: "niho-1",
  look: "niho-interim-1",
  base: null,
  vignette: { amount: -1 },
});

/** 古い wasm・壊れた応答・throw は false（効果の項目を出さない）。 */
function acceptsEffectSettings(validateSettings: DevelopGlue["validateSettings"]): boolean {
  if (!validateSettings) return false;
  try {
    const issues: unknown = JSON.parse(String(validateSettings(EFFECTS_PROBE_SETTINGS_JSON)));
    return Array.isArray(issues) && issues.length === 0;
  } catch {
    return false;
  }
}

const COLOR_POINTS_PROBE_SETTINGS_JSON = JSON.stringify({
  v: 4,
  engine: "niho-10",
  look: "niho-standard-1",
  base: null,
  colorPoints: [{
    id: "probe",
    target: { lightness: 0.7, chroma: 0.1, hue: 50 },
    range: { hue: 20, chroma: 0.05, lightness: 0.1 },
    delta: { hue: 1, chromaScale: 1, lightness: 0 },
  }],
});

function acceptsColorPointSettings(validateSettings: DevelopGlue["validateSettings"]): boolean {
  if (!validateSettings) return false;
  try {
    const issues: unknown = JSON.parse(String(validateSettings(COLOR_POINTS_PROBE_SETTINGS_JSON)));
    return Array.isArray(issues) && issues.length === 0;
  } catch {
    return false;
  }
}

/** ディテールが 1 つだけ効いている小さな `v: 6` の設定（crate の `DETAIL_SETTINGS_VERSION` = 6）。 */
const DETAIL_PROBE_SETTINGS_JSON = JSON.stringify({
  v: 6,
  engine: "niho-10",
  look: "niho-standard-1",
  base: null,
  detail: { sharpening: { amount: 10, radius: 1, detail: 25, masking: 0 }, luminanceNoiseReduction: 0 },
});

/** 古い wasm・壊れた応答・throw は false（ディテールの項目を出さない）。 */
function acceptsDetailSettings(validateSettings: DevelopGlue["validateSettings"]): boolean {
  if (!validateSettings) return false;
  try {
    const issues: unknown = JSON.parse(String(validateSettings(DETAIL_PROBE_SETTINGS_JSON)));
    return Array.isArray(issues) && issues.length === 0;
  } catch {
    return false;
  }
}
const PERSPECTIVE_PROBE_SETTINGS_JSON = JSON.stringify({
  v: 7,
  engine: "niho-10",
  look: "niho-standard-1",
  base: null,
  geometry: { perspective: { vertical: -10 }, constrain: true },
});

function acceptsPerspectiveSettings(validateSettings: DevelopGlue["validateSettings"]): boolean {
  if (!validateSettings) return false;
  try {
    const issues: unknown = JSON.parse(String(validateSettings(PERSPECTIVE_PROBE_SETTINGS_JSON)));
    return Array.isArray(issues) && issues.length === 0;
  } catch {
    return false;
  }
}

/** 修復の印が 1 つある小さな設定（crate の `HEAL_SETTINGS_VERSION` = 8）。 */
const HEAL_PROBE_SETTINGS_JSON = JSON.stringify({
  v: 8,
  engine: "niho-10",
  look: "niho-standard-1",
  base: null,
  heal: [{ id: "probe", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.5, 0.5]] }],
});

function acceptsHealSettings(validateSettings: DevelopGlue["validateSettings"]): boolean {
  if (!validateSettings) return false;
  try {
    const issues: unknown = JSON.parse(String(validateSettings(HEAL_PROBE_SETTINGS_JSON)));
    return Array.isArray(issues) && issues.length === 0;
  } catch {
    return false;
  }
}

/** レンズ補正のある小さな設定（crate の `LENS_SETTINGS_VERSION` = 9）。 */
const LENS_PROBE_SETTINGS_JSON = JSON.stringify({
  v: 9,
  engine: "niho-10",
  look: "niho-standard-1",
  base: null,
  lens: { distortion: 10, removeChromaticAberration: true, defringe: { purple: { amount: 20 } } },
});

function acceptsLensSettings(validateSettings: DevelopGlue["validateSettings"]): boolean {
  if (!validateSettings) return false;
  try {
    const issues: unknown = JSON.parse(String(validateSettings(LENS_PROBE_SETTINGS_JSON)));
    return Array.isArray(issues) && issues.length === 0;
  } catch {
    return false;
  }
}

/** glue にある口（`ready` に付ける）。 */
function glueFeatures(glue: DevelopGlue): DevelopEngineWorkerFeatures {
  return {
    ...(glue.geometry ? { geometry: true as const } : {}),
    ...(glue.applyPreset ? { presetAmount: true as const } : {}),
    ...(glue.settingsToXmp ? { settingsToXmp: true as const } : {}),
    ...(glue.presetThumbnails ? { presetThumbnails: true as const } : {}),
    ...(glue.auto ? { auto: true as const } : {}),
    ...(glue.applyPreset && glue.asShotWhiteFromMeta ? { presetFromMeta: true as const } : {}),
  };
}

/** 開いている写真の撮影時の白（`applyPreset` の第 4 引数）。読めなければ undefined（crate は撮影時の白なしで当てる）。 */
function readAsShotWhite(developer: DevelopDeveloper | null): string | undefined {
  if (!developer || typeof developer.asShotWhite !== "function") return undefined;
  try {
    const white = developer.asShotWhite();
    return typeof white === "string" ? white : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 開いている写真なしで当てるときの撮影時の白（`applyPreset` の第 4 引数。F5a-2 移行元設計）。`null` は撮影時の白なし（JPEG / PNG）、
 * 文字列は作業コピーのメタの JSON から引く。glue に口が無い・読めないメタは error（開いている写真の白で当てない）。
 */
function readAsShotWhiteFromMeta(glue: DevelopGlue, metaJson: string | null): string | undefined {
  if (metaJson === null) return undefined;
  const read = glue.asShotWhiteFromMeta;
  if (!read) throw new Error("develop engine cannot read the as-shot white");
  const white = read(metaJson);
  if (typeof white !== "string") throw new Error("develop engine returned no as-shot white");
  return white;
}

/**
 * 同梱のプリセットを `settingsJson` に 100% で当てた設定の JSON（#129 の解析を先に作る候補。口の無い glue・当てられない・読めない
 * 結果は除く）。
 */
function presetVariants(glue: DevelopGlue, developer: DevelopDeveloper, settingsJson: string): string[] {
  if (!glue.builtinPresets || !glue.applyPreset) return [];
  try {
    const presets: unknown = JSON.parse(String(glue.builtinPresets()));
    if (!Array.isArray(presets)) return [];
    const asShot = readAsShotWhite(developer);
    const variants: string[] = [];
    for (const preset of presets) {
      if (!isRecord(preset) || typeof preset.xmp !== "string") continue;
      const applied: unknown = JSON.parse(String(glue.applyPreset(preset.xmp, settingsJson, 1, asShot)));
      if (isRecord(applied) && isRecord(applied.settings)) variants.push(JSON.stringify(applied.settings));
    }
    return variants;
  } catch {
    return [];
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function readFrame(value: unknown): RenderedFrame {
  if (!isRecord(value)) throw new Error("develop engine returned no frame");
  const { width, height, rgba } = value;
  if (!isPositiveInteger(width) || !isPositiveInteger(height) || !(rgba instanceof Uint8ClampedArray)) {
    throw new Error("develop engine returned an invalid frame");
  }
  if (rgba.length !== width * height * 4) throw new Error("develop engine returned a frame of the wrong size");
  return { width, height, rgba };
}

/** glue の `maskPlane` が返した `{ width, height, data }`（data は `width·height` byte）を読む。 */
function readMaskPlane(value: unknown): { width: number; height: number; data: Uint8Array } {
  if (!isRecord(value)) throw new Error("develop engine returned no mask plane");
  const { width, height, data } = value;
  if (!isPositiveInteger(width) || !isPositiveInteger(height) || !(data instanceof Uint8Array)) {
    throw new Error("develop engine returned an invalid mask plane");
  }
  if (data.length !== width * height) throw new Error("develop engine returned a mask plane of the wrong size");
  return { width, height, data };
}

/** glue が返した `{ width, height }`（正の整数）を読む。 */
function readSize(value: unknown): { width: number; height: number } {
  if (!isRecord(value)) throw new Error("develop engine returned no size");
  const { width, height } = value;
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) throw new Error("develop engine returned an invalid size");
  return { width, height };
}

/** 作業コピーの PNG の IHDR の幅・高さ（byte 16..23・big endian。#155 の見積もり用。読めなければ null）。 */
function workingCopyPngSize(png: ArrayBuffer): { width: number; height: number } | null {
  if (png.byteLength < 24) return null;
  const view = new DataView(png);
  // "IHDR"（byte 12..15）が先頭の chunk でなければ読まない
  if (view.getUint32(12) !== 0x49484452) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG / PNG の原本の向きを反映した大きさ（幾何の口の `imageSize`。#155 の見積もり用。口が無い・読めなければ null）。 */
function sourceImageSize(glue: DevelopGlue, bytes: ArrayBuffer): { width: number; height: number } | null {
  if (!glue.geometry) return null;
  try {
    return readSize(glue.geometry.imageSize(new Uint8Array(bytes)));
  } catch {
    return null;
  }
}

/** 作業コピーの大きさ（PNG の IHDR。読めなければ長辺 2560px の正方形）。 */
function workingCopySize(png: ArrayBuffer): { width: number; height: number } {
  return workingCopyPngSize(png) ?? { width: WORKING_COPY_FALLBACK_DIMENSION, height: WORKING_COPY_FALLBACK_DIMENSION };
}

/**
 * これから開く JPEG / PNG の見積もり（#155。デコードする前に空ける分）。作業サイズ（0 は一発の書き出しと同じ上限）の正方形で多めに
 * 見積もる（大きさを読むと native では sidecar への往復が 1 回増えるので読まない。開いた後は実際の大きさで数える）。
 */
function rasterOpenMemoryBytes(workingMaxDimension: number): number {
  const cap = workingMaxDimension > 0 ? workingMaxDimension : ONE_SHOT_DECODE_CAP;
  return developerMemoryBytes(cap, cap);
}

/** これから開く作業コピーの見積もり（#155）。 */
function workingCopyOpenMemoryBytes(png: ArrayBuffer): number {
  const size = workingCopySize(png);
  return developerMemoryBytes(size.width, size.height);
}

/** 作業コピーの書き出し 1 回の見積もり（#155。開いて持つ分も入る）。 */
function workingCopyExportMemoryBytes(png: ArrayBuffer, settingsJson: string, maxDimension: number): number {
  const load = developRenderLoadFromJson(settingsJson);
  return developExportMemoryBytes(load, { ...workingCopySize(png), workingCopy: true }, maxDimension);
}

/**
 * JPEG / PNG の書き出しで原本をデコードする長辺（#155 の見積もり用）。切り抜くと、切り抜きが書き出しの大きさに届くよう大きく
 * デコードして描く（`rasterDecodeSize`）。幾何の口が無ければ書き出しの長辺、原本の大きさや結果が読めなければデコードの上限
 * （多めに倒す）。
 */
function oneShotDecodeDimension(
  glue: DevelopGlue,
  settingsJson: string,
  source: { width: number; height: number } | null,
  maxDimension: number,
): number {
  if (!glue.geometry) return maxDimension;
  if (!source) return ONE_SHOT_DECODE_CAP;
  try {
    const value = glue.geometry.rasterDecodeSize(settingsJson, source.width, source.height, maxDimension, ONE_SHOT_DECODE_CAP);
    return isPositiveInteger(value) ? value : ONE_SHOT_DECODE_CAP;
  } catch {
    return ONE_SHOT_DECODE_CAP;
  }
}

/**
 * JPEG / PNG の書き出し 1 回の見積もり（#155）。描く分は原本をデコードする大きさ（{@link oneShotDecodeDimension}）で数える。
 * 原本の大きさが読めなければ、その長辺の正方形。
 */
function oneShotExportMemoryBytes(
  source: { width: number; height: number } | null,
  settingsJson: string,
  decodeDimension: number,
): number {
  const fallback = decodeDimension > 0 ? Math.min(decodeDimension, ONE_SHOT_DECODE_CAP) : ONE_SHOT_DECODE_CAP;
  const size = source ?? { width: fallback, height: fallback };
  return developExportMemoryBytes(developRenderLoadFromJson(settingsJson), { ...size, workingCopy: false }, decodeDimension);
}

function readMemoryBuffer(initOutput: unknown): ArrayBufferLike | null {
  if (!isRecord(initOutput)) return null;
  const memory = initOutput.memory;
  return typeof WebAssembly !== "undefined" && memory instanceof WebAssembly.Memory ? memory.buffer : null;
}

/**
 * transfer してよい ArrayBuffer にする。wasm の memory を指している・一部だけを指している・SharedArrayBuffer なら
 * コピーする（wasm の memory を transfer すると wasm が壊れる）。
 */
function transferableBuffer(view: Uint8Array | Uint8ClampedArray, wasmMemory: ArrayBufferLike | null): ArrayBuffer {
  const buffer = view.buffer;
  if (
    buffer instanceof ArrayBuffer &&
    buffer !== wasmMemory &&
    view.byteOffset === 0 &&
    view.byteLength === buffer.byteLength
  ) {
    return buffer;
  }
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "develop engine failed";
}

function analysisSettingsKeyFromJson(settingsJson: string): string | null {
  let settings: unknown;
  try {
    settings = JSON.parse(settingsJson);
  } catch {
    return null;
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null;
  const values = settings as Record<string, unknown>;
  const colorNoiseReduction = values.colorNoiseReduction ?? 0;
  if (typeof colorNoiseReduction !== "number" || !Number.isFinite(colorNoiseReduction)) return null;
  const engine = typeof values.engine === "string" ? values.engine : "";
  // v6 のノイズ軽減（Issue #32）も解析の元の画を変える（signed RAW の master・niho-6 の解析）
  const detail = values.detail;
  if (detail === undefined) return `${engine}:${colorNoiseReduction}`;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return null;
  const { luminanceNoiseReduction, colorNoiseReduction: detailColor } = detail as Record<string, unknown>;
  return `${engine}:${colorNoiseReduction}:${String(luminanceNoiseReduction)}:${String(detailColor)}`;
}

/**
 * Worker の中でスレッド版を試せる環境か（{@link DevelopEngineWorkerDeps.threadsEnvironment}）。`crossOriginIsolated` だけでは決めない:
 * macOS 27 の WKWebView は独自の scheme の文書と Worker で COOP / COEP を見て true を返すが、process は分離しておらず
 * `SharedArrayBuffer` を出さず、共有メモリを Worker へ渡せない（#173・#175）。
 */
export function readThreadsEnvironment(scope: {
  crossOriginIsolated?: boolean;
  SharedArrayBuffer?: unknown;
  navigator: { hardwareConcurrency: number; userAgent: string };
}): { isolated: boolean; hardwareConcurrency: number; userAgent: string } {
  return {
    isolated: scope.crossOriginIsolated === true && typeof scope.SharedArrayBuffer === "function",
    hardwareConcurrency: scope.navigator.hardwareConcurrency,
    userAgent: scope.navigator.userAgent,
  };
}

export function createDevelopEngineWorkerHandler(
  deps: DevelopEngineWorkerDeps,
): (message: DevelopEngineWorkerRequest) => Promise<void> {
  // 起こした glue（まだなら null）。起こせなかったら unavailable にして、以後は何も受けない
  let glue: DevelopGlue | null = null;
  let version = "";
  let runtime: DevelopEngineRuntime = "wasm";
  let wasmThreads = 1;
  let activeManifestUrl: string | null = null;
  let nativeReleaseClient: (() => unknown) | null = null;
  // 起こした wasm が効果のある設定（v: 3）を読めるか（起こしたときに 1 回だけ確かめる）
  let effects = false;
  let colorPoints = false;
  let detail = false;
  // 起こした wasm が描ける部分補正（起こしたときに `capabilities()` を 1 回だけ読む。描けなければ null）
  let masks: DevelopMaskCapabilities | null = null;
  let perspective = false;
  let upright = false;
  let heal = false;
  let lens = false;
  let wasmMemory: () => ArrayBufferLike | null = () => null;
  let diagnostics = false;
  let deviceClass: DevelopEngineDeviceClass = "pc";
  // 大きな書き出しを 1 回だけ描く使い捨ての worker として起こされた（#155）
  let disposable = false;
  let unavailableReason: string | null = null;
  let developer: DevelopDeveloper | null = null;
  // 開いている写真の見本用の session（初めて見本を描くときに作る。写真を手放すと一緒に手放す）と、作ったときの見積もり（#155）
  let thumbnailSession: DevelopDeveloper | null = null;
  let thumbnailSessionBytes = 0;
  // 開いている写真の `Developer` に渡した面の PNG（見本用の session にも渡すため。写真を手放すと捨てる）と、見本用の session に渡した面
  const heldSurfaces = new Map<string, Uint8Array>();
  const thumbnailSurfaces = new Set<string>();
  let currentAnalysisKey: string | null = null;
  let currentAnalysisSettingsJson: string | null = null;
  // 開いている写真の入力の鍵（鍵が無い写真は手放すときに保たない）と、開いていないが保っている写真（古い順）
  let currentKey: string | null = null;
  let currentOpenInput: CurrentOpenInput | null = null;
  const kept: KeptPhoto[] = [];
  // 写真 digest + 作業コピー metadata（寸法を含む input）+ engine/CNR/detail + engine 版で分離する。Rust も source
  // fingerprint を必ず照合する。import が失敗した entry は壊れた/不一致として直ちに捨て、通常の描画再計算へ戻る。
  const analysisBytes = new Map<string, CachedAnalysis>();
  let analysisBytesTotal = 0;
  let chain: Promise<void> = Promise.resolve();
  let warmAuto: Extract<DevelopEngineWorkerRequest, { type: "warmAutoSettings" }> | null = null;
  let warmTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledWarm: object | null = null;
  let normalPending = 0;
  // 解析を先に作る（#129）: 開いている写真を丁寧に描いた設定（静かな間に、それと同梱のプリセットの解析を 1 件ずつ作る）と、
  // 写真ごとに作った（作ろうとした）解析の鍵
  let analysisAhead: { developer: DevelopDeveloper; settingsJson: string } | null = null;
  let analysisTimer: ReturnType<typeof setTimeout> | null = null;
  const preparedAnalyses = new WeakMap<DevelopDeveloper, Set<string>>();
  // 先に作った別の設定の解析を持っている（かもしれない）写真（#155 の見積もり。この worker の `prepareAnalysis`・補助の worker の
  // 結果の取り込み・描く解析の鍵の替わり〔Session は前の解析を 1 件横に置く〕で入れ、`releaseAnalysisAhead`・free で外す）
  const analysisAheadHeld = new WeakSet<DevelopDeveloper>();
  // 先回りを補助の worker で作る（#155）: 開いている写真を開いた入力の写し（補助の worker に渡すまで）、動いている補助の worker、
  // 補助の worker で作れなかった写真（この worker で作る）、補助の worker に読ませる manifest
  let analysisSource: { developer: DevelopDeveloper; png: ArrayBuffer; metaJson: string } | null = null;
  let analysisHelper: AnalysisHelperState | null = null;
  const helperFailed = new WeakSet<DevelopDeveloper>();
  let helperManifestUrl: string | null = null;
  let nextHelperJobId = 1;
  let handle: (message: DevelopEngineWorkerRequest) => Promise<void>;
  let enforcingMemoryBudget = false;

  const analysisBytesId = (photoKey: string, analysisKey: string): string =>
    JSON.stringify([version, photoKey, analysisKey]);

  const activeAnalysisStore = (): DevelopAnalysisStore | undefined => {
    // 使い捨ての worker は解析を作らないので保存先も使わない（#155）
    if (disposable) return undefined;
    return runtime === "native" ? deps.nativeAnalysisStore ?? deps.analysisStore : deps.analysisStore;
  };

  /** meta JSON を保存先の鍵に置かない。入力・版・解析条件をまとめて SHA-256 にする。 */
  const persistentAnalysisId = async (photoKey: string, analysisKey: string): Promise<string | null> => {
    if (!deps.digest) return null;
    try {
      const bytes = new TextEncoder().encode(analysisBytesId(photoKey, analysisKey));
      return await deps.digest(bytes.buffer);
    } catch {
      return null;
    }
  };

  const persistAnalysis = (photoKey: string, analysisKey: string, bytes: ArrayBuffer) => {
    const store = activeAnalysisStore();
    if (!store) return;
    void (async () => {
      const id = await persistentAnalysisId(photoKey, analysisKey);
      if (id) await store.put(id, bytes);
    })().catch(() => undefined);
  };

  const loadPersistedAnalysis = async (photoKey: string | null, analysisKey: string | null) => {
    const store = activeAnalysisStore();
    if (photoKey === null || analysisKey === null || !store) return;
    if (analysisBytes.has(analysisBytesId(photoKey, analysisKey))) return;
    const id = await persistentAnalysisId(photoKey, analysisKey);
    if (!id) return;
    // 壊れた/固まった保存先のために編集を待たせ続けない。時間切れなら通常の render で再計算する。
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stored = await Promise.race([
        store.get(id).catch(() => null),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 120); }),
      ]);
      if (stored instanceof ArrayBuffer) cacheAnalysisBytes(photoKey, analysisKey, stored, false);
    } catch {
      // 保存先の障害は編集の障害にしない。
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const dropCachedAnalysis = (id: string) => {
    const cached = analysisBytes.get(id);
    if (!cached) return;
    analysisBytes.delete(id);
    analysisBytesTotal -= cached.bytes.byteLength;
  };

  const cacheAnalysisBytes = (photoKey: string | null, analysisKey: string | null, source: Uint8Array | ArrayBuffer, persist = true) => {
    if (photoKey === null || analysisKey === null) return;
    const view = source instanceof Uint8Array ? source : new Uint8Array(source);
    if (view.byteLength === 0 || view.byteLength > ANALYSIS_BYTES_ENTRY_LIMIT) return;
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    const id = analysisBytesId(photoKey, analysisKey);
    dropCachedAnalysis(id);
    analysisBytes.set(id, { bytes: copy.buffer });
    analysisBytesTotal += copy.byteLength;
    if (persist) persistAnalysis(photoKey, analysisKey, copy.buffer);
    while (analysisBytes.size > ANALYSIS_BYTES_COUNT_LIMIT || analysisBytesTotal > ANALYSIS_BYTES_TOTAL_LIMIT) {
      const oldest = analysisBytes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      dropCachedAnalysis(oldest);
    }
    enforceMemoryBudget();
  };

  const cacheAnalysisFromDeveloper = (
    target: DevelopDeveloper,
    photoKey: string | null,
    analysisKey: string | null,
    settingsJson: string | null,
  ) => {
    if (photoKey === null || analysisKey === null || settingsJson === null) return;
    try {
      if (target.holdsAnalysis?.(settingsJson) !== true) return;
      const bytes = target.exportAnalysis?.(settingsJson);
      if (bytes instanceof Uint8Array) cacheAnalysisBytes(photoKey, analysisKey, bytes);
    } catch {
      // export 非対応・転送失敗でも Developer の解放と従来の再計算を続ける。
    }
  };

  const restoreCachedAnalysis = async (
    target: DevelopDeveloper,
    photoKey: string | null,
    analysisKey: string | null,
    settingsJson: string,
  ) => {
    if (photoKey === null || analysisKey === null) return;
    const id = analysisBytesId(photoKey, analysisKey);
    if (holdsAnalysis(target, settingsJson)) return;
    await loadPersistedAnalysis(photoKey, analysisKey);
    const cached = analysisBytes.get(id);
    if (!cached) return;
    // Rust の Session は別設定の解析を 1 件だけ持つ。同じ Developer へ過去に import 済みでも、別 CNR に押し出され得るため
    // 描画ごとに実際の保持状態を聞く。口が無い・失敗した場合は false として、安全側で再 import する。
    if (holdsAnalysis(target, settingsJson)) return;
    try {
      const importer = target.importAnalysis;
      if (typeof importer !== "function") return;
      measure("importAnalysis", () => importer.call(target, new Uint8Array(cached.bytes)));
      // Map の挿入順を LRU として使う。
      analysisBytes.delete(id);
      analysisBytes.set(id, cached);
    } catch {
      dropCachedAnalysis(id);
      // 壊れた bytes・別写真・未対応 glue は捨て、直後の render に通常どおり再計算させる。
    }
  };

  const recordPerf = (stage: DevelopEnginePerfRecord["stage"], started: number, status: DevelopEnginePerfRecord["status"]) => {
    try {
      deps.logPerf?.({
        stage,
        durationMs: Math.max(0, (deps.now ?? performance.now.bind(performance))() - started),
        wasmMemoryBytes: wasmMemory()?.byteLength ?? null,
        status,
      });
    } catch {
      // 診断の失敗で写真の操作や元のエラーを変えない。
    }
  };
  const startPerf = (): number | null => {
    try {
      return (deps.now ?? performance.now.bind(performance))();
    } catch {
      // 時計を読めなくても本来の処理は続ける。
      return null;
    }
  };
  const measure = <T>(stage: DevelopEnginePerfRecord["stage"], action: () => T): T => {
    if (!diagnostics) return action();
    const started = startPerf();
    if (started === null) return action();
    try {
      const result = action();
      recordPerf(stage, started, "ok");
      return result;
    } catch (error) {
      recordPerf(stage, started, "error");
      throw error;
    }
  };
  const measureAsync = async <T>(stage: DevelopEnginePerfRecord["stage"], action: () => Promise<T>): Promise<T> => {
    if (!diagnostics) return action();
    const started = startPerf();
    if (started === null) return action();
    try {
      const result = await action();
      recordPerf(stage, started, "ok");
      return result;
    } catch (error) {
      recordPerf(stage, started, "error");
      throw error;
    }
  };

  const clearWarmTimer = () => {
    if (warmTimer !== null) clearTimeout(warmTimer);
    warmTimer = null;
  };

  /** 先読みは Worker が短時間空いてから動かし、通常要求の列へ割り込ませない。 */
  const scheduleWarm = (delayMs = 0) => {
    if (!warmAuto || warmTimer !== null || normalPending > 0) return;
    warmTimer = setTimeout(() => {
      warmTimer = null;
      if (!warmAuto || normalPending > 0) return;
      const candidate = warmAuto;
      const token = {};
      scheduledWarm = token;
      const next = chain
        .then(async () => {
          // 先行処理中に通常要求・取消が届いたら先読みを動かさない。
          if (scheduledWarm !== token || warmAuto !== candidate || normalPending > 0) return;
          scheduledWarm = null;
          warmAuto = null;
          await handle({ type: "autoSettings", id: candidate.id, settingsJson: candidate.settingsJson });
        })
        .catch(() => undefined);
      chain = next;
      void next.then(() => scheduleWarm());
    }, delayMs);
  };

  const clearAnalysisTimer = () => {
    if (analysisTimer !== null) clearTimeout(analysisTimer);
    analysisTimer = null;
  };

  const dropAnalysisAhead = () => {
    analysisAhead = null;
    clearAnalysisTimer();
    endAnalysisHelper();
  };

  /** 補助の worker を終わらせ、入力の写しを手放す（遅れて届いた結果は {@link receiveAnalysis} が捨てる）。 */
  const endAnalysisHelper = () => {
    analysisSource = null;
    const current = analysisHelper;
    analysisHelper = null;
    try {
      current?.helper?.terminate();
    } catch {
      // 終わらせられなくても、遅れて届いた結果は捨てる
    }
  };

  /**
   * 補助の worker で作れなかった（作れない・落ちた・取り込めない）: 終わらせ、その写真ではこの worker で作る。待っていた 1 件は
   * この worker でもう 1 度だけ作る（そこで作れなければ #129 と同じく作り直さない）。
   */
  const failAnalysisHelper = (state: AnalysisHelperState) => {
    if (analysisHelper !== state) return;
    helperFailed.add(state.developer);
    const key = state.waiting?.key;
    if (key) preparedAnalyses.get(state.developer)?.delete(key);
    state.waiting = null;
    endAnalysisHelper();
  };

  /**
   * 補助の worker の応答。終わらせた補助の worker・待っていない応答は捨てる。解析の bytes は、同じ写真のままなら列に積んで取り込む
   * （コピーだけ。何も手放さずに予算に収まらなければ取り込まず、解析の bytes に置くだけ。#155）。取り込みが終わったら次の 1 件へ。
   */
  const receiveAnalysis = (state: AnalysisHelperState, response: DevelopAnalysisHelperResponse | null) => {
    if (analysisHelper !== state) return;
    const waiting = state.waiting;
    if (response !== null && (!waiting || response.id !== waiting.id)) return;
    if (response === null || response.type === "error") {
      failAnalysisHelper(state);
      scheduleAnalysisAhead();
      return;
    }
    const bytes = response.bytes;
    const next = chain
      .then(() => {
        // 写真を替えた・閉じたら取り込まない
        if (analysisHelper !== state || state.waiting !== waiting || developer !== state.developer) return;
        if (bytes !== null) {
          try {
            const importer = state.developer.importAnalysis;
            if (typeof importer !== "function") throw new Error("develop engine cannot import analysis");
            if (fitsAnalysisAhead(state.developer)) {
              measure("importAnalysis", () => importer.call(state.developer, new Uint8Array(bytes)));
              analysisAheadHeld.add(state.developer);
            }
            cacheAnalysisBytes(currentKey, waiting?.key ?? null, bytes);
          } catch {
            failAnalysisHelper(state);
            return;
          }
        }
        state.waiting = null;
      })
      .catch(() => undefined);
    chain = next;
    void next.then(() => scheduleAnalysisAhead());
  };

  /**
   * 先回りの 1 件を補助の worker に頼む。最初の 1 件で補助の worker を作り、入力の写しを渡す（transfer）。頼めたら true（この worker
   * の列は結果を待たない）。補助の worker を足すと予算の `totalBytes` を超えるときも、その 1 件は作らずに true（この worker で作ると
   * 描画を止めるので作らない。#155）。補助の worker を使えない写真・作れなければ false（この worker で作る）。
   */
  const requestAnalysis = (
    job: { developer: DevelopDeveloper; settingsJson: string },
    settingsJson: string,
    key: string | null,
  ): boolean => {
    if (helperFailed.has(job.developer)) return false;
    let state = analysisHelper?.developer === job.developer ? analysisHelper : null;
    if (!state) {
      const source = analysisSource;
      const create = deps.createAnalysisHelper;
      if (!source || source.developer !== job.developer || !create || helperManifestUrl === null) return false;
      const memoryBytes = analysisHelperMemoryBytes(job.developer.width, job.developer.height);
      if (physicalBytes() + memoryBytes > memoryBudget().totalBytes) return true;
      endAnalysisHelper();
      const created: AnalysisHelperState = { developer: job.developer, helper: null, waiting: null, memoryBytes };
      analysisHelper = created;
      let started = false;
      try {
        created.helper = create((response) => receiveAnalysis(created, response));
        created.helper?.post(
          { type: "start", manifestUrl: helperManifestUrl, version, png: source.png, metaJson: source.metaJson },
          [source.png],
        );
        started = created.helper !== null;
      } catch {
        started = false;
      }
      if (!started) {
        // 作れなかった補助の worker は終わらせ、この写真ではこの worker で作る
        failAnalysisHelper(created);
        return false;
      }
      state = created;
    }
    const id = nextHelperJobId;
    nextHelperJobId += 1;
    try {
      state.helper?.post({ type: "analysis", id, settingsJson }, []);
    } catch {
      failAnalysisHelper(state);
      return false;
    }
    state.waiting = { id, key };
    return true;
  };

  /** その設定の解析をもう全部持っているか（#155 の口。無い glue・読めなければ false＝作る）。 */
  const holdsAnalysis = (target: DevelopDeveloper, settingsJson: string): boolean => {
    try {
      return target.holdsAnalysis?.(settingsJson) === true;
    } catch {
      return false;
    }
  };

  /** 補助の worker に渡す入力の写しを持つ（#155。補助の worker を使えない環境・glue・写真、使い捨ての worker では持たない）。 */
  const holdAnalysisSource = (opened: DevelopDeveloper, png: ArrayBuffer, metaJson: string) => {
    analysisSource =
      !disposable &&
      deps.createAnalysisHelper &&
      glue?.analysisTransfer &&
      !helperFailed.has(opened) &&
      isSignedRawWorkingCopy(metaJson)
        ? { developer: opened, png, metaJson }
        : null;
  };

  /**
   * 次に先に作る解析の設定: 丁寧に描いた設定、次に同梱のプリセットを当てた設定のうち、解析（engine・CNR・ノイズ軽減）がまだ
   * 作っていないもの。解析の種類は今の写真の分と、もう 1 つ（colorful の CNR 25 など）まで（engine が保つ解析も 2 つまで）。
   */
  const nextAnalysisAhead = (job: { developer: DevelopDeveloper; settingsJson: string }): string | null => {
    const prepared = preparedAnalyses.get(job.developer);
    const keys = new Set<string>();
    const candidates = [job.settingsJson];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index] as string;
      const key = analysisSettingsKeyFromJson(candidate);
      if (key !== null && !keys.has(key)) {
        if (keys.size === 2) break;
        keys.add(key);
        if (!prepared?.has(key)) return candidate;
      }
      if (index === 0 && glue) candidates.push(...presetVariants(glue, job.developer, job.settingsJson));
    }
    return null;
  };

  /**
   * 解析を先に作る 1 件を、通常の要求が {@link ANALYSIS_AHEAD_QUIET_MS} 来なかったら動かす（動かしたら次の 1 件を待つ。補助の worker に
   * 頼んだ 1 件は取り込むまで待つ）。
   */
  const scheduleAnalysisAhead = () => {
    if (!analysisAhead || analysisTimer !== null || normalPending > 0 || analysisHelper?.waiting) return;
    analysisTimer = setTimeout(() => {
      analysisTimer = null;
      const job = analysisAhead;
      if (!job || normalPending > 0 || analysisHelper?.waiting) return;
      const next = chain
        .then(() => {
          // 待つ間に通常の要求・写真の切り替えが来たら動かさない
          if (analysisAhead !== job || normalPending > 0 || developer !== job.developer || analysisHelper?.waiting) return;
          const settingsJson = nextAnalysisAhead(job);
          if (settingsJson === null) {
            analysisAhead = null;
            endAnalysisHelper();
            return;
          }
          const key = analysisSettingsKeyFromJson(settingsJson);
          let prepared = preparedAnalyses.get(job.developer);
          if (!prepared) {
            prepared = new Set();
            preparedAnalyses.set(job.developer, prepared);
          }
          // 作れなくても同じ解析を何度も試さない（描くときに作る。画素は同じ）
          if (key !== null) prepared.add(key);
          // すでに持っている解析は作らない。補助の worker に頼めたら、この worker の列は待たない（#155）
          if (holdsAnalysis(job.developer, settingsJson)) return;
          if (requestAnalysis(job, settingsJson, key)) return;
          // この worker で作るのは、何も手放さずに予算に収まるときだけ（#155）
          if (!fitsAnalysisAhead(job.developer)) return;
          measure("prepareAnalysis", () => job.developer.prepareAnalysis?.(settingsJson));
          analysisAheadHeld.add(job.developer);
          cacheAnalysisFromDeveloper(job.developer, currentKey, key, settingsJson);
        })
        .catch(() => undefined);
      chain = next;
      void next.then(() => scheduleAnalysisAhead());
    }, ANALYSIS_AHEAD_QUIET_MS);
  };

  const freeQuietly = (target: DevelopDeveloper | null) => {
    if (target) analysisAheadHeld.delete(target);
    try {
      target?.free();
    } catch {
      // 手放すときの失敗で、次の写真を止めない
    }
  };

  const releaseThumbnailSession = () => {
    const current = thumbnailSession;
    thumbnailSession = null;
    thumbnailSessionBytes = 0;
    thumbnailSurfaces.clear();
    freeQuietly(current);
  };

  const freeKept = (photo: KeptPhoto | undefined) => {
    if (photo) {
      cacheAnalysisFromDeveloper(photo.developer, photo.key, photo.analysisKey, photo.analysisSettingsJson);
    }
    freeQuietly(photo?.developer ?? null);
  };

  const clearAnalysisBytes = () => {
    analysisBytes.clear();
    analysisBytesTotal = 0;
  };

  const memoryBudget = () => DEVELOP_MEMORY_BUDGET[deviceClass];

  /** wasm の linear memory の高水位（free しても縮まない。native は 0）。 */
  const wasmHighWater = (): number => wasmMemory()?.byteLength ?? 0;

  /** 写真 1 枚（開いている・保っている）が持つ bytes の見積もり（先に作った別の設定の解析を持っていればその分も）。 */
  const photoMemoryBytes = (target: DevelopDeveloper): number =>
    developerMemoryBytes(target.width, target.height) +
    (analysisAheadHeld.has(target) ? analysisAheadMemoryBytes(target.width, target.height) : 0);

  /** wasm（native は sidecar）の中に持つ物: 開いている写真・保つ写真・見本の session。 */
  const wasmHeldBytes = (): number => {
    let total = (developer ? photoMemoryBytes(developer) : 0) + thumbnailSessionBytes;
    for (const photo of kept) total += photoMemoryBytes(photo.developer);
    return total;
  };

  /**
   * Worker が持つ物の見積もり（wasm の中の物・JS に置いた解析の bytes）。動いている補助の worker は一時的なので数えず、作るときと
   * 書き出しの前に `totalBytes` に対して見る（数えると、補助の worker が動いている間は先回りの取り込みを見送ってしまう）。
   */
  const heldBytes = (): number => wasmHeldBytes() + analysisBytesTotal;

  /** 動いている補助の worker の見積もり（無ければ 0）。 */
  const helperBytes = (): number => analysisHelper?.memoryBytes ?? 0;

  /**
   * いま物理メモリに乗っている量の見積もり（wasm は高水位と持つ物の大きいほう。補助の worker は作り直すときに見るので含めない）。
   */
  const physicalBytes = (): number =>
    (runtime === "native" ? wasmHeldBytes() : Math.max(wasmHighWater(), wasmHeldBytes())) + analysisBytesTotal;

  /** 持つ物の上限（書き出しの空きを残す。wasm で高水位が既に上がっていれば、払った分は使う）。 */
  const heldLimit = (): number => {
    const budget = memoryBudget();
    return Math.max(budget.totalBytes - budget.exportReserveBytes, wasmHighWater());
  };

  /** 開いている写真に別の設定の解析を 1 件足しても、何も手放さずに上限に収まるか（#155）。 */
  const fitsAnalysisAhead = (target: DevelopDeveloper): boolean =>
    heldBytes() + analysisAheadMemoryBytes(target.width, target.height) <= heldLimit();

  /** 開いている写真の先に作った別の設定の解析を手放す（解析の bytes は残るので、次は取り込みで戻る）。 */
  const releaseActiveAnalysisAhead = () => {
    if (!developer) return;
    analysisAheadHeld.delete(developer);
    try {
      developer.releaseAnalysisAhead?.();
    } catch {
      // 手放せなくても描く画素は同じ（メモリが減らないだけ）
    }
  };

  /**
   * 持つ物と `incoming`（これから足す物の見積もり）が `limit` を超える間、安く作り直せる見本 → 開いている写真の先回りの解析 →
   * 保つ写真（古い順）→ 高価な解析の bytes（古い順）の順に手放す。開いている写真は手放さない（それでも超えるなら止める）。
   */
  function enforceMemoryBudget(incoming = 0, limit = heldLimit()): void {
    if (enforcingMemoryBudget) return;
    enforcingMemoryBudget = true;
    try {
      while (heldBytes() + incoming > limit) {
        if (thumbnailSession) {
          releaseThumbnailSession();
          continue;
        }
        if (developer && analysisAheadHeld.has(developer)) {
          releaseActiveAnalysisAhead();
          continue;
        }
        if (kept.length > 0) {
          // freeKept は保持している解析を compact bytes に移す。enforcingMemoryBudget の guard で再入を止め、この loop で再評価する。
          freeKept(kept.shift());
          continue;
        }
        const oldestAnalysis = analysisBytes.keys().next().value as string | undefined;
        if (oldestAnalysis !== undefined) {
          dropCachedAnalysis(oldestAnalysis);
          continue;
        }
        // 開いている写真は見積もりのために捨てない（足りなければ allocation failure の再試行に任せる）
        break;
      }
    } finally {
      enforcingMemoryBudget = false;
    }
  }

  /** allocation failure の再試行前に、現在表示に不要な保持物を全部手放す。 */
  const releaseRecreatableMemory = () => {
    dropAnalysisAhead();
    releaseThumbnailSession();
    if (developer) analysisAheadHeld.delete(developer);
    try {
      developer?.releaseAnalysisAhead?.();
    } catch {
      // 現在表示中の Developer 自体は守り、補助解析を外せなくても再試行は続ける。
    }
    if (developer) preparedAnalyses.delete(developer);
    for (const photo of kept.splice(0)) freeKept(photo);
    clearAnalysisBytes();
  };

  const retryAllocationOnce = <T>(allocate: () => T): T => {
    try {
      return allocate();
    } catch (error) {
      if (!isDevelopAllocationFailure(error)) throw error;
      releaseRecreatableMemory();
      return allocate();
    }
  };

  /**
   * 同じ Worker で書き出しを描く前に、持つ物と書き出しの見積もりが `totalBytes`（wasm の高水位が上ならそこまで）を超える間だけ、
   * 破棄の順で手放す（#155。長辺によらず、超えなければ大きくても手放さない）。
   */
  const prepareTemporaryExport = (estimate: number) => {
    enforceMemoryBudget(estimate + helperBytes(), Math.max(memoryBudget().totalBytes, wasmHighWater()));
  };

  /** 保っている写真を、開いている写真と合わせて `limit` 枚に収まるまで古いほうから手放す。 */
  const trimKept = (limit: number) => {
    while (kept.length > 0 && kept.length + (developer ? 1 : 0) > limit) freeKept(kept.shift());
  };

  /** 開いている写真の面を外す（使い回す写真も、新しい `Developer` と同じく面を持たずに始める。client は渡し直す）。 */
  const dropHeldSurfaces = () => {
    try {
      for (const surfaceId of heldSurfaces.keys()) developer?.dropMaskSurface?.(surfaceId);
      for (const surfaceId of thumbnailSurfaces) thumbnailSession?.dropMaskSurface?.(surfaceId);
    } catch {
      // 外せなくても面は中身の sha256 で呼ぶので、別の面として描くことはない
    }
    heldSurfaces.clear();
    thumbnailSurfaces.clear();
  };

  /**
   * 開いている写真を手放す。入力の鍵があれば面を外して保ち（予算の `heldPhotos` 枚を超えたら古いほうから手放す）、
   * 無ければ見本用の session ごと free する。
   */
  const releaseDeveloper = () => {
    const current = developer;
    if (current && currentKey !== null) {
      dropHeldSurfaces();
      releaseThumbnailSession();
      analysisAheadHeld.delete(current);
      try {
        current.releaseAnalysisAhead?.();
      } catch {
        // 手放せなくても描く画素は同じ（メモリが減らないだけ）
      }
      preparedAnalyses.delete(current);
      kept.push({
        key: currentKey,
        developer: current,
        analysisKey: currentAnalysisKey,
        analysisSettingsJson: currentAnalysisSettingsJson,
      });
    } else {
      releaseThumbnailSession();
      heldSurfaces.clear();
      freeQuietly(current);
    }
    developer = null;
    currentKey = null;
    currentAnalysisKey = null;
    currentAnalysisSettingsJson = null;
    trimKept(memoryBudget().heldPhotos);
    enforceMemoryBudget();
  };

  /**
   * `key` の写真を開く: 開いている写真・保っている写真と同じ入力なら、それを開いている写真にして true（面は外す）。違えば
   * 開いている写真を手放し、新しい写真の分を空けて false（呼び出し側がデコードして {@link adoptDeveloper} する）。
   */
  const reuseDeveloper = (key: string | null): boolean => {
    if (key !== null && developer && currentKey === key) {
      dropHeldSurfaces();
      return true;
    }
    const index = key === null ? -1 : kept.findIndex((photo) => photo.key === key);
    const [photo] = index < 0 ? [] : kept.splice(index, 1);
    releaseDeveloper();
    if (!photo) {
      trimKept(memoryBudget().heldPhotos - 1);
      return false;
    }
    developer = photo.developer;
    currentKey = photo.key;
    currentAnalysisKey = photo.analysisKey;
    currentAnalysisSettingsJson = photo.analysisSettingsJson;
    trimKept(memoryBudget().heldPhotos);
    return true;
  };

  const adoptDeveloper = (next: DevelopDeveloper, key: string | null) => {
    developer = next;
    currentKey = key;
    currentAnalysisKey = null;
    currentAnalysisSettingsJson = null;
  };

  /** 開き方と入力の bytes の鍵（`digest` が無い・読めなければ null = 保たない）。 */
  const inputKey = async (kind: string, bytes: ArrayBuffer, detail: string): Promise<string | null> => {
    if (!deps.digest) return null;
    try {
      const digest = await deps.digest(bytes);
      return typeof digest === "string" && digest ? `${kind}\u0000${detail}\u0000${digest}` : null;
    } catch {
      return null;
    }
  };

  /** 見本用の session の面を、開いている写真の `Developer` に渡した面とそろえる（口の無い glue では何もしない）。 */
  const syncThumbnailSurfaces = (session: DevelopDeveloper) => {
    if (typeof session.setMaskSurface !== "function") return;
    for (const surfaceId of [...thumbnailSurfaces]) {
      if (heldSurfaces.has(surfaceId)) continue;
      thumbnailSurfaces.delete(surfaceId);
      session.dropMaskSurface?.(surfaceId);
    }
    for (const [surfaceId, png] of heldSurfaces) {
      if (thumbnailSurfaces.has(surfaceId)) continue;
      session.setMaskSurface(surfaceId, png);
      thumbnailSurfaces.add(surfaceId);
    }
  };

  /** 書き出しに添えた面を一時的な `Developer` に渡す（口の無い glue は error）。 */
  const setExportSurfaces = (target: DevelopDeveloper, surfaces: readonly DevelopMaskSurfacePng[]) => {
    if (typeof target.setMaskSurface !== "function") throw new Error("develop engine cannot take mask surfaces");
    for (const surface of surfaces) target.setMaskSurface(surface.id, new Uint8Array(surface.png));
  };

  const postReady = (id: number) => {
    deps.post({
      type: "ready",
      id,
      version,
      runtime,
      ...(wasmThreads > 1 ? { wasmThreads } : {}),
      ...(glue ? glueFeatures(glue) : {}),
      ...(effects ? { effects: true as const } : {}),
      ...(colorPoints ? { colorPoints: true as const } : {}),
      ...(detail ? { detail: true as const } : {}),
      ...(masks ? { masks: { ...masks, kinds: [...masks.kinds] } } : {}),
      ...(perspective ? { perspective: true as const } : {}),
      ...(upright ? { upright: true as const } : {}),
      ...(heal ? { heal: true as const } : {}),
      ...(lens ? { lens: true as const } : {}),
    });
  };

  const activateGlue = (
    loaded: DevelopGlue,
    manifestUrl: string,
    nextRuntime: DevelopEngineRuntime,
    fallbackVersion: string,
  ) => {
    const reported = loaded.version();
    glue = loaded;
    version = typeof reported === "string" && reported ? reported : fallbackVersion;
    runtime = nextRuntime;
    effects = acceptsEffectSettings(loaded.validateSettings);
    colorPoints = loaded.colorSampling && acceptsColorPointSettings(loaded.validateSettings);
    detail = acceptsDetailSettings(loaded.validateSettings);
    masks = readMaskCapabilities(loaded);
    perspective = loaded.geometry !== null && acceptsPerspectiveSettings(loaded.validateSettings);
    upright = perspective && loaded.upright;
    heal = acceptsHealSettings(loaded.validateSettings);
    lens = acceptsLensSettings(loaded.validateSettings);
    helperManifestUrl = manifestUrl;
  };

  const loadWasm = async (manifestUrl: string, allowThreads = true): Promise<void> => {
    const manifest = await measureAsync("manifestFetch", async () => {
      const response = await deps.fetch(manifestUrl, { cache: "no-cache" });
      if (!response.ok) throw new Error(`develop engine manifest ${response.status}`);
      const parsed = parseDevelopEngineManifest(await response.json(), manifestUrl);
      if (!parsed) throw new Error("develop engine manifest is invalid");
      return parsed;
    });
    const environment = deps.threadsEnvironment?.();
    // Safari と iOS のブラウザは WebKit の Worker pool が遅くなり続ける計測結果がある（#148）。アプリ内の WKWebView（Mac・iPad の
    // desktop 表示）は Safari の語を持たないので、Chrome 系でない AppleWebKit も WebKit とみなす（#175）。
    const webkit = environment && (/iPhone|iPad|iPod/i.test(environment.userAgent) ||
      (/Safari|AppleWebKit/i.test(environment.userAgent) && !/Chrome|Chromium|Edg/i.test(environment.userAgent)));
    const cores = environment?.hardwareConcurrency ?? 0;
    const threadedFiles = manifest.threads;
    if (allowThreads && threadedFiles && environment?.isolated && !webkit && Number.isFinite(cores) && cores >= 4) {
      const count = Math.min(8, Math.floor(cores));
      try {
        const module = await measureAsync("glueImport", () => deps.importModule(threadedFiles.jsUrl));
        const threaded = readGlue(module);
        if (!threaded || !isRecord(module) || typeof module.initThreadPool !== "function") {
          throw new Error("threaded develop engine glue is invalid");
        }
        await measureAsync("wasmInit", async () => {
          const output = await threaded.init({ module_or_path: threadedFiles.wasmUrl });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              (module.initThreadPool as (threads: number) => Promise<unknown>)(count),
              // Client 全体の初期化期限は20秒。単一版を再読込する時間を残す。
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("thread pool timed out")), 5_000); }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
          wasmMemory = () => readMemoryBuffer(output);
        });
        wasmThreads = count;
        activateGlue(threaded, manifestUrl, "wasm-threads", manifest.version);
        return;
      } catch {
        // 配布物の不整合、メモリ不足、pool 起動失敗でも単一 wasm の画素を使う。
      }
    }
    const loaded = await measureAsync("glueImport", async () => {
      const parsed = readGlue(await deps.importModule(manifest.jsUrl));
      if (!parsed) throw new Error("develop engine glue is invalid");
      return parsed;
    });
    await measureAsync("wasmInit", async () => {
      const output = await loaded.init({ module_or_path: manifest.wasmUrl });
      wasmMemory = () => readMemoryBuffer(output);
    });
    wasmThreads = 1;
    activateGlue(loaded, manifestUrl, "wasm", manifest.version);
  };

  const flushNativeClient = () => {
    try {
      nativeReleaseClient?.();
    } catch {
      // sidecar が落ちた後の一括解放は失敗してよい。close / wasm への切替は続ける。
    }
  };

  const releaseNativeClient = () => {
    flushNativeClient();
    nativeReleaseClient = null;
  };

  const loadNative = async (manifestUrl: string): Promise<void> => {
    const module = deps.createNativeGlue?.();
    const loaded = readGlue(module);
    if (!loaded) throw new Error("native develop engine glue is invalid");
    nativeReleaseClient =
      isRecord(module) && typeof module.releaseClient === "function"
        ? (module.releaseClient as () => unknown).bind(module)
        : null;
    await loaded.init({ module_or_path: manifestUrl });
    wasmMemory = () => null;
    wasmThreads = 1;
    activateGlue(loaded, manifestUrl, "native", "");
  };

  const init = async (
    id: number,
    manifestUrl: string,
    enableDiagnostics: boolean,
    preferNative: boolean,
    nextDeviceClass: DevelopEngineDeviceClass,
    nextDisposable: boolean,
  ): Promise<void> => {
    diagnostics = enableDiagnostics;
    deviceClass = nextDeviceClass;
    disposable = nextDisposable;
    enforceMemoryBudget();
    activeManifestUrl = manifestUrl;
    if (glue) {
      postReady(id);
      return;
    }
    if (unavailableReason !== null) {
      deps.post({ type: "unavailable", id, reason: unavailableReason });
      return;
    }
    try {
      if (disposable) {
        // 使い捨ての worker は単一スレッドの wasm で描く（native の sidecar・thread pool を起こさない。#155）
        await loadWasm(manifestUrl, false);
      } else if (preferNative && deps.createNativeGlue) {
        try {
          await loadNative(manifestUrl);
        } catch {
          releaseNativeClient();
          await loadWasm(manifestUrl, false);
        }
      } else {
        await loadWasm(manifestUrl);
      }
      postReady(id);
    } catch (error) {
      unavailableReason = errorMessage(error);
      deps.post({ type: "unavailable", id, reason: unavailableReason });
    }
  };

  const requireGlue = (): DevelopGlue => {
    if (!glue) throw new Error(unavailableReason ?? "develop engine is not initialized");
    return glue;
  };

  /** 幾何の口（glue に揃っていなければ error）。 */
  const requireGeometry = (): DevelopGeometryGlue => {
    const geometry = requireGlue().geometry;
    if (!geometry) throw new Error("develop engine cannot read geometry");
    return geometry;
  };

  /** 作業コピーを開く（glue に `openWorkingCopy` が無ければ error）。 */
  const openWorkingCopy = (png: ArrayBuffer, metaJson: string): DevelopDeveloper => {
    const opener = requireGlue().openWorkingCopy;
    if (!opener) throw new Error("develop engine cannot open working copies");
    return opener(new Uint8Array(png), metaJson);
  };

  /** native の現在状態を捨て、同じ入力・面を wasm の Developer に作り直す。 */
  const fallbackToWasm = async (): Promise<void> => {
    const manifestUrl = activeManifestUrl;
    if (runtime !== "native" || !manifestUrl) throw new Error("develop engine cannot fall back to wasm");
    const input = currentOpenInput;
    const key = currentKey;
    const analysisKey = currentAnalysisKey;
    const analysisSettingsJson = currentAnalysisSettingsJson;
    const surfaces = [...heldSurfaces].map(([surfaceId, png]) => [surfaceId, new Uint8Array(png)] as const);

    dropAnalysisAhead();
    releaseThumbnailSession();
    heldSurfaces.clear();
    thumbnailSurfaces.clear();
    if (developer) cacheAnalysisFromDeveloper(developer, key, analysisKey, analysisSettingsJson);
    freeQuietly(developer);
    developer = null;
    for (const photo of kept.splice(0)) freeKept(photo);
    currentKey = null;
    currentAnalysisKey = null;
    currentAnalysisSettingsJson = null;
    glue = null;
    releaseNativeClient();

    await loadWasm(manifestUrl, false);
    if (!input) {
      currentOpenInput = null;
      return;
    }
    const reopened =
      input.kind === "raster"
        ? new (requireGlue().Developer)(new Uint8Array(input.bytes), input.workingMaxDimension)
        : openWorkingCopy(input.png, input.metaJson);
    adoptDeveloper(reopened, key);
    currentAnalysisKey = analysisKey;
    currentAnalysisSettingsJson = analysisSettingsJson;
    if (input.kind === "workingCopy") holdAnalysisSource(reopened, input.png, input.metaJson);
    for (const [surfaceId, png] of surfaces) {
      if (typeof reopened.setMaskSurface !== "function") throw new Error("develop engine cannot restore mask surfaces");
      reopened.setMaskSurface(surfaceId, png);
      heldSurfaces.set(surfaceId, png);
    }
    currentOpenInput = null;
  };

  const canRetryAfterNativeFailure = (message: DevelopEngineWorkerRequest): boolean =>
    ![
      "init",
      "close",
      "dropMaskSurface",
      "warmAutoSettings",
      "promoteAutoSettings",
      "cancelAutoSettings",
    ].includes(message.type);

  /**
   * 持っている写真は変えず、別の作業コピーを一時的に開いて丁寧に描き（final）、手放す。画素は手放す前に transfer できる
   * ArrayBuffer にする。
   */
  const renderWorkingCopyOnce = (
    png: ArrayBuffer,
    metaJson: string,
    settingsJson: string,
    maxDimension: number,
    surfaces: readonly DevelopMaskSurfacePng[] = [],
  ): { width: number; height: number; rgba: ArrayBuffer } =>
    retryAllocationOnce(() => {
      const working = openWorkingCopy(png, metaJson);
      try {
        if (surfaces.length > 0) setExportSurfaces(working, surfaces);
        const frame = readFrame(working.render(settingsJson, maxDimension, false));
        return { width: frame.width, height: frame.height, rgba: transferableBuffer(frame.rgba, wasmMemory()) };
      } finally {
        try {
          working.free();
        } catch {
          // 手放すときの失敗で、描いた結果を捨てない
        }
      }
    });

  /**
   * 使い捨ての worker で描くか（#155）: wasm で、開いている写真・解析の bytes・動いている補助の worker と書き出しを合わせると、
   * `totalBytes`（高水位が既に上なら、払った高水位）を超えて高水位を上げてしまい、端末の予算が `overflow: "worker"`（PC）のとき。
   * native・使い捨ての worker の中・作る口や manifest が無ければ、この worker で描く。
   */
  const exportNeedsWorker = (estimate: number): boolean => {
    if (runtime === "native" || disposable || !deps.createExportWorker || activeManifestUrl === null) return false;
    const budget = memoryBudget();
    const minimumHeld =
      (developer ? developerMemoryBytes(developer.width, developer.height) : 0) + analysisBytesTotal + helperBytes();
    return budget.overflow === "worker" && minimumHeld + estimate > Math.max(budget.totalBytes, wasmHighWater());
  };

  /**
   * 使い捨ての worker を起こして書き出しを 1 回描かせ、結果を受け取る（どの終わり方でも terminate する）。作れない・起きない
   * （`unavailable`）・`error`・落ちた・`ready` が {@link EXPORT_WORKER_READY_TIMEOUT_MS} 来なければ throw。
   */
  const exportInWorker = async (message: DevelopExportRequest): Promise<DevelopExportResult> => {
    const create = deps.createExportWorker;
    const manifestUrl = activeManifestUrl;
    if (!create || manifestUrl === null) throw new Error("develop engine cannot start an export worker");
    // 応答は届いた順に 1 つずつ受け取る（待つ前に届いた応答は積んでおく）
    const inbox: (DevelopEngineWorkerResponse | null)[] = [];
    let deliver: ((response: DevelopEngineWorkerResponse | null) => void) | null = null;
    const receive = (response: DevelopEngineWorkerResponse | null) => {
      if (response?.type === "perf") return;
      const waiting = deliver;
      deliver = null;
      if (waiting) waiting(response);
      else inbox.push(response);
    };
    const nextResponse = (timeoutMs?: number) =>
      new Promise<DevelopEngineWorkerResponse | null>((resolve) => {
        if (inbox.length > 0) {
          resolve(inbox.shift() ?? null);
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        deliver = (response) => {
          if (timer !== undefined) clearTimeout(timer);
          resolve(response);
        };
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            deliver = null;
            resolve(null);
          }, timeoutMs);
        }
      });
    let worker: DevelopEngineExportWorker | null = null;
    try {
      worker = create(receive);
      if (!worker) throw new Error("develop engine cannot start an export worker");
      worker.post({ type: "init", id: 1, manifestUrl, disposable: true, deviceClass }, []);
      const ready = await nextResponse(EXPORT_WORKER_READY_TIMEOUT_MS);
      if (ready?.type !== "ready") throw new Error("develop engine export worker is unavailable");
      // 入力は写しを transfer する（元は、使い捨ての worker で描けなかったときにこの worker で描くために残す）。面は structured clone
      const request: DevelopExportRequest =
        message.type === "exportJpeg"
          ? { ...message, id: 2, bytes: message.bytes.slice(0) }
          : { ...message, id: 2, png: message.png.slice(0) };
      worker.post(request, [request.type === "exportJpeg" ? request.bytes : request.png]);
      const response = await nextResponse();
      if (response?.type === "jpeg" && response.id === 2) return { type: "jpeg", bytes: response.bytes };
      if (response?.type === "frame" && response.id === 2) {
        return { type: "frame", width: response.width, height: response.height, rgba: response.rgba };
      }
      throw new Error("develop engine export worker failed");
    } finally {
      try {
        worker?.terminate();
      } catch {
        // 終わらせられなくても、結果は送る（描けなかったらこの worker で描く）
      }
    }
  };

  /**
   * 書き出し 1 回の置き場所を決める（#155）。使い捨ての worker で描けたら、結果を元の id で送って true（持つ物は手放さない）。
   * この worker で描くなら false: 持つ物と見積もりが予算に収まるまで手放す。使い捨ての worker で描けなかったら、持つ物を全部
   * 手放す（allocation failure の再試行と同じ）。
   */
  const placeExport = async (message: DevelopExportRequest, estimate: number): Promise<boolean> => {
    if (!exportNeedsWorker(estimate)) {
      prepareTemporaryExport(estimate);
      return false;
    }
    let result: DevelopExportResult | null = null;
    try {
      result = await measureAsync("exportWorker", () => exportInWorker(message));
    } catch {
      result = null;
    }
    if (!result) {
      releaseRecreatableMemory();
      return false;
    }
    if (result.type === "jpeg") {
      deps.post({ type: "jpeg", id: message.id, bytes: result.bytes }, [result.bytes]);
    } else {
      const { width, height, rgba } = result;
      deps.post({ type: "frame", id: message.id, width, height, rgba }, [rgba]);
    }
    return true;
  };

  const processMessage = async (message: DevelopEngineWorkerRequest): Promise<void> => {
    const id = message.id;
    switch (message.type) {
        case "init":
          await init(
            id,
            message.manifestUrl,
            message.diagnostics === true,
            message.preferNative === true,
            message.deviceClass === "mobile" ? "mobile" : "pc",
            message.disposable === true,
          );
          return;
        case "open": {
          dropAnalysisAhead();
          const opened = await measureAsync("open", async () => {
            const loaded = requireGlue();
            const key = await inputKey("open", message.bytes, String(message.workingMaxDimension));
            if (reuseDeveloper(key) && developer) return developer;
            enforceMemoryBudget(rasterOpenMemoryBytes(message.workingMaxDimension));
            const next = retryAllocationOnce(
              () => new loaded.Developer(new Uint8Array(message.bytes), message.workingMaxDimension),
            );
            adoptDeveloper(next, key);
            return next;
          });
          currentOpenInput =
            runtime === "native"
              ? { kind: "raster", bytes: message.bytes.slice(0), workingMaxDimension: message.workingMaxDimension }
              : null;
          deps.post({ type: "opened", id, width: opened.width, height: opened.height });
          return;
        }
        case "openWorkingCopy": {
          dropAnalysisAhead();
          const opened = await measureAsync("openWorkingCopy", async () => {
            requireGlue();
            const key = await inputKey("openWorkingCopy", message.png, message.metaJson);
            if (reuseDeveloper(key) && developer) return developer;
            enforceMemoryBudget(workingCopyOpenMemoryBytes(message.png));
            const next = retryAllocationOnce(() => openWorkingCopy(message.png, message.metaJson));
            adoptDeveloper(next, key);
            return next;
          });
          currentOpenInput =
            runtime === "native"
              ? { kind: "workingCopy", png: message.png.slice(0), metaJson: message.metaJson }
              : null;
          holdAnalysisSource(opened, message.png, message.metaJson);
          deps.post({ type: "opened", id, width: opened.width, height: opened.height });
          return;
        }
        case "render": {
          const opened = developer;
          const photoKey = currentKey;
          const nextAnalysisKey = analysisSettingsKeyFromJson(message.settingsJson);
          // 再起動後も同じ写真・解析設定の compact bytes を描画より先に戻す。保存先が遅い/壊れたら再計算する。
          if (opened) await restoreCachedAnalysis(opened, photoKey, nextAnalysisKey, message.settingsJson);
          const { frame, rgba } = measure(message.interactive ? "renderInteractive" : "renderFinal", () => {
            requireGlue();
            if (!opened) throw new Error("no photo is open");
            const frame = readFrame(opened.render(message.settingsJson, message.maxDimension, message.interactive));
            // 初回の描画で作った解析も、補助の先回りを待たずに次の起動へ残す。
            if (nextAnalysisKey !== null && photoKey !== null &&
              !analysisBytes.has(analysisBytesId(photoKey, nextAnalysisKey))) {
              cacheAnalysisFromDeveloper(opened, photoKey, nextAnalysisKey, message.settingsJson);
            }
            // 丁寧に描いた設定から、静かな間に H/S の解析を先に作る（#129。口の無い glue では何もしない）
            if (!message.interactive && typeof opened.prepareAnalysis === "function") {
              analysisAhead = { developer: opened, settingsJson: message.settingsJson };
            }
            if (nextAnalysisKey !== null) {
              if (currentAnalysisKey !== null && nextAnalysisKey !== currentAnalysisKey) {
                releaseThumbnailSession();
                // Session は前の解析を 1 件横に置く（#155 の見積もり）
                analysisAheadHeld.add(opened);
              }
              currentAnalysisKey = nextAnalysisKey;
              currentAnalysisSettingsJson = message.settingsJson;
            }
            return { frame, rgba: transferableBuffer(frame.rgba, wasmMemory()) };
          });
          deps.post({ type: "frame", id, width: frame.width, height: frame.height, rgba }, [rgba]);
          return;
        }
        case "sampleColor": {
          requireGlue();
          const opened = developer;
          if (!opened || typeof opened.sampleColor !== "function") throw new Error("develop engine cannot sample colors");
          const result = opened.sampleColor(message.settingsJson, message.maxDimension, message.x, message.y);
          if (!isRecord(result)) throw new Error("develop engine returned no sampled color");
          const { lightness, chroma, hue } = result;
          if (![lightness, chroma, hue].every((value) => typeof value === "number" && Number.isFinite(value))) {
            throw new Error("develop engine returned an invalid sampled color");
          }
          deps.post({
            type: "sampledColor",
            id,
            lightness: lightness as number,
            chroma: chroma as number,
            hue: hue as number,
          });
          return;
        }
        case "maskPlane": {
          requireGlue();
          const opened = developer;
          if (!opened) throw new Error("no photo is open");
          if (!masks?.maskPlane || typeof opened.maskPlane !== "function") {
            throw new Error("develop engine cannot draw mask planes");
          }
          const plane = readMaskPlane(opened.maskPlane(message.settingsJson, message.maskId, message.maxDimension));
          const data = transferableBuffer(plane.data, wasmMemory());
          deps.post({ type: "maskPlane", id, width: plane.width, height: plane.height, data }, [data]);
          return;
        }
        case "estimateUpright": {
          requireGlue();
          const opened = developer;
          if (!opened) throw new Error("no photo is open");
          if (!upright || typeof opened.estimateUpright !== "function") {
            throw new Error("develop engine cannot estimate upright");
          }
          const resultJson = opened.estimateUpright(message.settingsJson, message.mode);
          if (typeof resultJson !== "string") throw new Error("develop engine returned no upright estimate");
          deps.post({ type: "upright", id, resultJson });
          return;
        }
case "setMaskSurface": {
          requireGlue();
          const opened = developer;
          if (!opened) throw new Error("no photo is open");
          if (!masks?.surfaces || typeof opened.setMaskSurface !== "function") {
            throw new Error("develop engine cannot take mask surfaces");
          }
          const png = new Uint8Array(message.png);
          opened.setMaskSurface(message.surfaceId, png);
          heldSurfaces.set(message.surfaceId, png);
          deps.post({ type: "maskSurfaceSet", id });
          return;
        }
        case "dropMaskSurface": {
          requireGlue();
          heldSurfaces.delete(message.surfaceId);
          if (thumbnailSurfaces.delete(message.surfaceId)) thumbnailSession?.dropMaskSurface?.(message.surfaceId);
          const dropped = developer?.dropMaskSurface?.(message.surfaceId) === true;
          deps.post({ type: "maskSurfaceDropped", id, dropped });
          return;
        }
        case "encodeMaskSurface": {
          const loaded = requireGlue();
          if (!masks?.surfaces || !loaded.encodeMaskSurface || !loaded.maskSurfaceId) {
            throw new Error("develop engine cannot encode mask surfaces");
          }
          const encoded = loaded.encodeMaskSurface(message.width, message.height, new Uint8Array(message.data));
          if (!(encoded instanceof Uint8Array) || encoded.byteLength === 0) throw new Error("develop engine returned no mask surface");
          const surfaceId = loaded.maskSurfaceId(encoded);
          if (typeof surfaceId !== "string" || !/^[0-9a-f]{64}$/.test(surfaceId)) {
            throw new Error("develop engine returned an invalid mask surface id");
          }
          const png = transferableBuffer(encoded, wasmMemory());
          deps.post({ type: "maskSurfaceEncoded", id, surfaceId, png }, [png]);          return;
        }
        case "exportJpeg": {
          const loaded = requireGlue();
          const sourceSize = sourceImageSize(loaded, message.bytes);
          const decodeDimension = oneShotDecodeDimension(loaded, message.settingsJson, sourceSize, message.maxDimension);
          if (await placeExport(message, oneShotExportMemoryBytes(sourceSize, message.settingsJson, decodeDimension))) {
            return;
          }
          if (message.surfaces && message.surfaces.length > 0) {
            // 一発の書き出しは面を持たないので、同じ作業サイズの一時的な Developer に面を渡して描く（持っている写真は変えない）
            const input = new Uint8Array(message.bytes);
            let decodeSize = message.maxDimension;
            if (loaded.geometry) {
              const size = sourceSize ?? readSize(loaded.geometry.imageSize(input));
              const value = loaded.geometry.rasterDecodeSize(
                message.settingsJson,
                size.width,
                size.height,
                message.maxDimension,
                ONE_SHOT_DECODE_CAP,
              );
              if (!isPositiveInteger(value)) throw new Error("develop engine returned an invalid decode size");
              decodeSize = value;
            }
            const bytes = retryAllocationOnce(() => {
              const temporary = new loaded.Developer(input, decodeSize);
              try {
                setExportSurfaces(temporary, message.surfaces ?? []);
                if (typeof temporary.exportJpeg !== "function") throw new Error("develop engine cannot export mask surfaces");
                const jpeg = temporary.exportJpeg(message.settingsJson, message.maxDimension, message.quality);
                if (!(jpeg instanceof Uint8Array) || jpeg.byteLength === 0) throw new Error("develop engine returned no JPEG");
                return transferableBuffer(jpeg, wasmMemory());
              } finally {
                freeQuietly(temporary);
              }
            });
            deps.post({ type: "jpeg", id, bytes }, [bytes]);
            return;
          }
          const jpeg = retryAllocationOnce(() =>
            loaded.exportJpeg(
              new Uint8Array(message.bytes),
              message.settingsJson,
              message.maxDimension,
              message.quality,
            ),
          );
          if (!(jpeg instanceof Uint8Array) || jpeg.byteLength === 0) throw new Error("develop engine returned no JPEG");
          const bytes = transferableBuffer(jpeg, wasmMemory());
          deps.post({ type: "jpeg", id, bytes }, [bytes]);
          return;
        }
        case "exportWorkingCopyJpeg": {
          requireGlue();
          const estimate = workingCopyExportMemoryBytes(message.png, message.settingsJson, message.maxDimension);
          if (await placeExport(message, estimate)) return;
          const { width, height, rgba } = renderWorkingCopyOnce(
            message.png,
            message.metaJson,
            message.settingsJson,
            message.maxDimension,
            message.surfaces,
          );
          let jpeg: ArrayBuffer | null = null;
          try {
            jpeg = deps.encodeJpeg ? await deps.encodeJpeg(width, height, rgba, message.quality) : null;
          } catch {
            // Worker の中で JPEG にできなければ、画素を返してメインスレッドで JPEG にする
            jpeg = null;
          }
          if (jpeg && jpeg.byteLength > 0) {
            deps.post({ type: "jpeg", id, bytes: jpeg }, [jpeg]);
          } else {
            deps.post({ type: "frame", id, width, height, rgba }, [rgba]);
          }
          return;
        }
        case "convertEditSettings": {
          const loaded = requireGlue();
          const resultJson = loaded.convertEditSettings(message.editSettingsJson, message.baseVersion ?? undefined);
          if (typeof resultJson !== "string") throw new Error("develop engine returned no conversion");
          deps.post({ type: "converted", id, resultJson });
          return;
        }
        case "presetSettings": {
          const apply = requireGlue().presetSettings;
          if (!apply) throw new Error("develop engine cannot apply presets");
          const resultJson = measure("presetSettings", () => apply(message.xmp, message.baseSettingsJson));
          if (typeof resultJson !== "string") throw new Error("develop engine returned no preset settings");
          deps.post({ type: "preset", id, resultJson });
          return;
        }
        case "builtinPresets": {
          const list = requireGlue().builtinPresets;
          if (!list) throw new Error("develop engine has no builtin presets");
          const presetsJson = list();
          if (typeof presetsJson !== "string") throw new Error("develop engine returned no builtin presets");
          deps.post({ type: "builtinPresets", id, presetsJson });
          return;
        }
        case "imageSize": {
          const size = readSize(requireGeometry().imageSize(new Uint8Array(message.bytes)));
          deps.post({ type: "size", id, width: size.width, height: size.height });
          return;
        }
        case "rasterDecodeSize": {
          const size = requireGeometry().rasterDecodeSize(
            message.settingsJson,
            message.width,
            message.height,
            message.maxDimension,
            message.cap,
          );
          if (!isPositiveInteger(size)) throw new Error("develop engine returned an invalid decode size");
          deps.post({ type: "decodeSize", id, size });
          return;
        }
        case "geometryOutputSize": {
          const size = readSize(
            requireGeometry().geometryOutputSize(
              message.settingsJson,
              message.sourceWidth,
              message.sourceHeight,
              message.maxDimension,
            ),
          );
          deps.post({ type: "size", id, width: size.width, height: size.height });
          return;
        }
        case "withCaptureExif": {
          const attach = requireGlue().withCaptureExif;
          if (!attach) throw new Error("develop engine cannot write EXIF");
          const jpeg = attach(new Uint8Array(message.bytes), message.capturedAt, message.offsetMinutes);
          if (!(jpeg instanceof Uint8Array) || jpeg.byteLength === 0) throw new Error("develop engine returned no JPEG");
          const bytes = transferableBuffer(jpeg, wasmMemory());
          deps.post({ type: "jpeg", id, bytes }, [bytes]);
          return;
        }
        case "applyPreset": {
          const loaded = requireGlue();
          const apply = loaded.applyPreset;
          if (!apply) throw new Error("develop engine cannot change the preset amount");
          // 撮影時の白は、メタを渡されたらそこから（開いている写真は見ない）、渡されなければ開いている写真から
          const asShot =
            message.asShotMetaJson === undefined
              ? readAsShotWhite(developer)
              : readAsShotWhiteFromMeta(loaded, message.asShotMetaJson);
          const resultJson = apply(message.xmp, message.baseSettingsJson, message.amount, asShot);
          if (typeof resultJson !== "string") throw new Error("develop engine returned no preset settings");
          deps.post({ type: "preset", id, resultJson });
          return;
        }
        case "settingsToXmp": {
          const write = requireGlue().settingsToXmp;
          if (!write) throw new Error("develop engine cannot write presets");
          const resultJson = write(message.settingsJson, message.optionsJson);
          if (typeof resultJson !== "string") throw new Error("develop engine returned no XMP");
          deps.post({ type: "xmp", id, resultJson });
          return;
        }
        case "renderPresetThumbnail": {
          const { frame, rgba } = measure("presetThumbnail", () => {
            if (!requireGlue().presetThumbnails) throw new Error("develop engine cannot render preset thumbnails");
            const opened = developer;
            if (!opened || typeof opened.thumbnail !== "function") throw new Error("no photo is open");
            if (!thumbnailSession) {
              const makeThumbnail = opened.thumbnail.bind(opened);
              // 見本の session の見積もりは親の作業サイズで決まる（作る前に空け、session と一緒に覚える。#155）
              const sessionBytes = thumbnailSessionMemoryBytes(opened.width, opened.height);
              enforceMemoryBudget(sessionBytes);
              thumbnailSession = measure("thumbnailSession", () =>
                retryAllocationOnce(() => makeThumbnail(PRESET_THUMBNAIL_SESSION_MAX_DIMENSION)),
              );
              thumbnailSessionBytes = sessionBytes;
            }
            // 見本の session は面を持たずに始まる: 開いている写真に渡した面をそろえる（面のマスクも見本に描く）
            syncThumbnailSurfaces(thumbnailSession);
            const frame = readFrame(thumbnailSession.render(message.settingsJson, message.maxDimension, false));
            return { frame, rgba: transferableBuffer(frame.rgba, wasmMemory()) };
          });
          deps.post({ type: "frame", id, width: frame.width, height: frame.height, rgba }, [rgba]);
          return;
        }
        case "autoSettings": {
          const settingsJson = measure("autoSettings", () => {
            requireGlue();
            // 開いている写真の session で測る（写真を開いていない・口の無い glue では使えない）
            const opened = developer;
            if (!opened) throw new Error("no photo is open");
            if (typeof opened.autoSettings !== "function") throw new Error("develop engine cannot pick auto settings");
            const result = opened.autoSettings(message.settingsJson);
            if (typeof result !== "string") throw new Error("develop engine returned no auto settings");
            return result;
          });
          deps.post({ type: "auto", id, settingsJson });
          return;
        }
        case "close":
          requireGlue();
          dropAnalysisAhead();
          releaseDeveloper();
          if (runtime === "native") {
            for (const photo of kept.splice(0)) freeKept(photo);
            flushNativeClient();
          }
          currentOpenInput = null;
          deps.post({ type: "closed", id });
          return;
        default:
          throw new Error("unknown develop engine request");
    }
  };

  handle = async (message: DevelopEngineWorkerRequest): Promise<void> => {
    try {
      await processMessage(message);
    } catch (error) {
      if (
        runtime === "native" &&
        deps.isNativeUnavailableError?.(error) === true
      ) {
        try {
          await fallbackToWasm();
          if (canRetryAfterNativeFailure(message)) {
            await processMessage(message);
            return;
          }
        } catch (fallbackError) {
          error = fallbackError;
        }
      }
      deps.post({ type: "error", id: message.id, message: errorMessage(error) });
    }
  };

  return (message) => {
    if (message.type === "warmAutoSettings") {
      // 保留する先読みは 1 件だけにし、置き換えで Worker の待ち行列を増やさない。
      if (warmAuto && warmAuto.id !== message.id) {
        deps.post({ type: "error", id: warmAuto.id, message: "auto settings prefetch superseded" });
      }
      warmAuto = message;
      scheduledWarm = null;
      clearWarmTimer();
      scheduleWarm();
      return Promise.resolve();
    }
    if (message.type === "promoteAutoSettings") {
      if (warmAuto?.id === message.id) {
        clearWarmTimer();
        scheduledWarm = null;
        scheduleWarm(0);
      }
      return Promise.resolve();
    }
    if (message.type === "cancelAutoSettings") {
      if (warmAuto?.id === message.id) {
        warmAuto = null;
        scheduledWarm = null;
        clearWarmTimer();
      }
      return Promise.resolve();
    }

    // 通常要求を保留中の先読み・解析を先に作るより先に処理する。
    normalPending += 1;
    clearWarmTimer();
    clearAnalysisTimer();
    scheduledWarm = null;
    // 受け取った順に 1 つずつ（前の失敗で後を止めない）
    const next = chain
      .then(async () => {
        normalPending = Math.max(0, normalPending - 1);
        await handle(message);
      })
      .catch(() => undefined);
    chain = next;
    void next.then(() => {
      scheduleWarm();
      scheduleAnalysisAhead();
    });
    return next;
  };
}
