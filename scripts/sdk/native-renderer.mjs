#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, gunzipSync, gzipSync } from "node:zlib";

export const REPOSITORY = "niho-life/niho-photo";
export const RUST_TOOLCHAIN = "1.98.1";
export const BUILD_RECIPE_VERSION = "niho-renderer-native-v1";
export const TARGETS = ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"];
export const BINARY_PATH = "package/bin/niho-develop-render";
const ENGINE_PATH = "packages/develop-engine";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 200 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const SHA40 = /^[a-f0-9]{40}$/u;
const SHA64 = /^[a-f0-9]{64}$/u;
const SIMPLE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const LICENSE_FILES = [
  ["LICENSE.md", "package/LICENSE.md"],
  ["THIRD_PARTY_NOTICES.md", "package/THIRD_PARTY_NOTICES.md"],
  [`${ENGINE_PATH}/LICENSES.md`, "package/LICENSES.md"],
  [`${ENGINE_PATH}/licenses/Adobe-DNG-SDK-LICENSE.txt`, "package/licenses/Adobe-DNG-SDK-LICENSE.txt"],
];
const EXPECTED_ARCHIVE_ENTRIES = [BINARY_PATH, "package/renderer.json", ...LICENSE_FILES.map(([, target]) => target)].sort();

export class NativeRendererError extends Error {}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function fail(message) {
  throw new NativeRendererError(message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail(`${label}のfield集合が不正です`);
  }
}

function ordinaryFile(file, label) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label}は通常fileが必要です`);
  return stat;
}

function ordinaryDirectory(directory, label, allowExisting = true) {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) {
    if (allowExisting) fail(`${label}がありません`);
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label}は通常directoryが必要です`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) fail(`${path.basename(command)}の実行に失敗しました（値は非表示）`);
  return String(result.stdout ?? "").trim();
}

function git(root, args) {
  return run("git", ["-C", root, ...args]);
}

function parseEngineVersion(engineRoot) {
  const version = /^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"$/mu.exec(readFileSync(path.join(engineRoot, "Cargo.toml"), "utf8"))?.[1];
  if (!version) fail("engine versionを読めません");
  return version;
}

function parseRustToolchain(engineRoot) {
  const toolchain = /^channel\s*=\s*"([^"]+)"$/mu.exec(readFileSync(path.join(engineRoot, "rust-toolchain.toml"), "utf8"))?.[1];
  if (toolchain !== RUST_TOOLCHAIN) fail("Rust toolchain source pinが1.98.1ではありません");
  return toolchain;
}

export function inspectRendererSource(repoRoot, expectedCommit) {
  if (!path.isAbsolute(repoRoot) || !SHA40.test(expectedCommit)) fail("source checkoutまたはcommitが不正です");
  ordinaryDirectory(repoRoot, "source checkout");
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  if (head !== expectedCommit) fail("source checkout HEADがdispatch inputと一致しません");
  if (git(repoRoot, ["status", "--porcelain", "--untracked-files=all", "--", ENGINE_PATH])) fail("source engine working treeがHEADと一致しません");
  const engineTree = git(repoRoot, ["rev-parse", `${expectedCommit}:${ENGINE_PATH}`]);
  if (!SHA40.test(engineTree)) fail("engine tree objectを固定できません");
  const repository = JSON.parse(readFileSync(path.join(repoRoot, "sdk/release-set.json"), "utf8")).repository;
  if (repository !== REPOSITORY) fail("source repository契約が不正です");
  const engineRoot = path.join(repoRoot, ENGINE_PATH);
  ordinaryFile(path.join(engineRoot, "Cargo.lock"), "Cargo.lock");
  ordinaryFile(path.join(engineRoot, "crates/niho-develop-render/src/main.rs"), "renderer main");
  return {
    sourceCommit: expectedCommit,
    engineTree,
    engineVersion: parseEngineVersion(engineRoot),
    rustToolchain: parseRustToolchain(engineRoot),
  };
}

function remapPrefixes(input, sourceRoot, scratch) {
  const candidates = [
    [sourceRoot, "source"],
    [path.join(sourceRoot, ENGINE_PATH), "engine-source"],
    [scratch, "build-root"],
    [path.join(scratch, "home"), "build-home"],
    [path.join(scratch, "cargo-home"), "cargo-home"],
    [path.join(scratch, "target"), "cargo-target"],
    [path.join(scratch, "tmp"), "build-temp"],
    [input.RUSTUP_HOME || (input.HOME && path.join(input.HOME, ".rustup")), "rust-toolchain"],
    [input.CARGO_HOME, "inherited-cargo"],
    [input.HOME, "build-user"],
    [input.RUNNER_TEMP, "runner-temp"],
    [input.GITHUB_WORKSPACE, "workspace"],
  ].filter(([value]) => path.isAbsolute(value ?? ""));
  const mappings = new Map();
  for (const [candidate, replacement] of candidates) {
    mappings.set(candidate, replacement);
    if (existsSync(candidate)) mappings.set(realpathSync(candidate), replacement);
  }
  return [...mappings]
    .sort(([left], [right]) => right.length - left.length)
    .map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
}

function rejectUnmergedSourceNativeFlags(engineRoot, target) {
  const config = path.join(engineRoot, ".cargo/config.toml");
  if (!existsSync(config)) return;
  const text = readFileSync(config, "utf8");
  const sections = [...text.matchAll(/^\s*\[([^\]]+)\]\s*$/gmu)].map((match) => ({ name: match[1].replaceAll("'", "").replaceAll('"', ""), index: match.index }));
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    const body = text.slice(section.index, sections[index + 1]?.index ?? text.length);
    if ((section.name === "build" || section.name === `target.${target}` || section.name.startsWith("target.cfg(")) && /^\s*rustflags\s*=/mu.test(body)) {
      fail("sourceのnative rustflagsをremap設定で暗黙に上書きできません");
    }
  }
}

export function nativeRendererBuildEnvironment(input, { sourceRoot, scratch, target }) {
  if (!path.isAbsolute(sourceRoot) || !path.isAbsolute(scratch) || !TARGETS.includes(target)) fail("native build隔離設定が不正です");
  const rustupHome = input.RUSTUP_HOME || (input.HOME && path.join(input.HOME, ".rustup"));
  if (!path.isAbsolute(rustupHome ?? "")) fail("RUSTUP_HOMEを絶対pathへ固定できません");
  const home = path.join(scratch, "home");
  const cargoHome = path.join(scratch, "cargo-home");
  const temporary = path.join(scratch, "tmp");
  const cargoTarget = path.join(scratch, "target");
  for (const directory of [home, cargoHome, temporary, cargoTarget]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  rejectUnmergedSourceNativeFlags(path.join(sourceRoot, ENGINE_PATH), target);
  const inherited = Object.fromEntries(["PATH", "LANG", "LC_ALL", "DEVELOPER_DIR", "SDKROOT"].filter((key) => input[key]).map((key) => [key, input[key]]));
  const existing = input.CARGO_ENCODED_RUSTFLAGS ? input.CARGO_ENCODED_RUSTFLAGS.split("\x1f").filter(Boolean) : input.RUSTFLAGS ? input.RUSTFLAGS.trim().split(/\s+/u).filter(Boolean) : [];
  return {
    ...inherited,
    HOME: home,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
    TMPDIR: temporary,
    RUSTUP_TOOLCHAIN: RUST_TOOLCHAIN,
    CARGO_TARGET_DIR: cargoTarget,
    CARGO_BUILD_TARGET: target,
    CARGO_PROFILE_RELEASE_DEBUG: "0",
    CARGO_PROFILE_RELEASE_STRIP: "debuginfo",
    CARGO_ENCODED_RUSTFLAGS: [...existing, ...remapPrefixes(input, sourceRoot, scratch)].join("\x1f"),
    CI: "true",
  };
}

function verifyElf(binary) {
  const bytes = readFileSync(binary);
  if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) fail("Linux rendererがx86_64 ELFではありません");
  const dynamic = run("readelf", ["-d", binary]);
  const needed = [...dynamic.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/gu)].map((match) => match[1]);
  const allowed = new Set(["libc.so.6", "libdl.so.2", "libgcc_s.so.1", "libm.so.6", "libpthread.so.0", "librt.so.1"]);
  if (!needed.length || needed.some((name) => !allowed.has(name))) fail("Linux rendererにglibc/system外の動的依存があります");
  const program = run("readelf", ["-l", binary]);
  const interpreter = /Requesting program interpreter:\s*([^\]]+)/u.exec(program)?.[1];
  if (interpreter !== "/lib64/ld-linux-x86-64.so.2") fail("Linux rendererのglibc loaderが不正です");
}

function verifyMachO(binary, env) {
  const bytes = readFileSync(binary);
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) fail("macOS rendererがarm64 thin Mach-Oではありません");
  if (run("lipo", ["-archs", binary], { env }) !== "arm64") fail("macOS rendererのarchがarm64ではありません");
  const dylibs = run("otool", ["-L", binary], { env }).split("\n").slice(1).map((line) => line.trim().split(" (")[0]).filter(Boolean);
  if (!dylibs.length || dylibs.some((item) => !item.startsWith("/usr/lib/") && !item.startsWith("/System/"))) fail("macOS rendererにsystem外のdylib依存があります");
  const load = run("otool", ["-l", binary], { env });
  const rpaths = [...load.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/gsu)].map((match) => match[1]);
  if (rpaths.some((item) => !item.startsWith("/usr/lib/") && !item.startsWith("/System/"))) fail("macOS rendererにprivate rpathがあります");
}

function verifyNoPrivateMetadata(binary, forbiddenPrefixes) {
  const bytes = readFileSync(binary);
  for (const prefix of forbiddenPrefixes.filter((value) => path.isAbsolute(value ?? ""))) {
    if (bytes.includes(Buffer.from(prefix))) fail("rendererにbuild絶対pathが残っています");
  }
  const strings = bytes.toString("latin1");
  if (/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|https?:\/\/[^\s/@]+:[^\s/@]+@)/u.test(strings)) fail("rendererにcredential形式のmetadataがあります");
}

export function verifyNativeBinary(binary, target, { env = process.env, forbiddenPrefixes = [] } = {}) {
  ordinaryFile(binary, "renderer binary");
  if (target === "x86_64-unknown-linux-gnu") verifyElf(binary);
  else if (target === "aarch64-apple-darwin") verifyMachO(binary, env);
  else fail("renderer targetが不正です");
  verifyNoPrivateMetadata(binary, forbiddenPrefixes);
  return { path: BINARY_PATH, sha256: sha256(readFileSync(binary)), bytes: statSync(binary).size };
}

function smokeRenderer(binary, scratch, env) {
  const capabilities = JSON.parse(run(binary, ["capabilities"], { env }));
  if (!capabilities.initialRasterSettings || capabilities.tool !== "niho-develop-render") fail("renderer capabilitiesが不正です");
  const smoke = path.join(scratch, "smoke");
  mkdirSync(smoke, { recursive: true, mode: 0o700 });
  const input = path.join(smoke, "synthetic.png");
  const settings = path.join(smoke, "settings.json");
  const output = path.join(smoke, "output.png");
  writeFileSync(input, syntheticPng());
  writeFileSync(settings, jsonBytes(capabilities.initialRasterSettings));
  const summary = JSON.parse(run(binary, ["render", "--settings", settings, "--raster", input, "--out", output], { env }));
  if (summary.source !== "raster" || summary.width !== 2 || summary.height !== 2 || !ordinaryFile(output, "synthetic smoke output")) fail("renderer synthetic CLI smokeが不正です");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

export function syntheticPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const pixels = Buffer.from([0, 16, 32, 48, 64, 80, 96, 0, 112, 128, 144, 160, 176, 192]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

function tarOctal(value, width) {
  const encoded = value.toString(8).padStart(width - 1, "0");
  if (encoded.length >= width) fail("tar数値が上限を超えました");
  return `${encoded}\0`;
}

function tarHeader(name, size, mode) {
  const header = Buffer.alloc(512);
  if (!name.startsWith("package/") || Buffer.byteLength(name) > 100) fail("tar entry pathが不正です");
  header.write(name, 0, 100, "utf8");
  header.write(tarOctal(mode, 8), 100, 8, "ascii");
  header.write(tarOctal(0, 8), 108, 8, "ascii");
  header.write(tarOctal(0, 8), 116, 8, "ascii");
  header.write(tarOctal(size, 12), 124, 12, "ascii");
  header.write(tarOctal(0, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(tarOctal([...header].reduce((sum, byte) => sum + byte, 0), 8), 148, 8, "ascii");
  return header;
}

export function createDeterministicTarball(entries) {
  const seen = new Set();
  const chunks = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (seen.has(entry.name)) fail("tar entryが重複しています");
    seen.add(entry.name);
    if (!Buffer.isBuffer(entry.bytes) || entry.bytes.length > MAX_ENTRY_BYTES) fail("tar entry bytesが不正です");
    chunks.push(tarHeader(entry.name, entry.bytes.length, entry.mode ?? 0o644), entry.bytes, Buffer.alloc((512 - (entry.bytes.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function tarString(block, start, length) {
  const bytes = block.subarray(start, start + length);
  const zero = bytes.indexOf(0);
  return bytes.subarray(0, zero === -1 ? bytes.length : zero).toString("utf8");
}

function parseTarOctal(block, start, length, label) {
  const text = tarString(block, start, length).trim();
  if (!/^[0-7]+$/u.test(text)) fail(`tar ${label}が不正です`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) fail(`tar ${label}が上限を超えました`);
  return value;
}

export function readStrictTarball(tarballBytes) {
  if (!Buffer.isBuffer(tarballBytes) || tarballBytes.length === 0 || tarballBytes.length > MAX_ARCHIVE_BYTES) fail("tgz sizeが不正です");
  let tar;
  try {
    tar = gunzipSync(tarballBytes, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    fail("tgzを安全に読めません");
  }
  const entries = new Map();
  let offset = 0;
  let terminators = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      terminators++;
      if (terminators === 2) break;
      continue;
    }
    if (terminators) fail("tar terminatorが不正です");
    const name = tarString(header, 0, 100);
    const type = header[156];
    const storedChecksum = parseTarOctal(header, 148, 8, "checksum");
    const check = Buffer.from(header);
    check.fill(0x20, 148, 156);
    if ([...check].reduce((sum, byte) => sum + byte, 0) !== storedChecksum) fail("tar checksumが不正です");
    if (type !== 0 && type !== 0x30) fail("tarはregular fileだけを許可します");
    if (!name.startsWith("package/") || name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..")) fail("tar entry pathが不正です");
    const mode = parseTarOctal(header, 100, 8, "mode");
    const expectedMode = name === BINARY_PATH ? 0o755 : 0o644;
    if (mode !== expectedMode || parseTarOctal(header, 108, 8, "uid") !== 0 || parseTarOctal(header, 116, 8, "gid") !== 0 || parseTarOctal(header, 136, 12, "mtime") !== 0 || tarString(header, 157, 100) || tarString(header, 265, 32) || tarString(header, 297, 32) || tarString(header, 345, 155) || tarString(header, 257, 6) !== "ustar" || tarString(header, 263, 2) !== "00") fail("tar metadataが決定的なregular file契約と一致しません");
    if (entries.has(name)) fail("tar entryが重複しています");
    const size = parseTarOctal(header, 124, 12, "size");
    if (size > MAX_ENTRY_BYTES || offset + size > tar.length) fail("tar entryがoversizedまたはtruncatedです");
    entries.set(name, Buffer.from(tar.subarray(offset, offset + size)));
    offset += Math.ceil(size / 512) * 512;
  }
  if (terminators !== 2 || offset !== tar.length || entries.size === 0) fail("tar終端またはtrailing bytesが不正です");
  return entries;
}

function validateRendererRecord(record) {
  exactKeys(record, ["schemaVersion", "sourceCommit", "engineTree", "engineVersion", "target", "rustToolchain", "buildRecipeVersion", "binary"], "renderer.json");
  exactKeys(record.binary, ["path", "sha256", "bytes"], "renderer binary");
  if (record.schemaVersion !== 1 || !SHA40.test(record.sourceCommit) || !SHA40.test(record.engineTree) || !/^\d+\.\d+\.\d+$/u.test(record.engineVersion) || !TARGETS.includes(record.target) || record.rustToolchain !== RUST_TOOLCHAIN || record.buildRecipeVersion !== BUILD_RECIPE_VERSION || record.binary.path !== BINARY_PATH || !SHA64.test(record.binary.sha256) || !Number.isSafeInteger(record.binary.bytes) || record.binary.bytes <= 0 || record.binary.bytes > MAX_ENTRY_BYTES) fail("renderer.jsonの値が不正です");
  return record;
}

export function verifyRendererTarball(bytes, expected = {}) {
  const entries = readStrictTarball(bytes);
  if ([...entries.keys()].sort().join("\0") !== EXPECTED_ARCHIVE_ENTRIES.join("\0")) fail("renderer tgzのentry集合が不正です");
  const record = validateRendererRecord(JSON.parse(entries.get("package/renderer.json").toString("utf8")));
  for (const [key, value] of Object.entries(expected)) if (value !== undefined && record[key] !== value) fail(`renderer tgzの${key}が一致しません`);
  const binary = entries.get(BINARY_PATH);
  if (sha256(binary) !== record.binary.sha256 || binary.length !== record.binary.bytes) fail("renderer binary bytesがmanifestと一致しません");
  return { record, binary: record.binary, entries: [...entries.keys()].sort() };
}

export function packageNativeRenderer({ repoRoot, binaryPath, outputDirectory, source, target }) {
  if (!TARGETS.includes(target) || source.rustToolchain !== RUST_TOOLCHAIN) fail("package target/sourceが不正です");
  ordinaryDirectory(outputDirectory, "native renderer output", false);
  const binaryBytes = readFileSync(binaryPath);
  const binary = { path: BINARY_PATH, sha256: sha256(binaryBytes), bytes: binaryBytes.length };
  const renderer = {
    schemaVersion: 1,
    sourceCommit: source.sourceCommit,
    engineTree: source.engineTree,
    engineVersion: source.engineVersion,
    target,
    rustToolchain: RUST_TOOLCHAIN,
    buildRecipeVersion: BUILD_RECIPE_VERSION,
    binary,
  };
  const entries = [
    { name: BINARY_PATH, bytes: binaryBytes, mode: 0o755 },
    { name: "package/renderer.json", bytes: jsonBytes(renderer) },
    ...LICENSE_FILES.map(([sourcePath, name]) => ({ name, bytes: readFileSync(path.join(repoRoot, sourcePath)) })),
  ];
  const first = createDeterministicTarball(entries);
  const second = createDeterministicTarball(entries);
  if (!first.equals(second)) fail("renderer tgzが決定的ではありません");
  verifyRendererTarball(first, { ...source, target });
  mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  const file = `niho-develop-render-${source.sourceCommit}-${target}.tgz`;
  writeFileSync(path.join(outputDirectory, file), first, { mode: 0o644 });
  const build = {
    schemaVersion: 1,
    repository: REPOSITORY,
    sourceCommit: source.sourceCommit,
    engineTree: source.engineTree,
    engineVersion: source.engineVersion,
    target,
    rustToolchain: RUST_TOOLCHAIN,
    buildRecipeVersion: BUILD_RECIPE_VERSION,
    file,
    sha256: sha256(first),
    bytes: first.length,
    binary,
  };
  const buildFile = `renderer-build-${target}.json`;
  writeFileSync(path.join(outputDirectory, buildFile), jsonBytes(build), { mode: 0o644 });
  return { ...build, buildFile };
}

function validateBuildRecord(value) {
  exactKeys(value, ["schemaVersion", "repository", "sourceCommit", "engineTree", "engineVersion", "target", "rustToolchain", "buildRecipeVersion", "file", "sha256", "bytes", "binary"], "renderer build record");
  exactKeys(value.binary, ["path", "sha256", "bytes"], "renderer build binary");
  if (value.schemaVersion !== 1 || value.repository !== REPOSITORY || !SHA40.test(value.sourceCommit) || !SHA40.test(value.engineTree) || !/^\d+\.\d+\.\d+$/u.test(value.engineVersion) || !TARGETS.includes(value.target) || value.rustToolchain !== RUST_TOOLCHAIN || value.buildRecipeVersion !== BUILD_RECIPE_VERSION || !SIMPLE_FILE.test(value.file) || !SHA64.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.binary.path !== BINARY_PATH || !SHA64.test(value.binary.sha256) || !Number.isSafeInteger(value.binary.bytes) || value.binary.bytes <= 0) fail("renderer build recordの値が不正です");
  return value;
}

export function verifyBuildArtifact(directory, expected) {
  ordinaryDirectory(directory, "renderer artifact");
  const names = readdirSync(directory).sort();
  const records = names.filter((name) => /^renderer-build-.+\.json$/u.test(name));
  const archives = names.filter((name) => name.endsWith(".tgz"));
  if (names.length !== 2 || records.length !== 1 || archives.length !== 1) fail("renderer artifactのfile集合が不正です");
  const record = validateBuildRecord(JSON.parse(readFileSync(path.join(directory, records[0]), "utf8")));
  if (records[0] !== `renderer-build-${record.target}.json` || record.file !== `niho-develop-render-${record.sourceCommit}-${record.target}.tgz`) fail("renderer artifactのfile名がidentityと一致しません");
  for (const [key, value] of Object.entries(expected)) {
    if (key === "binarySha256") {
      if (value !== undefined && record.binary.sha256 !== value) fail("renderer artifactのbinary digestが一致しません");
    } else if (value !== undefined && record[key] !== value) fail(`renderer artifactの${key}が一致しません`);
  }
  if (record.file !== archives[0]) fail("renderer artifactのarchive名が不正です");
  const bytes = readFileSync(path.join(directory, record.file));
  if (sha256(bytes) !== record.sha256 || bytes.length !== record.bytes) fail("renderer archive bytesがbuild recordと一致しません");
  const verified = verifyRendererTarball(bytes, expected);
  if (JSON.stringify(verified.binary) !== JSON.stringify(record.binary)) fail("renderer binary identityがbuild recordと一致しません");
  return { record, bytes };
}

function normalizeArtifactDigest(value) {
  const match = /^(?:sha256:)?([a-f0-9]{64})$/u.exec(value ?? "");
  if (!match) fail("artifact digestが不正です");
  return `sha256:${match[1]}`;
}

function validatePublicationInput(input) {
  if (!TARGETS.includes(input.target) || !/^[1-9][0-9]*$/u.test(input.id ?? "") || !SIMPLE_FILE.test(input.name ?? "")) fail("input artifact identityが不正です");
  return { target: input.target, id: input.id, digest: normalizeArtifactDigest(input.digest), name: input.name };
}

export function createNativeReleaseManifest({ artifacts, outputDirectory, sourceCommit, builderSourceCommit, runId, runAttempt }) {
  if (!SHA40.test(sourceCommit) || !SHA40.test(builderSourceCommit) || !/^[1-9][0-9]*$/u.test(runId) || !/^[1-9][0-9]*$/u.test(runAttempt)) fail("release identityが不正です");
  ordinaryDirectory(outputDirectory, "native release output", false);
  const inputs = artifacts.map((artifact) => ({ ...artifact, publication: validatePublicationInput(artifact.publication) })).sort((left, right) => left.target.localeCompare(right.target, "en"));
  if (inputs.length !== 2 || inputs.map(({ target }) => target).join("\0") !== [...TARGETS].sort().join("\0")) fail("native releaseはexact 2 targetsが必要です");
  for (const input of inputs) {
    if (input.publication.target !== input.target || input.publication.name !== `niho-renderer-${sourceCommit}-run-${runId}-attempt-${runAttempt}-${input.target}`) fail("input artifact name/targetがrun identityと一致しません");
  }
  const verified = inputs.map((input) => ({ ...input, ...verifyBuildArtifact(input.directory, { sourceCommit, target: input.target, ...input.expected }) }));
  const first = verified[0].record;
  for (const item of verified) {
    for (const key of ["repository", "sourceCommit", "engineTree", "engineVersion", "rustToolchain", "buildRecipeVersion"]) if (item.record[key] !== first[key]) fail(`native releaseの${key}がtarget間で一致しません`);
  }
  mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  const assets = verified.map(({ record, bytes }) => {
    writeFileSync(path.join(outputDirectory, record.file), bytes, { mode: 0o644, flag: "wx" });
    return { target: record.target, file: record.file, sha256: record.sha256, bytes: record.bytes, binary: record.binary };
  });
  const manifest = {
    schemaVersion: 1,
    repository: REPOSITORY,
    sourceCommit,
    engineTree: first.engineTree,
    engineVersion: first.engineVersion,
    buildRecipeVersion: BUILD_RECIPE_VERSION,
    rustToolchain: RUST_TOOLCHAIN,
    assets,
    publication: {
      builderSourceCommit,
      workflow: ".github/workflows/photo-renderer-release.yml",
      ref: "refs/heads/main",
      runId,
      runAttempt,
      inputArtifacts: verified.map(({ publication }) => publication),
    },
  };
  const manifestFile = `niho-photo-renderer-${sourceCommit}.json`;
  const bytes = jsonBytes(manifest);
  writeFileSync(path.join(outputDirectory, manifestFile), bytes, { mode: 0o644, flag: "wx" });
  return { manifest, manifestFile, manifestSha256: sha256(bytes), assets };
}

export function buildNativeRenderer({ repoRoot, outputDirectory, expectedCommit, target, inputEnv = process.env }) {
  const source = inspectRendererSource(repoRoot, expectedCommit);
  const expectedPlatform = target === "aarch64-apple-darwin" ? ["darwin", "arm64"] : ["linux", "x64"];
  if (process.platform !== expectedPlatform[0] || process.arch !== expectedPlatform[1]) fail("build hostがtargetと一致しません");
  const scratch = mkdtempSync(path.join(tmpdir(), "niho-renderer-native-"));
  try {
    const env = nativeRendererBuildEnvironment(inputEnv, { sourceRoot: repoRoot, scratch, target });
    const engineRoot = path.join(repoRoot, ENGINE_PATH);
    const rustVersion = run("rustc", ["+1.98.1", "--version"], { cwd: engineRoot, env });
    if (!rustVersion.startsWith("rustc 1.98.1 ")) fail("利用中のrustcがsource pinと一致しません");
    const lockBefore = sha256(readFileSync(path.join(engineRoot, "Cargo.lock")));
    run("cargo", ["+1.98.1", "build", "--locked", "--release", "--target", target, "-p", "niho-develop-render"], { cwd: engineRoot, env, stdio: "inherit" });
    if (sha256(readFileSync(path.join(engineRoot, "Cargo.lock"))) !== lockBefore) fail("Cargo.lockがbuild中に変わりました");
    const binaryPath = path.join(env.CARGO_TARGET_DIR, target, "release", "niho-develop-render");
    verifyNativeBinary(binaryPath, target, {
      env,
      forbiddenPrefixes: [repoRoot, engineRoot, scratch, inputEnv.HOME, inputEnv.CARGO_HOME, inputEnv.RUSTUP_HOME, inputEnv.RUNNER_TEMP, inputEnv.GITHUB_WORKSPACE],
    });
    smokeRenderer(binaryPath, scratch, env);
    return packageNativeRenderer({ repoRoot, binaryPath, outputDirectory, source, target });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function options(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name)) fail("native renderer CLI引数が不正です");
    values.set(name, value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) fail(`${name}が必要です`);
  return value;
}

function appendOutputs(file, values) {
  if (!file) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
  writeFileSync(file, lines, { flag: "a" });
}

async function main(argv) {
  const command = argv.shift();
  const values = options(argv);
  if (command === "build") {
    const allowed = new Set(["--source", "--expected-source", "--target", "--output", "--github-output"]);
    if ([...values.keys()].some((key) => !allowed.has(key))) fail("build CLIに未知の引数があります");
    const result = buildNativeRenderer({
      repoRoot: path.resolve(required(values, "--source")),
      outputDirectory: path.resolve(required(values, "--output")),
      expectedCommit: required(values, "--expected-source"),
      target: required(values, "--target"),
    });
    appendOutputs(values.get("--github-output"), {
      "source-sha": result.sourceCommit,
      "engine-tree": result.engineTree,
      "engine-version": result.engineVersion,
      target: result.target,
      "archive-file": result.file,
      "archive-sha256": result.sha256,
      "binary-sha256": result.binary.sha256,
    });
    return;
  }
  if (command === "publish") {
    const allowed = new Set(["--linux-directory", "--macos-directory", "--output", "--source", "--builder-source", "--run-id", "--run-attempt", "--linux-artifact-id", "--linux-artifact-digest", "--linux-artifact-name", "--linux-engine-tree", "--linux-engine-version", "--linux-target", "--linux-archive-sha256", "--linux-binary-sha256", "--macos-artifact-id", "--macos-artifact-digest", "--macos-artifact-name", "--macos-engine-tree", "--macos-engine-version", "--macos-target", "--macos-archive-sha256", "--macos-binary-sha256", "--github-output"]);
    if ([...values.keys()].some((key) => !allowed.has(key))) fail("publish CLIに未知の引数があります");
    const artifact = (prefix, target) => ({
      target,
      directory: path.resolve(required(values, `--${prefix}-directory`)),
      publication: { target, id: required(values, `--${prefix}-artifact-id`), digest: required(values, `--${prefix}-artifact-digest`), name: required(values, `--${prefix}-artifact-name`) },
      expected: {
        engineTree: required(values, `--${prefix}-engine-tree`),
        engineVersion: required(values, `--${prefix}-engine-version`),
        target: required(values, `--${prefix}-target`),
        sha256: required(values, `--${prefix}-archive-sha256`),
        binarySha256: required(values, `--${prefix}-binary-sha256`),
      },
    });
    const result = createNativeReleaseManifest({
      artifacts: [artifact("linux", "x86_64-unknown-linux-gnu"), artifact("macos", "aarch64-apple-darwin")],
      outputDirectory: path.resolve(required(values, "--output")),
      sourceCommit: required(values, "--source"),
      builderSourceCommit: required(values, "--builder-source"),
      runId: required(values, "--run-id"),
      runAttempt: required(values, "--run-attempt"),
    });
    appendOutputs(values.get("--github-output"), { "manifest-file": result.manifestFile, "manifest-sha256": result.manifestSha256 });
    return;
  }
  fail("使い方: native-renderer.mjs build|publish <固定引数>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "native renderer処理に失敗しました");
    process.exitCode = 1;
  });
}
