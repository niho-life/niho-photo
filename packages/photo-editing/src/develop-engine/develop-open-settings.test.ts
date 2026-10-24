import { describe, expect, it, vi } from "vitest";

import type { PhotoLibraryPhoto } from "../library/photo-library";

import type { DevelopEngine } from "./develop-engine-client";
import type { DevelopSettings } from "./develop-settings";
import { convertEditSettingsToDevelop, resolveDevelopOpenSettings } from "./develop-open-settings";

function cloudPhoto(overrides: Partial<PhotoLibraryPhoto> = {}): PhotoLibraryPhoto {
  return {
    id: "c1",
    fileName: "IMG_0001.JPG",
    fileExtension: "jpg",
    sizeBytes: 1_000,
    contentSha256: "1".repeat(64),
    createdAt: "2026-09-24T00:00:00.000Z",
    uploadedBy: null,
    hasOriginal: true,
    hasWebImage: true,
    hasDevelopSettings: false,
    developSettings: null,
    developSettingsUpdatedAt: null,
    developRevision: 0,
    webRenderedRevision: null,
    ...overrides,
  } as PhotoLibraryPhoto;
}

function engineWith(convert: DevelopEngine["convertEditSettings"]): DevelopEngine {
  return { convertEditSettings: vi.fn(convert) } as unknown as DevelopEngine;
}

const SAVED_DEVELOP = {
  hasDevelopSettings: true,
  developSettings: { v: 1, engine: "niho-1", look: "niho-interim-1", base: null, exposure: 0.5 } as DevelopSettings,
  developSettingsUpdatedAt: "2026-09-28T00:00:00.000Z",
  developRevision: 2,
};

// K1c 移行元設計: 補正の置き場は developSettings の 1 つ。開くときに旧エンジン（Photo Bench）の settings を見ない・変換しない
describe("resolveDevelopOpenSettings", () => {
  it("保存してある developSettings で開き、base未保存の作業コピーは取得した版で初期化する", () => {
    const direct = resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(SAVED_DEVELOP), baseVersion: null });
    expect(direct).toEqual({ kind: "settings", baseSettings: SAVED_DEVELOP.developSettings, settingsSource: "develop" });

    const working = resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(SAVED_DEVELOP), baseVersion: "raw-b1" });
    expect(working).toMatchObject({ kind: "settings", baseSettings: { base: "raw-b1", exposure: 0.5 }, settingsSource: "develop" });
  });

  it("保存済みのnonempty baseと異なるartifactはbaseMismatchで開かず、同じbaseは保つ", () => {
    const savedBase = "raw-apple.d8.p2.e1.cal-old";
    const saved = { ...SAVED_DEVELOP, developSettings: { ...SAVED_DEVELOP.developSettings, base: savedBase } };
    expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(saved), baseVersion: "raw-apple.d8.p2.e1.cal-new" })).toEqual({
      kind: "baseMismatch",
    });
    expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(saved), baseVersion: savedBase })).toMatchObject({
      kind: "settings",
      baseSettings: { base: savedBase, exposure: 0.5 },
    });
  });

  it("signed RAWはbase・metadata・niho-3/standard-2がそろったときだけ開く", () => {
    const base = "raw-apple.d8.p3.e4.cal-signed";
    const meta = { kind: "raw", encoding: { kind: "signed-gamma18-v1", ceiling: 2 } };
    const signed = {
      ...SAVED_DEVELOP,
      developSettings: { v: 1, engine: "niho-3", look: "niho-standard-2", base, colorNoiseReduction: 31 } as DevelopSettings,
    };
    expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(signed), baseVersion: base, workMeta: meta })).toMatchObject({
      kind: "settings",
      baseSettings: { engine: "niho-3", look: "niho-standard-2", base, colorNoiseReduction: 31 },
    });
    expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(signed), baseVersion: base })).toEqual({ kind: "baseMismatch" });
  });

  it("対応校正signed RAWの未保存設定はniho-11/standard-5で開き、保存済みniho-4/niho-7は昇格させない", () => {
    const base = "raw-apple.d8.p3.e4.cal-sony-ilme-fx30-apple-v4.lens-apple";
    const workMeta = {
      kind: "raw",
      encoding: { kind: "signed-gamma18-v1", ceiling: 2 },
      dcpSha256: "apple-ciraw8/linear-prophoto-d50/cal-sony-ilme-fx30-apple-v4",
    };
    expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(), baseVersion: base, workMeta })).toMatchObject({
      kind: "settings",
      baseSettings: { engine: "niho-11", look: "niho-standard-5", base },
      settingsSource: "none",
    });
    const saved = {
      ...SAVED_DEVELOP,
      developSettings: { v: 1, engine: "niho-4", look: "niho-standard-3", base, exposure: 0.4 } as DevelopSettings,
    };
    expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(saved), baseVersion: base, workMeta })).toMatchObject({
      kind: "settings",
      baseSettings: { engine: "niho-4", look: "niho-standard-3", exposure: 0.4 },
    });
    const saved7 = {
      ...saved,
      developSettings: { ...saved.developSettings, engine: "niho-7", look: "niho-standard-5" } as DevelopSettings,
    };
    expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(saved7), baseVersion: base, workMeta })).toMatchObject({
      kind: "settings",
      baseSettings: { engine: "niho-7", look: "niho-standard-5", exposure: 0.4 },
    });
  });

  it("補正を保存したことが無い写真は補正なしで開く（オリジナルから直接描く写真は土台なし、作業コピーの上ではその版の neutral）", () => {
    expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(), baseVersion: null })).toEqual({
      kind: "settings",
      baseSettings: null,
      settingsSource: "none",
    });
    expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(), baseVersion: "raw-b1" })).toMatchObject({
      kind: "settings",
      baseSettings: { v: 1, base: "raw-b1", exposure: 0 },
      settingsSource: "none",
    });
  });

  it("未保存の raster・unsigned RAW の作業コピーは niho-14 で開き、保存済みの niho-2 / niho-10 / niho-12 / niho-13 は昇格させない（#89・#27・#29）", () => {
    const legacyRaw = "raw-apple.d8.p1.e1.cal-none";
    const raster = "raster.ci2.p2.e2.icc-srgb";
    for (const [baseVersion, workMeta] of [
      [legacyRaw, { kind: "raw" }],
      [raster, { kind: "raster", encoding: "jpeg8" }],
    ] as const) {
      expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(), baseVersion, workMeta })).toMatchObject({
        kind: "settings",
        baseSettings: { engine: "niho-14", look: "niho-standard-1", base: baseVersion },
        settingsSource: "none",
      });
    }
    const saved = (engine: string, base: string) => ({
      ...SAVED_DEVELOP,
      developSettings: { v: 1, engine, look: "niho-standard-1", base } as DevelopSettings,
    });
    expect(
      resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(saved("niho-2", legacyRaw)), baseVersion: legacyRaw, workMeta: { kind: "raw" } }),
    ).toMatchObject({ kind: "settings", baseSettings: { engine: "niho-2", base: legacyRaw } });
    expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(saved("niho-10", raster)), baseVersion: raster })).toMatchObject({
      kind: "settings",
      baseSettings: { engine: "niho-10", base: raster },
    });
    for (const engine of ["niho-12", "niho-13", "niho-14"]) {
      expect(
        resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(saved(engine, legacyRaw)), baseVersion: legacyRaw, workMeta: { kind: "raw" } }),
      ).toMatchObject({ kind: "settings", baseSettings: { engine, base: legacyRaw }, settingsSource: "develop" });
      expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(saved(engine, raster)), baseVersion: raster })).toMatchObject({
        kind: "settings",
        baseSettings: { engine, base: raster },
        settingsSource: "develop",
      });
    }
  });

  it("古い API が返す旧エンジンの settings の項目（新しい日時）が行にあっても見ない（developSettings だけで決める）", () => {
    const legacyFields = { hasSettings: true, settingsUpdatedAt: "2026-09-29T00:00:00.000Z" } as Partial<PhotoLibraryPhoto>;
    expect(
      resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto({ ...SAVED_DEVELOP, ...legacyFields }), baseVersion: null }),
    ).toEqual({ kind: "settings", baseSettings: SAVED_DEVELOP.developSettings, settingsSource: "develop" });
    expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(legacyFields), baseVersion: null })).toEqual({
      kind: "settings",
      baseSettings: null,
      settingsSource: "none",
    });
  });

  it("新しい版の NIHO・読めない形の版は newer、E1b の v3 効果設定はそのまま開く", () => {
    expect(
      resolveDevelopOpenSettings({
        cloudPhoto: cloudPhoto({ ...SAVED_DEVELOP, developSettings: { v: 1, engine: "niho-3" } }),
        baseVersion: null,
      }),
    ).toEqual({ kind: "newer" });
    expect(
      resolveDevelopOpenSettings({
        cloudPhoto: cloudPhoto({ ...SAVED_DEVELOP, developSettings: { v: 10, engine: "niho-1" } as unknown as DevelopSettings }),
        baseVersion: null,
      }),
    ).toEqual({ kind: "newer" });
    const effects = { v: 3, engine: "niho-1", grayscale: true } as DevelopSettings;
    expect(resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto({ ...SAVED_DEVELOP, developSettings: effects }), baseVersion: null })).toEqual({
      kind: "settings",
      baseSettings: effects,
      settingsSource: "develop",
    });
  });

  it("v5 は部分補正（マスク）を読めるので開く。形の壊れたマスク・v5 未満のマスクは newer（閲覧だけ）", () => {
    const mask = { id: "m1", kind: "linear", zero: { x: 0.5, y: 0.2 }, full: { x: 0.5, y: 0.5 }, adjust: { exposure: -0.7 } };
    const open = (developSettings: unknown) =>
      resolveDevelopOpenSettings({
        cloudPhoto: cloudPhoto({ ...SAVED_DEVELOP, developSettings: developSettings as DevelopSettings }),
        baseVersion: null,
      });
    const saved = { v: 5, engine: "niho-10", look: "niho-standard-1", base: null, masks: [mask] };
    expect(open(saved)).toEqual({ kind: "settings", baseSettings: saved, settingsSource: "develop" });
    expect(open({ v: 5, engine: "niho-10", look: "niho-standard-1", base: null })).toMatchObject({ kind: "settings" });
    expect(open({ ...saved, v: 4 })).toEqual({ kind: "newer" });
    expect(open({ ...saved, masks: [{ ...mask, opacity: 1 }] })).toEqual({ kind: "newer" });
    expect(open({ ...saved, v: 10 })).toEqual({ kind: "newer" });
  });

  it("切り抜き・回転のある developSettings（v2）は、幾何を扱える面では開き、扱えない面（NIHO Desktop）では newer（#17138）", () => {
    const cropped = {
      ...SAVED_DEVELOP,
      developSettings: {
        v: 2,
        engine: "niho-1",
        look: "niho-interim-1",
        base: null,
        exposure: 0.5,
        geometry: { rotate: 90, crop: { left: 0.1, top: 0, right: 0.9, bottom: 1 } },
      } as DevelopSettings,
    };
    const browser = resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(cropped), baseVersion: "raw-b1" });
    expect(browser).toMatchObject({
      kind: "settings",
      baseSettings: { v: 2, base: "raw-b1", geometry: cropped.developSettings.geometry },
    });
    const desktop = resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(cropped), baseVersion: "raw-b1", geometry: false });
    expect(desktop).toEqual({ kind: "newer" });
    // 幾何の無い写真は、扱えない面でもそのまま開く
    const plain = resolveDevelopOpenSettings({ cloudPhoto: cloudPhoto(SAVED_DEVELOP), baseVersion: null, geometry: false });
    expect(plain).toMatchObject({ kind: "settings", settingsSource: "develop" });
  });
});

// この Mac の補正（Photo Bench の形）をクラウドの developSettings へ保存するときの変換（NIHO Desktop の面。読む側では使わない）
describe("convertEditSettingsToDevelop", () => {
  it("写せた・写せない項目がある・wasm が変換できなかったを分ける（作業コピーの版を渡す）", async () => {
    const converted = { v: 1, engine: "niho-1", look: "niho-interim-1", base: null, exposure: -1 } as DevelopSettings;
    const engine = engineWith(async () => ({ ok: true, settings: converted, issues: [] }));
    expect(await convertEditSettingsToDevelop(engine, { exposure: -1 }, null)).toEqual({ kind: "converted", settings: converted });
    expect(engine.convertEditSettings).toHaveBeenLastCalledWith({ exposure: -1 });
    await convertEditSettingsToDevelop(engine, { exposure: -1 }, "raw-b1");
    expect(engine.convertEditSettings).toHaveBeenLastCalledWith({ exposure: -1 }, { baseVersion: "raw-b1" });
    expect(
      await convertEditSettingsToDevelop(
        engineWith(async () => ({ ok: false, settings: { ...converted, legacySettings: { x: 1 } }, issues: [] })),
        { exposure: -1, x: 1 },
        null,
      ),
    ).toEqual({ kind: "unconvertible" });
    expect(
      await convertEditSettingsToDevelop(engineWith(async () => ({ ok: false, settings: null, issues: [] })), {}, null),
    ).toEqual({ kind: "failed" });
  });
});
