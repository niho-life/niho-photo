import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { DevelopAnalysisHelper } from "./develop-engine-analysis-worker-core";
import { DEVELOP_ENGINE_CRATE_VERSION, DEVELOP_ENGINE_VERSION, developEngineManifestPath } from "./develop-engine-manifest";
import {
  createDevelopEngineWorkerHandler,
  type DevelopEngineExportWorker,
  type DevelopEngineWorkerDeps,
  type DevelopEngineWorkerRequest,
  type DevelopEngineWorkerResponse,
} from "./develop-engine-worker-core";

/**
 * Worker の物理メモリの予算（#155）: 持つ物を bytes で見積もり、予算を超える間だけ 見本 → 先回りの解析 → 保つ写真 → 解析の bytes
 * の順に手放す（開いている写真は残す）。wasm の PC で予算に収まらない書き出しは使い捨ての worker で描き、持つ物は手放さない。
 * 使い捨ての worker で描けなければ、全部手放して同じ Worker で同じ bytes を描く。
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
const SIGNED_META = JSON.stringify({ kind: "raw", baselineEV: -0.25, encoding: { kind: "signed-gamma18-v1", ceiling: 4 } });
/** 補正を全部使った設定（マスク 3 枚・ディテールのノイズ軽減・遠近・修復・レンズ） */
const FULL = JSON.stringify({
  masks: [{}, {}, {}],
  detail: { luminanceNoiseReduction: 30 },
  geometry: { perspective: { vertical: 10 } },
  heal: [{}],
  lens: {},
});
/** 1GiB（PC の totalBytes）を超える wasm の高水位（確保しても触らなければ実メモリは食わない） */
const HIGH_WATER_PAGES = 17_000;

type Posted = { message: DevelopEngineWorkerResponse; transfer: Transferable[] | undefined };

/** 作業コピーの PNG の頭（signature と IHDR の幅・高さ）に名前を続けた bytes（偽の Developer はこの大きさで開く）。 */
function workingCopyPng(name: string, width = 2560, height = 1707): ArrayBuffer {
  const bytes = new Uint8Array(24 + name.length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([...name].map((char) => char.charCodeAt(0)), 24);
  return bytes.buffer;
}

/**
 * 寸法を持つ偽の glue: 作業コピーは IHDR の幅・高さで開き（2560×1707 にできる）、描いた画素は名前・長辺・設定から決まる
 * （同じ要求なら同じ bytes）。`transfer` は解析の受け渡しの口（補助の worker を使える glue）。
 */
function budgetGlue(options: { memory?: WebAssembly.Memory; transfer?: boolean } = {}) {
  const events: string[] = [];
  const developers: FakeDeveloper[] = [];
  class FakeDeveloper {
    readonly name: string;
    readonly width: number;
    readonly height: number;
    constructor(input: Uint8Array, workingMaxDimension: number, opened?: { name: string; width: number; height: number }) {
      this.name = opened?.name ?? `raster ${input.byteLength}`;
      this.width = opened?.width ?? workingMaxDimension;
      this.height = opened?.height ?? workingMaxDimension;
      events.push(`decode ${this.name}`);
      developers.push(this);
    }
    static openWorkingCopy(this: typeof FakeDeveloper, png: Uint8Array, _metaJson: string) {
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
      const name = String.fromCharCode(...png.subarray(24));
      return new this(png, 0, { name, width: view.getUint32(16), height: view.getUint32(20) });
    }
    render(settingsJson: string, maxDimension: number) {
      events.push(`render ${this.name}`);
      return {
        width: 1,
        height: 1,
        rgba: new Uint8ClampedArray([this.name.charCodeAt(0), maxDimension & 0xff, settingsJson.length & 0xff, 255]),
      };
    }
    thumbnail(maxDimension: number) {
      return new FakeDeveloper(new Uint8Array(0), maxDimension, { name: `thumbnail of ${this.name}`, width: 256, height: 171 });
    }
    prepareAnalysis() {
      events.push(`prepare ${this.name}`);
      return true;
    }
    releaseAnalysisAhead() {
      events.push(`release ahead ${this.name}`);
    }
    free() {
      events.push(`free ${this.name}`);
    }
  }
  class TransferDeveloper extends FakeDeveloper {
    exportAnalysis() {
      return new Uint8Array([1, 2, 3]);
    }
    importAnalysis() {
      events.push(`import ${this.name}`);
      return true;
    }
    holdsAnalysis() {
      return false;
    }
  }
  const module = {
    default: vi.fn(async () => (options.memory ? { memory: options.memory } : {})),
    version: () => "0.26.0+test",
    render: vi.fn(),
    exportJpeg: vi.fn((input: Uint8Array, settingsJson: string, maxDimension: number, quality: number) => {
      events.push("exportJpeg");
      return new Uint8Array([0xff, 0xd8, input.byteLength & 0xff, maxDimension & 0xff, settingsJson.length & 0xff, quality]);
    }),
    convertEditSettings: vi.fn(),
    Developer: options.transfer ? TransferDeveloper : FakeDeveloper,
    imageSize: vi.fn(() => ({ width: 6000, height: 4000 })),
    // 切り抜かない書き出しと同じ（要求の長辺。0 は上限）。切り抜いた場合は試験ごとに大きい値を返す
    rasterDecodeSize: vi.fn((_settingsJson: string, _width: number, _height: number, maxDimension: number, cap: number) =>
      maxDimension > 0 ? Math.min(maxDimension, cap) : cap,
    ),
    geometryOutputSize: vi.fn(() => ({ width: 1, height: 1 })),
    beforeSettings: vi.fn((settingsJson: string) => settingsJson),
  };
  return { module, events, developers };
}

const textDigest: DevelopEngineWorkerDeps["digest"] = async (bytes) => Array.from(new Uint8Array(bytes)).join(",");

type ExportWorkerMode = "ok" | "null" | "unavailable" | "error" | "crash" | "silent";

/**
 * 偽の使い捨ての worker: 同じ中身（別の glue）を動かして応答を `receive` に渡す。`null` は作れない、`unavailable` は起きない、
 * `error` は書き出しが失敗する、`crash` は落ちる（null）、`silent` は何も返さない。
 */
function fakeExportWorkers(mode: ExportWorkerMode = "ok") {
  const created: {
    posted: { message: DevelopEngineWorkerRequest; transfer: Transferable[] }[];
    terminate: Mock<() => void>;
    glue: ReturnType<typeof budgetGlue>;
  }[] = [];
  const create = vi.fn((receive: (response: DevelopEngineWorkerResponse | null) => void): DevelopEngineExportWorker | null => {
    if (mode === "null") return null;
    const glue = budgetGlue();
    const inner = createDevelopEngineWorkerHandler({
      fetch: vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 })),
      importModule: vi.fn(async () => glue.module),
      post: (message) => receive(message),
    });
    const entry = { posted: [] as { message: DevelopEngineWorkerRequest; transfer: Transferable[] }[], terminate: vi.fn<() => void>(), glue };
    created.push(entry);
    return {
      post: (message, transfer) => {
        entry.posted.push({ message, transfer });
        if (mode === "silent") return;
        if (message.type === "init") {
          if (mode === "unavailable") receive({ type: "unavailable", id: message.id, reason: "wasm failed" });
          else void inner(message);
          return;
        }
        if (mode === "error") receive({ type: "error", id: message.id, message: "export failed" });
        else if (mode === "crash") receive(null);
        else void inner(message);
      },
      terminate: entry.terminate,
    };
  });
  return { create, created };
}

function setup(
  options: {
    glue?: ReturnType<typeof budgetGlue>;
    exportWorkers?: ReturnType<typeof fakeExportWorkers>;
    extra?: Partial<DevelopEngineWorkerDeps>;
  } = {},
) {
  const glue = options.glue ?? budgetGlue();
  const posted: Posted[] = [];
  const deps: DevelopEngineWorkerDeps = {
    fetch: vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 })),
    importModule: vi.fn(async () => glue.module),
    post: (message, transfer) => posted.push({ message, transfer }),
    digest: textDigest,
    ...(options.exportWorkers ? { createExportWorker: options.exportWorkers.create } : {}),
    ...options.extra,
  };
  return { handler: createDevelopEngineWorkerHandler(deps), posted, glue };
}

const openCopy = (id: number, name: string, width?: number, height?: number, metaJson = "{}") =>
  ({ type: "openWorkingCopy", id, png: workingCopyPng(name, width, height), metaJson }) as const;
const final = (id: number, settingsJson = SIGNED) =>
  ({ type: "render", id, settingsJson, maxDimension: 1280, interactive: false }) as const;
const thumbnail = (id: number) => ({ type: "renderPresetThumbnail", id, settingsJson: "{}", maxDimension: 96 }) as const;
const exportCopy = (id: number, maxDimension: number, settingsJson = "{}", png = workingCopyPng("X")) =>
  ({ type: "exportWorkingCopyJpeg", id, png, metaJson: "{}", settingsJson, maxDimension, quality: 90 }) as const;
const exportOneShot = (id: number, maxDimension: number, settingsJson = "{}") =>
  ({ type: "exportJpeg", id, bytes: new Uint8Array([0xff, 0xd8, 7]).buffer, settingsJson, maxDimension, quality: 90 }) as const;

/** 送った応答の画素・JPEG の bytes。 */
function resultBytes(posted: Posted[], id: number): number[] {
  const message = posted.find((entry) => entry.message.id === id)?.message;
  if (message?.type === "frame") return [...new Uint8Array(message.rgba)];
  if (message?.type === "jpeg") return [...new Uint8Array(message.bytes)];
  throw new Error(`no result for ${id}: ${JSON.stringify(message)}`);
}

/** 何も持たない Worker で同じ書き出しを描いた bytes（どの経路でも同じになるはずの値）。 */
async function referenceBytes(request: ReturnType<typeof exportCopy> | ReturnType<typeof exportOneShot>): Promise<number[]> {
  const { handler, posted } = setup();
  await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
  await handler(request);
  return resultBytes(posted, request.id);
}

/**
 * PC の今の保ち方: A を保ち、B を開いて丁寧に描き、先回りの解析（この Worker）と見本を持つ。`close` が false なら閉じずに B を開く
 * （native は閉じると保つ写真を手放す）。
 */
async function holdTwoPhotos(
  handler: (message: DevelopEngineWorkerRequest) => Promise<void>,
  b = { width: 2560, height: 1707 },
  close = true,
) {
  await handler(openCopy(2, "A"));
  await handler(final(3));
  if (close) await handler({ type: "close", id: 4 });
  await handler(openCopy(5, "B", b.width, b.height));
  await handler(final(6));
  await vi.advanceTimersByTimeAsync(QUIET_MS);
  await handler(thumbnail(7));
}

describe("Worker の物理メモリの予算（#155）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("PC: 2560×1707 の写真 2 枚・先回りの解析・見本を持っても手放さない", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, deviceClass: "pc" });
    await holdTwoPhotos(handler);

    expect(posted.find((entry) => entry.message.id === 5)?.message).toEqual({ type: "opened", id: 5, width: 2560, height: 1707 });
    expect(glue.events).toEqual([
      "decode A",
      "render A",
      // 保つ前に先回りの解析は手放す（#129。予算とは別）
      "release ahead A",
      "decode B",
      "render B",
      "prepare B",
      "decode thumbnail of B",
      "render thumbnail of B",
    ]);
    // 保っている A は開き直してもデコードしない
    await handler(openCopy(8, "A"));
    expect(glue.events.filter((event) => event.startsWith("decode") || event.startsWith("free"))).toEqual([
      "decode A",
      "decode B",
      "decode thumbnail of B",
      "free thumbnail of B",
    ]);
  });

  it("mobile: 次の写真をデコードする前に保っている写真を手放す", async () => {
    const { handler, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, deviceClass: "mobile" });
    await handler(openCopy(2, "A"));
    await handler({ type: "close", id: 3 });
    await handler(openCopy(4, "B"));

    expect(glue.events).toEqual(["decode A", "release ahead A", "free A", "decode B"]);
  });

  it("予算を超える見本の作成で、先回りの解析 → 保つ写真の順に手放し、開いている写真は残す", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    // B（3300×2200）の見本は 443MiB の見積もり。A 150 + B 249 + 先回り 263 と合わせて上限 768MiB を超える
    await holdTwoPhotos(handler, { width: 3300, height: 2200 });

    expect(glue.events.slice(glue.events.indexOf("prepare B"))).toEqual([
      "prepare B",
      "release ahead B",
      "free A",
      "decode thumbnail of B",
      "render thumbnail of B",
    ]);
    expect(glue.events).not.toContain("free B");
    expect(posted.at(-1)?.message).toMatchObject({ type: "frame", id: 7 });
  });

  it("wasm の高水位をさらに上げてしまう書き出しは使い捨ての worker で描き、持つ物は手放さずに元の id で返す", async () => {
    const memory = new WebAssembly.Memory({ initial: HIGH_WATER_PAGES });
    const exportWorkers = fakeExportWorkers();
    const logPerf = vi.fn();
    const { handler, posted, glue } = setup({
      glue: budgetGlue({ memory }),
      exportWorkers,
      extra: { logPerf, now: () => 0 },
    });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, diagnostics: true });
    await holdTwoPhotos(handler);
    const held = glue.events.length;
    // 6000×4000 の作業コピーを補正全部入りで書き出すと、開いている写真だけにしても払った高水位（1,062MiB）を超える
    const big = () => exportCopy(20, 2560, FULL, workingCopyPng("X", 6000, 4000));
    const request = big();

    await handler(request);

    expect(exportWorkers.create).toHaveBeenCalledTimes(1);
    const [worker] = exportWorkers.created;
    expect(worker?.posted[0]).toEqual({
      message: { type: "init", id: 1, manifestUrl: MANIFEST_URL, disposable: true, deviceClass: "pc" },
      transfer: [],
    });
    // 入力は写しを transfer する（元はこの Worker に残す）
    const sent = worker?.posted[1];
    expect(sent?.message).toMatchObject({ type: "exportWorkingCopyJpeg", id: 2, maxDimension: 2560, settingsJson: FULL });
    const sentPng = sent?.message.type === "exportWorkingCopyJpeg" ? sent.message.png : null;
    expect(sent?.transfer).toEqual([sentPng]);
    expect(sentPng).not.toBe(request.png);
    expect([...new Uint8Array(sentPng ?? new ArrayBuffer(0))]).toEqual([...new Uint8Array(request.png)]);
    expect(worker?.glue.events).toEqual(["decode X", "render X", "free X"]);
    expect(worker?.terminate).toHaveBeenCalledTimes(1);

    // この Worker は何も手放さず、何もデコードしない
    expect(glue.events.slice(held)).toEqual([]);
    const result = posted.at(-1);
    expect(result?.message).toMatchObject({ type: "frame", id: 20, width: 1, height: 1 });
    expect(result?.transfer).toEqual([result?.message.type === "frame" ? result.message.rgba : null]);
    expect(resultBytes(posted, 20)).toEqual(await referenceBytes(big()));
    expect(logPerf).toHaveBeenCalledWith({
      stage: "exportWorker",
      durationMs: 0,
      wasmMemoryBytes: HIGH_WATER_PAGES * 65_536,
      status: "ok",
    });
  });

  it("高水位が予算を超えていても、払った高水位の内に収まる書き出しは同じ Worker で描き、何も手放さない", async () => {
    const memory = new WebAssembly.Memory({ initial: HIGH_WATER_PAGES });
    const exportWorkers = fakeExportWorkers();
    const { handler, posted, glue } = setup({ glue: budgetGlue({ memory }), exportWorkers });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await holdTwoPhotos(handler);
    const held = glue.events.length;

    await handler(exportCopy(20, 2048));

    expect(exportWorkers.create).not.toHaveBeenCalled();
    expect(glue.events.slice(held)).toEqual(["decode X", "render X", "free X"]);
    expect(resultBytes(posted, 20)).toEqual(await referenceBytes(exportCopy(20, 2048)));
  });

  it("高水位が低くても、開いている写真と書き出しが totalBytes を超えれば PC は使い捨ての worker、mobile は全部手放して同じ Worker", async () => {
    const pcWorkers = fakeExportWorkers();
    const pc = setup({ exportWorkers: pcWorkers });
    await pc.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await holdTwoPhotos(pc.handler);
    const held = pc.glue.events.length;
    // 6000×4000 の JPEG を補正を全部使って長辺 4096 で（1.6GiB の見積もり）
    await pc.handler(exportOneShot(20, 4096, FULL));

    expect(pcWorkers.create).toHaveBeenCalledTimes(1);
    expect(pcWorkers.created[0]?.glue.events).toEqual(["exportJpeg"]);
    expect(pc.glue.events.slice(held)).toEqual([]);
    expect(pc.posted.at(-1)?.message).toMatchObject({ type: "jpeg", id: 20 });
    const expected = await referenceBytes(exportOneShot(20, 4096, FULL));
    expect(resultBytes(pc.posted, 20)).toEqual(expected);

    const mobileWorkers = fakeExportWorkers();
    const mobile = setup({ exportWorkers: mobileWorkers });
    await mobile.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, deviceClass: "mobile" });
    await mobile.handler(openCopy(2, "B"));
    await mobile.handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    await mobile.handler(thumbnail(4));
    const mobileHeld = mobile.glue.events.length;
    await mobile.handler(exportOneShot(20, 4096, FULL));

    expect(mobileWorkers.create).not.toHaveBeenCalled();
    expect(mobile.glue.events.slice(mobileHeld)).toEqual(["free thumbnail of B", "release ahead B", "exportJpeg"]);
    expect(resultBytes(mobile.posted, 20)).toEqual(expected);
  });

  it.each<ExportWorkerMode>(["null", "unavailable", "error", "crash", "silent"])(
    "使い捨ての worker が %s なら、持つ物を全部手放して同じ Worker で同じ bytes を描く",
    async (mode) => {
      const memory = new WebAssembly.Memory({ initial: HIGH_WATER_PAGES });
      const exportWorkers = fakeExportWorkers(mode);
      const logPerf = vi.fn();
      const { handler, posted, glue } = setup({
        glue: budgetGlue({ memory }),
        exportWorkers,
        extra: { logPerf, now: () => 0 },
      });
      await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, diagnostics: true });
      await holdTwoPhotos(handler);
      const held = glue.events.length;

      // 開いている写真だけにしても払った高水位を超える書き出し（6000×4000・補正全部入り）
      const big = () => exportCopy(20, 2560, FULL, workingCopyPng("X", 6000, 4000));
      const done = handler(big());
      // `ready` が来ない worker は 20 秒で見切る
      if (mode === "silent") await vi.advanceTimersByTimeAsync(20_000);
      await done;

      expect(exportWorkers.create).toHaveBeenCalledTimes(1);
      for (const worker of exportWorkers.created) expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(glue.events.slice(held)).toEqual([
        "free thumbnail of B",
        "release ahead B",
        "free A",
        "decode X",
        "render X",
        "free X",
      ]);
      expect(glue.events).not.toContain("free B");
      expect(resultBytes(posted, 20)).toEqual(await referenceBytes(big()));
      expect(logPerf).toHaveBeenCalledWith(expect.objectContaining({ stage: "exportWorker", status: "error" }));
    },
  );

  it("切り抜いた JPEG は切り抜きが届く大きさでデコードするので、見積もりもその大きさで数える", async () => {
    const exportWorkers = fakeExportWorkers();
    const { handler, posted, glue } = setup({ exportWorkers });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await holdTwoPhotos(handler);

    // 切り抜かない: 6000×4000 を補正全部入りで長辺 2048（421MiB）は、開いている写真と合わせて 1GiB に収まる → 同じ Worker
    await handler(exportOneShot(20, 2048, FULL));
    expect(exportWorkers.create).not.toHaveBeenCalled();

    // 中央の半分を切り抜くと、長辺 2048 に届くよう 4096 でデコードする（1,685MiB）→ 使い捨ての worker
    glue.module.rasterDecodeSize.mockReturnValueOnce(4096);
    await handler(exportOneShot(21, 2048, FULL));
    expect(glue.module.rasterDecodeSize).toHaveBeenLastCalledWith(FULL, 6000, 4000, 2048, 4096);
    expect(exportWorkers.create).toHaveBeenCalledTimes(1);
    expect(resultBytes(posted, 21)).toEqual(await referenceBytes(exportOneShot(21, 2048, FULL)));
  });

  it("予算に収まる書き出しは同じ Worker で描き、2048 でも 4096 でも持つ物を手放さない", async () => {
    const exportWorkers = fakeExportWorkers();
    const { handler, posted, glue } = setup({ glue: budgetGlue({ memory: new WebAssembly.Memory({ initial: 1 }) }), exportWorkers });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await holdTwoPhotos(handler);
    const held = glue.events.length;

    // 作業コピー 2048（206MiB）・6000×4000 の JPEG 4096（224MiB）は、持つ物（PC 725MiB）と合わせて 1GiB に収まる
    await handler(exportCopy(20, 2048));
    await handler(exportOneShot(21, 4096));
    await handler(openCopy(22, "A"));

    expect(exportWorkers.create).not.toHaveBeenCalled();
    expect(glue.events.slice(held)).toEqual([
      "decode X",
      "render X",
      "free X",
      "exportJpeg",
      // A を開き直すとき、B を保つ前に見本と先回りの解析を手放す（#129。予算とは別）
      "free thumbnail of B",
      "release ahead B",
    ]);
    expect(resultBytes(posted, 20)).toEqual(await referenceBytes(exportCopy(20, 2048)));
    expect(resultBytes(posted, 21)).toEqual(await referenceBytes(exportOneShot(21, 4096)));
  });

  it("native: 収まらない書き出しの前に 見本 → 先回りの解析 → 保つ写真 の順に手放し、使い捨ての worker は作らない", async () => {
    const exportWorkers = fakeExportWorkers();
    const glue = budgetGlue();
    const { handler, posted } = setup({
      glue,
      exportWorkers,
      extra: { createNativeGlue: () => glue.module },
    });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, preferNative: true });
    expect(posted[0]?.message).toMatchObject({ type: "ready", runtime: "native" });
    await holdTwoPhotos(handler, undefined, false);
    const held = glue.events.length;

    // 作業コピー 2560 を補正を全部使って（809MiB）: 持つ物 725MiB と合わせて 1GiB を超える
    await handler(exportCopy(20, 2560, FULL));

    expect(exportWorkers.create).not.toHaveBeenCalled();
    expect(glue.events.slice(held)).toEqual([
      "free thumbnail of B",
      "release ahead B",
      "free A",
      "decode X",
      "render X",
      "free X",
    ]);
    expect(glue.events).not.toContain("free B");
    expect(resultBytes(posted, 20)).toEqual(await referenceBytes(exportCopy(20, 2560, FULL)));
  });

  it("補助の worker: 足すと totalBytes を超える写真では作らず、この Worker の prepareAnalysis も呼ばない", async () => {
    const helper: DevelopAnalysisHelper = { post: vi.fn(), terminate: vi.fn() };
    const createAnalysisHelper = vi.fn(() => helper);
    const { handler, glue } = setup({ glue: budgetGlue({ transfer: true }), extra: { createAnalysisHelper } });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    // 6000×4000 の作業コピー（824MiB）に補助の worker（1,053MiB）を足すと 1GiB を超える
    await handler(openCopy(2, "W", 6000, 4000, SIGNED_META));
    await handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS * 3);

    expect(createAnalysisHelper).not.toHaveBeenCalled();
    expect(glue.events).not.toContain("prepare W");
  });

  it("補助の worker を作れない写真で、この Worker に戻って作るのは何も手放さずに収まるときだけ", async () => {
    for (const [size, prepares] of [
      [{ width: 2560, height: 1707 }, true],
      // 4000×3000: 補助の worker（526MiB）は 1GiB に収まるが、この Worker の先回り（435MiB）は上限 768MiB に収まらない
      [{ width: 4000, height: 3000 }, false],
    ] as const) {
      const createAnalysisHelper = vi.fn(() => null);
      const { handler, glue } = setup({ glue: budgetGlue({ transfer: true }), extra: { createAnalysisHelper } });
      await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
      await handler(openCopy(2, "W", size.width, size.height, SIGNED_META));
      await handler(final(3));
      await vi.advanceTimersByTimeAsync(QUIET_MS * 3);

      expect(createAnalysisHelper).toHaveBeenCalledTimes(1);
      expect(glue.events.includes("prepare W")).toBe(prepares);
      expect(glue.events).not.toContain("free W");
    }
  });

  it("init の disposable: true は preferNative を無視して wasm を起こし、補助の worker・使い捨ての worker・保存先を使わない", async () => {
    const glue = budgetGlue({ memory: new WebAssembly.Memory({ initial: HIGH_WATER_PAGES }), transfer: true });
    const exportWorkers = fakeExportWorkers();
    const createNativeGlue = vi.fn(() => glue.module);
    const createAnalysisHelper = vi.fn(() => null);
    const analysisStore = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
    const { handler, posted } = setup({
      glue,
      exportWorkers,
      extra: { createNativeGlue, createAnalysisHelper, analysisStore },
    });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, preferNative: true, disposable: true });
    expect(posted[0]?.message).toMatchObject({ type: "ready", runtime: "wasm" });
    expect(posted[0]?.message).not.toHaveProperty("wasmThreads");
    expect(createNativeGlue).not.toHaveBeenCalled();

    await handler(openCopy(2, "W", 2560, 1707, SIGNED_META));
    await handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS * 3);
    await handler(exportCopy(4, 2560, FULL));

    expect(createAnalysisHelper).not.toHaveBeenCalled();
    expect(exportWorkers.create).not.toHaveBeenCalled();
    expect(analysisStore.get).not.toHaveBeenCalled();
    expect(analysisStore.put).not.toHaveBeenCalled();
    expect(posted.at(-1)?.message).toMatchObject({ type: "frame", id: 4 });
  });
});
