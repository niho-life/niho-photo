import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  BINARY_PATH,
  BUILD_RECIPE_VERSION,
  NativeRendererError,
  createDeterministicTarball,
  createNativeReleaseManifest,
  inspectRendererSource,
  nativeRendererBuildEnvironment,
  packageNativeRenderer,
  readStrictTarball,
  sha256,
  syntheticPng,
  smokeNativeRenderer,
  verifyBuildArtifact,
  verifyNativeBinary,
  verifyRendererTarball,
} from "./native-renderer.mjs";

const temporary = [];
const commit = "a".repeat(40);
const tree = "b".repeat(40);
const engineVersion = "0.27.0";
const source = { sourceCommit: commit, engineTree: tree, engineVersion, rustToolchain: "1.98.1" };

function temp(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function put(root, relative, bytes) {
  const file = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

function fixtureRepo() {
  const root = temp("native-renderer-repo-");
  put(root, "LICENSE.md", "license\n");
  put(root, "THIRD_PARTY_NOTICES.md", "notices\n");
  put(root, "packages/develop-engine/LICENSES.md", "engine licenses\n");
  put(root, "packages/develop-engine/licenses/Adobe-DNG-SDK-LICENSE.txt", "adobe license\n");
  return root;
}

function packageFixture(target) {
  const repoRoot = fixtureRepo();
  const binaryPath = put(repoRoot, "synthetic/niho-develop-render", Buffer.from(`synthetic-${target}`));
  const outputDirectory = path.join(repoRoot, "artifact");
  const result = packageNativeRenderer({ repoRoot, binaryPath, outputDirectory, source, target });
  return { repoRoot, outputDirectory, result };
}

function checksum(header) {
  header.fill(0x20, 148, 156);
  const sum = [...header].reduce((value, byte) => value + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}

function mutateHeader(tgz, index, mutate) {
  const tar = gunzipSync(tgz);
  let offset = 0;
  let current = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replaceAll("\0", "").trim(), 8);
    if (current++ === index) {
      mutate(header);
      checksum(header);
      return gzipSync(tar, { level: 9, mtime: 0 });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("header not found");
}

function duplicateFirstEntry(tgz) {
  const tar = gunzipSync(tgz);
  const size = Number.parseInt(tar.subarray(124, 136).toString("ascii").replaceAll("\0", "").trim(), 8);
  const firstLength = 512 + Math.ceil(size / 512) * 512;
  const bodyEnd = tar.length - 1024;
  return gzipSync(Buffer.concat([tar.subarray(0, bodyEnd), tar.subarray(0, firstLength), Buffer.alloc(1024)]), { level: 9, mtime: 0 });
}

test("native renderer tgzは決定的なregular file集合とbinary digestを持つ", () => {
  const { outputDirectory, result } = packageFixture("x86_64-unknown-linux-gnu");
  const bytes = readFileSync(path.join(outputDirectory, result.file));
  const systemEntries = execFileSync("tar", ["-tzf", path.join(outputDirectory, result.file)], { encoding: "utf8" }).trim().split("\n").sort();
  const again = createDeterministicTarball([...readStrictTarball(bytes)].map(([name, value]) => ({ name, bytes: value, mode: name === BINARY_PATH ? 0o755 : 0o644 })));
  assert.deepEqual(bytes, again);
  const verified = verifyRendererTarball(bytes, { ...source, target: "x86_64-unknown-linux-gnu" });
  assert.deepEqual(systemEntries, verified.entries);
  assert.equal(verified.binary.sha256, sha256(Buffer.from("synthetic-x86_64-unknown-linux-gnu")));
  assert.deepEqual(verified.entries, [
    "package/LICENSE.md",
    "package/LICENSES.md",
    "package/THIRD_PARTY_NOTICES.md",
    BINARY_PATH,
    "package/licenses/Adobe-DNG-SDK-LICENSE.txt",
    "package/renderer.json",
  ]);
});

test("build smokeの合成PNGは2x2 RGBとしてinflateできる", async () => {
  const bytes = syntheticPng();
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(bytes.readUInt32BE(16), 2);
  assert.equal(bytes.readUInt32BE(20), 2);
  const idatOffset = 8 + 12 + 13;
  const compressed = bytes.subarray(idatOffset + 8, idatOffset + 8 + bytes.readUInt32BE(idatOffset));
  const { inflateSync } = await import("node:zlib");
  assert.equal(inflateSync(compressed).length, 14);
});

test("tar verifierはtraversal・非regular・重複・oversized・未知entryを拒否する", () => {
  const { outputDirectory, result } = packageFixture("aarch64-apple-darwin");
  const bytes = readFileSync(path.join(outputDirectory, result.file));
  const traversal = mutateHeader(bytes, 0, (header) => {
    header.fill(0, 0, 100);
    header.write("package/../escape", 0, "ascii");
  });
  assert.throws(() => readStrictTarball(traversal), NativeRendererError);
  for (const type of [0x31, 0x32, 0x33, 0x34, 0x36, 0x67, 0x78]) {
    assert.throws(() => readStrictTarball(mutateHeader(bytes, 0, (header) => { header[156] = type; })), /regular file/u);
  }
  assert.throws(() => readStrictTarball(duplicateFirstEntry(bytes)), /重複/u);
  assert.throws(() => readStrictTarball(mutateHeader(bytes, 0, (header) => {
    header.fill(0, 124, 136);
    header.write("2000000000\0", 124, "ascii");
  })), /oversized|truncated/u);
  const unknown = mutateHeader(bytes, 0, (header) => {
    header.fill(0, 0, 100);
    header.write("package/unknown", 0, "ascii");
    header.fill(0, 100, 108);
    header.write("0000644\0", 100, "ascii");
  });
  assert.throws(() => verifyRendererTarball(unknown), /entry集合/u);
});

test("source checkoutはfull HEAD・engine tree・repository・toolchainを固定する", () => {
  const root = temp("native-renderer-source-");
  execFileSync("git", ["init", "--quiet", root]);
  put(root, "sdk/release-set.json", `${JSON.stringify({ repository: "niho-life/niho-photo" })}\n`);
  put(root, "packages/develop-engine/Cargo.toml", "[workspace.package]\nversion = \"0.27.0\"\n");
  put(root, "packages/develop-engine/Cargo.lock", "# lock\n");
  put(root, "packages/develop-engine/rust-toolchain.toml", "[toolchain]\nchannel = \"1.98.1\"\n");
  put(root, "packages/develop-engine/crates/niho-develop-render/src/main.rs", "fn main() {}\n");
  execFileSync("git", ["-C", root, "add", "--all"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@invalid.example", "commit", "--quiet", "-m", "fixture"]);
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const expectedTree = execFileSync("git", ["-C", root, "rev-parse", `HEAD:packages/develop-engine`], { encoding: "utf8" }).trim();
  assert.deepEqual(inspectRendererSource(root, head), { sourceCommit: head, engineTree: expectedTree, engineVersion, rustToolchain: "1.98.1" });
  assert.throws(() => inspectRendererSource(root, "f".repeat(40)), /HEAD/u);
  writeFileSync(path.join(root, "packages/develop-engine/rust-toolchain.toml"), "[toolchain]\nchannel = \"nightly\"\n");
  execFileSync("git", ["-C", root, "add", "--all"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@invalid.example", "commit", "--quiet", "-m", "wrong toolchain"]);
  const wrongHead = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.throws(() => inspectRendererSource(root, wrongHead), /toolchain/u);
});

test("build環境はtarget/toolchainを固定し既存flagを保持して全絶対pathをremapする", () => {
  const root = fixtureRepo();
  put(root, "packages/develop-engine/.cargo/config.toml", "[target.wasm32-unknown-unknown]\nrustflags = [\"-C\", \"target-feature=+simd128\"]\n");
  const scratch = temp("native-renderer-env-");
  const env = nativeRendererBuildEnvironment({
    PATH: "/usr/bin:/bin",
    HOME: "/runner/home",
    CARGO_HOME: "/runner/cargo",
    RUSTUP_HOME: "/runner/rustup",
    RUNNER_TEMP: "/runner/temp",
    GITHUB_WORKSPACE: "/runner/workspace",
    CARGO_ENCODED_RUSTFLAGS: "-Copt-level=2",
    GH_TOKEN: "must-not-pass",
  }, { sourceRoot: root, scratch, target: "aarch64-apple-darwin" });
  const flags = env.CARGO_ENCODED_RUSTFLAGS.split("\x1f");
  assert.equal(flags[0], "-Copt-level=2");
  for (const value of [root, scratch, "/runner/home", "/runner/cargo", "/runner/rustup", "/runner/temp", "/runner/workspace"]) assert.ok(flags.some((flag) => flag.startsWith(`--remap-path-prefix=${value}=`)), value);
  assert.equal(env.RUSTUP_TOOLCHAIN, "1.98.1");
  assert.equal(env.CARGO_BUILD_TARGET, "aarch64-apple-darwin");
  assert.equal(env.GH_TOKEN, undefined);
  const plainFlags = nativeRendererBuildEnvironment({ HOME: "/runner/home", RUSTUP_HOME: "/runner/rustup", RUSTFLAGS: "-C opt-level=2" }, { sourceRoot: root, scratch, target: "aarch64-apple-darwin" });
  assert.deepEqual(plainFlags.CARGO_ENCODED_RUSTFLAGS.split("\x1f").slice(0, 2), ["-C", "opt-level=2"]);
  put(root, "packages/develop-engine/.cargo/config.toml", "[target.'cfg(unix)']\nrustflags = [\"-C\", \"target-cpu=native\"]\n");
  assert.throws(() => nativeRendererBuildEnvironment({ HOME: "/runner/home", RUSTUP_HOME: "/runner/rustup" }, { sourceRoot: root, scratch, target: "aarch64-apple-darwin" }), /無断|暗黙/u);
  put(root, "packages/develop-engine/.cargo/config.toml", "[target.aarch64-apple-darwin]\nrustflags = [\"-C\", \"target-cpu=apple-m1\"]\n");
  assert.throws(() => nativeRendererBuildEnvironment({ HOME: "/runner/home", RUSTUP_HOME: "/runner/rustup" }, { sourceRoot: root, scratch: temp("native-renderer-env-reject-"), target: "aarch64-apple-darwin" }), /無断|暗黙/u);
});

test("binary verifierはtargetと異なるheader/archをtool実行前に拒否する", () => {
  const binary = put(temp("native-renderer-wrong-arch-"), "renderer", Buffer.alloc(64));
  assert.throws(() => verifyNativeBinary(binary, "x86_64-unknown-linux-gnu"), /x86_64 ELF/u);
  assert.throws(() => verifyNativeBinary(binary, "aarch64-apple-darwin"), /arm64 thin Mach-O/u);
});

test("publisherはexact 2 artifactsをDATAだけで照合しnative manifestを作る", () => {
  const linux = packageFixture("x86_64-unknown-linux-gnu");
  const macos = packageFixture("aarch64-apple-darwin");
  const outputDirectory = path.join(temp("native-renderer-release-"), "release");
  const result = createNativeReleaseManifest({
    artifacts: [
      { target: "x86_64-unknown-linux-gnu", directory: linux.outputDirectory, publication: { target: "x86_64-unknown-linux-gnu", id: "101", digest: "c".repeat(64), name: `niho-renderer-${commit}-run-77-attempt-1-x86_64-unknown-linux-gnu` } },
      { target: "aarch64-apple-darwin", directory: macos.outputDirectory, publication: { target: "aarch64-apple-darwin", id: "102", digest: `sha256:${"d".repeat(64)}`, name: `niho-renderer-${commit}-run-77-attempt-1-aarch64-apple-darwin` } },
    ],
    outputDirectory,
    sourceCommit: commit,
    builderSourceCommit: "e".repeat(40),
    runId: "77",
    runAttempt: "1",
  });
  assert.equal(result.manifest.schemaVersion, 1);
  assert.equal(result.manifest.buildRecipeVersion, BUILD_RECIPE_VERSION);
  assert.equal(result.manifest.assets.length, 2);
  assert.deepEqual(result.manifest.publication.inputArtifacts.map(({ id, digest }) => [id, digest]), [["102", `sha256:${"d".repeat(64)}`], ["101", `sha256:${"c".repeat(64)}`]]);
  assert.deepEqual(readFileSync(path.join(outputDirectory, result.manifestFile)), Buffer.from(`${JSON.stringify(result.manifest, null, 2)}\n`));
});

test("publisherはsource/tree/target/binary/archive/artifact identityの取り違えと改竄を拒否する", () => {
  const artifact = packageFixture("x86_64-unknown-linux-gnu");
  assert.throws(() => verifyBuildArtifact(artifact.outputDirectory, { sourceCommit: "f".repeat(40) }), /sourceCommit/u);
  const buildPath = path.join(artifact.outputDirectory, artifact.result.buildFile);
  const record = JSON.parse(readFileSync(buildPath, "utf8"));
  record.engineTree = "f".repeat(40);
  writeFileSync(buildPath, `${JSON.stringify(record, null, 2)}\n`);
  assert.throws(() => verifyBuildArtifact(artifact.outputDirectory, { engineTree: tree }), /engineTree/u);
  record.engineTree = tree;
  record.binary.sha256 = "0".repeat(64);
  writeFileSync(buildPath, `${JSON.stringify(record, null, 2)}\n`);
  assert.throws(() => verifyBuildArtifact(artifact.outputDirectory, {}), /binary identity/u);
  assert.throws(() => createNativeReleaseManifest({ artifacts: [], outputDirectory: path.join(temp("native-release-invalid-"), "out"), sourceCommit: commit, builderSourceCommit: tree, runId: "1", runAttempt: "1" }), /exact 2/u);
  assert.throws(() => createNativeReleaseManifest({ artifacts: [{ target: "x86_64-unknown-linux-gnu", directory: artifact.outputDirectory, publication: { target: "x86_64-unknown-linux-gnu", id: "0", digest: "x", name: "bad" } }], outputDirectory: path.join(temp("native-release-invalid-id-"), "out"), sourceCommit: commit, builderSourceCommit: tree, runId: "1", runAttempt: "1" }), /identity|exact 2/u);
});


test("publish CLIは完全なbuild digest期待値で成功しdigest改竄は拒否する", () => {
  const linux = packageFixture("x86_64-unknown-linux-gnu");
  const macos = packageFixture("aarch64-apple-darwin");
  const releaseRoot = temp("native-cli-release-");
  const args = [new URL("./native-renderer.mjs", import.meta.url).pathname, "publish", "--output", path.join(releaseRoot, "release"), "--source", commit, "--builder-source", "e".repeat(40), "--run-id", "77", "--run-attempt", "1"];
  for (const [prefix, fixture, id] of [["linux", linux, "101"], ["macos", macos, "102"]]) {
    const record = fixture.result;
    args.push(`--${prefix}-directory`, fixture.outputDirectory, `--${prefix}-artifact-id`, id, `--${prefix}-artifact-digest`, "c".repeat(64), `--${prefix}-artifact-name`, `niho-renderer-${commit}-run-77-attempt-1-${record.target}`, `--${prefix}-engine-tree`, record.engineTree, `--${prefix}-engine-version`, record.engineVersion, `--${prefix}-target`, record.target, `--${prefix}-archive-sha256`, record.sha256, `--${prefix}-binary-sha256`, record.binary.sha256);
  }
  execFileSync(process.execPath, args, { stdio: "pipe" });
  const manifest = JSON.parse(readFileSync(path.join(releaseRoot, "release", `niho-photo-renderer-${commit}.json`), "utf8"));
  assert.equal(manifest.assets.length, 2);
  assert.equal(manifest.assets.find((item) => item.target === linux.result.target).binary.sha256, linux.result.binary.sha256);
  for (const field of ["--linux-archive-sha256", "--linux-binary-sha256"]) {
    const changed = [...args];
    changed[changed.indexOf("--output") + 1] = path.join(releaseRoot, field.slice(2));
    changed[changed.indexOf(field) + 1] = "0".repeat(64);
    assert.throws(() => execFileSync(process.execPath, changed, { stdio: "pipe" }), /一致しません/u);
  }
});


test("native smokeは既存CLIのcapabilities契約とneutral recipeで合成PNGを描く", () => {
  const root = temp("native-legacy-cli-smoke-");
  const binary = path.join(root, "mock-renderer");
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "capabilities") {
  console.log(JSON.stringify({tool:"niho-develop-render",version:process.env.MOCK_VERSION || "0.27.0",settingsVersions:[1,2,3,4,5,6,7,8,9],engines:["niho-1","niho-14"]}));
} else if (args[0] === "render") {
  const value = (key) => args[args.indexOf(key)+1];
  const settings = JSON.parse(fs.readFileSync(value("--settings"),"utf8"));
  if (JSON.stringify(settings) !== JSON.stringify({v:9,engine:"niho-1",look:"niho-interim-1",base:null})) process.exit(2);
  fs.copyFileSync(value("--raster"),value("--out"));
  console.log(JSON.stringify({source:"raster",width:2,height:2}));
} else process.exit(2);
`);
  chmodSync(binary, 0o755);
  smokeNativeRenderer(binary, root, { PATH: process.env.PATH }, "0.27.0");
  assert.throws(() => smokeNativeRenderer(binary, root, { PATH: process.env.PATH, MOCK_VERSION: "0.28.0" }, "0.27.0"), /capabilities/u);
});
