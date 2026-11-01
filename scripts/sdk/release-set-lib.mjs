import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { assertPublicBytes, guardBundle } from "../ci/release-evidence-lib.mjs";
import { validateReleaseManifest, verifyManifestPackageFiles } from "./verify-release-artifact.mjs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIMPLE_ASSET = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const ROOT_NOTICE_FILES = ["LICENSE.md", "ASSET_LICENSE.md", "TRADEMARKS.md", "THIRD_PARTY_NOTICES.md"];
const ENGINE_NOTICE_FILES = ["LICENSES.md", "licenses/Adobe-DNG-SDK-LICENSE.txt"];
const ENGINE_NATIVE_CLOSURE = [
  "build-macos-native.mjs",
  "calibration/apple-registry.json",
  "calibration/apple-signed-registry.json",
  "calibration/panasonic-dc-s5/apple-v1.json",
  "calibration/panasonic-dc-s5/apple-v2.json",
  "crates/niho-develop-render/Cargo.toml",
  "crates/niho-develop-render/src/main.rs",
  "tools/apple-raw-linear/Package.swift",
  "tools/apple-raw-linear/Sources/apple-raw-linear/main.swift",
  "tools/niho-camera-cutout/Package.swift",
  "tools/niho-camera-cutout/Sources/NihoCameraCutoutCLI/main.swift",
];
const OWNED_SOURCE_PATHS = ["packages/photo-editing", "packages/ui", "packages/niho-cloud-contract", "packages/develop-engine", "packages/desktop-photo", "sdk", "scripts/sdk", "scripts/ci/cloud-contract-sync.mjs", "scripts/ci/image-metadata.mjs", "scripts/ci/photo-candidate-workflow-lib.mjs", "scripts/ci/photo-sdk-workflow-lib.mjs", "scripts/ci/publication-lib.mjs", "scripts/ci/release-evidence-lib.mjs", "scripts/ci/workflow-lib.mjs", "LICENSE.md", "ASSET_LICENSE.md", "TRADEMARKS.md", "THIRD_PARTY_NOTICES.md"];
const BUILD_TOOLING_PATHS = ["package.json", "package-lock.json"];
const TOOLING_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// スレッドの wasm（#151。crossOriginIsolated の画面だけが読む）の build の指定。build と release set の検証が
// 同じ値を使う。共有メモリの上限は 1 本の wasm と同じ wasm32 の 4GiB（大きな書き出しで 1 本より先に足りなく
// ならない。確保できない端末は Worker が起動で 1 本へ落ちる）。
export const THREADS_BUILD = Object.freeze({
  targetFeatures: Object.freeze(["+atomics", "+bulk-memory", "+mutable-globals", "+simd128"]),
  maxMemory: 4 * 1024 * 1024 * 1024,
  buildStd: "panic_abort,std",
  rustcBootstrap: true,
});

/** スレッドの wasm の配布名（1 本の `niho_develop_wasm-*` と区別する。worker は wasm-bindgen-rayon の helper を平らにしたもの）。 */
export function threadsRuntimeFileNames(version) {
  return Object.freeze({
    js: `niho_develop_wasm_threads-${version}.js`,
    dts: `niho_develop_wasm_threads-${version}.d.ts`,
    wasm: `niho_develop_wasm_threads_bg-${version}.wasm`,
    wasmDts: `niho_develop_wasm_threads_bg-${version}.wasm.d.ts`,
    worker: `niho_develop_wasm_threads_worker-${version}.js`,
  });
}

const THREADS_TLS_EXPORTS = ["__wasm_init_tls", "__tls_size", "__tls_align", "__tls_base"];

/** スレッドの wasm の rustc の指定（CARGO_ENCODED_RUSTFLAGS の並び。path の remap は build が足す）。 */
export function threadsRustflags(build = THREADS_BUILD) {
  return [
    "-C",
    `target-feature=${build.targetFeatures.join(",")}`,
    "-C",
    "link-arg=--shared-memory",
    "-C",
    "link-arg=--import-memory",
    "-C",
    `link-arg=--max-memory=${build.maxMemory}`,
    // wasm-bindgen がスレッドごとの TLS を用意する口
    ...THREADS_TLS_EXPORTS.flatMap((symbol) => ["-C", `link-arg=--export=${symbol}`]),
  ];
}

export class SdkReleaseError extends Error {}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sri(bytes) {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function assertRelativePath(value, label = "path") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new SdkReleaseError(`${label} が安全な相対pathではありません`);
  }
  return value;
}

export function assertStrictSemver(value) {
  const match = typeof value === "string" ? SEMVER.exec(value) : null;
  if (!match) throw new SdkReleaseError("SDK version は strict semver が必要です");
  for (const part of match[4]?.split(".") ?? []) {
    if (/^\d+$/.test(part) && part.length > 1 && part.startsWith("0")) throw new SdkReleaseError("SDK version の数値識別子に先頭 0 は使えません");
  }
  return value;
}

function globRegex(pattern) {
  assertRelativePath(pattern.replaceAll("*", "x"), "glob");
  let result = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          result += "(?:.*/)?";
        } else {
          result += ".*";
        }
      } else {
        result += "[^/]*";
      }
    } else {
      result += /[.+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`${result}$`);
}

export function matchesPackagePath(relative, definition) {
  assertRelativePath(relative, "source file");
  return definition.include.some((pattern) => globRegex(pattern).test(relative)) && !definition.exclude.some((pattern) => globRegex(pattern).test(relative));
}

export function validateConfig(config) {
  if (!config || config.schemaVersion !== 1 || config.repository !== "niho-life/niho-photo") throw new SdkReleaseError("release-set の基本契約が不正です");
  assertStrictSemver(config.version);
  if (!Array.isArray(config.packages) || config.packages.length !== 5) throw new SdkReleaseError("release-set は UI/editor/cloud contract/Node contract/engine source の 5 package が必要です");
  const ids = new Set();
  const names = new Set();
  for (const definition of config.packages) {
    if (!definition || !["typescript", "node-contract", "rust-source"].includes(definition.kind) || !/^[a-z][a-z0-9-]*$/.test(definition.id ?? "") || !PACKAGE_NAME.test(definition.name ?? "")) throw new SdkReleaseError("package 定義が不正です");
    if (ids.has(definition.id) || names.has(definition.name)) throw new SdkReleaseError("package id/name が重複しています");
    ids.add(definition.id);
    names.add(definition.name);
    assertRelativePath(definition.sourceRoot, "sourceRoot");
    if (!Array.isArray(definition.include) || !definition.include.length || !Array.isArray(definition.exclude)) throw new SdkReleaseError("package include/exclude が不正です");
    for (const pattern of [...definition.include, ...definition.exclude]) globRegex(pattern);
    if (definition.kind === "node-contract" && (definition.id !== "photo-contract" || definition.name !== "niho-photo-contract" || !assertRelativePath(definition.entry, "Node contract entry") || !definition.include.some((pattern) => globRegex(pattern).test(definition.entry)))) throw new SdkReleaseError("Node contract 定義が不正です");
    for (const [from, to] of Object.entries(definition.rewritePackageImports ?? {})) {
      if (!PACKAGE_NAME.test(from) || !PACKAGE_NAME.test(to) || from === to) throw new SdkReleaseError("package import rewrite が不正です");
    }
    for (const [from, to] of Object.entries(definition.rewriteSpecifiers ?? {})) {
      const dependency = to.startsWith("@") ? to.split("/").slice(0, 2).join("/") : to.split("/")[0];
      if (typeof from !== "string" || !from || from.includes("\\") || from.includes("\0") || !PACKAGE_NAME.test(dependency)) throw new SdkReleaseError("module specifier rewrite が不正です");
    }
  }
  if (!ids.has("ui") || !ids.has("photo-editing") || !ids.has("cloud-contract") || !ids.has("photo-contract") || !ids.has("develop-engine-source")) throw new SdkReleaseError("必須 package がありません");
  if (JSON.stringify(config.ownedSourcePaths) !== JSON.stringify(OWNED_SOURCE_PATHS)) throw new SdkReleaseError("SDK owned source path が不正です");
  if (JSON.stringify(config.buildToolingPaths) !== JSON.stringify(BUILD_TOOLING_PATHS)) throw new SdkReleaseError("SDK build tooling path が不正です");
  const engineSource = config.packages.find(({ id }) => id === "develop-engine-source");
  if (!ENGINE_NOTICE_FILES.every((file) => engineSource.include.some((pattern) => globRegex(pattern).test(file)))) throw new SdkReleaseError("engine source の license/notice closure が不足しています");
  if (!ENGINE_NATIVE_CLOSURE.every((file) => engineSource.include.some((pattern) => globRegex(pattern).test(file)))) throw new SdkReleaseError("engine source の macOS native build closure が不足しています");
  const engine = config.engine;
  if (!engine || !/^niho-[1-9]\d*$/.test(engine.version ?? "") || !SEMVER.test(engine.crateVersion ?? "") || !PACKAGE_NAME.test(engine.runtimePackageName ?? "")) throw new SdkReleaseError("engine pin が不正です");
  assertStrictSemver(engine.crateVersion);
  assertRelativePath(engine.assetDirectory, "engine assetDirectory");
  if (engine.manifestName !== `manifest-${engine.crateVersion}.json`) throw new SdkReleaseError("engine manifest 名と crate version が一致しません");
  for (const item of [...engine.contractPaths, ...engine.buildInputs]) assertRelativePath(item, "engine input");
  if (!Array.isArray(engine.requiredExtensions) || ![".js", ".wasm", ".d.ts"].every((extension) => engine.requiredExtensions.includes(extension))) throw new SdkReleaseError("engine runtime の必須拡張子がありません");
  return config;
}

function git(repoRoot, args, options = {}) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { maxBuffer: 128 * 1024 * 1024, ...options });
  } catch {
    throw new SdkReleaseError("Git object の読み取りに失敗しました");
  }
}

function resolveSource(repoRoot, sourceRef) {
  if (sourceRef !== "HEAD" && !/^[a-f0-9]{40}$/.test(sourceRef ?? "")) throw new SdkReleaseError("source は HEAD または full commit SHA が必要です");
  const commit = git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${sourceRef}^{commit}`], { encoding: "utf8" }).trim();
  const tree = git(repoRoot, ["rev-parse", "--verify", `${commit}^{tree}`], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) throw new SdkReleaseError("full source SHA を解決できません");
  const dirty = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
  if (dirty.length !== 0) throw new SdkReleaseError("release pack は clean working tree からだけ生成できます");
  return { commit, tree };
}

function treeEntries(repoRoot, commit, sourceRoot) {
  const output = git(repoRoot, ["ls-tree", "-rz", "--full-tree", commit, "--", sourceRoot]);
  if (!output.length) throw new SdkReleaseError(`tracked source がありません: ${sourceRoot}`);
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(record);
      if (!match) throw new SdkReleaseError("git tree entry が不正です");
      const [, mode, type, object, file] = match;
      assertRelativePath(file, "tracked source");
      if (mode === "120000") throw new SdkReleaseError(`symlink は SDK source に含められません: ${file}`);
      if (mode !== "100644" && mode !== "100755") throw new SdkReleaseError(`通常ファイル以外は SDK source に含められません: ${file}`);
      if (type !== "blob") throw new SdkReleaseError(`blob 以外は SDK source に含められません: ${file}`);
      return { mode, object, file };
    });
}

function gitBytes(repoRoot, commit, file) {
  assertRelativePath(file, "git object path");
  return git(repoRoot, ["show", `${commit}:${file}`]);
}

function safeDestination(root, relative) {
  assertRelativePath(relative, "staging path");
  const target = path.resolve(root, ...relative.split("/"));
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new SdkReleaseError("staging path が package 外を指しています");
  return target;
}

function put(root, relative, bytes) {
  const target = safeDestination(root, relative);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  writeFileSync(target, bytes, { mode: 0o644, flag: "wx" });
}

function rewriteImports(bytes, rewrites, specifierRewrites, file) {
  if ((!Object.keys(rewrites).length && !Object.keys(specifierRewrites).length) || !/\.(?:[cm]?[jt]sx?)$/.test(file)) return bytes;
  let text = bytes.toString("utf8");
  for (const [from, to] of Object.entries(rewrites)) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(["'])${escaped}(?=\\/|["'])`, "g"), `$1${to}`);
  }
  for (const [from, to] of Object.entries(specifierRewrites)) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(["'])${escaped}\\1`, "g"), `$1${to}$1`);
  }
  return Buffer.from(text);
}

function packageManifest(definition, original, config) {
  const rootNotices = ROOT_NOTICE_FILES;
  if (definition.kind === "node-contract") {
    return {
      name: definition.name,
      version: config.version,
      description: "NIHO photo recipe contract for plain Node.js ESM consumers",
      type: "module",
      license: "UNLICENSED",
      files: ["dist", ...rootNotices],
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./package.json": "./package.json" },
      engines: { node: "24.x" },
    };
  }
  if (definition.kind === "rust-source") {
    return {
      name: definition.name,
      version: config.version,
      description: "NIHO photo develop engine source pinned to an SDK release set",
      license: "UNLICENSED",
      files: ["engine", "release-inputs.json", ...rootNotices],
      engines: { node: "24.x" },
    };
  }
  const manifest = structuredClone(original);
  delete manifest.private;
  delete manifest.scripts;
  delete manifest.devDependencies;
  manifest.name = definition.name;
  manifest.version = config.version;
  manifest.license = "UNLICENSED";
  manifest.files = ["src", "types", ...rootNotices, ...(definition.id === "ui" ? ["tailwind-theme.cjs"] : []), ...(definition.id === "cloud-contract" ? ["README.md"] : [])];
  if (definition.id === "ui") manifest.sideEffects = ["./src/styles/*.css"];
  if (definition.id === "photo-editing") {
    const peers = { ...(manifest.peerDependencies ?? {}) };
    delete peers["niho-ui"];
    peers["niho-photo-ui"] = config.version;
    peers["niho-photo-cloud-contract"] = config.version;
    manifest.peerDependencies = Object.fromEntries(Object.entries(peers).sort(([a], [b]) => a.localeCompare(b, "en")));
    manifest.exports = {
      ...(manifest.exports ?? {}),
      "./develop-engine/*": "./src/develop-engine/*.ts",
      "./library/*": "./src/library/*.ts",
      "./sdk-dialog-host": "./src/sdk-dialog-host.tsx",
    };
  }
  manifest.exports = declarationExports(manifest.exports ?? {});
  return manifest;
}

function declarationTarget(target) {
  if (typeof target !== "string" || !/^\.\/src\/.+\.(?:ts|tsx)$/u.test(target)) return undefined;
  return target.replace(/^\.\/src\//u, "./types/").replace(/\.(?:ts|tsx)$/u, ".d.ts");
}

function declarationExports(exports) {
  return Object.fromEntries(Object.entries(exports).map(([name, target]) => {
    const types = declarationTarget(target);
    return [name, types ? { types, default: target } : target];
  }));
}

function resolveRelativeImport(files, fromFile, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (base.startsWith("../") || base === "..") return null;
  const withoutJs = base.replace(/\.(?:m?js)$/, "");
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}.js`, `${base}.mjs`, `${base}.json`, `${base}.css`, `${withoutJs}.ts`, `${withoutJs}.tsx`, `${withoutJs}.d.ts`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.d.ts`];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function exportTargets(target) {
  if (typeof target === "string") return [target];
  if (!target || typeof target !== "object" || Array.isArray(target)) return [];
  return Object.values(target).flatMap(exportTargets);
}

export function auditTypeScriptClosure(stage, manifest) {
  const files = new Set();
  function visit(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isDirectory()) visit(full, relative);
      else files.add(relative);
    }
  }
  visit(stage);
  const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));
  for (const file of [...files].filter((name) => /\.(?:[cm]?[jt]sx?)$/.test(name))) {
    const text = readFileSync(path.join(stage, file), "utf8");
    const specifiers = [
      ...ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => fileName),
      ...[...text.matchAll(/new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)].map((match) => match[1]),
    ];
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        if (!resolveRelativeImport(files, file, specifier)) throw new SdkReleaseError(`dependency closure に欠落があります: ${file}`);
        continue;
      }
      const dependency = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (["next", "@tauri-apps", "niho-ui"].some((forbidden) => dependency === forbidden || dependency.startsWith(`${forbidden}/`))) throw new SdkReleaseError(`SDK host 境界外の import があります: ${dependency}`);
      if (!dependency.startsWith("node:") && !peers.has(dependency)) throw new SdkReleaseError(`runtime dependency が peerDependencies にありません: ${dependency}`);
    }
  }
  for (const target of Object.values(manifest.exports ?? {}).flatMap(exportTargets)) {
    if (!target.startsWith("./")) continue;
    if (target.includes("*")) {
      const expression = globRegex(target.slice(2));
      if (![...files].some((file) => expression.test(file))) throw new SdkReleaseError(`export に対応する source がありません: ${target}`);
    } else if (!files.has(target.slice(2))) {
      throw new SdkReleaseError(`export source がありません: ${target}`);
    }
  }
}

function stageSourcePackage({ repoRoot, commit, config, definition, stage, rootNotices }) {
  const entries = treeEntries(repoRoot, commit, definition.sourceRoot);
  const selected = entries.filter(({ file }) => matchesPackagePath(file.slice(definition.sourceRoot.length + 1), definition));
  if (!selected.length) throw new SdkReleaseError(`package source が空です: ${definition.id}`);
  let originalManifest = {};
  for (const entry of selected) {
    const relative = entry.file.slice(definition.sourceRoot.length + 1);
    const bytes = gitBytes(repoRoot, commit, entry.file);
    if (relative === "package.json") {
      originalManifest = JSON.parse(bytes.toString("utf8"));
      continue;
    }
    const output = definition.kind === "rust-source" ? `engine/${relative}` : relative;
    put(stage, output, rewriteImports(bytes, definition.rewritePackageImports ?? {}, definition.rewriteSpecifiers ?? {}, relative));
  }
  const manifest = packageManifest(definition, originalManifest, config);
  if (definition.id === "photo-editing") {
    put(
      stage,
      "src/sdk-dialog-host.tsx",
      Buffer.from('export { AppDialogHost as PhotoEditingDialogHost } from "niho-photo-ui/components/app-dialog-host";\n'),
    );
  }
  put(stage, "package.json", jsonBytes(manifest));
  for (const [name, bytes] of Object.entries(rootNotices)) put(stage, name, bytes);
  if (definition.kind === "rust-source") {
    put(stage, "release-inputs.json", jsonBytes({
      schemaVersion: 1,
      engine: config.engine.version,
      crateVersion: config.engine.crateVersion,
      sourceRoot: definition.sourceRoot,
      buildInputs: config.engine.buildInputs,
      commands: {
        wasm: "cargo build --locked --config engine/.cargo/config.toml --manifest-path engine/Cargo.toml --target wasm32-unknown-unknown --release -p niho-develop-wasm",
        // スレッドの版（#151）: 固定の 1.98.1 に rust-src を足し、RUSTC_BOOTSTRAP=1 で std を作り直す
        wasmThreads: `RUSTC_BOOTSTRAP=1 RUSTFLAGS="${threadsRustflags().join(" ")}" cargo build --locked --manifest-path engine/Cargo.toml --target wasm32-unknown-unknown --release -p niho-develop-wasm --features threads -Z build-std=${THREADS_BUILD.buildStd}`,
        macosNative: "node engine/build-macos-native.mjs --engine engine --lock <camera-lock.json> --output <new-stage-directory>",
      },
    }));
  }
  return manifest;
}

function linkDeclarationDependency(dependencyRoot, dependency, source) {
  let stat;
  try {
    stat = lstatSync(source);
  } catch {
    throw new SdkReleaseError(`declaration peer がありません: ${dependency}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SdkReleaseError(`declaration peer が通常のdirectoryではありません: ${dependency}`);
  const target = path.join(dependencyRoot, "node_modules", ...dependency.split("/"));
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  try {
    lstatSync(target);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw new SdkReleaseError(`declaration peer linkを確認できません: ${dependency}`);
  }
  symlinkSync(source, target, "dir");
}

function declarationTypesTarget(target) {
  if (typeof target === "string") return target.endsWith(".d.ts") || target.endsWith(".d.cts") ? target : undefined;
  if (!target || typeof target !== "object" || Array.isArray(target)) return undefined;
  return declarationTypesTarget(target.import?.types) ?? declarationTypesTarget(target.types) ?? Object.values(target).map(declarationTypesTarget).find(Boolean);
}

function assertDeclarationPeerReexport(peer, dependency) {
  const peerRoot = path.join(TOOLING_ROOT, "node_modules", ...peer.split("/"));
  let peerManifest;
  try {
    peerManifest = JSON.parse(readFileSync(path.join(peerRoot, "package.json"), "utf8"));
  } catch {
    throw new SdkReleaseError(`declaration peer manifest がありません: ${peer}`);
  }
  const target = declarationTypesTarget(peerManifest.exports?.["."]) ?? declarationTypesTarget(peerManifest.types);
  if (!target?.startsWith("./")) throw new SdkReleaseError(`declaration peer の型入口がありません: ${peer}`);
  const declaration = readFileSync(path.join(peerRoot, target), "utf8");
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`export\\s+\\*\\s+from\\s+["']${escaped}["']`, "u").test(declaration)) {
    throw new SdkReleaseError(`declaration peer が型をre-exportしていません: ${peer} <- ${dependency}`);
  }
}

function normalizeDeclarationSpecifiers(text, manifest) {
  const rewrites = new Map([["@tanstack/query-core", "@tanstack/react-query"]]);
  let normalized = text;
  for (const [dependency, peer] of rewrites) {
    if (!ts.preProcessFile(normalized, true, true).importedFiles.some(({ fileName }) => fileName === dependency)) continue;
    if (!Object.hasOwn(manifest.peerDependencies ?? {}, peer)) continue;
    assertDeclarationPeerReexport(peer, dependency);
    normalized = normalized.replaceAll(`"${dependency}"`, `"${peer}"`).replaceAll(`'${dependency}'`, `'${peer}'`);
  }
  return normalized;
}

function emitSourceDeclarations({ repoRoot, definition, stage, manifest, sourceStages }) {
  const sourceRoot = path.join(stage, "src");
  const outputRoot = path.join(stage, "types");
  const dependencyRoot = path.dirname(stage);
  const stagedPackages = new Map([...sourceStages.values()].map((item) => [item.manifest.name, item.stage]));
  for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
    const source = stagedPackages.get(dependency) ?? path.join(TOOLING_ROOT, "node_modules", ...dependency.split("/"));
    linkDeclarationDependency(dependencyRoot, dependency, source);
  }
  for (const dependency of ["@types/node", "@types/react", "@types/react-dom"]) {
    linkDeclarationDependency(dependencyRoot, dependency, path.join(TOOLING_ROOT, "node_modules", ...dependency.split("/")));
  }
  const rootNames = collectFiles(sourceRoot)
    .filter((name) => /\.(?:ts|tsx)$/u.test(name) && !name.endsWith(".d.ts"))
    .map((name) => path.join(sourceRoot, name));
  const program = ts.createProgram({
    rootNames,
    options: {
      declaration: true,
      emitDeclarationOnly: true,
      esModuleInterop: true,
      isolatedModules: true,
      jsx: ts.JsxEmit.ReactJSX,
      lib: ["lib.dom.d.ts", "lib.dom.iterable.d.ts", "lib.esnext.d.ts"],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      newLine: ts.NewLineKind.LineFeed,
      noEmitOnError: true,
      noUncheckedIndexedAccess: false,
      outDir: outputRoot,
      resolveJsonModule: true,
      rootDir: sourceRoot,
      skipLibCheck: true,
      sourceMap: false,
      strict: true,
      target: ts.ScriptTarget.ES2017,
      types: definition.id === "cloud-contract" ? [] : ["node", "react", "react-dom", "react/experimental"],
    },
  });
  const emitted = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(({ category }) => category === ts.DiagnosticCategory.Error);
  if (emitted.emitSkipped || diagnostics.length) {
    const detail = diagnostics.slice(0, 20).map(({ file, start, messageText }) => {
      const location = file && start !== undefined ? `${path.relative(stage, file.fileName)}:${file.getLineAndCharacterOfPosition(start).line + 1}` : definition.id;
      return `${location}: ${ts.flattenDiagnosticMessageText(messageText, " ")}`;
    }).join(" / ");
    throw new SdkReleaseError(`TypeScript declaration生成に失敗しました: ${detail}`);
  }
  const outputs = collectFiles(outputRoot);
  if (!outputs.length || outputs.some((name) => !name.endsWith(".d.ts"))) throw new SdkReleaseError(`TypeScript declaration closureが不正です: ${definition.id}`);
  for (const name of outputs) {
    const output = path.join(outputRoot, name);
    const text = normalizeDeclarationSpecifiers(readFileSync(output, "utf8"), manifest);
    writeFileSync(output, text);
    if (text.includes(repoRoot) || text.includes(stage) || /\bprivate\/var\/|\bUsers\//u.test(text)) throw new SdkReleaseError(`TypeScript declarationにprivate pathがあります: ${definition.id}`);
  }
  auditTypeScriptClosure(stage, manifest);
}

function rewriteNodeImportSpecifiers(text) {
  let rewritten = text;
  for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles.filter(({ fileName }) => fileName.startsWith("."))) {
    const specifier = fileName.replace(/\.(?:[cm]?[jt]sx?)$/u, "");
    const replacement = `${specifier}.js`;
    rewritten = rewritten.replaceAll(`"${fileName}"`, `"${replacement}"`).replaceAll(`'${fileName}'`, `'${replacement}'`);
  }
  return rewritten;
}

function collectNodeContractSources(repoRoot, commit, definition) {
  const entries = treeEntries(repoRoot, commit, definition.sourceRoot);
  const byRelativePath = new Map(entries.map((entry) => [entry.file.slice(definition.sourceRoot.length + 1), entry]));
  const selected = new Map();
  const queue = [definition.entry];
  while (queue.length) {
    const relative = queue.shift();
    if (selected.has(relative)) continue;
    const entry = byRelativePath.get(relative);
    if (!entry || !relative.endsWith(".ts") || relative.endsWith(".d.ts")) throw new SdkReleaseError("Node contract の純粋TypeScript closureが不正です");
    const bytes = gitBytes(repoRoot, commit, entry.file);
    const text = bytes.toString("utf8");
    selected.set(relative, rewriteNodeImportSpecifiers(text));
    for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
      if (!specifier.startsWith(".")) throw new SdkReleaseError("Node contract に外部runtime dependencyがあります");
      const dependency = resolveRelativeImport(new Set(byRelativePath.keys()), relative, specifier);
      if (!dependency) throw new SdkReleaseError("Node contract dependency closureに欠落があります");
      queue.push(dependency);
    }
  }
  return selected;
}

function stageNodeContractPackage({ repoRoot, commit, config, definition, stage, rootNotices, recipe }) {
  const buildRoot = path.join(stage, ".contract-build");
  const sourceRoot = path.join(buildRoot, "source");
  const outputRoot = path.join(stage, "dist");
  mkdirSync(sourceRoot, { recursive: true, mode: 0o755 });
  put(buildRoot, "package.json", jsonBytes({ type: "module" }));
  for (const [relative, text] of collectNodeContractSources(repoRoot, commit, definition)) put(sourceRoot, relative, Buffer.from(text));
  const entry = [
    "export {",
    "  DEVELOP_SETTINGS_ENGINE, DEVELOP_SETTINGS_LOOK, DEVELOP_SETTINGS_LOOKS, DEVELOP_SETTINGS_LOOK_WHEN_MISSING,",
    "  LEGACY_DEVELOP_SETTINGS_ENGINE, NIHO2_DEVELOP_SETTINGS_ENGINE,",
    "  NIHO4_DEVELOP_SETTINGS_ENGINE, NIHO4_DEVELOP_SETTINGS_LOOK,",
    "  NIHO6_DEVELOP_SETTINGS_ENGINE, NIHO6_DEVELOP_SETTINGS_LOOKS, NIHO7_DEVELOP_SETTINGS_ENGINE, NIHO7_DEVELOP_SETTINGS_LOOK,",
    "  NIHO10_DEVELOP_SETTINGS_ENGINE, NIHO11_DEVELOP_SETTINGS_ENGINE, NIHO11_DEVELOP_SETTINGS_LOOK,",
    "  NIHO12_DEVELOP_SETTINGS_ENGINE, SIGNED_DEVELOP_SETTINGS_ENGINE, SIGNED_DEVELOP_SETTINGS_LOOK, SIGNED_WORKING_COPY_ENCODING,",
    "  DevelopSettingsBaseMismatchError, developSettingsOnWorkingCopy, hasNullDevelopGeometryField, isEditableDevelopSettings,",
    "  neutralDevelopSettings, newDevelopSettingsEngine, readDevelopSettings, signedNeutralDevelopSettings, signedWorkingCopyState,",
    "  supportsDevelopSettingsWrite, supportsNiho4SignedRaw, supportsNiho7SignedRaw,",
    '} from "./src/develop-engine/develop-settings.js";',
    'export type { DevelopSettings, DevelopSettingsVersion, NewDevelopSettingsEngineOptions, SignedWorkingCopyState } from "./src/develop-engine/develop-settings.js";',
    `export const supportedDevelopSettingsVersions = ${JSON.stringify(recipe.supportedVersions)} as const;`,
    `export const developSettingsEngineIdentifiers = ${JSON.stringify(recipe.engineIdentifiers)} as const;`,
    "",
  ].join("\n");
  put(sourceRoot, "index.ts", Buffer.from(entry));
  const rootNames = ["index.ts", ...collectFiles(sourceRoot).filter((name) => name.endsWith(".ts"))]
    .filter((name, index, values) => values.indexOf(name) === index)
    .map((name) => path.join(sourceRoot, name));
  const program = ts.createProgram({
    rootNames,
    options: {
      declaration: true,
      esModuleInterop: false,
      lib: ["lib.es2022.d.ts"],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      newLine: ts.NewLineKind.LineFeed,
      noEmitOnError: true,
      outDir: outputRoot,
      rootDir: sourceRoot,
      skipLibCheck: true,
      sourceMap: false,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
    },
  });
  const emitted = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(({ category }) => category === ts.DiagnosticCategory.Error);
  if (emitted.emitSkipped || diagnostics.length) throw new SdkReleaseError(`Node contract のJavaScript/declaration生成に失敗しました: ${diagnostics.slice(0, 4).map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, " ")).join(" / ")}`);
  rmSync(buildRoot, { recursive: true, force: true });
  const outputs = collectFiles(outputRoot);
  if (!outputs.includes("index.js") || !outputs.includes("index.d.ts") || outputs.some((name) => !/\.(?:js|d\.ts)$/u.test(name))) throw new SdkReleaseError("Node contract の生成物closureが不正です");
  for (const name of outputs) {
    const text = readFileSync(path.join(outputRoot, name), "utf8");
    if (/sourceMappingURL/u.test(text) || (/\.js$/u.test(name) && ts.preProcessFile(text, true, true).importedFiles.some(({ fileName }) => fileName.startsWith(".") && !fileName.endsWith(".js")))) throw new SdkReleaseError("Node contract のESM specifier/source mapが不正です");
  }
  const manifest = packageManifest(definition, {}, config);
  put(stage, "package.json", jsonBytes(manifest));
  for (const [name, bytes] of Object.entries(rootNotices)) put(stage, name, bytes);
  auditTypeScriptClosure(stage, manifest);
  return manifest;
}

function collectFiles(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? collectFiles(path.join(root, entry.name), relative) : [relative];
  }).sort();
}

export function validateRuntimeAssets({ assetDirectory, engine, expectedSource }) {
  if (!path.isAbsolute(assetDirectory)) throw new SdkReleaseError("engine asset 入力は絶対 path で指定してください");
  let directoryStat;
  try {
    directoryStat = lstatSync(assetDirectory);
  } catch {
    throw new SdkReleaseError(`engine runtime asset がありません: ${engine.manifestName}`);
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new SdkReleaseError("engine asset directory は通常の directory が必要です");
  const manifestPath = path.join(assetDirectory, engine.manifestName);
  let manifestBytes;
  try {
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    manifestBytes = readFileSync(manifestPath);
  } catch {
    throw new SdkReleaseError(`engine runtime manifest がありません: ${engine.manifestName}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new SdkReleaseError("engine runtime manifest が JSON ではありません");
  }
  if (manifest.engine !== engine.version || manifest.version !== engine.crateVersion || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new SdkReleaseError("engine runtime manifest の pin が release-set と一致しません");
  if (
    !expectedSource ||
    manifest.source?.repository !== "niho-life/niho-photo" ||
    manifest.source?.commit !== expectedSource.commit ||
    manifest.source?.tree !== expectedSource.tree ||
    manifest.build?.rustToolchain !== "1.98.1" ||
    manifest.build?.wasmBindgen !== "0.2.129" ||
    manifest.build?.target !== "wasm32-unknown-unknown" ||
    manifest.build?.profile !== "release"
  ) throw new SdkReleaseError("engine runtime の build provenance が selected source と一致しません");
  const names = Object.keys(manifest.files).sort();
  if (!names.length || !engine.requiredExtensions.every((extension) => names.some((name) => name.endsWith(extension)))) throw new SdkReleaseError("engine runtime dependency closure が不足しています");
  const files = names.map((name) => readRuntimeAsset(assetDirectory, name, manifest.files[name]));
  // スレッドの版（#151）は `threads` に分けて書く。`files`（1 本）は古い画面の読み方（.js と .wasm がちょうど 1 つずつ）のまま。
  const threads = manifest.threads;
  if (!threads || typeof threads !== "object" || Array.isArray(threads) || !threads.files || typeof threads.files !== "object" || Array.isArray(threads.files)) throw new SdkReleaseError("engine runtime manifest にスレッドの版がありません");
  if (JSON.stringify(threads.build) !== JSON.stringify(THREADS_BUILD)) throw new SdkReleaseError("スレッドの版の build 指定が固定値と一致しません");
  const threadsNames = Object.keys(threads.files).sort();
  const expectedThreadsNames = Object.values(threadsRuntimeFileNames(engine.crateVersion)).sort();
  if (JSON.stringify(threadsNames) !== JSON.stringify(expectedThreadsNames) || threadsNames.some((name) => names.includes(name))) throw new SdkReleaseError("スレッドの版の file 集合が不正です");
  const threadsFiles = threadsNames.map((name) => readRuntimeAsset(assetDirectory, name, threads.files[name]));
  return { manifest, manifestBytes, files, threadsFiles };
}

function readRuntimeAsset(assetDirectory, name, expected) {
  if (!SIMPLE_ASSET.test(name) || name.includes("..")) throw new SdkReleaseError("engine runtime manifest に不正な path があります");
  if (!expected || !SHA256.test(expected.sha256 ?? "") || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0) throw new SdkReleaseError("engine runtime manifest の file metadata が不正です");
  const full = path.join(assetDirectory, name);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    throw new SdkReleaseError(`engine runtime dependency がありません: ${name}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new SdkReleaseError("engine runtime の symlink / 特殊ファイルは禁止です");
  const bytes = readFileSync(full);
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new SdkReleaseError(`engine runtime asset の hash が一致しません: ${name}`);
  assertPublicBytes(bytes);
  return { name, bytes, sha256: expected.sha256, integrity: sri(bytes), size: bytes.length };
}

function stageRuntimePackage({ stage, config, runtime, rootNotices, engineNotices }) {
  const manifest = {
    name: config.engine.runtimePackageName,
    version: config.version,
    type: "module",
    description: "NIHO photo develop engine immutable wasm runtime",
    license: "UNLICENSED",
    files: ["develop-engine", ...ROOT_NOTICE_FILES, ...ENGINE_NOTICE_FILES],
    exports: {
      "./manifest": `./develop-engine/${config.engine.version}/${config.engine.manifestName}`,
      "./*": `./develop-engine/${config.engine.version}/*`,
    },
    engines: { node: "24.x" },
  };
  put(stage, "package.json", jsonBytes(manifest));
  for (const [name, bytes] of Object.entries(rootNotices)) put(stage, name, bytes);
  for (const [name, bytes] of Object.entries(engineNotices)) put(stage, name, bytes);
  const prefix = `develop-engine/${config.engine.version}`;
  put(stage, `${prefix}/${config.engine.manifestName}`, runtime.manifestBytes);
  for (const file of [...runtime.files, ...runtime.threadsFiles]) put(stage, `${prefix}/${file.name}`, file.bytes);
  return manifest;
}

function tarEntries(tarball) {
  let output;
  try {
    output = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    throw new SdkReleaseError("tarball を検査できません");
  }
  const entries = output.split("\n").filter(Boolean);
  if (!entries.length) throw new SdkReleaseError("空の tarball は許可されません");
  for (const entry of entries) {
    if (!entry.startsWith("package/") || entry.startsWith("/") || entry.includes("\\") || entry.split("/").some((part) => part === "..")) throw new SdkReleaseError("tarball に path traversal があります");
  }
  return entries;
}

function npmPackDeterministic(stage, scratch) {
  const destinations = [mkdtempSync(path.join(scratch, "pack-a-")), mkdtempSync(path.join(scratch, "pack-b-"))];
  const npmCache = path.join(scratch, "npm-cache");
  mkdirSync(npmCache, { recursive: true, mode: 0o700 });
  const outputs = [];
  for (const destination of destinations) {
    let result;
    try {
      result = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", destination, "."], {
        cwd: stage,
        encoding: "utf8",
        env: { ...process.env, TZ: "UTC", SOURCE_DATE_EPOCH: "0", npm_config_cache: npmCache, npm_config_update_notifier: "false" },
        maxBuffer: 64 * 1024 * 1024,
      }));
    } catch {
      throw new SdkReleaseError("npm pack に失敗しました");
    }
    if (!Array.isArray(result) || result.length !== 1 || !SIMPLE_ASSET.test(result[0].filename ?? "")) throw new SdkReleaseError("npm pack の出力が不正です");
    const tarball = path.join(destination, result[0].filename);
    tarEntries(tarball);
    outputs.push(tarball);
  }
  const first = readFileSync(outputs[0]);
  const second = readFileSync(outputs[1]);
  if (!first.equals(second)) throw new SdkReleaseError("npm package tarball が決定的ではありません");
  return { filename: path.basename(outputs[0]), bytes: first, entries: tarEntries(outputs[0]) };
}

function sourceRecords(repoRoot, commit, paths) {
  return paths.map((file) => {
    const bytes = gitBytes(repoRoot, commit, file);
    return { path: file, sha256: sha256(bytes), integrity: sri(bytes), size: bytes.length };
  });
}

function ownershipDigest(records) {
  return sha256(Buffer.from(records.map(({ path: ownedPath, sha256: digest, files }) => `${ownedPath}\0${digest}\0${files}\n`).join("")));
}

function ownedSourceRecords(repoRoot, commit, paths) {
  const records = paths.map((ownedPath) => {
    const entries = treeEntries(repoRoot, commit, ownedPath).sort((left, right) => left.file.localeCompare(right.file, "en"));
    const digest = createHash("sha256");
    for (const entry of entries) {
      const bytes = gitBytes(repoRoot, commit, entry.file);
      digest.update(`${entry.mode}\0${entry.file}\0${bytes.length}\0`);
      digest.update(bytes);
      digest.update("\0");
    }
    return { path: ownedPath, sha256: digest.digest("hex"), files: entries.length };
  });
  return { algorithm: "sha256-git-file-set-v1", digest: ownershipDigest(records), paths: records };
}

function verifyEnginePins(repoRoot, commit, config) {
  const client = gitBytes(repoRoot, commit, "packages/photo-editing/src/develop-engine/develop-engine-manifest.ts").toString("utf8");
  const engineVersion = /export const DEVELOP_ENGINE_VERSION = "([^"]+)";/.exec(client)?.[1];
  const crateVersion = /export const DEVELOP_ENGINE_CRATE_VERSION = "([^"]+)";/.exec(client)?.[1];
  const cargo = gitBytes(repoRoot, commit, "packages/develop-engine/Cargo.toml").toString("utf8");
  const workspaceVersion = /\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m.exec(cargo)?.[1];
  if (engineVersion !== config.engine.version || crateVersion !== config.engine.crateVersion || workspaceVersion !== config.engine.crateVersion) throw new SdkReleaseError("editor / engine source / release-set の version pin が一致しません");
}

function recipeCompatibility(repoRoot, commit) {
  const source = gitBytes(repoRoot, commit, "packages/photo-editing/src/develop-engine/develop-settings.ts").toString("utf8");
  const versionsText = /export type DevelopSettingsVersion = ([^;]+);/.exec(source)?.[1];
  const versions = [...new Set((versionsText?.match(/\b\d+\b/g) ?? []).map(Number))].sort((a, b) => a - b);
  const engines = [...source.matchAll(/export const [A-Z0-9_]*DEVELOP_SETTINGS_ENGINE = "(niho-\d+)";/g)]
    .map((match) => match[1])
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  if (JSON.stringify(versions) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]) || !engines.includes("niho-13")) throw new SdkReleaseError("recipe compatibility を source から確定できません");
  return {
    format: "javascript-esm-with-declarations",
    supportedVersions: versions,
    engineIdentifiers: engines,
    nodeRuntimeValidator: true,
    package: "niho-photo-contract",
    export: ".",
  };
}

export async function packReleaseSet({ repoRoot, configPath = "sdk/release-set.json", outputDirectory, sourceRef = "HEAD", assetDirectory } = {}) {
  if (!repoRoot || !path.isAbsolute(repoRoot)) throw new SdkReleaseError("repoRoot は絶対 path が必要です");
  assertRelativePath(configPath, "config path");
  if (!outputDirectory || !path.isAbsolute(outputDirectory)) throw new SdkReleaseError("output は絶対 path が必要です");
  try {
    lstatSync(outputDirectory);
    throw new SdkReleaseError("既存の SDK output は上書きできません");
  } catch (error) {
    if (error instanceof SdkReleaseError) throw error;
    if (error?.code !== "ENOENT") throw new SdkReleaseError("SDK output を確認できません");
  }
  const { commit, tree } = resolveSource(repoRoot, sourceRef);
  const config = validateConfig(JSON.parse(gitBytes(repoRoot, commit, configPath).toString("utf8")));
  verifyEnginePins(repoRoot, commit, config);
  const assets = path.resolve(assetDirectory ?? path.join(repoRoot, config.engine.assetDirectory));
  const runtime = validateRuntimeAssets({ assetDirectory: assets, engine: config.engine, expectedSource: { commit, tree } });
  const rootNotices = Object.fromEntries(ROOT_NOTICE_FILES.map((name) => [name, gitBytes(repoRoot, commit, name)]));
  const engineNotices = Object.fromEntries(ENGINE_NOTICE_FILES.map((name) => [name, gitBytes(repoRoot, commit, `packages/develop-engine/${name}`)]));
  const recipe = recipeCompatibility(repoRoot, commit);
  const scratch = mkdtempSync(path.join(tmpdir(), "niho-photo-sdk-pack-"));
  try {
    const packages = [];
    const staged = new Map();
    for (const definition of config.packages) {
      const stage = path.join(scratch, `stage-${definition.id}`);
      mkdirSync(stage, { mode: 0o755 });
      const manifest = definition.kind === "node-contract"
        ? stageNodeContractPackage({ repoRoot, commit, config, definition, stage, rootNotices, recipe })
        : stageSourcePackage({ repoRoot, commit, config, definition, stage, rootNotices });
      staged.set(definition.id, { definition, stage, manifest });
    }
    for (const id of ["cloud-contract", "ui", "photo-editing"]) {
      const item = staged.get(id);
      emitSourceDeclarations({ repoRoot, ...item, sourceStages: staged });
    }
    rmSync(path.join(scratch, "node_modules"), { recursive: true, force: true });
    for (const definition of config.packages) {
      const { stage } = staged.get(definition.id);
      await guardBundle(stage, [repoRoot]);
      const packed = npmPackDeterministic(stage, scratch);
      packages.push({ id: definition.id, name: definition.name, ...packed });
    }
    const runtimeStage = path.join(scratch, "stage-develop-engine-runtime");
    mkdirSync(runtimeStage, { mode: 0o755 });
    stageRuntimePackage({ stage: runtimeStage, config, runtime, rootNotices, engineNotices });
    await guardBundle(runtimeStage, [repoRoot]);
    const packedRuntime = npmPackDeterministic(runtimeStage, scratch);
    packages.push({ id: "develop-engine-runtime", name: config.engine.runtimePackageName, ...packedRuntime });

    const manifestName = `niho-photo-sdk-${config.version}-${commit}.json`;
    const manifest = {
      schemaVersion: 1,
      releaseReady: true,
      repository: config.repository,
      version: config.version,
      source: { commit, tree },
      sourceOwnership: ownedSourceRecords(repoRoot, commit, config.ownedSourcePaths),
      buildTooling: { node: "24.x", files: sourceRecords(repoRoot, commit, config.buildToolingPaths) },
      packages: packages.map(({ id, name, filename, bytes }) => ({ id, name, file: filename, sha256: sha256(bytes), integrity: sri(bytes), size: bytes.length })),
      engine: {
        version: config.engine.version,
        crateVersion: config.engine.crateVersion,
        manifest: {
          file: config.engine.manifestName,
          sha256: sha256(runtime.manifestBytes),
          integrity: sri(runtime.manifestBytes),
          size: runtime.manifestBytes.length,
        },
        runtimeFiles: runtime.files.map(({ name, sha256: hash, integrity, size }) => ({ name, sha256: hash, integrity, size })),
        // スレッドの版（#151）。Mac の candidate は `runtimeFiles`（1 本）だけを同梱する。
        threads: { runtimeFiles: runtime.threadsFiles.map(({ name, sha256: hash, integrity, size }) => ({ name, sha256: hash, integrity, size })) },
        contracts: sourceRecords(repoRoot, commit, config.engine.contractPaths),
        buildInputs: sourceRecords(repoRoot, commit, config.engine.buildInputs),
      },
      recipeCompatibility: recipe,
      uiSingleton: {
        package: "niho-photo-ui",
        hostExport: "niho-photo-editing/sdk-dialog-host",
        requirement: "Render PhotoEditingDialogHost from this export so editor dialogs and the host share one appDialog store instance.",
      },
    };
    const manifestBytes = jsonBytes(manifest);
    assertPublicBytes(manifestBytes);
    mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
    for (const item of packages) writeFileSync(path.join(outputDirectory, item.filename), item.bytes, { flag: "wx", mode: 0o644 });
    writeFileSync(path.join(outputDirectory, manifestName), manifestBytes, { flag: "wx", mode: 0o644 });
    return { manifest, manifestName, outputDirectory };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function verifyReleaseManifestFiles(manifestPath) {
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new SdkReleaseError("SDK release manifest は通常ファイルが必要です");
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { throw new SdkReleaseError("SDK release manifest がJSONではありません"); }
  validateReleaseManifest(manifest, manifest.source?.commit);
  verifyManifestPackageFiles({ manifest, directory: path.dirname(manifestPath) });
  return manifest;
}
