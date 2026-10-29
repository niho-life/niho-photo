import { describe, expect, it, vi } from "vitest";

import { DevelopMaskSurfaceError, createDevelopEngine, type DevelopMaskSurfaceSource } from "./develop-engine-client";
import type { DevelopEngineWorkerRequest, DevelopEngineWorkerResponse } from "./develop-engine-worker-core";
import { writeDevelopMasks, type DevelopMask } from "./develop-masks";
import { neutralDevelopSettings, type DevelopSettings } from "./develop-settings";

/**
 * 段 2 の wasm の面の受け渡し（M4 #68）: 描く前に要る面を 1 回だけ渡す・読めない面は型付きの失敗・待っている間の追い越し・開き直しの
 * 渡し直し・上限で手放す・重ね表示・書き出しに添える・面を作る。
 */

const MANIFEST_URL = "https://photo.example.test/develop-engine/niho-2/manifest.json";
const SURFACES = { kinds: ["linear", "radial", "brush", "subject", "sky"], max: 8, maskPlane: true, surfaces: true };

class FakeWorker extends EventTarget {
  readonly posted: { message: DevelopEngineWorkerRequest; transfer: Transferable[] }[] = [];

  postMessage(message: DevelopEngineWorkerRequest, transfer: Transferable[] = []) {
    this.posted.push({ message, transfer });
  }

  terminate() {}

  respond(response: DevelopEngineWorkerResponse) {
    this.dispatchEvent(new MessageEvent("message", { data: response }));
  }

  requests<T extends DevelopEngineWorkerRequest["type"]>(type: T): Extract<DevelopEngineWorkerRequest, { type: T }>[] {
    return this.posted.filter((entry) => entry.message.type === type).map((entry) => entry.message) as Extract<
      DevelopEngineWorkerRequest,
      { type: T }
    >[];
  }

  types(): string[] {
    return this.posted.map((entry) => entry.message.type).filter((type) => type !== "init");
  }
}

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function surfaceId(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function brush(id: string, n: number, adjust: DevelopMask["adjust"] = { exposure: -1 }): DevelopMask {
  return { id, kind: "brush", enabled: true, invert: false, surface: { id: surfaceId(n), width: 4, height: 3 }, adjust };
}

function settingsWith(...masks: DevelopMask[]): DevelopSettings {
  return writeDevelopMasks(neutralDevelopSettings(), masks);
}

async function readyEngine(options: { source?: DevelopMaskSurfaceSource; masks?: unknown } = {}) {
  const worker = new FakeWorker();
  const source = options.source ?? vi.fn(async (id: string) => new Uint8Array([0x89, id.length]));
  const engine = createDevelopEngine({
    createWorker: () => worker as unknown as Worker,
    manifestUrl: MANIFEST_URL,
    maskSurfaces: source,
  });
  const ready = engine.ready();
  const init = worker.requests("init")[0]!;
  worker.respond({ type: "ready", id: init.id, version: "0.19.0", runtime: "wasm", masks: (options.masks ?? SURFACES) as never });
  expect(await ready).toBe(true);
  return { worker, engine, source };
}

/** Worker に面の受け取りを返す（出ている setMaskSurface にすべて）。 */
function acceptSurfaces(worker: FakeWorker, answered: Set<number>) {
  for (const request of worker.requests("setMaskSurface")) {
    if (answered.has(request.id)) continue;
    answered.add(request.id);
    worker.respond({ type: "maskSurfaceSet", id: request.id });
  }
}

function frame(id: number): DevelopEngineWorkerResponse {
  return { type: "frame", id, width: 1, height: 1, rgba: new Uint8ClampedArray(4).buffer };
}

describe("面の受け渡し（createDevelopEngine）", () => {
  it("描かれる面のマスクの面を描く前に 1 回だけ渡し、次の描画では渡さない", async () => {
    const { worker, engine, source } = await readyEngine();
    const answered = new Set<number>();
    const settings = settingsWith(brush("m1", 1));
    const rendered = engine.render(settings, { maxDimension: 640, interactive: false });
    await flush();
    expect(worker.types()).toEqual(["setMaskSurface"]);
    const set = worker.requests("setMaskSurface")[0]!;
    expect(set.surfaceId).toBe(surfaceId(1));
    expect(worker.posted.find((entry) => entry.message === set)?.transfer).toEqual([set.png]);
    acceptSurfaces(worker, answered);
    await flush();
    expect(worker.types()).toEqual(["setMaskSurface", "render"]);
    worker.respond(frame(worker.requests("render")[0]!.id));
    await expect(rendered).resolves.toMatchObject({ width: 1 });

    const again = engine.render(settings, { maxDimension: 640, interactive: true });
    expect(worker.types()).toEqual(["setMaskSurface", "render", "render"]);
    worker.respond(frame(worker.requests("render")[1]!.id));
    await again;
    expect(source).toHaveBeenCalledOnce();
  });

  it("面の要らない設定（補正なし・無効のブラシ）はそのまま描く", async () => {
    const { worker, engine, source } = await readyEngine();
    void engine.render(settingsWith(brush("m1", 1, {}), { ...brush("m2", 2), enabled: false }), { maxDimension: 640, interactive: false });
    expect(worker.types()).toEqual(["render"]);
    expect(source).not.toHaveBeenCalled();
  });

  it("読めない面は描かずに DevelopMaskSurfaceError（マスクの id 付き）で失敗する", async () => {
    const { worker, engine } = await readyEngine({ source: async () => null });
    const failure = await engine.render(settingsWith(brush("brush-a", 3)), { maxDimension: 640, interactive: false }).catch((error) => error);
    expect(failure).toBeInstanceOf(DevelopMaskSurfaceError);
    expect(failure).toMatchObject({ code: "maskSurfaceMissing", maskId: "brush-a", surfaceId: surfaceId(3) });
    expect(worker.types()).toEqual([]);
  });

  it("面を読んでいる間に同じ枠の新しい描画が来たら、前の描画は null で終える（新しい描画だけ出す）", async () => {
    let resolveSource: (png: Uint8Array) => void = () => undefined;
    const source = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          resolveSource = resolve;
        }),
    );
    const { worker, engine } = await readyEngine({ source });
    const first = engine.render(settingsWith(brush("m1", 1)), { maxDimension: 640, interactive: true });
    await flush();
    const second = engine.render(neutralDevelopSettings(), { maxDimension: 640, interactive: true });
    await expect(first).resolves.toBeNull();
    expect(worker.types()).toEqual(["render"]);
    resolveSource(new Uint8Array([1]));
    await flush();
    worker.respond(frame(worker.requests("render")[0]!.id));
    await expect(second).resolves.not.toBeNull();
  });

  it("写真を開き直したら面を渡し直す（覚えた PNG から。読み口は読まない）", async () => {
    const { worker, engine, source } = await readyEngine();
    const answered = new Set<number>();
    const settings = settingsWith(brush("m1", 1));
    const first = engine.render(settings, { maxDimension: 640, interactive: false });
    await flush();
    acceptSurfaces(worker, answered);
    await flush();
    worker.respond(frame(worker.requests("render")[0]!.id));
    await first;

    const opened = engine.open(new ArrayBuffer(8), 2560);
    const open = worker.requests("open")[0]!;
    worker.respond({ type: "opened", id: open.id, width: 4, height: 3 });
    await opened;
    const second = engine.render(settings, { maxDimension: 640, interactive: false });
    await flush();
    expect(worker.requests("setMaskSurface")).toHaveLength(2);
    acceptSurfaces(worker, answered);
    await flush();
    worker.respond(frame(worker.requests("render")[1]!.id));
    await second;
    expect(source).toHaveBeenCalledOnce();
  });

  it("持つ面が 16 枚を超えたら、使ったのが古い面を手放す", async () => {
    const { worker, engine } = await readyEngine();
    const answered = new Set<number>();
    for (let n = 1; n <= 17; n += 1) {
      const rendered = engine.render(settingsWith(brush("m1", n)), { maxDimension: 640, interactive: false });
      await flush();
      acceptSurfaces(worker, answered);
      await flush();
      const renders = worker.requests("render");
      worker.respond(frame(renders[renders.length - 1]!.id));
      await rendered;
    }
    expect(worker.requests("dropMaskSurface").map((request) => request.surfaceId)).toEqual([surfaceId(1)]);
  });

  it("重ね表示は、無効・補正なしでもそのマスクの面を渡してから出す", async () => {
    const { worker, engine } = await readyEngine();
    const answered = new Set<number>();
    const settings = settingsWith({ ...brush("m1", 5, {}), enabled: false });
    const plane = engine.maskPlane!(settings, "m1", { maxDimension: 640 });
    await flush();
    expect(worker.types()).toEqual(["setMaskSurface"]);
    acceptSurfaces(worker, answered);
    await flush();
    const request = worker.requests("maskPlane")[0]!;
    expect(request.maskId).toBe("m1");
    worker.respond({ type: "maskPlane", id: request.id, width: 2, height: 1, data: new Uint8Array([0, 255]).buffer });
    await expect(plane).resolves.toMatchObject({ width: 2, height: 1 });
  });

  it("Worker の面の失敗のメッセージは型付きの失敗にする", async () => {
    const { worker, engine } = await readyEngine({ masks: { kinds: ["linear", "radial"], max: 8, maskPlane: true } });
    const rendered = engine.render(neutralDevelopSettings(), { maxDimension: 640, interactive: false });
    worker.respond({
      type: "error",
      id: worker.requests("render")[0]!.id,
      message: "maskSurfaceMissing: mask brush-9 needs its surface, which is not loaded",
    });
    await expect(rendered).rejects.toMatchObject({ name: "DevelopMaskSurfaceError", code: "maskSurfaceMissing", maskId: "brush-9" });
  });

  it("面の口の無い wasm には面を渡さない", async () => {
    const { worker, engine, source } = await readyEngine({ masks: { kinds: ["linear", "radial"], max: 8, maskPlane: true } });
    void engine.render(settingsWith(brush("m1", 1)), { maxDimension: 640, interactive: false });
    expect(worker.types()).toEqual(["render"]);
    expect(source).not.toHaveBeenCalled();
    await expect(engine.encodeMaskSurface!(1, 1, new Uint8Array([0]))).rejects.toThrow("cannot encode");
  });

  it("書き出しは描かれる面のマスクの面を添えて出す（読み口は渡したもの）。読めなければ型付きの失敗", async () => {
    const { worker, engine, source } = await readyEngine();
    const exportSource = vi.fn(async () => new Uint8Array([7, 7, 7]));
    const exported = engine.exportJpeg(new ArrayBuffer(4), settingsWith(brush("m1", 2)), {
      maxDimension: 2048,
      quality: 90,
      maskSurfaces: exportSource,
    });
    await flush();
    const request = worker.requests("exportJpeg")[0]!;
    expect(request.surfaces).toHaveLength(1);
    expect(request.surfaces![0]!.id).toBe(surfaceId(2));
    expect([...new Uint8Array(request.surfaces![0]!.png)]).toEqual([7, 7, 7]);
    expect(exportSource).toHaveBeenCalledWith(surfaceId(2));
    expect(source).not.toHaveBeenCalled();
    worker.respond({ type: "jpeg", id: request.id, bytes: new Uint8Array([0xff, 0xd8]).buffer });
    await expect(exported).resolves.toEqual(new Uint8Array([0xff, 0xd8]));

    // 面の無い書き出しは今までどおり（surfaces を付けない）
    void engine.exportJpeg(new ArrayBuffer(4), neutralDevelopSettings(), { maxDimension: 2048, quality: 90 });
    expect("surfaces" in worker.requests("exportJpeg")[1]!).toBe(false);

    await expect(
      engine.exportWorkingCopyJpeg(new ArrayBuffer(4), "{}", settingsWith(brush("m1", 3)), {
        maxDimension: 2048,
        quality: 90,
        maskSurfaces: async () => null,
      }),
    ).rejects.toMatchObject({ code: "maskSurfaceMissing", maskId: "m1" });
  });

  it("面を読んでいる途中の書き出しは、dispose しても描き終えるまで Worker を止めない", async () => {
    let resolveSource: (png: Uint8Array) => void = () => undefined;
    const { worker, engine } = await readyEngine();
    const exported = engine.exportJpeg(new ArrayBuffer(4), settingsWith(brush("m1", 2)), {
      maxDimension: 2048,
      quality: 90,
      maskSurfaces: () =>
        new Promise<Uint8Array>((resolve) => {
          resolveSource = resolve;
        }),
    });
    engine.dispose();
    resolveSource(new Uint8Array([1]));
    await flush();
    const request = worker.requests("exportJpeg")[0]!;
    worker.respond({ type: "jpeg", id: request.id, bytes: new Uint8Array([1]).buffer });
    await expect(exported).resolves.toEqual(new Uint8Array([1]));
  });

  it("面を作る（PNG と id）と、作った PNG を覚えて読み口を読まずに使う。直接渡す・手放す", async () => {
    const { worker, engine, source } = await readyEngine();
    const encoded = engine.encodeMaskSurface!(2, 1, new Uint8Array([0, 255]));
    const request = worker.requests("encodeMaskSurface")[0]!;
    expect(request).toMatchObject({ width: 2, height: 1 });
    expect([...new Uint8Array(request.data)]).toEqual([0, 255]);
    worker.respond({ type: "maskSurfaceEncoded", id: request.id, surfaceId: surfaceId(42), png: new Uint8Array([9, 8]).buffer });
    await expect(encoded).resolves.toEqual({ id: surfaceId(42), png: new Uint8Array([9, 8]) });
    await expect(engine.maskSurfacePng!(surfaceId(42))).resolves.toEqual(new Uint8Array([9, 8]));
    expect(source).not.toHaveBeenCalled();

    const set = engine.setMaskSurface!(surfaceId(42), new Uint8Array([9, 8]));
    const setRequest = worker.requests("setMaskSurface")[0]!;
    worker.respond({ type: "maskSurfaceSet", id: setRequest.id });
    await set;
    // 渡した面は持っている: 次の描画で渡し直さない
    void engine.render(settingsWith(brush("m1", 42)), { maxDimension: 640, interactive: false });
    expect(worker.requests("setMaskSurface")).toHaveLength(1);

    const dropped = engine.dropMaskSurface!(surfaceId(42));
    const dropRequest = worker.requests("dropMaskSurface")[0]!;
    worker.respond({ type: "maskSurfaceDropped", id: dropRequest.id, dropped: true });
    await expect(dropped).resolves.toBe(true);

    const invalid = engine.setMaskSurface!(surfaceId(43), new Uint8Array([1]));
    const invalidRequest = worker.requests("setMaskSurface")[1]!;
    worker.respond({ type: "error", id: invalidRequest.id, message: `maskSurfaceInvalid: surface ${surfaceId(43)}: not a PNG` });
    await expect(invalid).rejects.toMatchObject({ code: "maskSurfaceInvalid", surfaceId: surfaceId(43) });
  });
});
