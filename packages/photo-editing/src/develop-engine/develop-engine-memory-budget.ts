/**
 * 編集・見本・大きな書き出しが分け合う物理メモリの予算（#155）。Worker が持つ物の bytes の見積もりと、端末の種類ごとの予算。
 *
 * 見積もりは Studio・Node の単一スレッドの wasm で、場面ごとに別のプロセスで測った linear memory の高水位の差から作った
 * （`packages/develop-engine/tools/memory-budget-bench.mjs`。2560×1707 の signed RAW の作業コピー・6000×4000 の JPEG）。
 * wasm の linear memory は free しても縮まず、高水位が Worker の終わるまで物理メモリに残る。だから予算は「高水位をどこまで
 * 上げてよいか」で、持つ物の見積もりはその内側をどう使い回すかを決める。native（Mac の sidecar）は free で OS に返るので、
 * 同じ見積もりを sidecar が同時に持つ量として使う。
 *
 * 実測（MiB。高水位。2560×1707 = 4.37MP。Studio M1 Max・Node 24・crate 0.26.0）:
 * - 開いて丁寧に描いた写真 1 枚 148（開くだけで 98）
 * - それに別の CNR の解析を先に作る +156、見本の session で同梱のプリセットを全部描く +217〜263
 * - 直前の写真を保つ（先回りの解析と見本は手放してから）+167 → PC の今の保ち方の高水位 688、保たない（スマホ）521
 * - 書き出しだけ（新しいプロセス）: 作業コピー長辺 2048 で 180、補正を全部使った作業コピー 2560 で 804、
 *   6000×4000 の JPEG 長辺 4096 で 209、補正を全部使って 1,616
 * - 688 を持ったまま補正を全部使った作業コピー 2560 を書き出すと 1,387、見本・kept・先回りを手放してからだと 973。
 *   JPEG 4096 では 2,194 / 1,821（手放しても空きに収まらない）
 * - 補助の worker（同じ作業コピーを開き、CNR 25 の解析を bytes にする）198
 */

/** Worker が予算を選ぶ端末の種類（client が init で渡す）。 */
export type DevelopMemoryDeviceClass = "pc" | "mobile";

const MIB = 1024 * 1024;

/** 開いて丁寧に描いた写真 1 枚（作業画素あたり）。保つ写真（kept）も同じ。実測 148MiB / 4.37MP = 35.5 → 36。 */
export const DEVELOPER_BYTES_PER_PIXEL = 36;
/** 先に作った別の設定の解析 1 件（CNR の元と応答の係数。作業画素あたり）。実測 156MiB / 4.37MP = 37.4 → 38。 */
export const ANALYSIS_AHEAD_BYTES_PER_PIXEL = 38;
/** 見本の session（同梱のプリセットを全部描いた後。親の作業画素あたり）。実測 263MiB / 4.37MP = 63.1 → 64。 */
export const THUMBNAIL_SESSION_BYTES_PER_PIXEL = 64;

/** 補助の worker 1 つ（同じ写真を開いて解析を 1 件作る。作業画素あたり）。実測 198MiB（207.6MB）/ 4.37MP = 47.5 → 48。 */
export const ANALYSIS_HELPER_BYTES_PER_PIXEL = 48;

/** 写真を開いて丁寧に描いた後に持つ bytes の見積もり。 */
export function developerMemoryBytes(width: number, height: number): number {
  return DEVELOPER_BYTES_PER_PIXEL * pixels(width, height);
}

/** 先に作った別の設定の解析 1 件の bytes の見積もり。 */
export function analysisAheadMemoryBytes(width: number, height: number): number {
  return ANALYSIS_AHEAD_BYTES_PER_PIXEL * pixels(width, height);
}

/** 補助の worker 1 つの bytes の見積もり。 */
export function analysisHelperMemoryBytes(width: number, height: number): number {
  return ANALYSIS_HELPER_BYTES_PER_PIXEL * pixels(width, height);
}

/** 見本の session の bytes の見積もり（`width` × `height` は親の写真の作業サイズ）。 */
export function thumbnailSessionMemoryBytes(width: number, height: number): number {
  return THUMBNAIL_SESSION_BYTES_PER_PIXEL * pixels(width, height);
}

/** 描画の重さ（書き出しの見積もりに使う。マスクは画を変えるものを 8 枚まで数える）。 */
export type DevelopRenderLoad = {
  masks: number;
  detail: boolean;
  /** ノイズ軽減（輝度・カラー。signed RAW の CNR の元も含む） */
  noiseReduction: boolean;
  geometry: boolean;
  heal: boolean;
  lens: boolean;
};

/**
 * 書き出す画の 1 画素あたりの bytes（niho-photo#134 の実測。24MP の JPEG を長辺 4096 で描いて露光量・コントラストだけで
 * 213MB、マスク 3 枚・修復・レンズ・遠近・ディテールで 1,284MB。補正ごとの割り振りは Mac の原寸の実測〔niho-photo#132〕の比）。
 * JPEG の入力を開く分はここに入っている。ノイズ軽減は #155 の実測（同じ補正に輝度 30・カラー 25 を足すと 1,616MiB〔157.5/px〕。
 * 作業コピー 2560 では CNR の元を含めて 804MiB）から 1 画素あたり 36 を足す。
 */
const RENDER_BYTES_PER_PIXEL = 21;
const RENDER_NOISE_REDUCTION_BYTES_PER_PIXEL = 36;
const RENDER_MASK_BYTES_PER_PIXEL = 10;
const RENDER_DETAIL_BYTES_PER_PIXEL = 30;
const RENDER_GEOMETRY_BYTES_PER_PIXEL = 15;
const RENDER_HEAL_BYTES_PER_PIXEL = 11;
const RENDER_LENS_BYTES_PER_PIXEL = 15;

/** 書き出す画（`size`）を描く wasm のメモリの見積もり（bytes。入力を開く分はこの外）。 */
export function developRenderMemoryBytes(load: DevelopRenderLoad, size: { width: number; height: number }): number {
  let perPixel = RENDER_BYTES_PER_PIXEL + RENDER_MASK_BYTES_PER_PIXEL * Math.min(8, Math.max(0, load.masks));
  if (load.detail) perPixel += RENDER_DETAIL_BYTES_PER_PIXEL;
  if (load.noiseReduction) perPixel += RENDER_NOISE_REDUCTION_BYTES_PER_PIXEL;
  if (load.geometry) perPixel += RENDER_GEOMETRY_BYTES_PER_PIXEL;
  if (load.heal) perPixel += RENDER_HEAL_BYTES_PER_PIXEL;
  if (load.lens) perPixel += RENDER_LENS_BYTES_PER_PIXEL;
  return perPixel * pixels(size.width, size.height);
}

/**
 * Worker が受け取った設定の JSON から描画の重さを読む（読めなければ全部入り。多めに見積もる側に倒す）。画面の判定
 * （`hasDevelopGeometry` など）より粗く、無効なマスクや何もしない幾何も数える。
 */
export function developRenderLoadFromJson(settingsJson: string): DevelopRenderLoad {
  let settings: unknown;
  try {
    settings = JSON.parse(settingsJson);
  } catch {
    return HEAVIEST_RENDER_LOAD;
  }
  if (typeof settings !== "object" || settings === null) return HEAVIEST_RENDER_LOAD;
  const { masks, detail, geometry, heal, lens, colorNoiseReduction } = settings as Record<string, unknown>;
  const detailRecord = typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : null;
  return {
    masks: Array.isArray(masks) ? Math.min(8, masks.length) : 0,
    detail: detail !== undefined && detail !== null,
    noiseReduction:
      positive(colorNoiseReduction) ||
      positive(detailRecord?.luminanceNoiseReduction) ||
      positive(detailRecord?.colorNoiseReduction),
    geometry: geometry !== undefined && geometry !== null,
    heal: Array.isArray(heal) ? heal.length > 0 : heal !== undefined && heal !== null,
    lens: lens !== undefined && lens !== null,
  };
}

const HEAVIEST_RENDER_LOAD: DevelopRenderLoad = Object.freeze({
  masks: 8,
  detail: true,
  noiseReduction: true,
  geometry: true,
  heal: true,
  lens: true,
});

/** 数でなければ、効くかもしれない側（true）に倒す。 */
function positive(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "number" || value > 0;
}

/** 長辺を `maxDimension` に収めた大きさ（拡大しない。0 は元の大きさ）。 */
export function fittedSize(width: number, height: number, maxDimension: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (maxDimension <= 0 || long <= maxDimension) return { width, height };
  const scale = maxDimension / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * 一時的に開いて描く書き出し 1 回の見積もり。作業コピーは開いて持つ分（{@link developerMemoryBytes}）+ 描く分、JPEG / PNG は
 * 描く分だけ（入力を開く分は 1 画素あたりの係数に入っている）。実測との差: 作業コピー 2048 で +14%、補正を全部使った
 * 作業コピー 2560 で +1%、JPEG 4096 で +7%、補正を全部使った JPEG 4096 で +5%（どれも下回らない）。
 */
export function developExportMemoryBytes(
  load: DevelopRenderLoad,
  source: { width: number; height: number; workingCopy: boolean },
  maxDimension: number,
): number {
  const render = developRenderMemoryBytes(load, fittedSize(source.width, source.height, maxDimension));
  return source.workingCopy ? developerMemoryBytes(source.width, source.height) + render : render;
}

/**
 * 端末の種類ごとの予算。`totalBytes` は Worker の wasm の高水位（native は sidecar が同時に持つ量）・JS に置いた解析の bytes・
 * 同時に動く補助の worker を合わせた上限。`exportReserveBytes` は長辺 2048px のふだんの書き出しを、持つ物を手放さずに同じ
 * Worker で描くための空き（持つ物の上限は `totalBytes - exportReserveBytes`）。`heldPhotos` は開いている写真と合わせて保つ枚数。
 *
 * `overflow` は、持つ物を全部手放しても `totalBytes` に収まらない書き出しの描き方: `worker` は使い捨ての worker で描いて
 * 終わらせる（高水位を残さない。その間は今の高水位 + 書き出しが一時的に乗る）、`inPlace` は同じ Worker で持つ物を全部手放して
 * 描く（一時的な山は低いが、高水位はそのまま残る）。
 *
 * - PC: 今の保ち方（kept 1 枚・先回り・見本。高水位 688MiB）＋解析の bytes 32MiB が持つ物の上限 768MiB に収まり、長辺 2048 の
 *   書き出し（作業コピー 180MiB）は手放さずに描ける。補助の worker（198MiB）も 1GiB に収まる。補正を全部使った JPEG の
 *   「大きく」（1,616MiB）は収まらないので使い捨ての worker で描き、終わったら OS に返す
 * - スマホ: 保たない（高水位 521MiB）＋解析の bytes 16MiB が上限 576MiB に収まる。山を低く保つほうを優先し、収まらない
 *   書き出しも同じ Worker で描く（画面は「大きく」を 512MB の見積もりまでしか出さない。niho-photo#134）
 */
export type DevelopMemoryBudget = {
  totalBytes: number;
  exportReserveBytes: number;
  heldPhotos: number;
  overflow: "worker" | "inPlace";
};

export const DEVELOP_MEMORY_BUDGET: Readonly<Record<DevelopMemoryDeviceClass, DevelopMemoryBudget>> = {
  pc: { totalBytes: 1024 * MIB, exportReserveBytes: 256 * MIB, heldPhotos: 2, overflow: "worker" },
  mobile: { totalBytes: 768 * MIB, exportReserveBytes: 192 * MIB, heldPhotos: 1, overflow: "inPlace" },
};

function pixels(width: number, height: number): number {
  return Math.max(0, width) * Math.max(0, height);
}
