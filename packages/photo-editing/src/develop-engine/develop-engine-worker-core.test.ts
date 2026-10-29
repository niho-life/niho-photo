import { describe, expect, it, vi } from "vitest";

import {
  createDevelopEngineWorkerHandler,
  type DevelopEngineWorkerDeps,
  type DevelopEngineWorkerResponse,
} from "./develop-engine-worker-core";
import { DEVELOP_ENGINE_CRATE_VERSION, DEVELOP_ENGINE_VERSION, developEngineManifestPath } from "./develop-engine-manifest";

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

type Posted = { message: DevelopEngineWorkerResponse; transfer: Transferable[] | undefined };

/** wasm-bindgen の glue の代わり（`import init, * as dev`）。 */
function fakeGlue(options: { memory?: WebAssembly.Memory; renderInMemory?: boolean } = {}) {
  const memory = options.memory ?? new WebAssembly.Memory({ initial: 1 });
  const developers: FakeDeveloper[] = [];
  class FakeDeveloper {
    readonly width: number;
    readonly height: number;
    readonly input: Uint8Array;
    readonly freed = vi.fn();
    readonly renders: { settingsJson: string; maxDimension: number; interactive: boolean }[] = [];
    metaJson: string | null = null;
    constructor(input: Uint8Array, workingMaxDimension: number) {
      this.input = input;
      this.width = Math.min(workingMaxDimension, 4);
      this.height = 2;
      developers.push(this);
    }
    /** 作業コピー（16bit PNG とメタデータ）を開く（長辺 2560px のまま持つ） */
    static openWorkingCopy(png: Uint8Array, metaJson: string) {
      const developer = new FakeDeveloper(png, 2560);
      developer.metaJson = metaJson;
      return developer;
    }
    render(settingsJson: string, maxDimension: number, interactive: boolean) {
      this.renders.push({ settingsJson, maxDimension, interactive });
      const rgba = options.renderInMemory
        ? new Uint8ClampedArray(memory.buffer, 16, 2 * 1 * 4)
        : new Uint8ClampedArray(2 * 1 * 4);
      rgba[0] = interactive ? 1 : 2;
      return { width: 2, height: 1, rgba, approximations: [], settingsJson, maxDimension };
    }
    sampleColor(_settingsJson: string, _maxDimension: number, x: number, y: number) {
      return { lightness: 0.72 + x * 0.01, chroma: 0.08, hue: 50 + y };
    }
    free() {
      this.freed();
    }
  }
  const init = vi.fn(async () => ({ memory }));
  return {
    developers,
    init,
    module: {
      default: init,
      version: () => "0.2.0+test",
      render: vi.fn(),
      exportJpeg: vi.fn((input: Uint8Array, _settingsJson: string, _maxDimension: number, _quality: number) =>
        new Uint8Array([0xff, 0xd8, input.byteLength, 0xff, 0xd9]),
      ),
      convertEditSettings: vi.fn((editSettingsJson: string, _baseVersion?: string) =>
        JSON.stringify({ converter: "test", ok: true, settings: { v: 1, engine: "niho-1", ...JSON.parse(editSettingsJson) }, issues: [], notes: [] }),
      ),
      presetSettings: vi.fn((xmp: string, baseJson?: string | null) => {
        if (!xmp.includes("x:xmpmeta")) throw new Error("preset has no settings");
        const base = baseJson ? (JSON.parse(baseJson) as Record<string, unknown>) : { v: 1, engine: "niho-1" };
        return JSON.stringify({ name: "bluesky2", settings: { ...base, exposure: 0.4 }, unsupported: [], converted: true });
      }),
      builtinPresets: vi.fn(() => JSON.stringify([{ id: "niho-bluesky2", name: "bluesky2", xmp: "<x:xmpmeta/>" }])),
      Developer: FakeDeveloper,
    },
  };
}

const AS_SHOT_JSON = '{"temperature":5200,"tint":4}';

/** プリセットの口（F2a 移行元設計: applyPreset・settingsToXmp・Developer.thumbnail / asShotWhite）のある glue。 */
function presetGlue() {
  const glue = fakeGlue();
  const Base = glue.module.Developer;
  const thumbnails: { maxDimension: number; session: InstanceType<typeof Base> }[] = [];
  class PresetDeveloper extends Base {
    asShotWhite() {
      return AS_SHOT_JSON;
    }
    thumbnail(maxDimension: number) {
      const session = new Base(new Uint8Array(0), maxDimension);
      thumbnails.push({ maxDimension, session });
      return session;
    }
  }
  const applyPreset = vi.fn((_xmp: string, baseJson: string, amount: number, _asShotJson?: string) =>
    JSON.stringify({ name: "bluesky2", settings: { ...JSON.parse(baseJson), contrast: 12 * amount }, converted: true, unsupported: [], amount }),
  );
  const settingsToXmp = vi.fn((_settingsJson: string, optionsJson?: string) =>
    JSON.stringify({
      xmp: `<x:xmpmeta>${(JSON.parse(optionsJson ?? "{}") as { name?: string }).name ?? ""}</x:xmpmeta>`,
      notWritten: ["relativeTemperature"],
    }),
  );
  return {
    developers: glue.developers,
    thumbnails,
    applyPreset,
    settingsToXmp,
    module: { ...glue.module, Developer: PresetDeveloper, applyPreset, settingsToXmp },
  };
}

/** 「自動」の口（F4a 移行元設計: `Developer.autoSettings`）のある glue。露光量と自然な彩度だけを変えた設定の JSON を返す。 */
function autoGlue() {
  const glue = fakeGlue();
  const Base = glue.module.Developer;
  const autoCalls: { developer: InstanceType<typeof Base>; settingsJson: string }[] = [];
  let broken = false;
  class AutoDeveloper extends Base {
    static openWorkingCopy(png: Uint8Array, metaJson: string) {
      const developer = new AutoDeveloper(png, 2560);
      developer.metaJson = metaJson;
      return developer;
    }
    autoSettings(settingsJson: string) {
      autoCalls.push({ developer: this, settingsJson });
      if (broken) return 1;
      return JSON.stringify({ ...(JSON.parse(settingsJson) as Record<string, unknown>), exposure: 0.35, vibrance: 12 });
    }
  }
  return {
    developers: glue.developers,
    autoCalls,
    breakResult: () => {
      broken = true;
    },
    module: { ...glue.module, Developer: AutoDeveloper },
  };
}

function setup(
  options: {
    manifestStatus?: number;
    module?: unknown;
    manifest?: unknown;
    encodeJpeg?: DevelopEngineWorkerDeps["encodeJpeg"];
    now?: DevelopEngineWorkerDeps["now"];
    logPerf?: DevelopEngineWorkerDeps["logPerf"];
    createNativeGlue?: DevelopEngineWorkerDeps["createNativeGlue"];
    isNativeUnavailableError?: DevelopEngineWorkerDeps["isNativeUnavailableError"];
  } = {},
) {
  const posted: Posted[] = [];
  const glue = fakeGlue();
  const deps: DevelopEngineWorkerDeps = {
    fetch: vi.fn(async () =>
      new Response(JSON.stringify(options.manifest ?? MANIFEST), { status: options.manifestStatus ?? 200 }),
    ),
    importModule: vi.fn(async () => options.module ?? glue.module),
    post: (message, transfer) => posted.push({ message, transfer }),
    encodeJpeg: options.encodeJpeg,
    now: options.now,
    logPerf: options.logPerf,
    createNativeGlue: options.createNativeGlue,
    isNativeUnavailableError: options.isNativeUnavailableError,
  };
  return { handler: createDevelopEngineWorkerHandler(deps), deps, posted, glue };
}

describe("createDevelopEngineWorkerHandler", () => {
  it("camera の希望時は native を選び、browser の init は同じ注入口があっても wasm のまま", async () => {
    const native = fakeGlue();
    const createNativeGlue = vi.fn(() => native.module);
    const selected = setup({ createNativeGlue });
    await selected.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, preferNative: true });
    expect(selected.posted[0]?.message).toMatchObject({ type: "ready", id: 1, runtime: "native" });
    expect(selected.deps.fetch).not.toHaveBeenCalled();

    const browser = setup({ createNativeGlue });
    await browser.handler({ type: "init", id: 2, manifestUrl: MANIFEST_URL });
    expect(browser.posted[0]?.message).toMatchObject({ type: "ready", id: 2, runtime: "wasm" });
    expect(createNativeGlue).toHaveBeenCalledOnce();
    expect(browser.deps.fetch).toHaveBeenCalledOnce();
  });

  it("native の hello・版・method 検証相当の初期化失敗では wasm へ戻る", async () => {
    for (const message of ["protocol mismatch", "crate version mismatch", "missing method", "sidecar 503"]) {
      const native = fakeGlue();
      const nativeModule = {
        ...native.module,
        default: vi.fn(async () => {
          throw new Error(message);
        }),
      };
      const { handler, posted, deps } = setup({ createNativeGlue: () => nativeModule });
      await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, preferNative: true });
      expect(posted[0]?.message, message).toMatchObject({ type: "ready", runtime: "wasm" });
      expect(deps.fetch, message).toHaveBeenCalledOnce();
    }
  });

  it("native の handle が失効した描画は写真と面を wasm に作り直して 1 回だけ再試行する", async () => {
    const unavailable = new Error("native handle is gone");
    const native = fakeGlue();
    const wasm = fakeGlue();
    const NativeBase = native.module.Developer;
    const WasmBase = wasm.module.Developer;
    const nativeSurfaces = new Map<string, Uint8Array>();
    const wasmSurfaces = new Map<string, Uint8Array>();
    class NativeDeveloper extends NativeBase {
      setMaskSurface(id: string, png: Uint8Array) {
        nativeSurfaces.set(id, new Uint8Array(png));
      }
      dropMaskSurface(id: string) {
        return nativeSurfaces.delete(id);
      }
      exportJpeg() {
        return new Uint8Array([1]);
      }
      override render(
        _settingsJson: string,
        _maxDimension: number,
        _interactive: boolean,
      ): ReturnType<InstanceType<typeof NativeBase>["render"]> {
        throw unavailable;
      }
    }
    class WasmDeveloper extends WasmBase {
      setMaskSurface(id: string, png: Uint8Array) {
        wasmSurfaces.set(id, new Uint8Array(png));
      }
      dropMaskSurface(id: string) {
        return wasmSurfaces.delete(id);
      }
      exportJpeg() {
        return new Uint8Array([1]);
      }
    }
    const capabilities = () => JSON.stringify({ masks: { kinds: ["brush"], max: 8, maskPlane: false, surfaces: true } });
    const surfaceFunctions = {
      capabilities,
      encodeMaskSurface: () => new Uint8Array([1]),
      maskSurfaceId: () => "a".repeat(64),
    };
    const releaseClient = vi.fn();
    const nativeModule = { ...native.module, ...surfaceFunctions, Developer: NativeDeveloper, releaseClient };
    const wasmModule = { ...wasm.module, ...surfaceFunctions, Developer: WasmDeveloper };
    const { handler, posted } = setup({
      module: wasmModule,
      createNativeGlue: () => nativeModule,
      isNativeUnavailableError: (error) => error === unavailable,
    });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, preferNative: true });
    await handler({ type: "open", id: 2, bytes: new Uint8Array([4, 5, 6]).buffer, workingMaxDimension: 1280 });
    await handler({ type: "setMaskSurface", id: 3, surfaceId: "surface", png: new Uint8Array([7, 8]).buffer });
    await handler({ type: "render", id: 4, settingsJson: "{}", maxDimension: 640, interactive: false });

    expect(posted[0]?.message).toMatchObject({ type: "ready", runtime: "native" });
    expect(posted.at(-1)?.message).toMatchObject({ type: "frame", id: 4, width: 2, height: 1 });
    expect(wasm.developers).toHaveLength(1);
    expect([...wasm.developers[0]!.input]).toEqual([4, 5, 6]);
    expect([...wasmSurfaces.get("surface")!]).toEqual([7, 8]);
    expect(releaseClient).toHaveBeenCalledOnce();
  });

  it("manifest が読めなければ unavailable を返し、以後の要求は error", async () => {
    const { handler, posted, deps } = setup({ manifestStatus: 404 });

    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "render", id: 2, settingsJson: "{}", maxDimension: 1280, interactive: false });

    expect(deps.fetch).toHaveBeenCalledWith(MANIFEST_URL, { cache: "no-cache" });
    expect(deps.importModule).not.toHaveBeenCalled();
    expect(posted[0]?.message).toMatchObject({ type: "unavailable", id: 1 });
    expect(posted[1]?.message).toMatchObject({ type: "error", id: 2 });
  });

  it("glue の形が違えば unavailable", async () => {
    const { handler, posted } = setup({ module: { default: async () => ({}) } });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    expect(posted[0]?.message).toMatchObject({ type: "unavailable", id: 1 });
  });

  it("init が成功したら ready（glue は manifest の URL から読み、wasm の URL で起こす）", async () => {
    const { handler, posted, deps, glue } = setup();

    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });

    expect(deps.importModule).toHaveBeenCalledWith(`https://photo.example.test/develop-engine/${DEVELOP_ENGINE_VERSION}/niho_develop_wasm-${DEVELOP_ENGINE_CRATE_VERSION}.js`);
    expect(glue.init).toHaveBeenCalledWith({
      module_or_path: `https://photo.example.test/develop-engine/${DEVELOP_ENGINE_VERSION}/niho_develop_wasm_bg-${DEVELOP_ENGINE_CRATE_VERSION}.wasm`,
    });
    expect(posted[0]?.message).toEqual({ type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm" });
  });

  it("診断が無効なら時計とログを使わず、応答だけ返す", async () => {
    const now = vi.fn(() => 10);
    const logPerf = vi.fn();
    const { handler, posted } = setup({ now, logPerf });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({ type: "render", id: 3, settingsJson: "{}", maxDimension: 1280, interactive: false });
    expect(posted.at(-1)?.message.type).toBe("frame");
    expect(now).not.toHaveBeenCalled();
    expect(logPerf).not.toHaveBeenCalled();
  });

  it("非同期 init の開始時計が失敗しても manifest と Wasm を読み ready を返す", async () => {
    const now = vi.fn(() => { throw new Error("clock unavailable"); });
    const logPerf = vi.fn();
    const { handler, posted, deps, glue } = setup({ now, logPerf });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, diagnostics: true });

    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(deps.importModule).toHaveBeenCalledOnce();
    expect(glue.init).toHaveBeenCalledOnce();
    expect(posted[0]?.message).toEqual({ type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm" });
    expect(now).toHaveBeenCalled();
    expect(logPerf).not.toHaveBeenCalled();
  });

  it("同期 open/render の開始時計が失敗しても処理し、元の render エラーを返す", async () => {
    const logPerf = vi.fn();
    const { handler, posted, glue } = setup({
      now: () => { throw new Error("clock unavailable"); },
      logPerf,
    });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, diagnostics: true });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({ type: "render", id: 3, settingsJson: "{}", maxDimension: 1280, interactive: false });
    await handler({ type: "close", id: 4 });
    await handler({ type: "render", id: 5, settingsJson: "{}", maxDimension: 1280, interactive: false });

    expect(glue.developers).toHaveLength(1);
    expect(posted.slice(1).map((entry) => entry.message.type)).toEqual(["opened", "frame", "closed", "error"]);
    expect(posted.at(-1)?.message).toEqual({ type: "error", id: 5, message: "no photo is open" });
    expect(logPerf).not.toHaveBeenCalled();
  });

  it("診断時だけ各処理をキューから取り出した後に計り、Wasm memory の成長後の容量を記録する", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const glue = fakeGlue({ memory });
    let time = 0;
    const records: NonNullable<Parameters<NonNullable<DevelopEngineWorkerDeps["logPerf"]>>[0]>[] = [];
    const { handler } = setup({ module: glue.module, now: () => (time += 5), logPerf: (record) => records.push(record) });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, diagnostics: true });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    memory.grow(1);
    await handler({ type: "render", id: 3, settingsJson: "{}", maxDimension: 1280, interactive: false });
    await handler({ type: "render", id: 4, settingsJson: "{}", maxDimension: 1280, interactive: true });
    await handler({ type: "openWorkingCopy", id: 5, png: new ArrayBuffer(4), metaJson: "{}" });

    expect(records).toEqual([
      { stage: "manifestFetch", durationMs: 5, wasmMemoryBytes: null, status: "ok" },
      { stage: "glueImport", durationMs: 5, wasmMemoryBytes: null, status: "ok" },
      { stage: "wasmInit", durationMs: 5, wasmMemoryBytes: 65_536, status: "ok" },
      { stage: "open", durationMs: 5, wasmMemoryBytes: 65_536, status: "ok" },
      { stage: "renderFinal", durationMs: 5, wasmMemoryBytes: 131_072, status: "ok" },
      { stage: "renderInteractive", durationMs: 5, wasmMemoryBytes: 131_072, status: "ok" },
      { stage: "openWorkingCopy", durationMs: 5, wasmMemoryBytes: 131_072, status: "ok" },
    ]);
  });

  it("memory が取得できないときも null で記録し、エラーの内容をログへ入れない", async () => {
    const glue = fakeGlue();
    const records: NonNullable<Parameters<NonNullable<DevelopEngineWorkerDeps["logPerf"]>>[0]>[] = [];
    const { handler, posted } = setup({
      module: { ...glue.module, default: async () => ({}) },
      now: () => 7,
      logPerf: (record) => records.push(record),
    });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, diagnostics: true });
    await handler({ type: "render", id: 2, settingsJson: '{"secret":"do-not-log"}', maxDimension: 1280, interactive: false });
    expect(posted.at(-1)?.message).toMatchObject({ type: "error", id: 2 });
    expect(records.at(-1)).toEqual({ stage: "renderFinal", durationMs: 0, wasmMemoryBytes: null, status: "error" });
    expect(JSON.stringify(records)).not.toContain("do-not-log");
  });

  it("manifest 失敗時も所要時間と error status を記録し、既存の unavailable を返す", async () => {
    const logPerf = vi.fn();
    const { handler, posted } = setup({ manifestStatus: 404, now: () => 8, logPerf });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, diagnostics: true });
    expect(logPerf).toHaveBeenCalledWith({ stage: "manifestFetch", durationMs: 0, wasmMemoryBytes: null, status: "error" });
    expect(posted[0]?.message).toMatchObject({ type: "unavailable", id: 1 });
  });

  it("プリセット見本・見本用の session・プリセットの当てはめと自動補正をそれぞれ処理時間として記録する", async () => {
    const preset = presetGlue();
    const auto = autoGlue();
    const presetLog = vi.fn();
    const autoLog = vi.fn();
    const { handler: presetHandler } = setup({ module: preset.module, now: () => 1, logPerf: presetLog });
    const { handler: autoHandler } = setup({ module: auto.module, now: () => 1, logPerf: autoLog });
    for (const handler of [presetHandler, autoHandler]) {
      await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, diagnostics: true });
      await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    }
    await presetHandler({ type: "renderPresetThumbnail", id: 3, settingsJson: "{}", maxDimension: 96 });
    await presetHandler({ type: "renderPresetThumbnail", id: 4, settingsJson: "{}", maxDimension: 96 });
    await presetHandler({ type: "presetSettings", id: 5, xmp: "<x:xmpmeta/>", baseSettingsJson: null });
    await autoHandler({ type: "autoSettings", id: 3, settingsJson: "{}" });
    // 見本用の session を作るのは初回だけ（見本 1 枚の時間の内訳）。プリセットを当てる時間も別に記録する
    expect(presetLog.mock.calls.map(([record]) => (record as { stage: string }).stage).slice(-4)).toEqual([
      "thumbnailSession",
      "presetThumbnail",
      "presetThumbnail",
      "presetSettings",
    ]);
    expect(presetLog).toHaveBeenCalledWith({ stage: "presetThumbnail", durationMs: 0, wasmMemoryBytes: 65_536, status: "ok" });
    expect(presetLog).toHaveBeenCalledWith({ stage: "thumbnailSession", durationMs: 0, wasmMemoryBytes: 65_536, status: "ok" });
    expect(presetLog).toHaveBeenCalledWith({ stage: "presetSettings", durationMs: 0, wasmMemoryBytes: 65_536, status: "ok" });
    expect(autoLog).toHaveBeenCalledWith({ stage: "autoSettings", durationMs: 0, wasmMemoryBytes: 65_536, status: "ok" });
  });

  it("wasm が v: 3・4・6・8・9 を通せば effects・color points・detail・heal・lens capability を付ける", async () => {
    const glue = fakeGlue();
    const validateSettings = vi.fn((_settingsJson: string) => "[]");
    const { handler, posted } = setup({ module: { ...glue.module, validateSettings } });

    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "init", id: 2, manifestUrl: MANIFEST_URL });

    expect(posted.map((entry) => entry.message)).toEqual([
      { type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm", effects: true, colorPoints: true, detail: true, heal: true, lens: true },
      { type: "ready", id: 2, version: "0.2.0+test", runtime: "wasm", effects: true, colorPoints: true, detail: true, heal: true, lens: true },
    ]);
    // effects・color points・detail・heal・lens の最小設定を各 1 回だけ確認する。
    expect(validateSettings).toHaveBeenCalledTimes(5);
    expect(JSON.parse(validateSettings.mock.calls[0]?.[0] ?? "null")).toMatchObject({ v: 3, vignette: { amount: -1 } });
    expect(JSON.parse(validateSettings.mock.calls[1]?.[0] ?? "null")).toMatchObject({ v: 4, colorPoints: [{ id: "probe" }] });
    expect(JSON.parse(validateSettings.mock.calls[2]?.[0] ?? "null")).toEqual({
      v: 6,
      engine: "niho-10",
      look: "niho-standard-1",
      base: null,
      detail: { sharpening: { amount: 10, radius: 1, detail: 25, masking: 0 }, luminanceNoiseReduction: 0 },
    });
    expect(JSON.parse(validateSettings.mock.calls[3]?.[0] ?? "null")).toEqual({
      v: 8,
      engine: "niho-10",
      look: "niho-standard-1",
      base: null,
      heal: [{ id: "probe", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.5, 0.5]] }],
    });
    // レンズ補正（niho-photo#45）は小さな v: 9 の設定で確かめる
    expect(JSON.parse(validateSettings.mock.calls[4]?.[0] ?? "null")).toEqual({
      v: 9,
      engine: "niho-10",
      look: "niho-standard-1",
      base: null,
      lens: { distortion: 10, removeChromaticAberration: true, defringe: { purple: { amount: 20 } } },
    });
  });

  it("v: 9 を断る wasm（crate 0.22.0 以前）には lens を付けない", async () => {
    const glue = fakeGlue();
    const validateSettings = vi.fn((settingsJson: string) =>
      JSON.parse(settingsJson).v === 9 ? JSON.stringify([{ path: "v", code: "unsupportedVersion" }]) : "[]",
    );
    const { handler, posted } = setup({ module: { ...glue.module, validateSettings } });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    expect(posted[0]?.message).toEqual({
      type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm", effects: true, colorPoints: true, detail: true, heal: true,
    });
  });

  it("v: 6 を断る wasm には detail を付けず、v: 8 の heal capability は判定する", async () => {
    const glue = fakeGlue();
    const validateSettings = vi.fn((settingsJson: string) =>
      JSON.parse(settingsJson).v === 6 ? JSON.stringify([{ path: "v", code: "unsupportedVersion" }]) : "[]",
    );
    const { handler, posted } = setup({ module: { ...glue.module, validateSettings } });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    expect(posted[0]?.message).toEqual({
      type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm", effects: true, colorPoints: true, heal: true, lens: true,
    });
  });

  it("v: 8 を断る wasm には heal を付けない", async () => {
    const glue = fakeGlue();
    const unsupportedVersion = JSON.stringify([{ code: "unsupportedVersion", message: "only v = 1, v = 2, v = 3, v = 4, v = 5, v = 6, and v = 7 are supported", path: "v" }]);
    const { handler, posted } = setup({
      module: {
        ...glue.module,
        validateSettings: (settingsJson: string) => (JSON.parse(settingsJson).v >= 8 ? unsupportedVersion : "[]"),
      },
    });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    expect(posted[0]?.message).toEqual({ type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm", effects: true, colorPoints: true, detail: true });
  });

  it("sampleColor は正規化座標を session に渡し、Stage Q の Oklch だけを返す", async () => {
    const glue = fakeGlue();
    const validateSettings = vi.fn(() => "[]");
    const { handler, posted } = setup({ module: { ...glue.module, validateSettings } });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({ type: "sampleColor", id: 3, settingsJson: "{}", maxDimension: 1024, x: 0.25, y: 0.75 });
    expect(posted.at(-1)?.message).toEqual({
      type: "sampledColor",
      id: 3,
      lightness: 0.7224999999999999,
      chroma: 0.08,
      hue: 50.75,
    });
  });

  it("v: 3 を断る wasm（問題を返す・throw する・壊れた応答）と validateSettings の無い wasm には effects を付けない（描ける版でも）", async () => {
    const unsupportedVersion = JSON.stringify([
      { code: "unsupportedVersion", message: "only v = 1 and v = 2 are supported", path: "v" },
    ]);
    const cases: Array<{ label: string; validateSettings: unknown }> = [
      // 公開済みの wasm 0.5.0 / 0.6.0 の応答: 効果は描けるが、v: 3 は断る
      { label: "unsupportedVersion を返す", validateSettings: () => unsupportedVersion },
      { label: "throw する", validateSettings: () => { throw new Error("unreachable"); } },
      { label: "JSON でない", validateSettings: () => "not json" },
      { label: "配列でない", validateSettings: () => "{}" },
      { label: "関数でない", validateSettings: "validateSettings" },
      { label: "関数が無い", validateSettings: undefined },
    ];
    for (const { label, validateSettings } of cases) {
      const glue = fakeGlue();
      const { handler, posted } = setup({ module: { ...glue.module, validateSettings } });
      await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
      expect(posted[0]?.message, label).toEqual({ type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm" });
    }
  });

  it("幾何の口と v3/v4/v5/v6/v7 設定があれば ready に全 capability を付ける", async () => {
    const glue = fakeGlue();
    const validateSettings = vi.fn((_settingsJson: string) => "[]");
    const { handler, posted } = setup({
      module: {
        ...glue.module,
        imageSize: () => ({ width: 6000, height: 4000 }),
        rasterDecodeSize: () => 1280,
        geometryOutputSize: () => ({ width: 1280, height: 853 }),
        beforeSettings: (settingsJson: string) => settingsJson,
        validateSettings,
      },
    });

    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });

    expect(posted[0]?.message).toEqual({
      type: "ready",
      id: 1,
      version: "0.2.0+test",
      runtime: "wasm",
      geometry: true,
      effects: true,
      colorPoints: true,
      detail: true,
      perspective: true,
      heal: true,
      lens: true,
    });
    // 遠近（niho-photo#46）は小さな v: 7 の設定で確かめる
    expect(JSON.parse(validateSettings.mock.calls[3]?.[0] ?? "null")).toEqual({
      v: 7,
      engine: "niho-10",
      look: "niho-standard-1",
      base: null,
      geometry: { perspective: { vertical: -10 }, constrain: true },
    });
  });

  it("幾何の口があっても v: 7 を断る wasm には perspective を付けない", async () => {
    const glue = fakeGlue();
    const unsupportedVersion = JSON.stringify([{ code: "unsupportedVersion", message: "only v = 1, v = 2, v = 3, and v = 4 are supported", path: "v" }]);
    const { handler, posted } = setup({
      module: {
        ...glue.module,
        imageSize: () => ({ width: 6000, height: 4000 }),
        rasterDecodeSize: () => 1280,
        geometryOutputSize: () => ({ width: 1280, height: 853 }),
        beforeSettings: (settingsJson: string) => settingsJson,
        // v: 7 を知らない wasm は v: 8 も知らない
        validateSettings: (settingsJson: string) => (JSON.parse(settingsJson).v >= 7 ? unsupportedVersion : "[]"),
      },
    });

    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });

    expect(posted[0]?.message).toEqual({
      type: "ready",
      id: 1,
      version: "0.2.0+test",
      runtime: "wasm",
      geometry: true,
      effects: true,
      colorPoints: true,
      detail: true,
    });
  });

  it("未初期化の open / render / exportJpeg / close は error", async () => {
    const { handler, posted } = setup();
    await handler({ type: "open", id: 1, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({ type: "render", id: 2, settingsJson: "{}", maxDimension: 1280, interactive: false });
    await handler({ type: "exportJpeg", id: 3, bytes: new ArrayBuffer(4), settingsJson: "{}", maxDimension: 2048, quality: 90 });
    await handler({ type: "close", id: 4 });
    expect(posted.map((entry) => entry.message.type)).toEqual(["error", "error", "error", "error"]);
  });

  it("open → render は frame を返し、画素の buffer を transfer する。別の写真を開くと前の写真を手放す", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });

    await handler({ type: "open", id: 2, bytes: new Uint8Array([1, 2, 3]).buffer, workingMaxDimension: 1280 });
    await handler({ type: "render", id: 3, settingsJson: '{"v":1}', maxDimension: 1280, interactive: true });

    expect(posted[1]?.message).toEqual({ type: "opened", id: 2, width: 4, height: 2 });
    expect(Array.from(glue.developers[0]?.input ?? [])).toEqual([1, 2, 3]);
    const frame = posted[2];
    expect(frame?.message).toMatchObject({ type: "frame", id: 3, width: 2, height: 1 });
    const rgba = frame?.message.type === "frame" ? frame.message.rgba : null;
    expect(rgba?.byteLength).toBe(8);
    expect(new Uint8Array(rgba ?? new ArrayBuffer(0))[0]).toBe(1);
    expect(frame?.transfer).toEqual([rgba]);

    await handler({ type: "open", id: 4, bytes: new ArrayBuffer(2), workingMaxDimension: 1280 });
    expect(glue.developers[0]?.freed).toHaveBeenCalledOnce();
    await handler({ type: "close", id: 5 });
    expect(glue.developers[1]?.freed).toHaveBeenCalledOnce();
    expect(posted.at(-1)?.message).toEqual({ type: "closed", id: 5 });
    // 手放した後の render は error
    await handler({ type: "render", id: 6, settingsJson: "{}", maxDimension: 1280, interactive: false });
    expect(posted.at(-1)?.message).toMatchObject({ type: "error", id: 6 });
  });

  it("wasm の memory を指す画素はコピーしてから transfer する（memory を手放さない）", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const glue = fakeGlue({ memory, renderInMemory: true });
    const posted: Posted[] = [];
    const handler = createDevelopEngineWorkerHandler({
      fetch: async () => new Response(JSON.stringify(MANIFEST)),
      importModule: async () => glue.module,
      post: (message, transfer) => posted.push({ message, transfer }),
    });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(2), workingMaxDimension: 1280 });
    await handler({ type: "render", id: 3, settingsJson: "{}", maxDimension: 1280, interactive: false });

    const message = posted[2]?.message;
    const rgba = message?.type === "frame" ? message.rgba : null;
    expect(rgba).not.toBe(memory.buffer);
    expect(rgba?.byteLength).toBe(8);
    expect(new Uint8Array(rgba ?? new ArrayBuffer(0))[0]).toBe(2);
  });

  it("exportJpeg は持っている写真を変えずに JPEG を返す（transfer）", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(3), workingMaxDimension: 1280 });

    await handler({ type: "exportJpeg", id: 3, bytes: new ArrayBuffer(7), settingsJson: '{"v":1}', maxDimension: 2048, quality: 90 });

    expect(glue.module.exportJpeg).toHaveBeenCalledWith(expect.any(Uint8Array), '{"v":1}', 2048, 90);
    const jpeg = posted[2];
    expect(jpeg?.message.type).toBe("jpeg");
    const bytes = jpeg?.message.type === "jpeg" ? jpeg.message.bytes : null;
    expect(Array.from(new Uint8Array(bytes ?? new ArrayBuffer(0)))).toEqual([0xff, 0xd8, 7, 0xff, 0xd9]);
    expect(jpeg?.transfer).toEqual([bytes]);
    expect(glue.developers[0]?.freed).not.toHaveBeenCalled();
  });

  it("convertEditSettings は crate の変換の結果を JSON のまま返す（未初期化なら error）", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "convertEditSettings", id: 1, editSettingsJson: "{}" });
    expect(posted[0]?.message).toMatchObject({ type: "error", id: 1 });

    await handler({ type: "init", id: 2, manifestUrl: MANIFEST_URL });
    await handler({ type: "convertEditSettings", id: 3, editSettingsJson: '{"exposure":0.4}' });

    expect(glue.module.convertEditSettings).toHaveBeenCalledWith('{"exposure":0.4}', undefined);
    const message = posted[2]?.message;
    expect(message).toMatchObject({ type: "converted", id: 3 });
    const resultJson = message?.type === "converted" ? message.resultJson : "{}";
    expect(JSON.parse(resultJson)).toMatchObject({ ok: true, settings: { v: 1, engine: "niho-1", exposure: 0.4 } });
  });

  it("convertEditSettings は作業コピーの上で直す写真の baseVersion を crate の変換へ渡す（#16944）", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({
      type: "convertEditSettings",
      id: 2,
      editSettingsJson: '{"exposure":0.4}',
      baseVersion: "raw-apple.d8.p1.e1.cal-none",
    });
    expect(glue.module.convertEditSettings).toHaveBeenCalledWith('{"exposure":0.4}', "raw-apple.d8.p1.e1.cal-none");
    expect(posted[1]?.message).toMatchObject({ type: "converted", id: 2 });
  });

  it("openWorkingCopy は作業コピーとメタデータを開いて持ち（前の写真は手放す）、render はそれで描く（#16944）", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(3), workingMaxDimension: 1280 });

    await handler({ type: "openWorkingCopy", id: 3, png: new Uint8Array([9, 8]).buffer, metaJson: '{"kind":"raw"}' });
    await handler({ type: "render", id: 4, settingsJson: '{"v":1}', maxDimension: 1280, interactive: false });

    expect(glue.developers[0]?.freed).toHaveBeenCalledOnce();
    const working = glue.developers[1];
    expect(Array.from(working?.input ?? [])).toEqual([9, 8]);
    expect(working?.metaJson).toBe('{"kind":"raw"}');
    expect(posted[2]?.message).toEqual({ type: "opened", id: 3, width: 4, height: 2 });
    expect(working?.renders).toEqual([{ settingsJson: '{"v":1}', maxDimension: 1280, interactive: false }]);
    expect(posted[3]?.message).toMatchObject({ type: "frame", id: 4 });
  });

  it("exportWorkingCopyJpeg は持っている写真を変えずに別に開いて丁寧に描き、Worker の中で JPEG にする（transfer）", async () => {
    const encodeJpeg = vi.fn(async (_width: number, _height: number, rgba: ArrayBuffer, quality: number) =>
      new Uint8Array([0xff, 0xd8, new Uint8Array(rgba)[0] ?? 0, quality, 0xff, 0xd9]).buffer,
    );
    const { handler, posted, glue } = setup({ encodeJpeg });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "openWorkingCopy", id: 2, png: new ArrayBuffer(4), metaJson: "{}" });

    await handler({
      type: "exportWorkingCopyJpeg",
      id: 3,
      png: new ArrayBuffer(4),
      metaJson: '{"kind":"raw"}',
      settingsJson: '{"v":1,"exposure":1}',
      maxDimension: 2048,
      quality: 90,
    });

    const held = glue.developers[0];
    const temporary = glue.developers[1];
    expect(held?.freed).not.toHaveBeenCalled();
    expect(temporary?.renders).toEqual([{ settingsJson: '{"v":1,"exposure":1}', maxDimension: 2048, interactive: false }]);
    expect(temporary?.freed).toHaveBeenCalledOnce();
    expect(encodeJpeg).toHaveBeenCalledWith(2, 1, expect.any(ArrayBuffer), 90);
    const jpeg = posted[2];
    const bytes = jpeg?.message.type === "jpeg" ? jpeg.message.bytes : null;
    // 丁寧に描いた画（final）を JPEG にした
    expect(Array.from(new Uint8Array(bytes ?? new ArrayBuffer(0)))).toEqual([0xff, 0xd8, 2, 90, 0xff, 0xd9]);
    expect(jpeg?.transfer).toEqual([bytes]);
    // 持っている写真で描き続けられる
    await handler({ type: "render", id: 4, settingsJson: "{}", maxDimension: 1280, interactive: true });
    expect(held?.renders).toHaveLength(1);
  });

  it("Worker の中で JPEG にできなければ（OffscreenCanvas が無い・失敗）、画素を返してメインスレッドに任せる", async () => {
    for (const encodeJpeg of [
      undefined,
      vi.fn(async () => null),
      vi.fn(async () => {
        throw new Error("encode failed");
      }),
    ]) {
      const { handler, posted, glue } = setup({ encodeJpeg });
      await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
      await handler({
        type: "exportWorkingCopyJpeg",
        id: 2,
        png: new ArrayBuffer(4),
        metaJson: "{}",
        settingsJson: "{}",
        maxDimension: 2048,
        quality: 90,
      });
      const frame = posted[1];
      expect(frame?.message).toMatchObject({ type: "frame", id: 2, width: 2, height: 1 });
      const rgba = frame?.message.type === "frame" ? frame.message.rgba : null;
      expect(frame?.transfer).toEqual([rgba]);
      expect(glue.developers[0]?.freed).toHaveBeenCalledOnce();
    }
  });

  it("glue に openWorkingCopy が無くても ready（オリジナルから描く分は使う）。作業コピーを開くと error", async () => {
    const glue = fakeGlue();
    class WithoutWorkingCopy {
      constructor(
        readonly input: Uint8Array,
        readonly workingMaxDimension: number,
      ) {}
    }
    const { handler, posted } = setup({ module: { ...glue.module, Developer: WithoutWorkingCopy } });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "openWorkingCopy", id: 2, png: new ArrayBuffer(4), metaJson: "{}" });
    expect(posted.map((entry) => entry.message.type)).toEqual(["ready", "error"]);
  });

  it("glue に convertEditSettings が無ければ unavailable", async () => {
    const glue = fakeGlue();
    const { convertEditSettings: _omitted, ...withoutConvert } = glue.module;
    const { handler, posted } = setup({ module: withoutConvert });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    expect(posted[0]?.message).toMatchObject({ type: "unavailable", id: 1 });
  });

  it("presetSettings は XMP を base（無ければ neutral）に当てた結果を JSON のまま返す。読めない XMP は error（#16946 S7b）", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "presetSettings", id: 1, xmp: "<x:xmpmeta/>", baseSettingsJson: null });
    expect(posted[0]?.message).toMatchObject({ type: "error", id: 1 });

    await handler({ type: "init", id: 2, manifestUrl: MANIFEST_URL });
    await handler({ type: "presetSettings", id: 3, xmp: "<x:xmpmeta/>", baseSettingsJson: '{"v":1,"engine":"niho-1","base":"b1"}' });
    await handler({ type: "presetSettings", id: 4, xmp: "<x:xmpmeta/>", baseSettingsJson: null });
    await handler({ type: "presetSettings", id: 5, xmp: "not xmp", baseSettingsJson: null });

    expect(glue.module.presetSettings).toHaveBeenNthCalledWith(1, "<x:xmpmeta/>", '{"v":1,"engine":"niho-1","base":"b1"}');
    expect(glue.module.presetSettings).toHaveBeenNthCalledWith(2, "<x:xmpmeta/>", null);
    const message = posted[2]?.message;
    expect(message).toMatchObject({ type: "preset", id: 3 });
    const resultJson = message?.type === "preset" ? message.resultJson : "{}";
    expect(JSON.parse(resultJson)).toMatchObject({ converted: true, settings: { base: "b1", exposure: 0.4 } });
    expect(posted[3]?.message).toMatchObject({ type: "preset", id: 4 });
    expect(posted[4]?.message).toMatchObject({ type: "error", id: 5 });
  });

  it("builtinPresets は同梱のプリセットの一覧を JSON のまま返す（#16946 S7b）", async () => {
    const { handler, posted } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "builtinPresets", id: 2 });
    const message = posted[1]?.message;
    expect(message).toMatchObject({ type: "builtinPresets", id: 2 });
    const presetsJson = message?.type === "builtinPresets" ? message.presetsJson : "[]";
    expect(JSON.parse(presetsJson)).toEqual([{ id: "niho-bluesky2", name: "bluesky2", xmp: "<x:xmpmeta/>" }]);
  });

  it("glue にプリセットが無くても ready（描く分は使う）。プリセットの要求は error", async () => {
    const glue = fakeGlue();
    const { presetSettings: _preset, builtinPresets: _builtin, ...withoutPresets } = glue.module;
    const { handler, posted } = setup({ module: withoutPresets });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "presetSettings", id: 2, xmp: "<x:xmpmeta/>", baseSettingsJson: null });
    await handler({ type: "builtinPresets", id: 3 });
    expect(posted.map((entry) => entry.message.type)).toEqual(["ready", "error", "error"]);
  });

  it("幾何の口が glue に揃っていれば ready に geometry: true を付け、寸法・作業サイズ・出力の寸法を返す（F3 #17122）", async () => {
    const glue = fakeGlue();
    const geometry = {
      imageSize: vi.fn((input: Uint8Array) => ({ width: 6000, height: 4000 + input.byteLength })),
      rasterDecodeSize: vi.fn(
        (_settingsJson: string, _width: number, _height: number, _maxDimension: number, _cap: number) => 2560,
      ),
      geometryOutputSize: vi.fn(
        (_settingsJson: string, _sourceWidth: number, _sourceHeight: number, _maxDimension: number) => ({ width: 1280, height: 853 }),
      ),
      beforeSettings: vi.fn((settingsJson: string) => settingsJson),
    };
    const { handler, posted } = setup({ module: { ...glue.module, ...geometry } });
    const settingsJson = '{"v":2,"engine":"niho-1","geometry":{"crop":{"left":0.25,"top":0.25,"right":0.75,"bottom":0.75}}}';
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "imageSize", id: 2, bytes });
    await handler({ type: "rasterDecodeSize", id: 3, settingsJson, width: 6000, height: 4004, maxDimension: 1280, cap: 4096 });
    await handler({ type: "geometryOutputSize", id: 4, settingsJson, sourceWidth: 2560, sourceHeight: 1707, maxDimension: 1280 });
    // もう一度 init しても同じ応答
    await handler({ type: "init", id: 5, manifestUrl: MANIFEST_URL });

    expect(posted.map((entry) => entry.message)).toEqual([
      { type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm", geometry: true },
      { type: "size", id: 2, width: 6000, height: 4004 },
      { type: "decodeSize", id: 3, size: 2560 },
      { type: "size", id: 4, width: 1280, height: 853 },
      { type: "ready", id: 5, version: "0.2.0+test", runtime: "wasm", geometry: true },
    ]);
    // bytes は transfer しない（呼び出し側がこの後 open に渡す）
    expect(posted.every((entry) => entry.transfer === undefined)).toBe(true);
    expect(geometry.imageSize.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
    expect(geometry.rasterDecodeSize).toHaveBeenCalledWith(settingsJson, 6000, 4004, 1280, 4096);
    expect(geometry.geometryOutputSize).toHaveBeenCalledWith(settingsJson, 2560, 1707, 1280);
  });

  it("幾何の口が壊れた値を返したら error（次の要求は処理する）", async () => {
    const glue = fakeGlue();
    const { handler, posted } = setup({
      module: {
        ...glue.module,
        imageSize: () => ({ width: 0, height: 4000 }),
        rasterDecodeSize: () => 0.5,
        geometryOutputSize: () => {
          throw new Error("geometry.crop: invalidCrop");
        },
        beforeSettings: (settingsJson: string) => settingsJson,
      },
    });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "imageSize", id: 2, bytes: new ArrayBuffer(4) });
    await handler({ type: "rasterDecodeSize", id: 3, settingsJson: "{}", width: 6000, height: 4000, maxDimension: 1280, cap: 4096 });
    await handler({ type: "geometryOutputSize", id: 4, settingsJson: "{}", sourceWidth: 2560, sourceHeight: 1707, maxDimension: 1280 });
    await handler({ type: "open", id: 5, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });

    expect(posted.map((entry) => entry.message.type)).toEqual(["ready", "error", "error", "error", "opened"]);
    expect(posted[3]?.message).toMatchObject({ type: "error", id: 4, message: "geometry.crop: invalidCrop" });
  });

  it("glue に幾何の口が無くても（1 つでも欠けていても）ready（geometry は付けない）。幾何の要求は error", async () => {
    const glue = fakeGlue();
    const partial = {
      ...glue.module,
      imageSize: () => ({ width: 6000, height: 4000 }),
      rasterDecodeSize: () => 2560,
      geometryOutputSize: () => ({ width: 1280, height: 853 }),
    };
    for (const glueModule of [glue.module, partial]) {
      const { handler, posted } = setup({ module: glueModule });
      await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
      await handler({ type: "imageSize", id: 2, bytes: new ArrayBuffer(4) });
      await handler({ type: "rasterDecodeSize", id: 3, settingsJson: "{}", width: 6000, height: 4000, maxDimension: 1280, cap: 4096 });
      await handler({ type: "geometryOutputSize", id: 4, settingsJson: "{}", sourceWidth: 2560, sourceHeight: 1707, maxDimension: 1280 });
      await handler({ type: "open", id: 5, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });

      expect(posted[0]?.message).toEqual({ type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm" });
      expect(posted.map((entry) => entry.message.type)).toEqual(["ready", "error", "error", "error", "opened"]);
    }
  });

  it("withCaptureExif は JPEG に撮影日時の EXIF を付けた JPEG を返す（transfer。F7b #17127）", async () => {
    const glue = fakeGlue();
    const withCaptureExif = vi.fn((jpeg: Uint8Array, _capturedAt: string, _offsetMinutes: number) =>
      new Uint8Array([0xff, 0xd8, 0xe1, jpeg.byteLength, 0xff, 0xd9]),
    );
    const { handler, posted } = setup({ module: { ...glue.module, withCaptureExif } });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });

    await handler({
      type: "withCaptureExif",
      id: 2,
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer,
      capturedAt: "2026-09-17T02:12:59.000Z",
      offsetMinutes: 540,
    });

    expect(withCaptureExif).toHaveBeenCalledWith(expect.any(Uint8Array), "2026-09-17T02:12:59.000Z", 540);
    const jpeg = posted[1];
    expect(jpeg?.message.type).toBe("jpeg");
    const bytes = jpeg?.message.type === "jpeg" ? jpeg.message.bytes : null;
    expect(Array.from(new Uint8Array(bytes ?? new ArrayBuffer(0)))).toEqual([0xff, 0xd8, 0xe1, 4, 0xff, 0xd9]);
    expect(jpeg?.transfer).toEqual([bytes]);
  });

  it("glue に withCaptureExif が無い・失敗したら error（次の要求は処理する）", async () => {
    const glue = fakeGlue();
    const request = {
      type: "withCaptureExif" as const,
      bytes: new ArrayBuffer(4),
      capturedAt: "2026-09-17T02:12:59.000Z",
      offsetMinutes: 540,
    };
    const withoutExif = setup();
    await withoutExif.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await withoutExif.handler({ ...request, id: 2 });
    await withoutExif.handler({ type: "open", id: 3, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    expect(withoutExif.posted.map((entry) => entry.message.type)).toEqual(["ready", "error", "opened"]);

    const failing = setup({
      module: {
        ...glue.module,
        withCaptureExif: () => {
          throw new Error("not a JPEG");
        },
      },
    });
    await failing.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await failing.handler({ ...request, id: 2 });
    expect(failing.posted[1]?.message).toEqual({ type: "error", id: 2, message: "not a JPEG" });
  });

  it("プリセットの口（F2a #17135）が glue にあれば ready に付け、applyPreset は開いている写真の撮影時の白を渡す", async () => {
    const glue = presetGlue();
    const { handler, posted } = setup({ module: glue.module });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    // 写真を開く前は撮影時の白なし
    await handler({ type: "applyPreset", id: 2, xmp: "<x:xmpmeta/>", baseSettingsJson: '{"v":1,"engine":"niho-1"}', amount: 0.5 });
    await handler({ type: "open", id: 3, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({ type: "applyPreset", id: 4, xmp: "<x:xmpmeta/>", baseSettingsJson: '{"v":1,"engine":"niho-1"}', amount: 1.5 });
    await handler({
      type: "settingsToXmp",
      id: 5,
      settingsJson: '{"v":1,"engine":"niho-1","contrast":12}',
      optionsJson: '{"name":"夕方の窓辺","groups":["exposure","tone"]}',
    });

    expect(posted[0]?.message).toEqual({
      type: "ready",
      id: 1,
      version: "0.2.0+test",
      runtime: "wasm",
      presetAmount: true,
      settingsToXmp: true,
      presetThumbnails: true,
    });
    expect(glue.applyPreset).toHaveBeenNthCalledWith(1, "<x:xmpmeta/>", '{"v":1,"engine":"niho-1"}', 0.5, undefined);
    expect(glue.applyPreset).toHaveBeenNthCalledWith(2, "<x:xmpmeta/>", '{"v":1,"engine":"niho-1"}', 1.5, AS_SHOT_JSON);
    const applied = posted[1]?.message;
    expect(applied).toMatchObject({ type: "preset", id: 2 });
    expect(JSON.parse(applied?.type === "preset" ? applied.resultJson : "{}")).toMatchObject({ amount: 0.5 });
    expect(posted[3]?.message).toMatchObject({ type: "preset", id: 4 });
    expect(glue.settingsToXmp).toHaveBeenCalledWith(
      '{"v":1,"engine":"niho-1","contrast":12}',
      '{"name":"夕方の窓辺","groups":["exposure","tone"]}',
    );
    const written = posted[4]?.message;
    expect(written).toMatchObject({ type: "xmp", id: 5 });
    expect(JSON.parse(written?.type === "xmp" ? written.resultJson : "{}")).toEqual({
      xmp: "<x:xmpmeta>夕方の窓辺</x:xmpmeta>",
      notWritten: ["relativeTemperature"],
    });
  });

  it("asShotWhiteFromMeta のある glue は ready に presetFromMeta を付け、メタを渡した applyPreset は開いている写真なしで作業コピーのメタから白を引く（F5a-2 #17140）", async () => {
    const glue = presetGlue();
    const asShotWhiteFromMeta = vi.fn((metaJson: string) =>
      (JSON.parse(metaJson) as { kind?: string }).kind === "raw" ? '{"temperature":4800,"tint":2}' : "null",
    );
    const { handler, posted } = setup({ module: { ...glue.module, asShotWhiteFromMeta } });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    const base = '{"v":1,"engine":"niho-1"}';
    // 写真を開いていなくても、RAW の作業コピーのメタから撮影時の白を引いて当てる
    await handler({ type: "applyPreset", id: 2, xmp: "<x:xmpmeta/>", baseSettingsJson: base, amount: 1, asShotMetaJson: '{"kind":"raw"}' });
    // JPEG / PNG（null）は撮影時の白なし
    await handler({ type: "applyPreset", id: 3, xmp: "<x:xmpmeta/>", baseSettingsJson: base, amount: 1, asShotMetaJson: null });
    // 写真を開いていても、メタ（null を含む）を渡されたら開いている写真の白は使わない
    await handler({ type: "open", id: 4, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({ type: "applyPreset", id: 5, xmp: "<x:xmpmeta/>", baseSettingsJson: base, amount: 1, asShotMetaJson: null });
    // 省けば今までどおり開いている写真の白（1 枚の面の呼び方は変わらない）
    await handler({ type: "applyPreset", id: 6, xmp: "<x:xmpmeta/>", baseSettingsJson: base, amount: 1 });

    expect(posted[0]?.message).toMatchObject({ type: "ready", id: 1, presetAmount: true, presetFromMeta: true });
    expect(asShotWhiteFromMeta).toHaveBeenCalledTimes(1);
    expect(asShotWhiteFromMeta).toHaveBeenCalledWith('{"kind":"raw"}');
    expect(glue.applyPreset).toHaveBeenNthCalledWith(1, "<x:xmpmeta/>", base, 1, '{"temperature":4800,"tint":2}');
    expect(glue.applyPreset).toHaveBeenNthCalledWith(2, "<x:xmpmeta/>", base, 1, undefined);
    expect(glue.applyPreset).toHaveBeenNthCalledWith(3, "<x:xmpmeta/>", base, 1, undefined);
    expect(glue.applyPreset).toHaveBeenNthCalledWith(4, "<x:xmpmeta/>", base, 1, AS_SHOT_JSON);
    expect(posted.map((entry) => entry.message.type)).toEqual(["ready", "preset", "preset", "opened", "preset", "preset"]);
  });

  it("asShotWhiteFromMeta の無い glue は presetFromMeta を付けず、メタを渡した applyPreset は error（開いている写真の白で当てない）", async () => {
    const glue = presetGlue();
    const { handler, posted } = setup({ module: glue.module });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({ type: "applyPreset", id: 3, xmp: "<x:xmpmeta/>", baseSettingsJson: "{}", amount: 1, asShotMetaJson: '{"kind":"raw"}' });
    // null（JPEG / PNG）は撮影時の白を引かないので当てられる
    await handler({ type: "applyPreset", id: 4, xmp: "<x:xmpmeta/>", baseSettingsJson: "{}", amount: 1, asShotMetaJson: null });

    expect(posted[0]?.message).not.toHaveProperty("presetFromMeta");
    expect(posted[2]?.message).toEqual({ type: "error", id: 3, message: "develop engine cannot read the as-shot white" });
    expect(posted[3]?.message).toMatchObject({ type: "preset", id: 4 });
    expect(glue.applyPreset).toHaveBeenCalledTimes(1);
    expect(glue.applyPreset).toHaveBeenCalledWith("<x:xmpmeta/>", "{}", 1, undefined);
  });

  it("renderPresetThumbnail は開いている写真の thumbnail(256) を初回に作って持ち、丁寧に描く。写真を手放すと一緒に手放す", async () => {
    const glue = presetGlue();
    const { handler, posted } = setup({ module: glue.module });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    // 写真を開いていなければ error
    await handler({ type: "renderPresetThumbnail", id: 2, settingsJson: "{}", maxDimension: 96 });
    await handler({ type: "open", id: 3, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({ type: "renderPresetThumbnail", id: 4, settingsJson: '{"contrast":12}', maxDimension: 96 });
    await handler({ type: "renderPresetThumbnail", id: 5, settingsJson: '{"contrast":-8}', maxDimension: 96 });
    // 本体の描画は本体の session のまま
    await handler({ type: "render", id: 6, settingsJson: "{}", maxDimension: 1280, interactive: true });

    expect(posted[1]?.message).toMatchObject({ type: "error", id: 2, message: "no photo is open" });
    const photo = glue.developers[0];
    expect(glue.thumbnails).toHaveLength(1);
    const thumbnail = glue.thumbnails[0];
    expect(thumbnail?.maxDimension).toBe(256);
    expect(thumbnail?.session.renders).toEqual([
      { settingsJson: '{"contrast":12}', maxDimension: 96, interactive: false },
      { settingsJson: '{"contrast":-8}', maxDimension: 96, interactive: false },
    ]);
    const frame = posted[3];
    expect(frame?.message).toMatchObject({ type: "frame", id: 4, width: 2, height: 1 });
    expect(frame?.transfer).toEqual([frame?.message.type === "frame" ? frame.message.rgba : null]);
    expect(photo?.renders).toEqual([{ settingsJson: "{}", maxDimension: 1280, interactive: true }]);

    // 別の写真を開くと、前の写真の見本の session も手放し、次の見本は新しい写真から作る
    await handler({ type: "open", id: 7, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    expect(thumbnail?.session.freed).toHaveBeenCalledOnce();
    expect(photo?.freed).toHaveBeenCalledOnce();
    await handler({ type: "renderPresetThumbnail", id: 8, settingsJson: "{}", maxDimension: 96 });
    expect(glue.thumbnails).toHaveLength(2);
    await handler({ type: "close", id: 9 });
    expect(glue.thumbnails[1]?.session.freed).toHaveBeenCalledOnce();
    await handler({ type: "renderPresetThumbnail", id: 10, settingsJson: "{}", maxDimension: 96 });
    expect(posted.at(-1)?.message).toMatchObject({ type: "error", id: 10 });
  });

  it("本体のengine/CNR設定が変わったら見本sessionを手放し、次回は現在の解析から作り直す", async () => {
    const glue = presetGlue();
    const { handler } = setup({ module: glue.module });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({
      type: "render",
      id: 3,
      settingsJson: '{"engine":"niho-3","colorNoiseReduction":25}',
      maxDimension: 1280,
      interactive: false,
    });
    await handler({ type: "renderPresetThumbnail", id: 4, settingsJson: '{"colorNoiseReduction":25}', maxDimension: 96 });
    const firstThumbnail = glue.thumbnails[0]?.session;

    await handler({
      type: "render",
      id: 5,
      settingsJson: '{"engine":"niho-3","colorNoiseReduction":25,"contrast":12}',
      maxDimension: 1280,
      interactive: true,
    });
    expect(firstThumbnail?.freed).not.toHaveBeenCalled();

    await handler({
      type: "render",
      id: 6,
      settingsJson: '{"engine":"niho-3","colorNoiseReduction":40,"contrast":12}',
      maxDimension: 1280,
      interactive: false,
    });
    expect(firstThumbnail?.freed).toHaveBeenCalledOnce();

    await handler({ type: "renderPresetThumbnail", id: 7, settingsJson: '{"colorNoiseReduction":40}', maxDimension: 96 });
    expect(glue.thumbnails).toHaveLength(2);
    expect(glue.thumbnails[1]?.session.freed).not.toHaveBeenCalled();
  });

  it("プリセットの口の無い glue では ready に付けず（ほかは使える）、適用量・書き出し・見本の要求は error", async () => {
    const { handler, posted } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({ type: "applyPreset", id: 3, xmp: "<x:xmpmeta/>", baseSettingsJson: "{}", amount: 0.5 });
    await handler({ type: "settingsToXmp", id: 4, settingsJson: "{}", optionsJson: "{}" });
    await handler({ type: "renderPresetThumbnail", id: 5, settingsJson: "{}", maxDimension: 96 });
    await handler({ type: "render", id: 6, settingsJson: "{}", maxDimension: 1280, interactive: false });

    expect(posted[0]?.message).toEqual({ type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm" });
    expect(posted.map((entry) => entry.message.type)).toEqual(["ready", "opened", "error", "error", "error", "frame"]);
  });

  it("「自動」の口（F4a #17123）が Developer にあれば ready に auto: true を付け、開いている写真の autoSettings の JSON をそのまま返す", async () => {
    const glue = autoGlue();
    const { handler, posted } = setup({ module: glue.module });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    // 写真を開いていなければ error
    await handler({ type: "autoSettings", id: 2, settingsJson: '{"v":1,"engine":"niho-1"}' });
    await handler({ type: "open", id: 3, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({ type: "autoSettings", id: 4, settingsJson: '{"v":1,"engine":"niho-1","contrast":12}' });
    // 別の写真を開くと、その写真で測る
    await handler({ type: "openWorkingCopy", id: 5, png: new ArrayBuffer(4), metaJson: "{}" });
    await handler({ type: "autoSettings", id: 6, settingsJson: '{"v":1,"engine":"niho-1","base":"w1"}' });
    // 口が文字列以外を返したら error（次の要求は処理する）
    glue.breakResult();
    await handler({ type: "autoSettings", id: 7, settingsJson: "{}" });
    await handler({ type: "render", id: 8, settingsJson: "{}", maxDimension: 1280, interactive: false });

    expect(posted[0]?.message).toEqual({ type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm", auto: true });
    expect(posted[1]?.message).toMatchObject({ type: "error", id: 2, message: "no photo is open" });
    expect(posted[3]?.message).toEqual({
      type: "auto",
      id: 4,
      settingsJson: JSON.stringify({ v: 1, engine: "niho-1", contrast: 12, exposure: 0.35, vibrance: 12 }),
    });
    expect(posted[5]?.message).toMatchObject({ type: "auto", id: 6 });
    expect(glue.autoCalls.map((call) => [glue.developers.indexOf(call.developer), call.settingsJson])).toEqual([
      [0, '{"v":1,"engine":"niho-1","contrast":12}'],
      [1, '{"v":1,"engine":"niho-1","base":"w1"}'],
      [1, "{}"],
    ]);
    expect(posted.slice(6).map((entry) => [entry.message.type, entry.message.id])).toEqual([
      ["error", 7],
      ["frame", 8],
    ]);
    // 描画はしない（測るのは crate の中の代理）
    expect(glue.developers[1]?.renders).toEqual([{ settingsJson: "{}", maxDimension: 1280, interactive: false }]);
  });

  it("Upright の口（niho-photo#46 後半）が Developer にあり遠近も描ければ ready に upright: true を付け、結果の JSON をそのまま返す", async () => {
    const glue = fakeGlue();
    const Base = glue.module.Developer;
    const calls: { settingsJson: string; mode: number }[] = [];
    let result: unknown = '{"perspective":{"vertical":-30},"mode":3,"confidence":0.8,"lines":{"vertical":9,"horizontal":2}}';
    class UprightDeveloper extends Base {
      estimateUpright(settingsJson: string, mode: number) {
        calls.push({ settingsJson, mode });
        return result;
      }
    }
    const geometryGlue = {
      imageSize: () => ({ width: 6000, height: 4000 }),
      rasterDecodeSize: () => 1280,
      geometryOutputSize: () => ({ width: 1280, height: 853 }),
      beforeSettings: (settingsJson: string) => settingsJson,
      validateSettings: () => "[]",
    };
    const { handler, posted } = setup({ module: { ...glue.module, ...geometryGlue, Developer: UprightDeveloper } });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    // 写真を開いていなければ error
    await handler({ type: "estimateUpright", id: 2, settingsJson: "{}", mode: 1 });
    await handler({ type: "open", id: 3, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({ type: "estimateUpright", id: 4, settingsJson: '{"v":1}', mode: 3 });
    // 口が文字列以外を返したら error（次の要求は処理する）
    result = 1;
    await handler({ type: "estimateUpright", id: 5, settingsJson: "{}", mode: 4 });
    await handler({ type: "render", id: 6, settingsJson: "{}", maxDimension: 1280, interactive: false });

    expect(posted[0]?.message).toMatchObject({ type: "ready", perspective: true, upright: true });
    expect(posted[1]?.message).toMatchObject({ type: "error", id: 2, message: "no photo is open" });
    expect(posted[3]?.message).toEqual({
      type: "upright",
      id: 4,
      resultJson: '{"perspective":{"vertical":-30},"mode":3,"confidence":0.8,"lines":{"vertical":9,"horizontal":2}}',
    });
    expect(posted.slice(4).map((entry) => [entry.message.type, entry.message.id])).toEqual([
      ["error", 5],
      ["frame", 6],
    ]);
    expect(calls).toEqual([
      { settingsJson: '{"v":1}', mode: 3 },
      { settingsJson: "{}", mode: 4 },
    ]);
  });

  it("Upright の口があっても遠近（v: 7）を描けない wasm・口の無い glue には upright を付けず、要求は error", async () => {
    const glue = fakeGlue();
    class UprightDeveloper extends glue.module.Developer {
      estimateUpright() {
        return "{}";
      }
    }
    // 遠近を描けない（幾何の口が無い）
    const old = setup({ module: { ...glue.module, Developer: UprightDeveloper } });
    await old.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await old.handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await old.handler({ type: "estimateUpright", id: 3, settingsJson: "{}", mode: 1 });
    expect(old.posted[0]?.message).toEqual({ type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm" });
    expect(old.posted[2]?.message).toMatchObject({ type: "error", id: 3, message: "develop engine cannot estimate upright" });
    // 口の無い glue
    const none = setup();
    await none.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await none.handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await none.handler({ type: "estimateUpright", id: 3, settingsJson: "{}", mode: 1 });
    expect(none.posted[2]?.message).toMatchObject({ type: "error", id: 3, message: "develop engine cannot estimate upright" });
  });

  it("「自動」の口の無い glue では ready に付けず（ほかは使える）、autoSettings の要求は error", async () => {
    const { handler, posted } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler({ type: "open", id: 2, bytes: new ArrayBuffer(4), workingMaxDimension: 1280 });
    await handler({ type: "autoSettings", id: 3, settingsJson: "{}" });
    await handler({ type: "render", id: 4, settingsJson: "{}", maxDimension: 1280, interactive: false });

    expect(posted[0]?.message).toEqual({ type: "ready", id: 1, version: "0.2.0+test", runtime: "wasm" });
    expect(posted[2]?.message).toMatchObject({ type: "error", id: 3, message: "develop engine cannot pick auto settings" });
    expect(posted.map((entry) => entry.message.type)).toEqual(["ready", "opened", "error", "frame"]);
  });

  it("受け取った順に 1 つずつ処理し、前の失敗で後を止めない", async () => {
    const posted: Posted[] = [];
    const glue = fakeGlue();
    let releaseManifest!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseManifest = resolve;
    });
    const slowHandler = createDevelopEngineWorkerHandler({
      fetch: async () => {
        await gate;
        return new Response(JSON.stringify(MANIFEST));
      },
      importModule: async () => glue.module,
      post: (message, transfer) => posted.push({ message, transfer }),
    });

    const pending = [
      slowHandler({ type: "init", id: 1, manifestUrl: MANIFEST_URL }),
      slowHandler({ type: "render", id: 2, settingsJson: "{}", maxDimension: 1280, interactive: false }),
      slowHandler({ type: "open", id: 3, bytes: new ArrayBuffer(1), workingMaxDimension: 1280 }),
    ];
    expect(posted).toEqual([]);
    releaseManifest();
    await Promise.all(pending);

    expect(posted.map((entry) => [entry.message.type, entry.message.id])).toEqual([
      ["ready", 1],
      ["error", 2],
      ["opened", 3],
    ]);
  });
});

describe("threaded wasm selection", () => {
  const threadsJs = `niho_develop_wasm_threads-${DEVELOP_ENGINE_CRATE_VERSION}.js`;
  const threadsWasm = `niho_develop_wasm_threads_bg-${DEVELOP_ENGINE_CRATE_VERSION}.wasm`;
  const manifest = {
    ...MANIFEST,
    threads: { files: { [threadsJs]: { sha256: "11", bytes: 1 }, [threadsWasm]: { sha256: "22", bytes: 1 } } },
  };

  it("isolated Chrome loads the threaded glue and reports the pool size", async () => {
    const single = fakeGlue();
    const threaded = fakeGlue();
    const initThreadPool = vi.fn(async (_count: number) => {});
    const { handler, deps, posted } = setup({ manifest });
    deps.threadsEnvironment = () => ({ isolated: true, hardwareConcurrency: 8, userAgent: "Chrome/120 Safari/537" });
    deps.importModule = vi.fn(async (url) => url.endsWith(threadsJs) ? { ...threaded.module, initThreadPool } : single.module);

    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });

    expect(deps.importModule).toHaveBeenCalledTimes(1);
    expect(deps.importModule).toHaveBeenCalledWith(`https://photo.example.test/develop-engine/${DEVELOP_ENGINE_VERSION}/${threadsJs}`);
    expect(threaded.init).toHaveBeenCalledWith({ module_or_path: `https://photo.example.test/develop-engine/${DEVELOP_ENGINE_VERSION}/${threadsWasm}` });
    expect(initThreadPool).toHaveBeenCalledExactlyOnceWith(4);
    expect(posted[0]?.message).toMatchObject({ type: "ready", runtime: "wasm-threads", wasmThreads: 4 });
  });

  it.each([
    [{ isolated: false, hardwareConcurrency: 8, userAgent: "Chrome/120 Safari/537" }, "no isolation"],
    [{ isolated: true, hardwareConcurrency: 8, userAgent: "Safari/605" }, "Safari"],
    [{ isolated: true, hardwareConcurrency: 8, userAgent: "iPhone CriOS/120" }, "iOS WebKit"],
  ])("uses the single wasm in %s (%s)", async (environment) => {
    const single = fakeGlue();
    const { handler, deps, posted } = setup({ manifest, module: single.module });
    deps.threadsEnvironment = () => environment;

    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });

    expect(deps.importModule).toHaveBeenCalledTimes(1);
    expect(deps.importModule).toHaveBeenCalledWith(`https://photo.example.test/develop-engine/${DEVELOP_ENGINE_VERSION}/niho_develop_wasm-${DEVELOP_ENGINE_CRATE_VERSION}.js`);
    expect(posted[0]?.message).toMatchObject({ type: "ready", runtime: "wasm" });
  });

  it("falls back to the single wasm when the thread pool cannot start", async () => {
    const single = fakeGlue();
    const threaded = fakeGlue();
    const initThreadPool = vi.fn(async () => { throw new Error("shared memory unavailable"); });
    const { handler, deps, posted } = setup({ manifest });
    deps.threadsEnvironment = () => ({ isolated: true, hardwareConcurrency: 8, userAgent: "Chrome/120 Safari/537" });
    deps.importModule = vi.fn(async (url) => url.endsWith(threadsJs) ? { ...threaded.module, initThreadPool } : single.module);

    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });

    expect(deps.importModule).toHaveBeenCalledTimes(2);
    expect(single.init).toHaveBeenCalledOnce();
    expect(posted[0]?.message).toMatchObject({ type: "ready", runtime: "wasm" });
  });
});
