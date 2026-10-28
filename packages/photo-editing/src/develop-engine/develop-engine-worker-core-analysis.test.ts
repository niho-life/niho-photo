import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEVELOP_ENGINE_CRATE_VERSION, DEVELOP_ENGINE_VERSION, developEngineManifestPath } from "./develop-engine-manifest";
import {
  createDevelopEngineWorkerHandler,
  type DevelopEngineWorkerDeps,
  type DevelopEngineWorkerResponse,
} from "./develop-engine-worker-core";

/**
 * Worker が H/S の解析を先に作る（#129）: 丁寧に描いた設定と、同梱のプリセットを当てた設定の解析（engine・CNR・ノイズ軽減）を、
 * 通常の要求が 500ms 来なかったら 1 件ずつ `Developer.prepareAnalysis` で作る。通常の要求が来たら始めない。写真を替えると捨てる。
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
const QUIET_MS = 500;
const SIGNED = '{"engine":"niho-11","colorNoiseReduction":0,"exposure":0}';

type Posted = { message: DevelopEngineWorkerResponse; transfer: Transferable[] | undefined };

/** 同梱のプリセット 3 本（colorful だけ CNR 25）と、`prepareAnalysis` のある Developer。 */
function analysisGlue(options: { prepareAnalysis?: boolean } = {}) {
  const prepared: { developer: number; settingsJson: string }[] = [];
  const developers: FakeDeveloper[] = [];
  class FakeDeveloper {
    readonly width = 4;
    readonly height = 2;
    readonly index: number;
    constructor() {
      this.index = developers.length;
      developers.push(this);
    }
    static openWorkingCopy() {
      return new FakeDeveloper();
    }
    render() {
      return { width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]) };
    }
    asShotWhite() {
      return '{"temperature":5500,"tint":4}';
    }
    free() {}
  }
  class AnalysisDeveloper extends FakeDeveloper {
    prepareAnalysis(settingsJson: string) {
      prepared.push({ developer: this.index, settingsJson });
      return true;
    }
  }
  const presets = [
    { id: "niho-bluesky2", cnr: 0 },
    { id: "niho-pastel", cnr: 0 },
    { id: "niho-colorful", cnr: 25 },
  ];
  const module = {
    default: vi.fn(async () => ({})),
    version: () => "0.26.0+test",
    render: vi.fn(),
    exportJpeg: vi.fn(() => new Uint8Array([0xff, 0xd8, 0])),
    convertEditSettings: vi.fn(),
    Developer: options.prepareAnalysis === false ? FakeDeveloper : AnalysisDeveloper,
    builtinPresets: () => JSON.stringify(presets.map((preset) => ({ id: preset.id, name: preset.id, xmp: preset.id }))),
    applyPreset: vi.fn((xmp: string, baseJson: string, amount: number, asShotJson?: string) => {
      const cnr = presets.find((preset) => preset.id === xmp)?.cnr ?? 0;
      expect(amount).toBe(1);
      expect(asShotJson).toBe('{"temperature":5500,"tint":4}');
      return JSON.stringify({ settings: { ...JSON.parse(baseJson), preset: xmp, highlights: -50, colorNoiseReduction: cnr } });
    }),
  };
  return { module, prepared, developers };
}

function setup(glue = analysisGlue()) {
  const posted: Posted[] = [];
  const deps: DevelopEngineWorkerDeps = {
    fetch: vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 })),
    importModule: vi.fn(async () => glue.module),
    post: (message, transfer) => posted.push({ message, transfer }),
  };
  return { handler: createDevelopEngineWorkerHandler(deps), posted, glue };
}

const final = (id: number, settingsJson = SIGNED) =>
  ({ type: "render", id, settingsJson, maxDimension: 1280, interactive: false }) as const;
const openCopy = (id: number) => ({ type: "openWorkingCopy", id, png: new ArrayBuffer(4), metaJson: "{}" }) as const;

describe("Worker が H/S の解析を先に作る（#129）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("丁寧に描いた後、静かな間に今の設定、次に違う CNR のプリセット（colorful）の解析を 1 件ずつ作る", async () => {
    const { handler, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3));

    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(glue.prepared).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(glue.prepared).toEqual([{ developer: 0, settingsJson: SIGNED }]);
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(glue.prepared).toHaveLength(2);
    expect(JSON.parse(glue.prepared[1]?.settingsJson ?? "{}")).toMatchObject({ preset: "niho-colorful", colorNoiseReduction: 25 });
    // bluesky2 / pastel は今の設定と同じ解析なので作らない。終わったら何もしない
    await vi.advanceTimersByTimeAsync(QUIET_MS * 4);
    expect(glue.prepared).toHaveLength(2);

    // 同じ解析の設定を描き直しても作り直さない
    await handler(final(4, '{"engine":"niho-11","colorNoiseReduction":0,"exposure":0.3}'));
    await vi.advanceTimersByTimeAsync(QUIET_MS * 4);
    expect(glue.prepared).toHaveLength(2);
  });

  it("通常の要求が来ている間は始めず、静かになってから作る。drag の描画では作らない", async () => {
    const { handler, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler({ type: "render", id: 3, settingsJson: SIGNED, maxDimension: 1280, interactive: true });
    await vi.advanceTimersByTimeAsync(QUIET_MS * 2);
    expect(glue.prepared).toEqual([]);

    await handler(final(4));
    await vi.advanceTimersByTimeAsync(QUIET_MS - 100);
    await handler({ type: "render", id: 5, settingsJson: SIGNED, maxDimension: 1280, interactive: true });
    await vi.advanceTimersByTimeAsync(QUIET_MS - 100);
    expect(glue.prepared).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(glue.prepared).toEqual([{ developer: 0, settingsJson: SIGNED }]);
  });

  it("写真を替えたら前の写真の残りは捨て、新しい写真を描いてから作る", async () => {
    const { handler, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(glue.prepared.map((entry) => entry.developer)).toEqual([0]);

    await handler(openCopy(4));
    await vi.advanceTimersByTimeAsync(QUIET_MS * 4);
    expect(glue.prepared.map((entry) => entry.developer)).toEqual([0]);
    await handler(final(5));
    await vi.advanceTimersByTimeAsync(QUIET_MS * 2);
    expect(glue.prepared.map((entry) => entry.developer)).toEqual([0, 1, 1]);
  });

  it("解析の種類は今の写真の分ともう 1 つまで（CNR 40 の写真では bluesky2 の CNR 0 まで）", async () => {
    const { handler, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3, '{"engine":"niho-11","colorNoiseReduction":40}'));
    await vi.advanceTimersByTimeAsync(QUIET_MS * 6);

    expect(glue.prepared.map((entry) => JSON.parse(entry.settingsJson).colorNoiseReduction)).toEqual([40, 0]);
  });

  it("prepareAnalysis の無い glue では何もしない", async () => {
    const { handler, glue } = setup(analysisGlue({ prepareAnalysis: false }));
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS * 4);

    expect(glue.prepared).toEqual([]);
    expect(glue.module.applyPreset).not.toHaveBeenCalled();
  });
});
