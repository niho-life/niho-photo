import {
  normalizeBrowserPhotoAdjustments,
  type BrowserPhotoAdjustments,
} from "../browser-photo-adjustments";
import { hasActiveDevelopEffects, isInactiveDevelopEffect } from "../photo-editing-effects";
import { PHOTO_EDITING_ZERO_DEFAULT_KEYS, isNeutralPhotoEditingSettings } from "../photo-editing-settings-neutral";
import {
  DEVELOP_MASKS_SETTINGS_VERSION,
  hasActiveDevelopMasks,
  hasDevelopMasks,
  hasValidDevelopMasks,
} from "./develop-masks";
import { presetMasksForPhoto, type PresetMasksPlacement } from "./develop-preset-masks";
import { HEAL_SETTINGS_VERSION, hasDevelopHeal, hasValidDevelopHeal } from "./develop-heal";
import {
  LENS_SETTINGS_VERSION,
  hasActiveDevelopLens,
  hasValidDevelopLens,
  isActiveDevelopLens,
  readDevelopLens,
} from "./develop-lens";
/**
 * NIHO の現像エンジンの編集内容 `developSettings`（移行元設計。移行時の設計文書「段 2」）。Photo Bench の
 * `EditSettings` の上位集合に `v`・`engine`・`look`・`base`・`geometry`・`heal`・`lens` を足したもの。ブラウザは基本補正の 13 項目（NIHO Photo 段 1
 * F1 移行元設計。S1 の canvas では露光量・コントラスト・彩度と相対の色温度 / 色かぶり補正だけ）を直し、ほかの項目（HSL など）はそのまま
 * 持って返す。形の版 `v` は、レンズ補正が画を変えれば 9、修復の印があれば 8、遠近（`geometry.perspective`）があれば 7、detail があれば 6、部分補正（マスク）があれば
 * 5、色ポイントがあれば 4、効果が有効なら 3、幾何が恒等でなければ 2、ほかは 1。古い画面は知らない形を落とさないため、未対応の版を読まない。 */
/** API schemaの設定型（v1〜v9）を画面で扱う型。未知の項目はそのまま保持する。 */
export type DevelopSettings = {
  v: DevelopSettingsVersion;
  engine: string;
  [key: string]: unknown;
};

/**
 * 新規編集の数式（#89）。JPEG / PNG をオリジナルから直接描く（`base: null`）写真、raster の作業コピー（`raster.*`。HEIC / TIFF /
 * 大きな JPEG）と unsigned RAW の作業コピー（`raw-apple.*` の p0〜2 / e1）の上で直す写真はこれ。niho-13（niho-12 の数式で、raster の
 * 相対の色温度 / 色かぶり補正を処理の先頭に当てる）のまま、ハイライト / シャドウの応答の解析（特徴量と網）を軽くした版で、WB を
 * 変えた後の確定が速い。画は niho-13 と丸めの差だけ違う（H/S を使わない設定と unsigned RAW は同じ画）。signed RAW・camera-linear は
 * 描かない（crate の IncompatibleWorkingCopy）ので、作業コピーの無い RAW・版の分からない作業コピーの新規編集は
 * {@link NIHO2_DEVELOP_SETTINGS_ENGINE}（{@link newDevelopSettingsEngine}）。signed RAW の新規既定は metadata を確認して別途選ぶ。
 * 保存済みの編集内容は、その数式のまま描き・直す（決まりごと 4。niho-1〜niho-13 を niho-14 へ変えない）。
 */
export const DEVELOP_SETTINGS_ENGINE = "niho-14";
/**
 * 保存済みの raster・unsigned RAW 編集の旧数式（#27。niho-14 の前の新規既定。H/S の解析が凍結した計算）。新規設定へは昇格させない。
 * 描ける入力とルックは niho-14 と同じ。
 */
export const NIHO13_DEVELOP_SETTINGS_ENGINE = "niho-13";
/**
 * 保存済みの raster・unsigned RAW 編集の旧数式（#29。niho-13 の前の新規既定。相対 WB は出力側）。新規設定へは昇格させない。
 * 描ける入力とルックは niho-14 と同じ。
 */
export const NIHO12_DEVELOP_SETTINGS_ENGINE = "niho-12";
/** 保存済み raster 編集の旧数式（niho-12 の前の raster の新規既定）。新規設定へは昇格させない。 */
export const NIHO10_DEVELOP_SETTINGS_ENGINE = "niho-10";
/** 保存済み raster 編集の旧数式。新規設定へは昇格させない。 */
export const NIHO6_DEVELOP_SETTINGS_ENGINE = "niho-6";
/**
 * raster 専用数式・float cube より前の新規編集の数式。今も作業コピーの無い RAW・版の分からない作業コピーの新規編集はこれ
 * （作業コピーが signed になるか決まる前・版の分からない作業コピーには niho-12〜niho-14 を約束しない）。保存済みの unsigned RAW の
 * 作業コピーの補正も niho-2 のまま描く。
 */
export const NIHO2_DEVELOP_SETTINGS_ENGINE = "niho-2";
/** 公開済み niho-2 wasm が旧式で描く保存済みの数式。編集時も無断で新式に変えない。 */
export const LEGACY_DEVELOP_SETTINGS_ENGINE = "niho-1";
/**
 * 新しく作る編集内容のルック（S8 移行元設計 の NIHO 標準ルック）。保存済みの編集内容はその `look` のまま描き、後から変えない
 * （S5 で直した写真は `niho-interim-1`）。
 */
export const DEVELOP_SETTINGS_LOOK = "niho-standard-1";
export const SIGNED_DEVELOP_SETTINGS_ENGINE = "niho-3";
export const SIGNED_DEVELOP_SETTINGS_LOOK = "niho-standard-2";
export const NIHO4_DEVELOP_SETTINGS_ENGINE = "niho-4";
export const NIHO4_DEVELOP_SETTINGS_LOOK = "niho-standard-3";
/** 対応校正済み signed RAW の旧数式とルック。保存済み niho-7 は昇格しない。 */
export const NIHO7_DEVELOP_SETTINGS_ENGINE = "niho-7";
export const NIHO7_DEVELOP_SETTINGS_LOOK = "niho-standard-5";
/** niho-7 の色段だけを更新した、対応校正済み signed RAW の新規数式。 */
export const NIHO11_DEVELOP_SETTINGS_ENGINE = "niho-11";
export const NIHO11_DEVELOP_SETTINGS_LOOK = NIHO7_DEVELOP_SETTINGS_LOOK;
export const SIGNED_WORKING_COPY_ENCODING = "signed-gamma18-v1";
/** `look` を持たない保存済みの編集内容のルック（段 2 の crate が読むときの既定と同じ。恒等）。 */
export const DEVELOP_SETTINGS_LOOK_WHEN_MISSING = "niho-interim-1";
/** この画面の crate が描けるルックの版。 */
export const DEVELOP_SETTINGS_LOOKS: readonly string[] = [
  DEVELOP_SETTINGS_LOOK_WHEN_MISSING,
  DEVELOP_SETTINGS_LOOK,
  SIGNED_DEVELOP_SETTINGS_LOOK,
  NIHO4_DEVELOP_SETTINGS_LOOK,
  NIHO7_DEVELOP_SETTINGS_LOOK,
];
/** niho-6 / niho-10 / niho-12〜niho-14 が描けるルック（crate と同じ。無ければ {@link DEVELOP_SETTINGS_LOOK_WHEN_MISSING}）。 */
export const NIHO6_DEVELOP_SETTINGS_LOOKS: readonly string[] = [DEVELOP_SETTINGS_LOOK_WHEN_MISSING, DEVELOP_SETTINGS_LOOK];
/** raster の作業コピーの土台の版の頭（niho-6 / niho-10 / niho-12〜niho-14 で描ける作業コピー）。 */
const RASTER_WORKING_COPY_BASE_PREFIX = "raster.";

const NIHO4_CALIBRATION_PATTERN = /^apple-ciraw8\/linear-prophoto-d50\/cal-(?:panasonic-dc-s5|sony-zv-e10m2|sony-ilme-fx30)-apple-v[0-9]+$/u;

export function supportsNiho4SignedRaw(meta: unknown): boolean {
  return isRecord(meta) && typeof meta.dcpSha256 === "string" && NIHO4_CALIBRATION_PATTERN.test(meta.dcpSha256);
}

/** niho-11 を新規既定にできる、校正が既知の signed RAW metadata か。 */
export function supportsNiho7SignedRaw(meta: unknown): boolean {
  return supportsNiho4SignedRaw(meta);
}

const SIGNED_RAW_BASE_VERSION_PATTERN = /^raw-apple\.d[A-Za-z0-9]+\.p3\.e4\./u;
const LEGACY_RAW_BASE_VERSION_PATTERN = /^raw-apple\.d[A-Za-z0-9]+\.p[0-2]\.e1(?:\.|$)/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** この画面が読む `developSettings` の形の版（1〜9。5: 部分補正、6: detail、7: 遠近、8: 修復、9: レンズ補正）。 */
export const DEVELOP_DETAIL_SETTINGS_VERSION = 6;
export type DevelopSettingsVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export function isDevelopSettingsVersion(value: unknown): value is DevelopSettingsVersion {
  return (
    value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6 || value === 7 || value === 8 || value === 9
  );
}

export type DevelopDetailSettings = {
  sharpening: { amount: number; radius: number; detail: number; masking: number };
  luminanceNoiseReduction: number;
  colorNoiseReduction?: number;
};

/** Rust readerと同じexact shape・有限値・範囲でv6 detailを読む。 */
export function readDevelopDetail(value: unknown): DevelopDetailSettings | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (!keys.every((key) => ["sharpening", "luminanceNoiseReduction", "colorNoiseReduction"].includes(key))) return null;
  if (!Object.hasOwn(value, "sharpening") || !Object.hasOwn(value, "luminanceNoiseReduction")) return null;
  const sharpening = value.sharpening;
  if (!isRecord(sharpening) || !hasExactKeys(sharpening, ["amount", "radius", "detail", "masking"])) return null;
  if (
    !finiteIn(sharpening.amount, 0, 150) ||
    !finiteIn(sharpening.radius, 0.5, 3) ||
    !finiteIn(sharpening.detail, 0, 100) ||
    !finiteIn(sharpening.masking, 0, 100) ||
    !finiteIn(value.luminanceNoiseReduction, 0, 100) ||
    (Object.hasOwn(value, "colorNoiseReduction") && !finiteIn(value.colorNoiseReduction, 0, 100))
  ) {
    return null;
  }
  return value as DevelopDetailSettings;
}

function hasValidDevelopDetail(value: Record<string, unknown>): boolean {
  return value.detail === undefined || readDevelopDetail(value.detail) !== null;
}

function hasDevelopDetail(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, "detail") && value.detail !== undefined;}

export const MAX_COLOR_POINTS = 8;

export type DevelopColorPoint = {
  id: string;
  target: { lightness: number; chroma: number; hue: number };
  range: { hue: number; chroma: number; lightness: number };
  delta: { hue: number; chromaScale: number; lightness: number };
};

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function finiteIn(value: unknown, min: number, max: number, upperExclusive = false): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    (upperExclusive ? value < max : value <= max)
  );
}

export function readDevelopColorPoints(value: unknown): DevelopColorPoint[] | null {
  if (!Array.isArray(value) || value.length > MAX_COLOR_POINTS) return null;
  const ids = new Set<string>();
  const points: DevelopColorPoint[] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasExactKeys(item, ["id", "target", "range", "delta"])) return null;
    if (typeof item.id !== "string" || item.id.length < 1 || item.id.length > 64 || !/^[\x00-\x7f]+$/u.test(item.id) || ids.has(item.id)) {
      return null;
    }
    if (!isRecord(item.target) || !hasExactKeys(item.target, ["lightness", "chroma", "hue"])) return null;
    if (!isRecord(item.range) || !hasExactKeys(item.range, ["hue", "chroma", "lightness"])) return null;
    if (!isRecord(item.delta) || !hasExactKeys(item.delta, ["hue", "chromaScale", "lightness"])) return null;
    if (
      !finiteIn(item.target.lightness, 0, 1) ||
      !finiteIn(item.target.chroma, 0, 5) ||
      !finiteIn(item.target.hue, 0, 360, true) ||
      !finiteIn(item.range.hue, 1, 180) ||
      !finiteIn(item.range.chroma, 0.001, 5) ||
      !finiteIn(item.range.lightness, 0.001, 1) ||
      !finiteIn(item.delta.hue, -180, 180) ||
      !finiteIn(item.delta.chromaScale, 0, 3) ||
      !finiteIn(item.delta.lightness, -1, 1)
    ) {
      return null;
    }
    ids.add(item.id);
    points.push(item as DevelopColorPoint);
  }
  return points;
}

export function developColorPoints(value: unknown): DevelopColorPoint[] {
  if (!isRecord(value) || value.colorPoints === undefined) return [];
  return readDevelopColorPoints(value.colorPoints) ?? [];
}

function hasValidDevelopColorPoints(value: Record<string, unknown>): boolean {
  return value.colorPoints === undefined || readDevelopColorPoints(value.colorPoints) !== null;
}

function hasDevelopColorPoints(value: Record<string, unknown>): boolean {
  const points = readDevelopColorPoints(value.colorPoints);
  return points !== null && points.length > 0;
}

function hasActiveDevelopColorPoints(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const points = readDevelopColorPoints(value.colorPoints);
  return points !== null && points.some((point) => point.delta.hue !== 0 || point.delta.chromaScale !== 1 || point.delta.lightness !== 0);
}

/** `geometry.perspective`（Lightroom の変形の 7 本。crate の `PerspectiveField`）の恒等の値。 */
export const DEVELOP_PERSPECTIVE_NEUTRAL: Readonly<Record<string, number>> = Object.freeze({
  vertical: 0,
  horizontal: 0,
  rotate: 0,
  aspect: 0,
  scale: 100,
  x: 0,
  y: 0,
});

/**
 * 遠近（`geometry.perspective`。niho-photo#46）が恒等でないか（crate の `Geometry::active_perspective`）。無い・7 本がすべて恒等の値
 * なら false。形の壊れた値（オブジェクトでない・知らない項目・恒等でない値）は恒等とみなさない（描けない設定として扱う）。
 * 「余白を埋める」（`constrain`）と Upright（`upright`）は数えない。
 */
export function hasDevelopPerspective(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.geometry)) return false;
  const perspective = value.geometry.perspective;
  if (perspective === undefined) return false;
  if (!isRecord(perspective)) return true;
  return Object.entries(perspective).some(
    ([key, item]) => !Object.hasOwn(DEVELOP_PERSPECTIVE_NEUTRAL, key) || item !== DEVELOP_PERSPECTIVE_NEUTRAL[key],
  );
}

/**
 * `geometry`（crate の `geometry.rs` の `is_identity`）が恒等でないか。回転（半回転と左右・上下の両方の反転は恒等）・角度・全体で
 * ない切り抜き・遠近のどれかがあれば true。縦横比の指定（`aspect`）・「余白を埋める」・Upright だけなら恒等。形の壊れた値は恒等と
 * みなさない（描けない設定として扱う）。
 */
export function hasDevelopGeometry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const geometry = value.geometry;
  if (geometry === undefined || geometry === null) return false;
  if (!isRecord(geometry)) return true;
  if (hasDevelopPerspective(value)) return true;
  const rotate = geometry.rotate ?? 0;
  const flipH = geometry.flipH ?? false;
  const flipV = geometry.flipV ?? false;
  const turned = !(
    (rotate === 0 && flipH === false && flipV === false) ||
    (rotate === 180 && flipH === true && flipV === true)
  );
  const crop = geometry.crop ?? {};
  if (!isRecord(crop)) return true;
  const edge = (key: string, whole: number) => (crop[key] === undefined ? whole : crop[key]);
  const whole = edge("left", 0) === 0 && edge("top", 0) === 0 && edge("right", 1) === 1 && edge("bottom", 1) === 1;
  return turned || (geometry.angle ?? 0) !== 0 || !whole;
}

export function hasNullDevelopGeometryField(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.geometry)) return false;
  const geometry = value.geometry;
  const keys = ["rotate", "flipH", "flipV", "angle", "perspective", "constrain", "upright"];
  if (keys.some((key) => Object.hasOwn(geometry, key) && geometry[key] === null)) return true;
  const perspective = geometry.perspective;
  if (isRecord(perspective) && Object.values(perspective).some((item) => item === null)) return true;
  if (!Object.hasOwn(geometry, "crop")) return false;
  const crop = geometry.crop;
  if (crop === null) return true;
  return isRecord(crop) && ["left", "top", "right", "bottom"].some((key) => Object.hasOwn(crop, key) && crop[key] === null);
}

/**
 * 編集内容に要る形の版（画を変えるレンズ補正なら9、修復の印なら8、遠近なら7、detailなら6、マスクなら5、色ポイントなら4、効果なら3、
 * 幾何なら2。crateの `required_version`）。
 */
export function developSettingsVersion(settings: Record<string, unknown>): DevelopSettingsVersion {
  if (hasActiveDevelopLens(settings)) return LENS_SETTINGS_VERSION;
  if (hasDevelopHeal(settings)) return HEAL_SETTINGS_VERSION;
  if (hasDevelopPerspective(settings)) return 7;
  if (hasDevelopDetail(settings)) return DEVELOP_DETAIL_SETTINGS_VERSION;
  if (hasDevelopMasks(settings)) return DEVELOP_MASKS_SETTINGS_VERSION;
  if (hasDevelopColorPoints(settings)) return 4;
  if (hasActiveDevelopEffects(settings)) return 3;
  return hasDevelopGeometry(settings) ? 2 : 1;
}

/** 新しく作る編集内容の数式の選び方（{@link newDevelopSettingsEngine}）。 */
export type NewDevelopSettingsEngineOptions = {
  /**
   * RAW の写真（作業コピーの無い RAW など、`base` が null でも JPEG / PNG のオリジナルから直接描くのではない写真）なら true。
   * `base` によらず {@link NIHO2_DEVELOP_SETTINGS_ENGINE} にする（作業コピーが signed になるか決まる前なので、signed を描かない
   * niho-14 にしない）。
   */
  raw?: boolean;
};

/**
 * 新しく作る（保存したことの無い写真の）編集内容の数式（#89・#27・#29。移行元設計）。JPEG / PNG をオリジナルから直接描く（`base: null`）・
 * raster の作業コピー（`raster.*`）・unsigned RAW の作業コピー（`raw-apple.*` の p0〜2 / e1）なら {@link DEVELOP_SETTINGS_ENGINE}
 * （niho-14）、版の分からない作業コピー・RAW の写真（`raw: true`）は {@link NIHO2_DEVELOP_SETTINGS_ENGINE}。signed RAW は
 * {@link signedNeutralDevelopSettings}。
 */
export function newDevelopSettingsEngine(base: string | null, options: NewDevelopSettingsEngineOptions = {}): string {
  if (options.raw === true) return NIHO2_DEVELOP_SETTINGS_ENGINE;
  if (base === null || base.startsWith(RASTER_WORKING_COPY_BASE_PREFIX) || LEGACY_RAW_BASE_VERSION_PATTERN.test(base)) {
    return DEVELOP_SETTINGS_ENGINE;
  }
  return NIHO2_DEVELOP_SETTINGS_ENGINE;
}

/**
 * 何も当てていない編集内容（「初期化」はこれを保存する）。小さな JPEG / PNG はオリジナルから直接描くので `base: null`、作業コピー
 * から描く写真（RAW など。移行元設計）は作業コピーの `baseVersion` を渡す。数式は {@link newDevelopSettingsEngine} で `base` から決める
 * （`base: null` で RAW の写真を持ちうる呼び出し側は `{ raw: true }` を渡す）。
 */
export function neutralDevelopSettings(
  base: string | null = null,
  options: NewDevelopSettingsEngineOptions = {},
): DevelopSettings {
  return {
    v: 1,
    engine: newDevelopSettingsEngine(base, options),
    look: DEVELOP_SETTINGS_LOOK,
    base,
    exposure: 0,
    contrast: 0,
    saturation: 0,
    relativeTemperature: 0,
    relativeTint: 0,
    whiteBalance: { mode: "asShot" },
  };
}

/** 未保存 signed RAW の初期化。対応校正だけ niho-11、その他は niho-3。 */
export function signedNeutralDevelopSettings(base: string, meta?: unknown): DevelopSettings {
  const niho7 = supportsNiho7SignedRaw(meta);
  return {
    ...neutralDevelopSettings(base),
    engine: niho7 ? NIHO11_DEVELOP_SETTINGS_ENGINE : SIGNED_DEVELOP_SETTINGS_ENGINE,
    look: niho7 ? NIHO11_DEVELOP_SETTINGS_LOOK : SIGNED_DEVELOP_SETTINGS_LOOK,
  };
}

export type SignedWorkingCopyState = "signed" | "unsigned" | "mismatch";

/** signed の判定はこのhelperだけで行い、baseとmetadataの片方だけ一致する入力を拒否する。 */
export function signedWorkingCopyState(baseVersion: unknown, meta: unknown): SignedWorkingCopyState {
  const signedBase = typeof baseVersion === "string" && SIGNED_RAW_BASE_VERSION_PATTERN.test(baseVersion);
  let metadataState: "signed_raw" | "legacy_raw" | "raster" | "legacy_unknown" | "absent" | "invalid";
  if (meta === undefined || meta === null) {
    metadataState = "absent";
  } else if (!isRecord(meta)) {
    metadataState = "invalid";
  } else if (meta.kind === "raw") {
    if (meta.encoding === undefined || meta.encoding === null) {
      metadataState = "legacy_raw";
    } else if (isRecord(meta.encoding)) {
      const keys = Object.keys(meta.encoding);
      const ceiling = meta.encoding.ceiling;
      metadataState =
        keys.length === 2 &&
        keys.includes("kind") &&
        keys.includes("ceiling") &&
        meta.encoding.kind === SIGNED_WORKING_COPY_ENCODING &&
        typeof ceiling === "number" &&
        Number.isFinite(ceiling) &&
        Number.isInteger(ceiling) &&
        ceiling >= 1 &&
        ceiling <= 65_536 &&
        (ceiling & (ceiling - 1)) === 0
          ? "signed_raw"
          : "invalid";
    } else {
      metadataState = "invalid";
    }
  } else if (meta.kind === "raster") {
    metadataState = meta.encoding === undefined || meta.encoding === null || meta.encoding === "jpeg8" ? "raster" : "invalid";
  } else if (!Object.hasOwn(meta, "kind") && !Object.hasOwn(meta, "encoding")) {
    metadataState = "legacy_unknown";
  } else {
    metadataState = "invalid";
  }
  if (metadataState === "invalid") return "mismatch";
  if (signedBase) return metadataState === "signed_raw" ? "signed" : "mismatch";
  if (metadataState === "signed_raw") return "mismatch";
  if (typeof baseVersion === "string" && baseVersion.startsWith("raw-apple.")) {
    return LEGACY_RAW_BASE_VERSION_PATTERN.test(baseVersion) && (metadataState === "legacy_raw" || metadataState === "absent")
      ? "unsigned"
      : "mismatch";
  }
  if (typeof baseVersion === "string" && baseVersion.startsWith("raster.")) {
    return metadataState === "raster" || metadataState === "absent" ? "unsigned" : "mismatch";
  }
  return metadataState === "legacy_unknown" || metadataState === "legacy_raw" || metadataState === "raster" || metadataState === "absent"
    ? "unsigned"
    : "mismatch";
}

export class DevelopSettingsBaseMismatchError extends Error {
  constructor(readonly reason: "base_mismatch" | "signed_mismatch" | "engine_mismatch") {
    super(reason);
    this.name = "DevelopSettingsBaseMismatchError";
  }
}

/**
 * 作業コピー（`baseVersion`）の上で直す編集内容にする（移行元設計）。設定が無ければその版の neutral（NIHO 標準ルック。数式は
 * raster・unsigned RAW の作業コピーなら niho-14、版の分からない作業コピーなら niho-2、signed RAW なら niho-3 / niho-4 / niho-7 /
 * niho-11）。保存済みの nonempty `base` があれば同じ版だけを使い、新しい版へ無言で上書きしない。数式・ルックも保存済みの版のまま
 * （S8 移行元設計）。niho-6 / niho-10 の保存済みの設定は raster の作業コピーの上でだけ開く（RAW・版の分からない作業コピーの上では
 * `engine_mismatch`。移行元設計）。niho-12〜niho-14 は signed RAW の上では開かない（`engine_mismatch`）。
 */
export function developSettingsOnWorkingCopy(
  settings: DevelopSettings | null,
  baseVersion: string,
  meta?: unknown,
): DevelopSettings {
  const signed = signedWorkingCopyState(baseVersion, meta);
  if (signed === "mismatch") throw new DevelopSettingsBaseMismatchError("signed_mismatch");
  if (!settings) return signed === "signed" ? signedNeutralDevelopSettings(baseVersion, meta) : neutralDevelopSettings(baseVersion);
  if (typeof settings.base === "string" && settings.base.length > 0 && settings.base !== baseVersion) {
    throw new DevelopSettingsBaseMismatchError("base_mismatch");
  }
  // niho-6 / niho-10 は RAW・camera-linear の作業コピーを描かない（crate の IncompatibleWorkingCopy）。描けないルックとの組も開かない
  const rasterEngine = settings.engine === NIHO10_DEVELOP_SETTINGS_ENGINE || settings.engine === NIHO6_DEVELOP_SETTINGS_ENGINE;
  if (
    rasterEngine &&
    (!baseVersion.startsWith(RASTER_WORKING_COPY_BASE_PREFIX) || !isNiho6Look(settings.look))
  ) {
    throw new DevelopSettingsBaseMismatchError("engine_mismatch");
  }
  // niho-12〜niho-14 は raster と unsigned RAW の作業コピーを描く（signed RAW は下の照合で止める）。ルックは niho-6 / niho-10 と同じ版だけ
  if (isFloatCubeEngine(settings.engine) && !isNiho6Look(settings.look)) {
    throw new DevelopSettingsBaseMismatchError("engine_mismatch");
  }
  const signedEngine = settings.engine === SIGNED_DEVELOP_SETTINGS_ENGINE;
  const signedLook = settings.look === SIGNED_DEVELOP_SETTINGS_LOOK;
  const niho4Engine = settings.engine === NIHO4_DEVELOP_SETTINGS_ENGINE;
  const niho4Look = settings.look === NIHO4_DEVELOP_SETTINGS_LOOK;
  const niho7Engine = settings.engine === NIHO7_DEVELOP_SETTINGS_ENGINE;
  const niho7Look = settings.look === NIHO7_DEVELOP_SETTINGS_LOOK;
  const niho11Engine = settings.engine === NIHO11_DEVELOP_SETTINGS_ENGINE;
  if (signedEngine !== signedLook || niho4Engine !== niho4Look || (niho7Engine || niho11Engine) !== niho7Look ||
      (signed === "signed") !== (signedEngine || niho4Engine || niho7Engine || niho11Engine) ||
      ((niho4Engine || niho7Engine || niho11Engine) && !supportsNiho7SignedRaw(meta))) {
    if (signed === "unsigned" && !baseVersion.startsWith("raw-apple.") && signedEngine && signedLook) {
      // niho-3 raster は既存の対応済み仕様。RAW以外では保持する。
    } else {
      throw new DevelopSettingsBaseMismatchError("engine_mismatch");
    }
  }
  const next = { ...settings, base: baseVersion, look: settings.look ?? DEVELOP_SETTINGS_LOOK_WHEN_MISSING };
  return { ...next, v: developSettingsVersion(next) };
}

/**
 * API の値を編集内容として読む（形の版が1〜9でない・色ポイント、マスク、detail、遠近、修復、レンズ補正の形が壊れている・必要な版より
 * 低ければ null）。
 */
export function readDevelopSettings(value: unknown): DevelopSettings | null {
  if (
    !isRecord(value) ||
    !isDevelopSettingsVersion(value.v) ||
    !hasValidDevelopColorPoints(value) ||
    !hasValidDevelopMasks(value) ||
    !hasValidDevelopDetail(value) ||
    !hasValidDevelopLens(value)
  ) {
    return null;
  }
  if (value.v < developSettingsVersion(value)) return null;
  if (hasDevelopColorPoints(value) && value.v < 4) return null;
  if (
    !isRecord(value) ||
    !isDevelopSettingsVersion(value.v) ||
    !hasValidDevelopColorPoints(value) ||
    !hasValidDevelopMasks(value) ||
    !hasValidDevelopDetail(value) ||
    !hasValidDevelopHeal(value)
  ) {
    return null;
  }
  const engine = value.engine;
  if (typeof engine !== "string") return null;
  return { ...value, v: value.v, engine };
}

/**
 * このブラウザの版で続きを直せる編集内容か。まだ無い（null）なら直せる。形の版が1〜9で、この画面が知る数式とルックのときだけ直せる。
 * 未対応の項目を落として描かない。恒等でない幾何をv1で持つ壊れた設定は直さず、幾何を扱えない面は `{ geometry: false }` を渡す。
 * 閲覧だけにする（切り抜きを落として描かない・保存しない）。
 */
export function isEditableDevelopSettings(value: unknown, options: { geometry?: boolean } = {}): boolean {
  if (value === null || value === undefined) return true;
  if (
    !isRecord(value) ||
    !isDevelopSettingsVersion(value.v) ||
    !hasValidDevelopColorPoints(value) ||
    !hasValidDevelopMasks(value) ||
    !hasValidDevelopDetail(value) ||
    !hasValidDevelopHeal(value) ||
    !hasValidDevelopLens(value)
  ) {
    return false;
  }
  const legacyEngine = value.engine === NIHO2_DEVELOP_SETTINGS_ENGINE || value.engine === LEGACY_DEVELOP_SETTINGS_ENGINE;
  const niho6Engine = value.engine === NIHO6_DEVELOP_SETTINGS_ENGINE || value.engine === NIHO10_DEVELOP_SETTINGS_ENGINE;
  const niho12Engine = isFloatCubeEngine(value.engine);
  const signedEngine = value.engine === SIGNED_DEVELOP_SETTINGS_ENGINE;
  const niho4Engine = value.engine === NIHO4_DEVELOP_SETTINGS_ENGINE;
  const niho7Engine = value.engine === NIHO7_DEVELOP_SETTINGS_ENGINE;
  const niho11Engine = value.engine === NIHO11_DEVELOP_SETTINGS_ENGINE;
  if (!legacyEngine && !niho6Engine && !niho12Engine && !signedEngine && !niho4Engine && !niho7Engine && !niho11Engine) {
    return false;
  }
  if (value.v < developSettingsVersion(value)) return false;
  if (value.look !== undefined && (typeof value.look !== "string" || !DEVELOP_SETTINGS_LOOKS.includes(value.look))) return false;
  // niho-6 / niho-10 / niho-12〜niho-14 は NIHO 標準ルック（standard-1）と恒等（interim-1・無し）だけを描く
  if ((niho6Engine || niho12Engine) && !isNiho6Look(value.look)) return false;
  if (signedEngine !== (value.look === SIGNED_DEVELOP_SETTINGS_LOOK)) return false;
  if (niho4Engine !== (value.look === NIHO4_DEVELOP_SETTINGS_LOOK)) return false;
  if ((niho7Engine || niho11Engine) !== (value.look === NIHO7_DEVELOP_SETTINGS_LOOK)) return false;
  return options.geometry !== false || !hasDevelopGeometry(value);
}

/**
 * float cube の数式（niho-12・niho-13・新規既定の niho-14）か。どれも raster と unsigned RAW の作業コピーを描き、ルックは niho-6 と
 * 同じ版だけ。違いは raster の相対 WB を当てる場所（niho-12 は出力側、niho-13 / niho-14 は先頭）と H/S の解析（niho-14 は軽い計算）。
 */
function isFloatCubeEngine(engine: unknown): boolean {
  return (
    engine === DEVELOP_SETTINGS_ENGINE ||
    engine === NIHO13_DEVELOP_SETTINGS_ENGINE ||
    engine === NIHO12_DEVELOP_SETTINGS_ENGINE
  );
}

/** niho-6 / niho-10 / niho-12〜niho-14 が描けるルックか（無ければ恒等のルックとして描ける）。 */
function isNiho6Look(look: unknown): boolean {
  return look === undefined || (typeof look === "string" && NIHO6_DEVELOP_SETTINGS_LOOKS.includes(look));
}

/**
 * 右パネルの「初期化」で保存する編集内容: 色の補正だけを neutral に戻し、幾何と修復の印（写真の中身の直し）は保つ。効果や部分補正は色の補正として外す。
 * レンズ補正（`lens`。niho-photo#45）も右パネルの補正なので外す（「補正前」も手動のレンズ補正の無い写真と比べる）。
 * `engine`・`look`・`base` は現在の値を保ち、形の版は残した幾何と修復の印から決め直す。 */
export function resetDevelopSettingsColors(current: DevelopSettings | null, base: string | null): DevelopSettings {
  const neutral: DevelopSettings = neutralDevelopSettings(base);
  if (current) neutral.engine = current.engine;
  if (current && current.look === undefined) delete neutral.look;
  else if (current) neutral.look = current.look;
  if (!current || (!isRecord(current.geometry) && current.heal === undefined)) return neutral;
  const next: Record<string, unknown> = { ...neutral };
  if (isRecord(current.geometry)) next.geometry = current.geometry;
  if (current.heal !== undefined) next.heal = current.heal;
  return { ...next, v: developSettingsVersion(next), engine: neutral.engine };
}

/**
 * プリセットを当てた結果（crate の `presetSettings`）を、当てる前の編集内容 `base` の枠に入れる（F2b 移行元設計）。プリセットは色の
 * 補正だけを変え、ルック・土台の版（`look`・`base`）と幾何（切り抜き・回転）は当てる前のまま保つ
 * （`engine` は通常 base のまま。旧式 niho-1 の写真に非 0 の増分 WB を当てたときの Rust の `niho-2` 昇格だけ保持する。niho-3 /
 * niho-4 / niho-6〜niho-14 の写真は Rust も昇格させない）
 * （移行時の設計文書「プリセットの適用量・書き出し・見本」）。形の版 `v` は保った幾何から決め直す。効果
 * （`grayscale`・`grayMixer`・`vignette`・`grain`）は色の補正と同じくプリセットの結果のまま入れる（モノクロのプリセットを当てると
 * 白黒になる。E1b 移行元設計）。
 *
 * 部分補正（`masks`）は写真自身の編集で、`presetResult` の `masks` は使わない。プリセット（Lightroom の XMP）がマスクを持つときは
 * `presetMasks`（結果の `masks` と、当てる写真の作業画像の大きさ）を渡すと、写真の幾何で見えている枠から作業画像の座標へ写して
 * 写真のマスクと置き換える（`develop-preset-masks.ts`。docs/local-adjustments.md「Lightroom の XMP の読み」）。渡さない・大きさが
 * 分からない・1 枚も置けないときは、当てる前の写真のマスクのまま。
 *
 * 幾何のうち変形（遠近 `perspective` と Upright の `upright`。niho-photo#46）だけはプリセットの結果を
 * 入れる（crate が当てる前の幾何にプリセットの `Perspective*` を当てたもの。Lightroom のプリセットの変形も当たる）。 */
export function presetDevelopSettings(
  base: DevelopSettings,
  presetResult: DevelopSettings,
  presetMasks?: PresetMasksPlacement,
): DevelopSettings {
  const next: Record<string, unknown> = { ...presetResult, base: base.base ?? null };
  // Adobe crs:PointColors は非公開形式で相互変換しない。NIHO の点は
  // XMP プリセットを当てても写真自身の編集として保持する。
  if (base.colorPoints === undefined) delete next.colorPoints;
  else next.colorPoints = base.colorPoints;
  const whiteBalance = presetResult.whiteBalance;
  const placed = presetMasksForPhoto(base.geometry, presetMasks, isRecord(whiteBalance) ? whiteBalance.mode : undefined);
  if (placed) next.masks = placed;
  else if (base.masks === undefined) delete next.masks;
  else next.masks = base.masks;
  // 修復の印は写真固有なので、プリセット結果からは運ばず元の写真の値を保つ。
  if (base.heal === undefined) delete next.heal;
  else next.heal = base.heal;  if (base.look === undefined) delete next.look;
  else next.look = base.look;
  const geometry = presetGeometry(base.geometry, presetResult.geometry);
  if (geometry) next.geometry = geometry;
  else delete next.geometry;
  const promoted =
    presetResult.engine === NIHO2_DEVELOP_SETTINGS_ENGINE && base.engine === LEGACY_DEVELOP_SETTINGS_ENGINE;
  return { ...next, v: developSettingsVersion(next), engine: promoted ? NIHO2_DEVELOP_SETTINGS_ENGINE : base.engine };
}

/** プリセットの結果に入れる幾何の項目（変形）。ほかは当てる前のまま。 */
const PRESET_GEOMETRY_KEYS = ["perspective", "upright"] as const;

/**
 * 当てる前の幾何 `base` に、プリセットの結果の幾何 `preset` の変形（{@link PRESET_GEOMETRY_KEYS}）だけを入れる。当てる前に幾何が
 * 無く、変形も入らなければ null（キーを作らない）。
 */
function presetGeometry(base: unknown, preset: unknown): Record<string, unknown> | null {
  const next: Record<string, unknown> = isRecord(base) ? { ...base } : {};
  const source = isRecord(preset) ? preset : {};
  for (const key of PRESET_GEOMETRY_KEYS) {
    if (source[key] === undefined) delete next[key];
    else next[key] = source[key];
  }
  return isRecord(base) || Object.keys(next).length > 0 ? next : null;
}

/**
 * 「自動」の結果（crate の `Developer.autoSettings`。F4a 移行元設計）を、押す前の編集内容 `before` の枠に入れる（F4b 移行元設計）。crate は
 * ライト 6 本と自然な彩度だけを変えてほかのキーは渡したまま返すが、画面でも数式の版・ルック・土台の版（`engine`・`look`・`base`）・
 * 幾何（切り抜き・回転）と効果（`grayscale`・`grayMixer`・`vignette`・`grain`）を押す前のものにそろえる（プリセットと違い、自動は
 * 白黒にしない）。形の版 `v` は保った幾何から決め直す。
 */
export function autoDevelopSettings(before: DevelopSettings, autoResult: DevelopSettings): DevelopSettings {
  const next: Record<string, unknown> = { ...presetDevelopSettings(before, autoResult) };
  for (const key of DEVELOP_EFFECT_SETTINGS_KEYS) {
    if (before[key] === undefined) delete next[key];
    else next[key] = before[key];
  }
  // 幾何は変形も含めて押す前のまま
  if (isRecord(before.geometry)) next.geometry = before.geometry;
  else delete next.geometry;
  return { ...next, v: developSettingsVersion(next), engine: before.engine };
}

/**
 * コピーした補正（「補正をコピー」。F5a-2 移行元設計）。色の補正（HSL・効果・レンズ補正〔レンズと撮影の特性。niho-photo#45〕など、この画面が
 * 知らない項目も含む全部）を持ち、貼り付け先の
 * ものを保つ項目（数式の版・ルック・土台の版・幾何・マスク・修復の印）は持たない。RAW の絶対のホワイトバランスも写さない。
 * マスクと修復の印は写真固有の編集なので、ほかの写真へは運ばない。 */
export type CopiedDevelopSettings = Record<string, unknown>;

export function copyDevelopSettings(settings: DevelopSettings): CopiedDevelopSettings {
  const { v: _v, engine: _engine, look: _look, base: _base, geometry: _geometry, masks: _masks, heal: _heal, ...rest } = settings;
  const copied: CopiedDevelopSettings = { ...rest };
  const detail = readDevelopDetail(copied.detail);
  if (detail) copied.detail = { ...detail, sharpening: { ...detail.sharpening } };
  if (isRecord(copied.whiteBalance) && copied.whiteBalance.mode === "absolute") delete copied.whiteBalance;
  return copied;
}

/**
 * コピーした補正を今の編集内容 `base` に貼り付けた結果（「補正を貼り付け」。取り消しの 1 単位で確定する）。色の補正はコピーした
 * 全部に置き換え（コピーに無い項目は neutral）、数式の版・ルック・土台の版と幾何（切り抜き・回転）・修復の印は貼り付け先のまま。ホワイト
 * バランスは、コピーに無い（RAW の絶対値だった）とき・貼り付け先が絶対値（RAW で撮影時の白から直した）ときは mode と相対値を含めて貼り付け先のまま。
 * 部分補正（`masks`）も貼り付け先のまま（コピーに入っていても使わない）。形の版 `v` は保った幾何・マスク・修復の印から決め直す。
 */
export function pasteDevelopSettings(base: DevelopSettings, copied: CopiedDevelopSettings): DevelopSettings {
  const baseVersion = typeof base.base === "string" ? base.base : null;
  const next: Record<string, unknown> = { ...neutralDevelopSettings(baseVersion), ...copied, base: baseVersion };
  if (base.look === undefined) delete next.look;
  else next.look = base.look;
  if (isRecord(base.geometry)) next.geometry = base.geometry;
  else delete next.geometry;
  if (base.masks === undefined) delete next.masks;
  else next.masks = base.masks;
  if (base.heal === undefined) delete next.heal;
  else next.heal = base.heal;
  const baseWhiteBalance = isRecord(base.whiteBalance) ? base.whiteBalance : null;
  if (copied.whiteBalance === undefined || baseWhiteBalance?.mode === "absolute") {
    if (baseWhiteBalance) next.whiteBalance = baseWhiteBalance;
    else delete next.whiteBalance;
    if (base.relativeTemperature === undefined) delete next.relativeTemperature;
    else next.relativeTemperature = base.relativeTemperature;
    if (base.relativeTint === undefined) delete next.relativeTint;
    else next.relativeTint = base.relativeTint;
  }
  return { ...next, v: developSettingsVersion(next), engine: base.engine };
}

/** 編集内容から、ブラウザのスライダーの値を読む（無い項目は 0）。 */
export function readBrowserAdjustmentsFromDevelopSettings(settings: DevelopSettings | null): BrowserPhotoAdjustments {
  const source: Record<string, unknown> = settings ?? {};
  return normalizeBrowserPhotoAdjustments({
    exposure: numberOrZero(source.exposure),
    contrast: numberOrZero(source.contrast),
    saturation: numberOrZero(source.saturation),
    temperature: numberOrZero(source.relativeTemperature),
    tint: numberOrZero(source.relativeTint),
  });
}

/**
 * スライダーの値を編集内容に重ねる。土台（`base`。無ければ JPEG / PNG をオリジナルから直接描く neutral〔niho-14〕。RAW の写真は
 * `neutralDevelopSettings(null, { raw: true })` を土台に渡す）の知らない項目は残す。相対の色温度 / 色かぶり補正を
 * 動かしたら `whiteBalance.mode` を `relative` にし（段 2 はそれを求める）、両方 0 に戻したら撮影時（`asShot`）に戻す。
 */
export function applyBrowserAdjustmentsToDevelopSettings(
  base: DevelopSettings | null,
  adjustments: BrowserPhotoAdjustments,
): DevelopSettings {
  const source = base ?? neutralDevelopSettings();
  const value = normalizeBrowserPhotoAdjustments(adjustments);
  const baseWhiteBalance = isRecord(source.whiteBalance) ? source.whiteBalance : null;
  let whiteBalance: Record<string, unknown>;
  if (value.temperature !== 0 || value.tint !== 0) {
    whiteBalance = { ...(baseWhiteBalance ?? {}), mode: "relative" };
  } else if (baseWhiteBalance?.mode === "relative") {
    whiteBalance = { ...baseWhiteBalance, mode: "asShot" };
  } else {
    whiteBalance = baseWhiteBalance ?? { mode: "asShot" };
  }
  return {
    ...source,
    v: developSettingsVersion(source),
    engine: source.engine,
    look: source.look === undefined ? DEVELOP_SETTINGS_LOOK_WHEN_MISSING : source.look,
    base: source.base === undefined ? null : source.base,
    exposure: value.exposure,
    contrast: value.contrast,
    saturation: value.saturation,
    relativeTemperature: value.temperature,
    relativeTint: value.tint,
    whiteBalance,
  };
}

/**
 * ブラウザで直し始める編集内容（開いたときの土台。無ければ JPEG / PNG を直接描く neutral）。版の情報をそろえ、露光量・コントラスト・彩度と相対の白を
 * 範囲に収め、相対の白と `whiteBalance.mode` を合わせる（段 2 の `modeMismatch` を避ける）。ほかの項目はそのまま持つ。
 */
export function browserEditingDevelopSettings(base: DevelopSettings | null): DevelopSettings {
  return applyBrowserAdjustmentsToDevelopSettings(base, readBrowserAdjustmentsFromDevelopSettings(base));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
  }
  return result;
}

/**
 * 編集内容を比べるための文字列。キーの順を問わず、0 が既定の調整項目（露光量・ハイライトなど）は無いのと 0 を同じにする
 * （スライダーを 0 のまま離した・0 でダブルクリックしたときに、変わったと数えない）。
 */
export function developSettingsKey(settings: DevelopSettings): string {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined || (PHOTO_EDITING_ZERO_DEFAULT_KEYS.has(key) && value === 0)) continue;
    record[key] = value;
  }
  return JSON.stringify(canonicalValue(record));
}

/** 2 つの編集内容が同じか（{@link developSettingsKey} で比べる）。 */
export function sameDevelopSettings(a: DevelopSettings, b: DevelopSettings): boolean {
  return a === b || developSettingsKey(a) === developSettingsKey(b);
}

/** 版の情報（見た目を変えない）。 */
const DEVELOP_METADATA_KEYS: ReadonlySet<string> = new Set(["v", "engine", "look", "base"]);

/** 0 でない既定値を持つ項目（既定値なら何も当てていない）。 */
const DEVELOP_DEFAULT_VALUES: ReadonlyMap<string, number> = new Map([
  ["parametricShadowSplit", 25],
  ["parametricMidtoneSplit", 50],
  ["parametricHighlightSplit", 75],
  ["curveRefineSaturation", 100],
]);

/**
 * 何も当てていない編集内容か（無ければ true）。恒等でない幾何（切り抜き・回転）・修復の印があれば neutral にしない（オリジナルの
 * ままでは見せられない）。版の情報と既定値の項目を除き、残りを Photo Bench の neutral の判定にかける（分からない項目があれば neutral と
 * みなさない）。変換できなかった値（`legacySettings`）があれば neutral にしない。相対の色温度 / 色かぶり補正が 0 なら、
 * `whiteBalance.mode` が `relative` でも撮影時のままとみなす。
 */
export function isNeutralDevelopSettings(value: unknown): boolean {
  if (hasDevelopGeometry(value) || hasDevelopHeal(value)) return false;
  return isNeutralDevelopColors(value);
}

/**
 * 色の補正が何も当たっていないか（幾何と修復の印は見ない。右パネルの「初期化」を押せるかに使う。初期化は色だけを戻し、切り抜きと
 * 修復の印は戻さない）。画を変えるレンズ補正（`lens`）は初期化で戻すので数える（中点・色相の範囲だけの `lens` は数えない）。
 * ほかは {@link isNeutralDevelopSettings} と同じ。効果（白黒・周辺光量補正・粒子。E1 移行元設計）は crate の `is_neutral` と同じ規則で
 * 数える: 白黒がオン・周辺光量補正か粒子の量が 0 でなければ neutral にしない（量が 0 の `vignette` / `grain` と、白黒でないときの
 * `grayMixer` は画に効かないので neutral のまま）。
 */
export function isNeutralDevelopColors(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.legacySettings !== undefined && value.legacySettings !== null) return false;
  const rest: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (DEVELOP_METADATA_KEYS.has(key) || key === "legacySettings" || key === "geometry" || key === "heal") continue;
    if (key === "colorPoints" && !hasActiveDevelopColorPoints(value)) continue;
    // 画を変えないマスク（無効・何も動かさない）は色の補正ではない。形が壊れていれば残して neutral にしない
    if (key === "masks" && hasValidDevelopMasks(value) && !hasActiveDevelopMasks(value)) continue;
    if (key === "lens") {
      const lens = readDevelopLens(item);
      if (lens !== null && !isActiveDevelopLens(lens)) continue;
    }
    if (key === "detail") {
      const detail = readDevelopDetail(item);
      if (
        detail !== null &&
        detail.sharpening.amount === 0 &&
        detail.luminanceNoiseReduction === 0 &&
        (detail.colorNoiseReduction === undefined || detail.colorNoiseReduction === 0)
      ) continue;
    }
    if (DEVELOP_DEFAULT_VALUES.has(key) && item === DEVELOP_DEFAULT_VALUES.get(key)) continue;
    // 画に効いていない効果の項目は除く（効いている・形の壊れた項目は残り、下の判定で neutral にならない）
    if (isInactiveDevelopEffect(key, item) === true) continue;
    rest[key] = item;
  }
  const whiteBalance = rest.whiteBalance;
  if (
    isRecord(whiteBalance) &&
    whiteBalance.mode === "relative" &&
    numberOrZero(rest.relativeTemperature) === 0 &&
    numberOrZero(rest.relativeTint) === 0
  ) {
    rest.whiteBalance = { ...whiteBalance, mode: "asShot" };
  }
  return isNeutralPhotoEditingSettings(rest);
}

/**
 * クラウドの写真に補正（`developSettings`）を保存してあるか。補正の置き場は `developSettings` の 1 つで、旧エンジン（Photo Bench）の
 * `settings` は読まない（K1c 移行元設計。保存したことの無い写真は補正なし）。neutral かどうかは見ない（「初期化」も保存した補正）。
 */
export function hasSavedDevelopSettings(photo: { developSettings?: unknown }): boolean {
  return isRecord(photo.developSettings);
}

/** Photo Bench `EditSettings` の既知の top-level の項目（`developSettings` から Photo Bench の形へ戻すときに残す）。 */
const EDIT_SETTINGS_KEYS: readonly string[] = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "texture",
  "clarity",
  "dehaze",
  "vibrance",
  "saturation",
  "relativeTemperature",
  "relativeTint",
  "toneCurves",
  "hsl",
  "calibration",
  "colorGrading",
  "parametricShadows",
  "parametricDarks",
  "parametricLights",
  "parametricHighlights",
  "parametricShadowSplit",
  "parametricMidtoneSplit",
  "parametricHighlightSplit",
  "curveRefineSaturation",
];

/** 旧エンジン（Photo Bench）の形に無い、NIHO の効果のキー。 */
const DEVELOP_EFFECT_SETTINGS_KEYS = ["grayscale", "grayMixer", "vignette", "grain"] as const;

/**
 * `developSettings` を Photo Bench `EditSettings` の形へ戻す（NIHO Desktop の面が、クラウドに結び付いたこの Mac の写真を Photo Bench で
 * 描くとき・原寸の書き出しのときに使う。crate の `convert::to_edit_settings_value` と同じ規則）。版の情報（`v`・`engine`・`look`・`base`）と知らない項目は落とし、白は
 * `absolute` → `custom`、ほか（撮影時・相対）→ `asShot`（相対の値はそのまま残る）。作業コピーの上で直した RAW などの補正
 * （`base` がある。移行元設計）も同じ規則で戻し、Desktop は自分の土台で描く（owner 決定 2026-09-29「写真 1 枚に補正 1 つ」）。
 * 変換できなかった値（`legacySettings`）か恒等でない幾何・修復の印・画を変えるレンズ補正があれば戻せないので null。
 */
export function developSettingsToEditSettings(value: unknown): Record<string, unknown> | null {
  const settings = readDevelopSettings(value);
  if (!settings) return null;
  if (settings.legacySettings !== undefined && settings.legacySettings !== null) return null;
  // 旧エンジンの形は幾何を持てない（切り抜き・回転を落として写さない。移行元設計）
  if (hasDevelopGeometry(settings)) return null;
  // 修復の印も旧エンジンの形に無い（落として写すと、消したものが戻る）
  if (hasDevelopHeal(settings)) return null;
  // 画を変えるレンズ補正も旧エンジンの形に無い（落として写すと、直した歪み・周辺光量・色収差が戻る）
  if (hasActiveDevelopLens(settings)) return null;
  // 効いている効果（白黒・周辺光量補正・粒子。E1 移行元設計）も旧エンジンの形に無い。落として写すと、白黒の写真が色つきで出る
  if (DEVELOP_EFFECT_SETTINGS_KEYS.some((key) => isInactiveDevelopEffect(key, settings[key]) === false)) return null;
  if (hasDevelopColorPoints(settings)) return null;
  // 部分補正（マスク）も旧エンジンの形に無い。落として写すと、局所の補正が消えた画になる
  if (hasDevelopMasks(settings)) return null;
  const result: Record<string, unknown> = {};
  for (const key of EDIT_SETTINGS_KEYS) {
    if (settings[key] !== undefined) result[key] = settings[key];
  }
  const whiteBalance = isRecord(settings.whiteBalance) ? settings.whiteBalance : null;
  const nextWhiteBalance: Record<string, unknown> = { mode: whiteBalance?.mode === "absolute" ? "custom" : "asShot" };
  for (const key of ["temperature", "tint"]) {
    const item = whiteBalance?.[key];
    if (typeof item === "number" && Number.isFinite(item)) nextWhiteBalance[key] = item;
  }
  result.whiteBalance = nextWhiteBalance;
  return result;
}
