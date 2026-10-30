import { describe, expect, it } from "vitest";

import {
  analysisAheadMemoryBytes,
  analysisHelperMemoryBytes,
  DEVELOP_MEMORY_BUDGET,
  developerMemoryBytes,
  developExportMemoryBytes,
  developRenderLoadFromJson,
  developRenderMemoryBytes,
  fittedSize,
  thumbnailSessionMemoryBytes,
  type DevelopRenderLoad,
} from "./develop-engine-memory-budget";

/**
 * 物理メモリの予算（#155）の見積もり: 係数は実測（2560×1707 の signed RAW の作業コピー・6000×4000 の JPEG。MiB の高水位）を
 * 下回らず、端末ごとの予算は実測の保ち方を収める。
 */

const MIB = 1024 * 1024;
const WORKING = { width: 2560, height: 1707 };
const JPEG = { width: 6000, height: 4000 };
const LIGHT: DevelopRenderLoad = { masks: 0, detail: false, noiseReduction: false, geometry: false, heal: false, lens: false };
/** 実測の「補正を全部使った」（マスク 3 枚・ディテール・ノイズ軽減・遠近・修復・レンズ） */
const FULL: DevelopRenderLoad = { masks: 3, detail: true, noiseReduction: true, geometry: true, heal: true, lens: true };
const HEAVIEST: DevelopRenderLoad = { masks: 8, detail: true, noiseReduction: true, geometry: true, heal: true, lens: true };

const mib = (bytes: number) => bytes / MIB;
const limitOf = (budget: { totalBytes: number; exportReserveBytes: number }) => budget.totalBytes - budget.exportReserveBytes;

describe("物理メモリの予算の見積もり（#155）", () => {
  it("写真・先回りの解析・見本の係数は、2560×1707 の実測を下回らない", () => {
    expect(developerMemoryBytes(WORKING.width, WORKING.height)).toBe(36 * 2560 * 1707);
    expect(mib(developerMemoryBytes(WORKING.width, WORKING.height))).toBeGreaterThanOrEqual(148);
    expect(mib(analysisAheadMemoryBytes(WORKING.width, WORKING.height))).toBeGreaterThanOrEqual(156);
    expect(mib(thumbnailSessionMemoryBytes(WORKING.width, WORKING.height))).toBeGreaterThanOrEqual(263);
    expect(mib(analysisHelperMemoryBytes(WORKING.width, WORKING.height))).toBeGreaterThanOrEqual(198);
    // 寸法が 0・負なら 0（壊れた寸法で予算を食わない）
    expect(developerMemoryBytes(0, 1707)).toBe(0);
    expect(thumbnailSessionMemoryBytes(-1, 1707)).toBe(0);
  });

  it("書き出しの見積もりは実測（作業コピー 2048 / 2560・JPEG 4096）を下回らず、作業コピーだけ開いて持つ分を足す", () => {
    const workingCopy = { ...WORKING, workingCopy: true };
    const jpeg = { ...JPEG, workingCopy: false };
    expect(mib(developExportMemoryBytes(LIGHT, workingCopy, 2048))).toBeGreaterThanOrEqual(180);
    expect(mib(developExportMemoryBytes(FULL, workingCopy, 2560))).toBeGreaterThanOrEqual(804);
    expect(mib(developExportMemoryBytes(LIGHT, jpeg, 4096))).toBeGreaterThanOrEqual(209);
    expect(mib(developExportMemoryBytes(FULL, jpeg, 4096))).toBeGreaterThanOrEqual(1616);

    expect(developExportMemoryBytes(LIGHT, workingCopy, 2048)).toBe(
      developerMemoryBytes(WORKING.width, WORKING.height) + developRenderMemoryBytes(LIGHT, fittedSize(2560, 1707, 2048)),
    );
    expect(developExportMemoryBytes(LIGHT, jpeg, 4096)).toBe(developRenderMemoryBytes(LIGHT, fittedSize(6000, 4000, 4096)));
    // マスクは 8 枚までしか数えない
    expect(developRenderMemoryBytes({ ...HEAVIEST, masks: 20 }, WORKING)).toBe(developRenderMemoryBytes(HEAVIEST, WORKING));
  });

  it("fittedSize は長辺を収め、拡大しない（0 は元の大きさ）", () => {
    expect(fittedSize(6000, 4000, 4096)).toEqual({ width: 4096, height: 2731 });
    expect(fittedSize(1707, 2560, 2048)).toEqual({ width: 1366, height: 2048 });
    expect(fittedSize(2560, 1707, 4096)).toEqual({ width: 2560, height: 1707 });
    expect(fittedSize(2560, 1707, 0)).toEqual({ width: 2560, height: 1707 });
    expect(fittedSize(10000, 1, 100)).toEqual({ width: 100, height: 1 });
  });

  it("設定の JSON から描画の重さを読み、壊れた JSON・オブジェクトでない JSON は全部入りにする", () => {
    for (const broken of ["", "{", "null", "1", '"settings"', "true"]) {
      expect(developRenderLoadFromJson(broken)).toEqual(HEAVIEST);
    }
    expect(developRenderLoadFromJson("{}")).toEqual(LIGHT);
    expect(developRenderLoadFromJson('{"v":9,"engine":"niho-11","exposure":0.3,"colorNoiseReduction":0}')).toEqual(LIGHT);
    expect(
      developRenderLoadFromJson(
        JSON.stringify({
          masks: Array.from({ length: 12 }, () => ({})),
          detail: { sharpening: 40, luminanceNoiseReduction: 0, colorNoiseReduction: 0 },
          geometry: { crop: { left: 0, top: 0, right: 1, bottom: 1 } },
          heal: [{}],
          lens: {},
        }),
      ),
    ).toEqual({ masks: 8, detail: true, noiseReduction: false, geometry: true, heal: true, lens: true });
    // ノイズ軽減は旧 CNR・ディテールの輝度 / カラーのどれかが効けば数える（数でなければ効く側に倒す）
    expect(developRenderLoadFromJson('{"colorNoiseReduction":25}').noiseReduction).toBe(true);
    expect(developRenderLoadFromJson('{"detail":{"luminanceNoiseReduction":30}}').noiseReduction).toBe(true);
    expect(developRenderLoadFromJson('{"detail":{"colorNoiseReduction":"25"}}').noiseReduction).toBe(true);
    expect(developRenderLoadFromJson('{"heal":[]}').heal).toBe(false);
    expect(developRenderLoadFromJson('{"heal":{}}').heal).toBe(true);
  });

  it("予算の上限は実測の保ち方を収める（PC: 688MiB + 解析 32MiB、スマホ: 521MiB + 16MiB）", () => {
    const { pc, mobile } = DEVELOP_MEMORY_BUDGET;
    expect(limitOf(pc)).toBeGreaterThanOrEqual((688 + 32) * MIB);
    expect(limitOf(mobile)).toBeGreaterThanOrEqual((521 + 16) * MIB);
    // PC の補助の worker（198MiB）も、今の保ち方と合わせて totalBytes に収まる
    expect(pc.totalBytes).toBeGreaterThanOrEqual((688 + 32 + 198) * MIB);
    expect(pc).toMatchObject({ heldPhotos: 2, overflow: "worker" });
    expect(mobile).toMatchObject({ heldPhotos: 1, overflow: "inPlace" });
  });

  it("PC の見積もりでも、2 枚・先回り・見本・解析の bytes を手放さずに持てる", () => {
    const { width, height } = WORKING;
    const held =
      2 * developerMemoryBytes(width, height) +
      analysisAheadMemoryBytes(width, height) +
      thumbnailSessionMemoryBytes(width, height) +
      32 * MIB;
    expect(held).toBeLessThanOrEqual(limitOf(DEVELOP_MEMORY_BUDGET.pc));
    // 補助の worker は持つ物の上限ではなく totalBytes で見る（動いている間も、先回りの取り込みを見送らない）
    expect(held + analysisHelperMemoryBytes(width, height)).toBeLessThanOrEqual(DEVELOP_MEMORY_BUDGET.pc.totalBytes);
  });
});
