import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { artifactName, assertPublicBytes, buildEnvironment, cargoComponents, contractFiles, createArtifactReceipt, createManifest, createSbom, guardBundle, hash, jsonBytes, lockfilePattern, lockfiles, npmComponents, validateManifest, validateSchema, workflowArtifactName } from "./release-evidence-lib.mjs";

const root = new URL("../../", import.meta.url);
const schema = JSON.parse(await readFile(new URL("docs/releases/manifest-v1.schema.json", root)));
const locks = Object.fromEntries(await Promise.all(lockfiles.map(async (file) => [file, await readFile(new URL(file, root))])));
const contracts = Object.fromEntries(await Promise.all(contractFiles.map(async (file) => [file, await readFile(new URL(file, root))])));
const commit = "a".repeat(40);
const options = { commit, tree: "b".repeat(40), arch: "arm64", runId: "123", runAttempt: "1", tools: Object.fromEntries(["node", "npm", "rustc", "cargo", "xcode", "tauri"].map((key) => [key, "1.0"])), locks, contracts, artifactBytes: Buffer.from("synthetic app archive"), sbomBytes: jsonBytes(createSbom(commit, locks)), checkedFiles: 3 };
const manifest = () => createManifest(options);

test("manifestは全lock・contract・archive・SBOMの実bytesをSHA-256へ結び付ける", () => {
  const value = manifest();
  validateManifest(value, schema);
  assert.equal(value.repository, "niho-life/niho-photo");
  const historical = structuredClone(value);
  historical.repository = "niho-coliving/niho-photo";
  assert.doesNotThrow(() => validateManifest(historical, schema));
  assert.equal(value.artifact.sha256, hash(options.artifactBytes));
  assert.equal(value.artifact.bytes, options.artifactBytes.length);
  assert.equal(value.sbom.sha256, hash(options.sbomBytes));
  for (const source of value.locks) assert.equal(source.sha256, hash(locks[source.path]));
  for (const source of value.contracts.files) assert.equal(source.sha256, hash(contracts[source.path]));
  assert.equal(value.contracts.docsSourceCommit, JSON.parse(contracts[contractFiles[3]]).commit);
  const changed = createManifest({ ...options, artifactBytes: Buffer.from("another synthetic app") });
  assert.notEqual(changed.artifact.sha256, value.artifact.sha256);
  assert.deepEqual(changed.locks, value.locks);
});

for (const [name, mutate] of [
  ["short SHA", (v) => { v.commit = "a".repeat(7); }],
  ["mutable ref", (v) => { v.commit = "main"; }],
  ["unknown field", (v) => { v.token = "unapproved"; }],
  ["unknown repository", (v) => { v.repository = "other/repository"; }],
  ["artifact mismatch", (v) => { v.artifact.name = "latest.zip"; }],
  ["platform mismatch", (v) => { v.platform.arch = "x64"; }],
  ["lock missing", (v) => { v.locks.pop(); }],
  ["lock substitution", (v) => { v.locks[0].path = "another/Cargo.lock"; }],
  ["lock duplicate", (v) => { v.locks[0] = structuredClone(v.locks[1]); }],
  ["contract missing", (v) => { v.contracts.files.pop(); }],
  ["contract duplicate", (v) => { v.contracts.files[0] = structuredClone(v.contracts.files[1]); }],
  ["contract version drift", (v) => { v.contracts.accountVersion = 3; }],
  ["production signature", (v) => { v.build.signing = "Developer ID"; }],
  ["updater enabled", (v) => { v.build.updaterArtifacts = true; }],
  ["malformed hash", (v) => { v.artifact.sha256 = "z".repeat(64); }],
  ["zero bytes", (v) => { v.artifact.bytes = 0; }],
  ["missing toolchain", (v) => { delete v.tools.rustc; }],
]) test(`manifest schema/semantic guard: ${name}`, () => {
  const value = manifest(); mutate(value);
  assert.throws(() => validateManifest(value, schema));
});

test("Actions artifact名はrun IDとattemptで一意、payload basenameはfull SHAを維持", () => {
  const first = workflowArtifactName(commit, "arm64", "123", "1");
  const retry = workflowArtifactName(commit, "arm64", "123", "2");
  const separateRun = workflowArtifactName(commit, "arm64", "124", "1");
  assert.equal(first, `niho-photo-${commit}-macos-arm64-run-123-attempt-1`);
  assert.notEqual(first, retry);
  assert.notEqual(first, separateRun);
  assert.equal(manifest().artifact.name, `niho-photo-${commit}-macos-arm64.zip`);
  assert.throws(() => workflowArtifactName(commit, "arm64", "0", "1"));
});

test("upload receiptはActions artifact ID/digestとworkflow識別子の整合性を検査", () => {
  const digest = "a".repeat(64);
  const input = { artifactId: "987", artifactDigest: digest, artifactName: workflowArtifactName(commit, "arm64", "123", "2"), commit, runId: "123", runAttempt: "2" };
  const receipt = createArtifactReceipt(input);
  assert.ok(receipt.includes("Repository: `niho-life/niho-photo`"));
  assert.ok(receipt.includes("Artifact ID: `987`"));
  assert.ok(receipt.includes(`Artifact digest (SHA-256): \`${digest}\``));
  for (const changed of [
    { ...input, artifactId: "0" },
    { ...input, artifactDigest: "sha256:wrong" },
    { ...input, artifactName: workflowArtifactName(commit, "arm64", "999", "2") },
    { ...input, commit: "b".repeat(40) },
  ]) assert.throws(() => createArtifactReceipt(changed));
});

test("schema validatorは未対応keywordを黙認しない", () => assert.throws(() => validateSchema({}, { unevaluatedProperties: false })));
test("contract sourceのversion driftは生成時にも拒否", () => {
  const changed = { ...contracts, [contractFiles[0]]: Buffer.from('{"version":3}') };
  assert.throws(() => createManifest({ ...options, contracts: changed }));
});

test("CycloneDXは全lockのnpm/Cargo inventoryを重複なし・安定順で収録", () => {
  const bom = createSbom(commit, locks);
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.6");
  const expected = new Set(lockfiles.flatMap((file) => file.endsWith(".json") ? npmComponents(locks[file]) : cargoComponents(locks[file])).map((item) => item.purl));
  assert.deepEqual(new Set(bom.components.map((item) => item.purl)), expected);
  assert.equal(expected.size, bom.components.length);
  assert.ok(bom.components.some((item) => item.name === "vitest"), "開発依存も収録する");
  assert.ok(bom.components.some((item) => item.name === "tauri" && item.hashes?.length), "Cargo checksumを残す");
  assert.deepEqual(jsonBytes(createSbom(commit, Object.fromEntries(Object.entries(locks).reverse()))), jsonBytes(bom));
  assertPublicBytes(jsonBytes(bom));
  assert.throws(() => createSbom(commit, { ...locks, "unknown.lock": Buffer.from("") }));
});

test("収録するlockfileはrepoに入っている全lockfileと一致する（mainの成果物生成で初めて落ちないようにPRで検査）", () => {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: fileURLToPath(root), encoding: "utf8" });
  assert.equal(listed.status, 0);
  const committed = listed.stdout.split("\0").filter((file) => lockfilePattern.test(file)).sort();
  assert.deepEqual(committed, lockfiles);
});

test("SBOMは未知registryと不正lockを拒否する", () => {
  const privateUrl = "https://registry.example.invalid/package.tgz";
  assert.throws(() => npmComponents(JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "fixture", version: "1" }, "node_modules/dependency": { version: "1", resolved: privateUrl } } })));
  assert.throws(() => cargoComponents(Buffer.from('version = 4\n[[package]]\nname = "fixture"\nversion = "1"\nsource = "git+https://example.invalid/repo"\n')));
  assert.throws(() => cargoComponents(Buffer.from('version = 4\n[[package]]\nname = "fixture"\nversion = "1"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n')));
});

test("ビルド環境は署名・認証・Vite secret・外部cargo設定を引き継がない", () => {
  const input = { PATH: "/bin", HOME: path.join(path.sep, "synthetic", "account"), TMPDIR: "/synthetic/tmp", RUSTUP_HOME: "/synthetic/rustup", APPLE_ID: "synthetic", TAURI_SIGNING_PRIVATE_KEY: "synthetic", NIHO_ACCOUNT_TOKEN: "synthetic", VITE_SECRET: "synthetic", CARGO_TARGET_DIR: "elsewhere", RUSTFLAGS: "unapproved", NPM_CONFIG_USERCONFIG: "elsewhere", NPM_CONFIG_GLOBALCONFIG: "elsewhere" };
  const result = buildEnvironment(input, "/synthetic/source", { home: "/isolated/home", cargoHome: "/isolated/cargo", tmpdir: "/isolated/tmp", npmUserConfig: "/isolated/user.npmrc", npmGlobalConfig: "/isolated/global.npmrc" });
  for (const key of Object.keys(input).filter((key) => !["PATH", "HOME", "TMPDIR", "RUSTUP_HOME", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG"].includes(key))) assert.equal(result[key], undefined);
  assert.equal(result.HOME, "/isolated/home");
  assert.equal(result.TMPDIR, "/isolated/tmp");
  assert.equal(result.CARGO_HOME, "/isolated/cargo");
  assert.equal(result.RUSTUP_HOME, "/synthetic/rustup");
  assert.equal(result.NPM_CONFIG_USERCONFIG, "/isolated/user.npmrc");
  assert.equal(result.NPM_CONFIG_GLOBALCONFIG, "/isolated/global.npmrc");
  assert.equal(result.RUSTUP_TOOLCHAIN, "1.98.1");
  assert.equal(result.CARGO_PROFILE_RELEASE_DEBUG, "0");
  assert.equal(result.CARGO_PROFILE_RELEASE_STRIP, "debuginfo");
  assert.equal(result.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.ok(result.CARGO_ENCODED_RUSTFLAGS.includes("--remap-path-prefix=/synthetic/rustup=toolchain"));
  assert.ok(result.CARGO_ENCODED_RUSTFLAGS.includes("--remap-path-prefix=/isolated/tmp=build-temp"));
  assert.equal(artifactName(commit, "x64"), `niho-photo-${commit}-macos-x64`);
  assert.throws(() => artifactName("main", "arm64"));
});

const unsafeSamples = [
  ["absolute home", ["", "Users", "synthetic", "source"].join("/")],
  ["absolute volume", ["", "Volumes", "synthetic", "source"].join("/")],
  ["private endpoint", "https://" + "api.example.internal"],
  ["token", "ghp_" + "syntheticfixture012345678901234567890"],
  ["JWT", ["eyJmb28iOiJiYXIifQ", "eyJmb28iOiJiYXIifQ", "synthetic"].join(".")],
  ["credential assignment", JSON.stringify({ access_token: "synthetic-fixture-value" })],
  ["source map", "//# sourceMapping" + "URL=app.js.map"],
];
for (const [name, content] of unsafeSamples) test(`公開bytes guard: ${name}`, () => {
  assert.throws(() => assertPublicBytes(Buffer.from(content)), (error) => !error.message.includes(content));
});

test("公開bytes guardはNUL後の絶対pathを拒否し、相対private pathは許可", () => {
  const privatePath = ["", "private", "synthetic", "path"].join("/");
  const fileUrl = `file://${["", "Users", "synthetic", "path"].join("/")}`;
  assert.throws(() => assertPublicBytes(Buffer.concat([Buffer.from([0]), Buffer.from(privatePath)])));
  assert.throws(() => assertPublicBytes(Buffer.from(fileUrl)));
  assert.doesNotThrow(() => assertPublicBytes(Buffer.from("Contents/Frameworks/private/module")));
});

test("app guardはbinary埋込path、source map、token file、symlinkを拒否", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "photo-evidence-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const app = path.join(temporary, "Synthetic.app");
  await mkdir(app);
  const binary = path.join(app, "binary");
  await writeFile(binary, Buffer.from([0, 1, 2]));
  assert.equal(await guardBundle(app), 1);
  await writeFile(binary, Buffer.concat([Buffer.from([0]), Buffer.from(unsafeSamples[0][1])]));
  await assert.rejects(() => guardBundle(app));
  await writeFile(binary, "synthetic");
  for (const name of ["source.js.map", "tokens.json", ".DS_Store", "build.log"]) {
    await writeFile(path.join(app, name), "synthetic");
    await assert.rejects(() => guardBundle(app));
    await rm(path.join(app, name));
  }
  await symlink(binary, path.join(app, "link"));
  await assert.rejects(() => guardBundle(app));
});

test("release build入口はdebug/featuresを追加せず、隔離HOMEからcargo --lockedとad-hoc configを渡す", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "photo-evidence-build-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stub = path.join(temporary, "tauri");
  await writeFile(stub, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(require("node:path").join(require("node:path").dirname(process.env.TMPDIR), "result.json"), JSON.stringify({ args: process.argv.slice(2), env: process.env, userConfig: fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, "utf8"), globalConfig: fs.readFileSync(process.env.NPM_CONFIG_GLOBALCONFIG, "utf8") }));
`);
  await chmod(stub, 0o755);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("apps/camera/scripts/build-release-evidence.mjs", root))], { encoding: "utf8", env: { PATH: `${temporary}${path.delimiter}${process.env.PATH}`, HOME: temporary, TMPDIR: temporary, APPLE_ID: "synthetic", TAURI_SIGNING_PRIVATE_KEY: "synthetic", VITE_SECRET: "synthetic", CARGO_TARGET_DIR: "unapproved", NPM_CONFIG_USERCONFIG: "unapproved", NPM_CONFIG_GLOBALCONFIG: "unapproved", CARGO_HOME: "unapproved", RUSTUP_HOME: "/synthetic/rustup" } });
  assert.equal(result.status, 0);
  const recorded = JSON.parse(await readFile(path.join(temporary, "result.json")));
  assert.deepEqual(recorded.args.slice(0, 4), ["build", "--bundles", "app", "--config"]);
  assert.deepEqual(recorded.args.slice(-2), ["--", "--locked"]);
  assert.ok(!recorded.args.includes("--debug") && !recorded.args.includes("--features"));
  assert.deepEqual(JSON.parse(recorded.args[4]), { bundle: { macOS: { signingIdentity: "-", hardenedRuntime: false }, createUpdaterArtifacts: false } });
  for (const key of ["APPLE_ID", "TAURI_SIGNING_PRIVATE_KEY", "VITE_SECRET", "CARGO_TARGET_DIR"]) assert.equal(recorded.env[key], undefined);
  assert.notEqual(recorded.env.HOME, temporary);
  assert.notEqual(recorded.env.CARGO_HOME, "unapproved");
  assert.notEqual(recorded.env.TMPDIR, temporary);
  assert.equal(recorded.env.RUSTUP_HOME, "/synthetic/rustup");
  assert.ok(recorded.env.NPM_CONFIG_USERCONFIG.startsWith(temporary));
  assert.ok(recorded.env.NPM_CONFIG_GLOBALCONFIG.startsWith(temporary));
  assert.equal(recorded.userConfig, "");
  assert.equal(recorded.globalConfig, "");
});

test("公開artifact入口はPR contextを拒否し子processの値を表示しない", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("scripts/ci/release-evidence.mjs", root))], { encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_SHA: commit, GITHUB_REPOSITORY: "niho-life/niho-photo", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /context\/clean checkout/);
  assert.ok(!result.stderr.includes(commit));
});
