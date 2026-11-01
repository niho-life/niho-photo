import { isDevelopAspect } from "./develop-aspect";

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "v",
  "engine",
  "look",
  "base",
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
  "colorNoiseReduction",
  "colorNoiseReductionDetail",
  "colorNoiseReductionSmoothness",
  "whiteBalance",
  "relativeTemperature",
  "relativeTint",
  "toneCurves",
  "hsl",
  "colorPoints",
  "masks",
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
  "grayscale",
  "grayMixer",
  "vignette",
  "grain",
  "detail",
  "legacySettings",
  "geometry",
  "heal",
  "lens",
]);

const HSL_BANDS: ReadonlySet<string> = new Set([
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "magenta",
]);
const HSL_ADJUSTMENT_KEYS: ReadonlySet<string> = new Set(["hue", "saturation", "luminance"]);
const COLOR_GRADE_BANDS: ReadonlySet<string> = new Set(["shadow", "midtone", "highlight", "global"]);
const WHITE_BALANCE_KEYS: ReadonlySet<string> = new Set(["mode", "temperature", "tint"]);
const TONE_CURVE_KEYS: ReadonlySet<string> = new Set(["channel", "points"]);
const TONE_CURVE_POINT_KEYS: ReadonlySet<string> = new Set(["x", "y"]);
const TONE_CURVE_CHANNELS: ReadonlySet<string> = new Set(["rgb", "red", "green", "blue"]);
const COLOR_GRADING_KEYS: ReadonlySet<string> = new Set([...COLOR_GRADE_BANDS, "blending", "balance"]);
const CALIBRATION_KEYS: ReadonlySet<string> = new Set([
  "shadowTint",
  "redHue",
  "redSaturation",
  "greenHue",
  "greenSaturation",
  "blueHue",
  "blueSaturation",
]);
const VIGNETTE_KEYS: ReadonlySet<string> = new Set(["amount", "midpoint", "roundness", "feather", "highlights", "style"]);
const GRAIN_KEYS: ReadonlySet<string> = new Set(["amount", "size", "roughness", "seed"]);
const GEOMETRY_KEYS: ReadonlySet<string> = new Set([
  "rotate",
  "flipH",
  "flipV",
  "angle",
  "crop",
  "aspect",
  "perspective",
  "constrain",
  "upright",
]);
const CROP_KEYS: ReadonlySet<string> = new Set(["left", "top", "right", "bottom"]);
const PERSPECTIVE_KEYS: ReadonlySet<string> = new Set([
  "vertical",
  "horizontal",
  "rotate",
  "aspect",
  "scale",
  "x",
  "y",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function hasKnownWhiteBalanceFields(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, WHITE_BALANCE_KEYS)) return false;
  return !hasOwn(value, "mode") || value.mode === "asShot" || value.mode === "absolute" || value.mode === "relative";
}

function hasKnownToneCurveFields(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((curve) => {
    if (
      !isRecord(curve) ||
      !hasOnlyKeys(curve, TONE_CURVE_KEYS) ||
      !hasOwn(curve, "channel") ||
      typeof curve.channel !== "string" ||
      !TONE_CURVE_CHANNELS.has(curve.channel) ||
      !hasOwn(curve, "points") ||
      !Array.isArray(curve.points)
    ) {
      return false;
    }
    return curve.points.every(
      (point) =>
        isRecord(point) &&
        hasOnlyKeys(point, TONE_CURVE_POINT_KEYS) &&
        hasOwn(point, "x") &&
        hasOwn(point, "y"),
    );
  });
}

function hasKnownHslAdjustmentFields(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, HSL_ADJUSTMENT_KEYS);
}

function hasKnownHslFields(value: unknown): boolean {
  if (Array.isArray(value)) {
    if (value.length % 2 !== 0) return false;
    for (let index = 0; index < value.length; index += 2) {
      const band = value[index];
      if (typeof band !== "string" || !HSL_BANDS.has(band) || !hasKnownHslAdjustmentFields(value[index + 1])) {
        return false;
      }
    }
    return true;
  }
  return (
    isRecord(value) &&
    Object.entries(value).every(([band, adjustment]) => HSL_BANDS.has(band) && hasKnownHslAdjustmentFields(adjustment))
  );
}

function hasKnownColorGradingFields(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, COLOR_GRADING_KEYS)) return false;
  for (const band of COLOR_GRADE_BANDS) {
    if (!hasOwn(value, band)) continue;
    const grade = value[band];
    if (!isRecord(grade) || !hasOnlyKeys(grade, HSL_ADJUSTMENT_KEYS)) return false;
  }
  return true;
}

function hasKnownVignetteFields(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, VIGNETTE_KEYS)) return false;
  return (
    !hasOwn(value, "style") ||
    value.style === "highlightPriority" ||
    value.style === "colorPriority" ||
    value.style === "paintOverlay"
  );
}

function hasKnownGeometryFields(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, GEOMETRY_KEYS)) return false;
  if (hasOwn(value, "aspect") && (typeof value.aspect !== "string" || !isDevelopAspect(value.aspect))) return false;
  if (hasOwn(value, "crop") && (!isRecord(value.crop) || !hasOnlyKeys(value.crop, CROP_KEYS))) {
    return false;
  }
  return (
    !hasOwn(value, "perspective") ||
    (isRecord(value.perspective) && hasOnlyKeys(value.perspective, PERSPECTIVE_KEYS))
  );
}

/**
 * `isEditableDevelopSettings` の既存の編集可否確認を通った設定に、SDK が知る書き込み可能な field / feature だけがあるか。
 * 数値・範囲や working-copy などの値の妥当性は判定しない。
 */
export function hasKnownDevelopSettingsWriteFields(value: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(value, TOP_LEVEL_KEYS)) return false;
  // colorPoints / masks / detail / heal / lens の深い閉包と値は、先に呼ぶ isEditableDevelopSettings の既存 validator が確認する。
  if (hasOwn(value, "legacySettings") && (!isRecord(value.legacySettings) || Object.keys(value.legacySettings).length !== 0)) {
    return false;
  }
  if (hasOwn(value, "whiteBalance") && !hasKnownWhiteBalanceFields(value.whiteBalance)) return false;
  if (hasOwn(value, "toneCurves") && !hasKnownToneCurveFields(value.toneCurves)) return false;
  if (hasOwn(value, "hsl") && !hasKnownHslFields(value.hsl)) return false;
  if (
    hasOwn(value, "calibration") &&
    (!isRecord(value.calibration) || !hasOnlyKeys(value.calibration, CALIBRATION_KEYS))
  ) {
    return false;
  }
  if (hasOwn(value, "colorGrading") && !hasKnownColorGradingFields(value.colorGrading)) return false;
  if (hasOwn(value, "grayMixer") && (!isRecord(value.grayMixer) || !hasOnlyKeys(value.grayMixer, HSL_BANDS))) return false;
  if (hasOwn(value, "vignette") && !hasKnownVignetteFields(value.vignette)) return false;
  if (
    hasOwn(value, "grain") &&
    (!isRecord(value.grain) || !hasOnlyKeys(value.grain, GRAIN_KEYS))
  ) {
    return false;
  }
  return !hasOwn(value, "geometry") || hasKnownGeometryFields(value.geometry);
}
