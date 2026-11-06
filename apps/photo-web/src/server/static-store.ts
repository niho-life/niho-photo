import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import type { PhotoStaticAsset } from "../pwa/types.ts";
import type { PhotoPublicNotice, PhotoStaticBuildResult } from "../build/types.ts";
import type {
  LoadPhotoWebStaticStoreOptions,
  LoadRetainedPhotoWebStaticStoreOptions,
  PhotoWebStaticStore,
} from "./types.ts";

const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STATIC_BYTES = 32 * 1024 * 1024;
const MAX_PUBLIC_FILES = 128;
const MAX_PATH_BYTES = 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable, no-transform";

type StoreErrorCode = "invalid_input" | "invalid_artifact" | "budget_exceeded" | "io_failure";
type JsonRecord = Record<string, unknown>;
type Descriptor = PhotoStaticAsset | PhotoPublicNotice;
type Snapshot = { readonly directory: string; readonly build: PhotoStaticBuildResult; readonly metadata: Buffer };
type Pending = { readonly route: string; readonly bytes: Buffer; readonly contentType: string; readonly hash: string; readonly cache: boolean; readonly worker?: boolean };
type Stored = { readonly blob: Blob; readonly headers: readonly (readonly [string, string])[] };

class StoreFailure extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode) {
    super(code);
    this.code = code;
  }
}

export class PhotoWebStaticStoreError extends Error {
  override readonly name = "PhotoWebStaticStoreError";
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode) {
    super("Photo web static store preparation failed");
    this.code = code;
  }
}

function fail(code: StoreErrorCode): never {
  throw new StoreFailure(code);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, maximum = MAX_PATH_BYTES): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum
    || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) fail("invalid_artifact");
  return value;
}

function integer(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) fail("invalid_artifact");
  return value as number;
}

function hashValue(value: unknown): string {
  const result = stringValue(value, 64);
  if (!SHA256.test(result)) fail("invalid_artifact");
  return result;
}

function safeRelative(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("%") || value.includes("?")
    || value.includes("#") || path.posix.normalize(value) !== value) fail("invalid_artifact");
  const segments = value.split("/");
  if (segments.length > 8 || segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment.startsWith("."))) {
    fail("invalid_artifact");
  }
  return value;
}

function routeValue(value: unknown): string {
  const route = stringValue(value);
  if (!route.startsWith("/") || route === "/" || route.includes("//")) fail("invalid_artifact");
  safeRelative(route.slice(1));
  const first = route.slice(1).split("/", 1)[0]?.toLowerCase();
  if (first === "auth" || first === "api" || first === "photos" || first === "uploads") fail("invalid_artifact");
  return route;
}

const ASSET_TYPES: Readonly<Record<string, { readonly contentType: string; readonly kind: PhotoStaticAsset["kind"] }>> = Object.freeze({
  ".avif": { contentType: "image/avif", kind: "icon" },
  ".css": { contentType: "text/css", kind: "style" },
  ".ico": { contentType: "image/x-icon", kind: "icon" },
  ".js": { contentType: "application/javascript", kind: "script" },
  ".mjs": { contentType: "application/javascript", kind: "script" },
  ".otf": { contentType: "font/otf", kind: "font" },
  ".png": { contentType: "image/png", kind: "icon" },
  ".svg": { contentType: "image/svg+xml", kind: "icon" },
  ".ttf": { contentType: "font/ttf", kind: "font" },
  ".webp": { contentType: "image/webp", kind: "icon" },
  ".woff": { contentType: "font/woff", kind: "font" },
  ".woff2": { contentType: "font/woff2", kind: "font" },
});

function expectedArtifact(route: string, hash: string, manifestHash: string): { readonly contentType: string; readonly kind: Descriptor["kind"] } {
  if (route.startsWith("/assets/")) {
    const mapping = ASSET_TYPES[path.posix.extname(route)];
    if (mapping === undefined) fail("invalid_artifact");
    return mapping;
  }
  if (route === `/icons/photo-${hash}.png`) return { contentType: "image/png", kind: "icon" };
  if (route === `/offline.${hash}.html`) return { contentType: "text/html", kind: "offline" };
  const prefix = `/develop-engine/${manifestHash}/`;
  if (!route.startsWith(prefix)) fail("invalid_artifact");
  const relative = route.slice(prefix.length);
  if (/^(?:[A-Z][A-Z0-9_]*\.md|licenses\/[A-Za-z0-9][A-Za-z0-9._-]*\.txt)$/.test(relative)) {
    return { contentType: "text/plain", kind: "notice" };
  }
  const extension = path.posix.extname(relative);
  const contentType = extension === ".js" ? "application/javascript"
    : extension === ".wasm" ? "application/wasm"
      : extension === ".json" ? "application/json"
        : extension === ".f32" ? "application/octet-stream" : null;
  if (contentType === null) fail("invalid_artifact");
  return { contentType, kind: "engine" };
}

function descriptorSnapshot(raw: unknown, manifestHash: string): Descriptor {
  if (!isRecord(raw)) fail("invalid_artifact");
  const route = routeValue(raw.path);
  const sha256 = hashValue(raw.sha256);
  const sizeBytes = integer(raw.sizeBytes, MAX_FILE_BYTES);
  const expected = expectedArtifact(route, sha256, manifestHash);
  if (raw.contentType !== expected.contentType || raw.kind !== expected.kind) fail("invalid_artifact");
  return Object.freeze({ path: route, sha256, sizeBytes, contentType: expected.contentType, kind: expected.kind }) as Descriptor;
}

function equalDescriptor(left: Descriptor, right: Descriptor): boolean {
  return left.path === right.path && left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes
    && left.contentType === right.contentType && left.kind === right.kind;
}

function sortedUnique(descriptors: readonly Descriptor[]): void {
  let previous: string | undefined;
  for (const descriptor of descriptors) {
    if (previous !== undefined && previous.localeCompare(descriptor.path, "en") >= 0) fail("invalid_artifact");
    previous = descriptor.path;
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
}

function snapshot(options: LoadPhotoWebStaticStoreOptions): Snapshot {
  try {
    if (!isRecord(options)) fail("invalid_input");
    const directory = stringValue(options.directory, 4096);
    const raw = options.build;
    if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.document) || !Array.isArray(raw.files)
      || !isRecord(raw.pwa) || !isRecord(raw.worker) || !isRecord(raw.sdk) || !isRecord(raw.webManifest)) fail("invalid_artifact");
    if (raw.files.length > MAX_PUBLIC_FILES - 4) fail("budget_exceeded");
    const buildId = hashValue(raw.buildId);
    const sdkVersion = stringValue(raw.sdk.sdkVersion, 32);
    const crateVersion = stringValue(raw.sdk.crateVersion, 32);
    const sourceCommit = stringValue(raw.sdk.sourceCommit, 40);
    const manifestSha256 = hashValue(raw.sdk.manifestSha256);
    if (!VERSION.test(sdkVersion) || !VERSION.test(crateVersion) || !COMMIT.test(sourceCommit)) fail("invalid_artifact");
    const manifestUrl = routeValue(raw.sdk.manifestUrl);
    if (manifestUrl !== `/develop-engine/${manifestSha256}/manifest-${crateVersion}.json`) fail("invalid_artifact");
    const sdk = Object.freeze({ sdkVersion, crateVersion, sourceCommit, manifestSha256, manifestUrl });

    if (raw.document.file !== "index.html" || raw.document.contentType !== "text/html") fail("invalid_artifact");
    const document = Object.freeze({
      file: "index.html" as const,
      sha256: hashValue(raw.document.sha256),
      sizeBytes: integer(raw.document.sizeBytes, MAX_DOCUMENT_BYTES),
      contentType: "text/html" as const,
    });
    if (raw.worker.path !== "/photo-sw.js" || raw.worker.contentType !== "application/javascript") fail("invalid_artifact");
    const worker = Object.freeze({
      path: "/photo-sw.js" as const,
      sha256: hashValue(raw.worker.sha256),
      sizeBytes: integer(raw.worker.sizeBytes, MAX_FILE_BYTES),
      contentType: "application/javascript" as const,
    });
    if (raw.webManifest.path !== "/manifest.webmanifest" || raw.webManifest.contentType !== "application/manifest+json") fail("invalid_artifact");
    const webManifest = Object.freeze({ path: "/manifest.webmanifest" as const, sha256: hashValue(raw.webManifest.sha256),
      sizeBytes: integer(raw.webManifest.sizeBytes, MAX_DOCUMENT_BYTES), contentType: "application/manifest+json" as const });
    const files = raw.files.map((item) => descriptorSnapshot(item, manifestSha256));
    sortedUnique(files);
    const manifest = files.find((file) => file.path === manifestUrl);
    if (manifest === undefined || manifest.kind !== "engine" || manifest.contentType !== "application/json"
      || manifest.sha256 !== manifestSha256) fail("invalid_artifact");
    const offlineFiles = files.filter((file) => file.kind === "offline");
    if (offlineFiles.length !== 1) fail("invalid_artifact");

    if (raw.pwa.schemaVersion !== 1 || raw.pwa.buildId !== buildId || !Array.isArray(raw.pwa.assets)
      || raw.pwa.assets.length > MAX_PUBLIC_FILES - 4) fail("invalid_artifact");
    const assets = raw.pwa.assets.map((item) => descriptorSnapshot(item, manifestSha256));
    sortedUnique(assets);
    const expectedAssets = files.filter((file) => file.kind !== "notice");
    if (assets.length !== expectedAssets.length || assets.some((asset, index) => !equalDescriptor(asset, expectedAssets[index] as Descriptor))) {
      fail("invalid_artifact");
    }
    if (assets.some((asset) => asset.kind === "notice")) fail("invalid_artifact");
    const offlinePath = routeValue(raw.pwa.offlinePath);
    if (offlinePath !== offlineFiles[0]?.path) fail("invalid_artifact");
    const pwaAssets = assets as PhotoStaticAsset[];
    const pwa = Object.freeze({ schemaVersion: 1 as const, buildId, assets: Object.freeze(pwaAssets), offlinePath });
    const build: PhotoStaticBuildResult = freezeDeep({ schemaVersion: 1 as const, buildId, document, files, pwa, worker, webManifest, sdk });
    const metadata = Buffer.from(`${JSON.stringify(build, null, 2)}\n`, "utf8");
    if (metadata.byteLength > MAX_DOCUMENT_BYTES) fail("budget_exceeded");
    const total = document.sizeBytes + worker.sizeBytes + webManifest.sizeBytes + metadata.byteLength
      + files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (!Number.isSafeInteger(total) || total > MAX_STATIC_BYTES || files.length + 4 > MAX_PUBLIC_FILES) fail("budget_exceeded");
    return { directory, build, metadata };
  } catch (error) {
    if (error instanceof StoreFailure) throw error;
    fail("invalid_input");
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalRoot(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  try {
    const info = await lstat(resolved);
    const [root, parent] = await Promise.all([realpath(resolved), realpath(path.dirname(resolved))]);
    if (!info.isDirectory() || info.isSymbolicLink() || root !== path.join(parent, path.basename(resolved))) fail("invalid_input");
    return root;
  } catch (error) {
    if (error instanceof StoreFailure) throw error;
    fail("invalid_input");
  }
}

async function readBounded(root: string, relative: string, size: number): Promise<Buffer> {
  const target = path.join(root, ...safeRelative(relative).split("/"));
  if (!isInside(root, target)) fail("invalid_artifact");
  try {
    const parent = await realpath(path.dirname(target));
    if (parent !== path.dirname(target) || !isInside(root, parent)) fail("invalid_artifact");
  } catch (error) {
    if (error instanceof StoreFailure) throw error;
    fail("invalid_artifact");
  }
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    fail("invalid_artifact");
  }
  let bytes: Buffer | undefined;
  let failure: StoreFailure | undefined;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== size || before.size <= 0 || before.size > MAX_FILE_BYTES) fail("invalid_artifact");
    bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, null);
      if (result.bytesRead <= 0) fail("invalid_artifact");
      offset += result.bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    if ((await handle.read(overflow, 0, 1, null)).bytesRead !== 0) fail("invalid_artifact");
    const after = await handle.stat();
    if (!after.isFile() || after.size !== before.size) fail("invalid_artifact");
  } catch (error) {
    failure = error instanceof StoreFailure ? error : new StoreFailure("io_failure");
  }
  try {
    await handle.close();
  } catch {
    failure ??= new StoreFailure("io_failure");
  }
  if (failure !== undefined) {
    bytes?.fill(0);
    throw failure;
  }
  if (bytes === undefined) fail("io_failure");
  return bytes;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function responseHeaders(entry: Pending): readonly (readonly [string, string])[] {
  const headers: [string, string][] = [
    ["Cache-Control", entry.cache ? CACHE_IMMUTABLE : "no-store"],
    ["Content-Length", String(entry.bytes.byteLength)],
    ["Content-Type", entry.contentType],
    ["ETag", `"${entry.hash}"`],
    ["X-Content-Type-Options", "nosniff"],
  ];
  if (entry.worker === true) headers.push(["Service-Worker-Allowed", "/"]);
  return Object.freeze(headers.map((item) => Object.freeze(item)));
}

export async function loadPhotoWebStaticStore(options: LoadPhotoWebStaticStoreOptions): Promise<PhotoWebStaticStore> {
  const buffers: Buffer[] = [];
  try {
    const input = snapshot(options);
    buffers.push(input.metadata);
    const root = await canonicalRoot(input.directory);
    const pending: Pending[] = [];
    const add = async (route: string, relative: string, size: number, expectedHash: string, contentType: string, cache: boolean, worker = false) => {
      const bytes = await readBounded(root, relative, size);
      buffers.push(bytes);
      if (digest(bytes) !== expectedHash) fail("invalid_artifact");
      pending.push({ route, bytes, contentType, hash: expectedHash, cache, ...(worker ? { worker: true } : {}) });
    };
    await add("/", "index.html", input.build.document.sizeBytes, input.build.document.sha256, input.build.document.contentType, false);
    for (const file of input.build.files) {
      await add(file.path, file.path.slice(1), file.sizeBytes, file.sha256, file.contentType, true);
    }
    await add(input.build.worker.path, "photo-sw.js", input.build.worker.sizeBytes, input.build.worker.sha256,
      input.build.worker.contentType, false, true);
    await add(input.build.webManifest.path, "manifest.webmanifest", input.build.webManifest.sizeBytes,
      input.build.webManifest.sha256, input.build.webManifest.contentType, false);
    const metadataBytes = await readBounded(root, "photo-build.json", input.metadata.byteLength);
    buffers.push(metadataBytes);
    if (!metadataBytes.equals(input.metadata)) fail("invalid_artifact");
    pending.push({
      route: "/photo-build.json",
      bytes: metadataBytes,
      contentType: "application/json",
      hash: digest(metadataBytes),
      cache: false,
    });
    input.metadata.fill(0);

    const entries = new Map<string, Stored>();
    for (const item of pending) {
      const stored = Object.freeze({ blob: new Blob([Uint8Array.from(item.bytes)]), headers: responseHeaders(item) });
      if (entries.has(item.route)) fail("invalid_artifact");
      entries.set(item.route, stored);
    }
    for (const bytes of buffers) bytes.fill(0);
    buffers.length = 0;
    const get = (route: string, head = false): Response | null => {
      const entry = entries.get(route);
      if (entry === undefined) return null;
      const headers = new Headers();
      for (const [name, value] of entry.headers) headers.append(name, value);
      return new Response(head ? null : entry.blob.stream(), { status: 200, headers });
    };
    return Object.freeze({ build: input.build, get });
  } catch (error) {
    for (const bytes of buffers) bytes.fill(0);
    const code = error instanceof StoreFailure ? error.code : "io_failure";
    throw new PhotoWebStaticStoreError(code);
  }
}

const RETAINED_KINDS = new Set<Descriptor["kind"]>(["script", "style", "font", "icon", "engine", "notice"]);

type RetainedEntry = {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly blob: Blob;
};

function storeRoutes(build: PhotoStaticBuildResult, prior: boolean): readonly string[] {
  const files = build.files.filter((file) => !prior || RETAINED_KINDS.has(file.kind)).map((file) => file.path);
  return prior ? files : ["/", ...files, build.worker.path, build.webManifest.path, "/photo-build.json"];
}

async function retainStore(
  store: PhotoWebStaticStore,
  prior: boolean,
  entries: Map<string, RetainedEntry>,
  blobs: Map<string, { readonly blob: Blob; readonly sizeBytes: number; readonly bytes: Uint8Array }>,
  budget: { files: number; bytes: number },
): Promise<void> {
  for (const route of storeRoutes(store.build, prior)) {
    const response = store.get(route);
    if (response === null || response.status !== 200 || response.body === null) fail("invalid_artifact");
    const contentType = response.headers.get("content-type");
    const contentLength = response.headers.get("content-length");
    if (contentType === null || contentLength === null || !/^\d+$/.test(contentLength)) fail("invalid_artifact");
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared <= 0 || declared > MAX_FILE_BYTES) fail("budget_exceeded");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== declared) fail("invalid_artifact");
    const sha256 = digest(bytes);
    const existing = entries.get(route);
    if (existing !== undefined) {
      if (existing.sha256 !== sha256 || existing.sizeBytes !== bytes.byteLength || existing.contentType !== contentType) {
        fail("invalid_artifact");
      }
      continue;
    }
    if (budget.files + 1 > MAX_PUBLIC_FILES) fail("budget_exceeded");
    let pooled = blobs.get(sha256);
    if (pooled !== undefined) {
      if (pooled.sizeBytes !== bytes.byteLength || !Buffer.from(pooled.bytes).equals(Buffer.from(bytes))) fail("invalid_artifact");
    } else {
      if (budget.bytes + bytes.byteLength > MAX_STATIC_BYTES) fail("budget_exceeded");
      const owned = bytes.slice();
      pooled = Object.freeze({ blob: new Blob([owned]), sizeBytes: owned.byteLength, bytes: owned });
      blobs.set(sha256, pooled);
      budget.bytes += owned.byteLength;
    }
    const headers = new Headers(response.headers);
    if (prior) headers.set("Cache-Control", CACHE_IMMUTABLE);
    const frozenHeaders = Object.freeze([...headers].map((item) => Object.freeze(item))) as readonly (readonly [string, string])[];
    entries.set(route, Object.freeze({
      sha256,
      sizeBytes: bytes.byteLength,
      contentType,
      headers: frozenHeaders,
      blob: pooled.blob,
    }));
    budget.files += 1;
  }
}

/**
 * Verifies every C06 store independently, then copies only public bytes into one SHA-addressed pool.
 * No prior store closure is retained and mutable routes always come from the current build.
 */
export async function loadRetainedPhotoWebStaticStore(
  options: LoadRetainedPhotoWebStaticStoreOptions,
): Promise<PhotoWebStaticStore> {
  try {
    if (!isRecord(options) || !isRecord(options.current)
      || options.acceptedPrior !== undefined && !Array.isArray(options.acceptedPrior)) fail("invalid_input");
    const entries = new Map<string, RetainedEntry>();
    const blobs = new Map<string, { readonly blob: Blob; readonly sizeBytes: number; readonly bytes: Uint8Array }>();
    const budget = { files: 0, bytes: 0 };
    const current = await loadPhotoWebStaticStore(options.current);
    await retainStore(current, false, entries, blobs, budget);
    for (const accepted of options.acceptedPrior ?? []) {
      const prior = await loadPhotoWebStaticStore(accepted);
      await retainStore(prior, true, entries, blobs, budget);
    }
    const get = (route: string, head = false): Response | null => {
      const entry = entries.get(route);
      if (entry === undefined) return null;
      const headers = new Headers();
      for (const [name, value] of entry.headers) headers.append(name, value);
      return new Response(head ? null : entry.blob.stream(), { status: 200, headers });
    };
    return Object.freeze({ build: current.build, get });
  } catch (error) {
    if (error instanceof PhotoWebStaticStoreError) throw error;
    const code = error instanceof StoreFailure ? error.code : "io_failure";
    throw new PhotoWebStaticStoreError(code);
  }
}
