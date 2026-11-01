#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SdkReleaseError, THREADS_BUILD, assertRelativePath, threadsRuntimeFileNames, threadsRustflags, validateConfig } from "./release-set-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// スレッドの wasm（#151）の wasm-bindgen の出力名と、wasm-bindgen-rayon の Worker の helper（wasm-bindgen が snippets/ に写す）。
const THREADS_BINDGEN_NAME = "niho_develop_wasm_threads";
const WORKER_HELPER = /^snippets\/wasm-bindgen-rayon-[0-9a-f]+\/src\/workerHelpers\.js$/u;

function git(args, encoding = "utf8") {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    throw new SdkReleaseError("engine runtime build の Git source を確認できません");
  }
}

function toolVersion(command, args, pattern, label) {
  let output;
  try {
    output = execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new SdkReleaseError(`${label} がありません`);
  }
  if (!pattern.test(output)) throw new SdkReleaseError(`${label} の版が固定値と一致しません`);
  return output;
}

// スレッドの版は std を作り直す（-Z build-std）ので、固定の 1.98.1 の rust-src が要る。
function assertRustSource() {
  let sysroot;
  try {
    sysroot = execFileSync("rustc", ["+1.98.1", "--print", "sysroot"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new SdkReleaseError("rustc 1.98.1 がありません");
  }
  try {
    if (!lstatSync(path.join(sysroot, "lib/rustlib/src/rust/library/Cargo.lock")).isFile()) throw new Error();
  } catch {
    throw new SdkReleaseError("rust-src がありません（rustup component add rust-src --toolchain 1.98.1）");
  }
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", env });
  if (result.error || result.status !== 0) throw new SdkReleaseError(`engine runtime build に失敗しました: ${command}`);
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new SdkReleaseError(`${name} に値が必要です`);
  return argv[index + 1];
}

export function versionedRuntimeFileName(name, version) {
  const mapping = new Map([
    ["niho_develop_wasm.js", `niho_develop_wasm-${version}.js`],
    ["niho_develop_wasm.d.ts", `niho_develop_wasm-${version}.d.ts`],
    ["niho_develop_wasm_bg.wasm", `niho_develop_wasm_bg-${version}.wasm`],
    ["niho_develop_wasm_bg.wasm.d.ts", `niho_develop_wasm_bg-${version}.wasm.d.ts`],
  ]);
  return mapping.get(name);
}

export function rewriteVersionedRuntimeReferences(name, bytes, version) {
  if (!/\.(?:js|d\.ts)$/.test(name)) return bytes;
  const text = bytes
    .toString("utf8")
    .replaceAll("niho_develop_wasm_bg.wasm", `niho_develop_wasm_bg-${version}.wasm`)
    .replaceAll("niho_develop_wasm.d.ts", `niho_develop_wasm-${version}.d.ts`)
    .replaceAll("niho_develop_wasm.js", `niho_develop_wasm-${version}.js`);
  // web glue の import object key は WASM 内の module ID と一致させる。
  // この仮想module名は外部JSへの参照ではないため、名前を変えない。
  const resourceReferences = text.replace(/(["'])\.\/niho_develop_wasm_bg\.js\1\s*:/gu, '"wasm-import-module":');
  if (/niho_develop_wasm(?:_bg)?\.(?:js|wasm|d\.ts)/.test(resourceReferences)) throw new SdkReleaseError("wasm-bindgen output に unversioned runtime 参照が残っています");
  return Buffer.from(text);
}

/** スレッドの版の wasm-bindgen の出力（`snippets/` の helper を含む相対 path）を平らな版つきの名前にする。 */
export function versionedThreadsRuntimeFileName(name, version) {
  const names = threadsRuntimeFileNames(version);
  if (WORKER_HELPER.test(name)) return names.worker;
  return new Map([
    [`${THREADS_BINDGEN_NAME}.js`, names.js],
    [`${THREADS_BINDGEN_NAME}.d.ts`, names.dts],
    [`${THREADS_BINDGEN_NAME}_bg.wasm`, names.wasm],
    [`${THREADS_BINDGEN_NAME}_bg.wasm.d.ts`, names.wasmDts],
  ]).get(name);
}

// コメントの行を除いたコード（wasm-bindgen・helper の説明の中の `../../..` や `new URL('...')` を参照と読まない）。
function codeLines(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line))
    .join("\n");
}

/**
 * スレッドの版の JS / d.ts の参照を、平らに置いた版つきのファイルへ書き換える。helper は glue を `import('../../..')`
 * （bundler が package の入口へ解決する）で、自分自身を `new URL('./workerHelpers.js')` で読む。どちらも版つきの名前に
 * して、bundler の無い配り方（同じ置き場の静的なファイル）でも解決させる。書き換えの数が想定と違う・コードに版の無い
 * 参照が残るなら止める。
 */
export function rewriteThreadsRuntimeReferences(name, bytes, version) {
  if (!/\.(?:js|d\.ts)$/u.test(name)) return bytes;
  const names = threadsRuntimeFileNames(version);
  let text = bytes.toString("utf8");
  const replaceExactly = (pattern, replacement, label) => {
    const count = (text.match(pattern) ?? []).length;
    if (count !== 1) throw new SdkReleaseError(`スレッドの wasm-bindgen output の参照が想定と違います: ${label}（${count} 件）`);
    text = text.replace(pattern, replacement);
  };
  if (WORKER_HELPER.test(name)) {
    replaceExactly(/\bimport\(\s*(["'])\.\.\/\.\.\/\.\.\1\s*\)/gu, `import("./${names.js}")`, "helper から glue");
    replaceExactly(/\bnew URL\(\s*(["'])\.\/workerHelpers\.js\1\s*,\s*import\.meta\.url\s*\)/gu, `new URL("./${names.worker}", import.meta.url)`, "helper から helper");
  } else if (name === `${THREADS_BINDGEN_NAME}.js`) {
    replaceExactly(/(["'])\.\/snippets\/wasm-bindgen-rayon-[0-9a-f]+\/src\/workerHelpers\.js\1/gu, `"./${names.worker}"`, "glue から helper");
  }
  text = text
    .replaceAll(`${THREADS_BINDGEN_NAME}_bg.wasm`, names.wasm)
    .replaceAll(`${THREADS_BINDGEN_NAME}.d.ts`, names.dts)
    .replaceAll(`${THREADS_BINDGEN_NAME}.js`, names.js);
  // import object の key（wasm の中の module ID）は外部の JS への参照ではないので名前を変えない（1 本と同じ）。
  const code = codeLines(text).replace(new RegExp(`(["'])\\./${THREADS_BINDGEN_NAME}_bg\\.js\\1\\s*:`, "gu"), '"wasm-import-module":');
  if (new RegExp(`${THREADS_BINDGEN_NAME}(?:_bg)?\\.(?:js|wasm|d\\.ts)`, "u").test(code) || /snippets\/|workerHelpers|\.\.\//u.test(code)) throw new SdkReleaseError("スレッドの wasm-bindgen output に版の無い参照が残っています");
  const allowed = new Set([`./${names.js}`, `./${names.worker}`, names.wasm, `./${names.wasm}`]);
  const references = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew URL\(\s*)(["'])([^"'\n]+)\1/gu)].map((match) => match[2]);
  if (references.some((reference) => !allowed.has(reference))) throw new SdkReleaseError("スレッドの wasm-bindgen output に配布物の外への参照があります");
  return Buffer.from(text);
}

/** wasm の import section の memory（スレッドの版が共有メモリと上限で link されたことを確かめる）。 */
export function wasmMemoryImports(bytes) {
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100 || bytes.readUInt32LE(4) !== 1) throw new SdkReleaseError("wasm の形式ではありません");
  let offset = 8;
  const byte = () => {
    if (offset >= bytes.length) throw new SdkReleaseError("wasm の import を読めません");
    return bytes[offset++];
  };
  const leb = () => {
    let result = 0;
    let scale = 1;
    let current;
    do {
      current = byte();
      result += (current & 0x7f) * scale;
      scale *= 128;
    } while (current & 0x80);
    return result;
  };
  const name = () => {
    const length = leb();
    const value = bytes.subarray(offset, offset + length).toString("utf8");
    offset += length;
    return value;
  };
  const limits = () => {
    const flags = byte();
    const initial = leb();
    return { shared: Boolean(flags & 2), initial, maximum: flags & 1 ? leb() : null };
  };
  while (offset < bytes.length) {
    const id = byte();
    const end = leb() + offset;
    if (id !== 2) {
      offset = end;
      continue;
    }
    const memories = [];
    for (let count = leb(); count > 0; count -= 1) {
      const module = name();
      const field = name();
      const kind = byte();
      if (kind === 0) leb();
      else if (kind === 1) {
        byte();
        limits();
      } else if (kind === 2) memories.push({ module, field, ...limits() });
      else if (kind === 3) offset += 2;
      else if (kind === 4) {
        byte();
        leb();
      } else throw new SdkReleaseError("wasm の import を読めません");
    }
    return memories;
  }
  return [];
}

function assertThreadsMemory(bytes) {
  const memories = wasmMemoryImports(bytes);
  if (memories.length !== 1 || !memories[0].shared || memories[0].maximum * 65536 !== THREADS_BUILD.maxMemory) throw new SdkReleaseError("スレッドの wasm が共有メモリ（固定の上限）を import していません");
}

// cargo に渡す path の remap（実行 host の絶対 path を成果物へ混ぜない）。
function remapPrefixes(input, scratch) {
  const required = ["home", "cargoHome", "temporary", "target"];
  if (required.some((name) => !path.isAbsolute(scratch?.[name] ?? ""))) throw new SdkReleaseError("隔離した engine runtime build path が必要です");
  const cargoHome = scratch.cargoHome;
  const rustupHome = input.RUSTUP_HOME || (input.HOME ? path.join(input.HOME, ".rustup") : undefined);
  for (const [label, value] of [["CARGO_HOME", cargoHome], ["RUSTUP_HOME", rustupHome]]) {
    if (value && !path.isAbsolute(value)) throw new SdkReleaseError(`${label} は絶対pathが必要です`);
  }
  const flags = [
    [repoRoot, "source"],
    [input.HOME, "build-user"],
    [cargoHome, "cargo-registry"],
    [rustupHome, "toolchain"],
    [scratch.temporary, "build-temp"],
  ]
    .filter(([value]) => value)
    .sort(([left], [right]) => right.length - left.length)
    .map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  return { cargoHome, rustupHome, flags };
}

// ビルド結果へ実行hostの絶対pathや任意のCargo設定を混入させない。
// CARGO_ENCODED_RUSTFLAGSはrepositoryのwasm SIMD設定を明示的に再現する。
export function runtimeBuildEnvironment(input, scratch) {
  const { cargoHome, rustupHome, flags } = remapPrefixes(input, scratch);
  return {
    ...Object.fromEntries(["PATH", "LANG"].filter((key) => input[key]).map((key) => [key, input[key]])),
    ...(cargoHome ? { CARGO_HOME: cargoHome } : {}),
    ...(rustupHome ? { RUSTUP_HOME: rustupHome } : {}),
    HOME: scratch.home,
    TMPDIR: scratch.temporary,
    CARGO_TARGET_DIR: scratch.target,
    CARGO_INCREMENTAL: "0",
    CARGO_PROFILE_RELEASE_DEBUG: "0",
    CARGO_PROFILE_RELEASE_STRIP: "debuginfo",
    CARGO_ENCODED_RUSTFLAGS: ["-C", "target-feature=+simd128", ...flags].join("\x1f"),
    RUSTUP_TOOLCHAIN: "1.98.1",
    SOURCE_DATE_EPOCH: "0",
    CI: "true",
  };
}

// スレッドの版（#151）: 共有メモリ・atomics と std の作り直し。toolchain は 1 本と同じ固定の 1.98.1 のまま、
// RUSTC_BOOTSTRAP=1 で -Z build-std を通す（1 本の wasm・native と同じコンパイラで浮動小数の codegen が同じ。
// 日付の nightly は 2 つ目の toolchain の固定・配布が増える）。remap と隔離は 1 本と同じ。
export function threadsRuntimeBuildEnvironment(input, scratch) {
  if (!path.isAbsolute(scratch?.threadsTarget ?? "")) throw new SdkReleaseError("隔離した engine runtime build path が必要です");
  const { flags } = remapPrefixes(input, scratch);
  return {
    ...runtimeBuildEnvironment(input, scratch),
    CARGO_TARGET_DIR: scratch.threadsTarget,
    CARGO_ENCODED_RUSTFLAGS: [...threadsRustflags(), ...flags].join("\x1f"),
    RUSTC_BOOTSTRAP: "1",
  };
}

// wasm-bindgen の出力（directory を含む）を相対 path の一覧にする。特殊ファイルは止める。
function bindgenOutputFiles(root, prefix = "") {
  return readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assertRelativePath(relative, "wasm-bindgen output");
    const stat = lstatSync(path.join(root, relative));
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new SdkReleaseError("wasm-bindgen output の特殊ファイルは禁止です");
    return stat.isDirectory() ? bindgenOutputFiles(root, relative) : [relative];
  }).sort();
}

// 空の検出のモデル（niho-photo#141・#158）。repo の層の見出しと重みを、版つきの名前で runtime の `files` に足す
// （画面の Worker と Mac アプリが初めての「空」で読む。develop-engine-manifest.ts の `skyModel`）。
export const SKY_MODEL_SOURCES = [
  ["packages/develop-engine/crates/niho-develop/sky/layout.json", ".json"],
  ["packages/develop-engine/crates/niho-develop/sky/weights.f32", ".f32"],
];

export function skyModelFileName(extension, version) {
  return `niho_sky_model-${version}${extension}`;
}

function collectBindgenOutput(bindgenOutput, rename, rewrite) {
  return bindgenOutputFiles(bindgenOutput).map((name) => {
    const renamed = rename(name);
    if (!renamed) throw new SdkReleaseError(`予期しない wasm-bindgen output です: ${name}`);
    const bytes = rewrite(name, readFileSync(path.join(bindgenOutput, name)));
    return { name: renamed, bytes, sha256: hash(bytes), size: bytes.length };
  });
}

export function buildDevelopEngineRuntime(outputDirectory) {
  if (!path.isAbsolute(outputDirectory)) throw new SdkReleaseError("output は絶対 path が必要です");
  try {
    lstatSync(outputDirectory);
    throw new SdkReleaseError("既存の engine runtime output は上書きできません");
  } catch (error) {
    if (error instanceof SdkReleaseError) throw error;
    if (error?.code !== "ENOENT") throw new SdkReleaseError("engine runtime output を確認できません");
  }
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]).length !== 0) throw new SdkReleaseError("engine runtime は clean working tree からだけ build できます");
  const commit = git(["rev-parse", "HEAD^{commit}"]).trim();
  const tree = git(["rev-parse", "HEAD^{tree}"]).trim();
  const configBytes = git(["show", `${commit}:sdk/release-set.json`], null);
  const config = validateConfig(JSON.parse(configBytes.toString("utf8")));
  const version = config.engine.crateVersion;
  const rustc = toolVersion("rustc", ["+1.98.1", "--version"], /^rustc 1\.98\.1\b/, "rustc 1.98.1");
  const wasmBindgen = toolVersion("wasm-bindgen", ["--version"], /^wasm-bindgen 0\.2\.129$/, "wasm-bindgen 0.2.129");
  assertRustSource();
  const scratch = mkdtempSync(path.join(tmpdir(), "niho-photo-wasm-build-"));
  try {
    const isolated = {
      home: path.join(scratch, "home"),
      cargoHome: path.join(scratch, "cargo-home"),
      temporary: path.join(scratch, "tmp"),
      target: path.join(scratch, "target"),
      threadsTarget: path.join(scratch, "target-threads"),
    };
    for (const directory of Object.values(isolated)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const cargoBuild = ["+1.98.1", "build", "--locked", "--manifest-path", "packages/develop-engine/Cargo.toml", "--target", "wasm32-unknown-unknown", "--release", "-p", "niho-develop-wasm"];

    // 1 本の wasm（今の配布物。古い画面と Mac アプリが読む）
    const buildEnv = runtimeBuildEnvironment(process.env, isolated);
    run("cargo", [...cargoBuild.slice(0, 3), "--config", "packages/develop-engine/.cargo/config.toml", ...cargoBuild.slice(3)], buildEnv);
    const bindgenOutput = path.join(scratch, "wasm-bindgen");
    mkdirSync(bindgenOutput, { mode: 0o700 });
    run("wasm-bindgen", ["--target", "web", "--out-dir", bindgenOutput, "--out-name", "niho_develop_wasm", path.join(isolated.target, "wasm32-unknown-unknown/release/niho_develop_wasm.wasm")], buildEnv);
    const generated = collectBindgenOutput(bindgenOutput, (name) => versionedRuntimeFileName(name, version), (name, bytes) => rewriteVersionedRuntimeReferences(name, bytes, version));
    if (![".js", ".wasm", ".d.ts"].every((extension) => generated.some(({ name }) => name.endsWith(extension)))) throw new SdkReleaseError("wasm-bindgen runtime dependency closure が不足しています");
    // 空の検出のモデルは、build した commit の内容を写す（作業ツリーではなく）
    for (const [source, extension] of SKY_MODEL_SOURCES) {
      const bytes = git(["show", `${commit}:${source}`], null);
      generated.push({ name: skyModelFileName(extension, version), bytes, sha256: hash(bytes), size: bytes.length });
    }

    // スレッドの wasm（crossOriginIsolated の画面だけが読む。Mac アプリには入れない）
    const threadsEnv = threadsRuntimeBuildEnvironment(process.env, isolated);
    run("cargo", [...cargoBuild, "--features", "threads", "-Z", `build-std=${THREADS_BUILD.buildStd}`], threadsEnv);
    const threadsWasm = path.join(isolated.threadsTarget, "wasm32-unknown-unknown/release/niho_develop_wasm.wasm");
    assertThreadsMemory(readFileSync(threadsWasm));
    const threadsBindgenOutput = path.join(scratch, "wasm-bindgen-threads");
    mkdirSync(threadsBindgenOutput, { mode: 0o700 });
    run("wasm-bindgen", ["--target", "web", "--out-dir", threadsBindgenOutput, "--out-name", THREADS_BINDGEN_NAME, threadsWasm], threadsEnv);
    const threadsGenerated = collectBindgenOutput(threadsBindgenOutput, (name) => versionedThreadsRuntimeFileName(name, version), (name, bytes) => rewriteThreadsRuntimeReferences(name, bytes, version));
    const expectedThreads = Object.values(threadsRuntimeFileNames(version)).sort();
    if (JSON.stringify(threadsGenerated.map(({ name }) => name).sort()) !== JSON.stringify(expectedThreads)) throw new SdkReleaseError("スレッドの wasm-bindgen output のファイルが想定と違います");
    assertThreadsMemory(threadsGenerated.find(({ name }) => name.endsWith(".wasm")).bytes);

    const manifest = {
      schemaVersion: 1,
      engine: config.engine.version,
      version,
      source: { repository: config.repository, commit, tree },
      build: {
        rustToolchain: "1.98.1",
        wasmBindgen: "0.2.129",
        target: "wasm32-unknown-unknown",
        profile: "release",
        rustc,
        wasmBindgenCli: wasmBindgen,
      },
      files: Object.fromEntries(generated.map((file) => [file.name, { sha256: file.sha256, bytes: file.size }])),
      threads: {
        files: Object.fromEntries(threadsGenerated.map((file) => [file.name, { sha256: file.sha256, bytes: file.size }])),
        build: { ...THREADS_BUILD },
      },
    };
    mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
    for (const file of [...generated, ...threadsGenerated]) writeFileSync(path.join(outputDirectory, file.name), file.bytes, { flag: "wx", mode: 0o644 });
    writeFileSync(path.join(outputDirectory, config.engine.manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    return { manifest, outputDirectory, sizes: [...generated.map((file) => ["1 本", file]), ...threadsGenerated.map((file) => ["スレッド", file])].map(([kind, file]) => ({ kind, name: file.name, bytes: file.size })) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== "--output") throw new SdkReleaseError("使い方: build-develop-engine-runtime.mjs --output <新規directory>");
    const output = option(argv, "--output");
    const result = buildDevelopEngineRuntime(path.resolve(output));
    console.log(`engine runtime を生成しました: ${result.outputDirectory}`);
    // 配布物の大きさ（1 本・スレッド）を CI の記録に残す
    for (const { kind, name, bytes } of result.sizes) console.log(`${kind}\t${name}\t${bytes} bytes`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "engine runtime build に失敗しました");
    process.exitCode = 1;
  }
}
