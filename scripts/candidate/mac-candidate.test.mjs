import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { validateNativeLock, validateNativeSourceClosure } from "../../packages/develop-engine/build-macos-native.mjs";
import {
  applyVersionOverlay,
  assertDmgRoot,
  assertCandidatePublicBytes,
  assertOwnershipMatches,
  assertSdkSelection,
  candidateBaseName,
  candidateContract,
  inventoryTree,
  officialBuildEnvironment,
  packAppTar,
  packDmg,
  verifyDmgInventory,
  resolveCleanSource,
  sha256,
  stageCandidateNotices,
  stagePreparedNodeDependencies,
  stageRuntimeAssetBundle,
  machoRuntimeSection,
  verifyRuntimeAssetBundle,
  validateTarEntries,
  verifyAppNoticeResources,
  verifyCandidateDirectory,
  verifySdkProofDirectory,
} from "./mac-candidate-lib.mjs";
import { sourceSnapshot, assertExpectedWorkspaceChanges, candidateSbomBytes } from "./build-mac-candidate.mjs";
import { preparePublishedSdkProof } from "./prepare-published-sdk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = [];
const temp = (prefix) => {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
};
after(() => temporary.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function put(base, relative, bytes) {
  const file = path.join(base, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function overlayFixture() {
  const workspace = temp("niho-photo-overlay-");
  put(workspace, "apps/camera/package.json", `${JSON.stringify({ name: "@niho/camera", version: "0.1.18" }, null, 2)}\n`);
  put(workspace, "apps/camera/src-tauri/tauri.conf.json", `${JSON.stringify({ productName: "NIHO photo", version: "0.1.18" }, null, 2)}\n`);
  put(workspace, "apps/camera/src-tauri/Cargo.toml", `[package]\nname = "niho_camera"\nversion = "0.1.18"\n`);
  put(workspace, "apps/camera/src-tauri/Cargo.lock", `version = 4\n\n[[package]]\nname = "niho_camera"\nversion = "0.1.18"\ndependencies = []\n`);
  put(workspace, "package-lock.json", "root lock must not change\n");
  return workspace;
}

test("version overlayはcameraの4 fileだけを変更しroot npm lockに触れない", () => {
  const workspace = overlayFixture();
  const rootLock = readFileSync(path.join(workspace, "package-lock.json"));
  const records = applyVersionOverlay(workspace, "2.3.4-beta.1");
  assert.deepEqual(records.map(({ path: name }) => name), candidateContract.overlayPaths);
  assert.equal(JSON.parse(readFileSync(path.join(workspace, "apps/camera/package.json"), "utf8")).version, "2.3.4-beta.1");
  assert.equal(JSON.parse(readFileSync(path.join(workspace, "apps/camera/src-tauri/tauri.conf.json"), "utf8")).version, "2.3.4-beta.1");
  assert.match(readFileSync(path.join(workspace, "apps/camera/src-tauri/Cargo.toml"), "utf8"), /version = "2\.3\.4-beta\.1"/u);
  assert.match(readFileSync(path.join(workspace, "apps/camera/src-tauri/Cargo.lock"), "utf8"), /version = "2\.3\.4-beta\.1"/u);
  assert.deepEqual(readFileSync(path.join(workspace, "package-lock.json")), rootLock);
});

test("official build環境は公開値だけを追加し秘密・Cargo設定を継承しない", () => {
  const workspace = temp("niho-photo-env-workspace-");
  const isolatedRoot = temp("niho-photo-env-isolated-");
  const publicKey = `AIza${"A".repeat(35)}`;
  const env = officialBuildEnvironment({ PATH: "/usr/bin", HOME: "/unsafe", CARGO_HOME: "/unsafe/cargo", RUSTFLAGS: "unsafe", TAURI_SIGNING_PRIVATE_KEY: "secret" }, { workspace, isolatedRoot, publicFirebaseKey: publicKey });
  assert.equal(env.NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY, publicKey);
  assert.equal(env.HOME, path.join(isolatedRoot, "home"));
  assert.equal(env.CARGO_HOME, path.join(isolatedRoot, "cargo-home"));
  assert.equal(env.RUSTUP_TOOLCHAIN, "1.98.1");
  assert.equal(env.RUSTFLAGS, undefined);
  assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.throws(() => officialBuildEnvironment({}, { workspace, isolatedRoot: temp("niho-photo-env-missing-"), publicFirebaseKey: "" }), /公開Firebase/);
});

test("candidate scannerは指定した公開Firebase値だけを例外にし別値を拒否する", () => {
  const allowed = `AIza${"A".repeat(35)}`;
  const other = `AIza${"B".repeat(35)}`;
  assert.doesNotThrow(() => assertCandidatePublicBytes(Buffer.from(`compiled:${allowed}`), allowed));
  assert.throws(() => assertCandidatePublicBytes(Buffer.from(`compiled:${other}`), allowed), /API key/);
  assert.throws(() => assertCandidatePublicBytes(Buffer.from(`${allowed}\n${other}`), allowed), /API key/);
  const privateKeyMarker = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
  assert.throws(() => assertCandidatePublicBytes(Buffer.from(privateKeyMarker), allowed), /非公開|秘密/);
});

test("published/local-validation SDK pinとsource ownership mismatchを拒否する", () => {
  const app = "a".repeat(40), sdk = "b".repeat(40), digest = "c".repeat(64);
  assert.doesNotThrow(() => assertSdkSelection({ mode: "published", appSource: app, sdkSource: sdk, manifestSha256: digest, expectedManifestSha256: digest }));
  assert.throws(() => assertSdkSelection({ mode: "published", appSource: app, sdkSource: sdk, manifestSha256: digest, expectedManifestSha256: "d".repeat(64) }), /輸送hash/);
  assert.throws(() => assertSdkSelection({ mode: "local-validation", appSource: app, sdkSource: sdk, manifestSha256: digest }), /同じcommit/);
  assert.doesNotThrow(() => assertSdkSelection({ mode: "local-validation", appSource: app, sdkSource: app, manifestSha256: digest }));
  const ownership = { algorithm: "sha256-git-file-set-v1", digest, paths: [{ path: "sdk", sha256: digest, files: 1 }] };
  assert.doesNotThrow(() => assertOwnershipMatches(ownership, structuredClone(ownership)));
  assert.throws(() => assertOwnershipMatches(ownership, { ...ownership, digest: "d".repeat(64) }), /sourceOwnership/);
});

test("candidate sourceはtemp fixtureのclean current full SHAだけを受け付ける", () => {
  const repo = temp("niho-photo-clean-source-");
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Candidate fixture"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "candidate@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  writeFileSync(path.join(repo, "source.txt"), "one\n");
  execFileSync("git", ["add", "source.txt"], { cwd: repo });
  execFileSync("git", ["commit", "--quiet", "-m", "one"], { cwd: repo });
  const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(resolveCleanSource(repo, first).commit, first);
  writeFileSync(path.join(repo, "dirty.txt"), "dirty\n");
  assert.throws(() => resolveCleanSource(repo, first), /clean Git/);
  rmSync(path.join(repo, "dirty.txt"));
  writeFileSync(path.join(repo, "source.txt"), "two\n");
  execFileSync("git", ["add", "source.txt"], { cwd: repo });
  execFileSync("git", ["commit", "--quiet", "-m", "two"], { cwd: repo });
  assert.throws(() => resolveCleanSource(repo, first), /current HEAD/);
  assert.throws(() => resolveCleanSource(repo, first.slice(0, 12)), /full commit SHA/);
});

test("SDK native closureとlegacy calibration bytesを固定する", () => {
  assert.deepEqual(validateNativeSourceClosure(path.join(root, "packages/develop-engine")), { rustToolchain: "1.98.1", target: "aarch64-apple-darwin" });
  for (const [relative, size, digest] of [
    ["apple-v1.json", 4988, "85995e52e8a8a9e958d78a3a35a1c9d5de7916b804bd5fca2fd29a81b88ece18"],
    ["apple-v2.json", 5378, "19a0b544394c5434c0fa352fed47502d68634263a971cafb36eacfa372e97cad"],
  ]) {
    const bytes = readFileSync(path.join(root, "packages/develop-engine/calibration/panasonic-dc-s5", relative));
    assert.equal(bytes.length, size);
    assert.equal(sha256(bytes), digest);
    assert.notEqual(bytes.at(-1), 10);
  }
});

test("native tool lockの旧版とRust toolchain保存先の欠落をビルド前に拒否する", () => {
  const engine = path.join(root, "packages/develop-engine");
  const lock = JSON.parse(readFileSync(path.join(root, "apps/camera/develop-sidecars.lock.json"), "utf8"));
  const versions = validateNativeLock(engine, lock);
  assert.equal(versions.nihoDevelopRender, "0.27.0");
  assert.throws(() => validateNativeLock(engine, { ...lock, nihoDevelopRender: { version: "0.16.0" } }), /tool version/u);
  const isolatedRoot = temp("niho-photo-default-rustup-");
  const env = officialBuildEnvironment({ HOME: "/build/home", PATH: "/usr/bin:/bin" }, { workspace: "/source", isolatedRoot, publicFirebaseKey: `AIza${"A".repeat(35)}` });
  assert.equal(env.RUSTUP_HOME, "/build/home/.rustup");
  assert.throws(() => officialBuildEnvironment({}, { workspace: "/source", isolatedRoot, publicFirebaseKey: `AIza${"A".repeat(35)}` }), /Rust toolchain/u);
});

test("app tar contractはroot外path・special file・symlinkを拒否する", () => {
  const valid = [
    { name: "NIHO photo.app", type: "directory" },
    { name: "NIHO photo.app/Contents", type: "directory" },
    { name: "NIHO photo.app/Contents/Info.plist", type: "file" },
  ];
  assert.equal(validateTarEntries(valid, "NIHO photo.app"), valid);
  for (const entry of [
    { name: "../escape", type: "file" },
    { name: "other.app/file", type: "file" },
    { name: "NIHO photo.app/link", type: "symlink" },
    { name: "/NIHO photo.app/file", type: "file" },
  ]) assert.throws(() => validateTarEntries([...valid, entry], "NIHO photo.app"), /path traversal/);
});

function candidateFixture() {
  const directory = temp("niho-photo-candidate-fixture-");
  const source = "a".repeat(40), tree = "b".repeat(40), version = "1.2.3", runId = "44", runAttempt = "2";
  const base = candidateBaseName({ version, sourceSha: source, runId, runAttempt });
  const appRoot = temp("niho-photo-app-fixture-");
  put(appRoot, "NIHO photo.app/Contents/Info.plist", "fixture\n");
  for (const name of ["niho-camera", "apple-raw-linear", "niho-develop-render", "niho-camera-cutout"]) {
    put(appRoot, `NIHO photo.app/Contents/MacOS/${name}`, `synthetic binary ${name}\n`);
    chmodSync(path.join(appRoot, "NIHO photo.app/Contents/MacOS", name), 0o755);
  }
  put(appRoot, "NIHO photo.app/Contents/Resources/develop-calibration/apple-registry.json", "{}\n");
  const notices = candidateContract.noticePaths.map((name) => {
    const bytes = Buffer.from(`synthetic notice: ${name}\n`);
    put(appRoot, `NIHO photo.app/Contents/Resources/third-party-notices/${name}`, bytes);
    return { path: name, sha256: sha256(bytes), bytes: bytes.length };
  });
  const tarName = `${base}.app.tar.gz`, dmgName = `${base}.dmg`, sbomName = `${base}.cdx.json`;
  packAppTar(path.join(appRoot, "NIHO photo.app"), path.join(directory, tarName));
  writeFileSync(path.join(directory, dmgName), "synthetic dmg bytes");
  const sbom = { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { component: { type: "application", name: "niho-photo", version: source } }, components: [] };
  writeFileSync(path.join(directory, sbomName), `${JSON.stringify(sbom)}\n`);
  const asset = (name) => { const bytes = readFileSync(path.join(directory, name)); return { name, sha256: sha256(bytes), bytes: bytes.length }; };
  const ownershipPaths = JSON.parse(readFileSync(path.join(root, "sdk/release-set.json"), "utf8")).ownedSourcePaths.map((name, index) => ({ path: name, sha256: String(index).padStart(64, "0"), files: 1 }));
  const ownershipDigest = createHash("sha256").update(ownershipPaths.map(({ path: name, sha256: digest, files }) => `${name}\0${digest}\0${files}\n`).join("")).digest("hex");
  const packageNames = { ui: "niho-photo-ui", "photo-editing": "niho-photo-editing", "cloud-contract": "niho-photo-cloud-contract", "photo-contract": "niho-photo-contract", "develop-engine-source": "niho-photo-develop-engine-source", "develop-engine-runtime": "niho-photo-develop-engine-runtime" };
  const sdkPackages = Object.entries(packageNames).map(([id, name]) => ({ id, name, file: `${id}.tgz`, sha256: "c".repeat(64), bytes: 1 }));
  const files = inventoryTree(path.join(appRoot, "NIHO photo.app"));
  const native = ["apple-raw-linear", "niho-develop-render", "niho-camera-cutout"].map((name) => {
    const file = files.find((item) => item.path === `Contents/MacOS/${name}`);
    return { name, version: "1.0.0", architecture: "arm64", sourceSha256: "a".repeat(64), sha256: file.sha256, bytes: file.bytes, dylibs: ["/usr/lib/libSystem.B.dylib"] };
  });
  const manifest = {
    schemaVersion: 1,
    repository: "niho-life/niho-photo",
    product: "NIHO photo",
    bundleId: "life.niho.camera",
    version,
    source: { commit: source, tree },
    run: { id: runId, attempt: runAttempt },
    sdk: { mode: "published", version: "0.1.1", manifestFile: `niho-photo-sdk-0.1.1-${"1".repeat(40)}.json`, manifestSha256: "c".repeat(64), source: { commit: "1".repeat(40), tree: "2".repeat(40) }, packages: sdkPackages },
    sourceOwnership: { algorithm: "sha256-git-file-set-v1", digest: ownershipDigest, paths: ownershipPaths },
    publicAccountConfig: { name: "NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY", sha256: "e".repeat(64), included: true },
    build: { signing: "ad-hoc", officialUpdates: true, updaterArtifacts: false, toolchain: { node: "v24.1.0", rust: "rustc 1.98.1 (fixture)", swift: "Swift 6 fixture", tauri: "tauri 2 fixture", target: "aarch64-apple-darwin" } },
    overlays: candidateContract.overlayPaths.map((name) => ({ path: name, beforeSha256: "1".repeat(64), afterSha256: "2".repeat(64) })),
    app: {
      identity: { product: "NIHO photo", bundleId: "life.niho.camera", version, deepLink: "niho-camera" },
      updater: { feed: candidateContract.updaterFeed, publicKeySha256: candidateContract.updaterPublicKeySha256, officialUpdates: true },
      files,
      executable: { ...files.find((item) => item.path === "Contents/MacOS/niho-camera") },
      notices,
      native,
      calibration: [{ path: "apple-registry.json", sha256: sha256(Buffer.from("{}\n")), bytes: 3 }],
      runtime: { engine: "niho-13", crateVersion: "0.25.0", manifest: { name: "manifest-0.25.0.json", sha256: "4".repeat(64) }, files: [{ name: "runtime.wasm", sha256: "5".repeat(64), bytes: 1 }] },
    },
    assets: [asset(tarName), asset(sbomName), asset(dmgName)],
  };
  const manifestFile = `${base}.candidate.json`;
  writeFileSync(path.join(directory, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, appRoot, manifest, manifestFile, names: { tarName, dmgName, sbomName } };
}

test("appにroot notices・Adobe license・Nunito OFLを同じbytesで同梱する", () => {
  const app = temp("niho-photo-app-notices-");
  const staged = stageCandidateNotices(root, path.join(app, "Contents/Resources/third-party-notices"));
  assert.equal(staged.files.length, 7);
  assert.equal(verifyAppNoticeResources(app, staged.files), staged.files);
  writeFileSync(path.join(staged.directory, "fonts/OFL-Nunito.txt"), "changed\n");
  assert.throws(() => verifyAppNoticeResources(app, staged.files), /notice hash/u);
  assert.throws(() => verifyAppNoticeResources(app, staged.files.slice(1)), /notice集合/u);
});

const integrity = (digest) => `sha256-${Buffer.from(digest, "hex").toString("base64")}`;
const pinnedRecords = (paths, marker) => paths.map((name, index) => {
  const digest = `${marker}${String(index).padStart(63, "0")}`;
  return { path: name, sha256: digest, integrity: integrity(digest), size: 1 };
});

function sdkManifestFixture(candidate, repository = "niho-life/niho-photo") {
  const runtimeDigest = "8".repeat(64), manifestDigest = "9".repeat(64);
  return {
    schemaVersion: 1,
    releaseReady: true,
    repository,
    version: candidate.manifest.sdk.version,
    source: candidate.manifest.sdk.source,
    packages: candidate.manifest.sdk.packages.map(({ bytes: size, ...item }) => ({ ...item, size, integrity: integrity(item.sha256) })),
    sourceOwnership: candidate.manifest.sourceOwnership,
    buildTooling: { node: "24.x", files: pinnedRecords(["package.json", "package-lock.json"], "6") },
    engine: {
      version: "niho-13",
      crateVersion: "0.25.0",
      contracts: pinnedRecords(["packages/photo-editing/src/develop-engine/develop-engine-manifest.ts", "packages/photo-editing/src/develop-engine/develop-settings.ts", "packages/develop-engine/crates/niho-develop/src/settings.rs"], "7"),
      buildInputs: pinnedRecords(["packages/develop-engine/Cargo.lock", "packages/develop-engine/Cargo.toml", "packages/develop-engine/rust-toolchain.toml", "packages/develop-engine/crates/niho-develop-wasm/Cargo.toml", "packages/develop-engine/crates/niho-develop-wasm/src/lib.rs"], "5"),
      manifest: { file: "manifest-0.25.0.json", sha256: manifestDigest, integrity: integrity(manifestDigest), size: 1 },
      runtimeFiles: ["runtime.js", "runtime.wasm", "runtime.d.ts"].map((name) => ({ name, sha256: runtimeDigest, integrity: integrity(runtimeDigest), size: 1 })),
    },
    recipeCompatibility: { format: "javascript-esm-with-declarations", supportedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9], nodeRuntimeValidator: true, package: "niho-photo-contract", export: ".", engineIdentifiers: ["niho-13"] },
    uiSingleton: { package: "niho-photo-ui", hostExport: "niho-photo-editing/sdk-dialog-host", requirement: "one host singleton only" },
  };
}

function sdkProofFixture(candidate, sdkRepository = "niho-life/niho-photo") {
  const directory = temp("niho-photo-sdk-proof-");
  const sdkManifest = sdkManifestFixture(candidate, sdkRepository);
  const manifestBytes = Buffer.from(`${JSON.stringify(sdkManifest, null, 2)}\n`);
  candidate.manifest.sdk.manifestSha256 = sha256(manifestBytes);
  writeFileSync(path.join(directory, candidate.manifest.sdk.manifestFile), manifestBytes);
  const receipt = {
    schemaVersion: 1,
    repository: sdkManifest.repository,
    sourceSha: candidate.manifest.sdk.source.commit,
    sourceOwnershipDigest: candidate.manifest.sourceOwnership.digest,
    version: candidate.manifest.sdk.version,
    runId: "31",
    runAttempt: "1",
    artifact: { id: "72", name: `niho-photo-sdk-${candidate.manifest.sdk.source.commit}-run-31-attempt-1`, digest: `sha256:${"d".repeat(64)}` },
    releaseManifest: { file: candidate.manifest.sdk.manifestFile, sha256: candidate.manifest.sdk.manifestSha256 },
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(path.join(directory, "photo-sdk-artifact-receipt.json"), receiptBytes);
  const assets = [
    { name: candidate.manifest.sdk.manifestFile, bytes: manifestBytes.length },
    ...sdkManifest.packages.map(({ file: name, size: bytes }) => ({ name, bytes })),
    { name: "photo-sdk-artifact-receipt.json", bytes: receiptBytes.length },
  ].sort((left, right) => left.name.localeCompare(right.name, "en"));
  const release = { schemaVersion: 1, repository: candidate.manifest.repository, releaseId: 88, tagName: `photo-sdk-v${candidate.manifest.sdk.version}`, tagSha: candidate.manifest.sdk.source.commit, targetCommitish: candidate.manifest.sdk.source.commit, draft: false, prerelease: false, publishedAt: "2026-10-22T00:00:00Z", assets };
  writeFileSync(path.join(directory, "photo-sdk-release.json"), `${JSON.stringify(release, null, 2)}\n`);
  writeFileSync(path.join(candidate.directory, candidate.manifestFile), `${JSON.stringify(candidate.manifest, null, 2)}\n`);
  return { directory, sdkManifest, receipt, release };
}

test("candidate data verifierはasset集合/hash/identity/updater/versionを固定する", () => {
  const valid = candidateFixture();
  assert.equal(verifyCandidateDirectory(valid.directory).assets.length, 3);
  const manifestSha256 = sha256(readFileSync(path.join(valid.directory, valid.manifestFile)));
  const verifier = path.join(root, "scripts/candidate/verify-mac-candidate.mjs");
  const args = [verifier, "--directory", valid.directory, "--expected-manifest-sha256", manifestSha256, "--expected-source", valid.manifest.source.commit, "--expected-version", valid.manifest.version, "--expected-sdk-mode", "published", "--expected-sdk-version", valid.manifest.sdk.version, "--expected-sdk-manifest-sha256", valid.manifest.sdk.manifestSha256, "--run-id", valid.manifest.run.id, "--run-attempt", valid.manifest.run.attempt];
  assert.doesNotThrow(() => execFileSync(process.execPath, args));
  const wrongMode = [...args]; wrongMode[wrongMode.indexOf("published")] = "local-validation";
  assert.throws(() => execFileSync(process.execPath, wrongMode, { stdio: "pipe" }));

  const extra = candidateFixture();
  writeFileSync(path.join(extra.directory, "extra.bin"), "extra");
  assert.throws(() => verifyCandidateDirectory(extra.directory), /集合/);

  const tampered = candidateFixture();
  writeFileSync(path.join(tampered.directory, tampered.names.dmgName), "tampered");
  assert.throws(() => verifyCandidateDirectory(tampered.directory), /hash/);

  const oversized = candidateFixture();
  truncateSync(path.join(oversized.directory, oversized.names.dmgName), candidateContract.maxAssetBytes + 1);
  assert.throws(() => verifyCandidateDirectory(oversized.directory), /250 MiB/);

  const linkedManifest = candidateFixture();
  const manifestTarget = path.join(temp("niho-photo-candidate-manifest-target-"), "manifest.json");
  writeFileSync(manifestTarget, JSON.stringify(linkedManifest.manifest));
  rmSync(path.join(linkedManifest.directory, linkedManifest.manifestFile));
  symlinkSync(manifestTarget, path.join(linkedManifest.directory, linkedManifest.manifestFile));
  assert.throws(() => verifyCandidateDirectory(linkedManifest.directory), /通常file/);

  for (const mutate of [
    (value) => { value.repository = "other/repository"; },
    (value) => { value.version = "v1"; },
    (value) => { value.app.identity.bundleId = "other.bundle"; },
    (value) => { delete value.app.notices; },
    (value) => { value.app.files = value.app.files.filter((file) => !file.path.endsWith("OFL-Nunito.txt")); },
    (value) => { value.app.updater.feed = "https://example.invalid/latest.json"; },
    (value) => { value.app.updater.publicKeySha256 = "0".repeat(64); },
  ]) {
    const fixture = candidateFixture();
    mutate(fixture.manifest);
    writeFileSync(path.join(fixture.directory, fixture.manifestFile), `${JSON.stringify(fixture.manifest, null, 2)}\n`);
    assert.throws(() => verifyCandidateDirectory(fixture.directory));
  }
});

test("移管前candidateと旧repositoryの公開SDK proofを引き続き検証する", () => {
  const historicalCandidate = candidateFixture();
  historicalCandidate.manifest.repository = "niho-coliving/niho-photo";
  writeFileSync(path.join(historicalCandidate.directory, historicalCandidate.manifestFile), `${JSON.stringify(historicalCandidate.manifest, null, 2)}\n`);
  assert.equal(verifyCandidateDirectory(historicalCandidate.directory).manifest.repository, "niho-coliving/niho-photo");

  const currentCandidate = candidateFixture();
  const historicalSdkProof = sdkProofFixture(currentCandidate, "niho-coliving/niho-photo");
  assert.equal(verifySdkProofDirectory({
    directory: historicalSdkProof.directory,
    candidateManifest: currentCandidate.manifest,
    expectedSdkVersion: currentCandidate.manifest.sdk.version,
    expectedSdkManifestSha256: currentCandidate.manifest.sdk.manifestSha256,
  }).manifest.repository, "niho-coliving/niho-photo");
});

test("published SDK proofはmanifest schema/source ownership/release receiptをcandidateへ固定する", () => {
  const candidate = candidateFixture();
  const proof = sdkProofFixture(candidate);
  const verified = verifySdkProofDirectory({ directory: proof.directory, candidateManifest: candidate.manifest, expectedSdkVersion: candidate.manifest.sdk.version, expectedSdkManifestSha256: candidate.manifest.sdk.manifestSha256 });
  assert.equal(verified.release.tagSha, candidate.manifest.sdk.source.commit);

  const mismatched = candidateFixture();
  const mismatchedProof = sdkProofFixture(mismatched);
  mismatchedProof.release.targetCommitish = "f".repeat(40);
  writeFileSync(path.join(mismatchedProof.directory, "photo-sdk-release.json"), `${JSON.stringify(mismatchedProof.release, null, 2)}\n`);
  assert.throws(() => verifySdkProofDirectory({ directory: mismatchedProof.directory, candidateManifest: mismatched.manifest, expectedSdkVersion: mismatched.manifest.sdk.version, expectedSdkManifestSha256: mismatched.manifest.sdk.manifestSha256 }), /metadata/);
});

test("candidate publisher verifierはrun/SDK proof/artifact digestを照合してreceiptとprovenanceを出す", () => {
  const candidate = candidateFixture();
  const proof = sdkProofFixture(candidate);
  const candidateManifestSha256 = sha256(readFileSync(path.join(candidate.directory, candidate.manifestFile)));
  const verifier = path.join(root, "scripts/candidate/verify-mac-candidate.mjs");
  const receipt = path.join(temp("niho-photo-candidate-output-"), "receipt.json");
  const provenance = path.join(path.dirname(receipt), "provenance.json");
  const artifactName = `niho-photo-candidate-${candidate.manifest.source.commit}-run-${candidate.manifest.run.id}-attempt-${candidate.manifest.run.attempt}`;
  const args = [verifier, "--directory", candidate.directory, "--sdk-proof-directory", proof.directory, "--expected-manifest-sha256", candidateManifestSha256, "--expected-source", candidate.manifest.source.commit, "--expected-version", candidate.manifest.version, "--expected-sdk-mode", "published", "--expected-sdk-version", candidate.manifest.sdk.version, "--expected-sdk-manifest-sha256", candidate.manifest.sdk.manifestSha256, "--run-id", candidate.manifest.run.id, "--run-attempt", candidate.manifest.run.attempt, "--artifact-id", "99", "--artifact-digest", "a".repeat(64), "--artifact-name", artifactName, "--tooling-source", "e".repeat(40), "--receipt", receipt, "--provenance", provenance];
  assert.doesNotThrow(() => execFileSync(process.execPath, args));
  assert.equal(JSON.parse(readFileSync(receipt)).artifact.digest, `sha256:${"a".repeat(64)}`);
  assert.equal(JSON.parse(readFileSync(provenance)).sdk.sourceSha, candidate.manifest.sdk.source.commit);
  const badRun = [...args]; badRun[badRun.lastIndexOf(candidate.manifest.run.attempt)] = "3";
  assert.throws(() => execFileSync(process.execPath, badRun, { stdio: "pipe" }));
});

test("published SDK preparerは7-file directoryとGitHub releaseの8 assetsを別proofへ固定する", () => {
  const candidate = candidateFixture();
  const sdkDirectory = temp("niho-photo-published-sdk-");
  for (const record of candidate.manifest.sdk.packages) {
    const stage = temp("niho-photo-sdk-package-");
    put(stage, "package/index.txt", `${record.id}\n`);
    execFileSync("tar", ["-czf", path.join(sdkDirectory, record.file), "-C", stage, "package"]);
    const bytes = readFileSync(path.join(sdkDirectory, record.file));
    record.sha256 = sha256(bytes);
    record.bytes = bytes.length;
  }
  const sdkManifest = sdkManifestFixture(candidate);
  const manifestBytes = Buffer.from(`${JSON.stringify(sdkManifest, null, 2)}\n`);
  candidate.manifest.sdk.manifestSha256 = sha256(manifestBytes);
  writeFileSync(path.join(sdkDirectory, candidate.manifest.sdk.manifestFile), manifestBytes);
  const receipt = {
    schemaVersion: 1, repository: candidate.manifest.repository, sourceSha: candidate.manifest.sdk.source.commit,
    sourceOwnershipDigest: candidate.manifest.sourceOwnership.digest, version: candidate.manifest.sdk.version, runId: "50", runAttempt: "1",
    artifact: { id: "90", name: `niho-photo-sdk-${candidate.manifest.sdk.source.commit}-run-50-attempt-1`, digest: `sha256:${"a".repeat(64)}` },
    releaseManifest: { file: candidate.manifest.sdk.manifestFile, sha256: candidate.manifest.sdk.manifestSha256 },
  };
  const receiptFile = path.join(temp("niho-photo-sdk-receipt-"), "photo-sdk-artifact-receipt.json");
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  const assets = [
    ...candidate.manifest.sdk.packages.map(({ file: name }) => ({ name, size: statSync(path.join(sdkDirectory, name)).size })),
    { name: candidate.manifest.sdk.manifestFile, size: manifestBytes.length },
    { name: "photo-sdk-artifact-receipt.json", size: statSync(receiptFile).size },
  ];
  const releaseFile = path.join(temp("niho-photo-sdk-release-input-"), "release.json");
  writeFileSync(releaseFile, JSON.stringify({ id: 123, tag_name: `photo-sdk-v${candidate.manifest.sdk.version}`, target_commitish: candidate.manifest.sdk.source.commit, draft: false, prerelease: false, published_at: "2026-10-22T00:00:00Z", assets }));
  const output = path.join(temp("niho-photo-sdk-proof-parent-"), "sdk-proof");
  const githubOutput = path.join(temp("niho-photo-sdk-output-"), "output.txt");
  assert.doesNotThrow(() => preparePublishedSdkProof({ "--sdk-directory": sdkDirectory, "--sdk-receipt": receiptFile, "--release-json": releaseFile, "--tag-sha": candidate.manifest.sdk.source.commit, "--expected-version": candidate.manifest.sdk.version, "--expected-manifest-sha256": candidate.manifest.sdk.manifestSha256, "--output": output, "--github-output": githubOutput }));
  assert.deepEqual(JSON.parse(readFileSync(path.join(output, "photo-sdk-release.json"))).assets.map(({ name }) => name).sort(), assets.map(({ name }) => name).sort());
  assert.match(readFileSync(githubOutput, "utf8"), /sdk-manifest-sha256=/u);
});


test("prepared npm依存はnested workspaceと相対linkをbuild workspace内に再現する", () => {
  const prepared = temp("photo-prepared-deps-");
  const workspace = temp("photo-staged-deps-");
  const rootManifest = JSON.stringify({ workspaces: ["apps/camera", "packages/editor"] });
  for (const target of [prepared, workspace]) {
    put(target, "package.json", rootManifest);
    put(target, "package-lock.json", "same lock\n");
    put(target, "apps/camera/package.json", JSON.stringify({ type: "module", name: "camera" }));
    put(target, "packages/editor/package.json", JSON.stringify({ type: "module", name: "editor", exports: "./index.js" }));
  }
  put(prepared, "packages/editor/index.js", 'export default "original-source-must-not-load";\n');
  put(workspace, "packages/editor/index.js", 'export default "build-source";\n');
  mkdirSync(path.join(prepared, "node_modules"));
  symlinkSync("../packages/editor", path.join(prepared, "node_modules/editor"), "dir");
  put(prepared, "apps/camera/node_modules/camera-only/package.json", JSON.stringify({ type: "module", exports: "./index.js" }));
  put(prepared, "apps/camera/node_modules/camera-only/index.js", 'export default "nested-dependency";\n');
  assert.deepEqual(stagePreparedNodeDependencies({ nodeModules: path.join(prepared, "node_modules"), workspace }), ["node_modules", "apps/camera/node_modules"]);
  put(workspace, "apps/camera/probe.mjs", 'import nested from "camera-only"; import editor from "editor"; console.log(nested + ":" + editor);\n');
  const result = execFileSync(process.execPath, [path.join(workspace, "apps/camera/probe.mjs")], { encoding: "utf8", cwd: "/" });
  assert.equal(result.trim(), "nested-dependency:build-source");
  assert.throws(() => stagePreparedNodeDependencies({ nodeModules: path.join(prepared, "node_modules"), workspace }), /新規path/u);
  const mismatched = temp("photo-mismatched-deps-");
  put(mismatched, "package.json", rootManifest);
  put(mismatched, "package-lock.json", "different lock\n");
  assert.throws(() => stagePreparedNodeDependencies({ nodeModules: path.join(prepared, "node_modules"), workspace: mismatched }), /manifest\/lock/u);
});


test("Tauriのgen/schemasは生成物とし、それ以外のsource追加・変更を拒否する", () => {
  const workspace = temp("photo-source-snapshot-");
  put(workspace, "apps/camera/src/main.tsx", "source\n");
  const before = sourceSnapshot(workspace);
  put(workspace, "apps/camera/src-tauri/gen/schemas/desktop-schema.json", "generated schema\n");
  assertExpectedWorkspaceChanges(before, sourceSnapshot(workspace));
  put(workspace, "apps/camera/src/unexpected.ts", "unexpected source\n");
  assert.throws(() => assertExpectedWorkspaceChanges(before, sourceSnapshot(workspace)), /unexpected\.ts/u);
});

test("公開byte検査の診断は対象fileと種別だけを表示し検出値を出さない", () => {
  const privateValue = ["", "private", "test-build-root", "src.rs"].join("/");
  assert.throws(() => assertCandidatePublicBytes(Buffer.from(`\0${privateValue}`), undefined, "Contents/MacOS/tool"), (error) => error.message.includes("Contents/MacOS/tool") && error.message.includes("absolute-path") && !error.message.includes(privateValue));
});

test("official buildは新規の隔離directoryを作ってから別名pathと実pathをremapする", () => {
  const actual = temp("candidate-isolated-real-");
  const alias = path.join(temp("candidate-isolated-alias-"), "root");
  symlinkSync(actual, alias, "dir");
  const isolatedRoot = path.join(alias, "new-isolated");
  const env = officialBuildEnvironment({ HOME: actual, PATH: "/usr/bin" }, { workspace: actual, isolatedRoot, publicFirebaseKey: `AIza${"A".repeat(35)}` });
  assert.ok(env.CARGO_ENCODED_RUSTFLAGS.includes(`${isolatedRoot}=build-temp`));
  assert.ok(env.CARGO_ENCODED_RUSTFLAGS.includes(`${realpathSync(isolatedRoot)}=build-temp`));
});


function runtimeMachoFixture(bundle) {
  const header = Buffer.alloc(32), segment = Buffer.alloc(152);
  header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(0x0100000c, 4); header.writeUInt32LE(2, 12);
  header.writeUInt32LE(1, 16); header.writeUInt32LE(152, 20);
  segment.writeUInt32LE(0x19); segment.writeUInt32LE(152, 4); segment.write("__DATA_CONST", 8);
  segment.writeBigUInt64LE(0x1000000b8n, 24); segment.writeBigUInt64LE(BigInt(bundle.length), 32);
  segment.writeBigUInt64LE(184n, 40); segment.writeBigUInt64LE(BigInt(bundle.length), 48); segment.writeUInt32LE(1, 64);
  segment.write("__niho_runtime", 72); segment.write("__DATA_CONST", 88);
  segment.writeBigUInt64LE(0x1000000b8n, 104); segment.writeBigUInt64LE(BigInt(bundle.length), 112); segment.writeUInt32LE(184, 120);
  return Buffer.concat([header, segment, bundle]);
}

test("Tauriが配信する専用sectionのruntime実bytesをSDKへ照合し、URLだけ・改変を拒否する", () => {
  const workspace = temp("candidate-runtime-bundle-");
  const values = new Map([["runtime.js", Buffer.from("export {};\n")], ["runtime.wasm", Buffer.from("\0asmfixture")], ["runtime.d.ts", Buffer.from("export {};\n")], ["manifest-0.25.0.json", Buffer.from("{}\n")]]);
  const record = (name) => ({ name, sha256: sha256(values.get(name)), size: values.get(name).length });
  const sdk = { engine: { version: "niho-13", runtimeFiles: [...values.keys()].filter((name) => !name.startsWith("manifest-")).map(record), manifest: { ...record("manifest-0.25.0.json"), file: "manifest-0.25.0.json" } } };
  for (const [name, data] of values) put(workspace, `packages/develop-engine/public/develop-engine/niho-13/${name}`, data);
  const output = path.join(workspace, "runtime.bundle");
  stageRuntimeAssetBundle(workspace, sdk, output);
  const bundle = readFileSync(output);
  assert.equal(verifyRuntimeAssetBundle(machoRuntimeSection(runtimeMachoFixture(bundle)), sdk), true);
  const tampered = Buffer.from(bundle); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => verifyRuntimeAssetBundle(machoRuntimeSection(runtimeMachoFixture(tampered)), sdk), /実bytes/u);
  assert.throws(() => machoRuntimeSection(Buffer.from("/develop-engine/niho-13/runtime.wasm")), /Mach-O/u);
  const malformed = runtimeMachoFixture(bundle); malformed.writeUInt32LE(0xffffffff, 32 + 120);
  assert.throws(() => machoRuntimeSection(malformed), /bounds/u);
});


test("binary string poolで公開configに定数が隣接しても完全一致分だけを除き、別keyは拒否する", () => {
  const key = `AIza${"A".repeat(35)}`;
  assert.doesNotThrow(() => assertCandidatePublicBytes(Buffer.from(`prefix${key}nextConstant`), key));
  assert.throws(() => assertCandidatePublicBytes(Buffer.from(`${key}nextConstant AIza${"B".repeat(35)}`), key), /許可されていない/u);
});


test("production builderと同じ入口で実lock inventoryをSBOM bytesへ直列化する", () => {
  const sbom = JSON.parse(candidateSbomBytes(root, "a".repeat(40)).toString("utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.metadata.component.version, "a".repeat(40));
  assert.ok(sbom.components.length > 0);
});

test("完成tarの外側hashを更新しても検証後のapp改変・追加・実行属性変更を拒否する", () => {
  for (const mutate of [
    (fixture) => put(fixture.appRoot, "NIHO photo.app/Contents/MacOS/niho-camera", "modified binary\n"),
    (fixture) => put(fixture.appRoot, "NIHO photo.app/Contents/extra.txt", "unexpected\n"),
    (fixture) => chmodSync(path.join(fixture.appRoot, "NIHO photo.app/Contents/MacOS/niho-camera"), 0o644),
  ]) {
    const fixture = candidateFixture();
    assert.doesNotThrow(() => verifyCandidateDirectory(fixture.directory));
    mutate(fixture);
    const archive = path.join(fixture.directory, fixture.names.tarName);
    rmSync(archive);
    packAppTar(path.join(fixture.appRoot, "NIHO photo.app"), archive);
    const bytes = readFileSync(archive);
    Object.assign(fixture.manifest.assets.find((item) => item.name === fixture.names.tarName), { sha256: sha256(bytes), bytes: bytes.length });
    writeFileSync(path.join(fixture.directory, fixture.manifestFile), JSON.stringify(fixture.manifest));
    assert.throws(() => verifyCandidateDirectory(fixture.directory), /tar inventory/u);
  }
});

test("executable/native/calibrationのproofは同じapp inventoryのhashと一致しなければならない", () => {
  for (const select of [(m) => m.app.executable, (m) => m.app.native[0], (m) => m.app.calibration[0]]) {
    const fixture = candidateFixture();
    select(fixture.manifest).sha256 = "0".repeat(64);
    writeFileSync(path.join(fixture.directory, fixture.manifestFile), JSON.stringify(fixture.manifest));
    assert.throws(() => verifyCandidateDirectory(fixture.directory), /inventory/u);
  }
});

test("実DMGをreadonlyで開き、梱包時の改変・追加・実行属性の違いを検証済みinventoryへ照合する", { skip: process.platform !== "darwin" }, () => {
  const stage = temp("niho-photo-public-dmg-fixture-");
  const app = path.join(stage, "NIHO photo.app");
  put(stage, "NIHO photo.app/Contents/MacOS/niho-camera", "synthetic app data; never executed\n");
  chmodSync(path.join(app, "Contents/MacOS/niho-camera"), 0o755);
  const expected = inventoryTree(app);
  const image = path.join(stage, "valid.dmg");
  const proof = packDmg(app, image, expected);
  assert.equal(proof.sha256, sha256(readFileSync(image)));
  assert.doesNotThrow(() => verifyDmgInventory(image, expected));
  for (const mutation of [
    (files) => { files[0].sha256 = "0".repeat(64); },
    (files) => { files.push({ path: "Contents/extra.txt", sha256: "0".repeat(64), bytes: 1, executable: false }); },
    (files) => { files[0].executable = false; },
  ]) {
    const mismatch = structuredClone(expected);
    mutation(mismatch);
    assert.throws(() => verifyDmgInventory(image, mismatch), /DMG.*inventory/u);
  }
  put(stage, "NIHO photo.app/Contents/MacOS/niho-camera", "changed after verifyBuiltApp\n");
  assert.throws(() => packDmg(app, path.join(stage, "changed.dmg"), expected), /DMG.*inventory/u);
  const hidden = temp("niho-photo-hidden-dmg-");
  cpSync(app, path.join(hidden, "NIHO photo.app"), { recursive: true });
  symlinkSync("/Applications", path.join(hidden, "Applications"));
  put(hidden, ".Trashes/payload.txt", "synthetic hidden content\n");
  const hiddenImage = path.join(stage, "hidden.dmg");
  execFileSync("/usr/bin/hdiutil", ["create", "-volname", "NIHO photo", "-srcfolder", hidden, "-format", "UDZO", hiddenImage], { stdio: "pipe", timeout: 120_000 });
  assert.throws(() => verifyDmgInventory(hiddenImage, inventoryTree(app)), /DMG root.*metadata payload/u);
});

test("app inventoryは実行bitが同じでもSUID/SGID/stickyを拒否する", () => {
  const app = temp("niho-photo-permission-fixture-");
  put(app, "Contents/MacOS/niho-camera", "synthetic bytes; never executed\n");
  const binary = path.join(app, "Contents/MacOS/niho-camera");
  chmodSync(binary, 0o755);
  assert.doesNotThrow(() => inventoryTree(app));
  for (const mode of [0o4755, 0o2755, 0o1755]) {
    chmodSync(binary, mode);
    assert.throws(() => inventoryTree(app), /SUID\/SGID\/sticky/u);
  }
});

test("DMG rootはappと固定Applications linkだけを許可し、隠しmetadataのpayloadも拒否する", () => {
  const root = temp("niho-photo-dmg-root-");
  mkdirSync(path.join(root, "NIHO photo.app"));
  symlinkSync("/Applications", path.join(root, "Applications"));
  assert.doesNotThrow(() => assertDmgRoot(root));
  for (const name of [".DS_Store", ".Trashes", ".fseventsd", ".Spotlight-V100", ".HFS+ Private Directory Data\r"]) {
    put(root, name === ".DS_Store" ? name : `${name}/payload`, "synthetic hidden payload\n");
    assert.throws(() => assertDmgRoot(root), /metadata payload/u);
    rmSync(path.join(root, name), { recursive: true, force: true });
  }
});
