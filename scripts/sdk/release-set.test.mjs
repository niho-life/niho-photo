import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import ts from "typescript";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertRelativePath,
  assertStrictSemver,
  auditTypeScriptClosure,
  matchesPackagePath,
  packReleaseSet,
  sha256,
  THREADS_BUILD,
  threadsRuntimeFileNames,
  validateConfig,
  validateRuntimeAssets,
  verifyReleaseManifestFiles,
} from "./release-set-lib.mjs";
import { smokeConsumer } from "./smoke-consumer.mjs";
import {
  rewriteThreadsRuntimeReferences,
  rewriteVersionedRuntimeReferences,
  runtimeBuildEnvironment,
  SKY_MODEL_SOURCES,
  skyModelFileName,
  threadsRuntimeBuildEnvironment,
  versionedRuntimeFileName,
  versionedThreadsRuntimeFileName,
  wasmMemoryImports,
} from "./build-develop-engine-runtime.mjs";
import { normalizeArtifactDigest, validateReleaseManifest, verifyReleaseArtifact } from "./verify-release-artifact.mjs";
import { nativeBuildEnvironment, swiftSourcePrefixArguments, validateNativeSourceClosure } from "../../packages/develop-engine/build-macos-native.mjs";

const realRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = [];

function temp(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runGit(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function put(root, relative, bytes) {
  const target = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function commit(root, message) {
  runGit(root, ["add", "--all"]);
  runGit(root, ["-c", "user.name=SDK test", "-c", "user.email=sdk-test@invalid.example", "commit", "-m", message]);
}

function runtimeFixture(root, config, source = { commit: "a".repeat(40), tree: "b".repeat(40) }) {
  const directory = path.join(root, ...config.engine.assetDirectory.split("/"));
  mkdirSync(directory, { recursive: true });
  const values = {
    [`niho_develop_wasm-${config.engine.crateVersion}.js`]: "export default async function init() {}\nexport class Developer {}\n",
    [`niho_develop_wasm_bg-${config.engine.crateVersion}.wasm`]: Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    [`niho_develop_wasm-${config.engine.crateVersion}.d.ts`]: "export default function init(input?: unknown): Promise<unknown>;\n",
  };
  const threadsNames = threadsRuntimeFileNames(config.engine.crateVersion);
  const threadsValues = {
    [threadsNames.js]: `import { startWorkers } from "./${threadsNames.worker}";\nexport default async function init() {}\nexport function initThreadPool() {}\n`,
    [threadsNames.dts]: "export function initThreadPool(num_threads: number): Promise<any>;\n",
    [threadsNames.wasm]: Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x02]),
    [threadsNames.wasmDts]: "export const memory: WebAssembly.Memory;\n",
    [threadsNames.worker]: `export async function startWorkers() { await import("./${threadsNames.js}"); }\n`,
  };
  const records = (entries) => Object.fromEntries(Object.entries(entries).map(([name, value]) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return [name, { sha256: sha256(bytes), bytes: bytes.length }];
  }));
  const manifest = {
    schemaVersion: 1,
    engine: config.engine.version,
    version: config.engine.crateVersion,
    source: { repository: config.repository ?? "niho-life/niho-photo", ...source },
    build: { rustToolchain: "1.98.1", wasmBindgen: "0.2.129", target: "wasm32-unknown-unknown", profile: "release" },
    files: records(values),
    threads: { files: records(threadsValues), build: { ...THREADS_BUILD } },
  };
  put(directory, config.engine.manifestName, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, value] of Object.entries({ ...values, ...threadsValues })) put(directory, name, value);
  return directory;
}

function createFixture() {
  const root = temp("niho-photo-sdk-repo-");
  const config = JSON.parse(readFileSync(path.join(realRoot, "sdk/release-set.json"), "utf8"));
  config.version = "0.1.0+001";
  runGit(root, ["init", "--quiet"]);
  for (const name of ["package.json", "package-lock.json"]) put(root, name, readFileSync(path.join(realRoot, name)));
  for (const name of ["LICENSE.md", "ASSET_LICENSE.md", "TRADEMARKS.md", "THIRD_PARTY_NOTICES.md"]) put(root, name, readFileSync(path.join(realRoot, name)));
  put(root, "sdk/release-set.json", `${JSON.stringify(config, null, 2)}\n`);
  for (const definition of config.packages) {
    const names = runGit(realRoot, ["ls-files", "-co", "--exclude-standard", "--", definition.sourceRoot]).trim().split("\n").filter(Boolean);
    for (const name of names) {
      const relative = name.slice(definition.sourceRoot.length + 1);
      if (matchesPackagePath(relative, definition)) put(root, name, readFileSync(path.join(realRoot, name)));
    }
  }
  for (const name of config.ownedSourcePaths.filter((value) => value.startsWith("scripts/ci/"))) put(root, name, readFileSync(path.join(realRoot, name)));
  put(root, "packages/desktop-photo/ownership-fixture.txt", "owned\n");
  put(root, "scripts/sdk/ownership-fixture.mjs", "export {};\n");
  commit(root, "fixture");
  const source = { commit: runGit(root, ["rev-parse", "HEAD"]).trim(), tree: runGit(root, ["rev-parse", "HEAD^{tree}"]).trim() };
  const assets = runtimeFixture(temp("niho-photo-sdk-runtime-"), { engine: { ...config.engine, assetDirectory: "assets" } }, source);
  return { root, config, assets, source };
}

test("strict semver と安全な相対 path だけを受け入れる", () => {
  assert.equal(assertStrictSemver("1.2.3-beta.1+build.5"), "1.2.3-beta.1+build.5");
  assert.equal(assertStrictSemver("1.2.3+001"), "1.2.3+001");
  for (const value of ["v1.2.3", "1.2", "01.2.3", "1.2.3-01"]) assert.throws(() => assertStrictSemver(value));
  assert.equal(assertRelativePath("packages/photo-editing"), "packages/photo-editing");
  for (const value of ["../private", "/tmp/source", "a/../../b", "a\\b"]) assert.throws(() => assertRelativePath(value));
});

test("Actions/REST artifact digestをcanonical SHA-256へ揃える", () => {
  const digest = "d".repeat(64);
  assert.equal(normalizeArtifactDigest(digest), `sha256:${digest}`);
  assert.equal(normalizeArtifactDigest(`sha256:${digest}`), `sha256:${digest}`);
  assert.throws(() => normalizeArtifactDigest("sha256:broken"));
});

test("空の検出のモデルは repo の層の見出しと重みを版つきの名前で runtime に足す", () => {
  assert.equal(skyModelFileName(".json", "0.27.0"), "niho_sky_model-0.27.0.json");
  assert.equal(skyModelFileName(".f32", "0.27.0"), "niho_sky_model-0.27.0.f32");
  // 画面の manifest の読み方（develop-engine-manifest.ts）と同じ名前
  const manifestSource = readFileSync(path.join(realRoot, "packages/photo-editing/src/develop-engine/develop-engine-manifest.ts"), "utf8");
  assert.match(manifestSource, /niho_sky_model-\$\{DEVELOP_ENGINE_CRATE_VERSION\}\.json/);
  assert.match(manifestSource, /niho_sky_model-\$\{DEVELOP_ENGINE_CRATE_VERSION\}\.f32/);
  for (const [source] of SKY_MODEL_SOURCES) assert.ok(statSync(path.join(realRoot, source)).isFile(), source);
  const layout = JSON.parse(readFileSync(path.join(realRoot, SKY_MODEL_SOURCES[0][0]), "utf8"));
  assert.equal(statSync(path.join(realRoot, SKY_MODEL_SOURCES[1][0])).size, layout.floats * 4);
});

test("wasm-bindgen の出力名と JS/d.ts 内部参照を同じ crate version へ固定する", () => {
  assert.equal(versionedRuntimeFileName("niho_develop_wasm_bg.wasm", "0.25.0"), "niho_develop_wasm_bg-0.25.0.wasm");
  assert.equal(versionedRuntimeFileName("niho_develop_wasm.js", "0.25.0"), "niho_develop_wasm-0.25.0.js");
  const source = Buffer.from('new URL("niho_develop_wasm_bg.wasm", import.meta.url); import("./niho_develop_wasm.js");\n');
  const rewritten = rewriteVersionedRuntimeReferences("niho_develop_wasm.js", source, "0.25.0").toString("utf8");
  assert.match(rewritten, /niho_develop_wasm_bg-0\.25\.0\.wasm/);
  assert.match(rewritten, /niho_develop_wasm-0\.25\.0\.js/);
  assert.doesNotMatch(rewritten, /niho_develop_wasm_bg\.wasm/);
  assert.equal(rewriteVersionedRuntimeReferences("niho_develop_wasm_bg.wasm", Buffer.from("bytes"), "0.25.0").toString(), "bytes");
});

test("スレッドの版の helper と glue の参照を平らな版つきのファイルへ書き換える", () => {
  const names = threadsRuntimeFileNames("0.26.0");
  const helperPath = "snippets/wasm-bindgen-rayon-38edf6e439f6d70d/src/workerHelpers.js";
  assert.equal(versionedThreadsRuntimeFileName(helperPath, "0.26.0"), names.worker);
  assert.equal(versionedThreadsRuntimeFileName("niho_develop_wasm_threads.js", "0.26.0"), names.js);
  assert.equal(versionedThreadsRuntimeFileName("niho_develop_wasm_threads_bg.wasm", "0.26.0"), names.wasm);
  assert.equal(versionedThreadsRuntimeFileName("niho_develop_wasm_threads_bg.wasm.d.ts", "0.26.0"), names.wasmDts);
  assert.equal(versionedThreadsRuntimeFileName("snippets/other/src/x.js", "0.26.0"), undefined);
  const glue = [
    "import { startWorkers } from './snippets/wasm-bindgen-rayon-38edf6e439f6d70d/src/workerHelpers.js';",
    'const imports = { "./niho_develop_wasm_threads_bg.js": import0 };',
    "module_or_path = new URL('niho_develop_wasm_threads_bg.wasm', import.meta.url);",
  ].join("\n");
  const rewrittenGlue = rewriteThreadsRuntimeReferences("niho_develop_wasm_threads.js", Buffer.from(glue), "0.26.0").toString();
  assert.ok(rewrittenGlue.includes(`from "./${names.worker}"`));
  assert.ok(rewrittenGlue.includes(`new URL('${names.wasm}'`));
  assert.ok(rewrittenGlue.includes('"./niho_develop_wasm_threads_bg.js": import0'));
  const helper = [
    "// resolve the main module via `../../..` (`[out-dir]/snippets/wasm-bindgen-rayon-[hash]/workerHelpers.js`)",
    "  // TODO: while `new URL('...', import.meta.url) becomes a semi-standard",
    "  const pkg = await import('../../..');",
    "      const worker = new Worker(new URL('./workerHelpers.js', import.meta.url), {",
  ].join("\n");
  const rewrittenHelper = rewriteThreadsRuntimeReferences(helperPath, Buffer.from(helper), "0.26.0").toString();
  assert.ok(rewrittenHelper.includes(`import("./${names.js}")`));
  assert.ok(rewrittenHelper.includes(`new URL("./${names.worker}", import.meta.url)`));
  assert.match(rewrittenHelper, /\/\/ resolve the main module via `\.\.\/\.\.\/\.\.`/u);
  assert.throws(() => rewriteThreadsRuntimeReferences(helperPath, Buffer.from("const pkg = await import('../../..');\n"), "0.26.0"), /helper から helper（0 件）/u);
  assert.throws(() => rewriteThreadsRuntimeReferences("niho_develop_wasm_threads.js", Buffer.from(`${glue}\n${glue.split("\n")[0]}`), "0.26.0"), /glue から helper（2 件）/u);
  assert.throws(() => rewriteThreadsRuntimeReferences("niho_develop_wasm_threads.js", Buffer.from(`${glue}\nimport("./snippets/other.js");`), "0.26.0"), /版の無い参照/u);
  assert.throws(() => rewriteThreadsRuntimeReferences("niho_develop_wasm_threads.js", Buffer.from(`${glue}\nimport("./elsewhere.js");`), "0.26.0"), /配布物の外/u);
  assert.equal(rewriteThreadsRuntimeReferences("niho_develop_wasm_threads_bg.wasm", Buffer.from("bytes"), "0.26.0").toString(), "bytes");
});

test("スレッドの wasm の共有メモリの import を読む", () => {
  const body = [0x01, 0x03, ...Buffer.from("wbg"), 0x06, ...Buffer.from("memory"), 0x02, 0x03, 0x11, 0x80, 0x80, 0x04];
  const module = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01, 0x78, 0x02, body.length, ...body]);
  assert.deepEqual(wasmMemoryImports(module), [{ module: "wbg", field: "memory", shared: true, initial: 17, maximum: 65536 }]);
  assert.equal(wasmMemoryImports(module)[0].maximum * 65536, THREADS_BUILD.maxMemory);
  assert.deepEqual(wasmMemoryImports(Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])), []);
  assert.throws(() => wasmMemoryImports(Buffer.from("not wasm")), /wasm/u);
});

test("スレッドの版は固定の 1.98.1 のまま共有メモリ・build-std で隔離して build する", () => {
  const scratch = { home: "/isolated/home", cargoHome: "/isolated/cargo", temporary: "/isolated/tmp", target: "/isolated/target", threadsTarget: "/isolated/target-threads" };
  const env = threadsRuntimeBuildEnvironment({ PATH: "/bin", HOME: "/synthetic/home", RUSTFLAGS: "unapproved", RUSTC_BOOTSTRAP: "0" }, scratch);
  const flags = env.CARGO_ENCODED_RUSTFLAGS.split("\x1f");
  assert.equal(env.RUSTUP_TOOLCHAIN, "1.98.1");
  assert.equal(env.RUSTC_BOOTSTRAP, "1");
  assert.equal(env.RUSTFLAGS, undefined);
  assert.equal(env.CARGO_TARGET_DIR, "/isolated/target-threads");
  assert.equal(env.HOME, "/isolated/home");
  for (const flag of ["target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128", "link-arg=--shared-memory", "link-arg=--import-memory", `link-arg=--max-memory=${THREADS_BUILD.maxMemory}`, "link-arg=--export=__wasm_init_tls", "link-arg=--export=__tls_size", "link-arg=--export=__tls_align", "link-arg=--export=__tls_base"]) assert.ok(flags.includes(flag), flag);
  for (const prefix of [realRoot, "/synthetic/home", "/isolated/cargo", "/synthetic/home/.rustup", "/isolated/tmp"]) assert.ok(flags.some((flag) => flag.startsWith(`--remap-path-prefix=${prefix}=`)), prefix);
  assert.equal(THREADS_BUILD.maxMemory, 4294967296);
  assert.throws(() => threadsRuntimeBuildEnvironment({ HOME: "/synthetic/home" }, { ...scratch, threadsTarget: "relative" }), /隔離/u);
});

test("engine runtime build は外部Cargo設定を捨てpathをremapする", () => {
  const env = runtimeBuildEnvironment({
    PATH: "/bin",
    HOME: "/synthetic/home",
    CARGO_HOME: "/synthetic/cargo",
    RUSTUP_HOME: "/synthetic/rustup",
    RUSTFLAGS: "unapproved",
    CARGO_TARGET_DIR: "/unapproved/target",
  }, { home: "/isolated/home", cargoHome: "/isolated/cargo", temporary: "/isolated/tmp", target: "/isolated/target" });
  assert.equal(env.HOME, "/isolated/home");
  assert.equal(env.CARGO_TARGET_DIR, "/isolated/target");
  assert.equal(env.RUSTFLAGS, undefined);
  assert.match(env.CARGO_ENCODED_RUSTFLAGS, /target-feature=\+simd128/);
  for (const prefix of [realRoot, "/synthetic/home", "/isolated/cargo", "/synthetic/rustup", "/isolated/tmp"]) assert.ok(env.CARGO_ENCODED_RUSTFLAGS.includes(`--remap-path-prefix=${prefix}=`));
  assert.equal(env.CARGO_ENCODED_RUSTFLAGS.includes("/synthetic/cargo"), false);
  const defaults = runtimeBuildEnvironment({ PATH: "/bin", HOME: "/default/home", CARGO_HOME: "/unapproved/cargo" }, { home: "/isolated/home", cargoHome: "/isolated/cargo", temporary: "/isolated/tmp", target: "/isolated/target" });
  assert.equal(defaults.CARGO_HOME, "/isolated/cargo");
  assert.equal(defaults.RUSTUP_HOME, "/default/home/.rustup");
  assert.ok(defaults.CARGO_ENCODED_RUSTFLAGS.includes("--remap-path-prefix=/default/home/.rustup=toolchain"));
  assert.throws(() => runtimeBuildEnvironment({ HOME: "/default/home" }, { home: "/isolated/home", cargoHome: "relative", temporary: "/isolated/tmp", target: "/isolated/target" }), /隔離/);
});

test("macOS native source closure は固定Rust・隔離環境・legacy calibration bytesを要求する", () => {
  const engineRoot = path.join(realRoot, "packages/develop-engine");
  assert.deepEqual(validateNativeSourceClosure(engineRoot), { rustToolchain: "1.98.1", target: "aarch64-apple-darwin" });
  const isolatedRoot = temp("niho-photo-native-env-");
  const env = nativeBuildEnvironment(
    {
      PATH: "/usr/bin:/bin",
      HOME: "/untrusted/home",
      CARGO_HOME: "/untrusted/cargo",
      RUSTFLAGS: "untrusted",
      RUSTUP_TOOLCHAIN: "nightly",
      TAURI_SIGNING_PRIVATE_KEY: "must-not-pass",
    },
    { engineRoot, isolatedRoot },
  );
  assert.equal(env.HOME, path.join(isolatedRoot, "home"));
  assert.equal(env.CARGO_HOME, path.join(isolatedRoot, "cargo-home"));
  assert.equal(env.RUSTUP_HOME, "/untrusted/home/.rustup");
  assert.equal(env.RUSTUP_TOOLCHAIN, "1.98.1");
  assert.equal(env.CARGO_BUILD_TARGET, "aarch64-apple-darwin");
  assert.equal(env.RUSTFLAGS, undefined);
  assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.match(env.CARGO_ENCODED_RUSTFLAGS, /engine-source/);
});

test("展開先のdirectoryがsymlinkでもnative CLIを実行する", () => {
  const alias = path.join(temp("niho-photo-native-cli-alias-"), "engine");
  symlinkSync(path.join(realRoot, "packages/develop-engine"), alias, "dir");
  // 必須引数を省略するため、Swift/Rust buildには進まない。
  const result = spawnSync(process.execPath, [path.join(alias, "build-macos-native.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--engine --lock --output/u);
});

test("release-set 定義は package/path/version の改変を拒否する", () => {
  const config = JSON.parse(readFileSync(path.join(realRoot, "sdk/release-set.json"), "utf8"));
  assert.equal(validateConfig(config), config);
  assert.throws(() => validateConfig({ ...config, repository: "niho-coliving/niho-photo" }), /基本契約/);
  assert.throws(() => validateConfig({ ...config, version: "latest" }), /semver/);
  const escaped = structuredClone(config);
  escaped.packages[0].sourceRoot = "../niho-app";
  assert.throws(() => validateConfig(escaped), /相対path/);
});

test("TypeScript dependency closure の欠落を拒否する", () => {
  const stage = temp("niho-photo-sdk-closure-");
  put(stage, "src/index.ts", 'import "./missing";\n');
  assert.throws(() => auditTypeScriptClosure(stage, { peerDependencies: {}, exports: { ".": "./src/index.ts" } }), /dependency closure/);
});

test("engine runtime の欠落・tamper・symlink を拒否する", () => {
  const root = temp("niho-photo-sdk-assets-");
  const config = JSON.parse(readFileSync(path.join(realRoot, "sdk/release-set.json"), "utf8"));
  const assets = runtimeFixture(root, { engine: { ...config.engine, assetDirectory: "assets" } });
  const expectedSource = { commit: "a".repeat(40), tree: "b".repeat(40) };
  const valid = validateRuntimeAssets({ assetDirectory: assets, engine: config.engine, expectedSource });
  assert.equal(valid.files.length, 3);
  assert.equal(valid.threadsFiles.length, 5);
  const manifestPath = path.join(assets, config.engine.manifestName);
  const original = readFileSync(manifestPath, "utf8");
  for (const [pattern, mutate] of [
    [/スレッドの版がありません/u, (value) => { delete value.threads; }],
    [/build 指定/u, (value) => { value.threads.build.maxMemory = 2 ** 31; }],
    [/build 指定/u, (value) => { value.threads.build.rustcBootstrap = false; }],
    [/file 集合/u, (value) => { value.threads.files["extra.js"] = value.threads.files[Object.keys(value.threads.files)[0]]; }],
    [/file 集合/u, (value) => { delete value.threads.files[threadsRuntimeFileNames(config.engine.crateVersion).worker]; }],
  ]) {
    const changed = JSON.parse(original);
    mutate(changed);
    writeFileSync(manifestPath, JSON.stringify(changed));
    assert.throws(() => validateRuntimeAssets({ assetDirectory: assets, engine: config.engine, expectedSource }), pattern);
  }
  writeFileSync(manifestPath, original);
  const threadsWorker = path.join(assets, threadsRuntimeFileNames(config.engine.crateVersion).worker);
  const workerBytes = readFileSync(threadsWorker);
  writeFileSync(threadsWorker, "tampered");
  assert.throws(() => validateRuntimeAssets({ assetDirectory: assets, engine: config.engine, expectedSource }), /hash/);
  writeFileSync(threadsWorker, workerBytes);
  assert.throws(() => validateRuntimeAssets({ assetDirectory: assets, engine: config.engine, expectedSource: { ...expectedSource, commit: "c".repeat(40) } }), /provenance/);
  const wasm = valid.files.find((file) => file.name.endsWith(".wasm"));
  writeFileSync(path.join(assets, wasm.name), "tampered");
  assert.throws(() => validateRuntimeAssets({ assetDirectory: assets, engine: config.engine, expectedSource }), /hash/);
  rmSync(path.join(assets, wasm.name));
  symlinkSync(path.join(assets, valid.files[0].name), path.join(assets, wasm.name));
  assert.throws(() => validateRuntimeAssets({ assetDirectory: assets, engine: config.engine, expectedSource }), /symlink/);
  assert.throws(() => validateRuntimeAssets({ assetDirectory: path.join(root, "missing"), engine: config.engine, expectedSource }), /ありません/);
});

test("clean Git object から決定的 tarball を作り repo 外 consumer で TS/Worker/CSS を bundle する", { timeout: 120_000 }, async () => {
  const fixture = createFixture();
  const first = path.join(temp("niho-photo-sdk-output-a-"), "release");
  const second = path.join(temp("niho-photo-sdk-output-b-"), "release");
  const one = await packReleaseSet({ repoRoot: fixture.root, outputDirectory: first, assetDirectory: fixture.assets });
  const two = await packReleaseSet({ repoRoot: fixture.root, outputDirectory: second, assetDirectory: fixture.assets });
  assert.deepEqual(one.manifest.packages, two.manifest.packages);
  assert.equal(one.manifest.releaseReady, true);
  assert.deepEqual(one.manifest.recipeCompatibility.supportedVersions, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(one.manifest.recipeCompatibility.engineIdentifiers.includes("niho-13"));
  assert.equal(one.manifest.recipeCompatibility.nodeRuntimeValidator, true);
  assert.equal(one.manifest.recipeCompatibility.package, "niho-photo-contract");
  assert.equal(one.manifest.sourceOwnership.paths.length, fixture.config.ownedSourcePaths.length);
  assert.equal(one.manifest.uiSingleton.hostExport, "niho-photo-editing/sdk-dialog-host");
  for (const item of one.manifest.packages) {
    const entries = execFileSync("tar", ["-tzf", path.join(first, item.file)], { encoding: "utf8" });
    for (const name of ["LICENSE.md", "ASSET_LICENSE.md", "TRADEMARKS.md", "THIRD_PARTY_NOTICES.md"]) assert.match(entries, new RegExp(`package/${name}`));
    if (["develop-engine-source", "develop-engine-runtime"].includes(item.id)) {
      assert.match(entries, /LICENSES\.md/);
      assert.match(entries, /Adobe-DNG-SDK-LICENSE\.txt/);
    }
    if (item.id === "develop-engine-source") {
      for (const required of [
        "package/engine/build-macos-native.mjs",
        "package/engine/calibration/apple-registry.json",
        "package/engine/calibration/apple-signed-registry.json",
        "package/engine/calibration/panasonic-dc-s5/apple-v1.json",
        "package/engine/calibration/panasonic-dc-s5/apple-v2.json",
        "package/engine/tools/apple-raw-linear/Package.swift",
        "package/engine/tools/apple-raw-linear/Tests/apple-raw-linearTests/WorkingCopyTests.swift",
        "package/engine/tools/apple-raw-linear/Tests/apple-raw-linearTests/Fixtures/calibration-illuminants.json",
        "package/engine/tools/niho-camera-cutout/Package.swift",
        "package/engine/tools/niho-camera-cutout/Tests/NihoCameraCutoutTests/CLITests.swift",
      ]) assert.match(entries, new RegExp(required.replaceAll(".", "\\.")));
      const extracted = temp("niho-photo-sdk-native-closure-");
      execFileSync("tar", ["-xzf", path.join(first, item.file), "-C", extracted]);
      validateNativeSourceClosure(path.join(extracted, "package/engine"));
      const inputs = JSON.parse(execFileSync("tar", ["-xOzf", path.join(first, item.file), "package/release-inputs.json"], { encoding: "utf8" }));
      assert.match(inputs.commands.wasm, /--config engine\/\.cargo\/config\.toml/u);
      assert.match(inputs.commands.wasmThreads, /^RUSTC_BOOTSTRAP=1 RUSTFLAGS="-C target-feature=\+atomics,\+bulk-memory,\+mutable-globals,\+simd128 .*--max-memory=4294967296.*" cargo build .*--features threads -Z build-std=panic_abort,std$/u);
    }
    if (item.id === "develop-engine-runtime") {
      const packageJson = JSON.parse(execFileSync("tar", ["-xOzf", path.join(first, item.file), "package/package.json"], { encoding: "utf8" }));
      assert.equal(packageJson.type, "module");
      for (const name of Object.values(threadsRuntimeFileNames(fixture.config.engine.crateVersion))) assert.ok(entries.includes(`package/develop-engine/${fixture.config.engine.version}/${name}`), name);
    }
  }
  const manifestPath = path.join(first, one.manifestName);
  assert.deepEqual(verifyReleaseManifestFiles(manifestPath).packages, one.manifest.packages);
  // Mac の candidate が同梱する runtimeFiles は 1 本だけ。スレッドの版は threads に分ける。
  assert.equal(one.manifest.engine.runtimeFiles.length, 3);
  assert.ok(one.manifest.engine.runtimeFiles.every(({ name }) => !name.includes("threads")));
  assert.deepEqual(one.manifest.engine.threads.runtimeFiles.map(({ name }) => name).sort(), Object.values(threadsRuntimeFileNames(fixture.config.engine.crateVersion)).sort());
  const beforeThreads = structuredClone(one.manifest);
  delete beforeThreads.engine.threads;
  assert.equal(validateReleaseManifest(beforeThreads, fixture.source.commit).engine.threads, undefined);
  const historicalManifest = structuredClone(one.manifest);
  historicalManifest.repository = "niho-coliving/niho-photo";
  assert.equal(validateReleaseManifest(historicalManifest, fixture.source.commit).repository, "niho-coliving/niho-photo");
  const manifestSha256 = sha256(readFileSync(manifestPath));
  assert.equal(verifyReleaseArtifact({ directory: first, expectedSource: fixture.source.commit, expectedManifestSha256: manifestSha256 }).manifestSha256, manifestSha256);
  assert.throws(() => verifyReleaseArtifact({ directory: first, expectedSource: fixture.source.commit, expectedManifestSha256: "f".repeat(64) }), /輸送hash/);
  const verifierSource = readFileSync(path.join(realRoot, "scripts/sdk/verify-release-artifact.mjs"), "utf8");
  assert.deepEqual([...verifierSource.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]).filter((name) => !name.startsWith("node:")), []);
  const receiptPath = path.join(temp("niho-photo-sdk-receipt-"), "receipt.json");
  execFileSync(process.execPath, [
    path.join(realRoot, "scripts/sdk/verify-release-artifact.mjs"),
    "--directory", first,
    "--expected-source", fixture.source.commit,
    "--expected-manifest-sha256", manifestSha256,
    "--receipt", receiptPath,
    "--artifact-id", "123",
    "--artifact-digest", "d".repeat(64),
    "--artifact-name", `niho-photo-sdk-${fixture.source.commit}-run-456-attempt-1`,
    "--run-id", "456",
    "--run-attempt", "1",
  ]);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.releaseManifest.sha256, manifestSha256);
  assert.equal(receipt.sourceOwnershipDigest, one.manifest.sourceOwnership.digest);
  assert.equal(receipt.artifact.digest, `sha256:${"d".repeat(64)}`);
  const secondManifestPath = path.join(second, two.manifestName);
  verifyReleaseArtifact({ directory: second, expectedSource: fixture.source.commit, expectedManifestSha256: sha256(readFileSync(secondManifestPath)) });
  writeFileSync(path.join(second, "unlisted.tgz"), "unexpected");
  assert.throws(() => verifyReleaseArtifact({ directory: second, expectedSource: fixture.source.commit }), /集合/);
  for (const [name, mutate] of [
    ["empty-packages", (value) => { value.packages = []; }],
    ["wrong-repository", (value) => { value.repository = "other/repository"; }],
    ["short-tree", (value) => { value.source.tree = "abc"; }],
    ["duplicate-package", (value) => { value.packages[1] = { ...value.packages[0] }; }],
    ["bad-integrity", (value) => { value.packages[0].integrity = "sha256-invalid"; }],
    ["missing-recipe", (value) => { delete value.recipeCompatibility; }],
    ["missing-ui-singleton", (value) => { delete value.uiSingleton; }],
    ["missing-owned-source", (value) => { delete value.sourceOwnership; }],
    ["changed-owned-source", (value) => { value.sourceOwnership.paths[0].sha256 = "c".repeat(64); }],
    ["node-contract-disabled", (value) => { value.recipeCompatibility.nodeRuntimeValidator = false; }],
    ["threads-empty", (value) => { value.engine.threads.runtimeFiles = []; }],
    ["threads-null", (value) => { value.engine.threads = null; }],
    ["threads-duplicate-single", (value) => { value.engine.threads.runtimeFiles[0] = { ...value.engine.runtimeFiles[0] }; }],
    ["threads-bad-integrity", (value) => { value.engine.threads.runtimeFiles[0].integrity = "sha256-invalid"; }],
    ["threads-extra-key", (value) => { value.engine.threads.files = {}; }],
  ]) {
    const changed = structuredClone(one.manifest);
    mutate(changed);
    const changedPath = path.join(first, `${name}.json`);
    writeFileSync(changedPath, `${JSON.stringify(changed)}\n`);
    assert.throws(() => verifyReleaseManifestFiles(changedPath));
  }
  const linkedManifest = path.join(temp("niho-photo-sdk-manifest-link-"), "release.json");
  symlinkSync(manifestPath, linkedManifest);
  assert.throws(() => verifyReleaseManifestFiles(linkedManifest), /通常ファイル/);
  const linkedPackages = temp("niho-photo-sdk-package-links-");
  writeFileSync(path.join(linkedPackages, "release.json"), `${JSON.stringify(one.manifest)}\n`);
  for (const item of one.manifest.packages) symlinkSync(path.join(first, item.file), path.join(linkedPackages, item.file));
  assert.throws(() => verifyReleaseManifestFiles(path.join(linkedPackages, "release.json")), /通常ファイル/);
  const smoke = smokeConsumer(manifestPath);
  assert.ok(smoke.files.some((file) => file.endsWith(".css")));
  assert.ok(smoke.files.filter((file) => file.endsWith(".js")).length >= 2);
  await assert.rejects(packReleaseSet({ repoRoot: fixture.root, outputDirectory: first, assetDirectory: fixture.assets }), /上書き/);
  await assert.rejects(packReleaseSet({ repoRoot: fixture.root, outputDirectory: path.join(temp("niho-photo-sdk-option-"), "release"), assetDirectory: fixture.assets, sourceRef: "--help" }), /HEAD または full commit SHA/);

  const link = path.join(fixture.root, "packages/photo-editing/src/escape.ts");
  symlinkSync("../../../../LICENSE.md", link);
  commit(fixture.root, "tracked symlink");
  const linkedSource = { commit: runGit(fixture.root, ["rev-parse", "HEAD"]).trim(), tree: runGit(fixture.root, ["rev-parse", "HEAD^{tree}"]).trim() };
  rmSync(fixture.assets, { recursive: true, force: true });
  const linkedAssets = runtimeFixture(path.dirname(fixture.assets), { engine: { ...fixture.config.engine, assetDirectory: path.basename(fixture.assets) } }, linkedSource);
  await assert.rejects(packReleaseSet({ repoRoot: fixture.root, outputDirectory: path.join(temp("niho-photo-sdk-symlink-"), "release"), assetDirectory: linkedAssets }), /symlink/);

  writeFileSync(path.join(fixture.root, "untracked.txt"), "dirty");
  await assert.rejects(packReleaseSet({ repoRoot: fixture.root, outputDirectory: path.join(temp("niho-photo-sdk-dirty-"), "release"), assetDirectory: linkedAssets }), /clean working tree/);
});


test("SDK ownershipはgeneratorとguardの相対import closureを含む", () => {
  const config = JSON.parse(readFileSync(path.join(realRoot, "sdk/release-set.json"), "utf8"));
  const seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    assert.ok(config.ownedSourcePaths.some((owned) => file === owned || file.startsWith(`${owned}/`)), `SDK ownershipにgenerator/guardがありません: ${file}`);
    const imports = ts.preProcessFile(readFileSync(path.join(realRoot, file), "utf8"), true, true).importedFiles;
    for (const { fileName } of imports) if (fileName.startsWith(".")) visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), fileName)));
  }
  visit("scripts/sdk/release-set-lib.mjs");
});

test("nativeのRust/Swift prefix mapは別名pathと実pathを両方扱う", () => {
  const isolated = temp("native-prefix-real-");
  const alias = path.join(temp("native-prefix-alias-"), "engine");
  symlinkSync(path.join(realRoot, "packages/develop-engine"), alias, "dir");
  const env = nativeBuildEnvironment({ PATH: "/usr/bin", HOME: "/build-user" }, { engineRoot: alias, isolatedRoot: isolated });
  assert.ok(env.CARGO_ENCODED_RUSTFLAGS.includes(`${alias}=engine-source`));
  assert.ok(env.CARGO_ENCODED_RUSTFLAGS.includes(`${path.join(realRoot, "packages/develop-engine")}=engine-source`));
  const args = swiftSourcePrefixArguments(alias, isolated);
  assert.ok(args.includes("-file-prefix-map"));
  assert.ok(args.includes("-debug-prefix-map"));
  assert.ok(args.includes(`${alias}=engine-source`));
  assert.ok(args.includes(`${path.join(realRoot, "packages/develop-engine")}=engine-source`));
});
