import { describe, expect, it } from "vitest";

import {
  autoDevelopSettings,
  neutralDevelopSettings,
  presetDevelopSettings,
  type DevelopSettings,
} from "./develop-settings";

const CROP = { rotate: 90, crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 } };

describe("presetDevelopSettings", () => {
  it("プリセットの色の補正を入れ、engine・look・base は当てる前のまま保つ", () => {
    const base: DevelopSettings = { ...neutralDevelopSettings("apple-ciraw8/e2/cal-1"), look: "niho-interim-1", exposure: 0.3 };
    const result: DevelopSettings = {
      ...neutralDevelopSettings(),
      engine: "niho-11",
      look: "niho-standard-1",
      base: null,
      exposure: 0.3,
      contrast: 12,
      vibrance: 20,
    };

    expect(presetDevelopSettings(base, result)).toEqual({
      ...result,
      v: 1,
      engine: base.engine,
      look: "niho-interim-1",
      base: "apple-ciraw8/e2/cal-1",
    });
  });

  it("切り抜き・回転は当てる前のまま保ち、形の版はその幾何から決める", () => {
    const base: DevelopSettings = { ...neutralDevelopSettings(), v: 2, geometry: CROP };
    const result: DevelopSettings = { ...neutralDevelopSettings(), v: 1, contrast: 12 };

    const next = presetDevelopSettings(base, result);
    expect(next.geometry).toEqual(CROP);
    expect(next.v).toBe(2);
    expect(next.contrast).toBe(12);
  });

  it("効果のキーを落とさない（モノクロのプリセットの結果の grayscale・grayMixer・vignette・grain がそのまま入る。E1b #17134）", () => {
    const base: DevelopSettings = { ...neutralDevelopSettings("raw-1"), v: 2, geometry: CROP, saturation: 30 };
    const result: DevelopSettings = {
      ...neutralDevelopSettings(),
      contrast: 18,
      saturation: 30,
      grayscale: true,
      grayMixer: { red: 20, orange: 0, yellow: 0, green: -10, aqua: 0, blue: -30, purple: 0, magenta: 0 },
      vignette: { amount: -25, midpoint: 50, roundness: 0, feather: 50, highlights: 0, style: "highlightPriority" },
      grain: { amount: 30, size: 25, roughness: 50 },
      colorNoiseReduction: 31,
      colorNoiseReductionDetail: 60,
      colorNoiseReductionSmoothness: 55,
    };

    const next = presetDevelopSettings(base, result);
    expect(next.grayscale).toBe(true);
    expect(next.grayMixer).toEqual(result.grayMixer);
    expect(next.vignette).toEqual(result.vignette);
    expect(next.grain).toEqual(result.grain);
    expect(next).toMatchObject({
      colorNoiseReduction: 31,
      colorNoiseReductionDetail: 60,
      colorNoiseReductionSmoothness: 55,
    });
    // 値は保持（白黒の間は描画に効かないだけ）
    expect(next.saturation).toBe(30);
    expect(next).toMatchObject({ v: 3, geometry: CROP, base: "raw-1", contrast: 18 });
  });

  it("当てる前に幾何・ルックが無ければ、プリセットの結果が持っていても入れない", () => {
    const base: DevelopSettings = { v: 1, engine: "niho-1", exposure: 0 };
    const result: DevelopSettings = { ...neutralDevelopSettings("other-base"), v: 2, geometry: CROP, contrast: 12 };

    const next = presetDevelopSettings(base, result);
    expect(Object.hasOwn(next, "geometry")).toBe(false);
    expect(Object.hasOwn(next, "look")).toBe(false);
    expect(next.v).toBe(1);
    expect(next.base).toBeNull();
    expect(next.contrast).toBe(12);
  });

  it("XMPプリセットの結果が点を持たなくても NIHO の色ポイントを保持する", () => {
    const colorPoints = [{
      id: "skin",
      target: { lightness: 0.72, chroma: 0.08, hue: 50 },
      range: { hue: 30, chroma: 0.08, lightness: 0.15 },
      delta: { hue: 10, chromaScale: 1.1, lightness: 0 },
    }];
    const base: DevelopSettings = { ...neutralDevelopSettings(), v: 4, colorPoints };
    const next = presetDevelopSettings(base, { ...neutralDevelopSettings(), contrast: 12 });
    expect(next).toMatchObject({ v: 4, contrast: 12, colorPoints });
  });

  it("旧式の写真に非 0 の増分 WB を当てた Rust 結果は niho-2 を保つ。通常のプリセットは旧式のまま", () => {
    const base: DevelopSettings = { ...neutralDevelopSettings(), engine: "niho-1" };
    const upgraded: DevelopSettings = {
      ...base,
      engine: "niho-2",
      relativeTemperature: 20,
      relativeTint: -10,
      whiteBalance: { mode: "relative" },
    };
    expect(presetDevelopSettings(base, upgraded)).toMatchObject({
      engine: "niho-2",
      relativeTemperature: 20,
      relativeTint: -10,
      whiteBalance: { mode: "relative" },
    });
    expect(presetDevelopSettings(base, { ...base, contrast: 12 }).engine).toBe("niho-1");
  });

  it("niho-10・niho-12・niho-13・niho-14・signed の写真は Rust と同じく niho-2 へ昇格させず、写真の数式のまま", () => {
    const relative = { relativeTemperature: 20, relativeTint: -10, whiteBalance: { mode: "relative" } };
    const raster: DevelopSettings = neutralDevelopSettings();
    expect(raster.engine).toBe("niho-14");
    expect(presetDevelopSettings(raster, { ...raster, ...relative, engine: "niho-2" })).toMatchObject({ engine: "niho-14", ...relative });
    expect(presetDevelopSettings(raster, { ...raster, contrast: 12 }).engine).toBe("niho-14");
    const raster13: DevelopSettings = { ...raster, engine: "niho-13" };
    expect(presetDevelopSettings(raster13, { ...raster13, ...relative, engine: "niho-2" })).toMatchObject({ engine: "niho-13", ...relative });
    const raster12: DevelopSettings = { ...raster, engine: "niho-12" };
    expect(presetDevelopSettings(raster12, { ...raster12, ...relative, engine: "niho-2" })).toMatchObject({ engine: "niho-12", ...relative });
    const raster10: DevelopSettings = { ...raster, engine: "niho-10" };
    expect(presetDevelopSettings(raster10, { ...raster10, ...relative, engine: "niho-2" })).toMatchObject({ engine: "niho-10", ...relative });
    expect(presetDevelopSettings(raster10, { ...raster10, contrast: 12 }).engine).toBe("niho-10");
    const signed: DevelopSettings = { ...neutralDevelopSettings("raw-apple.d8.p3.e4.cal-signed"), engine: "niho-3", look: "niho-standard-2" };
    expect(presetDevelopSettings(signed, { ...signed, ...relative, engine: "niho-2" }).engine).toBe("niho-3");
    const signed7: DevelopSettings = { ...signed, engine: "niho-7", look: "niho-standard-5" };
    expect(presetDevelopSettings(signed7, { ...signed7, ...relative, engine: "niho-2" })).toMatchObject({
      engine: "niho-7",
      look: "niho-standard-5",
      ...relative,
    });
    const signed9: DevelopSettings = { ...signed7, engine: "niho-11" };
    expect(presetDevelopSettings(signed9, { ...signed9, ...relative, engine: "niho-2" }).engine).toBe("niho-11");
    // unsigned RAW の作業コピーの新規（niho-14）・保存済みの niho-2 はそのまま
    const raw: DevelopSettings = neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none");
    expect(raw.engine).toBe("niho-14");
    expect(presetDevelopSettings(raw, { ...raw, ...relative }).engine).toBe("niho-14");
    expect(presetDevelopSettings(raw, { ...raw, ...relative, engine: "niho-2" }).engine).toBe("niho-14");
    const raw2: DevelopSettings = { ...raw, engine: "niho-2" };
    expect(presetDevelopSettings(raw2, { ...raw2, ...relative }).engine).toBe("niho-2");
  });
});

describe("autoDevelopSettings", () => {
  const MONO: Partial<DevelopSettings> = {
    grayscale: true,
    grayMixer: { red: 20, orange: 0, yellow: 0, green: -10, aqua: 0, blue: -30, purple: 0, magenta: 0 },
    vignette: { amount: -25 },
    grain: { amount: 30, size: 25 },
  };

  it("「自動」のライトと自然な彩度を入れ、engine・look・base・幾何・効果は押す前のまま保つ（F4b #17139）", () => {
    const before: DevelopSettings = {
      ...neutralDevelopSettings("raw-1"),
      v: 3,
      look: "niho-interim-1",
      geometry: CROP,
      contrast: 12,
      ...MONO,
    };
    const result: DevelopSettings = {
      ...neutralDevelopSettings(),
      engine: "niho-11",
      look: "niho-standard-1",
      v: 1,
      contrast: 20,
      exposure: 0.35,
      shadows: 30,
      vibrance: 12,
      grain: { amount: 0 },
    };

    const next = autoDevelopSettings(before, result);
    expect(next).toMatchObject({
      v: 3,
      engine: before.engine,
      look: "niho-interim-1",
      base: "raw-1",
      geometry: CROP,
      contrast: 20,
      exposure: 0.35,
      shadows: 30,
      vibrance: 12,
      ...MONO,
    });
  });

  it("押す前に無かった効果・幾何は、結果が持っていても入れない", () => {
    const before: DevelopSettings = { ...neutralDevelopSettings(), exposure: 0.1 };
    const result: DevelopSettings = { ...before, v: 2, geometry: CROP, exposure: 0.4, ...MONO };

    const next = autoDevelopSettings(before, result);
    for (const key of ["geometry", "grayscale", "grayMixer", "vignette", "grain"]) expect(Object.hasOwn(next, key)).toBe(false);
    expect(next).toMatchObject({ v: 1, exposure: 0.4 });
  });
});
