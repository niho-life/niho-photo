import { describe, expect, it, vi } from "vitest";

import { DEVELOP_ENGINE_CRATE_VERSION, DEVELOP_ENGINE_VERSION, developEngineManifestPath } from "./develop-engine-manifest";
import {
  createDevelopEngineWorkerHandler,
  type DevelopEngineWorkerDeps,
  type DevelopEngineWorkerResponse,
} from "./develop-engine-worker-core";

/**
 * Worker の中の面の受け渡し（M4 #68）: 能力の `surfaces`（口が揃わない glue は面の種類を外す）、開いている写真へ渡す・手放す、見本の
 * session にもそろえる、面の PNG と id を作る、書き出しに添えた面は一時的な Developer で描く（JPEG / PNG は一発の書き出しと同じ作業
 * サイズ、作業コピーは描く前に渡す）。空の検出（niho-photo#141）は manifest のモデルを初回に読んで glue に渡し、開いている写真の
 * Developer で面を作り、PNG と id を返す。
 */

const MANIFEST_URL = `https://photo.example.test${developEngineManifestPath()}`;
const MANIFEST = {
  engine: DEVELOP_ENGINE_VERSION,
  version: DEVELOP_ENGINE_CRATE_VERSION,
  files: {
    [`niho_develop_wasm_bg-${DEVELOP_ENGINE_CRATE_VERSION}.wasm`]: { sha256: "c1", bytes: 1 },
    [`niho_develop_wasm-${DEVELOP_ENGINE_CRATE_VERSION}.js`]: { sha256: "08", bytes: 1 },
    [`niho_develop_wasm-${DEVELOP_ENGINE_CRATE_VERSION}.d.ts`]: { sha256: "88", bytes: 1 },
  },
};
/** 空の検出のモデルを持つ manifest（niho-photo#141） */
const SKY_LAYOUT = `niho_sky_model-${DEVELOP_ENGINE_CRATE_VERSION}.json`;
const SKY_WEIGHTS = `niho_sky_model-${DEVELOP_ENGINE_CRATE_VERSION}.f32`;
const SKY_MANIFEST = {
  ...MANIFEST,
  files: { ...MANIFEST.files, [SKY_LAYOUT]: { sha256: "5a", bytes: 9 }, [SKY_WEIGHTS]: { sha256: "5b", bytes: 8 } },
};
const ID = "a".repeat(64);
const CAPABILITIES = { masks: { kinds: ["linear", "radial", "brush", "subject", "sky"], max: 8, maskPlane: true, surfaces: true } };

type Posted = { message: DevelopEngineWorkerResponse; transfer: Transferable[] | undefined };

function surfaceGlue(
  options: {
    capabilities?: unknown;
    developerSurfaces?: boolean;
    encode?: boolean;
    /** `Developer.prototype.detectSky`（省略 = 口の無い glue） */
    detectSky?: (settingsJson: string, ev100?: number) => unknown;
    /** `setSkyModel` を持たない glue（`detectSky` だけある） */
    noSetSkyModel?: boolean;
  } = {},
) {
  const developers: FakeDeveloper[] = [];
  const thumbnails: FakeDeveloper[] = [];
  class FakeDeveloper {
    readonly width = 4;
    readonly height = 2;
    readonly input: Uint8Array;
    readonly workingMaxDimension: number;
    readonly surfaces = new Map<string, number[]>();
    readonly renders: string[] = [];
    readonly free = vi.fn();
    constructor(input: Uint8Array, workingMaxDimension: number) {
      this.input = input;
      this.workingMaxDimension = workingMaxDimension;
      developers.push(this);
    }
    static openWorkingCopy(this: typeof FakeDeveloper, png: Uint8Array) {
      return new this(png, 2560);
    }
    render(settingsJson: string) {
      this.renders.push(settingsJson);
      return { width: 1, height: 1, rgba: new Uint8ClampedArray([this.surfaces.size, 0, 0, 255]) };
    }
    thumbnail(maxDimension: number) {
      const session = new (this.constructor as typeof FakeDeveloper)(new Uint8Array(0), maxDimension);
      thumbnails.push(session);
      return session;
    }
    maskPlane() {
      return { width: 1, height: 1, data: new Uint8Array([255]) };
    }
  }
  class SurfaceDeveloper extends FakeDeveloper {
    setMaskSurface(id: string, png: Uint8Array) {
      if (png.length === 0) throw new Error(`maskSurfaceInvalid: surface ${id}: empty`);
      this.surfaces.set(id, [...png]);
    }
    dropMaskSurface(id: string) {
      return this.surfaces.delete(id);
    }
    exportJpeg(settingsJson: string, maxDimension: number, quality: number) {
      this.renders.push(settingsJson);
      return new Uint8Array([0xff, 0xd8, this.surfaces.size, maxDimension & 0xff, quality]);
    }
  }
  const detectSky = options.detectSky;
  class SkyDeveloper extends SurfaceDeveloper {
    detectSky(settingsJson: string, ev100?: number) {
      return detectSky!(settingsJson, ev100);
    }
  }
  const capabilities = options.capabilities ?? CAPABILITIES;
  const module = {
    default: vi.fn(async () => ({})),
    version: () => "0.19.0+test",
    render: vi.fn(),
    exportJpeg: vi.fn(() => new Uint8Array([0xff, 0xd8, 0])),
    convertEditSettings: vi.fn(),
    Developer: options.developerSurfaces === false ? FakeDeveloper : detectSky ? SkyDeveloper : SurfaceDeveloper,
    capabilities: () => JSON.stringify(capabilities),
    imageSize: vi.fn(() => ({ width: 3000, height: 2000 })),
    rasterDecodeSize: vi.fn((_settingsJson: string, _width: number, _height: number, maxDimension: number) => maxDimension * 2),
    geometryOutputSize: vi.fn(() => ({ width: 1, height: 1 })),
    beforeSettings: vi.fn(() => "{}"),
    ...(detectSky && !options.noSetSkyModel
      ? { setSkyModel: vi.fn((_layoutJson: string, _weights: Uint8Array) => '{"long":384,"inputs":"rgb"}') }
      : {}),
    ...(options.encode === false
      ? {}
      : {
          encodeMaskSurface: vi.fn((width: number, height: number, data: Uint8Array) => new Uint8Array([0x89, width, height, ...data])),
          maskSurfaceId: vi.fn(() => ID),
        }),
  };
  return { module, developers, thumbnails };
}

function setup(
  module: unknown,
  encodeJpeg?: DevelopEngineWorkerDeps["encodeJpeg"],
  options: { skyModel?: boolean; skyModelStatus?: () => number; native?: boolean } = {},
) {
  const posted: Posted[] = [];
  const deps: DevelopEngineWorkerDeps = {
    fetch: vi.fn(async (url: string) => {
      if (url.endsWith(SKY_LAYOUT)) return new Response('{"long":384}', { status: options.skyModelStatus?.() ?? 200 });
      if (url.endsWith(SKY_WEIGHTS)) return new Response(new Uint8Array([1, 2, 3, 4]), { status: options.skyModelStatus?.() ?? 200 });
      return new Response(JSON.stringify(options.skyModel === false ? MANIFEST : SKY_MANIFEST), { status: 200 });
    }),
    importModule: vi.fn(async () => module),
    post: (message, transfer) => posted.push({ message, transfer }),
    encodeJpeg,
    ...(options.native ? { createNativeGlue: () => module } : {}),
  };
  return { handler: createDevelopEngineWorkerHandler(deps), posted, deps };
}

describe("Worker の面の受け渡し", () => {
  it("口が揃っていれば masks.surfaces を付ける。揃わない glue は面の種類を描けない扱いにする", async () => {
    const ready = setup(surfaceGlue().module);
    await ready.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    expect(ready.posted[0]?.message).toMatchObject({ masks: { ...CAPABILITIES.masks } });

    for (const options of [{ developerSurfaces: false }, { encode: false }, { capabilities: { masks: { ...CAPABILITIES.masks, surfaces: false } } }]) {
      const partial = setup(surfaceGlue(options).module);
      await partial.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
      const masks = (partial.posted[0]?.message as { masks?: Record<string, unknown> }).masks;
      expect(masks).toEqual({ kinds: ["linear", "radial"], max: 8, maskPlane: true });
    }
  });

  it("開いている写真へ面を渡し・手放す。写真なし・形の違う面は error。写真を開き直すと面は無い", async () => {
    const glue = surfaceGlue();
    const { handler, posted } = setup(glue.module);
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "setMaskSurface", id: 2, surfaceId: ID, png: new Uint8Array([1, 2]).buffer });
    expect(posted.at(-1)?.message).toEqual({ type: "error", id: 2, message: "no photo is open" });
    await handler({ type: "open", id: 3, bytes: new ArrayBuffer(4), workingMaxDimension: 2560 });
    await handler({ type: "setMaskSurface", id: 4, surfaceId: ID, png: new Uint8Array([1, 2]).buffer });
    expect(posted.at(-1)?.message).toEqual({ type: "maskSurfaceSet", id: 4 });
    expect(glue.developers[0]!.surfaces.get(ID)).toEqual([1, 2]);
    await handler({ type: "setMaskSurface", id: 5, surfaceId: "b".repeat(64), png: new ArrayBuffer(0) });
    expect(posted.at(-1)?.message).toMatchObject({ type: "error", id: 5, message: expect.stringMatching(/^maskSurfaceInvalid/) });
    await handler({ type: "dropMaskSurface", id: 6, surfaceId: ID });
    expect(posted.at(-1)?.message).toEqual({ type: "maskSurfaceDropped", id: 6, dropped: true });
    await handler({ type: "dropMaskSurface", id: 7, surfaceId: ID });
    expect(posted.at(-1)?.message).toEqual({ type: "maskSurfaceDropped", id: 7, dropped: false });
  });

  it("見本の session は面を持たずに始まるので、開いている写真に渡した面をそろえてから描く（手放した面は見本からも手放す）", async () => {
    const glue = surfaceGlue();
    const { handler, posted } = setup(glue.module);
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 2560 });
    // 見本の口は `ready` の presetThumbnails（Developer.prototype.thumbnail）
    await handler({ type: "setMaskSurface", id: 3, surfaceId: ID, png: new Uint8Array([5]).buffer });
    await handler({ type: "renderPresetThumbnail", id: 4, settingsJson: "{}", maxDimension: 64 });
    expect(posted.at(-1)?.message).toMatchObject({ type: "frame", id: 4 });
    expect(glue.thumbnails[0]!.surfaces.get(ID)).toEqual([5]);
    await handler({ type: "dropMaskSurface", id: 5, surfaceId: ID });
    expect(glue.thumbnails[0]!.surfaces.has(ID)).toBe(false);
  });

  it("面の値を 8bit グレーの PNG と id にする（PNG は transfer）", async () => {
    const glue = surfaceGlue();
    const { handler, posted } = setup(glue.module);
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "encodeMaskSurface", id: 2, width: 2, height: 1, data: new Uint8Array([0, 255]).buffer });
    const last = posted.at(-1)!;
    expect(last.message).toMatchObject({ type: "maskSurfaceEncoded", id: 2, surfaceId: ID });
    const png = (last.message as { png: ArrayBuffer }).png;
    expect([...new Uint8Array(png)]).toEqual([0x89, 2, 1, 0, 255]);
    expect(last.transfer).toEqual([png]);
    expect(glue.module.encodeMaskSurface).toHaveBeenCalledWith(2, 1, new Uint8Array([0, 255]));
  });

  it("書き出しに面が添えてあれば、一発の書き出しと同じ作業サイズの一時的な Developer に渡して描く（持っている写真は変えない）", async () => {
    const glue = surfaceGlue();
    const { handler, posted } = setup(glue.module);
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 2560 });
    const opened = glue.developers[0]!;
    await handler({
      type: "exportJpeg",
      id: 3,
      bytes: new Uint8Array([1, 2, 3]).buffer,
      settingsJson: '{"v":5}',
      maxDimension: 1000,
      quality: 90,
      surfaces: [{ id: ID, png: new Uint8Array([7]).buffer }],
    });
    const temporary = glue.developers[1]!;
    expect(temporary.workingMaxDimension).toBe(2000);
    expect(glue.module.rasterDecodeSize).toHaveBeenCalledWith('{"v":5}', 3000, 2000, 1000, 4096);
    expect(temporary.surfaces.get(ID)).toEqual([7]);
    expect(temporary.free).toHaveBeenCalledOnce();
    expect(posted.at(-1)?.message).toMatchObject({ type: "jpeg", id: 3 });
    expect([...new Uint8Array((posted.at(-1)!.message as { bytes: ArrayBuffer }).bytes)]).toEqual([0xff, 0xd8, 1, 1000 & 0xff, 90]);
    expect(glue.module.exportJpeg).not.toHaveBeenCalled();
    expect(opened.surfaces.size).toBe(0);

    // 面の無い書き出しは今までどおり一発の書き出し
    await handler({ type: "exportJpeg", id: 4, bytes: new ArrayBuffer(3), settingsJson: "{}", maxDimension: 1000, quality: 90 });
    expect(glue.module.exportJpeg).toHaveBeenCalledOnce();
  });

  it("作業コピーの書き出しは、開いた作業コピーに面を渡してから描く", async () => {
    const glue = surfaceGlue();
    const encodeJpeg = vi.fn(async () => new Uint8Array([0xff, 0xd8]).buffer);
    const { handler, posted } = setup(glue.module, encodeJpeg);
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({
      type: "exportWorkingCopyJpeg",
      id: 2,
      png: new ArrayBuffer(4),
      metaJson: "{}",
      settingsJson: '{"v":5}',
      maxDimension: 1000,
      quality: 90,
      surfaces: [{ id: ID, png: new Uint8Array([9]).buffer }],
    });
    const working = glue.developers[0]!;
    expect(working.surfaces.get(ID)).toEqual([9]);
    expect(working.renders).toEqual(['{"v":5}']);
    expect(posted.at(-1)?.message).toMatchObject({ type: "jpeg", id: 2 });
  });
});

describe("Worker の空の検出（niho-photo#141）", () => {
  const found = () => ({ width: 3, height: 2, png: new Uint8Array([0x89, 0x50, 7]) });

  it("detectSky・setSkyModel があり、面を受け渡せて sky を描け、manifest にモデルがあるときだけ ready に skyDetection: true", async () => {
    const ready = setup(surfaceGlue({ detectSky: found }).module);
    await ready.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    expect(ready.posted[0]?.message).toMatchObject({ type: "ready", skyDetection: true });
    // モデルは押すまで読まない
    expect(ready.deps.fetch).toHaveBeenCalledOnce();

    const noSky = { capabilities: { masks: { ...CAPABILITIES.masks, kinds: ["linear", "radial", "brush", "subject"] } } };
    const cases: [Parameters<typeof surfaceGlue>[0], boolean][] = [
      [{}, true],
      [{ detectSky: found, encode: false }, true],
      [{ detectSky: found, ...noSky }, true],
      [{ detectSky: found, noSetSkyModel: true }, true],
      [{ detectSky: found }, false],
    ];
    for (const [options, skyModel] of cases) {
      const other = setup(surfaceGlue(options).module, undefined, { skyModel });
      await other.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
      expect(other.posted[0]?.message).toMatchObject({ type: "ready" });
      expect("skyDetection" in other.posted[0]!.message).toBe(false);
    }
  });

  it("初めての detectSky でモデルを読んで 1 度だけ渡し、開いている写真で空の面を作る。空が無ければ surface: null", async () => {
    const detectSky = vi.fn((_settingsJson: string, _ev100?: number): unknown => found());
    const glue = surfaceGlue({ detectSky });
    const { handler, posted, deps } = setup(glue.module);
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "detectSky", id: 2, settingsJson: "{}", ev100: 14 });
    expect(posted.at(-1)?.message).toEqual({ type: "error", id: 2, message: "no photo is open" });

    await handler({ type: "open", id: 3, bytes: new ArrayBuffer(4), workingMaxDimension: 2560 });
    await handler({ type: "detectSky", id: 4, settingsJson: '{"v":5,"engine":"niho-10"}', ev100: 14.5 });
    const setSkyModel = (glue.module as unknown as { setSkyModel: ReturnType<typeof vi.fn> }).setSkyModel;
    expect(setSkyModel).toHaveBeenCalledOnce();
    expect(setSkyModel).toHaveBeenCalledWith('{"long":384}', new Uint8Array([1, 2, 3, 4]));
    expect(detectSky).toHaveBeenLastCalledWith('{"v":5,"engine":"niho-10"}', 14.5);
    const last = posted.at(-1)!;
    expect(last.message).toMatchObject({ type: "skyDetected", id: 4, surface: { surfaceId: ID, width: 3, height: 2 } });
    const png = (last.message as { surface: { png: ArrayBuffer } }).surface.png;
    expect([...new Uint8Array(png)]).toEqual([0x89, 0x50, 7]);
    expect(last.transfer).toEqual([png]);
    expect(glue.module.maskSurfaceId).toHaveBeenCalledWith(new Uint8Array([0x89, 0x50, 7]));

    // 露出が分からなければ undefined（wasm の None）で呼ぶ。モデルは読み直さない
    detectSky.mockReturnValueOnce(null);
    await handler({ type: "detectSky", id: 5, settingsJson: "{}", ev100: null });
    expect(detectSky).toHaveBeenLastCalledWith("{}", undefined);
    expect(posted.at(-1)?.message).toEqual({ type: "skyDetected", id: 5, surface: null });
    expect(setSkyModel).toHaveBeenCalledOnce();
    expect(deps.fetch).toHaveBeenCalledTimes(3);

    // 形の違う答えは error
    detectSky.mockReturnValueOnce({ width: 0, height: 2, png: new Uint8Array([1]) });
    await handler({ type: "detectSky", id: 6, settingsJson: "{}", ev100: null });
    expect(posted.at(-1)?.message).toEqual({ type: "error", id: 6, message: "develop engine returned an invalid sky surface" });
  });

  it("モデルを読めなければ error にし、次の detectSky で読み直す", async () => {
    let status = 404;
    const detectSky = vi.fn((): unknown => found());
    const glue = surfaceGlue({ detectSky });
    const { handler, posted } = setup(glue.module, undefined, { skyModelStatus: () => status });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 2560 });
    await handler({ type: "detectSky", id: 3, settingsJson: "{}", ev100: null });
    expect(posted.at(-1)?.message).toEqual({ type: "error", id: 3, message: "develop engine sky model 404" });
    expect(detectSky).not.toHaveBeenCalled();

    status = 200;
    await handler({ type: "detectSky", id: 4, settingsJson: "{}", ev100: null });
    expect(posted.at(-1)?.message).toMatchObject({ type: "skyDetected", id: 4 });
  });

  it("Mac アプリの native でも、同梱した manifest のモデルを sidecar に渡して空を探す（モデルが無ければ skyDetection を付けない）", async () => {
    const detectSky = vi.fn((): unknown => found());
    const glue = surfaceGlue({ detectSky });
    const { handler, posted } = setup(glue.module, undefined, { native: true });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, preferNative: true });
    expect(posted[0]?.message).toMatchObject({ type: "ready", runtime: "native", skyDetection: true });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 2560 });
    await handler({ type: "detectSky", id: 3, settingsJson: "{}", ev100: null });
    const setSkyModel = (glue.module as unknown as { setSkyModel: ReturnType<typeof vi.fn> }).setSkyModel;
    expect(setSkyModel).toHaveBeenCalledWith('{"long":384}', new Uint8Array([1, 2, 3, 4]));
    expect(posted.at(-1)?.message).toMatchObject({ type: "skyDetected", id: 3, surface: { surfaceId: ID } });

    const without = setup(surfaceGlue({ detectSky }).module, undefined, { native: true, skyModel: false });
    await without.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, preferNative: true });
    expect(without.posted[0]?.message).toMatchObject({ type: "ready", runtime: "native" });
    expect("skyDetection" in without.posted[0]!.message).toBe(false);
  });

  it("口の無い glue では error（ほかの要求は使える）", async () => {
    const glue = surfaceGlue();
    const { handler, posted } = setup(glue.module);
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 2560 });
    await handler({ type: "detectSky", id: 3, settingsJson: "{}", ev100: 14 });
    expect(posted.at(-1)?.message).toEqual({ type: "error", id: 3, message: "develop engine cannot detect the sky" });
    await handler({ type: "render", id: 4, settingsJson: "{}", maxDimension: 64, interactive: false });
    expect(posted.at(-1)?.message).toMatchObject({ type: "frame", id: 4 });
  });
});
