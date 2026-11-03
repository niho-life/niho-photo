#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonBytes } from "../ci/release-evidence-lib.mjs";

import {
  CandidateError,
  applyVersionOverlay,
  assertOwnershipMatches,
  candidateBaseName,
  candidateContract,
  createCandidateSbom,
  extractSdkPackage,
  materializeGitTree,
  officialBuildEnvironment,
  packAppTar,
  packDmg,
  resolveCleanSource,
  sha256,
  sourceOwnership,
  stageCandidateNotices,
  stagePreparedNodeDependencies,
  stageRuntimeAssetBundle,
  verifyBuiltApp,
  verifyCandidateDirectory,
  verifySdkDirectory,
} from "./mac-candidate-lib.mjs";

const defaultRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new CandidateError(`${path.basename(command)}の実行に失敗しました（値は非表示）`);
  return String(result.stdout ?? "").trim();
}

function parse(argv) {
  const allowed = new Set([
    "--repo",
    "--sdk-directory",
    "--sdk-mode",
    "--sdk-manifest-sha256",
    "--app-source",
    "--version",
    "--public-firebase-config",
    "--node-modules",
    "--output",
    "--run-id",
    "--run-attempt",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || values[key] !== undefined) throw new CandidateError("candidate builder引数が不正です");
    values[key] = value;
  }
  for (const key of ["--sdk-directory", "--sdk-mode", "--app-source", "--version", "--public-firebase-config", "--node-modules", "--output", "--run-id", "--run-attempt"]) {
    if (!values[key]) throw new CandidateError(`candidate builderに${key}が必要です`);
  }
  return values;
}

function readPublicConfig(file) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new CandidateError("public Firebase build configは通常fileが必要です");
  let value;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new CandidateError("public Firebase build configがJSONではありません"); }
  if (Object.keys(value).length !== 1 || typeof value.NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY !== "string") throw new CandidateError("public Firebase build configのkey集合が不正です");
  return value.NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY;
}

const BUILD_OUTPUTS = ["node_modules", "packages/develop-engine/public", "apps/camera/public", "apps/camera/dist", "apps/camera/src-tauri/gen/schemas"];

export function sourceSnapshot(workspace) {
  const records = new Map();
  function visit(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative.split("/").includes("node_modules")) continue;
      if (BUILD_OUTPUTS.some((allowed) => relative === allowed || relative.startsWith(`${allowed}/`))) continue;
      const full = path.join(directory, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new CandidateError("build workspaceのsourceにsymlink・特殊fileがあります");
      if (stat.isDirectory()) visit(full, relative);
      else records.set(relative, sha256(readFileSync(full)));
    }
  }
  visit(workspace);
  return records;
}

export function assertExpectedWorkspaceChanges(before, after) {
  const overlay = new Set(candidateContract.overlayPaths);
  const added = [...after.keys()].filter((name) => !before.has(name));
  const removed = [...before.keys()].filter((name) => !after.has(name));
  if (added.length || removed.length) throw new CandidateError(`build workspaceのsource file集合が変わりました: added=${added.slice(0, 12).join(",")} removed=${removed.slice(0, 12).join(",")}`);
  for (const [name, digest] of before) {
    if (!overlay.has(name) && after.get(name) !== digest) throw new CandidateError("version overlay/buildが許可外sourceを変更しました");
  }
}

function stageRuntime({ sdkDirectory, sdkManifest, workspace, scratch }) {
  const extracted = path.join(scratch, "sdk-runtime");
  extractSdkPackage({ sdkDirectory, manifest: sdkManifest, packageId: "develop-engine-runtime", destination: extracted });
  const source = path.join(extracted, "develop-engine", sdkManifest.engine.version);
  const target = path.join(workspace, "packages/develop-engine/public/develop-engine", sdkManifest.engine.version);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  cpSync(source, target, { recursive: true });
}

function buildNative({ sdkDirectory, sdkManifest, workspace, scratch, env }) {
  const extracted = path.join(scratch, "sdk-engine-source");
  extractSdkPackage({ sdkDirectory, manifest: sdkManifest, packageId: "develop-engine-source", destination: extracted });
  const output = path.join(scratch, "native-stage");
  run(process.execPath, [
    path.join(extracted, "engine/build-macos-native.mjs"),
    "--engine", path.join(extracted, "engine"),
    "--lock", path.join(workspace, "apps/camera/develop-sidecars.lock.json"),
    "--output", output,
  ], { env, stdio: "inherit" });
  return { output, manifest: JSON.parse(readFileSync(path.join(output, "native-build-manifest.json"), "utf8")) };
}

function toolchain(workspace, env) {
  const camera = path.join(workspace, "apps/camera");
  return {
    node: process.version,
    rust: run("rustc", ["--version"], { cwd: camera, env }).split("\n")[0],
    swift: run("swift", ["--version"], { env }).split("\n")[0],
    tauri: run(path.join(workspace, "node_modules/.bin/tauri"), ["--version"], { cwd: camera, env }).split("\n")[0],
    target: "aarch64-apple-darwin",
  };
}

export function candidateSbomBytes(workspace, commit) {
  return jsonBytes(createCandidateSbom(workspace, commit));
}

export function buildCandidate(values) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new CandidateError("Mac candidate buildはApple Silicon macOS専用です");
  const repoRoot = path.resolve(values["--repo"] ?? defaultRepo);
  const source = resolveCleanSource(repoRoot, values["--app-source"]);
  const sdkDirectory = path.resolve(values["--sdk-directory"]);
  const sdk = verifySdkDirectory({
    directory: sdkDirectory,
    mode: values["--sdk-mode"],
    appSource: source.commit,
    expectedManifestSha256: values["--sdk-manifest-sha256"],
  });
  const ownership = sourceOwnership(repoRoot, source.commit, sdk.manifest.schemaVersion);
  assertOwnershipMatches(ownership, sdk.manifest.sourceOwnership);
  const publicFirebaseKey = readPublicConfig(path.resolve(values["--public-firebase-config"]));
  const nodeModules = path.resolve(values["--node-modules"]);
  const output = path.resolve(values["--output"]);
  if (lstatSync(output, { throwIfNoEntry: false })) throw new CandidateError("candidate outputは新規directoryが必要です");
  const scratch = mkdtempSync(path.join(tmpdir(), "niho-photo-candidate-"));
  try {
    const workspace = path.join(scratch, "workspace");
    materializeGitTree(repoRoot, source.commit, workspace);
    const sourceBefore = sourceSnapshot(workspace);
    // Installはoverlay前にCIが済ませ、rootとworkspace固有の依存を同じlayoutへstageする。
    stagePreparedNodeDependencies({ nodeModules, workspace });
    stageRuntime({ sdkDirectory, sdkManifest: sdk.manifest, workspace, scratch });
    const overlays = applyVersionOverlay(workspace, values["--version"]);
    assertExpectedWorkspaceChanges(sourceBefore, sourceSnapshot(workspace));
    const isolated = path.join(scratch, "isolated");
    const env = officialBuildEnvironment(process.env, { workspace, isolatedRoot: isolated, publicFirebaseKey,
      cloudBuildProof: { sdkVersion: sdk.manifest.version, crateVersion: sdk.manifest.engine.crateVersion,
        manifestSha256: sdk.manifest.engine.manifest.sha256, sdkSourceCommit: sdk.manifest.source.commit } });
    const runtimeBundle = stageRuntimeAssetBundle(workspace, sdk.manifest, path.join(isolated, "runtime.assetbundle"));
    const native = buildNative({ sdkDirectory, sdkManifest: sdk.manifest, workspace, scratch, env });
    const notices = stageCandidateNotices(workspace, path.join(scratch, "third-party-notices"));
    const camera = path.join(workspace, "apps/camera");
    const buildConfig = {
      bundle: {
        createUpdaterArtifacts: false,
        resources: { [`${notices.directory}/`]: "third-party-notices/" },
        macOS: { signingIdentity: "-", hardenedRuntime: false },
      },
    };
    run(path.join(workspace, "node_modules/.bin/tauri"), [
      "build",
      "--target", "aarch64-apple-darwin",
      "--bundles", "app",
      "--features", "official-updates",
      "--config", path.join(native.output, "tauri.native.conf.json"),
      "--config", JSON.stringify(buildConfig),
      "--", "--locked",
    ], { cwd: camera, env: { ...env, NIHO_PHOTO_RUNTIME_BUNDLE: runtimeBundle }, stdio: "inherit" });
    assertExpectedWorkspaceChanges(sourceBefore, sourceSnapshot(workspace));
    const appPath = path.join(env.CARGO_TARGET_DIR, "aarch64-apple-darwin/release/bundle/macos", `${candidateContract.product}.app`);
    const app = verifyBuiltApp({ appPath, workspace, version: values["--version"], sdkManifest: sdk.manifest, nativeManifest: native.manifest, expectedNotices: notices.files, allowedPublicFirebaseKey: publicFirebaseKey });
    const base = candidateBaseName({ version: values["--version"], sourceSha: source.commit, runId: values["--run-id"], runAttempt: values["--run-attempt"] });
    mkdirSync(output, { recursive: true, mode: 0o755 });
    const tarName = `${base}.app.tar.gz`, dmgName = `${base}.dmg`, sbomName = `${base}.cdx.json`;
    const tar = packAppTar(appPath, path.join(output, tarName));
    const dmg = packDmg(appPath, path.join(output, dmgName), app.files, { allowedPublicFirebaseKey: publicFirebaseKey });
    const sbomBytes = candidateSbomBytes(workspace, source.commit);
    writeFileSync(path.join(output, sbomName), sbomBytes, { flag: "wx", mode: 0o644 });
    const manifest = {
      schemaVersion: 1,
      repository: "niho-life/niho-photo",
      product: candidateContract.product,
      bundleId: candidateContract.bundleId,
      version: values["--version"],
      source,
      run: { id: values["--run-id"], attempt: values["--run-attempt"] },
      sdk: {
        ...(sdk.manifest.schemaVersion === 2 ? { sdkManifestSchemaVersion: 2 } : {}),
        mode: sdk.mode,
        version: sdk.manifest.version,
        source: sdk.manifest.source,
        manifestFile: sdk.manifestFile,
        manifestSha256: sdk.manifestSha256,
        packages: sdk.manifest.packages.map(({ id, name, file, sha256: digest, size }) => ({ id, name, file, sha256: digest, bytes: size })),
      },
      sourceOwnership: ownership,
      publicAccountConfig: { name: "NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY", sha256: sha256(Buffer.from(publicFirebaseKey)), included: true },
      build: { mode: "release", signing: "ad-hoc", officialUpdates: true, updaterArtifacts: false, toolchain: toolchain(workspace, env) },
      overlays,
      app,
      sbom: { format: "CycloneDX", specVersion: "1.6", sha256: sha256(sbomBytes), bytes: sbomBytes.length },
      assets: [
        { name: tarName, sha256: tar.sha256, bytes: tar.bytes },
        { name: sbomName, sha256: sha256(sbomBytes), bytes: sbomBytes.length },
        { name: dmgName, sha256: dmg.sha256, bytes: dmg.bytes },
      ],
    };
    const manifestName = `${base}.candidate.json`;
    writeFileSync(path.join(output, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    verifyCandidateDirectory(output);
    return { output, manifestName, base };
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildCandidate(parse(process.argv.slice(2)));
    console.log(`Mac candidateを生成しました: ${path.join(result.output, result.manifestName)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Mac candidate buildに失敗しました");
    process.exitCode = 1;
  }
}
