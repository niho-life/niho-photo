import { describe, expect, it } from "vitest";

import type { PhotoLibraryNativeRenderer } from "./library/photo-library";
import {
  hasPhotoEditingNativeExportUnsupportedSettings,
  photoEditingNativeExportBlockers,
  photoEditingNativeExportUnsupportedFailedText,
  photoEditingNativeExportUnsupportedText,
  readPhotoLibraryNativeRenderer,
} from "./photo-editing-native-export";

const HEAL = [{ id: "a", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.5, 0.5]] }];
const MASK = { id: "m1", kind: "linear", zero: { x: 0.5, y: 0.2 }, full: { x: 0.5, y: 0.5 }, adjust: { exposure: -0.7 } };

/** `niho-develop-render capabilities`（0.26.0 の main の同梱と同じ中身）。`versions` は読める `v`。 */
function renderer(
  versions: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9],
  features: readonly string[] = ["colorGradingLuminance"],
): PhotoLibraryNativeRenderer {
  return {
    settingsVersions: versions,
    engines: ["niho-1", "niho-2", "niho-6", "niho-10", "niho-12", "niho-13", "niho-14"],
    features,
    maskKinds: ["linear", "radial", "brush", "subject", "sky"],
    maxPixels: 40_000_000,
  };
}

/** 遠近・修復・レンズ・輝度のグレーディングを全部使う設定（v9）。 */
const ALL_FOUR = {
  v: 9,
  engine: "niho-14",
  lens: { distortion: 5 },
  heal: HEAL,
  geometry: { perspective: { x: 3 } },
  colorGrading: { global: { luminance: 5 } },
};

describe("原寸の native renderer が描けない補正の判定", () => {
  it("補正が無い・描ける補正だけなら理由は無い", () => {
    expect(photoEditingNativeExportBlockers({})).toEqual([]);
    expect(photoEditingNativeExportBlockers({ exposure: 1, colorGrading: { shadow: { luminance: 20 } } })).toEqual([]);
    expect(hasPhotoEditingNativeExportUnsupportedSettings({ geometry: { angle: 3, crop: { left: 0.1, top: 0, right: 1, bottom: 1 } } })).toBe(
      false,
    );
  });

  it("中間調・全体の輝度・遠近・修復の印・画を変えるレンズ補正を、固定の順で返す", () => {
    expect(photoEditingNativeExportBlockers({ colorGrading: { midtone: { luminance: 1 } } })).toEqual(["colorGradingLuminance"]);
    expect(photoEditingNativeExportBlockers({ geometry: { perspective: { rotate: 1 } } })).toEqual(["perspective"]);
    expect(photoEditingNativeExportBlockers({ heal: HEAL })).toEqual(["heal"]);
    expect(photoEditingNativeExportBlockers({ lens: { vignetting: -10 } })).toEqual(["lens"]);
    expect(
      photoEditingNativeExportBlockers({
        lens: { distortion: 5 },
        heal: HEAL,
        geometry: { perspective: { x: 3 } },
        colorGrading: { global: { luminance: 5 } },
      }),
    ).toEqual(["colorGradingLuminance", "perspective", "heal", "lens"]);
  });

  it("恒等の遠近・空の修復・中点と色相の範囲だけのレンズ・余白を埋める / Upright だけは理由にしない", () => {
    expect(photoEditingNativeExportBlockers({ geometry: { perspective: { vertical: 0, scale: 100 }, constrain: true, upright: 2 } })).toEqual([]);
    expect(photoEditingNativeExportBlockers({ heal: [] })).toEqual([]);
    expect(photoEditingNativeExportBlockers({ lens: { vignettingMidpoint: 20, defringe: { purple: { hueLo: 20, hueHi: 80 } } } })).toEqual([]);
  });

  it("形の壊れた修復・遠近・レンズは、描けない設定として理由にする", () => {
    expect(photoEditingNativeExportBlockers({ heal: "x" })).toEqual(["heal"]);
    expect(photoEditingNativeExportBlockers({ geometry: { perspective: "x" } })).toEqual(["perspective"]);
    expect(photoEditingNativeExportBlockers({ lens: "x" })).toEqual(["lens"]);
  });

  it("描ける設定を答える描画には、読める版・描く輝度なら 4 つとも渡す", () => {
    expect(photoEditingNativeExportBlockers(ALL_FOUR, renderer())).toEqual([]);
    expect(photoEditingNativeExportBlockers({ v: 7, engine: "niho-14", geometry: { perspective: { rotate: 1 } } }, renderer())).toEqual(
      [],
    );
    expect(photoEditingNativeExportBlockers({ v: 8, engine: "niho-13", heal: HEAL }, renderer())).toEqual([]);
    expect(photoEditingNativeExportBlockers({ v: 9, engine: "niho-12", lens: { vignetting: -10 } }, renderer())).toEqual([]);
    expect(
      photoEditingNativeExportBlockers({ v: 1, engine: "niho-10", colorGrading: { midtone: { luminance: 1 } } }, renderer()),
    ).toEqual([]);
    expect(hasPhotoEditingNativeExportUnsupportedSettings(ALL_FOUR, renderer())).toBe(false);
  });

  it("答えない古い描画（省略・null）は、今の 4 つの遮断のまま", () => {
    for (const old of [undefined, null]) {
      expect(photoEditingNativeExportBlockers(ALL_FOUR, old)).toEqual(["colorGradingLuminance", "perspective", "heal", "lens"]);
      expect(photoEditingNativeExportBlockers({ v: 5, engine: "niho-99", masks: [MASK] }, old)).toEqual([]);
    }
  });

  it("答えた描画が読めない版・描かない輝度は、その補正の名前で塞ぐ", () => {
    expect(photoEditingNativeExportBlockers(ALL_FOUR, renderer([1, 2, 3, 4, 5, 6, 7]))).toEqual(["heal", "lens"]);
    expect(photoEditingNativeExportBlockers(ALL_FOUR, renderer([1, 2, 3, 4, 5, 6, 7, 8, 9], []))).toEqual(["colorGradingLuminance"]);
    expect(photoEditingNativeExportBlockers(ALL_FOUR, renderer([1, 2, 3, 4, 5, 6], []))).toEqual([
      "colorGradingLuminance",
      "perspective",
      "heal",
      "lens",
    ]);
  });

  it("4 つのほかに読めない設定（版・中身に要る版・engine）は「新しい補正」で塞ぐ", () => {
    // 書いてある版を読めない（未来の v10）
    expect(photoEditingNativeExportBlockers({ v: 10, engine: "niho-14" }, renderer())).toEqual(["settings"]);
    // 書いてある版は読めるが、中身（マスク）に要る v5 を読めない
    expect(photoEditingNativeExportBlockers({ v: 1, engine: "niho-14", masks: [MASK] }, renderer([1, 2, 3, 4]))).toEqual(["settings"]);
    expect(photoEditingNativeExportBlockers({ v: 5, engine: "niho-14", masks: [MASK] }, renderer([1, 2, 3, 4]))).toEqual(["settings"]);
    // 描かない engine（未来の niho-15）
    expect(photoEditingNativeExportBlockers({ v: 1, engine: "niho-15" }, renderer())).toEqual(["settings"]);
    // 4 つの理由があれば、そちらだけを出す
    expect(photoEditingNativeExportBlockers({ ...ALL_FOUR, engine: "niho-15" }, renderer([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual(["lens"]);
    // `v`・`engine` の無い設定は中身の版だけで決める
    expect(photoEditingNativeExportBlockers({ exposure: 1 }, renderer([1]))).toEqual([]);
  });

  it("host の渡した描画の能力は、形が合うときだけ読む", () => {
    const answered = renderer();
    expect(readPhotoLibraryNativeRenderer(answered)).toEqual(answered);
    expect(Object.isFrozen(readPhotoLibraryNativeRenderer(answered))).toBe(true);
    for (const broken of [
      null,
      undefined,
      "x",
      [],
      { ...answered, settingsVersions: [] },
      { ...answered, settingsVersions: [1, "2"] },
      { ...answered, settingsVersions: [0] },
      { ...answered, settingsVersions: [1.5] },
      { ...answered, engines: [] },
      { ...answered, engines: ["niho-1", ""] },
      { ...answered, features: "colorGradingLuminance" },
      { ...answered, maskKinds: undefined },
      { ...answered, maxPixels: 0 },
      { ...answered, maxPixels: Number.POSITIVE_INFINITY },
      { ...answered, engines: Array.from({ length: 65 }, (_, index) => `niho-${index}`) },
    ]) {
      expect(readPhotoLibraryNativeRenderer(broken)).toBeUndefined();
    }
  });

  it("写真の置き場があれば、描画を新しくする行き先を足す", () => {
    expect(photoEditingNativeExportUnsupportedText(["perspective", "heal"], "local")).toBe(
      "原寸は遠近、修復に未対応です。NIHO photo を更新すると書き出せます",
    );
    expect(photoEditingNativeExportUnsupportedText(["colorGradingLuminance"], "cloud")).toBe(
      "原寸は中間調・全体の輝度に未対応です。NIHO Desktop を更新すると書き出せます",
    );
    expect(photoEditingNativeExportUnsupportedText(["settings"], "local")).toBe(
      "原寸は新しい補正に未対応です。NIHO photo を更新すると書き出せます",
    );
    expect(photoEditingNativeExportUnsupportedFailedText(["lens"], "local")).toBe(
      "レンズ補正を使っている写真は、原寸で書き出せません。この Mac の NIHO photo を更新すると、原寸で書き出せます。",
    );
    expect(photoEditingNativeExportUnsupportedFailedText(["heal"], "cloud")).toBe(
      "修復を使っている写真は、原寸で書き出せません。NIHO Desktop を更新すると、原寸で書き出せます。",
    );
  });

  it("文は、輝度だけ（または理由が無い）なら従来のまま、それ以外は名前を並べる", () => {
    expect(photoEditingNativeExportUnsupportedText([])).toBe("原寸は中間調・全体の輝度に未対応です");
    expect(photoEditingNativeExportUnsupportedText(["colorGradingLuminance"])).toBe("原寸は中間調・全体の輝度に未対応です");
    expect(photoEditingNativeExportUnsupportedText(["perspective"])).toBe("原寸は遠近に未対応です");
    expect(photoEditingNativeExportUnsupportedText(["perspective", "heal", "lens"])).toBe("原寸は遠近、修復、レンズ補正に未対応です");
    expect(photoEditingNativeExportUnsupportedFailedText([])).toBe("中間調・全体の輝度を使っている写真は、原寸で書き出せません。");
    expect(photoEditingNativeExportUnsupportedFailedText(["heal"])).toBe("修復を使っている写真は、原寸で書き出せません。");
    expect(photoEditingNativeExportUnsupportedFailedText(["colorGradingLuminance", "lens"])).toBe(
      "中間調・全体の輝度、レンズ補正を使っている写真は、原寸で書き出せません。",
    );
  });
});
