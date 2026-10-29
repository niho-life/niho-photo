import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEVELOP_PREVIEW_QUIET_MS,
  DevelopEngineError,
  createDevelopEngine,
  photoDevelopDiagnosticsEnabled,
  type CreateDevelopEngineOptions,
} from "./develop-engine-client";
import type {
  DevelopEngineWorkerFeatures,
  DevelopEngineWorkerRequest,
  DevelopEngineWorkerResponse,
} from "./develop-engine-worker-core";

const MANIFEST_URL = "https://photo.example.test/develop-engine/niho-2/manifest.json";

/** Worker の代わり（送った要求を持ち、応答をテストから返す）。 */
class FakeWorker extends EventTarget {
  readonly posted: { message: DevelopEngineWorkerRequest; transfer: Transferable[] }[] = [];
  terminated = false;

  postMessage(message: DevelopEngineWorkerRequest, transfer: Transferable[] = []) {
    this.posted.push({ message, transfer });
  }

  terminate() {
    this.terminated = true;
  }

  respond(response: DevelopEngineWorkerResponse) {
    this.dispatchEvent(new MessageEvent("message", { data: response }));
  }

  lastRequest(type: DevelopEngineWorkerRequest["type"]): DevelopEngineWorkerRequest {
    const found = [...this.posted].reverse().find((entry) => entry.message.type === type);
    if (!found) throw new Error(`no ${type} request`);
    return found.message;
  }

  requests(type: DevelopEngineWorkerRequest["type"]): DevelopEngineWorkerRequest[] {
    return this.posted.filter((entry) => entry.message.type === type).map((entry) => entry.message);
  }
}

function frameResponse(id: number, marker: number): DevelopEngineWorkerResponse {
  const rgba = new Uint8ClampedArray(4);
  rgba[0] = marker;
  return { type: "frame", id, width: 1, height: 1, rgba: rgba.buffer };
}

async function flushPromises() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

async function readyEngine(
  options: Pick<
    CreateDevelopEngineOptions,
    "encodeFrameJpeg" | "previewQuietMs" | "diagnostics" | "preferNative" | "deviceClass"
  > & {
    geometry?: boolean;
    features?: DevelopEngineWorkerFeatures;
  } = {},
) {
  const { geometry, features, ...engineOptions } = options;
  const worker = new FakeWorker();
  const engine = createDevelopEngine({
    createWorker: () => worker as unknown as Worker,
    manifestUrl: MANIFEST_URL,
    ...engineOptions,
  });
  const ready = engine.ready();
  const init = worker.lastRequest("init");
  expect(init).toEqual({
    type: "init",
    id: init.id,
    manifestUrl: MANIFEST_URL,
    deviceClass: engineOptions.deviceClass ?? "pc",
    ...(engineOptions.diagnostics ? { diagnostics: true } : {}),
    ...(engineOptions.preferNative ? { preferNative: true } : {}),
  });
  worker.respond(
    geometry
      ? { type: "ready", id: init.id, version: "0.5.0", runtime: "wasm", geometry: true, ...features }
      : { type: "ready", id: init.id, version: "0.2.0", runtime: "wasm", ...features },
  );
  expect(await ready).toBe(true);
  return { worker, engine };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createDevelopEngine", () => {
  it("端末 class を既定 PC / 明示 mobile として Worker init に渡す", async () => {
    const pc = await readyEngine();
    expect(pc.worker.lastRequest("init")).toMatchObject({ deviceClass: "pc" });
    pc.engine.dispose();

    const mobile = await readyEngine({ deviceClass: "mobile" });
    expect(mobile.worker.lastRequest("init")).toMatchObject({ deviceClass: "mobile" });
    mobile.engine.dispose();
  });

  it("native の希望は明示時だけ Worker init に渡す", async () => {
    const { engine, worker } = await readyEngine({ preferNative: true });
    expect(worker.lastRequest("init")).toMatchObject({ preferNative: true });
    engine.dispose();
    const close = worker.lastRequest("close");
    expect(worker.terminated).toBe(false);
    worker.respond({ type: "closed", id: close.id });
    await flushPromises();
    expect(worker.terminated).toBe(true);
  });

  it("写真編集タブの正確な opt-in query だけを Worker init の診断フラグにする", async () => {
    expect(photoDevelopDiagnosticsEnabled({ pathname: "/host/spot/photoEditing", search: "?photoDevelopPerf=1" })).toBe(true);
    expect(photoDevelopDiagnosticsEnabled({ pathname: "/", search: "?photoDevelopPerf=1" })).toBe(true);
    expect(photoDevelopDiagnosticsEnabled({ pathname: "/host/spot/photoEditing", search: "?photoDevelopPerf=0" })).toBe(false);
    expect(photoDevelopDiagnosticsEnabled({ pathname: "/host/spot/other", search: "?photoDevelopPerf=1" })).toBe(false);
    const worker = new FakeWorker();
    const engine = createDevelopEngine({ createWorker: () => worker as unknown as Worker, manifestUrl: MANIFEST_URL, diagnostics: true });
    const ready = engine.ready();
    expect(worker.lastRequest("init")).toEqual({
      type: "init",
      id: 1,
      manifestUrl: MANIFEST_URL,
      deviceClass: "pc",
      diagnostics: true,
    });
    worker.respond({ type: "ready", id: 1, version: "test", runtime: "wasm" });
    expect(await ready).toBe(true);
    engine.dispose();
  });

  it("Worker の段階診断をメイン画面へ渡しても init 応答を妨げない", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const worker = new FakeWorker();
      const engine = createDevelopEngine({ createWorker: () => worker as unknown as Worker, manifestUrl: MANIFEST_URL, diagnostics: true });
      const ready = engine.ready();
      const record = { stage: "wasmInit" as const, durationMs: 12, wasmMemoryBytes: 65_536, status: "ok" as const };
      worker.respond({ type: "perf", id: 0, record });
      expect(info).toHaveBeenCalledWith("[photo-develop-perf]", record);
      worker.respond({ type: "ready", id: worker.lastRequest("init").id, version: "test", runtime: "native" });
      expect(await ready).toBe(true);
      expect(info).toHaveBeenCalledWith("[photo-develop-perf]", { stage: "runtime", runtime: "native" });
      engine.dispose();
    } finally {
      info.mockRestore();
    }
  });

  it("Worker が無ければ使えない（false。throw しない）", async () => {
    const engine = createDevelopEngine({ createWorker: () => null, manifestUrl: MANIFEST_URL });
    expect(await engine.ready()).toBe(false);
    await expect(engine.render({}, { maxDimension: 1280, interactive: false })).rejects.toBeInstanceOf(DevelopEngineError);
  });

  it("unavailable の応答なら false にして Worker を止める（結果は覚える）", async () => {
    const worker = new FakeWorker();
    const createWorker = vi.fn(() => worker as unknown as Worker);
    const engine = createDevelopEngine({ createWorker, manifestUrl: MANIFEST_URL });
    const ready = engine.ready();
    worker.respond({ type: "unavailable", id: worker.lastRequest("init").id, reason: "manifest 404" });

    expect(await ready).toBe(false);
    expect(worker.terminated).toBe(true);
    expect(await engine.ready()).toBe(false);
    expect(createWorker).toHaveBeenCalledOnce();
  });

  it("Worker が落ちたら false", async () => {
    const worker = new FakeWorker();
    const engine = createDevelopEngine({ createWorker: () => worker as unknown as Worker, manifestUrl: MANIFEST_URL });
    const ready = engine.ready();
    worker.dispatchEvent(new Event("error"));
    expect(await ready).toBe(false);
    expect(worker.terminated).toBe(true);
  });

  it("起こすのに時間がかかりすぎたら false", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const engine = createDevelopEngine({
      createWorker: () => worker as unknown as Worker,
      manifestUrl: MANIFEST_URL,
      loadTimeoutMs: 100,
    });
    const ready = engine.ready();
    await vi.advanceTimersByTimeAsync(100);

    expect(await ready).toBe(false);
    expect(worker.terminated).toBe(true);
  });

  it("render は最新の要求だけを描く（出している間に来た途中の要求は null）", async () => {
    const { worker, engine } = await readyEngine();
    const opened = engine.open(new ArrayBuffer(8), 1280);
    const open = worker.lastRequest("open");
    expect(open).toMatchObject({ type: "open", workingMaxDimension: 1280 });
    // bytes は transfer する
    expect(worker.posted.at(-1)?.transfer).toHaveLength(1);
    worker.respond({ type: "opened", id: open.id, width: 1280, height: 853 });
    expect(await opened).toEqual({ width: 1280, height: 853 });

    const first = engine.render({ exposure: 1 }, { maxDimension: 1280, interactive: true });
    const second = engine.render({ exposure: 2 }, { maxDimension: 1280, interactive: true });
    const third = engine.render({ exposure: 3 }, { maxDimension: 1280, interactive: false });

    // 同時に出す描画は 1 つまで
    expect(worker.requests("render")).toHaveLength(1);
    expect(await second).toBeNull();
    const firstRequest = worker.lastRequest("render");
    expect(firstRequest).toMatchObject({ settingsJson: '{"exposure":1}', maxDimension: 1280, interactive: true });

    worker.respond(frameResponse(firstRequest.id, 1));
    const firstFrame = await first;
    expect(firstFrame?.rgba[0]).toBe(1);
    // 出していた描画が返ったら「次」（最新の 3 つ目）を出す
    await flushPromises();
    const thirdRequest = worker.lastRequest("render");
    expect(worker.requests("render")).toHaveLength(2);
    expect(thirdRequest).toMatchObject({ settingsJson: '{"exposure":3}', interactive: false });
    worker.respond(frameResponse(thirdRequest.id, 3));
    expect((await third)?.rgba[0]).toBe(3);
  });

  it("別の写真を開くと、出している描画の結果は捨て、待っている描画は null", async () => {
    const { worker, engine } = await readyEngine();
    const inFlight = engine.render({ exposure: 1 }, { maxDimension: 1280, interactive: false });
    const queued = engine.render({ exposure: 2 }, { maxDimension: 1280, interactive: false });
    const renderId = worker.lastRequest("render").id;
    void engine.open(new ArrayBuffer(4), 1280).catch(() => undefined);

    expect(await inFlight).toBeNull();
    expect(await queued).toBeNull();
    worker.respond(frameResponse(renderId, 1));
    await flushPromises();
    // 捨てた描画の後に、待っていた描画は出さない
    expect(worker.requests("render")).toHaveLength(1);
  });

  it("render の優先度: Worker が空いたら 編集（drag / final）＞ preview ＞ background の順に出し、出している描画は横取りしない（#17118）", async () => {
    vi.useFakeTimers();
    const { worker, engine } = await readyEngine();
    const inFlight = engine.render({ step: 0 }, { maxDimension: 1280, interactive: false, priority: "background" });
    const background = engine.render({ step: 1 }, { maxDimension: 512, interactive: false, priority: "background" });
    const preview = engine.render({ step: 2 }, { maxDimension: 512, interactive: false, priority: "preview" });
    // 優先度を渡さなければ interactive で drag / final（編集の枠）
    const edit = engine.render({ step: 3 }, { maxDimension: 1280, interactive: true });

    // 出している background は横取りしない
    expect(worker.requests("render")).toHaveLength(1);
    const first = worker.lastRequest("render");
    expect(first).toMatchObject({ settingsJson: '{"step":0}' });

    worker.respond(frameResponse(first.id, 10));
    expect((await inFlight)?.rgba[0]).toBe(10);
    await flushPromises();
    const second = worker.lastRequest("render");
    expect(second).toMatchObject({ settingsJson: '{"step":3}', interactive: true });

    worker.respond(frameResponse(second.id, 13));
    expect((await edit)?.rgba[0]).toBe(13);
    await flushPromises();
    // 編集の描画が終わってから静かな時間（#126）がたつまで preview は出さない
    expect(worker.requests("render")).toHaveLength(2);
    vi.advanceTimersByTime(DEVELOP_PREVIEW_QUIET_MS - 1);
    expect(worker.requests("render")).toHaveLength(2);
    vi.advanceTimersByTime(1);
    const third = worker.lastRequest("render");
    expect(third).toMatchObject({ settingsJson: '{"step":2}', maxDimension: 512 });

    worker.respond(frameResponse(third.id, 12));
    expect((await preview)?.rgba[0]).toBe(12);
    await flushPromises();
    const fourth = worker.lastRequest("render");
    expect(fourth).toMatchObject({ settingsJson: '{"step":1}' });

    worker.respond(frameResponse(fourth.id, 11));
    expect((await background)?.rgba[0]).toBe(11);
    await flushPromises();
    expect(worker.requests("render")).toHaveLength(4);
  });

  it("render の優先度: 同じ枠の新しい要求は古い「次」を null で終え、ほかの枠の「次」は残す。drag と final は同じ枠", async () => {
    const { worker, engine } = await readyEngine();
    const inFlight = engine.render({ step: 0 }, { maxDimension: 1280, interactive: false });
    const drag = engine.render({ step: 1 }, { maxDimension: 1280, interactive: true, priority: "drag" });
    const previewOld = engine.render({ step: 2 }, { maxDimension: 512, interactive: false, priority: "preview" });
    const backgroundOld = engine.render({ step: 3 }, { maxDimension: 512, interactive: false, priority: "background" });
    const final = engine.render({ step: 4 }, { maxDimension: 1280, interactive: false, priority: "final" });
    const previewNew = engine.render({ step: 5 }, { maxDimension: 512, interactive: false, priority: "preview" });
    const backgroundNew = engine.render({ step: 6 }, { maxDimension: 512, interactive: false, priority: "background" });

    expect(await drag).toBeNull();
    expect(await previewOld).toBeNull();
    expect(await backgroundOld).toBeNull();

    const first = worker.lastRequest("render");
    worker.respond(frameResponse(first.id, 10));
    expect((await inFlight)?.rgba[0]).toBe(10);
    await flushPromises();
    const second = worker.lastRequest("render");
    expect(second).toMatchObject({ settingsJson: '{"step":4}', interactive: false });

    // 別の写真を開くと、ほかの枠の「次」もすべて null で終える
    void engine.open(new ArrayBuffer(4), 1280).catch(() => undefined);
    expect(await final).toBeNull();
    expect(await previewNew).toBeNull();
    expect(await backgroundNew).toBeNull();
    worker.respond(frameResponse(second.id, 14));
    await flushPromises();
    expect(worker.requests("render")).toHaveLength(2);
  });

  it("dispose は preview・background の「次」も null で終える", async () => {
    const { worker, engine } = await readyEngine();
    const inFlight = engine.render({}, { maxDimension: 1280, interactive: false });
    const preview = engine.render({}, { maxDimension: 512, interactive: false, priority: "preview" });
    const background = engine.render({}, { maxDimension: 512, interactive: false, priority: "background" });

    engine.dispose();

    expect(await inFlight).toBeNull();
    expect(await preview).toBeNull();
    expect(await background).toBeNull();
    expect(worker.terminated).toBe(true);
  });

  it("exportJpeg は捨てずに順に出し、それぞれの JPEG を返す", async () => {
    const { worker, engine } = await readyEngine();
    const first = engine.exportJpeg(new ArrayBuffer(3), { v: 1 }, { maxDimension: 2048, quality: 90 });
    const second = engine.exportJpeg(new ArrayBuffer(3), { v: 1, exposure: 1 }, { maxDimension: 2048, quality: 90 });
    const [firstRequest, secondRequest] = worker.requests("exportJpeg");
    expect(firstRequest).toMatchObject({ settingsJson: '{"v":1}', maxDimension: 2048, quality: 90 });
    expect(secondRequest).toMatchObject({ settingsJson: '{"v":1,"exposure":1}' });

    worker.respond({ type: "jpeg", id: firstRequest!.id, bytes: new Uint8Array([1]).buffer });
    worker.respond({ type: "jpeg", id: secondRequest!.id, bytes: new Uint8Array([2]).buffer });
    expect(Array.from(await first)).toEqual([1]);
    expect(Array.from(await second)).toEqual([2]);
  });

  it("convertEditSettings は変換の結果を読み（settings は v1 の形だけ）、捨てずに順に出す", async () => {
    const { worker, engine } = await readyEngine();
    const first = engine.convertEditSettings({ exposure: 0.4 });
    const second = engine.convertEditSettings({ exposure: 9 });
    const broken = engine.convertEditSettings({ contrast: 1 });
    const [firstRequest, secondRequest, brokenRequest] = worker.requests("convertEditSettings");
    expect(firstRequest).toMatchObject({ editSettingsJson: '{"exposure":0.4}' });

    worker.respond({
      type: "converted",
      id: firstRequest!.id,
      resultJson: JSON.stringify({ converter: "v2", ok: true, settings: { v: 1, engine: "niho-1", exposure: 0.4 }, issues: [], notes: [] }),
    });
    worker.respond({
      type: "converted",
      id: secondRequest!.id,
      resultJson: JSON.stringify({
        ok: false,
        settings: { v: 1, engine: "niho-1", legacySettings: { exposure: 9 } },
        issues: [{ path: "exposure", code: "outOfRange" }],
      }),
    });
    worker.respond({ type: "converted", id: brokenRequest!.id, resultJson: "not json" });

    expect(await first).toEqual({ ok: true, settings: { v: 1, engine: "niho-1", exposure: 0.4 }, issues: [] });
    expect(await second).toEqual({
      ok: false,
      settings: { v: 1, engine: "niho-1", legacySettings: { exposure: 9 } },
      issues: [{ path: "exposure", code: "outOfRange" }],
    });
    expect(await broken).toEqual({ ok: false, settings: null, issues: [] });
  });

  it("convertEditSettings の error 応答は reject", async () => {
    const { worker, engine } = await readyEngine();
    const converted = engine.convertEditSettings({});
    worker.respond({ type: "error", id: worker.lastRequest("convertEditSettings").id, message: "invalid json" });
    await expect(converted).rejects.toBeInstanceOf(DevelopEngineError);
  });

  it("convertEditSettings は作業コピーの baseVersion を渡せる（#16944）", async () => {
    const { worker, engine } = await readyEngine();
    void engine.convertEditSettings({ exposure: 0.4 }, { baseVersion: "raw-apple.d8.p1.e1.cal-none" });
    expect(worker.lastRequest("convertEditSettings")).toMatchObject({
      editSettingsJson: '{"exposure":0.4}',
      baseVersion: "raw-apple.d8.p1.e1.cal-none",
    });
  });

  it("openWorkingCopy は作業コピーとメタデータを送り（PNG は transfer）、待っている描画は null で終える（#16944）", async () => {
    const { worker, engine } = await readyEngine();
    const rendering = engine.render({}, { maxDimension: 1280, interactive: false });
    const png = new ArrayBuffer(8);
    const opened = engine.openWorkingCopy(png, '{"kind":"raw"}');

    expect(await rendering).toBeNull();
    const request = worker.lastRequest("openWorkingCopy");
    expect(request).toMatchObject({ type: "openWorkingCopy", png, metaJson: '{"kind":"raw"}' });
    expect(worker.posted.at(-1)?.transfer).toEqual([png]);
    worker.respond({ type: "opened", id: request.id, width: 2560, height: 1707 });
    expect(await opened).toEqual({ width: 2560, height: 1707 });

    const failed = engine.openWorkingCopy(new ArrayBuffer(8), "{}");
    worker.respond({ type: "error", id: worker.lastRequest("openWorkingCopy").id, message: "decode_failed" });
    await expect(failed).rejects.toThrow("decode_failed");
  });

  it("exportWorkingCopyJpeg は Worker の JPEG をそのまま返し、画素が返ったらメインスレッドで JPEG にする", async () => {
    const encodeFrameJpeg = vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const { worker, engine } = await readyEngine({ encodeFrameJpeg });
    const png = new ArrayBuffer(8);
    const first = engine.exportWorkingCopyJpeg(png, '{"kind":"raw"}', { v: 1 }, { maxDimension: 2048, quality: 90 });
    const second = engine.exportWorkingCopyJpeg(new ArrayBuffer(8), "{}", { v: 1 }, { maxDimension: 2048, quality: 90 });
    const [firstRequest, secondRequest] = worker.requests("exportWorkingCopyJpeg");
    expect(firstRequest).toMatchObject({ png, metaJson: '{"kind":"raw"}', settingsJson: '{"v":1}', maxDimension: 2048, quality: 90 });

    worker.respond({ type: "jpeg", id: firstRequest!.id, bytes: new Uint8Array([1]).buffer });
    worker.respond(frameResponse(secondRequest!.id, 5));
    expect(Array.from(await first)).toEqual([1]);
    expect(Array.from(await second)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect(encodeFrameJpeg).toHaveBeenCalledWith({ width: 1, height: 1, rgba: expect.any(Uint8ClampedArray) }, 90);
  });

  it("dispose は描き途中の作業コピーの JPEG も待ってから Worker を止める", async () => {
    const { worker, engine } = await readyEngine();
    const exported = engine.exportWorkingCopyJpeg(new ArrayBuffer(3), "{}", {}, { maxDimension: 2048, quality: 90 });
    engine.dispose();
    expect(worker.terminated).toBe(false);

    worker.respond({ type: "jpeg", id: worker.lastRequest("exportWorkingCopyJpeg").id, bytes: new Uint8Array([7]).buffer });
    expect(Array.from(await exported)).toEqual([7]);
    expect(worker.terminated).toBe(true);
  });

  it("エラーの応答は DevelopEngineError で reject", async () => {
    const { worker, engine } = await readyEngine();
    const exported = engine.exportJpeg(new ArrayBuffer(3), {}, { maxDimension: 2048, quality: 90 });
    worker.respond({ type: "error", id: worker.lastRequest("exportJpeg").id, message: "decode failed" });
    await expect(exported).rejects.toThrow("decode failed");
  });

  it("dispose は描き途中の JPEG を待ってから Worker を止める（待っている描画は null、以後の要求は reject）", async () => {
    const { worker, engine } = await readyEngine();
    const exported = engine.exportJpeg(new ArrayBuffer(3), {}, { maxDimension: 2048, quality: 90 });
    const rendering = engine.render({}, { maxDimension: 1280, interactive: false });

    engine.dispose();

    expect(await rendering).toBeNull();
    expect(worker.terminated).toBe(false);
    await expect(engine.render({}, { maxDimension: 1280, interactive: false })).rejects.toBeInstanceOf(DevelopEngineError);
    expect(await engine.ready()).toBe(false);

    worker.respond({ type: "jpeg", id: worker.lastRequest("exportJpeg").id, bytes: new Uint8Array([7]).buffer });
    expect(Array.from(await exported)).toEqual([7]);
    expect(worker.terminated).toBe(true);
  });

  it("presetSettings は base の JSON（無ければ null）と XMP を送り、結果の developSettings を読む（#16946 S7b）", async () => {
    const { worker, engine } = await readyEngine();
    const applied = engine.presetSettings("<x:xmpmeta/>", { v: 1, engine: "niho-1", base: "b1" });
    const neutral = engine.presetSettings("<x:xmpmeta/>", null);
    const [first, second] = worker.requests("presetSettings");
    expect(first).toEqual({
      type: "presetSettings",
      id: first!.id,
      xmp: "<x:xmpmeta/>",
      baseSettingsJson: '{"v":1,"engine":"niho-1","base":"b1"}',
    });
    expect(second).toMatchObject({ baseSettingsJson: null });

    worker.respond({
      type: "preset",
      id: first!.id,
      resultJson: JSON.stringify({
        name: "bluesky2",
        settings: { v: 1, engine: "niho-1", base: "b1", exposure: 0.4 },
        unsupported: ["Sharpness", 3],
        converted: true,
        items: [],
      }),
    });
    worker.respond({ type: "preset", id: second!.id, resultJson: JSON.stringify({ settings: { exposure: 1 }, converted: true }) });

    expect(await applied).toEqual({
      name: "bluesky2",
      settings: { v: 1, engine: "niho-1", base: "b1", exposure: 0.4 },
      converted: true,
      unsupported: ["Sharpness"],
    });
    // settings が v1 の形でなければ reject
    await expect(neutral).rejects.toBeInstanceOf(DevelopEngineError);

    const failed = engine.presetSettings("not xmp", null);
    worker.respond({ type: "error", id: worker.lastRequest("presetSettings").id, message: "preset has no settings" });
    await expect(failed).rejects.toThrow("preset has no settings");
  });

  it("builtinPresets は同梱のプリセットを読む（id と xmp の無いものは落とし、名前が無ければ id）", async () => {
    const { worker, engine } = await readyEngine();
    const listed = engine.builtinPresets();
    worker.respond({
      type: "builtinPresets",
      id: worker.lastRequest("builtinPresets").id,
      presetsJson: JSON.stringify([
        { id: "niho-bluesky2", name: "bluesky2", xmp: "<x:xmpmeta>b</x:xmpmeta>" },
        { id: "niho-pastel", xmp: "<x:xmpmeta>p</x:xmpmeta>" },
        { id: "broken" },
        null,
      ]),
    });
    expect(await listed).toEqual([
      { id: "niho-bluesky2", name: "bluesky2", xmp: "<x:xmpmeta>b</x:xmpmeta>" },
      { id: "niho-pastel", name: "niho-pastel", xmp: "<x:xmpmeta>p</x:xmpmeta>" },
    ]);

    const broken = engine.builtinPresets();
    worker.respond({ type: "builtinPresets", id: worker.lastRequest("builtinPresets").id, presetsJson: "{}" });
    await expect(broken).rejects.toBeInstanceOf(DevelopEngineError);
  });

  it("幾何の口が wasm に揃っていれば supportsGeometry は true（初回に wasm を起こし、結果は覚える。F3 #17122）", async () => {
    const worker = new FakeWorker();
    const createWorker = vi.fn(() => worker as unknown as Worker);
    const engine = createDevelopEngine({ createWorker, manifestUrl: MANIFEST_URL });
    const supported = engine.supportsGeometry();
    const init = worker.lastRequest("init");
    worker.respond({ type: "ready", id: init.id, version: "0.5.0", runtime: "wasm", geometry: true });

    expect(await supported).toBe(true);
    expect(await engine.supportsGeometry()).toBe(true);
    expect(await engine.ready()).toBe(true);
    expect(createWorker).toHaveBeenCalledOnce();
    expect(worker.requests("init")).toHaveLength(1);
  });

  it("幾何の口の無い wasm・使えない engine では supportsGeometry は false（throw しない）", async () => {
    const { worker, engine } = await readyEngine();
    expect(await engine.supportsGeometry()).toBe(false);
    // 口の無い wasm は Worker が error を返す
    const size = engine.imageSize(new ArrayBuffer(4));
    worker.respond({ type: "error", id: worker.lastRequest("imageSize").id, message: "develop engine cannot read geometry" });
    await expect(size).rejects.toThrow("develop engine cannot read geometry");

    const unavailable = createDevelopEngine({ createWorker: () => null, manifestUrl: MANIFEST_URL });
    expect(await unavailable.supportsGeometry()).toBe(false);
    await expect(unavailable.imageSize(new ArrayBuffer(4))).rejects.toBeInstanceOf(DevelopEngineError);
    await expect(unavailable.rasterDecodeSize({}, { width: 1, height: 1 }, 1280, 4096)).rejects.toBeInstanceOf(DevelopEngineError);
    await expect(unavailable.geometryOutputSize({}, { width: 1, height: 1 }, 1280)).rejects.toBeInstanceOf(DevelopEngineError);

    const { worker: supportedWorker, engine: supportedEngine } = await readyEngine({ geometry: true });
    supportedEngine.dispose();
    expect(supportedWorker.terminated).toBe(true);
    expect(await supportedEngine.supportsGeometry()).toBe(false);
  });

  it("ready に effects: true が付けば supportsEffects は true（初回に wasm を起こし、結果は覚える。E1b #17134）", async () => {
    const worker = new FakeWorker();
    const createWorker = vi.fn(() => worker as unknown as Worker);
    const engine = createDevelopEngine({ createWorker, manifestUrl: MANIFEST_URL });
    const supported = engine.supportsEffects();
    const init = worker.lastRequest("init");
    // 幾何の口の有無とは別に、wasm が効果のある設定（v: 3）を読めるかだけで決める
    worker.respond({ type: "ready", id: init.id, version: "niho-develop 0.7.0 (engine niho-1)", runtime: "wasm", effects: true });

    expect(await supported).toBe(true);
    expect(await engine.supportsEffects()).toBe(true);
    expect(await engine.supportsGeometry()).toBe(false);
    expect(createWorker).toHaveBeenCalledOnce();
    expect(worker.requests("init")).toHaveLength(1);
  });

  it("ready に colorPoints: true が付いた wasm だけ色ミキサーを公開する", async () => {
    const worker = new FakeWorker();
    const engine = createDevelopEngine({ createWorker: () => worker as unknown as Worker, manifestUrl: MANIFEST_URL });
    const supported = engine.supportsColorPoints();
    worker.respond({
      type: "ready",
      id: worker.lastRequest("init").id,
      version: "niho-develop 0.19.0 (engine niho-11)",
      runtime: "wasm",
      colorPoints: true,
    });

    expect(await supported).toBe(true);
    expect(await engine.supportsColorPoints()).toBe(true);
    expect(await engine.supportsEffects()).toBe(false);

    engine.dispose();
    expect(await engine.supportsColorPoints()).toBe(false);
  });

  it("ready に detail: true が付いた wasm だけディテールを公開する（Issue #32）", async () => {
    const { engine } = await readyEngine({ features: { detail: true } });
    expect(await engine.supportsDetail()).toBe(true);
    const { engine: older } = await readyEngine({ features: { colorPoints: true } });
    expect(await older.supportsDetail()).toBe(false);
  });

  it("ディテールの送り方（Issue #32・owner 判断 2026-10-21）: 作業コピーは drag 中だけ NR を計算し直さず、確定描画・見本・色取得・書き出しは今の値", async () => {
    const { worker, engine } = await readyEngine({
      features: { detail: true, colorPoints: true, presetThumbnails: true },
      previewQuietMs: 0,
    });
    const sentRender = () => (worker.lastRequest("render") as { settingsJson: string }).settingsJson;
    const finishRender = async () => {
      worker.respond(frameResponse(worker.lastRequest("render").id, 1));
      await flushPromises();
    };
    const detail = { sharpening: { amount: 40, radius: 1, detail: 25, masking: 0 }, luminanceNoiseReduction: 20 };
    const jpeg = { v: 6, engine: "niho-10", look: "niho-standard-1", detail };

    // JPEG / PNG（open）は drag 中も今の値（NR を描く。シャープは crate が Final だけで当てる）
    const opened = engine.open(new ArrayBuffer(4), 2560);
    worker.respond({ type: "opened", id: worker.lastRequest("open").id, width: 4, height: 3 });
    await opened;
    void engine.render(jpeg, { maxDimension: 1280, interactive: true });
    expect(JSON.parse(sentRender())).toEqual(jpeg);
    await finishRender();

    // 旧 RAW の作業コピー: drag 中は detail を外し、確定描画は今の値
    const unsigned = { v: 6, engine: "niho-2", look: "niho-standard-1", detail };
    const working = engine.openWorkingCopy(new ArrayBuffer(8), '{"kind":"raw"}');
    worker.respond({ type: "opened", id: worker.lastRequest("openWorkingCopy").id, width: 2560, height: 1707 });
    await working;
    void engine.render(unsigned, { maxDimension: 1280, interactive: true });
    expect(JSON.parse(sentRender())).toEqual({ v: 6, engine: "niho-2", look: "niho-standard-1" });
    await finishRender();
    void engine.render(unsigned, { maxDimension: 1280, interactive: false });
    expect(JSON.parse(sentRender())).toEqual(unsigned);
    await finishRender();

    // signed RAW: drag 中は直前の確定描画の NR のまま（master を作り直さない）。確定描画は今の値
    const signed = { v: 6, engine: "niho-11", look: "niho-standard-5", detail: { ...detail, colorNoiseReduction: 30 } };
    void engine.render(signed, { maxDimension: 1280, interactive: false });
    expect(JSON.parse(sentRender())).toEqual(signed);
    await finishRender();
    const dragging = { ...signed, contrast: 12, detail: { ...signed.detail, luminanceNoiseReduction: 70, colorNoiseReduction: 60 } };
    void engine.render(dragging, { maxDimension: 1280, interactive: true });
    expect(JSON.parse(sentRender())).toEqual({ ...dragging, detail: { ...dragging.detail, luminanceNoiseReduction: 20, colorNoiseReduction: 30 } });
    await finishRender();
    void engine.render(dragging, { maxDimension: 1280, interactive: false });
    expect(JSON.parse(sentRender())).toEqual(dragging);
    await finishRender();

    // 色取得・見本・書き出しは確定描画と同じ今の値
    void engine.sampleColor(dragging, { maxDimension: 1280, x: 0.5, y: 0.5 });
    expect(JSON.parse((worker.lastRequest("sampleColor") as { settingsJson: string }).settingsJson)).toEqual(dragging);
    void engine.renderPresetThumbnail(dragging, 96);
    await flushPromises();
    expect(JSON.parse((worker.lastRequest("renderPresetThumbnail") as { settingsJson: string }).settingsJson)).toEqual(dragging);
    void engine.exportWorkingCopyJpeg(new ArrayBuffer(8), '{"kind":"raw"}', dragging, { maxDimension: 2048, quality: 90 });
    expect(JSON.parse((worker.lastRequest("exportWorkingCopyJpeg") as { settingsJson: string }).settingsJson)).toEqual(dragging);
  });

  it("ディテールを使わない写真は、作業コピーでも drag 中・確定描画とも今までと同じ設定の JSON を送る（量の無い detail は外す）", async () => {
    const { worker, engine } = await readyEngine({ features: { detail: true } });
    const working = engine.openWorkingCopy(new ArrayBuffer(8), '{"kind":"raw"}');
    worker.respond({ type: "opened", id: worker.lastRequest("openWorkingCopy").id, width: 2560, height: 1707 });
    await working;
    const plain = { v: 1, engine: "niho-11", look: "niho-standard-5", contrast: 10, colorNoiseReduction: 25 };
    for (const interactive of [false, true, false]) {
      void engine.render(plain, { maxDimension: 1280, interactive });
      expect((worker.lastRequest("render") as { settingsJson: string }).settingsJson).toBe(JSON.stringify(plain));
      worker.respond(frameResponse(worker.lastRequest("render").id, 1));
      await flushPromises();
    }
    const inert = { ...plain, v: 6, detail: { sharpening: { amount: 0, radius: 2, detail: 25, masking: 0 }, luminanceNoiseReduction: 0 } };
    for (const interactive of [false, true]) {
      void engine.render(inert, { maxDimension: 1280, interactive });
      expect((worker.lastRequest("render") as { settingsJson: string }).settingsJson).toBe(JSON.stringify({ ...plain, v: 6 }));
      worker.respond(frameResponse(worker.lastRequest("render").id, 1));
      await flushPromises();
    }
  });
  it("ready に perspective: true が付いた wasm だけ遠近（v7。niho-photo#46）を公開する", async () => {
    const worker = new FakeWorker();
    const engine = createDevelopEngine({ createWorker: () => worker as unknown as Worker, manifestUrl: MANIFEST_URL });
    const supported = engine.supportsPerspective();
    worker.respond({
      type: "ready",
      id: worker.lastRequest("init").id,
      version: "niho-develop 0.20.0 (engine niho-11)",
      runtime: "wasm",
      geometry: true,
      perspective: true,
    });

    expect(await supported).toBe(true);
    expect(await engine.supportsPerspective()).toBe(true);
    expect(await engine.supportsColorPoints()).toBe(false);

    engine.dispose();
    expect(await engine.supportsPerspective()).toBe(false);
  });

  it("perspective の無い ready（v7 を読めない wasm）では遠近を公開しない", async () => {
    const worker = new FakeWorker();
    const engine = createDevelopEngine({ createWorker: () => worker as unknown as Worker, manifestUrl: MANIFEST_URL });
    const supported = engine.supportsPerspective();
    worker.respond({ type: "ready", id: worker.lastRequest("init").id, version: "niho-develop 0.19.0 (engine niho-11)", runtime: "wasm", geometry: true });
    expect(await supported).toBe(false);
    expect(await engine.supportsGeometry()).toBe(true);
  });

  it("ready に heal: true が付いた wasm だけ修復の印（v8。niho-photo#44）を描けると答える", async () => {
    const worker = new FakeWorker();
    const engine = createDevelopEngine({ createWorker: () => worker as unknown as Worker, manifestUrl: MANIFEST_URL });
    const supported = engine.supportsHeal();
    worker.respond({
      type: "ready",
      id: worker.lastRequest("init").id,
      version: "niho-develop 0.22.0 (engine niho-11)",
      runtime: "wasm",
      geometry: true,
      perspective: true,
      heal: true,
    });

    expect(await supported).toBe(true);
    expect(await engine.supportsHeal()).toBe(true);

    engine.dispose();
    expect(await engine.supportsHeal()).toBe(false);
  });

  it("ready に lens: true が付いた wasm だけレンズ補正（v9。niho-photo#45）を描けると答える", async () => {
    const worker = new FakeWorker();
    const engine = createDevelopEngine({ createWorker: () => worker as unknown as Worker, manifestUrl: MANIFEST_URL });
    const supported = engine.supportsLens();
    worker.respond({
      type: "ready",
      id: worker.lastRequest("init").id,
      version: "niho-develop 0.23.0 (engine niho-13)",
      runtime: "wasm",
      geometry: true,
      heal: true,
      lens: true,
    });
    expect(await supported).toBe(true);
    expect(await engine.supportsLens()).toBe(true);
    engine.dispose();
    expect(await engine.supportsLens()).toBe(false);
  });

  it("lens の無い ready（v9 を読めない wasm）ではレンズ補正を描けないと答える", async () => {
    const worker = new FakeWorker();
    const engine = createDevelopEngine({ createWorker: () => worker as unknown as Worker, manifestUrl: MANIFEST_URL });
    const supported = engine.supportsLens();
    worker.respond({ type: "ready", id: worker.lastRequest("init").id, version: "niho-develop 0.22.0 (engine niho-13)", runtime: "wasm", heal: true });
    expect(await supported).toBe(false);
    expect(await engine.supportsHeal()).toBe(true);
  });

  it("heal の無い ready（v8 を読めない wasm）では修復を描けないと答える", async () => {
    const worker = new FakeWorker();
    const engine = createDevelopEngine({ createWorker: () => worker as unknown as Worker, manifestUrl: MANIFEST_URL });
    const supported = engine.supportsHeal();
    worker.respond({ type: "ready", id: worker.lastRequest("init").id, version: "niho-develop 0.21.0 (engine niho-11)", runtime: "wasm", geometry: true, perspective: true });
    expect(await supported).toBe(false);
    expect(await engine.supportsPerspective()).toBe(true);
  });

  it("ready に upright: true が付いた wasm だけ Upright（niho-photo#46 後半）を推定し、結果の JSON を読む", async () => {
    const { worker, engine } = await readyEngine({ geometry: true, features: { perspective: true, upright: true } });
    expect(await engine.supportsUpright()).toBe(true);
    const settings = { v: 1, engine: "niho-11", geometry: { rotate: 90 } };
    const estimated = engine.estimateUpright(settings, 3);
    const request = worker.lastRequest("estimateUpright");
    expect(request).toEqual({ type: "estimateUpright", id: request.id, settingsJson: JSON.stringify(settings), mode: 3 });
    const perspective = { vertical: -31.5, horizontal: 0, rotate: 1.25, aspect: 0, scale: 100, x: 0, y: 0 };
    worker.respond({
      type: "upright",
      id: request.id,
      resultJson: JSON.stringify({ perspective, mode: 3, confidence: 0.9, lines: { vertical: 12, horizontal: 4 } }),
    });
    await expect(estimated).resolves.toEqual({
      perspective,
      mode: 3,
      confidence: 0.9,
      lines: { vertical: 12, horizontal: 4 },
      reason: null,
    });

    // 読めない結果・error は reject
    const broken = engine.estimateUpright(settings, 1);
    worker.respond({ type: "upright", id: worker.lastRequest("estimateUpright").id, resultJson: '{"mode":9}' });
    await expect(broken).rejects.toThrow("develop engine returned an invalid upright estimate");
    const failed = engine.estimateUpright(settings, 1);
    worker.respond({ type: "error", id: worker.lastRequest("estimateUpright").id, message: "no photo is open" });
    await expect(failed).rejects.toThrow("no photo is open");
  });

  it("upright の無い ready（古い wasm）では Upright を出さず、要求も送らない", async () => {
    const { worker, engine } = await readyEngine({ geometry: true, features: { perspective: true } });
    expect(await engine.supportsUpright()).toBe(false);
    await expect(engine.estimateUpright({}, 1)).rejects.toThrow("develop engine cannot estimate upright");
    expect(worker.requests("estimateUpright")).toEqual([]);
  });

  it("sampleColor は設定・描画長辺・正規化座標を worker に渡す", async () => {
    const { worker, engine } = await readyEngine({ features: { colorPoints: true } });
    const sampled = engine.sampleColor({ v: 4, colorPoints: [] }, { maxDimension: 1280, x: 0.2, y: 0.8 });
    const request = worker.lastRequest("sampleColor");
    expect(request).toMatchObject({
      type: "sampleColor",
      maxDimension: 1280,
      x: 0.2,
      y: 0.8,
    });
    worker.respond({ type: "sampledColor", id: request.id, lightness: 0.72, chroma: 0.08, hue: 50 });
    await expect(sampled).resolves.toEqual({ lightness: 0.72, chroma: 0.08, hue: 50 });
  });

  it("effects が付かない ready（v: 3 を読めない wasm）・使えない engine では supportsEffects は false（版が新しくても。throw しない）", async () => {
    const respondReady = async (message: { version: string; effects?: true }) => {
      const worker = new FakeWorker();
      const engine = createDevelopEngine({ createWorker: () => worker as unknown as Worker, manifestUrl: MANIFEST_URL });
      const supported = engine.supportsEffects();
      worker.respond({ type: "ready", id: worker.lastRequest("init").id, runtime: "wasm", ...message });
      return { engine, worker, supported: await supported };
    };
    // 公開済みの wasm 0.6.0 は効果を描けるが v: 3 を断る。版が 0.5.0 以上でも、読めると言わない wasm には出さない
    expect((await respondReady({ version: "niho-develop 0.6.0 (engine niho-1)" })).supported).toBe(false);
    expect((await respondReady({ version: "0.4.0" })).supported).toBe(false);
    expect((await respondReady({ version: "" })).supported).toBe(false);
    expect((await respondReady({ version: "0.7.0", effects: true })).supported).toBe(true);

    const unavailable = createDevelopEngine({ createWorker: () => null, manifestUrl: MANIFEST_URL });
    expect(await unavailable.supportsEffects()).toBe(false);

    const { engine, worker } = await respondReady({ version: "0.7.0", effects: true });
    engine.dispose();
    expect(worker.terminated).toBe(true);
    expect(await engine.supportsEffects()).toBe(false);
  });

  it("imageSize は bytes をコピーで渡し（transfer しない）、rasterDecodeSize・geometryOutputSize は設定の JSON を送る", async () => {
    const { worker, engine } = await readyEngine({ geometry: true });
    const settings = { v: 2, engine: "niho-1", geometry: { crop: { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 } } };
    const bytes = new ArrayBuffer(8);

    const size = engine.imageSize(bytes);
    const sizeRequest = worker.lastRequest("imageSize");
    expect(sizeRequest).toEqual({ type: "imageSize", id: sizeRequest.id, bytes });
    expect(worker.posted.at(-1)?.transfer).toEqual([]);
    worker.respond({ type: "size", id: sizeRequest.id, width: 6000, height: 4000 });
    expect(await size).toEqual({ width: 6000, height: 4000 });

    const decode = engine.rasterDecodeSize(settings, { width: 6000, height: 4000 }, 1280, 4096);
    const decodeRequest = worker.lastRequest("rasterDecodeSize");
    expect(decodeRequest).toEqual({
      type: "rasterDecodeSize",
      id: decodeRequest.id,
      settingsJson: JSON.stringify(settings),
      width: 6000,
      height: 4000,
      maxDimension: 1280,
      cap: 4096,
    });
    worker.respond({ type: "decodeSize", id: decodeRequest.id, size: 2560 });
    expect(await decode).toBe(2560);

    const output = engine.geometryOutputSize(settings, { width: 2560, height: 1707 }, 1280);
    const outputRequest = worker.lastRequest("geometryOutputSize");
    expect(outputRequest).toEqual({
      type: "geometryOutputSize",
      id: outputRequest.id,
      settingsJson: JSON.stringify(settings),
      sourceWidth: 2560,
      sourceHeight: 1707,
      maxDimension: 1280,
    });
    worker.respond({ type: "size", id: outputRequest.id, width: 1280, height: 853 });
    expect(await output).toEqual({ width: 1280, height: 853 });

    // 同じ bytes をこの後 open に渡せる（open は transfer する）
    const opened = engine.open(bytes, 2560);
    expect(worker.lastRequest("open")).toMatchObject({ type: "open", bytes, workingMaxDimension: 2560 });
    expect(worker.posted.at(-1)?.transfer).toEqual([bytes]);
    worker.respond({ type: "opened", id: worker.lastRequest("open").id, width: 2560, height: 1707 });
    expect(await opened).toEqual({ width: 2560, height: 1707 });
  });

  it("幾何の要求は描画の枠を使わず（出している描画を待たせない・追い越さない）、違う形の応答と error は reject", async () => {
    const { worker, engine } = await readyEngine({ geometry: true });
    const first = engine.render({ exposure: 1 }, { maxDimension: 1280, interactive: false });
    const queued = engine.render({ exposure: 2 }, { maxDimension: 1280, interactive: false });
    const output = engine.geometryOutputSize({}, { width: 2560, height: 1707 }, 1280);
    const decode = engine.rasterDecodeSize({}, { width: 6000, height: 4000 }, 1280, 4096);

    // 描画は 1 つだけ出ていて、幾何の要求はすぐに出る
    expect(worker.requests("render")).toHaveLength(1);
    expect(worker.requests("geometryOutputSize")).toHaveLength(1);
    worker.respond({ type: "error", id: worker.lastRequest("geometryOutputSize").id, message: "geometry.crop: invalidCrop" });
    await expect(output).rejects.toThrow("geometry.crop: invalidCrop");
    worker.respond({ type: "closed", id: worker.lastRequest("rasterDecodeSize").id });
    await expect(decode).rejects.toBeInstanceOf(DevelopEngineError);

    const firstRequest = worker.lastRequest("render");
    worker.respond(frameResponse(firstRequest.id, 1));
    expect((await first)?.rgba[0]).toBe(1);
    const secondRequest = worker.lastRequest("render");
    expect(secondRequest.id).not.toBe(firstRequest.id);
    worker.respond(frameResponse(secondRequest.id, 2));
    expect((await queued)?.rgba[0]).toBe(2);
  });

  it("withCaptureExif は JPEG（view の指す分だけ）を transfer し、EXIF を付けた JPEG を返す。error は reject（F7b #17127）", async () => {
    const { worker, engine } = await readyEngine();
    const whole = new Uint8Array([9, 0xff, 0xd8, 0xff, 0xd9, 9]);
    const exif = engine.withCaptureExif(whole.subarray(1, 5), "2026-09-17T02:12:59.000Z", 540);
    const request = worker.lastRequest("withCaptureExif");
    expect(request).toMatchObject({ type: "withCaptureExif", capturedAt: "2026-09-17T02:12:59.000Z", offsetMinutes: 540 });
    const sent = request.type === "withCaptureExif" ? request.bytes : null;
    expect(Array.from(new Uint8Array(sent ?? new ArrayBuffer(0)))).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect(worker.posted.at(-1)?.transfer).toEqual([sent]);
    worker.respond({ type: "jpeg", id: request.id, bytes: new Uint8Array([0xff, 0xd8, 0xe1, 0xff, 0xd9]).buffer });
    expect(Array.from(await exif)).toEqual([0xff, 0xd8, 0xe1, 0xff, 0xd9]);

    const failed = engine.withCaptureExif(new Uint8Array([0xff, 0xd8]), "2026-09-17T02:12:59.000Z", 540);
    worker.respond({ type: "error", id: worker.lastRequest("withCaptureExif").id, message: "develop engine cannot write EXIF" });
    await expect(failed).rejects.toBeInstanceOf(DevelopEngineError);
  });

  it("dispose は EXIF を付けている途中の JPEG も待ってから Worker を止める", async () => {
    const { worker, engine } = await readyEngine();
    const exif = engine.withCaptureExif(new Uint8Array([0xff, 0xd8]), "2026-09-17T02:12:59.000Z", 540);
    engine.dispose();
    expect(worker.terminated).toBe(false);

    worker.respond({ type: "jpeg", id: worker.lastRequest("withCaptureExif").id, bytes: new Uint8Array([7]).buffer });
    expect(Array.from(await exif)).toEqual([7]);
    expect(worker.terminated).toBe(true);
  });

  it("プリセットの口（F2a #17135）は ready の応答で分かる。無い wasm・使えない engine では false（throw しない）", async () => {
    const { engine } = await readyEngine({ features: { presetAmount: true, settingsToXmp: true, presetThumbnails: true } });
    expect(await engine.supportsPresetAmount()).toBe(true);
    expect(await engine.supportsSettingsToXmp()).toBe(true);
    expect(await engine.supportsPresetThumbnails()).toBe(true);

    const { engine: partial } = await readyEngine({ features: { presetAmount: true } });
    expect(await partial.supportsPresetAmount()).toBe(true);
    expect(await partial.supportsSettingsToXmp()).toBe(false);
    expect(await partial.supportsPresetThumbnails()).toBe(false);

    const { engine: old } = await readyEngine();
    expect(await old.supportsPresetAmount()).toBe(false);
    expect(await old.supportsSettingsToXmp()).toBe(false);
    expect(await old.supportsPresetThumbnails()).toBe(false);
    // 見本の口の無い wasm には送らない
    await expect(old.renderPresetThumbnail({}, 96)).rejects.toBeInstanceOf(DevelopEngineError);

    const unavailable = createDevelopEngine({ createWorker: () => null, manifestUrl: MANIFEST_URL });
    expect(await unavailable.supportsPresetAmount()).toBe(false);
    expect(await unavailable.supportsSettingsToXmp()).toBe(false);
    expect(await unavailable.supportsPresetThumbnails()).toBe(false);
    await expect(unavailable.applyPreset("<x:xmpmeta/>", {}, 0.5)).rejects.toBeInstanceOf(DevelopEngineError);
    await expect(unavailable.settingsToXmp({}, { name: "a" })).rejects.toBeInstanceOf(DevelopEngineError);
    await expect(unavailable.renderPresetThumbnail({}, 96)).rejects.toBeInstanceOf(DevelopEngineError);
  });

  it("applyPreset は base の JSON と適用量を送り、結果を presetSettings と同じ形で読む（捨てずに順に。描画の枠は使わない）", async () => {
    const { worker, engine } = await readyEngine({ features: { presetAmount: true } });
    const inFlight = engine.render({}, { maxDimension: 1280, interactive: false });
    const half = engine.applyPreset("<x:xmpmeta/>", { v: 1, engine: "niho-1", base: null }, 0.5);
    const zero = engine.applyPreset("<x:xmpmeta/>", { v: 1, engine: "niho-1", base: null }, 0);
    const [first, second] = worker.requests("applyPreset");
    expect(first).toEqual({
      type: "applyPreset",
      id: first!.id,
      xmp: "<x:xmpmeta/>",
      baseSettingsJson: '{"v":1,"engine":"niho-1","base":null}',
      amount: 0.5,
    });
    expect(second).toMatchObject({ amount: 0 });

    worker.respond({
      type: "preset",
      id: first!.id,
      resultJson: JSON.stringify({
        name: "bluesky2",
        settings: { v: 1, engine: "niho-1", base: null, contrast: 6 },
        converted: true,
        unsupported: [],
        amount: 0.5,
      }),
    });
    expect(await half).toEqual({
      name: "bluesky2",
      settings: { v: 1, engine: "niho-1", base: null, contrast: 6 },
      converted: true,
      unsupported: [],
    });
    worker.respond({ type: "error", id: second!.id, message: "develop engine cannot change the preset amount" });
    await expect(zero).rejects.toThrow("develop engine cannot change the preset amount");

    const broken = engine.applyPreset("<x:xmpmeta/>", {}, 1);
    worker.respond({ type: "preset", id: worker.lastRequest("applyPreset").id, resultJson: '{"settings":{}}' });
    await expect(broken).rejects.toBeInstanceOf(DevelopEngineError);
    // 描画は待たせていない
    worker.respond(frameResponse(worker.lastRequest("render").id, 1));
    expect((await inFlight)?.rgba[0]).toBe(1);
  });

  it("開いている写真なしのプリセット（F5a-2 #17140）: 口は ready の応答で分かり、applyPreset に作業コピーのメタを渡せる", async () => {
    const { worker, engine } = await readyEngine({ features: { presetAmount: true, presetFromMeta: true } });
    expect(await engine.supportsPresetFromMeta()).toBe(true);

    const raw = engine.applyPreset("<x:xmpmeta/>", { v: 1, engine: "niho-1" }, 1, { workMetaJson: '{"kind":"raw"}' });
    const jpeg = engine.applyPreset("<x:xmpmeta/>", { v: 1, engine: "niho-1" }, 1, { workMetaJson: null });
    const [first, second] = worker.requests("applyPreset");
    expect(first).toEqual({
      type: "applyPreset",
      id: first!.id,
      xmp: "<x:xmpmeta/>",
      baseSettingsJson: '{"v":1,"engine":"niho-1"}',
      amount: 1,
      asShotMetaJson: '{"kind":"raw"}',
    });
    // JPEG / PNG は撮影時の白なし（null を送り、開いている写真の白を使わせない）
    expect(second).toMatchObject({ asShotMetaJson: null });
    const resultJson = JSON.stringify({ name: "x", settings: { v: 1, engine: "niho-1" }, converted: true, unsupported: [] });
    worker.respond({ type: "preset", id: first!.id, resultJson });
    worker.respond({ type: "preset", id: second!.id, resultJson });
    expect((await raw).converted).toBe(true);
    expect((await jpeg).converted).toBe(true);
  });

  it("口（asShotWhiteFromMeta）の無い wasm では supportsPresetFromMeta が false で、メタを渡した applyPreset は送らずに reject（省けば今までどおり）", async () => {
    const { worker, engine } = await readyEngine({ features: { presetAmount: true } });
    expect(await engine.supportsPresetFromMeta()).toBe(false);
    await expect(engine.applyPreset("<x:xmpmeta/>", {}, 1, { workMetaJson: null })).rejects.toBeInstanceOf(DevelopEngineError);
    expect(worker.requests("applyPreset")).toHaveLength(0);

    // 1 枚の面の呼び方（撮影時の白は開いている写真）は要求の形も変えない
    void engine.applyPreset("<x:xmpmeta/>", {}, 0.5);
    expect(worker.lastRequest("applyPreset")).not.toHaveProperty("asShotMetaJson");

    const unavailable = createDevelopEngine({ createWorker: () => null, manifestUrl: MANIFEST_URL });
    expect(await unavailable.supportsPresetFromMeta()).toBe(false);
  });

  it("settingsToXmp は name と群の JSON を送り、{ xmp, notWritten } を読む（群を省くと crate の既定）", async () => {
    const { worker, engine } = await readyEngine({ features: { settingsToXmp: true } });
    const withGroups = engine.settingsToXmp({ v: 1, contrast: 12 }, { name: "夕方の窓辺", groups: ["exposure", "tone"] });
    const defaults = engine.settingsToXmp({ v: 1 }, { name: "朝" });
    const [first, second] = worker.requests("settingsToXmp");
    expect(first).toEqual({
      type: "settingsToXmp",
      id: first!.id,
      settingsJson: '{"v":1,"contrast":12}',
      optionsJson: '{"name":"夕方の窓辺","groups":["exposure","tone"]}',
    });
    expect(second).toMatchObject({ optionsJson: '{"name":"朝"}' });

    worker.respond({
      type: "xmp",
      id: first!.id,
      resultJson: JSON.stringify({ xmp: "<x:xmpmeta/>", notWritten: ["relativeTemperature", 1] }),
    });
    expect(await withGroups).toEqual({ xmp: "<x:xmpmeta/>", notWritten: ["relativeTemperature"] });
    worker.respond({ type: "xmp", id: second!.id, resultJson: JSON.stringify({ xmp: "" }) });
    await expect(defaults).rejects.toBeInstanceOf(DevelopEngineError);
  });

  it("renderPresetThumbnail は preview の枠: 出している描画を待ち、編集の描画を先に出してから見本を丁寧に描く", async () => {
    vi.useFakeTimers();
    const { worker, engine } = await readyEngine({ features: { presetThumbnails: true } });
    const inFlight = engine.render({ step: 0 }, { maxDimension: 1280, interactive: false });
    const thumbnail = engine.renderPresetThumbnail({ contrast: 12 }, 96);
    const edit = engine.render({ step: 1 }, { maxDimension: 1280, interactive: true });
    expect(worker.requests("renderPresetThumbnail")).toHaveLength(0);

    worker.respond(frameResponse(worker.lastRequest("render").id, 10));
    expect((await inFlight)?.rgba[0]).toBe(10);
    await flushPromises();
    // 編集の描画が先
    expect(worker.requests("renderPresetThumbnail")).toHaveLength(0);
    const editRequest = worker.lastRequest("render");
    expect(editRequest).toMatchObject({ settingsJson: '{"step":1}', interactive: true });
    worker.respond(frameResponse(editRequest.id, 11));
    expect((await edit)?.rgba[0]).toBe(11);
    await flushPromises();
    // 編集の描画が終わってから静かな時間がたってから見本
    expect(worker.requests("renderPresetThumbnail")).toHaveLength(0);
    vi.advanceTimersByTime(DEVELOP_PREVIEW_QUIET_MS);

    const request = worker.lastRequest("renderPresetThumbnail");
    expect(request).toEqual({ type: "renderPresetThumbnail", id: request.id, settingsJson: '{"contrast":12}', maxDimension: 96 });
    worker.respond(frameResponse(request.id, 12));
    expect((await thumbnail)?.rgba[0]).toBe(12);

    // Worker が空いていればすぐ出す。失敗は reject
    const failing = engine.renderPresetThumbnail({}, 96);
    worker.respond({ type: "error", id: worker.lastRequest("renderPresetThumbnail").id, message: "no photo is open" });
    await expect(failing).rejects.toThrow("no photo is open");
  });

  it("写真を開き直す・閉じると、見本の要求は null で終える（出している見本の結果も捨てる）", async () => {
    const { worker, engine } = await readyEngine({ features: { presetThumbnails: true } });
    const inFlight = engine.renderPresetThumbnail({ step: 0 }, 96);
    const queued = engine.renderPresetThumbnail({ step: 1 }, 96);
    const thumbnailId = worker.lastRequest("renderPresetThumbnail").id;
    void engine.open(new ArrayBuffer(4), 1280).catch(() => undefined);

    expect(await inFlight).toBeNull();
    expect(await queued).toBeNull();
    worker.respond(frameResponse(thumbnailId, 1));
    await flushPromises();
    expect(worker.requests("renderPresetThumbnail")).toHaveLength(1);

    worker.respond({ type: "opened", id: worker.lastRequest("open").id, width: 1280, height: 853 });
    const afterOpen = engine.renderPresetThumbnail({ step: 2 }, 96);
    const pendingId = worker.lastRequest("renderPresetThumbnail").id;
    void engine.close().catch(() => undefined);
    expect(await afterOpen).toBeNull();
    worker.respond(frameResponse(pendingId, 2));
    await flushPromises();
    expect(worker.requests("renderPresetThumbnail")).toHaveLength(2);
  });

  it("見本は編集の描画が無い間だけ: 押した・乗せた（yieldToEdit）後と編集の描画の後は、静かな時間がたってから出す（#126）", async () => {
    vi.useFakeTimers();
    const { worker, engine } = await readyEngine({ features: { presetThumbnails: true } });
    // 何も編集していなければ見本はすぐ出す
    const first = engine.renderPresetThumbnail({ step: 0 }, 96);
    const firstId = worker.lastRequest("renderPresetThumbnail").id;
    worker.respond(frameResponse(firstId, 1));
    expect((await first)?.rgba[0]).toBe(1);

    // プリセットを押した: Worker が空いていても次の見本は持ったまま
    engine.yieldToEdit();
    const held = engine.renderPresetThumbnail({ step: 1 }, 96);
    expect(worker.requests("renderPresetThumbnail")).toHaveLength(1);
    // 押した結果の描画はすぐ出す（見本の後ろで待たない）
    const applied = engine.render({ step: 2 }, { maxDimension: 1280, interactive: false });
    const appliedRequest = worker.lastRequest("render");
    expect(appliedRequest).toMatchObject({ settingsJson: '{"step":2}', interactive: false });
    // 描いている間に静かな時間が過ぎても、編集の描画が終わるまで見本は出さない
    vi.advanceTimersByTime(DEVELOP_PREVIEW_QUIET_MS * 2);
    expect(worker.requests("renderPresetThumbnail")).toHaveLength(1);
    worker.respond(frameResponse(appliedRequest.id, 2));
    expect((await applied)?.rgba[0]).toBe(2);
    await flushPromises();
    expect(worker.requests("renderPresetThumbnail")).toHaveLength(1);

    // 静かな時間の途中で次の編集が来たら、終わってから数え直す
    vi.advanceTimersByTime(DEVELOP_PREVIEW_QUIET_MS - 1);
    const drag = engine.render({ step: 3 }, { maxDimension: 640, interactive: true });
    const dragRequest = worker.lastRequest("render");
    worker.respond(frameResponse(dragRequest.id, 3));
    expect((await drag)?.rgba[0]).toBe(3);
    vi.advanceTimersByTime(DEVELOP_PREVIEW_QUIET_MS - 1);
    expect(worker.requests("renderPresetThumbnail")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const heldRequest = worker.lastRequest("renderPresetThumbnail");
    expect(heldRequest).toMatchObject({ settingsJson: '{"step":1}' });
    worker.respond(frameResponse(heldRequest.id, 4));
    expect((await held)?.rgba[0]).toBe(4);

    // 待っている見本は、写真を開き直すと null で終える（出さない）
    engine.yieldToEdit();
    const dropped = engine.renderPresetThumbnail({ step: 5 }, 96);
    void engine.open(new ArrayBuffer(4), 1280).catch(() => undefined);
    expect(await dropped).toBeNull();
    vi.advanceTimersByTime(DEVELOP_PREVIEW_QUIET_MS);
    expect(worker.requests("renderPresetThumbnail")).toHaveLength(2);
    engine.dispose();
  });

  it("previewQuietMs が 0 なら見本を待たせない（今までの順番）", async () => {
    const { worker, engine } = await readyEngine({ features: { presetThumbnails: true }, previewQuietMs: 0 });
    const edit = engine.render({ step: 0 }, { maxDimension: 1280, interactive: false });
    const thumbnail = engine.renderPresetThumbnail({ step: 1 }, 96);
    worker.respond(frameResponse(worker.lastRequest("render").id, 1));
    expect((await edit)?.rgba[0]).toBe(1);
    await flushPromises();
    engine.yieldToEdit();
    const request = worker.lastRequest("renderPresetThumbnail");
    worker.respond(frameResponse(request.id, 2));
    expect((await thumbnail)?.rgba[0]).toBe(2);
  });

  it("診断の間だけ、描画ごとに枠での待ちと Worker との往復を出す（設定は出さない）", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const { worker, engine } = await readyEngine({ features: { presetThumbnails: true }, diagnostics: true, previewQuietMs: 0 });
      const final = engine.render({ secret: "do-not-log" }, { maxDimension: 1280, interactive: false });
      const thumbnail = engine.renderPresetThumbnail({ secret: "do-not-log" }, 96);
      worker.respond(frameResponse(worker.lastRequest("render").id, 1));
      await final;
      await flushPromises();
      worker.respond({ type: "error", id: worker.lastRequest("renderPresetThumbnail").id, message: "no photo is open" });
      await expect(thumbnail).rejects.toThrow("no photo is open");

      const records = info.mock.calls.filter(([tag]) => tag === "[photo-develop-perf]").map(([, record]) => record as Record<string, unknown>);
      expect(records).toEqual([
        { stage: "runtime", runtime: "wasm" },
        { stage: "renderRequest", priority: "final", queuedMs: expect.any(Number), roundTripMs: expect.any(Number), status: "ok" },
        { stage: "presetThumbnailRequest", priority: "preview", queuedMs: expect.any(Number), roundTripMs: expect.any(Number), status: "error" },
      ]);
      expect(JSON.stringify(records)).not.toContain("do-not-log");

      const { worker: quietWorker, engine: quiet } = await readyEngine({ diagnostics: false });
      const plain = quiet.render({}, { maxDimension: 1280, interactive: false });
      quietWorker.respond(frameResponse(quietWorker.lastRequest("render").id, 1));
      await plain;
      expect(info.mock.calls.filter(([tag]) => tag === "[photo-develop-perf]")).toHaveLength(3);
    } finally {
      info.mockRestore();
    }
  });

  it("「自動」の口（F4a #17123）は ready の応答で分かる。無い wasm・使えない engine では false（throw しない。要求も送らない）", async () => {
    const { engine } = await readyEngine({ features: { auto: true } });
    expect(await engine.supportsAuto()).toBe(true);

    const { worker: oldWorker, engine: old } = await readyEngine({ features: { presetAmount: true } });
    expect(await old.supportsAuto()).toBe(false);
    await expect(old.autoSettings({ v: 1, engine: "niho-1" })).rejects.toBeInstanceOf(DevelopEngineError);
    expect(oldWorker.requests("autoSettings")).toHaveLength(0);

    const unavailable = createDevelopEngine({ createWorker: () => null, manifestUrl: MANIFEST_URL });
    expect(await unavailable.supportsAuto()).toBe(false);
    await expect(unavailable.autoSettings({})).rejects.toBeInstanceOf(DevelopEngineError);
  });

  it("autoSettings は今の設定の JSON を送り、結果を編集内容として読む（捨てずに順に。描画の枠は使わない）", async () => {
    const { worker, engine } = await readyEngine({ geometry: true, features: { auto: true } });
    const inFlight = engine.render({}, { maxDimension: 1280, interactive: false });
    const current = { v: 2, engine: "niho-1", look: "niho-standard-1", base: null, contrast: 12, geometry: { rotate: 90 } };
    const first = engine.autoSettings(current);
    const second = engine.autoSettings({ v: 1, engine: "niho-1" });
    const [firstRequest, secondRequest] = worker.requests("autoSettings");
    expect(firstRequest).toEqual({ type: "autoSettings", id: firstRequest!.id, settingsJson: JSON.stringify(current) });
    expect(secondRequest).toMatchObject({ settingsJson: '{"v":1,"engine":"niho-1"}' });

    worker.respond({
      type: "auto",
      id: firstRequest!.id,
      settingsJson: JSON.stringify({ ...current, exposure: 0.35, shadows: 20, vibrance: 12 }),
    });
    expect(await first).toEqual({ ...current, exposure: 0.35, shadows: 20, vibrance: 12 });
    worker.respond({ type: "error", id: secondRequest!.id, message: "no photo is open" });
    await expect(second).rejects.toThrow("no photo is open");

    // 編集内容として読めない結果（形の版が無い・JSON でない）・違う形の応答は reject
    for (const settingsJson of ['{"engine":"niho-1"}', "not json"]) {
      const broken = engine.autoSettings({});
      worker.respond({ type: "auto", id: worker.lastRequest("autoSettings").id, settingsJson });
      await expect(broken).rejects.toBeInstanceOf(DevelopEngineError);
    }
    const wrong = engine.autoSettings({});
    worker.respond({ type: "preset", id: worker.lastRequest("autoSettings").id, resultJson: "{}" });
    await expect(wrong).rejects.toBeInstanceOf(DevelopEngineError);

    // 描画は待たせていない
    expect(worker.requests("render")).toHaveLength(1);
    worker.respond(frameResponse(worker.lastRequest("render").id, 1));
    expect((await inFlight)?.rgba[0]).toBe(1);
  });

  it("描き途中の JPEG が無ければ dispose ですぐに止める", async () => {
    const { worker, engine } = await readyEngine();
    engine.dispose();
    expect(worker.terminated).toBe(true);
  });

  describe("部分補正（マスク。M3 #67）", () => {
    const MASKS = { kinds: ["linear", "radial"], max: 8, maskPlane: true };

    function planeResponse(id: number, value: number): DevelopEngineWorkerResponse {
      return { type: "maskPlane", id, width: 2, height: 1, data: new Uint8Array([value, 255 - value]).buffer };
    }

    it("supportsMasks は ready の masks（無い wasm・使えない engine は null。throw しない）", async () => {
      const { engine } = await readyEngine({ features: { masks: MASKS } });
      expect(await engine.supportsMasks?.()).toEqual(MASKS);
      const { engine: old } = await readyEngine();
      expect(await old.supportsMasks?.()).toBeNull();
      await expect(old.maskPlane?.({}, "mask-a", { maxDimension: 640 })).rejects.toBeInstanceOf(DevelopEngineError);
      const unavailable = createDevelopEngine({ createWorker: () => null, manifestUrl: MANIFEST_URL });
      expect(await unavailable.supportsMasks?.()).toBeNull();
      engine.dispose();
      expect(await engine.supportsMasks?.()).toBeNull();
    });

    it("maskPlane は設定・id・長辺を送り、面を返す。同時に 1 つまでで、出している間の要求は最新の 1 つだけを次に出す", async () => {
      const { worker, engine } = await readyEngine({ features: { masks: MASKS } });
      const first = engine.maskPlane!({ v: 5, masks: [] }, "mask-a", { maxDimension: 640 });
      const second = engine.maskPlane!({ v: 5 }, "mask-a", { maxDimension: 640 });
      const third = engine.maskPlane!({ v: 5 }, "mask-b", { maxDimension: 1280 });
      expect(worker.requests("maskPlane")).toHaveLength(1);
      expect(worker.lastRequest("maskPlane")).toMatchObject({
        type: "maskPlane",
        settingsJson: JSON.stringify({ v: 5, masks: [] }),
        maskId: "mask-a",
        maxDimension: 640,
      });
      // 追い越された「次」は null
      await expect(second).resolves.toBeNull();
      worker.respond(planeResponse(worker.lastRequest("maskPlane").id, 10));
      const plane = await first;
      expect(plane?.width).toBe(2);
      expect(Array.from(plane?.data ?? [])).toEqual([10, 245]);
      await flushPromises();
      expect(worker.requests("maskPlane")).toHaveLength(2);
      expect(worker.lastRequest("maskPlane")).toMatchObject({ maskId: "mask-b", maxDimension: 1280 });
      worker.respond({ type: "error", id: worker.lastRequest("maskPlane").id, message: "maskNotFound" });
      await expect(third).rejects.toThrow("maskNotFound");
    });

    it("maskPlane は描画の枠を使わない（描画を取り消さない・待たせない）。写真を開き直すと面の結果は捨てる", async () => {
      const { worker, engine } = await readyEngine({ features: { masks: MASKS } });
      const render = engine.render({}, { maxDimension: 1280, interactive: true });
      const plane = engine.maskPlane!({}, "mask-a", { maxDimension: 640 });
      expect(worker.requests("render")).toHaveLength(1);
      expect(worker.requests("maskPlane")).toHaveLength(1);
      worker.respond(frameResponse(worker.lastRequest("render").id, 3));
      expect((await render)?.rgba[0]).toBe(3);
      const opened = engine.open(new ArrayBuffer(4), 1280);
      await expect(plane).resolves.toBeNull();
      // 遅れて来た古い面は捨てる（次の要求を止めない）
      worker.respond(planeResponse(worker.lastRequest("maskPlane").id, 1));
      worker.respond({ type: "opened", id: worker.lastRequest("open").id, width: 4, height: 2 });
      await opened;
      const next = engine.maskPlane!({}, "mask-a", { maxDimension: 640 });
      expect(worker.requests("maskPlane")).toHaveLength(2);
      worker.respond(planeResponse(worker.lastRequest("maskPlane").id, 7));
      expect(Array.from((await next)?.data ?? [])).toEqual([7, 248]);
    });
  });
});
