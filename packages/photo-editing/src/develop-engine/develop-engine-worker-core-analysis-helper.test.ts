import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  createDevelopAnalysisWorkerHandler,
  type DevelopAnalysisHelper,
  type DevelopAnalysisHelperRequest,
  type DevelopAnalysisHelperResponse,
} from "./develop-engine-analysis-worker-core";
import { DEVELOP_ENGINE_CRATE_VERSION, DEVELOP_ENGINE_VERSION, developEngineManifestPath } from "./develop-engine-manifest";
import {
  createDevelopEngineWorkerHandler,
  type DevelopEngineWorkerDeps,
  type DevelopEngineWorkerResponse,
} from "./develop-engine-worker-core";

/**
 * 先回りを補助の worker で作る（#155）: 描画の worker は signed RAW の作業コピーを開いた入力の写しを補助の worker に渡し、補助の
 * worker が作った解析の bytes を `importAnalysis` で取り込むだけにする。補助の worker が計算している間も描画の列は待たない。写真を
 * 替える・閉じる・先回りが尽きたら補助の worker を終わらせ、遅れた結果は捨てる。補助の worker が無い・口が無い・失敗したら、
 * その写真では #129 の先回り（`Developer.prepareAnalysis`）へ戻る。
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
const VERSION = "0.26.0+test";
const QUIET_MS = 500;
const SIGNED = '{"engine":"niho-11","colorNoiseReduction":0,"exposure":0}';
const SIGNED_META = JSON.stringify({ kind: "raw", baselineEV: -0.25, encoding: { kind: "signed-gamma18-v1", ceiling: 4 } });

type StartRequest = Extract<DevelopAnalysisHelperRequest, { type: "start" }>;
type AnalysisRequest = Extract<DevelopAnalysisHelperRequest, { type: "analysis" }>;

const PRESETS = [
  { id: "niho-bluesky2", cnr: 0 },
  { id: "niho-pastel", cnr: 0 },
  { id: "niho-colorful", cnr: 25 },
];

/** 同梱のプリセット 3 本（colorful だけ CNR 25）と、解析の受け渡しの口（`transfer: false` で無い glue）のある Developer。 */
function transferGlue(
  options: {
    transfer?: boolean;
    holds?: (settingsJson: string) => boolean;
    trackHeldSlot?: boolean;
    importThrows?: boolean;
    importFails?: (developer: number, bytes: number[]) => boolean;
  } = {},
) {
  const prepared: { developer: number; settingsJson: string }[] = [];
  const imported: { developer: number; bytes: number[] }[] = [];
  const importAttempts: number[] = [];
  const events: string[] = [];
  const heldCnr = new Map<number, number>();
  const developers: FakeDeveloper[] = [];
  class FakeDeveloper {
    readonly width = 4;
    readonly height = 2;
    readonly index: number;
    constructor() {
      this.index = developers.length;
      developers.push(this);
    }
    static openWorkingCopy(this: new () => FakeDeveloper) {
      return new this();
    }
    render() {
      events.push(`render:${this.index}`);
      return { width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]) };
    }
    asShotWhite() {
      return '{"temperature":5500,"tint":4}';
    }
    prepareAnalysis(settingsJson: string) {
      prepared.push({ developer: this.index, settingsJson });
      return true;
    }
    free() {}
  }
  class TransferDeveloper extends FakeDeveloper {
    exportAnalysis() {
      throw new Error("the editor's worker does not make the analysis itself");
    }
    importAnalysis(bytes: Uint8Array) {
      const values = [...bytes];
      importAttempts.push(this.index);
      events.push(`import:${this.index}`);
      if (options.importThrows || options.importFails?.(this.index, values)) {
        throw new Error("analysis_transfer_failed: the analysis of another photo");
      }
      if (options.trackHeldSlot && values[0] !== undefined) heldCnr.set(this.index, values[0]);
      imported.push({ developer: this.index, bytes: values });
      return true;
    }
    holdsAnalysis(settingsJson: string) {
      if (options.holds) return options.holds(settingsJson);
      if (options.trackHeldSlot) return heldCnr.get(this.index) === JSON.parse(settingsJson).colorNoiseReduction;
      return false;
    }
  }
  const module = {
    default: vi.fn(async () => ({})),
    version: () => VERSION,
    render: vi.fn(),
    exportJpeg: vi.fn(() => new Uint8Array([0xff, 0xd8, 0])),
    convertEditSettings: vi.fn(),
    Developer: options.transfer === false ? FakeDeveloper : TransferDeveloper,
    builtinPresets: () => JSON.stringify(PRESETS.map((preset) => ({ id: preset.id, name: preset.id, xmp: preset.id }))),
    applyPreset: vi.fn((xmp: string, baseJson: string) => {
      const cnr = PRESETS.find((preset) => preset.id === xmp)?.cnr ?? 0;
      return JSON.stringify({ settings: { ...JSON.parse(baseJson), preset: xmp, highlights: -50, colorNoiseReduction: cnr } });
    }),
  };
  return { module, prepared, imported, importAttempts, events, developers };
}

type FakeHelper = {
  receive: (response: DevelopAnalysisHelperResponse | null) => void;
  posted: { message: DevelopAnalysisHelperRequest; transfer: Transferable[] }[];
  post: DevelopAnalysisHelper["post"];
  terminate: Mock<() => void>;
};

/** 偽の補助の worker（`receive` で応答を返す）。`fail` なら作れない。 */
function fakeHelpers(options: { fail?: boolean } = {}) {
  const created: FakeHelper[] = [];
  const create = vi.fn((receive: (response: DevelopAnalysisHelperResponse | null) => void): DevelopAnalysisHelper | null => {
    if (options.fail) return null;
    const helper: FakeHelper = {
      receive,
      posted: [],
      post: (message, transfer) => {
        helper.posted.push({ message, transfer });
      },
      terminate: vi.fn<() => void>(),
    };
    created.push(helper);
    return helper;
  });
  /** 補助の worker に頼んだ解析（`start` を除く） */
  const requests = (helper: FakeHelper | undefined) =>
    (helper?.posted ?? []).map((entry) => entry.message).filter((message): message is AnalysisRequest => message.type === "analysis");
  return { created, create, requests };
}

function setup(
  glue = transferGlue(),
  helpers: ReturnType<typeof fakeHelpers> | null = fakeHelpers(),
  extra: Partial<Pick<DevelopEngineWorkerDeps, "digest" | "analysisStore">> = {},
) {
  const posted: DevelopEngineWorkerResponse[] = [];
  const deps: DevelopEngineWorkerDeps = {
    fetch: vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 })),
    importModule: vi.fn(async () => glue.module),
    post: (message) => posted.push(message),
    ...(helpers ? { createAnalysisHelper: helpers.create } : {}),
    ...extra,
  };
  return { handler: createDevelopEngineWorkerHandler(deps), posted, glue, helpers };
}

const final = (id: number, settingsJson = SIGNED) =>
  ({ type: "render", id, settingsJson, maxDimension: 1280, interactive: false }) as const;
const openCopy = (id: number, metaJson = SIGNED_META) =>
  ({ type: "openWorkingCopy", id, png: new Uint8Array([id, 1, 2]).buffer, metaJson }) as const;
const bytesOf = (...values: number[]) => new Uint8Array(values).buffer;
const cnrOf = (request: AnalysisRequest | undefined) => JSON.parse(request?.settingsJson ?? "{}").colorNoiseReduction;

describe("先回りを補助の worker で作る（#155）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("最初の 1 件で補助の worker を作って入力の写しを渡し、返った bytes を取り込む。尽きたら終わらせる", async () => {
    const { handler, glue, helpers } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3));
    expect(helpers?.create).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const helper = helpers?.created[0];
    expect(helpers?.created).toHaveLength(1);
    const start = helper?.posted[0];
    expect(start?.message).toMatchObject({ type: "start", manifestUrl: MANIFEST_URL, version: VERSION, metaJson: SIGNED_META });
    const png = (start?.message as StartRequest).png;
    expect([...new Uint8Array(png)]).toEqual([2, 1, 2]);
    expect(start?.transfer).toEqual([png]);
    const [first] = helpers?.requests(helper) ?? [];
    expect(first?.settingsJson).toBe(SIGNED);
    expect(glue.prepared).toEqual([]);

    helper?.receive({ type: "analysis", id: first?.id ?? 0, bytes: bytesOf(7, 8) });
    await vi.advanceTimersByTimeAsync(0);
    expect(glue.imported).toEqual([{ developer: 0, bytes: [7, 8] }]);

    // 次の 1 件（colorful の CNR 25）は同じ補助の worker に頼む（写真を開き直さない）
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const second = helpers?.requests(helper)[1];
    expect(cnrOf(second)).toBe(25);
    expect(helper?.posted.filter((entry) => entry.message.type === "start")).toHaveLength(1);
    helper?.receive({ type: "analysis", id: second?.id ?? 0, bytes: bytesOf(9) });
    await vi.advanceTimersByTimeAsync(0);
    expect(glue.imported.map((entry) => entry.bytes)).toEqual([[7, 8], [9]]);

    expect(helper?.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(helper?.terminate).toHaveBeenCalledTimes(1);
    expect(helpers?.created).toHaveLength(1);
    expect(glue.prepared).toEqual([]);
  });

  it("補助の worker が計算している間に来た描画はすぐ描き、結果はその後に取り込む", async () => {
    const { handler, glue, helpers, posted } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const helper = helpers?.created[0];
    const [request] = helpers?.requests(helper) ?? [];
    expect(request).toBeDefined();

    // 結果を待たずに描く
    await handler({ type: "render", id: 4, settingsJson: SIGNED, maxDimension: 1280, interactive: true });
    await handler(final(5));
    expect(posted.filter((message) => message.type === "frame").map((message) => message.id)).toEqual([3, 4, 5]);
    expect(glue.imported).toEqual([]);
    // 待っている間は次の 1 件を頼まない
    await vi.advanceTimersByTimeAsync(QUIET_MS * 4);
    expect(helpers?.requests(helper)).toHaveLength(1);

    helper?.receive({ type: "analysis", id: request?.id ?? 0, bytes: bytesOf(1) });
    await vi.advanceTimersByTimeAsync(0);
    expect(glue.imported).toEqual([{ developer: 0, bytes: [1] }]);
  });

  it("Developer が LRU から eviction されても compact 解析 bytes を残し、同じ写真の再 open では描画前に import する", async () => {
    const glue = transferGlue({
      holds: () => {
        throw new Error("holdsAnalysis unavailable");
      },
    });
    const digest = vi.fn(async (bytes: ArrayBuffer) => String(new Uint8Array(bytes)[0]));
    const { handler, helpers } = setup(glue, fakeHelpers(), { digest });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const helper = helpers?.created[0];
    const [request] = helpers?.requests(helper) ?? [];
    helper?.receive({ type: "analysis", id: request?.id ?? 0, bytes: bytesOf(7, 8) });
    await vi.advanceTimersByTimeAsync(0);

    // B, C と開いて A を HELD_PHOTO_LIMIT=2 の Developer LRU から追い出す。
    await handler(openCopy(4));
    await handler(openCopy(6));
    expect(glue.developers[0]).toBeDefined();
    await handler(openCopy(2));
    expect(glue.developers).toHaveLength(4);

    const before = glue.events.length;
    await handler(final(7));
    await handler({ type: "render", id: 8, settingsJson: SIGNED, maxDimension: 1280, interactive: true });
    expect(glue.events.slice(before)).toEqual(["import:3", "render:3", "import:3", "render:3"]);
    expect(glue.imported.slice(-2)).toEqual([
      { developer: 3, bytes: [7, 8] },
      { developer: 3, bytes: [7, 8] },
    ]);
  });

  it("通常の 2048px 書き出しは compact 解析を直後も再利用し、大きい書き出しでも Developer eviction 後まで保つ", async () => {
    const glue = transferGlue({ holds: () => false });
    const digest = vi.fn(async (bytes: ArrayBuffer) => String(new Uint8Array(bytes)[0]));
    const { handler, helpers } = setup(glue, fakeHelpers(), { digest });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const helper = helpers?.created[0];
    const [request] = helpers?.requests(helper) ?? [];
    helper?.receive({ type: "analysis", id: request?.id ?? 0, bytes: bytesOf(7, 8) });
    await vi.advanceTimersByTimeAsync(0);

    await handler({
      type: "exportWorkingCopyJpeg",
      id: 4,
      png: new Uint8Array([9, 1, 2]).buffer,
      metaJson: SIGNED_META,
      settingsJson: SIGNED,
      maxDimension: 2048,
      quality: 90,
    });
    const afterNormalExport = glue.events.length;
    await handler({ type: "render", id: 40, settingsJson: SIGNED, maxDimension: 1280, interactive: true });
    expect(glue.events.slice(afterNormalExport)).toEqual(["import:0", "render:0"]);

    await handler({
      type: "exportWorkingCopyJpeg",
      id: 41,
      png: new Uint8Array([10, 1, 2]).buffer,
      metaJson: SIGNED_META,
      settingsJson: SIGNED,
      maxDimension: 2049,
      quality: 90,
    });
    // B, C で A の Developer を eviction し、A を新しく開き直す。
    await handler(openCopy(5));
    await handler(openCopy(6));
    await handler(openCopy(2));
    const before = glue.events.length;
    await handler(final(7));

    expect(glue.events.slice(before)).toEqual(["import:5", "render:5"]);
    expect(glue.imported.at(-1)).toEqual({ developer: 5, bytes: [7, 8] });
  });

  it("mobile の admission は kept Developer を compact 解析より先に捨て、開き直した描画へ解析を戻す", async () => {
    const glue = transferGlue({ holds: () => false });
    const digest = vi.fn(async (bytes: ArrayBuffer) => String(new Uint8Array(bytes)[0]));
    const { handler, helpers } = setup(glue, fakeHelpers(), { digest });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, deviceClass: "mobile" });
    await handler(openCopy(2));
    await handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const helper = helpers?.created[0];
    const [request] = helpers?.requests(helper) ?? [];
    helper?.receive({ type: "analysis", id: request?.id ?? 0, bytes: bytesOf(7, 8) });
    await vi.advanceTimersByTimeAsync(0);

    await handler(openCopy(4));
    await handler(openCopy(2));
    const before = glue.events.length;
    await handler(final(5));

    expect(glue.events.slice(before)).toEqual(["import:2", "render:2"]);
    expect(glue.imported.at(-1)).toEqual({ developer: 2, bytes: [7, 8] });
  });

  it("同じ Developer の1件枠で A→B→A と戻れば再 import し、同じ A の連続 drag では import を繰り返さない", async () => {
    const glue = transferGlue({ trackHeldSlot: true });
    const digest = vi.fn(async (bytes: ArrayBuffer) => String(new Uint8Array(bytes)[0]));
    const { handler, helpers } = setup(glue, fakeHelpers(), { digest });
    const cnr25 = '{"engine":"niho-11","colorNoiseReduction":25,"exposure":0}';
    const drag = (id: number, settingsJson: string) =>
      ({ type: "render", id, settingsJson, maxDimension: 1280, interactive: true }) as const;
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3));

    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const helper = helpers?.created[0];
    const first = helpers?.requests(helper)[0];
    helper?.receive({ type: "analysis", id: first?.id ?? 0, bytes: bytesOf(0) });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const second = helpers?.requests(helper)[1];
    expect(cnrOf(second)).toBe(25);
    helper?.receive({ type: "analysis", id: second?.id ?? 0, bytes: bytesOf(25) });
    await vi.advanceTimersByTimeAsync(0);

    const before = glue.imported.length;
    await handler(drag(4, SIGNED));
    await handler(drag(5, cnr25));
    await handler(drag(6, SIGNED));
    expect(glue.imported.slice(before).map((entry) => entry.bytes)).toEqual([[0], [25], [0]]);

    const afterSwitches = glue.imported.length;
    await handler(drag(7, SIGNED));
    await handler(drag(8, SIGNED));
    expect(glue.imported).toHaveLength(afterSwitches);
  });

  it("eviction 後の compact bytes を import できなければ entry を捨て、同じ描画を従来どおり再計算で続ける", async () => {
    const glue = transferGlue({ importFails: (developer) => developer === 3 });
    const digest = vi.fn(async (bytes: ArrayBuffer) => String(new Uint8Array(bytes)[0]));
    const { handler, helpers } = setup(glue, fakeHelpers(), { digest });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const helper = helpers?.created[0];
    const [request] = helpers?.requests(helper) ?? [];
    helper?.receive({ type: "analysis", id: request?.id ?? 0, bytes: bytesOf(7, 8) });
    await vi.advanceTimersByTimeAsync(0);

    await handler(openCopy(4));
    await handler(openCopy(6));
    await handler(openCopy(2));
    const before = glue.events.length;
    await handler(final(7));
    await handler(final(8));

    expect(glue.events.slice(before)).toEqual(["import:3", "render:3", "render:3"]);
    expect(glue.importAttempts.filter((developer) => developer === 3)).toHaveLength(1);
  });

  it("写真を替えたら補助の worker を終わらせ、遅れて届いた結果は捨てる。新しい写真には新しい補助の worker を作る", async () => {
    const { handler, glue, helpers } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const old = helpers?.created[0];
    const [request] = helpers?.requests(old) ?? [];

    await handler(openCopy(4));
    expect(old?.terminate).toHaveBeenCalledTimes(1);
    old?.receive({ type: "analysis", id: request?.id ?? 0, bytes: bytesOf(1) });
    await vi.advanceTimersByTimeAsync(QUIET_MS * 4);
    expect(glue.imported).toEqual([]);
    expect(helpers?.created).toHaveLength(1);

    await handler(final(5));
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const next = helpers?.created[1];
    expect([...new Uint8Array((next?.posted[0]?.message as StartRequest).png)]).toEqual([4, 1, 2]);
    const [nextRequest] = helpers?.requests(next) ?? [];
    next?.receive({ type: "analysis", id: nextRequest?.id ?? 0, bytes: bytesOf(2) });
    await vi.advanceTimersByTimeAsync(0);
    expect(glue.imported).toEqual([{ developer: 1, bytes: [2] }]);

    // 閉じても終わらせる
    await handler({ type: "close", id: 6 });
    expect(next?.terminate).toHaveBeenCalledTimes(1);
  });

  it("もう持っている解析は頼まない。作るものが無い（null）ときは取り込まずに次へ", async () => {
    const { handler, glue, helpers } = setup(transferGlue({ holds: (settingsJson) => JSON.parse(settingsJson).colorNoiseReduction === 0 }));
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(helpers?.created).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const helper = helpers?.created[0];
    const [request] = helpers?.requests(helper) ?? [];
    expect(cnrOf(request)).toBe(25);
    helper?.receive({ type: "analysis", id: request?.id ?? 0, bytes: null });
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(glue.imported).toEqual([]);
    expect(helper?.terminate).toHaveBeenCalledTimes(1);
    expect(glue.prepared).toEqual([]);
  });

  it("補助の worker を作れない環境・口の無い glue・signed RAW でない写真では、今までどおりこの worker で作る", async () => {
    for (const { glue, helpers, metaJson } of [
      { glue: transferGlue(), helpers: null, metaJson: SIGNED_META },
      { glue: transferGlue(), helpers: fakeHelpers({ fail: true }), metaJson: SIGNED_META },
      { glue: transferGlue({ transfer: false }), helpers: fakeHelpers(), metaJson: SIGNED_META },
      { glue: transferGlue(), helpers: fakeHelpers(), metaJson: '{"kind":"raster","iccSha256":"sRGB"}' },
    ]) {
      const { handler } = setup(glue, helpers);
      await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
      await handler(openCopy(2, metaJson));
      await handler(final(3));
      await vi.advanceTimersByTimeAsync(QUIET_MS * 4);
      expect(glue.prepared.map((entry) => entry.settingsJson === SIGNED)).toEqual([true, false]);
      expect(helpers?.created ?? []).toHaveLength(0);
      expect(glue.imported).toEqual([]);
    }
  });

  it("補助の worker が失敗した・落ちた・取り込めなかったら終わらせ、その写真ではその 1 件からこの worker で作る", async () => {
    const failures: { label: string; glue: ReturnType<typeof transferGlue>; fail: (helper: FakeHelper, id: number) => void }[] = [
      { label: "error", glue: transferGlue(), fail: (helper, id) => helper.receive({ type: "error", id, message: "no wasm" }) },
      { label: "crash", glue: transferGlue(), fail: (helper) => helper.receive(null) },
      {
        label: "import",
        glue: transferGlue({ importThrows: true }),
        fail: (helper, id) => helper.receive({ type: "analysis", id, bytes: bytesOf(1) }),
      },
    ];
    for (const { label, glue, fail } of failures) {
      const { handler, helpers } = setup(glue);
      await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
      await handler(openCopy(2));
      await handler(final(3));
      await vi.advanceTimersByTimeAsync(QUIET_MS);
      const helper = helpers?.created[0] as FakeHelper;
      const [request] = helpers?.requests(helper) ?? [];
      fail(helper, request?.id ?? 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(helper.terminate, label).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(QUIET_MS * 4);
      expect(
        glue.prepared.map((entry) => JSON.parse(entry.settingsJson).colorNoiseReduction),
        label,
      ).toEqual([0, 25]);
      expect(helpers?.created, label).toHaveLength(1);
      expect(glue.imported, label).toEqual([]);
    }
  });

  it("補助の worker の中身と合わせて: 同じ写真を同じ開き方で開き、作った bytes をそのまま取り込む", async () => {
    const glue = transferGlue();
    const opened: { png: number[]; metaJson: string }[] = [];
    class HelperDeveloper {
      readonly png: number[];
      constructor(png: number[], metaJson: string) {
        this.png = png;
        opened.push({ png, metaJson });
      }
      static openWorkingCopy(png: Uint8Array, metaJson: string) {
        return new HelperDeveloper([...png], metaJson);
      }
      exportAnalysis(settingsJson: string) {
        return new TextEncoder().encode(`${this.png.join(",")}|${JSON.parse(settingsJson).colorNoiseReduction}`);
      }
    }
    const helperModule = { default: vi.fn(async () => ({})), version: () => VERSION, Developer: HelperDeveloper };
    const terminate = vi.fn<() => void>();
    const createAnalysisHelper = vi.fn((receive: (response: DevelopAnalysisHelperResponse | null) => void) => {
      const handle = createDevelopAnalysisWorkerHandler({
        fetch: async () => new Response(JSON.stringify(MANIFEST), { status: 200 }),
        importModule: async () => helperModule,
        post: (message) => receive(message),
      });
      return { post: (message: DevelopAnalysisHelperRequest) => void handle(message), terminate };
    });
    const posted: DevelopEngineWorkerResponse[] = [];
    const handler = createDevelopEngineWorkerHandler({
      fetch: vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 })),
      importModule: vi.fn(async () => glue.module),
      post: (message) => posted.push(message),
      createAnalysisHelper,
    });
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(openCopy(2));
    await handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS * 4);

    expect(opened).toEqual([{ png: [2, 1, 2], metaJson: SIGNED_META }]);
    expect(glue.imported.map((entry) => new TextDecoder().decode(new Uint8Array(entry.bytes)))).toEqual(["2,1,2|0", "2,1,2|25"]);
    expect(glue.prepared).toEqual([]);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("補助の worker の解析をハッシュ鍵で保存し、再起動後は描画前に取り込む。保存先が壊れても描ける", async () => {
    const entries = new Map<string, ArrayBuffer>();
    const analysisStore: NonNullable<DevelopEngineWorkerDeps["analysisStore"]> = {
      get: vi.fn(async (id) => entries.get(id) ?? null),
      put: vi.fn(async (id, bytes) => { entries.set(id, bytes.slice(0)); }),
    };
    const digest: NonNullable<DevelopEngineWorkerDeps["digest"]> = async (bytes) =>
      createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
    const first = setup(transferGlue(), fakeHelpers(), { analysisStore, digest });
    await first.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await first.handler(openCopy(2));
    await first.handler(final(3));
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const helper = first.helpers?.created[0];
    const request = first.helpers?.requests(helper)[0];
    helper?.receive({ type: "analysis", id: request?.id ?? 0, bytes: bytesOf(7, 8) });
    await vi.advanceTimersByTimeAsync(0);
    expect([...entries.keys()]).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);

    const second = setup(transferGlue(), null, { analysisStore, digest });
    await second.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await second.handler(openCopy(2));
    await second.handler(final(3));
    expect(second.glue.events.slice(0, 2)).toEqual(["import:0", "render:0"]);
    expect(second.glue.imported).toEqual([{ developer: 0, bytes: [7, 8] }]);
    expect(second.posted.at(-1)).toMatchObject({ type: "frame", id: 3 });

    const broken = setup(transferGlue({ importThrows: true }), null, { analysisStore, digest });
    await broken.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await broken.handler(openCopy(2));
    await broken.handler(final(3));
    expect(broken.glue.events).toEqual(["import:0", "render:0"]);
    expect(broken.posted.at(-1)).toMatchObject({ type: "frame", id: 3 });

    const unavailableStore: NonNullable<DevelopEngineWorkerDeps["analysisStore"]> = {
      get: () => new Promise<ArrayBuffer | null>(() => undefined),
      put: async () => undefined,
    };
    const slow = setup(transferGlue(), null, { analysisStore: unavailableStore, digest });
    await slow.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await slow.handler(openCopy(2));
    const rendering = slow.handler(final(3));
    await vi.advanceTimersByTimeAsync(120);
    await rendering;
    expect(slow.posted.at(-1)).toMatchObject({ type: "frame", id: 3 });
  });
});
