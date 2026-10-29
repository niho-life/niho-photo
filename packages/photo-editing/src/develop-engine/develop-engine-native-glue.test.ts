import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createNativeDevelopAnalysisStore } from "./develop-engine-analysis-store";
import { DEVELOP_ENGINE_CRATE_VERSION, DEVELOP_ENGINE_VERSION, developEngineManifestPath } from "./develop-engine-manifest";
import {
  createNativeDevelopGlue,
  createSyncXhrTransport,
  decodeNativeDevelopBody,
  encodeNativeDevelopBody,
  NATIVE_DEVELOP_DEVELOPER_METHODS,
  NATIVE_DEVELOP_FUNCTIONS,
  NATIVE_DEVELOP_METHODS,
  NativeDevelopUnavailableError,
  type NativeDevelopTransport,
} from "./develop-engine-native-glue";
import { createDevelopEngineWorkerHandler, type DevelopEngineWorkerResponse } from "./develop-engine-worker-core";

type Sent = { method: string; header: Record<string, unknown>; blobs: Uint8Array[] };
type Reply = { ok: true; result: unknown; blobs?: Uint8Array[] } | { ok: false; error: string; code?: string };

function ok(result: unknown, blobs: Uint8Array[] = []): Reply {
  return { ok: true, result, blobs };
}

function replyBody(reply: Reply): ArrayBuffer {
  const { blobs = [], ...header } = reply as Reply & { blobs?: Uint8Array[] };
  return encodeNativeDevelopBody(header, blobs).buffer;
}

const HELLO = {
  protocol: 1,
  tool: `niho-develop-render ${DEVELOP_ENGINE_CRATE_VERSION} (niho-develop ${DEVELOP_ENGINE_CRATE_VERSION}, engine ${DEVELOP_ENGINE_VERSION})`,
  crateVersion: DEVELOP_ENGINE_CRATE_VERSION,
  engine: DEVELOP_ENGINE_VERSION,
  threads: 8,
  methods: [...NATIVE_DEVELOP_METHODS],
};

/** `niho-develop-render serve` の代わり（本文を読み、口ごとに答える）。 */
function fakeServe(overrides: Partial<Record<string, (sent: Sent) => Reply>> = {}) {
  const sent: Sent[] = [];
  const developers = new Map<number, { width: number; height: number; client: unknown }>();
  let nextHandle = 1;
  const open = (request: Sent, width: number, height: number): Reply => {
    const handle = nextHandle;
    nextHandle += 1;
    developers.set(handle, { width, height, client: request.header.client });
    return ok({ handle, width, height });
  };
  const frame = (width: number, height: number): Reply =>
    ok({ width, height, rgba: { blob: 0 }, approximations: [] }, [new Uint8Array(width * height * 4).fill(7)]);
  const handlers: Record<string, (sent: Sent) => Reply> = {
    hello: () => ok(HELLO),
    version: () => ok(`niho-develop ${DEVELOP_ENGINE_CRATE_VERSION} (engine ${DEVELOP_ENGINE_VERSION})`),
    capabilities: () =>
      ok(JSON.stringify({ masks: { kinds: ["linear", "radial", "brush", "subject", "sky"], max: 8, maskPlane: true, surfaces: true } })),
    maskSurfaceId: () => ok("surface-id"),
    encodeMaskSurface: () => ok({ blob: 0 }, [new Uint8Array([137, 80, 78, 71])]),
    validateSettings: () => ok("[]"),
    render: () => frame(4, 2),
    exportJpeg: () => ok({ blob: 0 }, [new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]),
    imageSize: () => ok({ width: 6, height: 4 }),
    rasterDecodeSize: () => ok(1280),
    "Developer.new": (request) => open(request, 4, 2),
    "Developer.openWorkingCopy": (request) => open(request, 8, 6),
    "Developer.thumbnail": (request) => open(request, 2, 1),
    "Developer.render": (request) => {
      const developer = developers.get(request.header.handle as number);
      return developer ? frame(developer.width, developer.height) : { ok: false, error: "unknown developer", code: "unknownHandle" };
    },
    "Developer.prepareAnalysis": () => ok(true),
    "Developer.releaseAnalysisAhead": () => ok(null),
    "Developer.exportAnalysis": (request) =>
      (request.header.args as unknown[])[0] === "none" ? ok(null) : ok({ blob: 0 }, [new Uint8Array([1, 5, 9])]),
    "Developer.holdsAnalysis": () => ok(true),
    "Developer.importAnalysis": () => ok(true),
    "Developer.setMaskSurface": () => ok(null),
    "Developer.dropMaskSurface": () => ok(true),
    "Developer.hasMaskSurface": () => ok(true),
    "Developer.exportJpeg": () => ok({ blob: 0 }, [new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]),
    "Developer.exportPng": () => ok({ blob: 0 }, [new Uint8Array([137, 80, 78, 71])]),
    "Developer.free": (request) => {
      developers.delete(request.header.handle as number);
      return ok(null);
    },
    releaseClient: (request) => {
      let released = 0;
      for (const [handle, developer] of developers) {
        if (developer.client !== request.header.client) continue;
        developers.delete(handle);
        released += 1;
      }
      return ok(released);
    },
    ...overrides,
  } as Record<string, (sent: Sent) => Reply>;
  const transport: NativeDevelopTransport = (method, body) => {
    const { header, blobs } = decodeNativeDevelopBody(body.slice().buffer);
    const entry = { method, header, blobs };
    sent.push(entry);
    const handler = handlers[method];
    return replyBody(handler ? handler(entry) : { ok: false, error: `unknown method ${method}`, code: "unknownMethod" });
  };
  return { transport, sent, developers };
}

describe("native の本文（u32 LE の header の長さ・JSON・binary）", () => {
  it("binary の長さを header の blobs に書き、読むと同じ bytes に戻る", () => {
    const body = encodeNativeDevelopBody({ args: [{ blob: 0 }, "x", { blob: 1 }] }, [new Uint8Array([1, 2, 3]), new Uint8Array([9])]);
    const headerLength = new DataView(body.buffer).getUint32(0, true);
    expect(JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + headerLength)))).toEqual({
      args: [{ blob: 0 }, "x", { blob: 1 }],
      blobs: [3, 1],
    });
    const { header, blobs } = decodeNativeDevelopBody(body.buffer);
    expect(header.args).toEqual([{ blob: 0 }, "x", { blob: 1 }]);
    expect(blobs.map((blob) => [...blob])).toEqual([[1, 2, 3], [9]]);
  });

  it("長さの合わない本文・JSON でない header は運べない扱い", () => {
    const body = encodeNativeDevelopBody({ ok: true }, [new Uint8Array([1, 2])]);
    expect(() => decodeNativeDevelopBody(body.buffer.slice(0, body.byteLength - 1))).toThrow(NativeDevelopUnavailableError);
    const extra = new Uint8Array(body.byteLength + 1);
    extra.set(body);
    expect(() => decodeNativeDevelopBody(extra.buffer)).toThrow(NativeDevelopUnavailableError);
    const broken = new Uint8Array(6);
    new DataView(broken.buffer).setUint32(0, 2, true);
    broken.set([0x7b, 0x7b], 4);
    expect(() => decodeNativeDevelopBody(broken.buffer)).toThrow(NativeDevelopUnavailableError);
    expect(() => decodeNativeDevelopBody(new ArrayBuffer(2))).toThrow(NativeDevelopUnavailableError);
  });
});

describe("createNativeDevelopGlue", () => {
  it("init は hello で protocol・crate の版・engine・口を確かめる", async () => {
    const serve = fakeServe();
    const glue = createNativeDevelopGlue(serve.transport);
    await expect(glue.default()).resolves.toEqual({});
    expect(glue.hello()).toMatchObject({ protocol: 1, crateVersion: DEVELOP_ENGINE_CRATE_VERSION, threads: 8 });
    expect(serve.sent.map((entry) => entry.method)).toEqual(["hello"]);
  });

  it.each([
    ["protocol", { ...HELLO, protocol: 2 }],
    ["crate の版", { ...HELLO, crateVersion: "0.0.1" }],
    ["engine", { ...HELLO, engine: "niho-1" }],
    ["口の一覧", { ...HELLO, methods: HELLO.methods.filter((name) => name !== "Developer.maskPlane") }],
    ["未知の口", { ...HELLO, methods: [...HELLO.methods, "Developer.futureMethod"] }],
  ])("%s が合わない sidecar は使わない（Worker は wasm へ落ちる）", async (_label, hello) => {
    const glue = createNativeDevelopGlue(fakeServe({ hello: () => ok(hello) }).transport);
    await expect(glue.default()).rejects.toBeInstanceOf(NativeDevelopUnavailableError);
  });

  it("一発の描画は binary を blob で送り、rgba を Uint8ClampedArray で返す", () => {
    const serve = fakeServe();
    const glue = createNativeDevelopGlue(serve.transport);
    const frame = glue.render(new Uint8Array([1, 2, 3]), "{}", 1280, undefined) as { width: number; rgba: Uint8ClampedArray };
    expect(frame.width).toBe(4);
    expect(frame.rgba).toBeInstanceOf(Uint8ClampedArray);
    expect(frame.rgba.length).toBe(4 * 2 * 4);
    expect(serve.sent[0].header.args).toEqual([{ blob: 0 }, "{}", 1280, null]);
    expect([...serve.sent[0].blobs[0]]).toEqual([1, 2, 3]);
    expect([...glue.exportJpeg(new Uint8Array([1]), "{}", 0, 90)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect(glue.maskSurfaceId(new Uint8Array([9]))).toBe("surface-id");
    expect([...glue.encodeMaskSurface(2, 1, new Uint8Array([0, 255]))]).toEqual([137, 80, 78, 71]);
    expect(serve.sent.at(-1)).toMatchObject({ method: "encodeMaskSurface", header: { args: [2, 1, { blob: 0 }] } });
    expect([...serve.sent.at(-1)!.blobs[0]]).toEqual([0, 255]);
  });

  it("Developer の解析・マスク面・export を wasm と同じ型へ変換する", () => {
    const serve = fakeServe();
    const glue = createNativeDevelopGlue(serve.transport);
    const developer = new glue.Developer(new Uint8Array([1]), 0);
    expect(developer.prepareAnalysis("{}")).toBe(true);
    expect(developer.releaseAnalysisAhead()).toBeUndefined();
    expect([...developer.exportAnalysis("{}")!]).toEqual([1, 5, 9]);
    expect(developer.exportAnalysis("none")).toBeUndefined();
    expect(developer.holdsAnalysis("{}")).toBe(true);
    expect(developer.importAnalysis(new Uint8Array([4, 2]))).toBe(true);
    expect(serve.sent.at(-1)).toMatchObject({ method: "Developer.importAnalysis", header: { args: [{ blob: 0 }], handle: 1 } });
    expect([...serve.sent.at(-1)!.blobs[0]]).toEqual([4, 2]);
    expect(developer.setMaskSurface("surface-id", new Uint8Array([8, 6]))).toBeUndefined();
    expect(serve.sent.at(-1)).toMatchObject({ method: "Developer.setMaskSurface", header: { args: ["surface-id", { blob: 0 }], handle: 1 } });
    expect(developer.hasMaskSurface("surface-id")).toBe(true);
    expect(developer.dropMaskSurface("surface-id")).toBe(true);
    expect([...developer.exportJpeg("{}", 1280, 90)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect([...developer.exportPng("{}", 1280)]).toEqual([137, 80, 78, 71]);
    const frame = developer.render("{}", 0, false) as { rgba: Uint8ClampedArray };
    expect(frame.rgba).toBeInstanceOf(Uint8ClampedArray);
  });

  it("新しい口の engine error と型の壊れた応答を区別する", () => {
    const engineError = createNativeDevelopGlue(
      fakeServe({ "Developer.setMaskSurface": () => ({ ok: false, error: "maskSurfaceInvalid: sha256 does not match" }) }).transport,
    );
    const developer = new engineError.Developer(new Uint8Array([1]), 0);
    expect(() => developer.setMaskSurface("bad", new Uint8Array([1]))).toThrow("maskSurfaceInvalid");
    const malformed = createNativeDevelopGlue(fakeServe({ "Developer.hasMaskSurface": () => ok("yes") }).transport);
    const malformedDeveloper = new malformed.Developer(new Uint8Array([1]), 0);
    expect(() => malformedDeveloper.hasMaskSurface("surface-id")).toThrow(NativeDevelopUnavailableError);
  });

  it("Developer は handle で持ち、持ち主の印を送り、free の後は使えない", () => {
    const serve = fakeServe();
    const glue = createNativeDevelopGlue(serve.transport, { clientId: "client-1" });
    const developer = new glue.Developer(new Uint8Array([5]), 2560);
    expect([developer.width, developer.height]).toEqual([4, 2]);
    expect(serve.sent[0]).toMatchObject({ method: "Developer.new", header: { client: "client-1", args: [{ blob: 0 }, 2560] } });
    const working = glue.Developer.openWorkingCopy(new Uint8Array([6]), "{}");
    expect([working.width, working.height]).toEqual([8, 6]);
    const thumbnail = working.thumbnail(256);
    expect([thumbnail.width, thumbnail.height]).toEqual([2, 1]);
    expect(serve.sent.at(-1)?.header).toMatchObject({ handle: 2, client: "client-1", args: [256] });
    expect((working.render("{}", 0, true) as { width: number }).width).toBe(8);
    expect(serve.sent.at(-1)?.header).toMatchObject({ handle: 2, args: ["{}", 0, true] });
    developer.free();
    developer.free();
    expect(serve.sent.filter((entry) => entry.method === "Developer.free")).toHaveLength(1);
    expect(() => developer.render("{}", 0, false)).toThrow("freed");
    expect(serve.developers.size).toBe(2);
    expect(glue.releaseClient()).toBe(2);
    expect(serve.developers.size).toBe(0);
  });

  it("口の失敗は wasm と同じ Error(message)、handle が無い・運べないときは NativeDevelopUnavailableError", () => {
    const glue = createNativeDevelopGlue(
      fakeServe({
        presetSettings: () => ({ ok: false, error: "xmp: not a preset" }),
        "Developer.render": () => ({ ok: false, error: "developer 1 is gone", code: "unknownHandle" }),
      }).transport,
    );
    let thrown: unknown = null;
    try {
      glue.presetSettings("<x/>", null);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(NativeDevelopUnavailableError);
    expect((thrown as Error).message).toBe("xmp: not a preset");
    const developer = new glue.Developer(new Uint8Array([1]), 0);
    expect(() => developer.render("{}", 0, false)).toThrow(NativeDevelopUnavailableError);
    const down = createNativeDevelopGlue(() => {
      throw new NativeDevelopUnavailableError("native develop engine responded 503");
    });
    expect(() => down.version()).toThrow(NativeDevelopUnavailableError);
  });

  it("口の一覧は wasm の export（niho-develop-wasm の #[wasm_bindgen]）と同じ", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../develop-engine/crates/niho-develop-wasm/src/lib.rs", import.meta.url)),
      "utf8",
    );
    const implStart = source.search(/#\[wasm_bindgen\]\s*impl Developer \{/);
    expect(implStart).toBeGreaterThan(0);
    let depth = 0;
    let implEnd = source.indexOf("{", implStart);
    for (let index = implEnd; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      if (depth === 0) {
        implEnd = index;
        break;
      }
    }
    const jsName = (attribute: string | undefined, rustName: string) =>
      /js_name\s*=\s*(\w+)/.exec(attribute ?? "")?.[1] ?? (/\bconstructor\b/.test(attribute ?? "") ? "new" : rustName);
    const topLevel = source.slice(0, implStart) + source.slice(implEnd + 1);
    const functions = [...topLevel.matchAll(/#\[wasm_bindgen(?:\(([^)]*)\))?\]\s*pub fn (\w+)/g)].map((match) => jsName(match[1], match[2]));
    const methods = [...source.slice(implStart, implEnd).matchAll(/(?:#\[wasm_bindgen\(([^)]*)\)\]\s*)?pub fn (\w+)/g)]
      .filter((match) => !/\bgetter\b/.test(match[1] ?? ""))
      .map((match) => jsName(match[1], match[2]));
    expect(new Set(functions)).toEqual(new Set(NATIVE_DEVELOP_FUNCTIONS));
    expect(new Set([...methods, "free"])).toEqual(new Set(NATIVE_DEVELOP_DEVELOPER_METHODS));

    const serveSource = readFileSync(
      fileURLToPath(new URL("../../../develop-engine/crates/niho-develop-render/src/serve/methods.rs", import.meta.url)),
      "utf8",
    );
    const serveMethods = [...serveSource.matchAll(/^\s*"([A-Za-z.]+)",$/gm)].map((match) => match[1]);
    expect(new Set(serveMethods)).toEqual(new Set(NATIVE_DEVELOP_METHODS));
  });
});

describe("Worker の中身に native の glue を渡す", () => {
  it("wasm と同じ口として読まれ、ready の機能が付き、開いて描ける", async () => {
    const serve = fakeServe();
    const glue = createNativeDevelopGlue(serve.transport);
    const posted: DevelopEngineWorkerResponse[] = [];
    const manifestUrl = `https://photo.example.test${developEngineManifestPath()}`;
    const handler = createDevelopEngineWorkerHandler({
      fetch: async () =>
        new Response(
          JSON.stringify({
            engine: DEVELOP_ENGINE_VERSION,
            version: DEVELOP_ENGINE_CRATE_VERSION,
            files: {
              [`niho_develop_wasm_bg-${DEVELOP_ENGINE_CRATE_VERSION}.wasm`]: { sha256: "c1", bytes: 1 },
              [`niho_develop_wasm-${DEVELOP_ENGINE_CRATE_VERSION}.js`]: { sha256: "08", bytes: 1 },
            },
          }),
        ),
      importModule: async () => glue,
      post: (message) => posted.push(message),
    });
    await handler({ type: "init", id: 1, manifestUrl });
    expect(posted[0]).toMatchObject({
      type: "ready",
      version: `niho-develop ${DEVELOP_ENGINE_CRATE_VERSION} (engine ${DEVELOP_ENGINE_VERSION})`,
      geometry: true,
      presetAmount: true,
      settingsToXmp: true,
      presetThumbnails: true,
      auto: true,
      presetFromMeta: true,
      effects: true,
      colorPoints: true,
      detail: true,
      perspective: true,
      upright: true,
      heal: true,
      lens: true,
      masks: { kinds: ["linear", "radial", "brush", "subject", "sky"], max: 8, maskPlane: true, surfaces: true },
    });
    await handler({ type: "open", id: 2, bytes: new Uint8Array([1, 2]).buffer, workingMaxDimension: 2560 });
    await handler({ type: "render", id: 3, settingsJson: "{}", maxDimension: 1280, interactive: false });
    expect(posted[1]).toEqual({ type: "opened", id: 2, width: 4, height: 2 });
    expect(posted[2]).toMatchObject({ type: "frame", id: 3, width: 4, height: 2 });
    expect((posted[2] as { rgba: ArrayBuffer }).rgba.byteLength).toBe(4 * 2 * 4);
  });
});

describe("createSyncXhrTransport", () => {
  function fakeXhr(status: number, response: unknown) {
    const xhr = { open: vi.fn(), setRequestHeader: vi.fn(), send: vi.fn(), responseType: "", status, response };
    return xhr;
  }

  it("POST <base><method> を同期で送り、200 の ArrayBuffer を返す", () => {
    const response = new ArrayBuffer(8);
    const xhr = fakeXhr(200, response);
    const transport = createSyncXhrTransport("niho-develop://localhost/", () => xhr as unknown as XMLHttpRequest);
    const body = new Uint8Array(new ArrayBuffer(4));
    expect(transport("Developer.render", body, "0123456789abcdef0123456789abcdef")).toBe(response);
    expect(xhr.open).toHaveBeenCalledWith("POST", "niho-develop://localhost/Developer.render", false);
    expect(xhr.responseType).toBe("arraybuffer");
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("X-Niho-Develop-Client", "0123456789abcdef0123456789abcdef");
    expect(xhr.send).toHaveBeenCalledWith(body);
  });

  it("200 以外・送れないときは NativeDevelopUnavailableError", () => {
    const unavailable = createSyncXhrTransport("niho-develop://localhost/", () => fakeXhr(503, null) as unknown as XMLHttpRequest);
    expect(() => unavailable("hello", new Uint8Array(new ArrayBuffer(4)))).toThrow(NativeDevelopUnavailableError);
    const failing = fakeXhr(0, null);
    failing.send.mockImplementation(() => {
      throw new Error("NetworkError");
    });
    const broken = createSyncXhrTransport("niho-develop://localhost/", () => failing as unknown as XMLHttpRequest);
    expect(() => broken("hello", new Uint8Array(new ArrayBuffer(4)))).toThrow(NativeDevelopUnavailableError);
  });
});

describe("createNativeDevelopAnalysisStore", () => {
  it("ハッシュ鍵の解析だけを native cache に送り、WebKit storage を使わず再取得する", async () => {
    const stored = new Map<string, ArrayBuffer>();
    const calls: { url: string; client: string; body: Uint8Array }[] = [];
    class FakeXhr {
      status = 0;
      response: ArrayBuffer | null = null;
      responseType = "";
      private url = "";
      private client = "";
      open(method: string, url: string, async: boolean) {
        expect([method, async]).toEqual(["POST", false]);
        this.url = url;
      }
      setRequestHeader(name: string, value: string) {
        expect(name).toBe("X-Niho-Develop-Client");
        this.client = value;
      }
      send(body: Uint8Array) {
        calls.push({ url: this.url, client: this.client, body });
        const id = new TextDecoder().decode(body.subarray(0, 64));
        if (this.url.endsWith("Analysis.put")) {
          stored.set(id, body.slice(64).buffer);
          this.status = 200;
          this.response = new ArrayBuffer(0);
        } else {
          this.response = stored.get(id) ?? null;
          this.status = this.response ? 200 : 404;
        }
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    try {
      const store = createNativeDevelopAnalysisStore();
      expect(store).not.toBeNull();
      const id = "a".repeat(64);
      await store?.put(id, new Uint8Array([1, 2, 3]).buffer);
      expect([...(new Uint8Array((await store?.get(id)) ?? new ArrayBuffer(0)))]).toEqual([1, 2, 3]);
      expect(await store?.get("b".repeat(64))).toBeNull();
      await expect(store?.get("not-a-hash")).rejects.toThrow("invalid analysis cache key");
      expect(calls.map((call) => call.url)).toEqual([
        "niho-develop://localhost/Analysis.put",
        "niho-develop://localhost/Analysis.get",
        "niho-develop://localhost/Analysis.get",
      ]);
      expect(calls.every((call) => /^[0-9a-f]{32}$/u.test(call.client))).toBe(true);
      expect(new TextDecoder().decode(calls[0]?.body.subarray(0, 64))).toBe(id);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
