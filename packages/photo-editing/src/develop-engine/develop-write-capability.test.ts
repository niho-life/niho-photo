import { describe, expect, it } from "vitest";

import {
  isEditableDevelopSettings,
  neutralDevelopSettings,
  readDevelopSettings,
  supportsDevelopSettingsWrite,
  type DevelopSettings,
} from "./develop-settings";

const FULL_SETTINGS: DevelopSettings = {
  v: 9,
  engine: "niho-14",
  look: "niho-standard-1",
  base: "raster.ci2.p2.e2.icc-srgb",
  exposure: 0.5,
  contrast: 10,
  highlights: -5,
  shadows: 8,
  whites: 2,
  blacks: -2,
  texture: 4,
  clarity: 3,
  dehaze: 2,
  vibrance: 5,
  saturation: 6,
  colorNoiseReduction: 10,
  colorNoiseReductionDetail: 50,
  colorNoiseReductionSmoothness: 50,
  relativeTemperature: 3,
  relativeTint: -2,
  whiteBalance: { mode: "relative", temperature: 5_500, tint: 4 },
  toneCurves: [{ channel: "rgb", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
  hsl: ["orange", { hue: 2, saturation: 3, luminance: 4 }],
  colorPoints: [
    {
      id: "point-1",
      target: { lightness: 0.5, chroma: 0.2, hue: 40 },
      range: { hue: 20, chroma: 0.1, lightness: 0.2 },
      delta: { hue: 3, chromaScale: 1.1, lightness: 0.05 },
    },
  ],
  masks: [
    {
      id: "mask-1",
      kind: "linear",
      zero: { x: 0.2, y: 0.2 },
      full: { x: 0.8, y: 0.8 },
      adjust: { exposure: 0.2 },
    },
  ],
  calibration: {
    shadowTint: 1,
    redHue: 2,
    redSaturation: 3,
    greenHue: 4,
    greenSaturation: 5,
    blueHue: 6,
    blueSaturation: 7,
  },
  colorGrading: {
    shadow: { hue: 220, saturation: 10, luminance: -2 },
    midtone: { hue: 40, saturation: 5, luminance: 1 },
    highlight: { hue: 60, saturation: 8, luminance: 2 },
    global: { hue: 0, saturation: 0, luminance: 0 },
    blending: 60,
    balance: 5,
  },
  parametricShadows: 1,
  parametricDarks: 2,
  parametricLights: 3,
  parametricHighlights: 4,
  parametricShadowSplit: 25,
  parametricMidtoneSplit: 50,
  parametricHighlightSplit: 75,
  curveRefineSaturation: 100,
  grayscale: true,
  grayMixer: { red: 1, orange: 2, yellow: 3, green: 4, aqua: 5, blue: 6, purple: 7, magenta: 8 },
  vignette: { amount: -20, midpoint: 50, roundness: 0, feather: 50, highlights: 0, style: "highlightPriority" },
  grain: { amount: 10, size: 25, roughness: 50, seed: 7 },
  detail: {
    sharpening: { amount: 20, radius: 1, detail: 25, masking: 0 },
    luminanceNoiseReduction: 10,
    colorNoiseReduction: 15,
  },
  legacySettings: {},
  geometry: {
    rotate: 90,
    flipH: false,
    flipV: false,
    angle: -2,
    crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
    aspect: "original",
    perspective: { vertical: 2, horizontal: 0, rotate: 0, aspect: 0, scale: 100, x: 0, y: 0 },
    constrain: true,
    upright: 0,
  },
  heal: [{ id: "heal-1", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.5, 0.5]] }],
  lens: { distortion: 5 },
};

function withNestedChange(key: string, value: unknown): DevelopSettings {
  return { ...FULL_SETTINGS, [key]: value } as DevelopSettings;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
}

describe("supportsDevelopSettingsWrite", () => {
  it("neutral の raster / RAW と既知の全設定を持つ fixture は書ける", () => {
    expect(supportsDevelopSettingsWrite(neutralDevelopSettings())).toBe(true);
    expect(supportsDevelopSettingsWrite(neutralDevelopSettings("raster.ci2.p2.e2.icc-srgb"))).toBe(true);
    expect(supportsDevelopSettingsWrite(neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none", { raw: true }))).toBe(true);
    expect(supportsDevelopSettingsWrite(FULL_SETTINGS)).toBe(true);
    expect(supportsDevelopSettingsWrite(withNestedChange("geometry", null))).toBe(true);
    expect(supportsDevelopSettingsWrite(withNestedChange("hsl", { red: { hue: 1 }, blue: { saturation: 2 } }))).toBe(true);
  });

  it("null / undefined / 配列、未来の版・engine、非対応の active geometry を拒む", () => {
    expect(supportsDevelopSettingsWrite(null)).toBe(false);
    expect(supportsDevelopSettingsWrite(undefined)).toBe(false);
    expect(supportsDevelopSettingsWrite([])).toBe(false);
    expect(supportsDevelopSettingsWrite({ ...FULL_SETTINGS, v: 10 })).toBe(false);
    expect(supportsDevelopSettingsWrite({ ...FULL_SETTINGS, engine: "niho-99" })).toBe(false);
    expect(supportsDevelopSettingsWrite({ ...FULL_SETTINGS, look: "niho-standard-future" })).toBe(false);
    expect(supportsDevelopSettingsWrite(FULL_SETTINGS, { geometry: false })).toBe(false);
    expect(supportsDevelopSettingsWrite(neutralDevelopSettings(), { geometry: false })).toBe(true);
  });

  it("未知の root / nested field と未知の variant を各閉集合で拒む", () => {
    const unknowns: DevelopSettings[] = [
      { ...FULL_SETTINGS, futureDrawingFeature: { amount: 0 } },
      withNestedChange("whiteBalance", { mode: "asShot", future: 0 }),
      withNestedChange("whiteBalance", { mode: "future" }),
      withNestedChange("toneCurves", [{ channel: "rgb", points: [], future: 0 }]),
      withNestedChange("toneCurves", [{ channel: "future", points: [] }]),
      withNestedChange("toneCurves", [{ channel: "rgb", points: [{ x: 0, y: 0, future: 0 }] }]),
      withNestedChange("hsl", { future: { hue: 0 } }),
      withNestedChange("hsl", { red: { hue: 0, future: 0 } }),
      withNestedChange("hsl", ["red", { hue: 0, future: 0 }]),
      withNestedChange("calibration", { future: 0 }),
      withNestedChange("colorGrading", { future: 0 }),
      withNestedChange("colorGrading", { shadow: { hue: 0, future: 0 } }),
      withNestedChange("grayMixer", { future: 0 }),
      withNestedChange("vignette", { amount: 0, future: 0 }),
      withNestedChange("vignette", { style: "future" }),
      withNestedChange("grain", { amount: 0, future: 0 }),
      withNestedChange("geometry", { rotate: 0, future: 0 }),
      withNestedChange("geometry", { extra: { future: 0 } }),
      withNestedChange("geometry", { crop: { left: 0, future: 0 } }),
      withNestedChange("geometry", { perspective: { vertical: 0, future: 0 } }),
      withNestedChange("colorPoints", [{ ...((FULL_SETTINGS.colorPoints as object[])[0] ?? {}), future: 0 }]),
      withNestedChange("colorPoints", [
        {
          ...((FULL_SETTINGS.colorPoints as object[])[0] ?? {}),
          target: { lightness: 0.5, chroma: 0.2, hue: 40, future: 0 },
        },
      ]),
      withNestedChange("masks", [{ ...(FULL_SETTINGS.masks as object[])[0], future: 0 }]),
      withNestedChange("masks", [
        { ...(FULL_SETTINGS.masks as object[])[0], adjust: { exposure: 0.2, future: 0 } },
      ]),
      withNestedChange("detail", { ...(FULL_SETTINGS.detail as object), future: 0 }),
      withNestedChange("detail", {
        ...(FULL_SETTINGS.detail as object),
        sharpening: { amount: 20, radius: 1, detail: 25, masking: 0, future: 0 },
      }),
      withNestedChange("heal", [{ ...(FULL_SETTINGS.heal as object[])[0], future: 0 }]),
      withNestedChange("lens", { distortion: 0, future: 0 }),
      withNestedChange("lens", { defringe: { future: {} } }),
      withNestedChange("lens", { defringe: { purple: { amount: 0, hueLo: 30, hueHi: 70, future: 0 } } }),
    ];
    for (const settings of unknowns) expect(supportsDevelopSettingsWrite(settings)).toBe(false);
  });

  it("既知の切り抜き比率だけを書き込み、未知variantはreaderで保持する", () => {
    for (const aspect of ["free", "original", "originalSwapped", "4:5", "16:9", "9999:1"]) {
      expect(supportsDevelopSettingsWrite(withNestedChange("geometry", { aspect })), aspect).toBe(true);
    }
    for (const aspect of ["futureAspect", "", "square", "0:1", "04:5", "10000:1"]) {
      const source = withNestedChange("geometry", { aspect });
      deepFreeze(source);
      expect(readDevelopSettings(source)).toEqual(source);
      expect(isEditableDevelopSettings(source)).toBe(true);
      expect(supportsDevelopSettingsWrite(source), aspect).toBe(false);
      expect(source.geometry).toEqual({ aspect });
    }
  });

  it("legacySettings は absent または空 object だけを許す", () => {
    const { legacySettings: _legacySettings, ...absent } = FULL_SETTINGS;
    expect(supportsDevelopSettingsWrite(absent)).toBe(true);
    expect(supportsDevelopSettingsWrite(FULL_SETTINGS)).toBe(true);
    expect(supportsDevelopSettingsWrite({ ...FULL_SETTINGS, legacySettings: { exposure: 0 } })).toBe(false);
    expect(supportsDevelopSettingsWrite({ ...FULL_SETTINGS, legacySettings: null })).toBe(false);
  });

  it("field capability だけを判定し、数値・範囲 validation を代用しない", () => {
    expect(supportsDevelopSettingsWrite({ ...neutralDevelopSettings(), exposure: "not-a-number" })).toBe(true);
    expect(supportsDevelopSettingsWrite({ ...neutralDevelopSettings(), exposure: 1_000_000 })).toBe(true);
  });

  it("構造化 group の壊れた型を保守的に拒む", () => {
    for (const [key, value] of [
      ["whiteBalance", []],
      ["toneCurves", {}],
      ["toneCurves", [{ channel: "rgb" }]],
      ["toneCurves", [{ channel: "rgb", points: [0] }]],
      ["hsl", ["red"]],
      ["hsl", ["red", 0]],
      ["calibration", []],
      ["colorGrading", { shadow: [] }],
      ["grayMixer", []],
      ["vignette", []],
      ["grain", []],
      ["geometry", []],
      ["geometry", { crop: [] }],
      ["geometry", { perspective: [] }],
    ] as const) {
      expect(supportsDevelopSettingsWrite(withNestedChange(key, value))).toBe(false);
    }
  });

  it("frozen input を変更せず、reader の未知 field 保持と従来の editability を変えない", () => {
    const source = { ...neutralDevelopSettings(), futureDrawingFeature: { amount: 1 } };
    const expected = { ...neutralDevelopSettings(), futureDrawingFeature: { amount: 1 } };
    deepFreeze(source);

    expect(readDevelopSettings(source)).toEqual(expected);
    expect(isEditableDevelopSettings(source)).toBe(true);
    expect(supportsDevelopSettingsWrite(source)).toBe(false);
    expect(source).toEqual(expected);
  });
});
