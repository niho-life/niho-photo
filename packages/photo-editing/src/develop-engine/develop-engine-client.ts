import { DevelopEngineError, DevelopMaskSurfaceError, developEngineErrorOf } from "./develop-engine-errors";
import { developEngineManifestPath } from "./develop-engine-manifest";
import type {
  DevelopEngineWorkerRequest,
  DevelopEngineWorkerResponse,
  DevelopMaskCapabilities,
  DevelopMaskSurfacePng,
} from "./develop-engine-worker-core";
import {
  createDevelopMaskSurfaceSync,
  developMaskPlaneSurfaceNeeds,
  developMaskSurfaceNeeds,
  type DevelopMaskSurfaceNeed,
  type DevelopMaskSurfaceSource,
} from "./develop-mask-surfaces";
import {
  BROKEN_CONVERSION,
  readBuiltinPresets,
  readConversion,
  readPresetResult,
  readSettingsXmp,
  type DevelopBuiltinPreset,
  type DevelopEditSettingsConversion,
  type DevelopPresetResult,
  type DevelopSettingsXmp,
  type DevelopXmpGroup,
} from "./develop-engine-results";
import {
  developDetailNoise,
  interactiveWorkingCopySettings,
  withoutInertDetail,
  type DevelopDetailNoise,
} from "./develop-detail-preview";
import { readDevelopSettings, type DevelopSettings } from "./develop-settings";
import { readDevelopUprightEstimate, type DevelopUprightEstimate, type DevelopUprightMode } from "./develop-upright";

export type { DevelopMaskCapabilities } from "./develop-engine-worker-core";
export type { DevelopMaskSurfaceSource } from "./develop-mask-surfaces";
export { DevelopEngineError, DevelopMaskSurfaceError, type DevelopMaskSurfaceErrorCode } from "./develop-engine-errors";

export {
  DEVELOP_XMP_DEFAULT_GROUPS,
  type DevelopBuiltinPreset,
  type DevelopEditSettingsConversion,
  type DevelopPresetResult,
  type DevelopSettingsXmp,
  type DevelopXmpGroup,
} from "./develop-engine-results";

/**
 * 段 2 の wasm（Web Worker）をメインスレッドから使う（移行元設計。移行時の設計文書「段 2」）。
 *
 * - `ready()` を初めて呼んだときに Worker を作って wasm を起こす。Worker が無い・manifest や wasm を読めない・時間切れなら
 *   false（呼び出し側は S1 の canvas に黙って戻る）。結果は覚えておく
 * - `render` は最新の要求だけを描く。Worker へ出す描画は同時に 1 つまでで、出している間に来た要求は「次の 1 つ」として持ち、
 *   さらに新しい要求が来たら古い「次」は null で終える（ドラッグ中に古い画を積まない）
 * - `render` の優先度（`priority`。省略時は `interactive` で drag / final）: drag と final は編集の「次」の 1 枠を分け合い、
 *   preview・background はそれぞれ別の 1 枠を持つ。Worker が空いたら 編集 ＞ preview ＞ background の順に出す（出している
 *   描画は横取りしない。移行元設計。使い分けは F2）。preview・background は編集が静かな間だけ出す: 編集の描画が終わってから
 *   {@link DEVELOP_PREVIEW_QUIET_MS} の間と、`yieldToEdit`（プリセットを押した・乗せた）から同じ時間は持ったまま待つ（見本 1 枚は
 *   Worker を数百 ms 占め、出した描画は横取りできないので、編集の描画を見本の後ろで待たせない。#126）
 * - 診断（`?photoDevelopPerf=1`）の間は、描画 1 つごとに枠での待ちと Worker との往復を `[photo-develop-perf]` に出す
 *   （{@link DevelopEngineRenderPerfRecord}。Worker の中の区間は Worker が出す）
 * - `exportJpeg`（記事用の画像・書き出し）と `convertEditSettings`（Photo Bench の補正の変換）は捨てずに順に処理する
 * - 作業コピー（RAW など、移行元設計）は `openWorkingCopy` で開いて持ち、`exportWorkingCopyJpeg` で持っている写真を変えずに JPEG に
 *   する（Worker の中で JPEG にできなければ、返ってきた画素をメインスレッドの canvas で JPEG にする）
 * - `dispose()` は描き途中の記事用の画像を描き終えてから Worker を止める
 * - `presetSettings`（XMP のプリセットを `developSettings` に当てる）と `builtinPresets`（crate に同梱したプリセット）は NIHO
 *   Desktop の段 2 の写真が使う（移行元設計 S7b）。捨てずに順に処理する
 * - 幾何（切り抜き・回転。F3 移行元設計）の口 `imageSize`・`rasterDecodeSize`・`geometryOutputSize` は、wasm に揃っているとき
 *   （`supportsGeometry()`。crate 0.5.0 から）だけ使える。捨てずに順に処理し、描画の枠・書き出しの数え方には入らない
 * - 効果（白黒・周辺光量補正・粒子。E1 移行元設計）は口が増えないので、Worker が起こした wasm に効果のある設定（`v: 3`）を
 *   読めるか確かめさせる（`supportsEffects()`。版の比較ではない: 画面と wasm の公開が前後すると、効果のある設定を保存したのに
 *   描けない写真ができる。移行元設計）。読めない wasm では、画面は項目を出さない
 * - ディテール（シャープ・ノイズ軽減。v6。Issue #32）も同じく `supportsDetail()` で確かめる。量の無い `detail` は外して送る。
 *   16bit PNG の作業コピー（RAW など）を開いている間は、drag 中（interactive）の描画で NR を計算し直さない（旧 RAW・raster は
 *   `detail` を外し、signed RAW は直前の確定描画の NR のまま。`develop-detail-preview.ts`・`docs/detail-processing.md`）。確定描画・
 *   見本・色取得・書き出しは今の値を送る
 * - `withCaptureExif`（書き出しの JPEG に撮影日時の EXIF を付ける。F7b 移行元設計）は `exportJpeg` と同じく捨てずに順に処理し、
 *   書き出しとして数える（`dispose` は付け終えるまで待つ）。wasm に無ければ reject（呼び出し側は EXIF 無しで続ける）
 * - プリセットの適用量（`applyPreset`）・今の補正の書き出し（`settingsToXmp`）・見本（`renderPresetThumbnail`）は、口が wasm に
 *   あるとき（`supportsPresetAmount()` / `supportsSettingsToXmp()` / `supportsPresetThumbnails()`。F2a 移行元設計）だけ使える。
 *   `applyPreset`・`settingsToXmp` は捨てずに順に処理し、見本は描画の preview の枠（編集の描画の後。写真を開き直す・閉じると
 *   null で終える）
 * - 自動（`autoSettings`。開いている写真の `Developer.autoSettings`、F4a 移行元設計）は、口が wasm にあるとき（`supportsAuto()`）だけ
 *   使える。捨てずに順に処理し、描画の枠には入らない
 * - 開いている写真なしでプリセットを当てる（一覧の一括。F5a-2 移行元設計）: `applyPreset` に `{ workMetaJson }` を渡すと、撮影時の白を
 *   開いている写真ではなく作業コピーのメタ（JPEG / PNG は null）から引く。口（`asShotWhiteFromMeta`）が wasm にあるとき
 *   （`supportsPresetFromMeta()`）だけ使える。省けば今までどおり開いている写真の白
 * - 部分補正（マスク。`docs/local-adjustments.md`）: `supportsMasks()` は Worker が起こした wasm の `capabilities()`（描ける種類・
 *   枚数・面の口。口の無い古い wasm は null）。`maskPlane` は 1 枚のマスクの面（重ね表示）で、Worker へ出すのは同時に 1 つまで、
 *   出している間に来た要求は「次の 1 つ」として持ち（さらに新しい要求が来たら古い「次」は null）、描画の枠は使わない（描画を
 *   取り消さない・追い越さない）。写真を開き直す・閉じると、出している面の結果は捨て、「次」は null で終える
 * - Upright（`estimateUpright`。開いている写真の `Developer.estimateUpright`、niho-photo#46 後半）は、口が wasm にあり遠近も描けるとき
 *   （`supportsUpright()`）だけ使える。`sampleColor` と同じく捨てずに順に処理し、描画の枠には入らない
 * - 修復の印（`heal`。niho-photo#44）は描画の設定の一部（口は増やさない）。印を描ける wasm か（`supportsHeal()`）は起こした wasm に
 *   小さな `v: 8` の設定を確かめさせて分かる
 * - 面（ブラシ・被写体・空のマスク。`docs/local-adjustments.md`「面の受け渡し」。M4 #68。`supportsMasks()` の `surfaces`）:
 *   `render`・見本・`maskPlane` は、描く前に要る面（描かれる面のマスク。重ね表示はそのマスク）を開いている写真の wasm に持たせる
 *   （`develop-mask-surfaces.ts`。読み口は `maskSurfaces`〔写真の出どころ〕。1 回渡したら覚え、16 枚を超えたら使ったのが古い面から
 *   手放す。写真を開き直したら渡し直す）。読んでいる間は Worker へ出さず、同じ枠の新しい要求が来たら null で終える（描画の枠の
 *   「次」と同じ。出している描画は取り消さない）。読めない面は {@link DevelopMaskSurfaceError}（マスクの id 付き）で reject し、
 *   面を外して描かない。`setMaskSurface` / `dropMaskSurface` は直接渡す・手放す、`encodeMaskSurface` は面の値を PNG と id にする。
 *   `exportJpeg` / `exportWorkingCopyJpeg` は描かれる面のマスクがあれば面を添えて出す（Worker が一時的な Developer で描く。読み口は
 *   `options.maskSurfaces`、無ければ覚えた PNG と開いている写真の読み口）。そのときも書き出しとして数え（`dispose` は描き終えるまで
 *   待つ）、面を読み終えてから Worker へ出す
 */

/** `applyPreset` の撮影時の白の出どころ（省くと開いている写真）。 */
export type DevelopPresetAsShotSource = {
  /** 作業コピーのメタの JSON（`work/download` の `work.meta`）。RAW 以外の写真（JPEG / PNG）は null（撮影時の白なし） */
  workMetaJson: string | null;
};

export type DevelopFrame = { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> };
export type DevelopSampledColor = { lightness: number; chroma: number; hue: number };
/** 1 枚のマスクの面（`width·height` byte。`round(重み / 65536 · 255)`、行優先、`invert` 込み、`enabled` に依らない）。 */
export type DevelopMaskPlane = { width: number; height: number; data: Uint8Array<ArrayBuffer> };

/**
 * 描画の優先度。`drag`（つまみを動かしている間の速い描き方）と `final`（離した後の丁寧な 1 枚）は編集の 1 枠、`preview`（一覧の
 * 下絵など）と `background`（先読みなど）はそれぞれ別の 1 枠。
 */
export type DevelopRenderPriority = "drag" | "final" | "preview" | "background";

export type DevelopRenderOptions = {
  maxDimension: number;
  interactive: boolean;
  /** プリセットの一時的な最初の画だけ、小さい見本用 session で先に描く。 */
  fastPresetPreview?: boolean;
  /** 省略時は `interactive ? "drag" : "final"` */
  priority?: DevelopRenderPriority;
};

/**
 * 編集の描画（drag / final）が終わってから・`yieldToEdit` から、preview・background の枠（プリセットの見本・補正前の画など）を
 * 出すまでの静かな時間（#126。押した・乗せた・離した直後の次の操作を、見本 1 枚の後ろで待たせない）。
 */
export const DEVELOP_PREVIEW_QUIET_MS = 400;

/**
 * 診断（`?photoDevelopPerf=1`）だけで出す、メインスレッドから見た描画 1 つの待ち（`[photo-develop-perf]`。設定・画素は入れない）。
 * `queuedMs` は描画の枠で Worker へ出すのを待った時間、`roundTripMs` は Worker へ出してから応答が届くまで（Worker の列の待ちと
 * 処理。処理だけの時間は Worker の `renderFinal` などの記録）。`dropped` は写真が変わって捨てた結果。
 */
export type DevelopEngineRenderPerfRecord = {
  stage: "renderRequest" | "presetThumbnailRequest";
  priority: DevelopRenderPriority;
  queuedMs: number;
  roundTripMs: number;
  status: "ok" | "error" | "dropped";
};

export type DevelopAutoSettingsWarm = {
  /** 先読みの結果。取消時は reject されるので、呼び出し側で静かに捨てる。 */
  promise: Promise<DevelopSettings>;
  /** 「自動」を押したら、Worker が空いた時点で先読みを優先する。 */
  promote: () => void;
  /** 保留中の先読みを取り消し、後続の編集を待たせない。 */
  cancel: () => void;
};

/** 書き出しの描き方（`maskSurfaces` は描かれる面のマスクの面の読み口。省略 = 覚えた PNG と開いている写真の読み口）。 */
export type DevelopExportOptions = { maxDimension: number; quality: number; maskSurfaces?: DevelopMaskSurfaceSource | null };

export type DevelopEngine = {
  /** 使えるか（初回に Worker を作って wasm を起こす。throw しない） */
  ready: () => Promise<boolean>;
  /** 写真を 1 回デコードして持つ（前の写真は手放す。待っている描画は null で終える） */
  open: (bytes: ArrayBuffer, workingMaxDimension: number) => Promise<{ width: number; height: number }>;
  /** 持っている写真を描く。同じ枠の新しい要求に追い越されたら null */
  render: (settings: object, options: DevelopRenderOptions) => Promise<DevelopFrame | null>;
  /** 描画座標の色ミキサー直前の Oklch。座標は表示フレームに対する 0〜1。 */
  sampleColor: (
    settings: object,
    options: { maxDimension: number; x: number; y: number },
  ) => Promise<DevelopSampledColor>;
  /** 別の bytes（オリジナルのコピー）から JPEG を描く。持っている写真は変えない */
  exportJpeg: (bytes: ArrayBuffer, settings: object, options: DevelopExportOptions) => Promise<Uint8Array<ArrayBuffer>>;
  /**
   * 作業コピー（16bit PNG とメタデータの JSON）を開いて持つ（前の写真は手放す。待っている描画は null で終える。長辺 2560px の
   * まま持ち、描く大きさは `render` で決める）
   */
  openWorkingCopy: (png: ArrayBuffer, metaJson: string) => Promise<{ width: number; height: number }>;
  /** 別の作業コピー（コピー）から丁寧に描いて JPEG にする（sRGB・撮影情報なし）。持っている写真は変えない */
  exportWorkingCopyJpeg: (
    png: ArrayBuffer,
    metaJson: string,
    settings: object,
    options: DevelopExportOptions,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /**
   * Photo Bench `EditSettings` を `developSettings` に変換する（壊れた結果は `ok: false`）。作業コピーの上で直す写真は、その
   * `baseVersion` を渡す（変換した設定の `base` になる）
   */
  convertEditSettings: (
    editSettings: object,
    options?: { baseVersion?: string | null },
  ) => Promise<DevelopEditSettingsConversion>;
  /** XMP のプリセットを `baseSettings`（null なら neutral）に当てる（プリセットが持つ項目だけを置き換える）。読めない XMP は reject */
  presetSettings: (xmp: string, baseSettings: object | null) => Promise<DevelopPresetResult>;
  /** crate に同梱したプリセットの一覧 */
  builtinPresets: () => Promise<DevelopBuiltinPreset[]>;
  /**
   * XMP のプリセットを `baseSettings`（当てる直前の設定）に適用量 `amount`（0〜1.5）で当てる（結果 ＝ base ＋ 適用量 ×（100% の
   * 結果 − base）。RAW の絶対のホワイトバランスは開いている写真の撮影時の白から補間する）。`asShot` を渡すと、開いている写真の
   * 白ではなく作業コピーのメタから引く（{@link DevelopPresetAsShotSource}。口の無い wasm では reject）。wasm に無ければ reject
   */
  applyPreset: (
    xmp: string,
    baseSettings: object,
    amount: number,
    asShot?: DevelopPresetAsShotSource,
  ) => Promise<DevelopPresetResult>;
  /** 設定を Lightroom のプリセット（XMP）に書き出す（`groups` を省くと crate の既定の群）。wasm に無ければ reject */
  settingsToXmp: (
    settings: object,
    options: { name: string; groups?: readonly DevelopXmpGroup[] },
  ) => Promise<DevelopSettingsXmp>;
  /**
   * 持っている写真のプリセットの見本を丁寧に描く（見本用の別の session。長辺 `maxDimension` に収める）。描画の preview の枠で
   * 待ち（編集の描画を先に出す）、同じ枠の新しい要求・写真を開き直す・閉じると null。wasm に無ければ reject
   */
  renderPresetThumbnail: (settings: object, maxDimension: number) => Promise<DevelopFrame | null>;
  /**
   * 編集の操作が始まった（プリセットを押した・乗せた）。preview・background の枠の描画（見本など）を、{@link DEVELOP_PREVIEW_QUIET_MS}
   * の間と、その間に来た編集の描画が終わってからさらに同じ時間は出さない（出している描画は止めない）
   */
  yieldToEdit: () => void;
  /** `applyPreset` を使える wasm か（初回に wasm を起こす。使えなければ false。throw しない） */
  supportsPresetAmount: () => Promise<boolean>;
  /** `settingsToXmp` を使える wasm か（初回に wasm を起こす。使えなければ false。throw しない） */
  supportsSettingsToXmp: () => Promise<boolean>;
  /** `renderPresetThumbnail` を使える wasm か（初回に wasm を起こす。使えなければ false。throw しない） */
  supportsPresetThumbnails: () => Promise<boolean>;
  /**
   * 開いている写真なしで `applyPreset` を当てられる wasm か（`applyPreset` と `asShotWhiteFromMeta` がある。一覧の一括のプリセット。
   * F5a-2 移行元設計。初回に wasm を起こす。使えなければ false。throw しない）
   */
  supportsPresetFromMeta: () => Promise<boolean>;
  /**
   * 持っている写真の「自動」: 今の設定 `settings`（プリセットを当てた状態）から、ライト 6 本（露光量・コントラスト・ハイライト・
   * シャドウ・白レベル・黒レベル）と自然な彩度だけを決めた設定（ほかの項目は渡したまま。切り抜きの範囲で測る）。捨てずに順に
   * 処理し、描画の枠は使わない。wasm に無い・写真を開いていない・結果を編集内容として読めなければ reject
   */
  autoSettings: (settings: object) => Promise<DevelopSettings>;
  /** pointer/focus 操作向けの低優先度・取消可能な先読み。 */
  warmAutoSettings?: (settings: object) => DevelopAutoSettingsWarm;
  /**
   * `autoSettings` を使える wasm か（開いた写真の `Developer` に口がある。crate の口が無い公開済みの wasm もある。初回に wasm を
   * 起こす。使えなければ false。throw しない）
   */
  supportsAuto: () => Promise<boolean>;
  /**
   * 幾何（切り抜き・回転）の口が wasm に揃っているか（crate 0.5.0 から。初回に wasm を起こす。使えなければ false。throw しない）。
   * false の wasm は、恒等でない幾何のある設定（`v: 2`）を描かない（`render` が reject）
   */
  supportsGeometry: () => Promise<boolean>;
  /**
   * 効果（白黒・周辺光量補正・粒子）のある設定（`v: 3`）を読める wasm か（Worker が起こした wasm が `validateSettings` で小さな
   * `v: 3` の設定を通すとき。初回に wasm を起こす。使えない・関数が無ければ false。throw しない）。false の wasm は `v: 3` の描画を断る
   */
  supportsEffects: () => Promise<boolean>;
  /** 独立した色ミキサー（`developSettings` v4）を読んで描ける wasm か。 */
  supportsColorPoints: () => Promise<boolean>;
  /** ディテール（シャープ・ノイズ軽減。`developSettings` v6。Issue #32）を読んで描ける wasm か。throw しない */
  supportsDetail: () => Promise<boolean>;
  /**
   * 部分補正（マスク）を描ける種類と枚数（wasm の `capabilities()`。口の無い古い wasm・使えない engine は null。throw しない）。
   * テスト用の engine には無いことがある（無い＝描けない）
   */
  supportsMasks?: () => Promise<DevelopMaskCapabilities | null>;
  /**
   * 持っている写真の 1 枚のマスクの面（`maxDimension` の描画と同じ寸法。幾何込み）。同時に 1 つまで出し、出している間の新しい要求に
   * 追い越された「次」・開き直し・閉じたときは null。面の口の無い wasm・知らない id は reject
   */
  maskPlane?: (settings: object, maskId: string, options: { maxDimension: number }) => Promise<DevelopMaskPlane | null>;
  /**
   * 遠近（`developSettings` v7 の `geometry.perspective`。niho-photo#46）を読んで描ける wasm か（Worker が起こした wasm が
   * `validateSettings` で小さな `v: 7` の設定を通すとき。初回に wasm を起こす。使えなければ false。throw しない）
   */
  supportsPerspective: () => Promise<boolean>;
  /** 開いている写真の wasm に面を渡す（`png` はコピーを Worker へ渡す。Worker が受け取ったら resolve。形の違う面は
   * {@link DevelopMaskSurfaceError}）。以後の描画はこの面を読み直さずに使う。面の口の無い wasm は reject
   */
  setMaskSurface?: (surfaceId: string, png: Uint8Array) => Promise<void>;
  /** 開いている写真の wasm から面を手放す（持っていたら true） */
  dropMaskSurface?: (surfaceId: string) => Promise<boolean>;
  /** 面の値（`width·height` byte、0〜255）を 8bit グレーの PNG と id（sha256）にする（作った PNG は覚える）。面の口の無い wasm は reject */
  encodeMaskSurface?: (width: number, height: number, data: Uint8Array) => Promise<{ id: string; png: Uint8Array<ArrayBuffer> }>;
  /** 面の PNG（覚えた PNG か、開いている写真の読み口から。読めなければ null） */
  maskSurfacePng?: (surfaceId: string) => Promise<Uint8Array | null>;
  /** 開いている写真の面の読み口を替える（null で外す） */
  setMaskSurfaceSource?: (source: DevelopMaskSurfaceSource | null) => void;
  /** 読めなかった面を忘れる（次の描画で読み口を読み直す） */
  retryMaskSurfaces?: () => void;
  /**
   * 持っている写真の Upright: 今の設定 `settings` の枠（90° 回転・反転。角度補正は差し引く）で、写真の直線から遠近の 回転・垂直方向・
   * 水平方向 を推定する（`mode`: 1 自動・2 水平・3 垂直・4 フル）。線が見つからなければ恒等で `reason` 付き。捨てずに順に処理し、
   * 描画の枠は使わない。wasm に無い・写真を開いていない・結果を読めなければ reject
   */
  estimateUpright: (settings: object, mode: DevelopUprightMode) => Promise<DevelopUprightEstimate>;
  /**
   * `estimateUpright` を使える wasm か（開いた写真の `Developer` に口があり、遠近〔v 7〕も描ける。crate 0.23.0 から。初回に wasm を
   * 起こす。使えなければ false。throw しない）
   */
  supportsUpright: () => Promise<boolean>;
  /**
   * 修復の印（`developSettings` v8 の `heal`。niho-photo#44）を読んで描ける wasm か（Worker が起こした wasm が `validateSettings` で
   * 小さな `v: 8` の設定を通すとき。crate 0.24.0 から。初回に wasm を起こす。使えなければ false。throw しない）。false の wasm は印の
   * ある設定を描かない（`unsupportedVersion`）ので、画面は修復の道具を出さない
   */
  supportsHeal: () => Promise<boolean>;
  /**
   * レンズ補正（`developSettings` v9 の `lens`。niho-photo#45）を読んで描ける wasm か（Worker が起こした wasm が `validateSettings` で
   * 小さな `v: 9` の設定を通すとき。crate 0.23.0 から。初回に wasm を起こす。使えなければ false。throw しない）。false の wasm は
   * レンズ補正のある設定を描かない（`unsupportedVersion`）ので、画面は「レンズ」の節を出さない
   */
  supportsLens: () => Promise<boolean>;
  /**
   * JPEG / PNG の寸法（EXIF の向きを反映。ヘッダーだけ読む）。bytes は Worker へコピーで渡す（呼び出し側の ArrayBuffer はそのまま
   * 使える。`open` / `exportJpeg` は手放す）。wasm に無ければ reject
   */
  imageSize: (bytes: ArrayBuffer) => Promise<{ width: number; height: number }>;
  /**
   * `size`（`imageSize`）のオリジナルを `open` する長辺: 設定の切り抜きが `maxDimension` に届く作業サイズ（`cap` が上限。0 は上限
   * なし。幾何が無ければ `maxDimension`）。wasm に無ければ reject
   */
  rasterDecodeSize: (
    settings: object,
    size: { width: number; height: number },
    maxDimension: number,
    cap: number,
  ) => Promise<number>;
  /** 描かずに出力の寸法（`source` は開いた写真の `width` / `height`）。wasm に無ければ reject */
  geometryOutputSize: (
    settings: object,
    source: { width: number; height: number },
    maxDimension: number,
  ) => Promise<{ width: number; height: number }>;
  /**
   * 書き出しの JPEG に NIHO の EXIF（撮影日時・向き 1・sRGB。位置情報・カメラは付けず、前の EXIF は外す）を付けた JPEG。
   * `capturedAt` は写真の `capturedAt`（ISO 8601・UTC）、`offsetMinutes` は表示する時差（日本は 540）。bytes は Worker へ渡して
   * 手放す（失敗したときに元の JPEG を使うなら、呼び出し側がコピーを渡す）。wasm に無ければ reject
   */
  withCaptureExif: (
    jpeg: Uint8Array<ArrayBuffer>,
    capturedAt: string,
    offsetMinutes: number,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /** 持っている写真を手放す */
  close: () => Promise<void>;
  /** 使い終わり（描き途中の JPEG を待ってから Worker を止める。以後の要求は reject） */
  dispose: () => void;
};

export type CreateDevelopEngineOptions = {
  createWorker?: () => Worker | null;
  manifestUrl?: string;
  /** camera だけが指定する native 優先。使えなければ Worker 内で同じ wasm manifest へ戻る。 */
  preferNative?: boolean;
  loadTimeoutMs?: number;
  /** 写真編集タブの ?photoDevelopPerf=1 だけで有効にする Worker 段階診断（明示値はテスト用）。 */
  diagnostics?: boolean;
  /** Worker が返した画素を JPEG にする（テストで差し替える。既定はメインスレッドの canvas） */
  encodeFrameJpeg?: (frame: DevelopFrame, quality: number) => Promise<Uint8Array<ArrayBuffer>>;
  /** 開いている写真の面（ブラシ・被写体・空）の PNG の読み口（写真の出どころの `loadMaskSurface`。省略 = 読めない） */
  maskSurfaces?: DevelopMaskSurfaceSource | null;
  /** preview・background を出すまでの静かな時間（省略は {@link DEVELOP_PREVIEW_QUIET_MS}。0 で待たない。テストで差し替える） */
  previewQuietMs?: number;
};

export function photoDevelopDiagnosticsEnabled(location: { pathname: string; search: string } | null =
  typeof window === "undefined" ? null : window.location): boolean {
  const optedIn = new URLSearchParams(location?.search ?? "").get("photoDevelopPerf") === "1";
  return optedIn && (location?.pathname.endsWith("/photoEditing") === true || location?.pathname === "/");
}

/** wasm を起こすのを諦めるまでの時間。 */
export const DEVELOP_ENGINE_LOAD_TIMEOUT_MS = 20_000;

type Pending = {
  kind:
    | "open"
    | "openWorkingCopy"
    | "exportJpeg"
    | "exportWorkingCopyJpeg"
    | "close"
    | "convertEditSettings"
    | "presetSettings"
    | "builtinPresets"
    | "applyPreset"
    | "settingsToXmp"
    | "autoSettings"
    | "sampleColor"
    | "estimateUpright"
    | "warmAutoSettings"
    | "imageSize"
    | "rasterDecodeSize"
    | "geometryOutputSize"
    | "withCaptureExif"
    | "setMaskSurface"
    | "dropMaskSurface"
    | "encodeMaskSurface";
  resolve: (response: DevelopEngineWorkerResponse) => void;
  reject: (error: unknown) => void;
};

/** 描き終えるまで Worker を止めない仕事（記事用の画像・書き出しの JPEG と、その EXIF）。 */
function isExportKind(kind: Pending["kind"]): boolean {
  return kind === "exportJpeg" || kind === "exportWorkingCopyJpeg" || kind === "withCaptureExif";
}

/** view がちょうど指している ArrayBuffer（一部だけを指していればコピー。transfer で余分を送らない）。 */
function exactArrayBuffer(view: Uint8Array<ArrayBuffer>): ArrayBuffer {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view.buffer : view.slice().buffer;
}

type RenderRequest = {
  /** `render`（持っている写真）か `thumbnail`（見本用の別の session） */
  kind: "render" | "thumbnail";
  settingsJson: string;
  maxDimension: number;
  interactive: boolean;
  fastPresetPreview?: boolean;
  /** 描くのに要る面（待っている間は手放さない） */
  needs: DevelopMaskSurfaceNeed[];
  priority: DevelopRenderPriority;
  /** 枠に入れた時刻（診断の間だけ。ほかは null） */
  requestedAt: number | null;
  resolve: (frame: DevelopFrame | null) => void;
  reject: (error: unknown) => void;
};

type InFlightRender = RenderRequest & { id: number; stale: boolean; sentAt: number | null };

/** マスクの面の要求（同時に 1 つまで出し、「次」は 1 つだけ持つ）。 */
type MaskPlaneRequest = {
  settingsJson: string;
  maskId: string;
  maxDimension: number;
  needs: DevelopMaskSurfaceNeed[];
  resolve: (plane: DevelopMaskPlane | null) => void;
  reject: (error: unknown) => void;
};

/** 面を読み終えるまで Worker へ出さずに待っている要求（同じ枠の新しい要求が来たら null で終える）。 */
type SurfaceWait = { needs: DevelopMaskSurfaceNeed[]; cancelled: boolean; cancel: () => void };
type SurfaceWaitSlot = "edit" | "preview" | "background" | "maskPlane";

type InFlightMaskPlane = MaskPlaneRequest & { id: number; stale: boolean };

/** 「次」を持つ枠（drag と final は編集の 1 枠）。並びは Worker が空いたときに出す順。 */
type RenderSlot = "edit" | "preview" | "background";
const RENDER_SLOT_ORDER: readonly RenderSlot[] = ["edit", "preview", "background"];

function renderSlotOf(priority: DevelopRenderPriority): RenderSlot {
  return priority === "drag" || priority === "final" ? "edit" : priority;
}

/** `ready` の `masks`（Worker が読んだ `capabilities()`）を写す。形が違えば null（描けない扱い）。 */
function readMaskCapabilitiesResponse(value: unknown): DevelopMaskCapabilities | null {
  if (typeof value !== "object" || value === null) return null;
  const { kinds, max, maskPlane, surfaces } = value as Record<string, unknown>;
  if (!Array.isArray(kinds) || typeof max !== "number" || !Number.isInteger(max) || max <= 0) return null;
  const readKinds = kinds.filter((kind): kind is string => typeof kind === "string");
  if (readKinds.length === 0) return null;
  return { kinds: readKinds, max, maskPlane: maskPlane === true, ...(surfaces === true ? { surfaces: true } : {}) };
}

/** プリセットを当てた結果を読む（`settings` が v1 の形でなければ throw）。 */
function presetResultOrThrow(resultJson: string): DevelopPresetResult {
  const result = readPresetResult(resultJson);
  if (!result) throw new DevelopEngineError("develop engine returned invalid preset settings");
  return result;
}

function autoSettingsResponse(response: DevelopEngineWorkerResponse): DevelopSettings {
  if (response.type !== "auto") throw new DevelopEngineError("develop engine returned no auto settings");
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.settingsJson);
  } catch {
    parsed = null;
  }
  const result = readDevelopSettings(parsed);
  if (!result) throw new DevelopEngineError("develop engine returned invalid auto settings");
  return result;
}

/** Worker の中で JPEG にできなかった画素を、メインスレッドの canvas で JPEG にする（sRGB のまま・撮影情報なし）。 */
async function encodeFrameJpegWithCanvas(frame: DevelopFrame, quality: number): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof document === "undefined") throw new DevelopEngineError("develop engine cannot encode JPEG");
  const canvas = document.createElement("canvas");
  try {
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext("2d");
    if (!context) throw new DevelopEngineError("develop engine cannot encode JPEG");
    context.putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality / 100));
    if (!blob) throw new DevelopEngineError("develop engine cannot encode JPEG");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

function createDefaultWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./develop-engine.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

function defaultManifestUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URL(developEngineManifestPath(), window.location.origin).href;
  } catch {
    return null;
  }
}

export function createDevelopEngine(options: CreateDevelopEngineOptions = {}): DevelopEngine {
  const loadTimeoutMs = options.loadTimeoutMs ?? DEVELOP_ENGINE_LOAD_TIMEOUT_MS;
  let worker: Worker | null = null;
  let readyPromise: Promise<boolean> | null = null;
  let settleReady: ((ready: boolean) => void) | null = null;
  let initId: number | null = null;
  let status: "idle" | "loading" | "ready" | "unavailable" | "disposed" = "idle";
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let inFlightRender: InFlightRender | null = null;
  const queuedRenders: Record<RenderSlot, RenderRequest | null> = { edit: null, preview: null, background: null };
  // 編集が静かになるまでの待ち（`DEVELOP_PREVIEW_QUIET_MS`。動いている間は preview・background を出さない。#126）
  const previewQuietMs = options.previewQuietMs ?? DEVELOP_PREVIEW_QUIET_MS;
  let editQuietTimer: ReturnType<typeof setTimeout> | null = null;
  const diagnosticsEnabled = () => options.diagnostics ?? photoDevelopDiagnosticsEnabled();
  const perfNow = (): number | null => (diagnosticsEnabled() ? performance.now() : null);
  let exportsInFlight = 0;
  let terminateWhenIdle = false;
  let closeBeforeTerminate = false;
  let finishDispose = () => terminate("disposed");
  // 幾何の口が wasm に揃っている（`ready` の応答で分かる）
  let geometrySupported = false;
  // 効果（白黒・周辺光量補正・粒子）を描ける版の crate（`ready` の応答の版で分かる）
  let effectsSupported = false;
  let colorPointsSupported = false;
  let detailSupported = false;
  // ディテール（シャープ・ノイズ軽減。Issue #32）の送り方（develop-detail-preview.ts）。16bit PNG の作業コピー（RAW など）を開いて
  // いる間は、drag 中の描画で NR を計算し直さない（signed RAW は直前の確定描画の NR のまま）。確定描画・見本・色取得・書き出しは
  // 今の値を送る。量の無い detail はどの写真でも外す
  let workingCopyOpened = false;
  let committedNoise: DevelopDetailNoise | null = null;
  const previewSettingsJson = (settings: object, interactive: boolean): string => {
    const record = settings as Record<string, unknown>;
    if (!workingCopyOpened || !interactive) {
      const sent = withoutInertDetail(record);
      if (workingCopyOpened) committedNoise = developDetailNoise(sent);
      return JSON.stringify(sent);
    }
    return JSON.stringify(interactiveWorkingCopySettings(record, committedNoise));
  };
  const finalSettingsJson = (settings: object): string => JSON.stringify(withoutInertDetail(settings as Record<string, unknown>));
  let perspectiveSupported = false;
  // Upright の口が wasm の `Developer` にあり、遠近も描ける（`ready` の応答で分かる）
  let uprightSupported = false;
  // 修復の印（v8）を描ける wasm（`ready` の応答で分かる）
  let healSupported = false;
  // レンズ補正（v9）を描ける wasm（`ready` の応答で分かる）
  let lensSupported = false;
  // プリセットの適用量・書き出し・見本の口が wasm にある（`ready` の応答で分かる）
  let presetAmountSupported = false;
  let settingsToXmpSupported = false;
  let presetThumbnailsSupported = false;
  // 「自動」の口が wasm の `Developer` にある（`ready` の応答で分かる）
  let autoSupported = false;
  // 開いている写真なしでプリセットを当てる口（`asShotWhiteFromMeta`）が wasm にある（`ready` の応答で分かる）
  let presetFromMetaSupported = false;
  // 描ける部分補正（`ready` の応答の `masks`。無ければ null）
  let maskCapabilities: DevelopMaskCapabilities | null = null;
  // 出しているマスクの面と、その間に来た「次」（描画の枠とは別）
  let inFlightMaskPlane: InFlightMaskPlane | null = null;
  let queuedMaskPlane: MaskPlaneRequest | null = null;
  // 開いている写真の面の読み口と、面を読み終えるまで待っている要求（枠ごとに 1 つ）
  let maskSurfaceSource: DevelopMaskSurfaceSource | null = options.maskSurfaces ?? null;
  const surfaceWaits: Record<SurfaceWaitSlot, SurfaceWait | null> = { edit: null, preview: null, background: null, maskPlane: null };

  const unavailableError = () =>
    new DevelopEngineError(status === "disposed" ? "develop engine is disposed" : "develop engine is unavailable");

  const post = (message: DevelopEngineWorkerRequest, transfer: Transferable[] = []) => {
    if (!worker) throw unavailableError();
    worker.postMessage(message, transfer);
  };

  /** 面の口のある wasm か（`ready` の応答の `masks.surfaces`）。 */
  const surfacesSupported = () => maskCapabilities?.surfaces === true;

  /** Worker へ面を渡す（受け取ったら resolve）。 */
  const postMaskSurface = async (surfaceId: string, png: Uint8Array): Promise<void> => {
    const response = await request("setMaskSurface", (id) => {
      const buffer = png.slice().buffer;
      return { message: { type: "setMaskSurface", id, surfaceId, png: buffer }, transfer: [buffer] };
    });
    if (response.type !== "maskSurfaceSet") throw new DevelopEngineError("develop engine did not take the mask surface");
  };

  const surfaces = createDevelopMaskSurfaceSync({
    set: postMaskSurface,
    drop: (surfaceId) => {
      void request("dropMaskSurface", (id) => ({ message: { type: "dropMaskSurface", id, surfaceId } })).catch(() => undefined);
    },
    source: () => maskSurfaceSource,
  });

  /** 待っている・持っている「次」の要求が要る面（上限で手放さない）。 */
  const pinnedSurfaceIds = (): Set<string> => {
    const ids = new Set<string>();
    const add = (needs: readonly DevelopMaskSurfaceNeed[] | undefined) => {
      for (const need of needs ?? []) ids.add(need.surface.id);
    };
    for (const wait of Object.values(surfaceWaits)) add(wait?.needs);
    for (const slot of RENDER_SLOT_ORDER) add(queuedRenders[slot]?.needs);
    add(queuedMaskPlane?.needs);
    return ids;
  };

  /** 面を待っている要求をすべて null で終える（写真が変わる・止める）。 */
  const dropSurfaceWaits = () => {
    for (const slot of Object.keys(surfaceWaits) as SurfaceWaitSlot[]) {
      const wait = surfaceWaits[slot];
      surfaceWaits[slot] = null;
      wait?.cancel();
    }
  };

  /**
   * 要る面を wasm に持たせてから `start` する。持っていればそのまま（同期のまま出す）。読んでいる間は待ち、同じ枠の新しい要求が
   * 来たら null で終える。読めなければ {@link DevelopMaskSurfaceError} で reject。
   */
  const afterSurfaces = <T>(
    slot: SurfaceWaitSlot,
    needs: DevelopMaskSurfaceNeed[],
    start: () => Promise<T | null>,
  ): Promise<T | null> => {
    const previous = surfaceWaits[slot];
    surfaceWaits[slot] = null;
    previous?.cancel();
    if (surfaces.unheld(needs).length === 0) {
      surfaces.touch(needs);
      return start();
    }
    return new Promise<T | null>((resolve, reject) => {
      const wait: SurfaceWait = {
        needs,
        cancelled: false,
        cancel: () => {
          wait.cancelled = true;
          resolve(null);
        },
      };
      surfaceWaits[slot] = wait;
      surfaces.ensure(needs, pinnedSurfaceIds).then(
        () => {
          if (wait.cancelled) return;
          if (surfaceWaits[slot] === wait) surfaceWaits[slot] = null;
          start().then(resolve, reject);
        },
        (error: unknown) => {
          if (wait.cancelled) return;
          if (surfaceWaits[slot] === wait) surfaceWaits[slot] = null;
          reject(error);
        },
      );
    });
  };

  /** 書き出しに添える面（描かれる面のマスクの PNG。読めなければ {@link DevelopMaskSurfaceError}）。 */
  const exportSurfaces = async (
    settings: object,
    source: DevelopMaskSurfaceSource | null | undefined,
  ): Promise<DevelopMaskSurfacePng[]> => {
    const result: DevelopMaskSurfacePng[] = [];
    const seen = new Set<string>();
    for (const need of developMaskSurfaceNeeds(settings)) {
      if (seen.has(need.surface.id)) continue;
      seen.add(need.surface.id);
      const png = await surfaces.png(need.surface.id, source === undefined ? maskSurfaceSource : source);
      if (!png) throw new DevelopMaskSurfaceError("maskSurfaceMissing", { maskId: need.maskId, surfaceId: need.surface.id });
      result.push({ id: need.surface.id, png: png.slice().buffer });
    }
    return result;
  };

  /** 写真を切り替えるとき、まだ消費していない自動補正の先読みを取り消す。 */
  const cancelWarmAutoSettings = () => {
    for (const [id, entry] of pending) {
      if (entry.kind !== "warmAutoSettings") continue;
      pending.delete(id);
      try {
        post({ type: "cancelAutoSettings", id });
      } catch {
        // ローカルの待機は取り除いた。Worker が終了済みなら取り消し要求は不要。
      }
      entry.reject(new DevelopEngineError("auto settings prefetch cancelled"));
    }
  };

  /** 持っている「次」をすべて null で終える。 */
  const dropQueuedRenders = () => {
    for (const slot of RENDER_SLOT_ORDER) {
      const queued = queuedRenders[slot];
      queuedRenders[slot] = null;
      queued?.resolve(null);
    }
  };

  /** Worker を止め、待っているものをすべて終える（描画は null、ほかは reject）。 */
  const terminate = (nextStatus: "unavailable" | "disposed") => {
    status = nextStatus;
    const current = worker;
    worker = null;
    try {
      current?.terminate();
    } catch {
      // 止めるときの失敗で、待っている呼び出し側を止めない
    }
    settleReady?.(false);
    settleReady = null;
    const error = unavailableError();
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    exportsInFlight = 0;
    if (inFlightRender && !inFlightRender.stale) inFlightRender.resolve(null);
    inFlightRender = null;
    if (editQuietTimer !== null) clearTimeout(editQuietTimer);
    editQuietTimer = null;
    dropQueuedRenders();
    dropMaskPlanes();
    dropSurfaceWaits();
    surfaces.reset();
  };

  /** 出しているマスクの面の結果は捨て（null）、「次」は null で終える（写真が変わる・止める）。 */
  const dropMaskPlanes = () => {
    if (inFlightMaskPlane && !inFlightMaskPlane.stale) {
      inFlightMaskPlane.stale = true;
      inFlightMaskPlane.resolve(null);
    }
    const queued = queuedMaskPlane;
    queuedMaskPlane = null;
    queued?.resolve(null);
  };

  const sendMaskPlane = (request: MaskPlaneRequest) => {
    const id = nextId++;
    inFlightMaskPlane = { ...request, id, stale: false };
    try {
      post({
        type: "maskPlane",
        id,
        settingsJson: request.settingsJson,
        maskId: request.maskId,
        maxDimension: request.maxDimension,
      });
    } catch (error) {
      inFlightMaskPlane = null;
      request.reject(error);
    }
  };

  /** 出していた面が終わったら、持っていた「次」を出す。 */
  const finishMaskPlane = () => {
    inFlightMaskPlane = null;
    const next = queuedMaskPlane;
    queuedMaskPlane = null;
    if (next) sendMaskPlane(next);
  };

  const sendRender = (request: RenderRequest) => {
    const id = nextId++;
    const entry: InFlightRender = { ...request, id, stale: false, sentAt: request.requestedAt === null ? null : performance.now() };
    inFlightRender = entry;
    try {
      post(
        request.kind === "thumbnail"
          ? { type: "renderPresetThumbnail", id, settingsJson: request.settingsJson, maxDimension: request.maxDimension }
          : {
              type: "render",
              id,
              settingsJson: request.settingsJson,
              maxDimension: request.maxDimension,
              interactive: request.interactive,
              fastPresetPreview: request.fastPresetPreview,
            },
      );
    } catch (error) {
      inFlightRender = null;
      request.reject(error);
    }
  };

  /** 編集の描画が終わった・編集の操作が始まった: ここから静かな時間を数え直す（終わったら持っている preview・background を出す）。 */
  const restartEditQuiet = () => {
    if (previewQuietMs <= 0) return;
    if (editQuietTimer !== null) clearTimeout(editQuietTimer);
    editQuietTimer = setTimeout(() => {
      editQuietTimer = null;
      if (inFlightRender === null) sendNextRender();
    }, previewQuietMs);
  };

  /** preview・background を出してよいか（編集の「次」が無く、静かな時間がたっている）。 */
  const editQuiet = () => editQuietTimer === null && queuedRenders.edit === null;

  /** Worker が空いたら、持っている「次」を 編集 ＞ preview ＞ background の順に 1 つ出す（preview・background は編集が静かなときだけ）。 */
  const sendNextRender = () => {
    for (const slot of RENDER_SLOT_ORDER) {
      const next = queuedRenders[slot];
      if (!next) continue;
      if (slot !== "edit" && !editQuiet()) return;
      queuedRenders[slot] = null;
      sendRender(next);
      if (inFlightRender) return;
    }
  };

  /** 出していた描画が終わった（編集の描画なら静かな時間を数え直してから、次を出す）。 */
  const finishRender = (finished: InFlightRender) => {
    inFlightRender = null;
    if (renderSlotOf(finished.priority) === "edit") restartEditQuiet();
    sendNextRender();
  };

  /** 診断の間だけ、描画 1 つの枠での待ちと Worker との往復を出す（設定・画素は出さない）。 */
  const logRenderPerf = (entry: InFlightRender, status: DevelopEngineRenderPerfRecord["status"]) => {
    if (entry.requestedAt === null || entry.sentAt === null) return;
    const record: DevelopEngineRenderPerfRecord = {
      stage: entry.kind === "thumbnail" ? "presetThumbnailRequest" : "renderRequest",
      priority: entry.priority,
      queuedMs: Math.max(0, entry.sentAt - entry.requestedAt),
      roundTripMs: Math.max(0, performance.now() - entry.sentAt),
      status,
    };
    console.info("[photo-develop-perf]", record);
  };

  /** 持っている写真が変わる（open / close）。出している描画の結果は捨て、「次」は null で終える。 */
  const dropRenders = () => {
    if (inFlightRender && !inFlightRender.stale) {
      inFlightRender.stale = true;
      inFlightRender.resolve(null);
    }
    dropQueuedRenders();
    dropMaskPlanes();
    // 新しい Developer は面を持たない（次の描画で渡し直す）
    dropSurfaceWaits();
    surfaces.reset();
  };

  const onResponse = (response: DevelopEngineWorkerResponse) => {
    if (response.type === "perf") {
      if (diagnosticsEnabled()) {
        console.info("[photo-develop-perf]", response.record);
      }
      return;
    }
    if (response.id === initId) {
      initId = null;
      if (response.type === "ready") {
        if (diagnosticsEnabled()) console.info("[photo-develop-perf]", { stage: "runtime", runtime: response.runtime, ...(response.wasmThreads ? { threads: response.wasmThreads } : {}) });
        geometrySupported = response.geometry === true;
        effectsSupported = response.effects === true;
        colorPointsSupported = response.colorPoints === true;
        detailSupported = response.detail === true;
        perspectiveSupported = response.perspective === true;
        uprightSupported = response.upright === true;
        healSupported = response.heal === true;
        lensSupported = response.lens === true;
        presetAmountSupported = response.presetAmount === true;
        settingsToXmpSupported = response.settingsToXmp === true;
        presetThumbnailsSupported = response.presetThumbnails === true;
        autoSupported = response.auto === true;
        presetFromMetaSupported = response.presetFromMeta === true;
        maskCapabilities = readMaskCapabilitiesResponse(response.masks);
        status = "ready";
        settleReady?.(true);
        settleReady = null;
      } else {
        terminate("unavailable");
      }
      return;
    }
    if (inFlightRender && response.id === inFlightRender.id) {
      const entry = inFlightRender;
      logRenderPerf(entry, entry.stale ? "dropped" : response.type === "frame" ? "ok" : response.type === "error" ? "error" : "dropped");
      if (!entry.stale) {
        if (response.type === "frame") {
          entry.resolve({ width: response.width, height: response.height, rgba: new Uint8ClampedArray(response.rgba) });
        } else if (response.type === "error") {
          entry.reject(developEngineErrorOf(response.message));
        } else {
          entry.resolve(null);
        }
      }
      finishRender(entry);
      return;
    }
    if (inFlightMaskPlane && response.id === inFlightMaskPlane.id) {
      const entry = inFlightMaskPlane;
      if (!entry.stale) {
        if (response.type === "maskPlane") {
          entry.resolve({ width: response.width, height: response.height, data: new Uint8Array(response.data) });
        } else if (response.type === "error") {
          entry.reject(developEngineErrorOf(response.message));
        } else {
          entry.reject(new DevelopEngineError("develop engine returned no mask plane"));
        }
      }
      finishMaskPlane();
      return;
    }
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.type === "error") entry.reject(developEngineErrorOf(response.message));
    else entry.resolve(response);
    if (isExportKind(entry.kind)) {
      exportsInFlight = Math.max(0, exportsInFlight - 1);
      if (terminateWhenIdle && exportsInFlight === 0) finishDispose();
    }
  };

  /**
   * 1 つの要求を出して応答を待つ。`reserved` は先に書き出しとして数えておいた要求（面を読み終えてから出す書き出し。`dispose` の後
   * でも出し、数え直さない）。
   */
  const request = (
    kind: Pending["kind"],
    build: (id: number) => { message: DevelopEngineWorkerRequest; transfer?: Transferable[] },
    reserved = false,
  ): Promise<DevelopEngineWorkerResponse> => {
    if (status !== "ready" || (terminateWhenIdle && !reserved)) {
      if (reserved) releaseExport();
      return Promise.reject(unavailableError());
    }
    const id = nextId++;
    return new Promise<DevelopEngineWorkerResponse>((resolve, reject) => {
      pending.set(id, { kind, resolve, reject });
      if (isExportKind(kind) && !reserved) exportsInFlight += 1;
      try {
        const { message, transfer } = build(id);
        post(message, transfer);
      } catch (error) {
        pending.delete(id);
        if (isExportKind(kind)) releaseExport();
        reject(error);
      }
    });
  };

  finishDispose = () => {
    if (options.preferNative !== true) {
      terminate("disposed");
      return;
    }
    if (closeBeforeTerminate || status !== "ready") return;
    closeBeforeTerminate = true;
    // native glue の client token に属する handle を Worker 側で解放してから止める。wasm-only の既存経路は即時終了のまま。
    void request("close", (id) => ({ message: { type: "close", id } }), true).then(
      () => terminate("disposed"),
      () => terminate("disposed"),
    );
  };

  /** 書き出しを 1 つ数え終える（止める予定なら、最後の 1 つで止める）。 */
  const releaseExport = () => {
    exportsInFlight = Math.max(0, exportsInFlight - 1);
    if (terminateWhenIdle && exportsInFlight === 0) finishDispose();
  };

  /**
   * 書き出しを出す。描かれる面のマスクがあれば、先に書き出しとして数えてから面を読み（`dispose` は描き終えるまで待つ）、面を添えて
   * 出す。無ければ今までどおりすぐ出す。
   */
  const requestExport = async (
    kind: "exportJpeg" | "exportWorkingCopyJpeg",
    settings: object,
    source: DevelopMaskSurfaceSource | null | undefined,
    build: (id: number, surfaces: DevelopMaskSurfacePng[] | undefined) => { message: DevelopEngineWorkerRequest; transfer?: Transferable[] },
  ): Promise<DevelopEngineWorkerResponse> => {
    if (!surfacesSupported() || developMaskSurfaceNeeds(settings).length === 0) {
      return request(kind, (id) => build(id, undefined));
    }
    if (status !== "ready" || terminateWhenIdle) throw unavailableError();
    exportsInFlight += 1;
    let attached: DevelopMaskSurfacePng[];
    try {
      attached = await exportSurfaces(settings, source);
    } catch (error) {
      releaseExport();
      throw error;
    }
    return request(
      kind,
      (id) => {
        const built = build(id, attached);
        return { ...built, transfer: [...(built.transfer ?? []), ...attached.map((surface) => surface.png)] };
      },
      true,
    );
  };

  const startWorker = (): Promise<boolean> => {
    const manifestUrl = options.manifestUrl ?? defaultManifestUrl();
    let created: Worker | null = null;
    try {
      created = manifestUrl ? (options.createWorker ?? createDefaultWorker)() : null;
    } catch {
      created = null;
    }
    if (!created || !manifestUrl) {
      status = "unavailable";
      return Promise.resolve(false);
    }
    worker = created;
    status = "loading";
    const result = new Promise<boolean>((resolve) => {
      settleReady = resolve;
    });
    const timer = setTimeout(() => {
      if (status === "loading") terminate("unavailable");
    }, loadTimeoutMs);
    void result.then(() => clearTimeout(timer));
    created.addEventListener("message", (event: MessageEvent<DevelopEngineWorkerResponse>) => onResponse(event.data));
    // Worker が落ちた・受け取れない形だった → 使えない扱い
    created.addEventListener("error", () => terminate("unavailable"));
    created.addEventListener("messageerror", () => terminate("unavailable"));
    const id = nextId++;
    initId = id;
    try {
      const diagnostics = diagnosticsEnabled();
      post({
        type: "init",
        id,
        manifestUrl,
        ...(diagnostics ? { diagnostics: true } : {}),
        ...(options.preferNative === true ? { preferNative: true } : {}),
      });
    } catch {
      terminate("unavailable");
    }
    return result;
  };

  const ready = (): Promise<boolean> => {
    // 止めた後・起こした後に Worker が落ちたときは使えない
    if (status === "disposed" || status === "unavailable" || terminateWhenIdle) return Promise.resolve(false);
    if (!readyPromise) readyPromise = startWorker();
    return readyPromise;
  };

  /**
   * 描画を待ち行列に入れる。Worker が空いていればすぐ出し、出している間は優先度の枠の「次」として持つ（同じ枠の古い「次」は
   * null で終える）。
   */
  const enqueueRender = (
    request: Omit<RenderRequest, "priority" | "requestedAt" | "resolve" | "reject">,
    priority: DevelopRenderPriority,
  ): Promise<DevelopFrame | null> => {
    if (status !== "ready" || terminateWhenIdle) return Promise.reject(unavailableError());
    return new Promise<DevelopFrame | null>((resolve, reject) => {
      const next: RenderRequest = { ...request, priority, requestedAt: perfNow(), resolve, reject };
      const slot = renderSlotOf(priority);
      // 編集は Worker が空いていればすぐ出す。preview・background は編集が静かなときだけ（待つ間は「次」として持つ）
      if (inFlightRender === null && (slot === "edit" || editQuiet())) {
        sendRender(next);
        return;
      }
      // 同じ枠の古い「次」は null で終える（ほかの枠の「次」は残す）
      queuedRenders[slot]?.resolve(null);
      queuedRenders[slot] = next;
    });
  };

  return {
    ready,

    async supportsGeometry() {
      return (await ready()) && geometrySupported;
    },

    async supportsEffects() {
      return (await ready()) && effectsSupported;
    },

    async supportsColorPoints() {
      return (await ready()) && colorPointsSupported;
    },

    async supportsDetail() {
      return (await ready()) && detailSupported;
    },
    async supportsMasks() {
      if (!(await ready()) || !maskCapabilities) return null;
      return { ...maskCapabilities, kinds: [...maskCapabilities.kinds] };
    },

    maskPlane(settings, maskId, planeOptions) {
      if (status !== "ready" || terminateWhenIdle) return Promise.reject(unavailableError());
      if (!maskCapabilities?.maskPlane) {
        return Promise.reject(new DevelopEngineError("develop engine cannot draw mask planes"));
      }
      const settingsJson = JSON.stringify(settings);
      const needs = surfacesSupported() ? developMaskPlaneSurfaceNeeds(settings, maskId) : [];
      return afterSurfaces("maskPlane", needs, () => {
        if (status !== "ready" || terminateWhenIdle) return Promise.reject(unavailableError());
        return new Promise<DevelopMaskPlane | null>((resolve, reject) => {
          const next: MaskPlaneRequest = { settingsJson, maskId, maxDimension: planeOptions.maxDimension, needs, resolve, reject };
          if (inFlightMaskPlane === null) {
            sendMaskPlane(next);
            return;
          }
          // 古い「次」は null で終える（新しい形だけを描く）
          queuedMaskPlane?.resolve(null);
          queuedMaskPlane = next;
        });
      });
    },

    async supportsPerspective() {
      return (await ready()) && perspectiveSupported;
    },

    async supportsUpright() {
      return (await ready()) && uprightSupported;
    },

    async supportsHeal() {
      return (await ready()) && healSupported;
    },

    async supportsLens() {
      return (await ready()) && lensSupported;
    },

    async estimateUpright(settings, mode) {
      // 口の無い wasm には送らない
      if (status === "ready" && !terminateWhenIdle && !uprightSupported) {
        throw new DevelopEngineError("develop engine cannot estimate upright");
      }
      const response = await request("estimateUpright", (id) => ({
        message: { type: "estimateUpright", id, settingsJson: JSON.stringify(settings), mode },
      }));
      if (response.type !== "upright") throw new DevelopEngineError("develop engine returned no upright estimate");
      const estimate = readDevelopUprightEstimate(response.resultJson);
      if (!estimate) throw new DevelopEngineError("develop engine returned an invalid upright estimate");
      return estimate;
    },

async setMaskSurface(surfaceId, png) {
      if (status === "ready" && !terminateWhenIdle && !surfacesSupported()) {
        throw new DevelopEngineError("develop engine cannot take mask surfaces");
      }
      const generation = surfaces.generation();
      await postMaskSurface(surfaceId, png);
      surfaces.markHeld(surfaceId, png.slice(), generation);
    },

    async dropMaskSurface(surfaceId) {
      surfaces.markDropped(surfaceId);
      const response = await request("dropMaskSurface", (id) => ({ message: { type: "dropMaskSurface", id, surfaceId } }));
      return response.type === "maskSurfaceDropped" && response.dropped;
    },

    async encodeMaskSurface(width, height, data) {
      if (status === "ready" && !terminateWhenIdle && !surfacesSupported()) {
        throw new DevelopEngineError("develop engine cannot encode mask surfaces");
      }
      const response = await request("encodeMaskSurface", (id) => {
        const buffer = data.slice().buffer;
        return { message: { type: "encodeMaskSurface", id, width, height, data: buffer }, transfer: [buffer] };
      });
      if (response.type !== "maskSurfaceEncoded") throw new DevelopEngineError("develop engine returned no mask surface");
      const png = new Uint8Array(response.png);
      surfaces.remember(response.surfaceId, png.slice());
      return { id: response.surfaceId, png };
    },

    maskSurfacePng(surfaceId) {
      return surfaces.png(surfaceId);
    },

    setMaskSurfaceSource(source) {
      maskSurfaceSource = source;
      surfaces.forgetMissing();
    },

    retryMaskSurfaces() {
      surfaces.forgetMissing();    },

    async sampleColor(settings, options) {
      const response = await request("sampleColor", (id) => ({
        message: {
          type: "sampleColor",
          id,
          settingsJson: finalSettingsJson(settings),
          maxDimension: options.maxDimension,
          x: options.x,
          y: options.y,
        },
      }));
      if (response.type !== "sampledColor") throw new DevelopEngineError("develop engine returned no sampled color");
      return { lightness: response.lightness, chroma: response.chroma, hue: response.hue };
    },

    async imageSize(bytes) {
      // transfer しない（Worker へはコピーが渡る。呼び出し側は同じ bytes をこの後 `open` に渡す）
      const response = await request("imageSize", (id) => ({ message: { type: "imageSize", id, bytes } }));
      if (response.type !== "size") throw new DevelopEngineError("develop engine returned no image size");
      return { width: response.width, height: response.height };
    },

    async rasterDecodeSize(settings, size, maxDimension, cap) {
      const response = await request("rasterDecodeSize", (id) => ({
        message: {
          type: "rasterDecodeSize",
          id,
          settingsJson: JSON.stringify(settings),
          width: size.width,
          height: size.height,
          maxDimension,
          cap,
        },
      }));
      if (response.type !== "decodeSize") throw new DevelopEngineError("develop engine returned no decode size");
      return response.size;
    },

    async geometryOutputSize(settings, source, maxDimension) {
      const response = await request("geometryOutputSize", (id) => ({
        message: {
          type: "geometryOutputSize",
          id,
          settingsJson: JSON.stringify(settings),
          sourceWidth: source.width,
          sourceHeight: source.height,
          maxDimension,
        },
      }));
      if (response.type !== "size") throw new DevelopEngineError("develop engine returned no output size");
      return { width: response.width, height: response.height };
    },

    async withCaptureExif(jpeg, capturedAt, offsetMinutes) {
      const response = await request("withCaptureExif", (id) => {
        const bytes = exactArrayBuffer(jpeg);
        return { message: { type: "withCaptureExif", id, bytes, capturedAt, offsetMinutes }, transfer: [bytes] };
      });
      if (response.type !== "jpeg") throw new DevelopEngineError("develop engine returned no JPEG");
      return new Uint8Array(response.bytes);
    },

    async open(bytes, workingMaxDimension) {
      dropRenders();
      cancelWarmAutoSettings();
      workingCopyOpened = false;
      committedNoise = null;
      const response = await request("open", (id) => ({
        message: { type: "open", id, bytes, workingMaxDimension },
        transfer: [bytes],
      }));
      if (response.type !== "opened") throw new DevelopEngineError("develop engine could not open the photo");
      return { width: response.width, height: response.height };
    },

    render(settings, renderOptions) {
      const priority = renderOptions.priority ?? (renderOptions.interactive ? "drag" : "final");
      const settingsJson = previewSettingsJson(settings, renderOptions.interactive);
      const needs = surfacesSupported() ? developMaskSurfaceNeeds(settings) : [];
      return afterSurfaces(renderSlotOf(priority), needs, () =>
        enqueueRender(
          {
            kind: "render",
            settingsJson,
            maxDimension: renderOptions.maxDimension,
            interactive: renderOptions.interactive,
            fastPresetPreview: renderOptions.fastPresetPreview,
            needs,
          },
          priority,
        ),
      );
    },

    renderPresetThumbnail(settings, maxDimension) {
      if (status === "ready" && !terminateWhenIdle && !presetThumbnailsSupported) {
        return Promise.reject(new DevelopEngineError("develop engine cannot render preset thumbnails"));
      }
      // 見本は丁寧に描く（interactive は Worker へ送らない）。編集の描画を待たせない preview の枠。面のマスクの面は、開いている写真へ
      // 渡してから見本の session にもそろえる（Worker）
      const settingsJson = finalSettingsJson(settings);
      const needs = surfacesSupported() ? developMaskSurfaceNeeds(settings) : [];
      return afterSurfaces("preview", needs, () =>
        enqueueRender({ kind: "thumbnail", settingsJson, maxDimension, interactive: false, needs }, "preview"),
      );
    },

    yieldToEdit() {
      restartEditQuiet();
    },

    async supportsPresetAmount() {
      return (await ready()) && presetAmountSupported;
    },

    async supportsSettingsToXmp() {
      return (await ready()) && settingsToXmpSupported;
    },

    async supportsPresetThumbnails() {
      return (await ready()) && presetThumbnailsSupported;
    },

    async supportsAuto() {
      return (await ready()) && autoSupported;
    },

    async supportsPresetFromMeta() {
      return (await ready()) && presetFromMetaSupported;
    },

    async autoSettings(settings) {
      // 口の無い wasm には送らない
      if (status === "ready" && !terminateWhenIdle && !autoSupported) {
        throw new DevelopEngineError("develop engine cannot pick auto settings");
      }
      const response = await request("autoSettings", (id) => ({
        message: { type: "autoSettings", id, settingsJson: JSON.stringify(settings) },
      }));
      return autoSettingsResponse(response);
    },

    warmAutoSettings(settings) {
      if (status !== "ready" || terminateWhenIdle || !autoSupported) {
        return {
          promise: Promise.reject(unavailableError()),
          promote: () => undefined,
          cancel: () => undefined,
        };
      }

      const id = nextId++;
      let resolve!: (response: DevelopEngineWorkerResponse) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<DevelopSettings>((resolveResult, rejectResult) => {
        resolve = (response) => {
          try {
            resolveResult(autoSettingsResponse(response));
          } catch (error) {
            rejectResult(error);
          }
        };
        reject = rejectResult;
      });
      pending.set(id, { kind: "warmAutoSettings", resolve, reject });
      try {
        post({ type: "warmAutoSettings", id, settingsJson: JSON.stringify(settings) });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }

      return {
        promise,
        promote: () => {
          if (!pending.has(id)) return;
          try {
            post({ type: "promoteAutoSettings", id });
          } catch {
            // Worker のエラー・終了処理が待機中の要求を reject する。
          }
        },
        cancel: () => {
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          try {
            post({ type: "cancelAutoSettings", id });
          } catch {
            // ローカルの待機は取り除いた。Worker が終了済みなら取り消し要求は不要。
          }
          entry.reject(new DevelopEngineError("auto settings prefetch cancelled"));
        },
      };
    },

    async applyPreset(xmp, baseSettings, amount, asShot) {
      // 作業コピーのメタから撮影時の白を引けない wasm には送らない（開いている写真の白で当てて取り違えない）
      if (asShot && status === "ready" && !terminateWhenIdle && !presetFromMetaSupported) {
        throw new DevelopEngineError("develop engine cannot read the as-shot white");
      }
      const response = await request("applyPreset", (id) => ({
        message: {
          type: "applyPreset",
          id,
          xmp,
          baseSettingsJson: JSON.stringify(baseSettings),
          amount,
          // 省いたときは今までどおり（開いている写真の白。要求の形も変えない）
          ...(asShot ? { asShotMetaJson: asShot.workMetaJson } : {}),
        },
      }));
      if (response.type !== "preset") throw new DevelopEngineError("develop engine returned no preset settings");
      return presetResultOrThrow(response.resultJson);
    },

    async settingsToXmp(settings, xmpOptions) {
      const response = await request("settingsToXmp", (id) => ({
        message: {
          type: "settingsToXmp",
          id,
          settingsJson: JSON.stringify(settings),
          optionsJson: JSON.stringify(
            xmpOptions.groups ? { name: xmpOptions.name, groups: [...xmpOptions.groups] } : { name: xmpOptions.name },
          ),
        },
      }));
      if (response.type !== "xmp") throw new DevelopEngineError("develop engine returned no XMP");
      const written = readSettingsXmp(response.resultJson);
      if (!written) throw new DevelopEngineError("develop engine returned an invalid XMP");
      return written;
    },

    async exportJpeg(bytes, settings, exportOptions) {
      const response = await requestExport("exportJpeg", settings, exportOptions.maskSurfaces, (id, attached) => ({
        message: {
          type: "exportJpeg",
          id,
          bytes,
          settingsJson: JSON.stringify(settings),
          maxDimension: exportOptions.maxDimension,
          quality: exportOptions.quality,
          ...(attached ? { surfaces: attached } : {}),
        },
        transfer: [bytes],
      }));
      if (response.type !== "jpeg") throw new DevelopEngineError("develop engine returned no JPEG");
      return new Uint8Array(response.bytes);
    },

    async openWorkingCopy(png, metaJson) {
      dropRenders();
      cancelWarmAutoSettings();
      workingCopyOpened = true;
      committedNoise = null;
      const response = await request("openWorkingCopy", (id) => ({
        message: { type: "openWorkingCopy", id, png, metaJson },
        transfer: [png],
      }));
      if (response.type !== "opened") throw new DevelopEngineError("develop engine could not open the working copy");
      return { width: response.width, height: response.height };
    },

    async exportWorkingCopyJpeg(png, metaJson, settings, exportOptions) {
      const response = await requestExport("exportWorkingCopyJpeg", settings, exportOptions.maskSurfaces, (id, attached) => ({
        message: {
          type: "exportWorkingCopyJpeg",
          id,
          png,
          metaJson,
          settingsJson: JSON.stringify(settings),
          maxDimension: exportOptions.maxDimension,
          quality: exportOptions.quality,
          ...(attached ? { surfaces: attached } : {}),
        },
        transfer: [png],
      }));
      if (response.type === "jpeg") return new Uint8Array(response.bytes);
      if (response.type !== "frame") throw new DevelopEngineError("develop engine returned no JPEG");
      // Worker の中で JPEG にできなかった（OffscreenCanvas が無い）→ メインスレッドで JPEG にする
      const frame: DevelopFrame = { width: response.width, height: response.height, rgba: new Uint8ClampedArray(response.rgba) };
      return (options.encodeFrameJpeg ?? encodeFrameJpegWithCanvas)(frame, exportOptions.quality);
    },

    async convertEditSettings(editSettings, conversionOptions = {}) {
      const response = await request("convertEditSettings", (id) => ({
        message: {
          type: "convertEditSettings",
          id,
          editSettingsJson: JSON.stringify(editSettings),
          ...(conversionOptions.baseVersion ? { baseVersion: conversionOptions.baseVersion } : {}),
        },
      }));
      if (response.type !== "converted") return BROKEN_CONVERSION;
      return readConversion(response.resultJson);
    },

    async presetSettings(xmp, baseSettings) {
      const response = await request("presetSettings", (id) => ({
        message: {
          type: "presetSettings",
          id,
          xmp,
          baseSettingsJson: baseSettings === null ? null : JSON.stringify(baseSettings),
        },
      }));
      if (response.type !== "preset") throw new DevelopEngineError("develop engine returned no preset settings");
      return presetResultOrThrow(response.resultJson);
    },

    async builtinPresets() {
      const response = await request("builtinPresets", (id) => ({ message: { type: "builtinPresets", id } }));
      if (response.type !== "builtinPresets") throw new DevelopEngineError("develop engine returned no builtin presets");
      const presets = readBuiltinPresets(response.presetsJson);
      if (!presets) throw new DevelopEngineError("develop engine returned invalid builtin presets");
      return presets;
    },

    async close() {
      dropRenders();
      cancelWarmAutoSettings();
      await request("close", (id) => ({ message: { type: "close", id } }));
    },

    dispose() {
      if (status === "disposed" || terminateWhenIdle) return;
      if (status !== "ready") {
        terminate("disposed");
        return;
      }
      // 描き途中の JPEG（記事用の画像）を描き終えてから止める。native 希望なら最後に handle を解放する。
      terminateWhenIdle = true;
      dropRenders();
      if (exportsInFlight === 0) finishDispose();
    },
  };
}
