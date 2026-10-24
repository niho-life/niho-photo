import { describe, expect, it } from "vitest";

import { NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS } from "../browser-photo-adjustments";
import {
  applyBrowserAdjustmentsToDevelopSettings,
  copyDevelopSettings,
  developSettingsOnWorkingCopy,
  developSettingsToEditSettings,
  developSettingsVersion,
  DEVELOP_SETTINGS_ENGINE,
  DevelopSettingsBaseMismatchError,
  NIHO10_DEVELOP_SETTINGS_ENGINE,
  NIHO12_DEVELOP_SETTINGS_ENGINE,
  NIHO13_DEVELOP_SETTINGS_ENGINE,
  NIHO2_DEVELOP_SETTINGS_ENGINE,
  hasDevelopGeometry,
  hasNullDevelopGeometryField,
  hasSavedDevelopSettings,
  isEditableDevelopSettings,
  isNeutralDevelopColors,
  isNeutralDevelopSettings,
  neutralDevelopSettings,
  newDevelopSettingsEngine,
  pasteDevelopSettings,
  readBrowserAdjustmentsFromDevelopSettings,
  readDevelopDetail,
  readDevelopSettings,
  resetDevelopSettingsColors,
  sameDevelopSettings,
  signedWorkingCopyState,
  presetDevelopSettings,
  autoDevelopSettings,
  type DevelopSettings,
} from "./develop-settings";

/** 切り抜き・角度・90° 回転のある幾何（F3 移行元設計）。 */
const CROP = { rotate: 90, flipH: false, flipV: false, angle: -2.5, crop: { left: 0.1, top: 0, right: 0.9, bottom: 1 } };

describe("neutralDevelopSettings", () => {
  it("JPEG / PNG を直接描く新規設定は v1・niho-14・NIHO 標準ルックを使う（#89）", () => {
    expect(DEVELOP_SETTINGS_ENGINE).toBe("niho-14");
    expect(NIHO13_DEVELOP_SETTINGS_ENGINE).toBe("niho-13");
    expect(NIHO12_DEVELOP_SETTINGS_ENGINE).toBe("niho-12");
    expect(NIHO10_DEVELOP_SETTINGS_ENGINE).toBe("niho-10");
    expect(NIHO2_DEVELOP_SETTINGS_ENGINE).toBe("niho-2");
    expect(neutralDevelopSettings()).toEqual({
      v: 1,
      engine: "niho-14",
      look: "niho-standard-1",
      base: null,
      exposure: 0,
      contrast: 0,
      saturation: 0,
      relativeTemperature: 0,
      relativeTint: 0,
      whiteBalance: { mode: "asShot" },
    });
    expect(isNeutralDevelopSettings(neutralDevelopSettings())).toBe(true);
  });

  it("作業コピーから描く写真（#16944）は base に作業コピーの版を持つ（neutral のまま）", () => {
    expect(neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none")).toMatchObject({ base: "raw-apple.d8.p1.e1.cal-none", exposure: 0 });
    expect(isNeutralDevelopSettings(neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none"))).toBe(true);
  });

  it("新規の数式は base で決める: 直接描く・raster・unsigned RAW の作業コピーは niho-14、signed・版の分からない作業コピー・RAW の写真は niho-2", () => {
    expect(neutralDevelopSettings(null).engine).toBe("niho-14");
    expect(neutralDevelopSettings("raster.ci2.p2.e2.icc-srgb")).toMatchObject({ engine: "niho-14", base: "raster.ci2.p2.e2.icc-srgb" });
    expect(neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none")).toMatchObject({ engine: "niho-14", base: "raw-apple.d8.p1.e1.cal-none" });
    // signed の作業コピーは signedNeutralDevelopSettings が選ぶ。base だけでは niho-14 を約束しない
    expect(neutralDevelopSettings("raw-apple.d8.p3.e4.cal-signed").engine).toBe("niho-2");
    expect(neutralDevelopSettings("raw-apple.d8.p2.e9.cal-future").engine).toBe("niho-2");
    expect(neutralDevelopSettings("fixture-base").engine).toBe("niho-2");
    // base: null でも RAW の写真（作業コピーの無い RAW など）は呼び出し側が明示する
    expect(neutralDevelopSettings(null, { raw: true })).toEqual({ ...neutralDevelopSettings(null), engine: "niho-2" });
    expect(neutralDevelopSettings("raster.ci2.p2.e2.icc-srgb", { raw: true }).engine).toBe("niho-2");
    expect(newDevelopSettingsEngine(null)).toBe("niho-14");
    expect(newDevelopSettingsEngine("raster.x")).toBe("niho-14");
    expect(newDevelopSettingsEngine("raw-apple.d8.p0.e1.cal-none")).toBe("niho-14");
    expect(newDevelopSettingsEngine("raw-apple.d8.p2.e1")).toBe("niho-14");
    expect(newDevelopSettingsEngine("raw-apple.d8.p3.e4.cal-signed")).toBe("niho-2");
    expect(newDevelopSettingsEngine(null, { raw: true })).toBe("niho-2");
    // niho-14 と niho-2 の neutral は数式の版だけが違う（raster は cube も相対 WB も H/S の解析も通らず同じ画になる）
    const { engine: _fourteen, ...fourteen } = neutralDevelopSettings(null);
    const { engine: _two, ...two } = neutralDevelopSettings(null, { raw: true });
    expect(fourteen).toEqual(two);
  });
});

describe("developSettings detail v6", () => {
  const neutralDetail = {
    sharpening: { amount: 0, radius: 1, detail: 25, masking: 0 },
    luminanceNoiseReduction: 0,
  };

  it("存在だけでv6を要求し、zeroとcolor NRの明示zeroを厳格にroundtripする", () => {
    expect(readDevelopDetail(neutralDetail)).toEqual(neutralDetail);
    const settings = { ...neutralDevelopSettings(), v: 6 as const, detail: neutralDetail };
    expect(readDevelopSettings(settings)).toEqual(settings);
    expect(isEditableDevelopSettings(settings)).toBe(true);
    expect(developSettingsVersion(settings)).toBe(6);
    expect(isNeutralDevelopColors(settings)).toBe(true);
    expect(isNeutralDevelopColors({ ...settings, detail: { ...neutralDetail, colorNoiseReduction: 0 } })).toBe(true);
    expect(copyDevelopSettings(settings)).toHaveProperty("detail", neutralDetail);
    expect(readDevelopSettings({ ...settings, v: 4 })).toBeNull();
  });

  it("空・partial・未知キー・非有限・範囲外を拒否する", () => {
    for (const detail of [
      {},
      { sharpening: neutralDetail.sharpening },
      { ...neutralDetail, future: 1 },
      { ...neutralDetail, sharpening: { ...neutralDetail.sharpening, future: 1 } },
      { ...neutralDetail, luminanceNoiseReduction: Number.NaN },
      { ...neutralDetail, colorNoiseReduction: 101 },
      { ...neutralDetail, sharpening: { ...neutralDetail.sharpening, radius: 0.49 } },
    ]) {
      expect(readDevelopDetail(detail)).toBeNull();
      expect(readDevelopSettings({ ...neutralDevelopSettings(), v: 6, detail })).toBeNull();
    }
  });

  it("active detailはneutralでなく、初期化で外し、貼り付けではcloneする", () => {
    const active: DevelopSettings = {
      ...neutralDevelopSettings(),
      v: 6,
      detail: { ...neutralDetail, sharpening: { ...neutralDetail.sharpening, amount: 40 } },
    };
    expect(isNeutralDevelopColors(active)).toBe(false);
    expect(resetDevelopSettingsColors(active, null)).not.toHaveProperty("detail");
    const pasted = pasteDevelopSettings(neutralDevelopSettings(), copyDevelopSettings(active));
    expect(pasted.v).toBe(6);
    expect(pasted.detail).toEqual(active.detail);
    expect(pasted.detail).not.toBe(active.detail);
  });
});

describe("developSettingsOnWorkingCopy（#16944）", () => {
  it("保存済みbaseと違う作業コピーは開かず、同じbaseならルックと補正を保つ", () => {
    expect(() =>
      developSettingsOnWorkingCopy(
        { ...neutralDevelopSettings("raw-apple.d8.p0.e1.cal-none"), look: "niho-interim-1", exposure: 0.4, hsl: { red: 1 } },
        "raw-apple.d8.p1.e1.cal-none",
      ),
    ).toThrow(DevelopSettingsBaseMismatchError);
    expect(
      developSettingsOnWorkingCopy(
        { ...neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none"), look: "niho-interim-1", exposure: 0.4, hsl: { red: 1 } },
        "raw-apple.d8.p1.e1.cal-none",
      ),
    ).toEqual({
      ...neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none"),
      look: "niho-interim-1",
      exposure: 0.4,
      hsl: { red: 1 },
    });
    expect(developSettingsOnWorkingCopy(null, "raster.ci1.p1.e1.icc-srgb")).toEqual(neutralDevelopSettings("raster.ci1.p1.e1.icc-srgb"));
    expect(developSettingsOnWorkingCopy(null, "raw-apple.d8.p1.e1.cal-none").look).toBe("niho-standard-1");
  });

  it("未保存なら raster・unsigned RAW の作業コピーは niho-14、版の分からない作業コピーは niho-2 で初期化する", () => {
    expect(developSettingsOnWorkingCopy(null, "raster.ci1.p1.e1.icc-srgb")).toMatchObject({
      engine: "niho-14",
      look: "niho-standard-1",
      base: "raster.ci1.p1.e1.icc-srgb",
    });
    expect(developSettingsOnWorkingCopy(null, "raster.ci2.p2.e2.icc-srgb", { kind: "raster", encoding: "jpeg8" }).engine).toBe(
      "niho-14",
    );
    expect(developSettingsOnWorkingCopy(null, "raw-apple.d8.p1.e1.cal-none", { kind: "raw" })).toMatchObject({
      engine: "niho-14",
      look: "niho-standard-1",
      base: "raw-apple.d8.p1.e1.cal-none",
    });
    expect(developSettingsOnWorkingCopy(null, "fixture-base").engine).toBe("niho-2");
  });

  it("保存済みの niho-14 / niho-13 / niho-12 は raster・unsigned RAW・版の分からない作業コピーで開き、signed RAW と描けないルックは engine_mismatch（#89・#27・#29）", () => {
    const mismatch = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof DevelopSettingsBaseMismatchError ? error.reason : error;
      }
      return null;
    };
    const raster = "raster.ci2.p2.e2.icc-srgb";
    const legacyRaw = "raw-apple.d8.p1.e1.cal-none";
    const fresh: DevelopSettings = { ...neutralDevelopSettings(null), exposure: 0.4, saturation: -30, relativeTemperature: 12 };
    expect(fresh.engine).toBe("niho-14");
    for (const engine of ["niho-14", "niho-13", "niho-12"]) {
      const saved: DevelopSettings = { ...fresh, engine };
      expect(developSettingsOnWorkingCopy(saved, raster)).toEqual({ ...saved, base: raster });
      expect(developSettingsOnWorkingCopy(saved, legacyRaw, { kind: "raw" })).toEqual({ ...saved, base: legacyRaw });
      expect(developSettingsOnWorkingCopy({ ...saved, look: "niho-interim-1" }, legacyRaw).look).toBe("niho-interim-1");
      expect(developSettingsOnWorkingCopy(saved, "fixture-base").engine).toBe(engine);
      const signedBase = "raw-apple.d8.p3.e4.cal-signed";
      const signedMeta = { kind: "raw", encoding: { kind: "signed-gamma18-v1", ceiling: 2 } };
      expect(mismatch(() => developSettingsOnWorkingCopy(saved, signedBase, signedMeta))).toBe("engine_mismatch");
      expect(mismatch(() => developSettingsOnWorkingCopy({ ...saved, look: "niho-standard-2" }, raster))).toBe("engine_mismatch");
      expect(mismatch(() => developSettingsOnWorkingCopy({ ...saved, look: "niho-standard-5" }, legacyRaw))).toBe("engine_mismatch");
    }
    // 保存済みの旧数式（niho-12・niho-13 を含む）は niho-14 へ昇格しない
    expect(developSettingsOnWorkingCopy({ ...fresh, engine: "niho-13" }, raster).engine).toBe("niho-13");
    expect(developSettingsOnWorkingCopy({ ...fresh, engine: "niho-12" }, raster).engine).toBe("niho-12");
    expect(developSettingsOnWorkingCopy({ ...fresh, engine: "niho-10" }, raster).engine).toBe("niho-10");
    expect(developSettingsOnWorkingCopy({ ...fresh, engine: "niho-2" }, legacyRaw).engine).toBe("niho-2");
  });

  it("保存済みの niho-6 は raster の作業コピーの上でだけ開き、RAW・signed・版の分からない作業コピーと描けないルックは engine_mismatch（#18397）", () => {
    const raster = "raster.ci2.p2.e2.icc-srgb";
    const direct: DevelopSettings = { ...neutralDevelopSettings(null), engine: "niho-10", exposure: 0.4 };
    expect(developSettingsOnWorkingCopy(direct, raster)).toEqual({ ...direct, base: raster });
    expect(developSettingsOnWorkingCopy({ ...direct, look: "niho-interim-1" }, raster).look).toBe("niho-interim-1");
    const { look: _look, ...noLook } = direct;
    expect(developSettingsOnWorkingCopy(noLook, raster)).toMatchObject({ engine: "niho-10", look: "niho-interim-1" });
    expect(developSettingsOnWorkingCopy({ ...direct, engine: "niho-6" }, raster).engine).toBe("niho-6");

    const mismatch = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof DevelopSettingsBaseMismatchError ? error.reason : error;
      }
      return null;
    };
    expect(mismatch(() => developSettingsOnWorkingCopy(direct, "raw-apple.d8.p1.e1.cal-none"))).toBe("engine_mismatch");
    expect(mismatch(() => developSettingsOnWorkingCopy({ ...direct, base: "raw-apple.d8.p1.e1.cal-none" }, "raw-apple.d8.p1.e1.cal-none")))
      .toBe("engine_mismatch");
    expect(mismatch(() => developSettingsOnWorkingCopy(direct, "fixture-base"))).toBe("engine_mismatch");
    const signedBase = "raw-apple.d8.p3.e4.cal-signed";
    const signedMeta = { kind: "raw", encoding: { kind: "signed-gamma18-v1", ceiling: 2 } };
    expect(mismatch(() => developSettingsOnWorkingCopy(direct, signedBase, signedMeta))).toBe("engine_mismatch");
    expect(mismatch(() => developSettingsOnWorkingCopy({ ...direct, look: "niho-standard-2" }, raster))).toBe("engine_mismatch");
    expect(mismatch(() => developSettingsOnWorkingCopy({ ...direct, look: "niho-standard-3" }, raster))).toBe("engine_mismatch");
    // 保存済みの niho-2 は RAW の上でも raster の上でも niho-2 のまま（数式を変えない）
    const legacy = { ...direct, engine: "niho-2" };
    expect(developSettingsOnWorkingCopy(legacy, raster).engine).toBe("niho-2");
    expect(developSettingsOnWorkingCopy(legacy, "raw-apple.d8.p1.e1.cal-none").engine).toBe("niho-2");
  });

  it("signed RAWはbaseとmetadataと niho-3/standard-2 の組だけを開く", () => {
    const base = "raw-apple.d8.p3.e4.cal-signed";
    const meta = { kind: "raw", encoding: { kind: "signed-gamma18-v1", ceiling: 2 } };
    expect(developSettingsOnWorkingCopy(null, base, meta)).toMatchObject({
      engine: "niho-3",
      look: "niho-standard-2",
      base,
    });
    const saved = { ...neutralDevelopSettings(base), engine: "niho-3", look: "niho-standard-2", colorNoiseReduction: 31 };
    expect(developSettingsOnWorkingCopy(saved, base, meta)).toEqual(saved);
    expect(() => developSettingsOnWorkingCopy(saved, base)).toThrow(DevelopSettingsBaseMismatchError);
    expect(() => developSettingsOnWorkingCopy(neutralDevelopSettings(base), base, meta)).toThrow(DevelopSettingsBaseMismatchError);
  });

  it("対応校正の未保存signedだけniho-11へ初期化し、保存済みniho-3/niho-4/niho-7を維持する", () => {
    const base = "raw-apple.d8.p3.e4.cal-panasonic-dc-s5-apple-v4.lens-apple";
    const meta = { kind: "raw", encoding: { kind: "signed-gamma18-v1", ceiling: 2 },
      dcpSha256: "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4" };
    expect(developSettingsOnWorkingCopy(null, base, meta)).toMatchObject({ engine: "niho-11", look: "niho-standard-5" });
    const saved = { ...neutralDevelopSettings(base), engine: "niho-3", look: "niho-standard-2" };
    expect(developSettingsOnWorkingCopy(saved, base, meta)).toEqual(saved);
    const savedNiho4 = { ...saved, engine: "niho-4", look: "niho-standard-3" };
    expect(developSettingsOnWorkingCopy(savedNiho4, base, meta)).toEqual(savedNiho4);
    const savedNiho7 = { ...saved, engine: "niho-7", look: "niho-standard-5" };
    expect(developSettingsOnWorkingCopy(savedNiho7, base, meta)).toEqual(savedNiho7);
    expect(developSettingsOnWorkingCopy(null, base, { ...meta, dcpSha256: "cal-unknown" })).toMatchObject({ engine: "niho-3" });
    expect(() => developSettingsOnWorkingCopy({ ...saved, engine: "niho-4", look: "niho-standard-3" }, base,
      { ...meta, dcpSha256: "cal-unknown" })).toThrow(DevelopSettingsBaseMismatchError);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-4", look: "niho-standard-3" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-7", look: "niho-standard-5" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-11", look: "niho-standard-5" })).toBe(true);
    expect(() => developSettingsOnWorkingCopy({ ...saved, engine: "niho-7", look: "niho-standard-5" }, base,
      { ...meta, dcpSha256: "cal-unknown" })).toThrow(DevelopSettingsBaseMismatchError);
    for (const [otherBase, otherMeta] of [
      ["raster.ci2.p2.e2.icc-srgb", { kind: "raster", encoding: "jpeg8" }],
      ["camera-linear.v1", null],
    ] as const) {
      expect(() => developSettingsOnWorkingCopy({ ...saved, engine: "niho-7", look: "niho-standard-5", base: otherBase },
        otherBase, otherMeta)).toThrow(DevelopSettingsBaseMismatchError);
    }
  });

  it("signed metadataはRust readerと同じexact encodingを必須にし、legacy RAWとraster jpeg8だけをunsignedで保つ", () => {
    const signedBase = "raw-apple.d8.p3.e4.cal-signed";
    expect(signedWorkingCopyState(signedBase, { kind: "raw", encoding: { kind: "signed-gamma18-v1", ceiling: 2 } })).toBe(
      "signed",
    );
    for (const encoding of [
      { kind: "signed-gamma18-v1" },
      { kind: "signed-gamma18-v1", ceiling: 3 },
      { kind: "signed-gamma18-v1", ceiling: 2, extra: true },
      { kind: "future", ceiling: 2 },
    ]) {
      expect(signedWorkingCopyState(signedBase, { kind: "raw", encoding })).toBe("mismatch");
    }
    expect(signedWorkingCopyState("raw-apple.d8.p0.e1.cal-none", { kind: "raw" })).toBe("unsigned");
    expect(signedWorkingCopyState("raw-apple.d8.p2.e1.cal-none", { kind: "raw", encoding: null })).toBe("unsigned");
    expect(signedWorkingCopyState("raster.ci2.p2.e2.icc-srgb", { kind: "raster", encoding: "jpeg8" })).toBe("unsigned");
    expect(signedWorkingCopyState("raw-apple.d8.p2.e9.cal-future", { kind: "raw" })).toBe("mismatch");
    expect(signedWorkingCopyState("raw-apple.d8.p2.e1.cal-none", { kind: "raw", encoding: "jpeg8" })).toBe("mismatch");
    expect(signedWorkingCopyState("fixture-base", null)).toBe("unsigned");
  });

  it("ルックを持たない保存済みの編集内容は恒等のルック（crate の既定と同じ）で続ける", () => {
    expect(developSettingsOnWorkingCopy({ v: 1, engine: "niho-1", exposure: 0.2 }, "raw-apple.d8.p1.e1.cal-none")).toEqual({
      v: 1,
      engine: "niho-1",
      look: "niho-interim-1",
      base: "raw-apple.d8.p1.e1.cal-none",
      exposure: 0.2,
    });
  });
});

describe("isEditableDevelopSettings", () => {
  it("まだ無いか、v1〜v9 で既知の数式なら直せる（未知の版・必要版より低い値は直さない）", () => {
    expect(isEditableDevelopSettings(null)).toBe(true);
    expect(isEditableDevelopSettings(undefined)).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-1", geometry: CROP })).toBe(true);
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-2" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-3" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-3", look: "niho-standard-2" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 3, engine: "niho-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-1", grayscale: true })).toBe(false);
    expect(isEditableDevelopSettings({ v: 3, engine: "niho-1", grayscale: true })).toBe(true);
    expect(isEditableDevelopSettings({ v: 4, engine: "niho-1", colorPoints: [] })).toBe(true);
    expect(isEditableDevelopSettings({ v: 5, engine: "niho-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 6, engine: "niho-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 9, engine: "niho-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 10, engine: "niho-1" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1", geometry: CROP })).toBe(false);
    expect(isEditableDevelopSettings("niho-1")).toBe(false);
  });

  it("niho-6 / niho-10 / niho-12〜niho-14 は raster ルックだけ、niho-7 / niho-11 は standard-5 だけを直せる", () => {
    expect(isEditableDevelopSettings(neutralDevelopSettings())).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6", look: "niho-standard-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6", look: "niho-interim-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-6", look: "niho-standard-1", geometry: CROP })).toBe(true);
    expect(isEditableDevelopSettings({ v: 3, engine: "niho-6", grayscale: true })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6", look: "niho-standard-2" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6", look: "niho-standard-3" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6", look: "niho-standard-9" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6", look: null })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-10", look: "niho-standard-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-5" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-7" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-7", look: "niho-standard-5" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-7", look: "niho-standard-3" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-11", look: "niho-standard-5" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-11", look: "niho-standard-3" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-4", look: "niho-standard-5" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-10", look: "niho-standard-5" })).toBe(false);
    for (const engine of ["niho-12", "niho-13", "niho-14"]) {
      expect(isEditableDevelopSettings({ v: 1, engine })).toBe(true);
      expect(isEditableDevelopSettings({ v: 1, engine, look: "niho-interim-1" })).toBe(true);
      expect(isEditableDevelopSettings({ v: 4, engine, look: "niho-standard-1", colorPoints: [] })).toBe(true);
      expect(isEditableDevelopSettings({ v: 1, engine, look: "niho-standard-2" })).toBe(false);
      expect(isEditableDevelopSettings({ v: 1, engine, look: "niho-standard-5" })).toBe(false);
    }
    // niho-8（評価候補）・niho-9（欠番）・niho-15 以降はこの画面では直さない
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-8", look: "niho-standard-1" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-9", look: "niho-standard-1" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-15", look: "niho-standard-1" })).toBe(false);
  });

  it("幾何を扱えない面（NIHO Desktop）は、幾何のある設定を直さない（幾何の無い v1 / v2 は直せる）", () => {
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-1", geometry: CROP }, { geometry: false })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1" }, { geometry: false })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1", geometry: { aspect: "1:1" } }, { geometry: false })).toBe(true);
    expect(isEditableDevelopSettings(null, { geometry: false })).toBe(true);
  });

  it("ルックはこの画面の知っている版（niho-interim-1・niho-standard-1）か、無いときだけ直せる", () => {
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1", look: "niho-interim-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1", look: "niho-standard-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-1", geometry: CROP, look: "niho-standard-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1", look: "niho-standard-2" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-1", geometry: CROP, look: "niho-standard-2" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1", look: 1 })).toBe(false);
  });

  it("readDevelopSettings は v1〜v7 の形だけを読み、必要な版より低い値は拒む", () => {
    expect(readDevelopSettings({ v: 1, engine: "niho-1", exposure: 1 })).toEqual({ v: 1, engine: "niho-1", exposure: 1 });
    expect(readDevelopSettings({ v: 2, engine: "niho-1", geometry: CROP })).toEqual({ v: 2, engine: "niho-1", geometry: CROP });
    expect(readDevelopSettings({ v: 3, engine: "niho-1", grayscale: true })).toEqual({ v: 3, engine: "niho-1", grayscale: true });
    expect(readDevelopSettings({ v: 4, engine: "niho-1", colorPoints: [] })).toEqual({ v: 4, engine: "niho-1", colorPoints: [] });
    expect(readDevelopSettings({ v: 5, engine: "niho-1" })).toEqual({ v: 5, engine: "niho-1" });
    expect(readDevelopSettings({ v: 6, engine: "niho-1" })).toEqual({ v: 6, engine: "niho-1" });
    expect(readDevelopSettings({ v: 7, engine: "niho-1", geometry: { perspective: { vertical: -10 } } })).toEqual({
      v: 7,
      engine: "niho-1",
      geometry: { perspective: { vertical: -10 } },
    });
    expect(readDevelopSettings({ v: 6, engine: "niho-1", geometry: { perspective: { vertical: -10 } } })).toBeNull();
    expect(readDevelopSettings({ v: 1 })).toBeNull();
    expect(readDevelopSettings(null)).toBeNull();
  });
});

describe("幾何（回転・反転・角度補正・切り抜き。#17138）", () => {
  it("hasDevelopGeometry は crate の is_identity と同じ（半回転＋両方の反転・縦横比だけは恒等、壊れた値は恒等でない）", () => {
    expect(hasDevelopGeometry({ v: 1 })).toBe(false);
    expect(hasDevelopGeometry({ geometry: null })).toBe(false);
    expect(hasDevelopGeometry({ geometry: {} })).toBe(false);
    expect(hasDevelopGeometry({ geometry: { aspect: "4:5" } })).toBe(false);
    expect(hasDevelopGeometry({ geometry: { rotate: 180, flipH: true, flipV: true } })).toBe(false);
    expect(hasDevelopGeometry({ geometry: { crop: { left: 0, top: 0, right: 1, bottom: 1 } } })).toBe(false);
    expect(hasDevelopGeometry({ geometry: { rotate: 180 } })).toBe(true);
    expect(hasDevelopGeometry({ geometry: { flipV: true } })).toBe(true);
    expect(hasDevelopGeometry({ geometry: { angle: 0.5 } })).toBe(true);
    expect(hasDevelopGeometry({ geometry: { crop: { right: 0.9 } } })).toBe(true);
    expect(hasDevelopGeometry({ geometry: "crop" })).toBe(true);
    expect(developSettingsVersion({ geometry: CROP })).toBe(2);
    expect(developSettingsVersion({ geometry: { aspect: "1:1" } })).toBe(1);
    expect(developSettingsVersion({ grayscale: true })).toBe(3);
    expect(developSettingsVersion({ geometry: CROP, grain: { amount: 1 } })).toBe(3);
    expect(hasNullDevelopGeometryField({ geometry: { rotate: null } })).toBe(true);
    expect(hasNullDevelopGeometryField({ geometry: { crop: { left: null } } })).toBe(true);
    expect(hasNullDevelopGeometryField({ geometry: { aspect: null } })).toBe(false);
  });

  it("スライダーの値を重ねても、幾何と v2 を保つ（幾何を外せば v1 に戻る）", () => {
    const cropped = { ...neutralDevelopSettings(), v: 2 as const, geometry: CROP };
    const next = applyBrowserAdjustmentsToDevelopSettings(cropped, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, exposure: 0.5 });
    expect(next).toMatchObject({ v: 2, geometry: CROP, exposure: 0.5 });
    const uncropped = applyBrowserAdjustmentsToDevelopSettings(
      { ...cropped, geometry: { aspect: "1:1" } },
      NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS,
    );
    expect(uncropped.v).toBe(1);
  });

  it("「初期化」は色だけを neutral に戻し、幾何と v2 を保つ（幾何が無ければ neutral そのもの）", () => {
    const cropped = { ...neutralDevelopSettings("raw-1"), v: 2 as const, exposure: 0.8, geometry: CROP };
    expect(resetDevelopSettingsColors(cropped, "raw-2")).toEqual({ ...neutralDevelopSettings("raw-2"), v: 2, geometry: CROP });
    expect(resetDevelopSettingsColors({ ...neutralDevelopSettings(), exposure: 0.8, geometry: { aspect: "4:5" } }, null)).toEqual({
      ...neutralDevelopSettings(),
      geometry: { aspect: "4:5" },
    });
    expect(resetDevelopSettingsColors({ ...neutralDevelopSettings(), exposure: 0.8 }, null)).toEqual(neutralDevelopSettings());
    expect(resetDevelopSettingsColors(null, null)).toEqual(neutralDevelopSettings());
    expect(resetDevelopSettingsColors({ ...cropped, engine: "niho-1" }, "raw-2")).toEqual({
      ...neutralDevelopSettings("raw-2"), engine: "niho-1", v: 2, geometry: CROP,
    });
    expect(resetDevelopSettingsColors({ ...neutralDevelopSettings(), engine: "niho-1", exposure: 0.8 }, null).engine).toBe("niho-1");
    expect(resetDevelopSettingsColors({ v: 1, engine: "niho-1", exposure: 0.8 }, null)).not.toHaveProperty("look");
  });

  it("「初期化」は今の数式を保ち、今の編集内容が無ければ base の neutral と同じ数式にする（#18397）", () => {
    expect(resetDevelopSettingsColors(null, null).engine).toBe("niho-14");
    expect(resetDevelopSettingsColors(null, "raster.ci2.p2.e2.icc-srgb")).toEqual(neutralDevelopSettings("raster.ci2.p2.e2.icc-srgb"));
    expect(resetDevelopSettingsColors(null, "raw-apple.d8.p1.e1.cal-none")).toMatchObject({
      engine: "niho-14",
      base: "raw-apple.d8.p1.e1.cal-none",
    });
    expect(resetDevelopSettingsColors(null, "fixture-base").engine).toBe("niho-2");
    // 保存済みの niho-2 / niho-10 / niho-12 / niho-13 の写真を初期化しても niho-14 にしない
    expect(resetDevelopSettingsColors({ ...neutralDevelopSettings(), engine: "niho-2", exposure: 0.8 }, null)).toEqual({
      ...neutralDevelopSettings(),
      engine: "niho-2",
    });
    expect(
      resetDevelopSettingsColors({ ...neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none"), engine: "niho-2", exposure: 0.8 },
        "raw-apple.d8.p1.e1.cal-none").engine,
    ).toBe("niho-2");
    expect(resetDevelopSettingsColors({ ...neutralDevelopSettings("raster.x"), engine: "niho-10", exposure: 0.8 }, "raster.x").engine)
      .toBe("niho-10");
    expect(
      resetDevelopSettingsColors({ ...neutralDevelopSettings("raster.x"), engine: "niho-12", relativeTemperature: 20 }, "raster.x").engine,
    ).toBe("niho-12");
    expect(
      resetDevelopSettingsColors({ ...neutralDevelopSettings("raster.x"), engine: "niho-13", relativeTemperature: 20 }, "raster.x").engine,
    ).toBe("niho-13");
    expect(resetDevelopSettingsColors({ ...neutralDevelopSettings("raster.x"), exposure: 0.8 }, "raster.x").engine).toBe("niho-14");
  });

  it("切り抜いただけの写真は neutral ではない（オリジナルのままでは見せられない）が、色は neutral（初期化を押せない）", () => {
    const cropped = { ...neutralDevelopSettings(), v: 2 as const, geometry: CROP };
    expect(isNeutralDevelopSettings(cropped)).toBe(false);
    expect(isNeutralDevelopColors(cropped)).toBe(true);
    expect(isNeutralDevelopColors({ ...cropped, exposure: 0.1 })).toBe(false);
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), geometry: { aspect: "1:1" } })).toBe(true);
  });
});

describe("スライダーと編集内容の写し", () => {
  it("露光量・コントラスト・彩度は同名、色温度 / 色かぶり補正は相対の値として読む（範囲の外は丸める）", () => {
    expect(
      readBrowserAdjustmentsFromDevelopSettings({
        v: 1,
        engine: "niho-1",
        exposure: 0.5,
        contrast: 20,
        saturation: -10,
        relativeTemperature: 30,
        relativeTint: -300,
        highlights: 40,
      }),
    ).toEqual({ exposure: 0.5, contrast: 20, saturation: -10, temperature: 30, tint: -100 });
    expect(readBrowserAdjustmentsFromDevelopSettings(null)).toEqual(NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS);
  });

  it("土台が無ければ neutral に重ねる", () => {
    expect(
      applyBrowserAdjustmentsToDevelopSettings(null, { exposure: 1, contrast: 10, saturation: 5, temperature: 0, tint: 0 }),
    ).toEqual({ ...neutralDevelopSettings(), exposure: 1, contrast: 10, saturation: 5 });
  });

  it("土台の知らない項目（HSL など）・ルック・base は残す", () => {
    const base = {
      v: 1 as const,
      engine: "niho-1",
      look: "niho-standard-1",
      base: "raw-1",
      hsl: ["green", { hue: 10, saturation: 0, luminance: 0 }],
      highlights: -20,
      whiteBalance: { mode: "asShot" },
    };
    const next = applyBrowserAdjustmentsToDevelopSettings(base, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, exposure: 0.3 });
    expect(next).toMatchObject({
      v: 1,
      engine: "niho-1",
      look: "niho-standard-1",
      base: "raw-1",
      hsl: base.hsl,
      highlights: -20,
      exposure: 0.3,
      whiteBalance: { mode: "asShot" },
    });
  });

  it("look・base が無い土台には暫定ルックと base: null を足す", () => {
    const next = applyBrowserAdjustmentsToDevelopSettings({ v: 1, engine: "niho-1" }, NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS);
    expect(next.look).toBe("niho-interim-1");
    expect(next.base).toBeNull();
    expect(next.whiteBalance).toEqual({ mode: "asShot" });
  });

  it("相対の色温度 / 色かぶり補正を動かしたら whiteBalance.mode を relative、両方 0 に戻したら asShot", () => {
    const warmed = applyBrowserAdjustmentsToDevelopSettings(null, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, temperature: 25 });
    expect(warmed).toMatchObject({ relativeTemperature: 25, relativeTint: 0, whiteBalance: { mode: "relative" } });

    const tinted = applyBrowserAdjustmentsToDevelopSettings(warmed, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, tint: -5 });
    expect(tinted).toMatchObject({ relativeTemperature: 0, relativeTint: -5, whiteBalance: { mode: "relative" } });

    const back = applyBrowserAdjustmentsToDevelopSettings(tinted, NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS);
    expect(back.whiteBalance).toEqual({ mode: "asShot" });
    expect(isNeutralDevelopSettings(back)).toBe(true);
    const legacy = applyBrowserAdjustmentsToDevelopSettings(
      { ...neutralDevelopSettings(), engine: "niho-1" },
      { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, temperature: 25 },
    );
    expect(legacy.engine).toBe("niho-1");
  });

  it("相対の値が 0 のままなら、土台の白（absolute など）は変えない", () => {
    const base = { v: 1 as const, engine: "niho-1", whiteBalance: { mode: "absolute", temperature: 5200, tint: 3 } };
    expect(applyBrowserAdjustmentsToDevelopSettings(base, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, exposure: 1 }).whiteBalance).toEqual(
      base.whiteBalance,
    );
  });
});

describe("isNeutralDevelopSettings", () => {
  it("無ければ neutral。版の情報と既定値の項目（パラメトリックの区切り・curveRefineSaturation 100）は数えない", () => {
    expect(isNeutralDevelopSettings(null)).toBe(true);
    expect(
      isNeutralDevelopSettings({
        ...neutralDevelopSettings(),
        look: "niho-standard-1",
        base: "raw-1",
        parametricShadowSplit: 25,
        parametricMidtoneSplit: 50,
        parametricHighlightSplit: 75,
        curveRefineSaturation: 100,
        toneCurves: [],
      }),
    ).toBe(true);
  });

  it("値が 0 でない・既定と違う区切り・変換できなかった値・知らない項目があれば neutral でない", () => {
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), exposure: 0.1 })).toBe(false);
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), parametricShadowSplit: 30 })).toBe(false);
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), legacySettings: { exposure: 0 } })).toBe(false);
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), mystery: 1 })).toBe(false);
  });

  it("whiteBalance.mode が relative でも相対の値が 0 なら neutral", () => {
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), whiteBalance: { mode: "relative" } })).toBe(true);
    expect(
      isNeutralDevelopSettings({ ...neutralDevelopSettings(), whiteBalance: { mode: "relative" }, relativeTint: 3 }),
    ).toBe(false);
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), whiteBalance: { mode: "absolute" } })).toBe(false);
  });
});

describe("効果（白黒・周辺光量補正・粒子。E1b #17134）", () => {
  it("白黒だけオン・周辺光量補正だけ・粒子だけ、のどれでも neutral でない（「初期化」を押せる）", () => {
    const gray: DevelopSettings = { ...neutralDevelopSettings(), grayscale: true };
    const vignette: DevelopSettings = { ...neutralDevelopSettings(), vignette: { amount: -20 } };
    const grain: DevelopSettings = { ...neutralDevelopSettings(), grain: { amount: 15 } };
    for (const settings of [gray, vignette, grain]) {
      expect(isNeutralDevelopColors(settings)).toBe(false);
      expect(isNeutralDevelopSettings(settings)).toBe(false);
    }
  });

  it("画に効いていない効果の項目は neutral のまま（crate の is_neutral と同じ）。形の壊れた値は neutral にしない", () => {
    const inactive: DevelopSettings = {
      ...neutralDevelopSettings(),
      grayscale: false,
      grayMixer: { red: 40, blue: -25.5 },
      vignette: { amount: 0, midpoint: 40, style: "paintOverlay" },
      grain: { amount: 0, size: 60, roughness: 50 },
    };
    expect(isNeutralDevelopColors(inactive)).toBe(true);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), vignette: { midpoint: 40 }, grain: { size: 60 } })).toBe(true);
    // 白黒がオンなら、ミックスの有無によらず neutral でない
    expect(isNeutralDevelopColors({ ...inactive, grayscale: true })).toBe(false);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), grayscale: 1 })).toBe(false);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), grayscale: null })).toBe(false);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), grayMixer: { red: "40" } })).toBe(false);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), vignette: 20 })).toBe(false);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), vignette: { amount: null } })).toBe(false);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), grain: [] })).toBe(false);
  });

  it("「初期化」と「補正前」は効果も外し、幾何と v2 を保つ", () => {
    const edited: DevelopSettings = {
      ...neutralDevelopSettings("raw-1"),
      v: 2,
      geometry: CROP,
      grayscale: true,
      grayMixer: { red: 40 },
      vignette: { amount: -20 },
      grain: { amount: 15, size: 40 },
    };
    const reset = resetDevelopSettingsColors(edited, "raw-1");
    expect(reset).toEqual({ ...neutralDevelopSettings("raw-1"), v: 2, geometry: CROP });
    expect(isNeutralDevelopColors(reset)).toBe(true);
    for (const key of ["grayscale", "grayMixer", "vignette", "grain"]) expect(Object.hasOwn(reset, key)).toBe(false);
  });
});

// K1c 移行元設計: 補正の置き場は developSettings の 1 つ。旧エンジン（Photo Bench）の settings・その保存日時は見ない
describe("hasSavedDevelopSettings", () => {
  const developed = { ...neutralDevelopSettings(), exposure: 0.5 };

  it("developSettings があれば true、保存したことが無ければ（null・項目なし）false", () => {
    expect(hasSavedDevelopSettings({ developSettings: developed })).toBe(true);
    expect(hasSavedDevelopSettings({ developSettings: null })).toBe(false);
    expect(hasSavedDevelopSettings({})).toBe(false);
    // 形の壊れた値（オブジェクトでない）は補正として読まない
    expect(hasSavedDevelopSettings({ developSettings: [developed] })).toBe(false);
    expect(hasSavedDevelopSettings({ developSettings: "niho-1" })).toBe(false);
  });

  it("neutral かどうかは見ない（「初期化」も保存した補正）。古い API が返す旧エンジンの項目があっても結果は変わらない", () => {
    expect(hasSavedDevelopSettings({ developSettings: neutralDevelopSettings() })).toBe(true);
    const legacyFields = { hasSettings: true, settingsUpdatedAt: "2026-09-28T02:00:00.000Z" };
    expect(hasSavedDevelopSettings({ ...legacyFields, developSettings: developed })).toBe(true);
    expect(hasSavedDevelopSettings({ ...legacyFields, developSettings: null })).toBe(false);
  });
});

describe("developSettingsToEditSettings（crate の to_edit_settings_value と同じ規則）", () => {
  it("効いている効果（白黒・周辺光量補正・粒子）のある補正は写さない（落として色つきで出さない）。効いていない効果は落として写す", () => {
    const base = { v: 1, engine: "niho-1", exposure: 0.5 };
    expect(developSettingsToEditSettings({ ...base, grayscale: true })).toBeNull();
    expect(developSettingsToEditSettings({ ...base, vignette: { amount: -20 } })).toBeNull();
    expect(developSettingsToEditSettings({ ...base, grain: { amount: 30 } })).toBeNull();
    expect(
      developSettingsToEditSettings({ ...base, grayscale: false, grayMixer: { red: 10 }, vignette: { amount: 0 }, grain: { amount: 0, size: 40 } }),
    ).toEqual({ exposure: 0.5, whiteBalance: { mode: "asShot" } });
  });

  it("版の情報と知らない項目を落とし、相対の白は asShot にして相対の値を残す", () => {
    expect(
      developSettingsToEditSettings({
        ...neutralDevelopSettings(),
        exposure: 0.5,
        highlights: -20,
        relativeTemperature: 12,
        relativeTint: -3,
        whiteBalance: { mode: "relative" },
        toneCurves: [{ channel: "master", points: [[0, 0], [1, 1]] }],
        hsl: ["green", { hue: 10, saturation: 0, luminance: 0 }],
        parametricShadowSplit: 25,
        mystery: 1,
      }),
    ).toEqual({
      exposure: 0.5,
      contrast: 0,
      saturation: 0,
      highlights: -20,
      relativeTemperature: 12,
      relativeTint: -3,
      toneCurves: [{ channel: "master", points: [[0, 0], [1, 1]] }],
      hsl: ["green", { hue: 10, saturation: 0, luminance: 0 }],
      parametricShadowSplit: 25,
      whiteBalance: { mode: "asShot" },
    });
  });

  it("absolute の白は custom（温度・色かぶりの有限数を添える）", () => {
    expect(
      developSettingsToEditSettings({
        v: 1,
        engine: "niho-1",
        base: null,
        whiteBalance: { mode: "absolute", temperature: 5200, tint: 3 },
      }),
    ).toEqual({ whiteBalance: { mode: "custom", temperature: 5200, tint: 3 } });
    expect(developSettingsToEditSettings({ v: 1, engine: "niho-1" })).toEqual({ whiteBalance: { mode: "asShot" } });
  });

  it("作業コピーの上で直した補正（base がある RAW など。#16944）も base・look を落として戻す（Desktop は自分の土台で描く）", () => {
    expect(
      developSettingsToEditSettings({
        ...neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none"),
        exposure: 0.7,
        relativeTint: 4,
        whiteBalance: { mode: "relative" },
      }),
    ).toEqual({
      exposure: 0.7,
      contrast: 0,
      saturation: 0,
      relativeTemperature: 0,
      relativeTint: 4,
      whiteBalance: { mode: "asShot" },
    });
  });

  it("変換できなかった値（legacySettings）・知らない版・幾何（切り抜きを落として写さない）は戻せない（null）", () => {
    expect(developSettingsToEditSettings({ ...neutralDevelopSettings(), legacySettings: { exposure: 9 } })).toBeNull();
    expect(
      developSettingsToEditSettings({ ...neutralDevelopSettings("raw-1"), legacySettings: { profile: "adobe" } }),
    ).toBeNull();
    expect(developSettingsToEditSettings({ v: 10, engine: "niho-1" })).toBeNull();
    expect(developSettingsToEditSettings({ ...neutralDevelopSettings(), v: 2, geometry: CROP })).toBeNull();
    expect(developSettingsToEditSettings({ v: 2, engine: "niho-1" })).toEqual({ whiteBalance: { mode: "asShot" } });
    expect(developSettingsToEditSettings(null)).toBeNull();
  });
});

describe("補正のコピーと貼り付け（F5a-2 #17140）", () => {
  const source: DevelopSettings = {
    ...neutralDevelopSettings("raw-1"),
    v: 2,
    look: "niho-interim-1",
    exposure: 0.8,
    contrast: 10,
    relativeTemperature: 12,
    whiteBalance: { mode: "relative" },
    hsl: { red: { hue: 5 } },
    geometry: CROP,
  };
  const copied = {
    exposure: 0.8,
    contrast: 10,
    saturation: 0,
    relativeTemperature: 12,
    relativeTint: 0,
    whiteBalance: { mode: "relative" },
    hsl: { red: { hue: 5 } },
  };

  it("コピーは色の補正（この画面が知らない項目も）を持ち、数式の版・ルック・土台の版・幾何は持たない", () => {
    expect(copyDevelopSettings(source)).toEqual(copied);
  });

  it("RAW の絶対のホワイトバランスは写さない（撮影時のまま・相対は写す）", () => {
    expect(copyDevelopSettings({ ...source, whiteBalance: { mode: "absolute", temperature: 5200, tint: 3 } })).not.toHaveProperty(
      "whiteBalance",
    );
    expect(copyDevelopSettings(neutralDevelopSettings()).whiteBalance).toEqual({ mode: "asShot" });
  });

  it("貼り付けは色の補正を写した全部に置き換え（写しに無い項目は neutral）、数式の版・ルック・土台の版は貼り付け先のまま", () => {
    const target: DevelopSettings = { ...neutralDevelopSettings(null), engine: "niho-2", saturation: -20, effects: { grain: 30 } };
    const pasted = pasteDevelopSettings(target, copyDevelopSettings(source));
    expect(pasted).toEqual({
      ...neutralDevelopSettings(null),
      engine: "niho-2",
      exposure: 0.8,
      contrast: 10,
      relativeTemperature: 12,
      whiteBalance: { mode: "relative" },
      hsl: { red: { hue: 5 } },
    });
    // 作業コピーの上で直す写真は、その土台の版のまま。ルックの無い古い設定はルック無しのまま
    expect(pasteDevelopSettings({ ...target, base: "raw-9" }, copied).base).toBe("raw-9");
    const { look: _look, ...noLook } = target;
    expect(pasteDevelopSettings(noLook, copied)).not.toHaveProperty("look");
    expect(pasteDevelopSettings({ ...target, engine: "niho-1" }, copied).engine).toBe("niho-1");
  });

  it("貼り付け先の幾何（切り抜き・回転）は保ち、形の版はその幾何から決め直す", () => {
    const cropped = pasteDevelopSettings({ ...neutralDevelopSettings(), v: 2, geometry: CROP }, copied);
    expect(cropped.geometry).toEqual(CROP);
    expect(cropped.v).toBe(2);
    // 写し元に幾何があっても、貼り付け先に無ければ付かない
    expect(pasteDevelopSettings(neutralDevelopSettings(), copyDevelopSettings(source))).not.toHaveProperty("geometry");
  });

  it("ホワイトバランスは、写しに無い（RAW の絶対値だった）・貼り付け先が絶対値なら、貼り付け先のまま", () => {
    const absolute = { mode: "absolute", temperature: 4800, tint: -2 };
    expect(
      pasteDevelopSettings(
        { ...neutralDevelopSettings("raw-2"), whiteBalance: absolute, relativeTemperature: 11, relativeTint: 4 },
        copied,
      ),
    ).toMatchObject({ whiteBalance: absolute, relativeTemperature: 11, relativeTint: 4 });
    const withoutWhiteBalance = copyDevelopSettings({ ...source, relativeTemperature: 0, whiteBalance: absolute });
    expect(
      pasteDevelopSettings(
        { ...neutralDevelopSettings(), whiteBalance: { mode: "relative" }, relativeTemperature: 3, relativeTint: -6 },
        withoutWhiteBalance,
      ),
    ).toMatchObject({ whiteBalance: { mode: "relative" }, relativeTemperature: 3, relativeTint: -6, exposure: 0.8 });
    // 貼り付け先にも無ければ付けない
    const { whiteBalance: _whiteBalance, ...bare } = neutralDevelopSettings();
    expect(pasteDevelopSettings(bare, withoutWhiteBalance)).not.toHaveProperty("whiteBalance");
  });

  it("貼り付け先の数式（新規の niho-14 / 保存済みの niho-13・niho-12・niho-10・RAW の作業コピーの niho-2）は写し元によらず保つ", () => {
    expect(pasteDevelopSettings(neutralDevelopSettings(), copied).engine).toBe("niho-14");
    expect(pasteDevelopSettings({ ...neutralDevelopSettings(), engine: "niho-13" }, copied).engine).toBe("niho-13");
    expect(pasteDevelopSettings({ ...neutralDevelopSettings(), engine: "niho-12" }, copied).engine).toBe("niho-12");
    expect(pasteDevelopSettings({ ...neutralDevelopSettings(), engine: "niho-10" }, copied).engine).toBe("niho-10");
    expect(pasteDevelopSettings(neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none"), copied)).toMatchObject({
      engine: "niho-14",
      base: "raw-apple.d8.p1.e1.cal-none",
    });
    expect(
      pasteDevelopSettings({ ...neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none"), engine: "niho-2" }, copied),
    ).toMatchObject({
      engine: "niho-2",
      base: "raw-apple.d8.p1.e1.cal-none",
    });
  });
});

describe("修復の印（heal。niho-photo#44）", () => {
  const HEAL = [{ id: "m1", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.2, 0.3], [0.4, 0.35]] }];
  const healed: DevelopSettings = { v: 8, engine: "niho-10", look: "niho-standard-1", base: null, exposure: 0.4, heal: HEAL };

  it("印があれば形の版は 8（遠近・色ポイントより上）、空・無いなら印のない版", () => {
    expect(developSettingsVersion({ heal: HEAL })).toBe(8);
    expect(developSettingsVersion({ heal: HEAL, geometry: { perspective: { vertical: -10 } } })).toBe(8);
    expect(developSettingsVersion({ heal: [], geometry: { perspective: { vertical: -10 } } })).toBe(7);
    expect(developSettingsVersion({ heal: [] })).toBe(1);
  });

  it("v8 を読み・直せる。印が壊れている・印があって v が 8 未満なら読まない・直さない", () => {
    expect(readDevelopSettings(healed)).toEqual(healed);
    expect(isEditableDevelopSettings(healed)).toBe(true);
    expect(readDevelopSettings({ ...healed, heal: undefined })).not.toBeNull();
    expect(readDevelopSettings({ ...healed, v: 7 })).toBeNull();
    expect(isEditableDevelopSettings({ ...healed, v: 7 })).toBe(false);
    const broken = { ...healed, heal: [{ ...HEAL[0], radius: 0.9 }] };
    expect(readDevelopSettings(broken)).toBeNull();
    expect(isEditableDevelopSettings(broken)).toBe(false);
    expect(readDevelopSettings({ ...healed, v: 10 })).toBeNull();
  });

  it("補正のコピーは印を運ばず、貼り付け先の印を保つ（写真の中の傷の位置は写真ごと）", () => {
    const copied = copyDevelopSettings(healed);
    expect(copied).not.toHaveProperty("heal");
    expect(copied.exposure).toBe(0.4);
    const target: DevelopSettings = { v: 1, engine: "niho-10", look: "niho-standard-1", base: null };
    const pasted = pasteDevelopSettings(target, copied);
    expect(pasted).not.toHaveProperty("heal");
    expect(pasted.v).toBe(1);
    const otherMarks = [{ ...HEAL[0], id: "x", points: [[0.9, 0.9]] }];
    const onto = pasteDevelopSettings({ ...target, v: 8, heal: otherMarks }, { ...copied, heal: HEAL });
    expect(onto.heal).toBe(otherMarks);
    expect(onto.v).toBe(8);
  });

  it("プリセット・自動は印を運ばず、当てる前の写真の印を保つ", () => {
    const presetResult: DevelopSettings = { v: 1, engine: "niho-10", look: "niho-standard-1", base: null, contrast: 30 };
    const applied = presetDevelopSettings(healed, presetResult);
    expect(applied.heal).toBe(HEAL);
    expect(applied.v).toBe(8);
    expect(applied.contrast).toBe(30);
    const plain: DevelopSettings = { v: 1, engine: "niho-10", look: "niho-standard-1", base: null };
    expect(presetDevelopSettings(plain, { ...presetResult, v: 8, heal: HEAL })).not.toHaveProperty("heal");
    const auto = autoDevelopSettings(healed, { ...healed, exposure: 0.9, heal: undefined });
    expect(auto.heal).toBe(HEAL);
    expect(auto.v).toBe(8);
  });

  it("「初期化」は色だけを戻し、印（と幾何）は保つ。印は色の補正に数えないが、印のある写真は neutral でない", () => {
    const reset = resetDevelopSettingsColors({ ...healed, geometry: CROP }, null);
    expect(reset.heal).toBe(HEAL);
    expect(reset.geometry).toBe(CROP);
    expect(reset.exposure).toBe(0);
    expect(reset.v).toBe(8);
    expect(resetDevelopSettingsColors({ ...healed, exposure: 0 }, null).heal).toBe(HEAL);
    expect(isNeutralDevelopColors({ ...healed, exposure: 0 })).toBe(true);
    expect(isNeutralDevelopSettings({ ...healed, exposure: 0 })).toBe(false);
    expect(isNeutralDevelopSettings({ ...healed, exposure: 0, v: 1, heal: [] })).toBe(true);
  });

  it("旧エンジン（Photo Bench）の形へは戻さない（印を落とすと消したものが戻る）", () => {
    expect(developSettingsToEditSettings({ ...healed, exposure: 0 })).toBeNull();
    expect(developSettingsToEditSettings({ ...healed, v: 1, heal: [] })).not.toBeNull();
  });

  it("同じかの比較は印のキーの順を問わず、点が違えば違う", () => {
    const reordered = { ...healed, heal: [{ points: HEAL[0]!.points, feather: 0.5, radius: 0.02, mode: "remove", id: "m1" }] };
    expect(sameDevelopSettings(healed, reordered)).toBe(true);
    const moved = { ...healed, heal: [{ ...HEAL[0], points: [[0.2, 0.3]] }] };
    expect(sameDevelopSettings(healed, moved)).toBe(false);
  });
});

describe("レンズ補正（lens。niho-photo#45）", () => {
  const LENS = { distortion: 12, vignetting: -20, removeChromaticAberration: true, defringe: { purple: { amount: 40 } } };
  const lensed: DevelopSettings = { v: 9, engine: "niho-10", look: "niho-standard-1", base: null, exposure: 0.4, lens: LENS };

  it("画を変えるレンズ補正があれば形の版は 9（修復の印より上）、中点・色相の範囲だけ・無いならレンズの無い版", () => {
    expect(developSettingsVersion({ lens: LENS })).toBe(9);
    expect(developSettingsVersion({ lens: { vignetting: 5 }, heal: [{ id: "m1", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.2, 0.3]] }] })).toBe(9);
    expect(developSettingsVersion({ lens: { removeChromaticAberration: true } })).toBe(9);
    expect(developSettingsVersion({ lens: { defringe: { green: { amount: 1 } } } })).toBe(9);
    expect(developSettingsVersion({ lens: { vignettingMidpoint: 20, defringe: { purple: { hueLo: 10 } } } })).toBe(1);
    expect(developSettingsVersion({ lens: {} })).toBe(1);
    expect(developSettingsVersion({ lens: { distortion: 0 }, grayscale: true })).toBe(3);
    // 形の壊れた lens は恒等とみなさない（描けない設定）
    expect(developSettingsVersion({ lens: { profile: true } })).toBe(9);
  });

  it("v9 を読み・直せる。形が壊れている・画を変えるのに v が 9 未満なら読まない・直さない", () => {
    expect(readDevelopSettings(lensed)).toEqual(lensed);
    expect(isEditableDevelopSettings(lensed)).toBe(true);
    expect(readDevelopSettings({ ...lensed, v: 8 })).toBeNull();
    expect(isEditableDevelopSettings({ ...lensed, v: 8 })).toBe(false);
    // 中点だけなら古い版のまま読める（古い reader の画は変わらない）
    expect(readDevelopSettings({ ...lensed, v: 1, lens: { vignettingMidpoint: 30 } })).not.toBeNull();
    for (const broken of [
      { ...LENS, distortion: 101 },
      { ...LENS, profile: true },
      { ...LENS, removeChromaticAberration: 1 },
      { ...LENS, defringe: { purple: { amount: 10, hueLo: 80, hueHi: 20 } } },
      { ...LENS, defringe: { blue: { amount: 10 } } },
      { ...LENS, defringe: { purple: null } },
      [LENS],
    ]) {
      expect(readDevelopSettings({ ...lensed, lens: broken }), JSON.stringify(broken)).toBeNull();
      expect(isEditableDevelopSettings({ ...lensed, lens: broken })).toBe(false);
    }
    expect(readDevelopSettings({ ...lensed, lens: null })).not.toBeNull();
    expect(readDevelopSettings({ ...lensed, v: 10 })).toBeNull();
  });

  it("補正のコピーはレンズ補正を運び（レンズと撮影の特性）、貼り付け先の版を決め直す", () => {
    const copied = copyDevelopSettings(lensed);
    expect(copied.lens).toBe(LENS);
    const target: DevelopSettings = { v: 1, engine: "niho-10", look: "niho-standard-1", base: null };
    const pasted = pasteDevelopSettings(target, copied);
    expect(pasted.lens).toBe(LENS);
    expect(pasted.v).toBe(9);
    // コピーに無ければ貼り付け先のレンズ補正も外れる（色の補正と同じく全部を置き換える）
    const without = pasteDevelopSettings({ ...target, v: 9, lens: LENS }, copyDevelopSettings({ ...target, exposure: 0.3 }));
    expect(without).not.toHaveProperty("lens");
    expect(without.v).toBe(1);
  });

  it("プリセット・自動の結果のレンズ補正を入れる（crate が写真の値に XMP の値を当てたもの）", () => {
    const presetResult: DevelopSettings = { ...lensed, contrast: 30, lens: { ...LENS, distortion: 30 } };
    const applied = presetDevelopSettings({ ...lensed, exposure: 0 }, presetResult);
    expect(applied.lens).toEqual({ ...LENS, distortion: 30 });
    expect(applied.v).toBe(9);
    const auto = autoDevelopSettings(lensed, { ...lensed, exposure: 0.9 });
    expect(auto.lens).toBe(LENS);
    expect(auto.v).toBe(9);
  });

  it("「初期化」（と補正前）はレンズ補正を外す。画を変えるレンズ補正は色の補正に数える", () => {
    const reset = resetDevelopSettingsColors({ ...lensed, geometry: CROP }, null);
    expect(reset).not.toHaveProperty("lens");
    expect(reset.geometry).toBe(CROP);
    expect(reset.v).toBe(2);
    expect(isNeutralDevelopColors({ ...lensed, exposure: 0 })).toBe(false);
    expect(isNeutralDevelopSettings({ ...lensed, exposure: 0 })).toBe(false);
    expect(isNeutralDevelopColors({ ...lensed, exposure: 0, v: 1, lens: { vignettingMidpoint: 20 } })).toBe(true);
    expect(isNeutralDevelopColors({ ...lensed, exposure: 0, v: 1, lens: { distortion: 0 } })).toBe(true);
  });

  it("旧エンジン（Photo Bench）の形へは戻さない（落とすと直した歪み・周辺光量・色収差が戻る）", () => {
    expect(developSettingsToEditSettings({ ...lensed, exposure: 0 })).toBeNull();
    expect(developSettingsToEditSettings({ ...lensed, v: 1, lens: { vignettingMidpoint: 20 } })).not.toBeNull();
  });
});
