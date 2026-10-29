import { HEAL_SETTINGS_VERSION } from "./develop-engine/develop-heal";
import { LENS_SETTINGS_VERSION, hasActiveDevelopLens } from "./develop-engine/develop-lens";
import { developSettingsVersion, hasDevelopPerspective } from "./develop-engine/develop-settings";
import type { PhotoLibraryNativeRenderer, PhotoLibraryPlace } from "./library/photo-library";
import { hasPhotoEditingColorGradingNativeExportUnsupportedLuminance } from "./photo-editing-color-grading";
import {
  PHOTO_EDITING_EXPORT_FULL_SIZE_COLOR_GRADING_UNSUPPORTED_FAILED_TEXT,
  PHOTO_EDITING_EXPORT_FULL_SIZE_COLOR_GRADING_UNSUPPORTED_TEXT,
  PHOTO_EDITING_EXPORT_FULL_SIZE_NATIVE_BLOCKER_LABELS,
  PHOTO_EDITING_EXPORT_FULL_SIZE_NATIVE_UPDATE_HINTS,
  PHOTO_EDITING_EXPORT_FULL_SIZE_NATIVE_UPDATE_TEXTS,
} from "./photo-editing-copy";
import type { PhotoEditingSettings } from "./photo-editing-types";

/**
 * 原寸の native renderer（Mac の sidecar `niho-develop-render`）が描けない補正。画面の wasm は描けるので、書き出しの経路だけを塞ぐ。
 * 描画が描ける設定を答える（`niho-develop-render capabilities`。{@link PhotoLibraryNativeRenderer}）ときはそれで決め、答えない古い
 * 描画（配布中の 0.16.0 など）では次の 4 つをいつも塞ぐ（niho-photo#102・#131。版ではなく描ける設定で決める）。
 *
 * - `colorGradingLuminance`: 中間調・全体の輝度（#39。`v` を上げずに足した描画 `colorGradingLuminance`）。古い renderer は黙って無視して
 *   別の画を書く
 * - `perspective`: 遠近（設定 v7。#46）。古い renderer は `unsupported_settings` で断る
 * - `heal`: 修復の印（設定 v8。#44）。同上
 * - `lens`: 画を変えるレンズ補正（設定 v9。#45）。同上
 * - `settings`: ほかの描けない設定（描画が読めない `v`・engine。描画が答えたときだけ。上の 4 つが無いとき）
 */
export type PhotoEditingNativeExportBlocker = "colorGradingLuminance" | "perspective" | "heal" | "lens" | "settings";

/** 遠近の設定の版（`developSettingsVersion` の 7）。 */
const PERSPECTIVE_SETTINGS_VERSION = 7;
/** 中間調・全体の輝度を描く描画の印（{@link PhotoLibraryNativeRenderer.features}）。 */
const COLOR_GRADING_LUMINANCE_FEATURE = "colorGradingLuminance";
/** {@link readPhotoLibraryNativeRenderer} が受け取る一覧の長さの上限。 */
const NATIVE_RENDERER_MAX_ITEMS = 64;

/** 修復の印が 1 つでもあるか（形の壊れた `heal` も、描けない設定として true）。 */
function hasHealMarks(settings: PhotoEditingSettings): boolean {
  const heal = settings.heal;
  if (heal === undefined || heal === null) return false;
  return !Array.isArray(heal) || heal.length > 0;
}

/** 答えた描画が、この設定の `v`（書いてある版と、中身に要る版）と engine を読めるか。 */
function rendererReads(renderer: PhotoLibraryNativeRenderer, settings: PhotoEditingSettings): boolean {
  if (typeof settings.v === "number" && !renderer.settingsVersions.includes(settings.v)) return false;
  if (!renderer.settingsVersions.includes(developSettingsVersion(settings))) return false;
  return typeof settings.engine !== "string" || renderer.engines.includes(settings.engine);
}

/**
 * この設定を原寸の native renderer へ渡せない理由（固定の順。無ければ空）。`renderer` は描画が描ける設定（省略・null = 答えない
 * 古い描画）。
 */
export function photoEditingNativeExportBlockers(
  settings: PhotoEditingSettings,
  renderer?: PhotoLibraryNativeRenderer | null,
): PhotoEditingNativeExportBlocker[] {
  const readsVersion = (version: number) => renderer?.settingsVersions.includes(version) === true;
  const blockers: PhotoEditingNativeExportBlocker[] = [];
  if (
    hasPhotoEditingColorGradingNativeExportUnsupportedLuminance(settings) &&
    renderer?.features.includes(COLOR_GRADING_LUMINANCE_FEATURE) !== true
  ) {
    blockers.push("colorGradingLuminance");
  }
  if (hasDevelopPerspective(settings) && !readsVersion(PERSPECTIVE_SETTINGS_VERSION)) blockers.push("perspective");
  if (hasHealMarks(settings) && !readsVersion(HEAL_SETTINGS_VERSION)) blockers.push("heal");
  if (hasActiveDevelopLens(settings) && !readsVersion(LENS_SETTINGS_VERSION)) blockers.push("lens");
  if (renderer && blockers.length === 0 && !rendererReads(renderer, settings)) blockers.push("settings");
  return blockers;
}

/** 原寸の native renderer が描けない補正が 1 つでもあるか。 */
export function hasPhotoEditingNativeExportUnsupportedSettings(
  settings: PhotoEditingSettings,
  renderer?: PhotoLibraryNativeRenderer | null,
): boolean {
  return photoEditingNativeExportBlockers(settings, renderer).length > 0;
}

function blockerLabels(blockers: readonly PhotoEditingNativeExportBlocker[]): string {
  return blockers.map((blocker) => PHOTO_EDITING_EXPORT_FULL_SIZE_NATIVE_BLOCKER_LABELS[blocker]).join("、");
}

function onlyLuminance(blockers: readonly PhotoEditingNativeExportBlocker[]): boolean {
  return blockers.length === 0 || (blockers.length === 1 && blockers[0] === "colorGradingLuminance");
}

/**
 * 原寸のカードを押せない理由の 1 行（「原寸は〇〇に未対応です」）。理由が無い・中間調 / 全体の輝度だけのときは、従来の文
 * （中間調・全体の輝度）のまま。`place`（写真の置き場）があれば、描画を新しくする行き先（「NIHO photo を更新すると書き出せます」）を足す。
 */
export function photoEditingNativeExportUnsupportedText(
  blockers: readonly PhotoEditingNativeExportBlocker[],
  place?: PhotoLibraryPlace,
): string {
  const text = onlyLuminance(blockers)
    ? PHOTO_EDITING_EXPORT_FULL_SIZE_COLOR_GRADING_UNSUPPORTED_TEXT
    : `原寸は${blockerLabels(blockers)}に未対応です`;
  return place ? `${text}。${PHOTO_EDITING_EXPORT_FULL_SIZE_NATIVE_UPDATE_HINTS[place]}` : text;
}

/**
 * 実行時に原寸の書き出しを断るとき（1 枚、複数枚の中で飛ばす写真）の失敗の 1 行。理由が無い・輝度だけのときは従来の文のまま。
 * `place` があれば、描画を新しくする行き先の 1 文を続ける。
 */
export function photoEditingNativeExportUnsupportedFailedText(
  blockers: readonly PhotoEditingNativeExportBlocker[],
  place?: PhotoLibraryPlace,
): string {
  const text = onlyLuminance(blockers)
    ? PHOTO_EDITING_EXPORT_FULL_SIZE_COLOR_GRADING_UNSUPPORTED_FAILED_TEXT
    : `${blockerLabels(blockers)}を使っている写真は、原寸で書き出せません。`;
  return place ? `${text}${PHOTO_EDITING_EXPORT_FULL_SIZE_NATIVE_UPDATE_TEXTS[place]}` : text;
}

function readNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > NATIVE_RENDERER_MAX_ITEMS) return null;
  return value.every((item): item is string => typeof item === "string" && item.length > 0) ? [...value] : null;
}

/**
 * host（NIHO camera の `camera_develop_status.renderer` など）が渡した描画の能力を読む。形が違えば undefined（答えない古い描画と
 * 同じ扱い。fail closed）。
 */
export function readPhotoLibraryNativeRenderer(value: unknown): PhotoLibraryNativeRenderer | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const versions = record.settingsVersions;
  if (
    !Array.isArray(versions) ||
    versions.length === 0 ||
    versions.length > NATIVE_RENDERER_MAX_ITEMS ||
    !versions.every((version) => Number.isSafeInteger(version) && version > 0)
  ) {
    return undefined;
  }
  const engines = readNames(record.engines);
  const features = readNames(record.features);
  const maskKinds = readNames(record.maskKinds);
  const maxPixels = record.maxPixels;
  if (!engines || engines.length === 0 || !features || !maskKinds) return undefined;
  if (typeof maxPixels !== "number" || !Number.isSafeInteger(maxPixels) || maxPixels <= 0) return undefined;
  return Object.freeze({
    settingsVersions: Object.freeze([...(versions as number[])]),
    engines: Object.freeze(engines),
    features: Object.freeze(features),
    maskKinds: Object.freeze(maskKinds),
    maxPixels,
  });
}
