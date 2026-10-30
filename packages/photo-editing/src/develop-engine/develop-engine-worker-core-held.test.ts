import { describe, expect, it, vi } from "vitest";

import { DEVELOP_ENGINE_CRATE_VERSION, DEVELOP_ENGINE_VERSION, developEngineManifestPath } from "./develop-engine-manifest";
import {
  createDevelopEngineWorkerHandler,
  type DevelopEngineWorkerDeps,
  type DevelopEngineWorkerResponse,
} from "./develop-engine-worker-core";

/**
 * Worker が同じ写真の `Developer` を保って使い回す（#129）: 開き方と入力の bytes の鍵で、開いている 1 枚と直前の 1 枚まで保ち、
 * 同じ入力をもう一度開いたらデコードせずに使う（面は外す）。新しい写真をデコードする前に古いほうから手放す。`digest` が無い・
 * 読めないときは今までどおり手放す。
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
const SURFACE_ID = "a".repeat(64);

type Posted = { message: DevelopEngineWorkerResponse; transfer: Transferable[] | undefined };

function heldGlue() {
  const events: string[] = [];
  const state = {
    failDecode: false,
    openAttempts: 0,
    openFailures: [] as Error[],
    renderFailures: [] as Error[],
    exportAttempts: 0,
    exportFailures: [] as Error[],
  };
  const developers: FakeDeveloper[] = [];
  const thumbnails: FakeDeveloper[] = [];
  class FakeDeveloper {
    readonly width: number;
    readonly height = 2;
    readonly name: string;
    readonly metaJson: string | null;
    readonly surfaces = new Set<string>();
    readonly renders: string[] = [];
    readonly free = vi.fn(() => events.push(`free ${this.name}`));
    readonly releaseAnalysisAhead = vi.fn();
    constructor(input: Uint8Array, workingMaxDimension: number, metaJson: string | null = null) {
      this.name = input.length === 0 ? `thumbnail of ${workingMaxDimension}` : String.fromCharCode(...input);
      this.width = workingMaxDimension;
      this.metaJson = metaJson;
      events.push(`decode ${this.name}`);
      developers.push(this);
    }
    static openWorkingCopy(png: Uint8Array, metaJson: string) {
      state.openAttempts += 1;
      const failure = state.openFailures.shift();
      if (failure) throw failure;
      if (state.failDecode) throw new Error("decodeFailed");
      return new FakeDeveloper(png, 2560, metaJson);
    }
    render(settingsJson: string) {
      const failure = state.renderFailures.shift();
      if (failure) throw failure;
      this.renders.push(settingsJson);
      return { width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]) };
    }
    thumbnail(maxDimension: number) {
      const session = new FakeDeveloper(new Uint8Array(0), maxDimension);
      thumbnails.push(session);
      return session;
    }
    setMaskSurface(id: string) {
      this.surfaces.add(id);
    }
    dropMaskSurface(id: string) {
      return this.surfaces.delete(id);
    }
    exportJpeg() {
      state.exportAttempts += 1;
      const failure = state.exportFailures.shift();
      if (failure) throw failure;
      return new Uint8Array([0xff, 0xd8]);
    }
  }
  const module = {
    default: vi.fn(async () => ({})),
    version: () => "0.26.0+test",
    render: vi.fn(),
    exportJpeg: vi.fn(() => new Uint8Array([0xff, 0xd8, 0])),
    convertEditSettings: vi.fn(),
    Developer: FakeDeveloper,
    capabilities: () =>
      JSON.stringify({ masks: { kinds: ["linear", "radial", "brush"], max: 8, maskPlane: true, surfaces: true } }),
    encodeMaskSurface: vi.fn(() => new Uint8Array([0x89])),
    maskSurfaceId: vi.fn(() => SURFACE_ID),
    applyPreset: vi.fn(),
    settingsToXmp: vi.fn(),
  };
  return { module, developers, thumbnails, events, state };
}

/** 鍵は bytes をそのまま文字にしたもの（テストでは中身が同じなら同じ鍵）。 */
const textDigest: DevelopEngineWorkerDeps["digest"] = async (bytes) => `d:${String.fromCharCode(...new Uint8Array(bytes))}`;

/** `digest` の null は口を渡さない（今までの Worker）。 */
function setup(digest: DevelopEngineWorkerDeps["digest"] | null = textDigest) {
  const glue = heldGlue();
  const posted: Posted[] = [];
  const deps: DevelopEngineWorkerDeps = {
    fetch: vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 })),
    importModule: vi.fn(async () => glue.module),
    post: (message, transfer) => posted.push({ message, transfer }),
    ...(digest ? { digest } : {}),
  };
  return { handler: createDevelopEngineWorkerHandler(deps), posted, glue };
}

const bytesOf = (text: string) => new Uint8Array([...text].map((char) => char.charCodeAt(0))).buffer;
const open = (id: number, text: string, workingMaxDimension = 1280) =>
  ({ type: "open", id, bytes: bytesOf(text), workingMaxDimension }) as const;
/** 作業コピーの PNG の頭（signature と IHDR の幅・高さ。#155 の見積もりが読む）に `text` を続けた bytes。 */
const workingCopyPng = (width: number, height: number, text: string) => {
  const bytes = new Uint8Array(24 + text.length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([...text].map((char) => char.charCodeAt(0)), 24);
  return bytes.buffer;
};

describe("Worker が同じ写真を保つ（#129）", () => {
  it("閉じた写真を保ち、同じ入力をもう一度開いたらデコードせずに使う（A → B → A）", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(open(2, "A"));
    await handler({ type: "render", id: 3, settingsJson: '{"exposure":0.3}', maxDimension: 1280, interactive: false });
    await handler({ type: "close", id: 4 });
    await handler(open(5, "B"));
    await handler({ type: "close", id: 6 });
    await handler(open(7, "A"));
    await handler({ type: "render", id: 8, settingsJson: '{"exposure":0.5}', maxDimension: 1280, interactive: false });

    expect(glue.events).toEqual(["decode A", "decode B"]);
    expect(posted.find((entry) => entry.message.id === 7)?.message).toEqual({ type: "opened", id: 7, width: 1280, height: 2 });
    const [a, b] = glue.developers;
    expect(a?.renders).toEqual(['{"exposure":0.3}', '{"exposure":0.5}']);
    expect(a?.free).not.toHaveBeenCalled();
    expect(b?.free).not.toHaveBeenCalled();
  });

  it("開いている 1 枚と合わせて 2 枚まで。3 枚目をデコードする前にいちばん古い写真を手放す", async () => {
    const { handler, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(open(2, "A"));
    await handler({ type: "close", id: 3 });
    await handler(open(4, "B"));
    await handler({ type: "close", id: 5 });
    await handler(open(6, "C"));
    await handler(open(7, "D"));
    await handler(open(8, "C"));

    expect(glue.events).toEqual(["decode A", "decode B", "free A", "decode C", "free B", "decode D"]);
    // D を開いた後に C へ戻るとデコードしない（D は保つ）
    expect(glue.developers.find((developer) => developer.name === "D")?.free).not.toHaveBeenCalled();
  });

  it("既定 PC は 2 枚を保ち、mobile は次の Developer を開く前に kept を手放す", async () => {
    const pc = setup();
    await pc.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, deviceClass: "pc" });
    await pc.handler(open(2, "A"));
    await pc.handler({ type: "close", id: 3 });
    await pc.handler(open(4, "B"));
    expect(pc.glue.events).toEqual(["decode A", "decode B"]);

    const mobile = setup();
    await mobile.handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL, deviceClass: "mobile" });
    await mobile.handler(open(2, "A"));
    await mobile.handler({ type: "close", id: 3 });
    await mobile.handler(open(4, "B"));
    expect(mobile.glue.events).toEqual(["decode A", "free A", "decode B"]);
  });

  it("鍵は開き方も含む（作業サイズ・メタデータが違えば別の写真としてデコードする）", async () => {
    const { handler, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(open(2, "A", 1280));
    await handler(open(3, "A", 2560));
    await handler({ type: "openWorkingCopy", id: 4, png: bytesOf("W"), metaJson: '{"kind":"raw","baselineEV":0}' });
    await handler({ type: "openWorkingCopy", id: 5, png: bytesOf("W"), metaJson: '{"kind":"raw","baselineEV":0.5}' });
    await handler({ type: "openWorkingCopy", id: 6, png: bytesOf("W"), metaJson: '{"kind":"raw","baselineEV":0}' });

    expect(glue.events.filter((event) => event.startsWith("decode"))).toEqual([
      "decode A",
      "decode A",
      "decode W",
      "decode W",
    ]);
    expect(glue.developers.map((developer) => developer.metaJson)).toEqual([
      null,
      null,
      '{"kind":"raw","baselineEV":0}',
      '{"kind":"raw","baselineEV":0.5}',
    ]);
  });

  it("保つ前に面・見本の session・先に作った別の解析を手放し、使い回すときは面を持たずに始める", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(open(2, "A"));
    await handler({ type: "setMaskSurface", id: 3, surfaceId: SURFACE_ID, png: new Uint8Array([1]).buffer });
    await handler({ type: "renderPresetThumbnail", id: 4, settingsJson: "{}", maxDimension: 96 });
    const [a] = glue.developers;
    const [thumbnail] = glue.thumbnails;
    expect(a?.surfaces.has(SURFACE_ID)).toBe(true);
    expect(thumbnail?.surfaces.has(SURFACE_ID)).toBe(true);

    await handler(open(5, "B"));
    expect(a?.surfaces.size).toBe(0);
    expect(thumbnail?.free).toHaveBeenCalledOnce();
    expect(a?.releaseAnalysisAhead).toHaveBeenCalledOnce();
    expect(a?.free).not.toHaveBeenCalled();
    await handler(open(6, "A"));
    await handler({ type: "renderPresetThumbnail", id: 7, settingsJson: '{"contrast":10}', maxDimension: 96 });

    // 見本の session は使い回した写真から作り直す（面は持たない）
    expect(glue.thumbnails).toHaveLength(2);
    expect(glue.thumbnails[1]?.renders).toEqual(['{"contrast":10}']);
    expect(glue.thumbnails[1]?.surfaces.size).toBe(0);
    expect(posted.at(-1)?.message).toMatchObject({ type: "frame", id: 7 });
  });

  it("開いている写真と同じ入力をもう一度開いても作り直さない（面は外す）", async () => {
    const { handler, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(open(2, "A"));
    await handler({ type: "setMaskSurface", id: 3, surfaceId: SURFACE_ID, png: new Uint8Array([1]).buffer });
    await handler(open(4, "A"));

    expect(glue.events).toEqual(["decode A"]);
    expect(glue.developers[0]?.surfaces.size).toBe(0);
  });

  it("digest が無い・null・失敗のときは保たない（今までどおり手放す）", async () => {
    for (const digest of [null, async () => null, async () => Promise.reject(new Error("no subtle"))]) {
      const { handler, glue } = setup(digest);
      await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
      await handler(open(2, "A"));
      await handler({ type: "close", id: 3 });
      await handler(open(4, "A"));

      expect(glue.events).toEqual(["decode A", "free A", "decode A"]);
    }
  });

  it("デコードに失敗しても保っている写真は使える", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(open(2, "A"));
    await handler({ type: "close", id: 3 });
    glue.state.failDecode = true;
    await handler({ type: "openWorkingCopy", id: 4, png: bytesOf("X"), metaJson: "{}" });
    expect(posted.at(-1)?.message).toMatchObject({ type: "error", id: 4 });
    await handler(open(5, "A"));
    await handler({ type: "render", id: 6, settingsJson: "{}", maxDimension: 1280, interactive: false });

    expect(glue.events).toEqual(["decode A"]);
    expect(posted.at(-1)?.message).toMatchObject({ type: "frame", id: 6 });
  });

  it("予算に収まらない作業コピーの書き出し前に見本と kept を解放し、active と結果 bytes は保つ", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(open(2, "A"));
    await handler({ type: "close", id: 3 });
    await handler(open(4, "B"));
    await handler({ type: "renderPresetThumbnail", id: 5, settingsJson: "{}", maxDimension: 96 });
    const active = glue.developers.find((entry) => entry.name === "B")!;
    const thumbnail = glue.thumbnails[0]!;
    // 8000×6000 の作業コピーは開くだけで予算（PC 1GiB）を超える（#155。長辺ではなく bytes の見積もりで決める）
    const png = workingCopyPng(8000, 6000, "X");
    const name = String.fromCharCode(...new Uint8Array(png));

    await handler({
      type: "exportWorkingCopyJpeg",
      id: 6,
      png,
      metaJson: "{}",
      settingsJson: "{}",
      maxDimension: 2560,
      quality: 90,
    });

    expect(glue.events).toEqual([
      "decode A",
      "decode B",
      "decode thumbnail of 256",
      "free thumbnail of 256",
      "free A",
      `decode ${name}`,
      `free ${name}`,
    ]);
    expect(active.free).not.toHaveBeenCalled();
    expect(thumbnail.free).toHaveBeenCalledOnce();
    const result = posted.at(-1)?.message;
    expect(result).toMatchObject({ type: "frame", id: 6 });
    expect(Array.from(new Uint8Array(result?.type === "frame" ? result.rgba : new ArrayBuffer(0)))).toEqual([1, 2, 3, 255]);
  });

  it("通常の 2048px 書き出しでは予算内の kept Developer を保ち、後でデコードせず再利用する", async () => {
    const { handler, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(open(2, "A"));
    await handler({ type: "close", id: 3 });
    await handler(open(4, "B"));
    await handler({
      type: "exportWorkingCopyJpeg",
      id: 5,
      png: bytesOf("X"),
      metaJson: "{}",
      settingsJson: "{}",
      maxDimension: 2048,
      quality: 90,
    });
    await handler(open(6, "A"));

    expect(glue.events).toEqual(["decode A", "decode B", "decode X", "free X"]);
    expect(glue.developers.find((entry) => entry.name === "A")?.free).not.toHaveBeenCalled();
  });

  it("allocation failure だけは保持物を解放して 1 回だけ再試行し、同じ結果 bytes を返す", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(open(2, "A"));
    await handler({ type: "close", id: 3 });
    glue.state.openFailures.push(new Error("memory allocation of 1048576 bytes failed"));

    await handler({
      type: "exportWorkingCopyJpeg",
      id: 4,
      png: bytesOf("X"),
      metaJson: "{}",
      settingsJson: "{}",
      maxDimension: 2048,
      quality: 90,
    });

    expect(glue.state.openAttempts).toBe(2);
    const result = posted.at(-1)?.message;
    expect(result).toMatchObject({ type: "frame", id: 4 });
    expect(Array.from(new Uint8Array(result?.type === "frame" ? result.rgba : new ArrayBuffer(0)))).toEqual([1, 2, 3, 255]);
  });

  it("一時作業コピーの render で allocation failure なら先に temporary を free し、最初から1回だけ再試行する", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(open(2, "A"));
    await handler({ type: "close", id: 3 });
    glue.state.renderFailures.push(new Error("out of memory"));

    await handler({
      type: "exportWorkingCopyJpeg",
      id: 4,
      png: bytesOf("X"),
      metaJson: "{}",
      settingsJson: "{}",
      maxDimension: 2048,
      quality: 90,
    });

    expect(glue.state.openAttempts).toBe(2);
    expect(glue.events).toEqual(["decode A", "decode X", "free X", "free A", "decode X", "free X"]);
    expect(posted.at(-1)?.message).toMatchObject({ type: "frame", id: 4 });
  });

  it("surface 付き exportJpeg の allocation failure も temporary を free して全体を1回だけ再試行する", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    await handler(open(2, "A"));
    await handler({ type: "close", id: 3 });
    glue.state.exportFailures.push(new Error("failed to allocate 4096 bytes"));

    await handler({
      type: "exportJpeg",
      id: 4,
      bytes: bytesOf("X"),
      settingsJson: "{}",
      maxDimension: 2048,
      quality: 90,
      surfaces: [{ id: SURFACE_ID, png: new Uint8Array([1]).buffer }],
    });

    expect(glue.state.exportAttempts).toBe(2);
    expect(glue.events).toEqual(["decode A", "decode X", "free X", "free A", "decode X", "free X"]);
    const result = posted.at(-1)?.message;
    expect(result).toMatchObject({ type: "jpeg", id: 4 });
    expect(Array.from(new Uint8Array(result?.type === "jpeg" ? result.bytes : new ArrayBuffer(0)))).toEqual([0xff, 0xd8]);
  });

  it("一時作業コピーの render が非メモリエラーなら再試行しない", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    glue.state.renderFailures.push(new Error("renderFailed"));
    await handler({
      type: "exportWorkingCopyJpeg",
      id: 2,
      png: bytesOf("X"),
      metaJson: "{}",
      settingsJson: "{}",
      maxDimension: 2048,
      quality: 90,
    });

    expect(glue.state.openAttempts).toBe(1);
    expect(glue.events).toEqual(["decode X", "free X"]);
    expect(posted.at(-1)?.message).toEqual({ type: "error", id: 2, message: "renderFailed" });
  });

  it("非メモリの open error は再試行しない", async () => {
    const { handler, posted, glue } = setup();
    await handler({ type: "init", id: 1, manifestUrl: MANIFEST_URL });
    glue.state.openFailures.push(new Error("decodeFailed"));
    await handler({ type: "openWorkingCopy", id: 2, png: bytesOf("X"), metaJson: "{}" });

    expect(glue.state.openAttempts).toBe(1);
    expect(posted.at(-1)?.message).toEqual({ type: "error", id: 2, message: "decodeFailed" });
  });
});
