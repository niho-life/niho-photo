import { constants, type Dirent } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, verifyExactBytes } from "../../../../packages/photo-cloud-media/src/server/runtime.ts";
import sdkBaseline from "../../../../packages/photo-cloud-media/sdk-baseline.json" with { type: "json" };
import { installPhotoStaticWorker } from "../pwa/worker-runtime.js";
import type { PhotoStaticAsset, PhotoStaticManifest } from "../pwa/types.ts";
import buildBaseline from "./build-baseline.json" with { type: "json" };
import type {
  PhotoPublicNotice,
  PhotoStaticBuildErrorCode,
  PhotoStaticBuildResult,
  PreparePhotoStaticBundleOptions,
} from "./types.ts";

const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STATIC_BYTES = 32 * 1024 * 1024;
const MAX_PUBLIC_FILES = 128;
const MAX_SOURCE_ENTRIES = 256;
const MAX_PATH_DEPTH = 8;
const MAX_COPY_BYTES = 4096;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENGINE_MANIFEST_PATH = "develop-engine/niho-14/manifest-0.27.0.json";
const ENGINE_PREFIX = `/develop-engine/${sdkBaseline.engine.manifest.sha256}`;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

type FailureCode = PhotoStaticBuildErrorCode;
type JsonRecord = Record<string, unknown>;
type Descriptor = PhotoStaticAsset | PhotoPublicNotice;
type PendingFile = { readonly descriptor: Descriptor; readonly bytes: Uint8Array };
type ManifestEntry = { readonly sha256: string; readonly bytes: number };
type PublicBudget = { bytes: number; files: number };
type SourceTraversal = { entries: number };
type InputSnapshot = {
  readonly builtWebDirectory: string;
  readonly outputDirectory: string;
  readonly sdkPackageDirectory: string;
  readonly offlineCopy: { readonly title: string; readonly message: string };
  readonly applicationCopy: PreparePhotoStaticBundleOptions["applicationCopy"];
};

const WEB_TYPES: Readonly<Record<string, { readonly contentType: string; readonly kind: PhotoStaticAsset["kind"] }>> = Object.freeze({
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

class BundleFailure extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode) {
    super(code);
    this.code = code;
  }
}

export class PhotoStaticBuildError extends Error {
  readonly code: PhotoStaticBuildErrorCode;

  constructor(code: PhotoStaticBuildErrorCode) {
    super("Photo static bundle preparation failed");
    this.name = "PhotoStaticBuildError";
    this.code = code;
  }
}

function fail(code: FailureCode): never {
  throw new BundleFailure(code);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hash(value: Uint8Array | string): string {
  return sha256(value);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateRelativePath(relative: string, maximumDepth = MAX_PATH_DEPTH): void {
  if (!relative || !/^[\x21-\x7e]+$/.test(relative) || relative.includes("\\") || relative.includes("%")
    || relative.includes("?") || relative.includes("#") || path.posix.normalize(relative) !== relative) fail("invalid_artifact");
  const segments = relative.split("/");
  if (segments.length > maximumDepth || segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment.startsWith("."))) {
    fail("invalid_artifact");
  }
}

async function readRegularFile(filePath: string, maximumBytes: number, code: FailureCode = "invalid_artifact"): Promise<Uint8Array> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    fail(code);
  }
  let result: Uint8Array | undefined;
  let failure: BundleFailure | undefined;
  try {
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0) fail(code);
    if (before.size > maximumBytes) fail("budget_exceeded");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const part = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (part.bytesRead <= 0) fail(code);
      offset += part.bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    if ((await handle.read(overflow, 0, 1, null)).bytesRead !== 0) fail(code);
    const after = await handle.stat();
    if (!after.isFile() || after.size !== before.size) fail(code);
    result = bytes;
  } catch (error) {
    failure = error instanceof BundleFailure ? error : new BundleFailure("io_failure");
  }
  try {
    await handle.close();
  } catch {
    failure ??= new BundleFailure("io_failure");
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) fail("io_failure");
  return result;
}

async function readDirectory(directory: string, traversal: SourceTraversal, code: FailureCode): Promise<Dirent[]> {
  let handle;
  try {
    handle = await opendir(directory);
  } catch {
    fail(code);
  }
  const entries: Dirent[] = [];
  let failure: BundleFailure | undefined;
  try {
    while (true) {
      const entry = await handle.read();
      if (entry === null) break;
      traversal.entries += 1;
      if (traversal.entries > MAX_SOURCE_ENTRIES) fail("budget_exceeded");
      entries.push(entry);
    }
  } catch (error) {
    failure = error instanceof BundleFailure ? error : new BundleFailure("io_failure");
  }
  try {
    await handle.close();
  } catch {
    failure ??= new BundleFailure("io_failure");
  }
  if (failure !== undefined) throw failure;
  return entries;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail("invalid_artifact");
  }
}

function descriptor(assetPath: string, bytes: Uint8Array, contentType: string, kind: PhotoStaticAsset["kind"]): PhotoStaticAsset {
  return Object.freeze({ path: assetPath, sha256: sha256(bytes), sizeBytes: bytes.byteLength, contentType, kind });
}

function ensurePublicCapacity(budget: PublicBudget, sizeBytes: number, files = 1): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || budget.bytes + sizeBytes > MAX_STATIC_BYTES
    || budget.files + files > MAX_PUBLIC_FILES) fail("budget_exceeded");
}

function addPending(target: PendingFile[], seen: Set<string>, budget: PublicBudget, file: PendingFile): void {
  if (seen.has(file.descriptor.path)) fail("invalid_artifact");
  ensurePublicCapacity(budget, file.bytes.byteLength);
  seen.add(file.descriptor.path);
  target.push(file);
  budget.bytes += file.bytes.byteLength;
  budget.files += 1;
}

async function scanWebAssets(
  root: string,
  directory: string,
  pending: PendingFile[],
  seen: Set<string>,
  budget: PublicBudget,
  traversal: SourceTraversal,
): Promise<void> {
  const entries = await readDirectory(directory, traversal, "io_failure");
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    validateRelativePath(relative);
    if (entry.isSymbolicLink()) fail("invalid_artifact");
    if (entry.isDirectory()) {
      await scanWebAssets(root, absolute, pending, seen, budget, traversal);
      continue;
    }
    if (!entry.isFile()) fail("invalid_artifact");
    const mapping = WEB_TYPES[path.posix.extname(relative)];
    if (!mapping) fail("invalid_artifact");
    ensurePublicCapacity(budget, 0);
    const bytes = await readRegularFile(absolute, Math.min(MAX_FILE_BYTES, MAX_STATIC_BYTES - budget.bytes));
    addPending(pending, seen, budget, {
      descriptor: descriptor(`/${relative}`, bytes, mapping.contentType, mapping.kind),
      bytes,
    });
  }
}

async function readWebBuild(
  directory: string,
  pending: PendingFile[],
  seen: Set<string>,
  budget: PublicBudget,
  traversal: SourceTraversal,
): Promise<{
  readonly document: PhotoStaticBuildResult["document"];
  readonly documentBytes: Uint8Array;
}> {
  const entries = await readDirectory(directory, traversal, "invalid_input");
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== 2 || names[0] !== "assets" || names[1] !== "index.html") fail("invalid_artifact");
  const indexEntry = entries.find((entry) => entry.name === "index.html");
  const assetsEntry = entries.find((entry) => entry.name === "assets");
  if (!indexEntry?.isFile() || indexEntry.isSymbolicLink() || !assetsEntry?.isDirectory() || assetsEntry.isSymbolicLink()) {
    fail("invalid_artifact");
  }
  const documentBytes = await readRegularFile(
    path.join(directory, "index.html"),
    Math.min(MAX_DOCUMENT_BYTES, MAX_STATIC_BYTES - budget.bytes),
  );
  ensurePublicCapacity(budget, documentBytes.byteLength, 0);
  budget.bytes += documentBytes.byteLength;
  const document = Object.freeze({
    file: "index.html" as const,
    sha256: sha256(documentBytes),
    sizeBytes: documentBytes.byteLength,
    contentType: "text/html" as const,
  });
  await scanWebAssets(directory, path.join(directory, "assets"), pending, seen, budget, traversal);
  return { document, documentBytes };
}

function manifestFiles(value: unknown): Map<string, ManifestEntry> {
  if (!isRecord(value)) fail("invalid_artifact");
  const output = new Map<string, ManifestEntry>();
  for (const [name, raw] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    validateRelativePath(name, 1);
    if (name.includes("/")) fail("invalid_artifact");
    if (!isRecord(raw) || !SHA256.test(String(raw.sha256)) || !Number.isSafeInteger(raw.bytes)
      || (raw.bytes as number) <= 0 || (raw.bytes as number) > MAX_FILE_BYTES || output.has(name)) fail("invalid_artifact");
    output.set(name, { sha256: String(raw.sha256), bytes: raw.bytes as number });
  }
  return output;
}

function engineType(name: string): string | null {
  if (name.endsWith(".d.ts")) return null;
  if (name.endsWith(".js")) return "application/javascript";
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".f32")) return "application/octet-stream";
  fail("invalid_artifact");
}

async function readSdk(
  packageDirectory: string,
  pending: PendingFile[],
  seen: Set<string>,
  budget: PublicBudget,
): Promise<PhotoStaticBuildResult["sdk"]> {
  const packageBytes = await readRegularFile(path.join(packageDirectory, "package.json"), MAX_DOCUMENT_BYTES);
  const packageJson = parseJson(packageBytes);
  if (!isRecord(packageJson) || packageJson.name !== "niho-photo-develop-engine-runtime" || packageJson.version !== buildBaseline.sdkVersion) {
    fail("invalid_artifact");
  }
  if (sdkBaseline.sourceCommit !== buildBaseline.sourceCommit
    || sdkBaseline.packages.find((item) => item.id === "develop-engine-runtime")?.sha256 !== buildBaseline.runtimePackageSha256
    || sdkBaseline.releaseTag !== `photo-sdk-v${buildBaseline.sdkVersion}`) fail("invalid_artifact");

  const manifestFile = path.join(packageDirectory, ENGINE_MANIFEST_PATH);
  ensurePublicCapacity(budget, sdkBaseline.engine.manifest.size);
  const manifestBytes = await readRegularFile(manifestFile, Math.min(MAX_FILE_BYTES, MAX_STATIC_BYTES - budget.bytes));
  if (!verifyExactBytes(manifestBytes, {
    sha256: sdkBaseline.engine.manifest.sha256,
    sizeBytes: sdkBaseline.engine.manifest.size,
  })) fail("invalid_artifact");
  const manifest = parseJson(manifestBytes);
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || manifest.engine !== sdkBaseline.engine.version
    || manifest.version !== sdkBaseline.engine.crateVersion || !isRecord(manifest.source)
    || manifest.source.repository !== sdkBaseline.repository || manifest.source.commit !== sdkBaseline.sourceCommit
    || !isRecord(manifest.threads)) fail("invalid_artifact");

  const listed = manifestFiles(manifest.files);
  for (const [name, expected] of manifestFiles(manifest.threads.files)) {
    if (listed.has(name)) fail("invalid_artifact");
    listed.set(name, expected);
  }
  addPending(pending, seen, budget, {
    descriptor: descriptor(`${ENGINE_PREFIX}/${path.basename(ENGINE_MANIFEST_PATH)}`, manifestBytes, "application/json", "engine"),
    bytes: manifestBytes,
  });
  const engineDirectory = path.dirname(manifestFile);
  for (const [name, expected] of [...listed].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const contentType = engineType(name);
    if (contentType !== null) ensurePublicCapacity(budget, expected.bytes);
    const bytes = await readRegularFile(
      path.join(engineDirectory, name),
      contentType === null ? MAX_FILE_BYTES : Math.min(MAX_FILE_BYTES, MAX_STATIC_BYTES - budget.bytes),
    );
    if (!verifyExactBytes(bytes, { sha256: expected.sha256, sizeBytes: expected.bytes })) fail("invalid_artifact");
    if (contentType !== null) {
      addPending(pending, seen, budget, {
        descriptor: descriptor(`${ENGINE_PREFIX}/${name}`, bytes, contentType, "engine"),
        bytes,
      });
    }
  }

  for (const notice of buildBaseline.notices) {
    validateRelativePath(notice.path);
    ensurePublicCapacity(budget, notice.sizeBytes);
    const bytes = await readRegularFile(
      path.join(packageDirectory, ...notice.path.split("/")),
      Math.min(MAX_FILE_BYTES, MAX_STATIC_BYTES - budget.bytes),
    );
    if (!verifyExactBytes(bytes, { sha256: notice.sha256, sizeBytes: notice.sizeBytes })) fail("invalid_artifact");
    const noticeDescriptor: PhotoPublicNotice = Object.freeze({
      path: `${ENGINE_PREFIX}/${notice.path}`,
      sha256: notice.sha256,
      sizeBytes: notice.sizeBytes,
      contentType: "text/plain",
      kind: "notice",
    });
    addPending(pending, seen, budget, { descriptor: noticeDescriptor, bytes });
  }

  return Object.freeze({
    sdkVersion: buildBaseline.sdkVersion,
    crateVersion: sdkBaseline.engine.crateVersion,
    sourceCommit: buildBaseline.sourceCommit,
    manifestSha256: sdkBaseline.engine.manifest.sha256,
    manifestUrl: `${ENGINE_PREFIX}/${path.basename(ENGINE_MANIFEST_PATH)}`,
  });
}

function validatePng(bytes: Uint8Array): void {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.byteLength < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString("ascii", 12, 16) !== "IHDR"
    || buffer.readUInt32BE(16) !== buildBaseline.icon.width || buffer.readUInt32BE(20) !== buildBaseline.icon.height) {
    fail("invalid_artifact");
  }
}

async function readIcon(pending: PendingFile[], seen: Set<string>, budget: PublicBudget): Promise<void> {
  validateRelativePath(buildBaseline.icon.sourcePath);
  const iconPath = path.join(REPOSITORY_ROOT, ...buildBaseline.icon.sourcePath.split("/"));
  ensurePublicCapacity(budget, buildBaseline.icon.sizeBytes);
  const bytes = await readRegularFile(iconPath, Math.min(MAX_FILE_BYTES, MAX_STATIC_BYTES - budget.bytes));
  if (!verifyExactBytes(bytes, { sha256: buildBaseline.icon.sha256, sizeBytes: buildBaseline.icon.sizeBytes })) {
    fail("invalid_artifact");
  }
  validatePng(bytes);
  addPending(pending, seen, budget, {
    descriptor: descriptor(`/icons/photo-${buildBaseline.icon.sha256}.png`, bytes, "image/png", "icon"),
    bytes,
  });
}

function validateCopy(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || byteLength(value) > MAX_COPY_BYTES
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || /[\ud800-\udfff]/u.test(value)) fail("invalid_input");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function offlineFile(copy: PreparePhotoStaticBundleOptions["offlineCopy"]): { readonly descriptor: PhotoStaticAsset; readonly bytes: Uint8Array } {
  if (!isRecord(copy)) fail("invalid_input");
  validateCopy(copy.title);
  validateCopy(copy.message);
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(copy.title)}</title></head><body><main><h1>${escapeHtml(copy.title)}</h1><p>${escapeHtml(copy.message)}</p></main></body></html>`;
  const bytes = Buffer.from(html, "utf8");
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) fail("budget_exceeded");
  const digest = hash(bytes);
  return { descriptor: descriptor(`/offline.${digest}.html`, bytes, "text/html", "offline"), bytes };
}

function snapshotOptions(options: PreparePhotoStaticBundleOptions): InputSnapshot {
  try {
    if (!isRecord(options)) fail("invalid_input");
    const builtWebDirectory = options.builtWebDirectory;
    const outputDirectory = options.outputDirectory;
    const sdkPackageDirectory = options.sdkPackageDirectory;
    const copy = options.offlineCopy;
    const app = options.applicationCopy;
    if (typeof builtWebDirectory !== "string" || builtWebDirectory.length === 0
      || typeof outputDirectory !== "string" || outputDirectory.length === 0
      || typeof sdkPackageDirectory !== "string" || sdkPackageDirectory.length === 0 || !isRecord(copy)) fail("invalid_input");
    const title = copy.title;
    const message = copy.message;
    validateCopy(title);
    validateCopy(message);
    if (!isRecord(app)) fail("invalid_input");
    const { name, shortName, description } = app;
    validateCopy(name);
    validateCopy(shortName);
    validateCopy(description);
    return Object.freeze({
      builtWebDirectory,
      outputDirectory,
      sdkPackageDirectory,
      offlineCopy: Object.freeze({ title, message }),
      applicationCopy: Object.freeze({ name, shortName, description }),
    });
  } catch (error) {
    if (error instanceof BundleFailure) throw error;
    fail("invalid_input");
  }
}

async function canonicalInputs(options: InputSnapshot): Promise<{
  readonly input: string;
  readonly output: string;
  readonly sdk: string;
}> {
  const inputResolved = path.resolve(options.builtWebDirectory);
  const sdkResolved = path.resolve(options.sdkPackageDirectory);
  const outputResolved = path.resolve(options.outputDirectory);
  let inputInfo;
  let sdkInfo;
  let input;
  let sdk;
  let parent;
  try {
    [inputInfo, sdkInfo] = await Promise.all([lstat(inputResolved), lstat(sdkResolved)]);
    [input, sdk, parent] = await Promise.all([
      realpath(inputResolved),
      realpath(sdkResolved),
      realpath(path.dirname(outputResolved)),
    ]);
  } catch {
    fail("invalid_input");
  }
  if (!inputInfo.isDirectory() || inputInfo.isSymbolicLink() || !sdkInfo.isDirectory() || sdkInfo.isSymbolicLink()) fail("invalid_input");
  let parentInfo;
  try {
    parentInfo = await stat(parent);
  } catch {
    fail("invalid_input");
  }
  if (!parentInfo.isDirectory()) fail("invalid_input");
  const output = path.join(parent, path.basename(outputResolved));
  if (isInside(input, output) || isInside(output, input) || isInside(sdk, output) || isInside(output, sdk)) {
    fail("invalid_input");
  }
  try {
    await lstat(output);
    fail("output_exists");
  } catch (error) {
    if (error instanceof BundleFailure) throw error;
    if (!isRecord(error) || error.code !== "ENOENT") fail("io_failure");
  }
  return { input, output, sdk };
}

function buildIdentifier(files: readonly Descriptor[], document: PhotoStaticBuildResult["document"], sdk: PhotoStaticBuildResult["sdk"], webManifest: PhotoStaticBuildResult["webManifest"]): string {
  const sortedFiles = [...files].sort((left, right) => left.path.localeCompare(right.path, "en"));
  const payload = JSON.stringify({
    schemaVersion: 1,
    files: sortedFiles,
    documentSha256: document.sha256,
    sdk,
    webManifest,
    workerRuntimeSha256: hash(installPhotoStaticWorker.toString()),
  });
  return hash(payload);
}

async function writeOutput(root: string, relative: string, bytes: Uint8Array | string): Promise<void> {
  const destination = path.join(root, ...relative.split("/"));
  if (!isInside(root, destination)) fail("invalid_artifact");
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
  } catch {
    fail("io_failure");
  }
}

export async function preparePhotoStaticBundle(options: PreparePhotoStaticBundleOptions): Promise<PhotoStaticBuildResult> {
  let output: string | undefined;
  let ownsOutput = false;
  try {
    const snapshot = snapshotOptions(options);
    const canonical = await canonicalInputs(snapshot);
    output = canonical.output;
    const pending: PendingFile[] = [];
    const seen = new Set<string>();
    const budget: PublicBudget = { bytes: 0, files: 4 };
    const traversal: SourceTraversal = { entries: 0 };
    const web = await readWebBuild(canonical.input, pending, seen, budget, traversal);
    const sdk = await readSdk(canonical.sdk, pending, seen, budget);
    await readIcon(pending, seen, budget);
    const offline = offlineFile(snapshot.offlineCopy);
    addPending(pending, seen, budget, offline);

    const pwaFiles = pending.filter((file): file is PendingFile & { readonly descriptor: PhotoStaticAsset } => file.descriptor.kind !== "notice");
    const files = pending.map((file) => file.descriptor).sort((left, right) => left.path.localeCompare(right.path, "en"));
    const manifestBytes = Buffer.from(`${JSON.stringify({
      name: snapshot.applicationCopy.name,
      short_name: snapshot.applicationCopy.shortName,
      description: snapshot.applicationCopy.description,
      lang: "ja", id: "/", start_url: "/", scope: "/", display: "standalone", orientation: "any",
      background_color: "#FCFBF9", theme_color: "#FCFBF9",
      icons: [{ src: `/icons/photo-${buildBaseline.icon.sha256}.png`, sizes: "512x512", type: "image/png", purpose: "any" }],
    }, null, 2)}\n`, "utf8");
    ensurePublicCapacity(budget, manifestBytes.byteLength, 0);
    budget.bytes += manifestBytes.byteLength;
    const webManifest = Object.freeze({ path: "/manifest.webmanifest" as const, sha256: hash(manifestBytes),
      sizeBytes: manifestBytes.byteLength, contentType: "application/manifest+json" as const });
    const buildId = buildIdentifier(files, web.document, sdk, webManifest);
    const assets = pwaFiles.map((file) => file.descriptor).sort((left, right) => left.path.localeCompare(right.path, "en"));
    const pwa: PhotoStaticManifest = freezeDeep({
      schemaVersion: 1 as const,
      buildId,
      assets: [...assets],
      offlinePath: offline.descriptor.path,
    });
    const workerSource = `(${installPhotoStaticWorker.toString()})(self,${JSON.stringify(pwa)});\n`;
    const workerBytes = Buffer.from(workerSource, "utf8");
    if (workerBytes.byteLength > MAX_FILE_BYTES) fail("budget_exceeded");
    ensurePublicCapacity(budget, workerBytes.byteLength, 0);
    budget.bytes += workerBytes.byteLength;
    const worker = Object.freeze({
      path: "/photo-sw.js" as const,
      sha256: hash(workerBytes),
      sizeBytes: workerBytes.byteLength,
      contentType: "application/javascript" as const,
    });
    const result: PhotoStaticBuildResult = freezeDeep({
      schemaVersion: 1 as const,
      buildId,
      document: web.document,
      files: [...files],
      pwa,
      worker,
      webManifest,
      sdk,
    });
    const metadata = `${JSON.stringify(result, null, 2)}\n`;
    if (byteLength(metadata) > MAX_DOCUMENT_BYTES) fail("budget_exceeded");
    ensurePublicCapacity(budget, byteLength(metadata), 0);
    budget.bytes += byteLength(metadata);

    try {
      await mkdir(output);
      ownsOutput = true;
    } catch (error) {
      if (isRecord(error) && error.code === "EEXIST") fail("output_exists");
      fail("io_failure");
    }
    await writeOutput(output, "index.html", web.documentBytes);
    for (const file of pending) await writeOutput(output, file.descriptor.path.slice(1), file.bytes);
    await writeOutput(output, "photo-sw.js", workerBytes);
    await writeOutput(output, "manifest.webmanifest", manifestBytes);
    await writeOutput(output, "photo-build.json", metadata);
    return result;
  } catch (error) {
    if (ownsOutput && output !== undefined) {
      try {
        await rm(output, { recursive: true, force: true });
      } catch {
        // The directory was uniquely created by this call; cleanup is best effort.
      }
    }
    const code = error instanceof BundleFailure ? error.code : "io_failure";
    throw new PhotoStaticBuildError(code);
  }
}
