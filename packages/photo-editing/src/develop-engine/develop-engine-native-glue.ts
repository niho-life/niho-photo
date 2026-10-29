import { DEVELOP_ENGINE_CRATE_VERSION, DEVELOP_ENGINE_VERSION } from "./develop-engine-manifest";

/**
 * Mac アプリ（Tauri）で現像を native の sidecar で描く glue（#152。#148 の 3）。wasm-bindgen の glue（`import init, * as dev`）と
 * 同じ形の module を、Worker の中の同期の XHR で包む:
 *
 * ```
 * Worker（develop-engine-worker-core.ts。今のまま）
 *  └ この glue … 同期の XHR → niho-develop://localhost/<method>（Tauri の独自の scheme。main 窓だけ）
 *     └ sidecar `niho-develop-render serve`（長く生きる 1 プロセス。wasm と同じ `niho_develop::api` を呼ぶ）
 * ```
 *
 * - 口の名前・引数・戻りの形・失敗の message は wasm の export と同じ（`NATIVE_DEVELOP_FUNCTIONS`・`NATIVE_DEVELOP_DEVELOPER_METHODS`）。
 *   `Developer` は sidecar の中で handle で持ち、`free` で手放す。`width` / `height` は開いた応答で受け取って持つ
 * - 本文（XHR の body と応答）: `u32 LE` の header の長さ・header の JSON・binary（画素・JPEG など）を前から連結。binary の引数と結果は
 *   JSON の中で `{ "blob": i }`
 * - `default()`（wasm の init にあたる）は `hello` を呼び、protocol・crate の版・engine・口の一覧がこの画面と合うかを確かめる。合わなければ
 *   {@link NativeDevelopUnavailableError}（Worker は wasm へ落ちる）
 * - 口の失敗（設定が読めない・decode できない）は wasm と同じく `Error(message)`。運べない（sidecar が無い・落ちた・503）・sidecar が
 *   作り直されて handle が無くなったときは {@link NativeDevelopUnavailableError}
 * - 同期の XHR で `responseType` を付けられるのは Worker の中だけ（画面の main thread では使わない）
 */

/** `serve` の本文の形の版（`hello` の `protocol`）。 */
export const NATIVE_DEVELOP_PROTOCOL = 1;

/** Tauri の独自の scheme（`apps/camera/src-tauri` の `develop_engine_scheme.rs`。CSP の `connect-src` に足してある）。 */
export const NATIVE_DEVELOP_BASE_URL = "niho-develop://localhost/";

/** wasm の export の関数（`niho-develop-wasm` の `#[wasm_bindgen]` の fn。名前は JS の名前）。 */
export const NATIVE_DEVELOP_FUNCTIONS = [
  "version",
  "capabilities",
  "maskSurfaceId",
  "encodeMaskSurface",
  "render",
  "exportJpeg",
  "exportPng",
  "withCaptureExif",
  "beforeSettings",
  "imageSize",
  "rasterDecodeSize",
  "geometryOutputSize",
  "neutralSettings",
  "validateSettings",
  "builtinPresets",
  "presetSettings",
  "applyPreset",
  "settingsToXmp",
  "asShotWhiteFromMeta",
  "convertEditSettings",
] as const;

/** wasm の `Developer` の口（constructor は `new`。getter の `width` / `height` は除く）。 */
export const NATIVE_DEVELOP_DEVELOPER_METHODS = [
  "new",
  "openWorkingCopy",
  "asShotWhite",
  "thumbnail",
  "render",
  "prepareAnalysis",
  "releaseAnalysisAhead",
  "exportAnalysis",
  "holdsAnalysis",
  "importAnalysis",
  "setMaskSurface",
  "dropMaskSurface",
  "hasMaskSurface",
  "exportJpeg",
  "exportPng",
  "maskPlane",
  "sampleColor",
  "autoSettings",
  "estimateUpright",
  "free",
] as const;

/** sidecar に要る口の全部（`hello` の `methods` がこれを含むこと）。 */
export const NATIVE_DEVELOP_METHODS: readonly string[] = [
  ...NATIVE_DEVELOP_FUNCTIONS,
  ...NATIVE_DEVELOP_DEVELOPER_METHODS.map((name) => `Developer.${name}`),
  "hello",
  "releaseClient",
];

/** native で描けない（運べない・版が違う・sidecar が作り直された）。Worker はこれを見て wasm へ落ちる。 */
export class NativeDevelopUnavailableError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "NativeDevelopUnavailableError";
    this.code = code;
  }
}

/** 1 回の要求（同期）: method と本文を送り、応答の本文を返す。運べなければ {@link NativeDevelopUnavailableError}。 */
export type NativeDevelopTransport = (method: string, body: Uint8Array<ArrayBuffer>, client?: string) => ArrayBuffer;

/** `hello` の応答。 */
export type NativeDevelopHello = {
  protocol: number;
  tool: string;
  crateVersion: string;
  engine: string;
  threads: number;
  methods: string[];
};

/**
 * 同期の XHR の運び手（Worker の中だけ）。`POST <baseUrl><method>`、応答は ArrayBuffer。200 以外・送れないときは
 * {@link NativeDevelopUnavailableError}（`ok: false` の口の失敗は 200 で返る）。
 */
export function createSyncXhrTransport(
  baseUrl: string = NATIVE_DEVELOP_BASE_URL,
  createXhr: () => XMLHttpRequest = () => new XMLHttpRequest(),
): NativeDevelopTransport {
  return (method, body, client) => {
    const xhr = createXhr();
    try {
      xhr.open("POST", `${baseUrl}${method}`, false);
      xhr.responseType = "arraybuffer";
      if (client) xhr.setRequestHeader("X-Niho-Develop-Client", client);
      xhr.send(body);
    } catch (error) {
      throw new NativeDevelopUnavailableError(`native develop engine request failed: ${messageOf(error)}`);
    }
    const response: unknown = xhr.response;
    if (xhr.status !== 200 || !(response instanceof ArrayBuffer)) {
      throw new NativeDevelopUnavailableError(`native develop engine responded ${xhr.status}`);
    }
    return response;
  };
}

type BinaryArgument = Uint8Array | Uint8ClampedArray | ArrayBuffer;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function bytesOf(value: BinaryArgument): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/** 本文を作る（`u32 LE` の header の長さ・header の JSON・binary を連結。binary の長さは header の `blobs`）。 */
export function encodeNativeDevelopBody(header: Record<string, unknown>, blobs: readonly Uint8Array[] = []): Uint8Array<ArrayBuffer> {
  const headerBytes = new TextEncoder().encode(JSON.stringify({ ...header, blobs: blobs.map((blob) => blob.byteLength) }));
  const total = 4 + headerBytes.byteLength + blobs.reduce((sum, blob) => sum + blob.byteLength, 0);
  const body = new Uint8Array(new ArrayBuffer(total));
  new DataView(body.buffer).setUint32(0, headerBytes.byteLength, true);
  body.set(headerBytes, 4);
  let offset = 4 + headerBytes.byteLength;
  for (const blob of blobs) {
    body.set(blob, offset);
    offset += blob.byteLength;
  }
  return body;
}

/** 本文を読む（binary は応答の buffer を指す view。形が違えば {@link NativeDevelopUnavailableError}）。 */
export function decodeNativeDevelopBody(buffer: ArrayBuffer): { header: Record<string, unknown>; blobs: Uint8Array[] } {
  const invalid = () => new NativeDevelopUnavailableError("native develop engine returned a malformed response");
  if (buffer.byteLength < 4) throw invalid();
  const headerLength = new DataView(buffer).getUint32(0, true);
  if (4 + headerLength > buffer.byteLength) throw invalid();
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)));
  } catch {
    throw invalid();
  }
  if (!isRecord(header)) throw invalid();
  const lengths = header.blobs ?? [];
  if (!Array.isArray(lengths)) throw invalid();
  const blobs: Uint8Array[] = [];
  let offset = 4 + headerLength;
  for (const length of lengths) {
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || offset + length > buffer.byteLength) throw invalid();
    blobs.push(new Uint8Array(buffer, offset, length));
    offset += length;
  }
  if (offset !== buffer.byteLength) throw invalid();
  return { header, blobs };
}

/** 結果の中の `{ "blob": i }` を binary に差し替える。 */
function resolveBlobs(value: unknown, blobs: readonly Uint8Array[]): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveBlobs(item, blobs));
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "blob") {
    const index = value.blob;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= blobs.length) {
      throw new NativeDevelopUnavailableError("native develop engine returned a malformed response");
    }
    return blobs[index];
  }
  return Object.fromEntries(keys.map((key) => [key, resolveBlobs(value[key], blobs)]));
}

/** 応答の handle と大きさ（`Developer.new` / `openWorkingCopy` / `thumbnail`）。 */
function readOpened(value: unknown): { handle: number; width: number; height: number } {
  if (isRecord(value)) {
    const { handle, width, height } = value;
    if (
      typeof handle === "number" &&
      Number.isInteger(handle) &&
      handle > 0 &&
      typeof width === "number" &&
      typeof height === "number"
    ) {
      return { handle, width, height };
    }
  }
  throw new NativeDevelopUnavailableError("native develop engine returned no developer");
}

/** 描いた画（wasm と同じく `rgba` は `Uint8ClampedArray`）。 */
function toFrame(value: unknown): unknown {
  if (!isRecord(value) || !(value.rgba instanceof Uint8Array)) return value;
  const rgba = value.rgba;
  return { ...value, rgba: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength) };
}

function randomClientId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** wasm の `Developer` と同じ形の class（{@link createNativeDevelopGlue} が作る）。 */
export type NativeDeveloper = {
  readonly width: number;
  readonly height: number;
  asShotWhite(): string;
  thumbnail(maxDimension: number): NativeDeveloper;
  render(settingsJson: string, maxDimension: number, interactive: boolean): unknown;
  prepareAnalysis(settingsJson: string): boolean;
  releaseAnalysisAhead(): void;
  exportAnalysis(settingsJson: string): Uint8Array | undefined;
  holdsAnalysis(settingsJson: string): boolean;
  importAnalysis(bytes: Uint8Array): boolean;
  setMaskSurface(id: string, png: Uint8Array): void;
  dropMaskSurface(id: string): boolean;
  hasMaskSurface(id: string): boolean;
  exportJpeg(settingsJson: string, maxDimension: number, quality: number): Uint8Array;
  exportPng(settingsJson: string, maxDimension: number): Uint8Array;
  maskPlane(settingsJson: string, maskId: string, maxDimension: number): unknown;
  sampleColor(settingsJson: string, maxDimension: number, x: number, y: number): unknown;
  autoSettings(settingsJson: string): string;
  estimateUpright(settingsJson: string, mode: number): string;
  free(): void;
};

export type NativeDeveloperClass = {
  new (input: Uint8Array, workingMaxDimension: number): NativeDeveloper;
  openWorkingCopy(png: Uint8Array, metaJson: string): NativeDeveloper;
  readonly prototype: NativeDeveloper;
};

/** wasm-bindgen の glue と同じ形の module（`readGlue` が読む口）と、native だけの `hello` / `releaseClient`。 */
export type NativeDevelopGlue = {
  default: (options?: unknown) => Promise<Record<string, never>>;
  version: () => string;
  capabilities: () => string;
  maskSurfaceId: (png: Uint8Array) => string;
  encodeMaskSurface: (width: number, height: number, data: Uint8Array) => Uint8Array;
  render: (input: Uint8Array, settingsJson: string, maxDimension: number, decodeCap?: number | null) => unknown;
  exportJpeg: (input: Uint8Array, settingsJson: string, maxDimension: number, quality: number, decodeCap?: number | null) => Uint8Array;
  exportPng: (input: Uint8Array, settingsJson: string, maxDimension: number, decodeCap?: number | null) => Uint8Array;
  withCaptureExif: (jpeg: Uint8Array, capturedAt: string | null | undefined, offsetMinutes: number) => Uint8Array;
  beforeSettings: (settingsJson: string) => string;
  imageSize: (input: Uint8Array) => unknown;
  rasterDecodeSize: (settingsJson: string, width: number, height: number, maxDimension: number, cap: number) => number;
  geometryOutputSize: (settingsJson: string, sourceWidth: number, sourceHeight: number, maxDimension: number) => unknown;
  neutralSettings: () => string;
  validateSettings: (settingsJson: string) => string;
  builtinPresets: () => string;
  presetSettings: (xmp: string, baseJson?: string | null) => string;
  applyPreset: (xmp: string, baseJson: string, amount: number, asShotJson?: string | null) => string;
  settingsToXmp: (settingsJson: string, optionsJson?: string | null) => string;
  asShotWhiteFromMeta: (metaJson: string) => string;
  convertEditSettings: (editSettingsJson: string, baseVersion?: string | null) => string;
  Developer: NativeDeveloperClass;
  /** `hello` の応答（`default()` の後。版の診断用） */
  hello: () => NativeDevelopHello | null;
  /** この glue が開いた Developer を sidecar で全部手放す（Worker を止める前。手放した数） */
  releaseClient: () => number;
};

/**
 * native の glue を作る。`transport` は既定で同期の XHR（{@link createSyncXhrTransport}）。`clientId` はこの glue が開く Developer の
 * 持ち主の印（既定は乱数）。
 */
export function createNativeDevelopGlue(
  transport: NativeDevelopTransport = createSyncXhrTransport(),
  options: { clientId?: string } = {},
): NativeDevelopGlue {
  const client = options.clientId ?? randomClientId();
  let hello: NativeDevelopHello | null = null;
  // `openWorkingCopy` / `thumbnail` の応答から Developer を作っている間（constructor の要求を送らない）
  let opening = false;

  /** 1 回呼ぶ。binary の引数は `{ blob: i }` にして本文の後ろへ。結果の `{ blob: i }` は binary に戻す。 */
  const call = (method: string, args: readonly unknown[], extra: { handle?: number; client?: true } = {}): unknown => {
    const blobs: Uint8Array[] = [];
    const encodedArgs = args.map((arg) => {
      if (arg instanceof ArrayBuffer || arg instanceof Uint8Array || arg instanceof Uint8ClampedArray) {
        blobs.push(bytesOf(arg));
        return { blob: blobs.length - 1 };
      }
      return arg === undefined ? null : arg;
    });
    const header: Record<string, unknown> = { args: encodedArgs };
    if (extra.handle !== undefined) header.handle = extra.handle;
    if (extra.client) header.client = client;
    const { header: response, blobs: resultBlobs } = decodeNativeDevelopBody(transport(method, encodeNativeDevelopBody(header, blobs), client));
    if (response.ok === true) return resolveBlobs(response.result ?? null, resultBlobs);
    const message = typeof response.error === "string" && response.error ? response.error : `native develop ${method} failed`;
    const code = typeof response.code === "string" ? response.code : null;
    // handle が無い（sidecar が作り直された）・口を知らない・本文の形が違う＝ native では続けられない
    if (code === "unknownHandle" || code === "unknownMethod" || code === "badRequest") {
      throw new NativeDevelopUnavailableError(message, code);
    }
    const error = new Error(message);
    if (code) Object.assign(error, { code });
    throw error;
  };
  const callString = (method: string, args: readonly unknown[]): string => {
    const result = call(method, args);
    if (typeof result !== "string") throw new NativeDevelopUnavailableError(`native develop ${method} returned no text`);
    return result;
  };
  const callBytes = (method: string, args: readonly unknown[], handle?: number): Uint8Array => {
    const result = call(method, args, handle === undefined ? {} : { handle });
    if (!(result instanceof Uint8Array)) throw new NativeDevelopUnavailableError(`native develop ${method} returned no bytes`);
    return result;
  };
  const callOptionalBytes = (method: string, args: readonly unknown[], handle: number): Uint8Array | undefined => {
    const result = call(method, args, { handle });
    if (result === null) return undefined;
    if (!(result instanceof Uint8Array)) throw new NativeDevelopUnavailableError(`native develop ${method} returned neither bytes nor null`);
    return result;
  };
  const callBoolean = (method: string, args: readonly unknown[], handle: number): boolean => {
    const result = call(method, args, { handle });
    if (typeof result !== "boolean") throw new NativeDevelopUnavailableError(`native develop ${method} returned no boolean`);
    return result;
  };
  const callVoid = (method: string, args: readonly unknown[], handle: number): void => {
    const result = call(method, args, { handle });
    if (result !== null) throw new NativeDevelopUnavailableError(`native develop ${method} returned a value`);
  };

  /** sidecar の Developer を指す。handle 0 は手放した後。 */
  class Developer implements NativeDeveloper {
    private handle = 0;
    private size = { width: 0, height: 0 };

    constructor(input: Uint8Array, workingMaxDimension: number) {
      if (opening) return;
      this.adopt(call("Developer.new", [input, workingMaxDimension], { client: true }));
    }

    static openWorkingCopy(png: Uint8Array, metaJson: string): Developer {
      return Developer.from(call("Developer.openWorkingCopy", [png, metaJson], { client: true }));
    }

    private static from(opened: unknown): Developer {
      opening = true;
      try {
        const developer = new Developer(new Uint8Array(0), 0);
        developer.adopt(opened);
        return developer;
      } finally {
        opening = false;
      }
    }

    private adopt(opened: unknown) {
      const { handle, width, height } = readOpened(opened);
      this.handle = handle;
      this.size = { width, height };
    }

    private live(): number {
      if (this.handle === 0) throw new Error("develop engine Developer was freed");
      return this.handle;
    }

    get width(): number {
      return this.size.width;
    }

    get height(): number {
      return this.size.height;
    }

    asShotWhite(): string {
      const result = call("Developer.asShotWhite", [], { handle: this.live() });
      if (typeof result !== "string") throw new NativeDevelopUnavailableError("native develop asShotWhite returned no text");
      return result;
    }

    thumbnail(maxDimension: number): Developer {
      return Developer.from(call("Developer.thumbnail", [maxDimension], { handle: this.live(), client: true }));
    }

    render(settingsJson: string, maxDimension: number, interactive: boolean): unknown {
      return toFrame(call("Developer.render", [settingsJson, maxDimension, interactive], { handle: this.live() }));
    }

    prepareAnalysis(settingsJson: string): boolean {
      return callBoolean("Developer.prepareAnalysis", [settingsJson], this.live());
    }

    releaseAnalysisAhead(): void {
      callVoid("Developer.releaseAnalysisAhead", [], this.live());
    }

    exportAnalysis(settingsJson: string): Uint8Array | undefined {
      return callOptionalBytes("Developer.exportAnalysis", [settingsJson], this.live());
    }

    holdsAnalysis(settingsJson: string): boolean {
      return callBoolean("Developer.holdsAnalysis", [settingsJson], this.live());
    }

    importAnalysis(bytes: Uint8Array): boolean {
      return callBoolean("Developer.importAnalysis", [bytes], this.live());
    }

    setMaskSurface(id: string, png: Uint8Array): void {
      callVoid("Developer.setMaskSurface", [id, png], this.live());
    }

    dropMaskSurface(id: string): boolean {
      return callBoolean("Developer.dropMaskSurface", [id], this.live());
    }

    hasMaskSurface(id: string): boolean {
      return callBoolean("Developer.hasMaskSurface", [id], this.live());
    }

    exportJpeg(settingsJson: string, maxDimension: number, quality: number): Uint8Array {
      return callBytes("Developer.exportJpeg", [settingsJson, maxDimension, quality], this.live());
    }

    exportPng(settingsJson: string, maxDimension: number): Uint8Array {
      return callBytes("Developer.exportPng", [settingsJson, maxDimension], this.live());
    }

    maskPlane(settingsJson: string, maskId: string, maxDimension: number): unknown {
      return call("Developer.maskPlane", [settingsJson, maskId, maxDimension], { handle: this.live() });
    }

    sampleColor(settingsJson: string, maxDimension: number, x: number, y: number): unknown {
      return call("Developer.sampleColor", [settingsJson, maxDimension, x, y], { handle: this.live() });
    }

    autoSettings(settingsJson: string): string {
      const result = call("Developer.autoSettings", [settingsJson], { handle: this.live() });
      if (typeof result !== "string") throw new NativeDevelopUnavailableError("native develop autoSettings returned no text");
      return result;
    }

    estimateUpright(settingsJson: string, mode: number): string {
      const result = call("Developer.estimateUpright", [settingsJson, mode], { handle: this.live() });
      if (typeof result !== "string") throw new NativeDevelopUnavailableError("native develop estimateUpright returned no text");
      return result;
    }

    /** sidecar の Developer を手放す（2 回目からは何もしない。wasm の `free` と同じく呼んだ後は使えない）。 */
    free(): void {
      const handle = this.handle;
      if (handle === 0) return;
      this.handle = 0;
      call("Developer.free", [], { handle });
    }
  }

  return {
    default: async () => {
      const result = call("hello", []);
      if (!isRecord(result)) throw new NativeDevelopUnavailableError("native develop engine did not say hello");
      const { protocol, tool, crateVersion, engine, threads, methods } = result;
      if (protocol !== NATIVE_DEVELOP_PROTOCOL) {
        throw new NativeDevelopUnavailableError(`native develop engine speaks protocol ${String(protocol)}`);
      }
      if (crateVersion !== DEVELOP_ENGINE_CRATE_VERSION || engine !== DEVELOP_ENGINE_VERSION) {
        throw new NativeDevelopUnavailableError(
          `native develop engine is ${String(crateVersion)} (${String(engine)}), not ${DEVELOP_ENGINE_CRATE_VERSION} (${DEVELOP_ENGINE_VERSION})`,
        );
      }
      const offered = new Set<string>(Array.isArray(methods) ? methods.filter((name): name is string => typeof name === "string") : []);
      const missing = NATIVE_DEVELOP_METHODS.filter((name) => !offered.has(name));
      if (missing.length > 0) throw new NativeDevelopUnavailableError(`native develop engine lacks ${missing.join(", ")}`);
      const unexpected = [...offered].filter((name) => !NATIVE_DEVELOP_METHODS.includes(name));
      if (unexpected.length > 0) throw new NativeDevelopUnavailableError(`native develop engine has unknown methods ${unexpected.join(", ")}`);
      hello = {
        protocol: NATIVE_DEVELOP_PROTOCOL,
        tool: typeof tool === "string" ? tool : "",
        crateVersion: DEVELOP_ENGINE_CRATE_VERSION,
        engine: DEVELOP_ENGINE_VERSION,
        threads: typeof threads === "number" && Number.isInteger(threads) && threads > 0 ? threads : 1,
        methods: [...offered],
      };
      return {};
    },
    version: () => callString("version", []),
    capabilities: () => callString("capabilities", []),
    maskSurfaceId: (png) => callString("maskSurfaceId", [png]),
    encodeMaskSurface: (width, height, data) => callBytes("encodeMaskSurface", [width, height, data]),
    render: (input, settingsJson, maxDimension, decodeCap) => toFrame(call("render", [input, settingsJson, maxDimension, decodeCap])),
    exportJpeg: (input, settingsJson, maxDimension, quality, decodeCap) =>
      callBytes("exportJpeg", [input, settingsJson, maxDimension, quality, decodeCap]),
    exportPng: (input, settingsJson, maxDimension, decodeCap) => callBytes("exportPng", [input, settingsJson, maxDimension, decodeCap]),
    withCaptureExif: (jpeg, capturedAt, offsetMinutes) => callBytes("withCaptureExif", [jpeg, capturedAt, offsetMinutes]),
    beforeSettings: (settingsJson) => callString("beforeSettings", [settingsJson]),
    imageSize: (input) => call("imageSize", [input]),
    rasterDecodeSize: (settingsJson, width, height, maxDimension, cap) => {
      const result = call("rasterDecodeSize", [settingsJson, width, height, maxDimension, cap]);
      if (typeof result !== "number") throw new NativeDevelopUnavailableError("native develop rasterDecodeSize returned no number");
      return result;
    },
    geometryOutputSize: (settingsJson, sourceWidth, sourceHeight, maxDimension) =>
      call("geometryOutputSize", [settingsJson, sourceWidth, sourceHeight, maxDimension]),
    neutralSettings: () => callString("neutralSettings", []),
    validateSettings: (settingsJson) => callString("validateSettings", [settingsJson]),
    builtinPresets: () => callString("builtinPresets", []),
    presetSettings: (xmp, baseJson) => callString("presetSettings", [xmp, baseJson]),
    applyPreset: (xmp, baseJson, amount, asShotJson) => callString("applyPreset", [xmp, baseJson, amount, asShotJson]),
    settingsToXmp: (settingsJson, optionsJson) => callString("settingsToXmp", [settingsJson, optionsJson]),
    asShotWhiteFromMeta: (metaJson) => callString("asShotWhiteFromMeta", [metaJson]),
    convertEditSettings: (editSettingsJson, baseVersion) => callString("convertEditSettings", [editSettingsJson, baseVersion]),
    Developer,
    hello: () => hello,
    releaseClient: () => {
      const result = call("releaseClient", [], { client: true });
      return typeof result === "number" ? result : 0;
    },
  };
}
