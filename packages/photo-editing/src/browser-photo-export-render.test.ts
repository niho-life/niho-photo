import { afterEach, describe, expect, it, vi } from "vitest";

import { renderBrowserPhotoExportJpeg } from "./browser-photo-export-render";
import type { DevelopEngine } from "./develop-engine/develop-engine-client";
import { neutralDevelopSettings } from "./develop-engine/develop-settings";
import type { DevelopRenderInput } from "./develop-engine/develop-render-input";
import { copyDevelopInput, rebindDevelopSettings } from "./editor/browser-photo-editing-model";

/** SOF0 に高さ・幅を書いた最小の JPEG（SOI・SOF0・EOI）。 */
function jpegWithSize(width: number, height: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
}

/** EXIF を付けた印（SOI の後ろに小さな APP1 を足す）。 */
const APP1 = [0xff, 0xe1, 0x00, 0x04, 0x45, 0x78];
function withExifMark(jpeg: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const marked = new Uint8Array(jpeg.byteLength + APP1.length);
  marked.set(jpeg.subarray(0, 2), 0);
  marked.set(APP1, 2);
  marked.set(jpeg.subarray(2), 2 + APP1.length);
  return marked;
}

/** EXIF（APP1）を付けたか */
function hasExif(jpeg: Uint8Array): boolean {
  return jpeg[2] === 0xff && jpeg[3] === 0xe1;
}

/**
 * 段 2 の wasm の代わり。元の寸法は `source`、長辺 2048px で描いたときの出力は `frame`。`exportJpeg` は `frame` を
 * `maxDimension` に縮めた寸法（拡大しない。crate の `fitted_size` と同じ式）の JPEG を返す。
 */
function fakeEngine(options: { source?: { width: number; height: number }; frame?: { width: number; height: number } } = {}) {
  const source = options.source ?? { width: 4000, height: 5000 };
  const frame = options.frame ?? { width: 1638, height: 2048 };
  const fitted = (maxDimension: number) => {
    const full = { width: source.width, height: source.height };
    const long = Math.max(full.width, full.height);
    if (long <= maxDimension) return full;
    const scale = maxDimension / long;
    return {
      width: full.width >= full.height ? maxDimension : Math.max(1, Math.round(full.width * scale)),
      height: full.height > full.width ? maxDimension : Math.max(1, Math.round(full.height * scale)),
    };
  };
  const jpegAt = (maxDimension: number) => {
    const size = fitted(maxDimension);
    return jpegWithSize(size.width, size.height);
  };
  const engine: DevelopEngine = {
    ready: vi.fn(async () => true),
    open: vi.fn(async () => ({ width: 1, height: 1 })),
    render: vi.fn(async () => null),
    sampleColor: vi.fn(async () => ({ lightness: 0.7, chroma: 0.1, hue: 50 })),
    exportJpeg: vi.fn(async (_bytes: ArrayBuffer, _settings: object, exportOptions: { maxDimension: number; quality: number }) =>
      jpegAt(exportOptions.maxDimension),
    ),
    openWorkingCopy: vi.fn(async () => ({ width: 2560, height: 1707 })),
    exportWorkingCopyJpeg: vi.fn(
      async (_png: ArrayBuffer, _metaJson: string, _settings: object, exportOptions: { maxDimension: number; quality: number }) =>
        jpegAt(exportOptions.maxDimension),
    ),
    convertEditSettings: vi.fn(async () => ({ ok: false, settings: null, issues: [] })),
    presetSettings: vi.fn(async () => ({ name: "", settings: neutralDevelopSettings(), converted: true, unsupported: [] })),
    builtinPresets: vi.fn(async () => []),
    // F2a の追加口（この export test では使わない）
    applyPreset: vi.fn(async () => ({ name: "", settings: neutralDevelopSettings(), converted: true, unsupported: [] })),
    settingsToXmp: vi.fn(async () => ({ xmp: "<x:xmpmeta/>", notWritten: [] })),
    renderPresetThumbnail: vi.fn(async () => null),
    yieldToEdit: vi.fn(),
    supportsPresetAmount: vi.fn(async () => false),
    supportsSettingsToXmp: vi.fn(async () => false),
    supportsPresetThumbnails: vi.fn(async () => false),
    supportsPresetFromMeta: vi.fn(async () => false),
    autoSettings: vi.fn(async () => neutralDevelopSettings()),
    supportsAuto: vi.fn(async () => false),
    supportsGeometry: vi.fn(async () => true),
    supportsEffects: vi.fn(async () => true),
    supportsColorPoints: vi.fn(async () => true),
    supportsDetail: vi.fn(async () => true),
    supportsPerspective: vi.fn(async () => true),
    // Upright（niho-photo#46 後半。この export test では使わない）
    supportsUpright: vi.fn(async () => false),
    // 修復（niho-photo#44。印は描画の設定の一部）
    supportsHeal: vi.fn(async () => true),
    supportsLens: vi.fn(async () => true),
    estimateUpright: vi.fn(async () => {
      throw new Error("not used by exports");
    }),
    imageSize: vi.fn(async () => source),
    rasterDecodeSize: vi.fn(async () => 2048),
    geometryOutputSize: vi.fn(async () => frame),
    withCaptureExif: vi.fn(async (jpeg: Uint8Array<ArrayBuffer>) => withExifMark(jpeg)),
    close: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  return engine;
}

const SETTINGS = { ...neutralDevelopSettings(), exposure: 0.5 };
const CAPTURED_AT = "2026-09-17T02:12:59.000Z";

function originalInput(): DevelopRenderInput {
  return { kind: "original", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderBrowserPhotoExportJpeg（F7b #17127）", () => {
  it("provisional入力を書き出しへ渡さず、canonicalへのrebindで利用者の補正値を保つ", async () => {
    await expect(
      copyDevelopInput({
        kind: "provisional",
        file: {} as File,
        contentSha256: "a".repeat(64),
        width: 1600,
        height: 1067,
      }),
    ).rejects.toThrow("provisional input cannot be exported");
    expect(
      rebindDevelopSettings(
        { v: 2, engine: "niho-6", look: "niho-standard-1", base: null, exposure: 0.7, geometry: { rotate: 90 } },
        { v: 1, engine: "niho-7", look: "niho-standard-5", base: "raw-apple.d8.p3.e4.cal-test" },
      ),
    ).toEqual({
      v: 2,
      engine: "niho-7",
      look: "niho-standard-5",
      base: "raw-apple.d8.p3.e4.cal-test",
      exposure: 0.7,
      geometry: { rotate: 90 },
    });
  });

  it("幅 1080px: 元の寸法 → 長辺 2048px の出力の寸法 → 幅が 1080 になる長辺で描き（4:5 の縦は 1080×1350）、撮影日時を +09:00 で付ける", async () => {
    const engine = fakeEngine();
    const input = originalInput();

    const result = await renderBrowserPhotoExportJpeg({ engine, input, settings: SETTINGS, size: "width1080", capturedAt: CAPTURED_AT });

    expect(engine.imageSize).toHaveBeenCalledWith(input.bytes);
    expect(engine.geometryOutputSize).toHaveBeenCalledWith(SETTINGS, { width: 4000, height: 5000 }, 2048);
    expect(engine.exportJpeg).toHaveBeenCalledWith(input.bytes, SETTINGS, { maxDimension: 1350, quality: 90 });
    expect(engine.withCaptureExif).toHaveBeenCalledWith(expect.any(Uint8Array), CAPTURED_AT, 540);
    expect(result).toMatchObject({ width: 1080, height: 1350, reachedWidth: true });
    expect(hasExif(result.bytes)).toBe(true);
  });

  it("「大きく」は寸法を読まずに長辺 4096 で描く（元・作業コピーの大きさで頭打ち。niho-photo#134）", async () => {
    const engine = fakeEngine({ source: { width: 6000, height: 4000 }, frame: { width: 4096, height: 2731 } });
    const result = await renderBrowserPhotoExportJpeg({
      engine,
      input: originalInput(),
      settings: SETTINGS,
      size: "large",
      capturedAt: null,
    });
    expect(engine.imageSize).not.toHaveBeenCalled();
    expect(engine.geometryOutputSize).not.toHaveBeenCalled();
    expect(engine.exportJpeg).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), SETTINGS, { maxDimension: 4096, quality: 90 });
    expect(result.reachedWidth).toBe(true);
  });

  it("長辺 2048px は寸法を読まずに 2048 で描く。横長の幅 1080px は長辺 1080", async () => {
    const landscape = fakeEngine({ source: { width: 6000, height: 4000 }, frame: { width: 2048, height: 1365 } });
    const standard = await renderBrowserPhotoExportJpeg({
      engine: landscape,
      input: originalInput(),
      settings: SETTINGS,
      size: "long2048",
      capturedAt: CAPTURED_AT,
    });
    expect(landscape.imageSize).not.toHaveBeenCalled();
    expect(landscape.geometryOutputSize).not.toHaveBeenCalled();
    expect(landscape.exportJpeg).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), SETTINGS, { maxDimension: 2048, quality: 90 });
    expect(standard).toMatchObject({ width: 2048, height: 1365, reachedWidth: true });

    const instagram = await renderBrowserPhotoExportJpeg({
      engine: landscape,
      input: originalInput(),
      settings: SETTINGS,
      size: "width1080",
      capturedAt: CAPTURED_AT,
    });
    expect(landscape.exportJpeg).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), SETTINGS, { maxDimension: 1080, quality: 90 });
    expect(instagram).toMatchObject({ width: 1080, height: 720, reachedWidth: true });
  });

  it("作業コピー（16bit PNG）は作業コピーの寸法で決め、exportWorkingCopyJpeg で描く", async () => {
    const engine = fakeEngine({ source: { width: 1707, height: 2560 }, frame: { width: 1365, height: 2048 } });
    const input: DevelopRenderInput = {
      kind: "workingCopy",
      encoding: "png16",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      metaJson: '{"kind":"raw"}',
      baseVersion: "raw.v1",
    };

    const result = await renderBrowserPhotoExportJpeg({ engine, input, settings: SETTINGS, size: "width1080", capturedAt: null });

    expect(engine.imageSize).toHaveBeenCalledWith(input.bytes);
    expect(engine.exportWorkingCopyJpeg).toHaveBeenCalledWith(input.bytes, '{"kind":"raw"}', SETTINGS, {
      maxDimension: 1620,
      quality: 90,
    });
    expect(engine.exportJpeg).not.toHaveBeenCalled();
    expect(result).toMatchObject({ width: 1080, height: 1620, reachedWidth: true });
  });

  it("撮影日時が無ければ EXIF を付けない", async () => {
    const engine = fakeEngine();
    const result = await renderBrowserPhotoExportJpeg({
      engine,
      input: originalInput(),
      settings: SETTINGS,
      size: "long2048",
      capturedAt: null,
    });
    expect(engine.withCaptureExif).not.toHaveBeenCalled();
    expect(hasExif(result.bytes)).toBe(false);
  });

  it("EXIF を付けられなかったら（古い wasm など）EXIF 無しの JPEG のまま書き出す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const engine = fakeEngine();
    vi.mocked(engine.withCaptureExif).mockRejectedValueOnce(new Error("develop engine cannot write EXIF"));

    const result = await renderBrowserPhotoExportJpeg({
      engine,
      input: originalInput(),
      settings: SETTINGS,
      size: "long2048",
      capturedAt: CAPTURED_AT,
    });

    expect(result).toMatchObject({ width: 1638, height: 2048, reachedWidth: true });
    expect(hasExif(result.bytes)).toBe(false);
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("幅 1080px で写真が小さくて届かなければ reachedWidth は false（拡大しない）。縦に長すぎて長辺 2048px で頭打ちの写真は true", async () => {
    const small = fakeEngine({ source: { width: 1024, height: 768 }, frame: { width: 1024, height: 768 } });
    expect(
      await renderBrowserPhotoExportJpeg({ engine: small, input: originalInput(), settings: SETTINGS, size: "width1080", capturedAt: null }),
    ).toMatchObject({ width: 1024, height: 768, reachedWidth: false });

    const smallPortrait = fakeEngine({ source: { width: 800, height: 1000 }, frame: { width: 800, height: 1000 } });
    expect(
      await renderBrowserPhotoExportJpeg({
        engine: smallPortrait,
        input: originalInput(),
        settings: SETTINGS,
        size: "width1080",
        capturedAt: null,
      }),
    ).toMatchObject({ width: 800, height: 1000, reachedWidth: false });

    const tall = fakeEngine({ source: { width: 2000, height: 6000 }, frame: { width: 683, height: 2048 } });
    const capped = await renderBrowserPhotoExportJpeg({
      engine: tall,
      input: originalInput(),
      settings: SETTINGS,
      size: "width1080",
      capturedAt: null,
    });
    expect(tall.exportJpeg).toHaveBeenCalledWith(expect.any(ArrayBuffer), SETTINGS, { maxDimension: 2048, quality: 90 });
    expect(capped).toMatchObject({ width: 683, height: 2048, reachedWidth: true });

    // 長辺 2048px は小さい写真でも常に届いた扱い
    expect(
      await renderBrowserPhotoExportJpeg({ engine: small, input: originalInput(), settings: SETTINGS, size: "long2048", capturedAt: null }),
    ).toMatchObject({ width: 1024, reachedWidth: true });
  });
});
