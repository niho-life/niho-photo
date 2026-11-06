#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const RELEASE_REPOSITORIES = new Set(["niho-coliving/niho-photo", "niho-life/niho-photo"]);
const PACKAGES_V1 = Object.freeze([
  ["ui", "niho-photo-ui"],
  ["photo-editing", "niho-photo-editing"],
  ["cloud-contract", "niho-photo-cloud-contract"],
  ["photo-contract", "niho-photo-contract"],
  ["develop-engine-source", "niho-photo-develop-engine-source"],
  ["develop-engine-runtime", "niho-photo-develop-engine-runtime"],
].map(Object.freeze));
const OWNED_PATHS_V1 = Object.freeze(["packages/photo-editing", "packages/ui", "packages/niho-cloud-contract", "packages/develop-engine", "packages/desktop-photo", "sdk", "scripts/sdk", "scripts/ci/cloud-contract-sync.mjs", "scripts/ci/image-metadata.mjs", "scripts/ci/photo-candidate-workflow-lib.mjs", "scripts/ci/photo-sdk-workflow-lib.mjs", "scripts/ci/publication-lib.mjs", "scripts/ci/release-evidence-lib.mjs", "scripts/ci/workflow-lib.mjs", "LICENSE.md", "ASSET_LICENSE.md", "TRADEMARKS.md", "THIRD_PARTY_NOTICES.md"]);
const OWNED_PATHS_V2 = Object.freeze([...OWNED_PATHS_V1, "packages/photo-library-contract"]);
const OWNED_PATHS_V3 = Object.freeze([...OWNED_PATHS_V2, "scripts/ci/photo-web-workflow-lib.mjs"]);
const PERSONAL_CLOUD_PACKAGE = Object.freeze(["personal-cloud-contract", "niho-photo-personal-cloud-contract"]);

export const SDK_RELEASE_PROFILES = Object.freeze({
  1: Object.freeze({ schemaVersion: 1, packages: PACKAGES_V1, ownedSourcePaths: OWNED_PATHS_V1, directoryFiles: 7 }),
  2: Object.freeze({
    schemaVersion: 2,
    packages: Object.freeze([...PACKAGES_V1.slice(0, 4), PERSONAL_CLOUD_PACKAGE, ...PACKAGES_V1.slice(4)]),
    ownedSourcePaths: OWNED_PATHS_V2,
    directoryFiles: 8,
  }),
  3: Object.freeze({
    schemaVersion: 3,
    packages: Object.freeze([...PACKAGES_V1.slice(0, 4), PERSONAL_CLOUD_PACKAGE, ...PACKAGES_V1.slice(4)]),
    ownedSourcePaths: OWNED_PATHS_V3,
    directoryFiles: 8,
  }),
});
const TOOLING_PATHS = ["package.json", "package-lock.json"];
const ENGINE_CONTRACT_PATHS = [
  "packages/photo-editing/src/develop-engine/develop-engine-manifest.ts",
  "packages/photo-editing/src/develop-engine/develop-settings.ts",
  "packages/develop-engine/crates/niho-develop/src/settings.rs",
];
const ENGINE_BUILD_INPUT_PATHS = [
  "packages/develop-engine/Cargo.lock",
  "packages/develop-engine/Cargo.toml",
  "packages/develop-engine/rust-toolchain.toml",
  "packages/develop-engine/crates/niho-develop-wasm/Cargo.toml",
  "packages/develop-engine/crates/niho-develop-wasm/src/lib.rs",
];

export class ReleaseArtifactError extends Error {}

export function normalizeArtifactDigest(value) {
  const raw = typeof value === "string" && value.startsWith("sha256:") ? value.slice(7) : value;
  if (!SHA256.test(raw ?? "")) throw new ReleaseArtifactError("artifact digestが不正です");
  return `sha256:${raw}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function strictSemver(value) {
  const match = typeof value === "string" ? SEMVER.exec(value) : null;
  if (!match || (match[4]?.split(".") ?? []).some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"))) throw new ReleaseArtifactError("SDK versionが不正です");
  return value;
}

function recordsValid(records, expectedPaths) {
  return Array.isArray(records) && records.length === expectedPaths.length && records.every((record, index) => record?.path === expectedPaths[index] && SHA256.test(record.sha256 ?? "") && record.integrity === `sha256-${Buffer.from(record.sha256, "hex").toString("base64")}` && Number.isSafeInteger(record.size) && record.size > 0);
}

function ownershipDigest(records) {
  return sha256(Buffer.from(records.map(({ path: ownedPath, sha256: digest, files }) => `${ownedPath}\0${digest}\0${files}\n`).join("")));
}

function hasExactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function sdkReleaseProfile(schemaVersion) {
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) throw new ReleaseArtifactError("release manifest schema profileが不正です");
  const profile = SDK_RELEASE_PROFILES[schemaVersion];
  if (!profile) throw new ReleaseArtifactError("release manifest schema profileが不正です");
  return profile;
}

function tarEntries(tarball) {
  let output;
  try {
    output = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    throw new ReleaseArtifactError("SDK tarballを読めません");
  }
  const entries = output.split("\n").filter(Boolean);
  if (!entries.length || entries.some((entry) => !entry.startsWith("package/") || entry.includes("\\") || entry.split("/").some((part) => part === ".."))) throw new ReleaseArtifactError("SDK tarball pathが不正です");
}

export function validateReleaseManifest(manifest, expectedSource) {
  const profile = sdkReleaseProfile(manifest?.schemaVersion);
  const packages = new Map(profile.packages);
  if (!hasExactKeys(manifest, ["schemaVersion", "releaseReady", "repository", "version", "source", "sourceOwnership", "buildTooling", "packages", "engine", "recipeCompatibility", "uiSingleton"])) throw new ReleaseArtifactError("release manifest top-level key集合が不正です");
  strictSemver(manifest?.version);
  if (manifest.releaseReady !== true || !RELEASE_REPOSITORIES.has(manifest.repository) || !COMMIT.test(manifest.source?.commit ?? "") || !COMMIT.test(manifest.source?.tree ?? "") || (expectedSource !== undefined && manifest.source.commit !== expectedSource)) throw new ReleaseArtifactError("release manifest基本契約が不正です");
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== packages.size) throw new ReleaseArtifactError("SDK package集合が不正です");
  const ids = new Set();
  const names = new Set();
  const files = new Set();
  for (const item of manifest.packages) {
    if (!hasExactKeys(item, ["id", "name", "file", "sha256", "integrity", "size"]) || packages.get(item?.id) !== item?.name || ids.has(item.id) || names.has(item.name) || files.has(item.file) || !SAFE_FILE.test(item.file ?? "") || !item.file.endsWith(".tgz") || !SHA256.test(item.sha256 ?? "") || item.integrity !== `sha256-${Buffer.from(item.sha256, "hex").toString("base64")}` || !Number.isSafeInteger(item.size) || item.size <= 0) throw new ReleaseArtifactError("SDK package recordが不正です");
    ids.add(item.id);
    names.add(item.name);
    files.add(item.file);
  }
  if ([...packages.keys()].some((id) => !ids.has(id))) throw new ReleaseArtifactError("SDK package必須集合が不足しています");
  const ownership = manifest.sourceOwnership;
  if (!hasExactKeys(ownership, ["algorithm", "digest", "paths"]) || ownership.algorithm !== "sha256-git-file-set-v1" || !SHA256.test(ownership.digest ?? "") || !Array.isArray(ownership.paths) || ownership.paths.length !== profile.ownedSourcePaths.length || ownership.paths.some((record, index) => !hasExactKeys(record, ["path", "sha256", "files"]) || record.path !== profile.ownedSourcePaths[index] || !SHA256.test(record.sha256 ?? "") || !Number.isSafeInteger(record.files) || record.files <= 0) || ownership.digest !== ownershipDigest(ownership.paths)) throw new ReleaseArtifactError("SDK owned source契約が不正です");
  if (manifest.buildTooling?.node !== "24.x" || !recordsValid(manifest.buildTooling?.files, TOOLING_PATHS)) throw new ReleaseArtifactError("SDK build tooling契約が不正です");
  const engine = manifest.engine;
  if (!/^niho-[1-9]\d*$/u.test(engine?.version ?? "")) throw new ReleaseArtifactError("SDK engine契約が不正です");
  strictSemver(engine.crateVersion);
  if (!recordsValid(engine.contracts, ENGINE_CONTRACT_PATHS) || !recordsValid(engine.buildInputs, ENGINE_BUILD_INPUT_PATHS)) throw new ReleaseArtifactError("SDK engine source pinが不正です");
  if (engine.manifest?.file !== `manifest-${engine.crateVersion}.json` || !SHA256.test(engine.manifest?.sha256 ?? "") || engine.manifest?.integrity !== `sha256-${Buffer.from(engine.manifest.sha256, "hex").toString("base64")}` || !Number.isSafeInteger(engine.manifest?.size) || engine.manifest.size <= 0) throw new ReleaseArtifactError("SDK engine manifest recordが不正です");
  if (!Array.isArray(engine.runtimeFiles) || ![".js", ".wasm", ".d.ts"].every((extension) => engine.runtimeFiles.some(({ name }) => name?.endsWith(extension)))) throw new ReleaseArtifactError("SDK engine runtime closureが不正です");
  const runtimeNames = new Set();
  const runtimeRecord = (file) => {
    if (!SAFE_FILE.test(file?.name ?? "") || runtimeNames.has(file.name) || !SHA256.test(file.sha256 ?? "") || file.integrity !== `sha256-${Buffer.from(file.sha256, "hex").toString("base64")}` || !Number.isSafeInteger(file.size) || file.size <= 0) throw new ReleaseArtifactError("SDK engine runtime recordが不正です");
    runtimeNames.add(file.name);
  };
  for (const file of engine.runtimeFiles) runtimeRecord(file);
  // スレッドの版（#151）。これより前の公開済みSDKには無い（candidateは公開済みSDKを読む）ので、あるときだけ照合する。
  if (engine.threads !== undefined) {
    const threadsFiles = engine.threads?.runtimeFiles;
    if (!Array.isArray(threadsFiles) || Object.keys(engine.threads).length !== 1 || ![".js", ".wasm", ".d.ts"].every((extension) => threadsFiles.some((file) => file?.name?.endsWith(extension)))) throw new ReleaseArtifactError("SDK engine threads runtime closureが不正です");
    for (const file of threadsFiles) runtimeRecord(file);
  }
  const recipe = manifest.recipeCompatibility;
  if (recipe?.format !== "javascript-esm-with-declarations" || JSON.stringify(recipe.supportedVersions) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]) || recipe.nodeRuntimeValidator !== true || recipe.package !== "niho-photo-contract" || recipe.export !== "." || !Array.isArray(recipe.engineIdentifiers) || new Set(recipe.engineIdentifiers).size !== recipe.engineIdentifiers.length || !recipe.engineIdentifiers.includes(engine.version)) throw new ReleaseArtifactError("SDK recipe契約が不正です");
  if (manifest.uiSingleton?.package !== "niho-photo-ui" || manifest.uiSingleton?.hostExport !== "niho-photo-editing/sdk-dialog-host" || typeof manifest.uiSingleton?.requirement !== "string" || manifest.uiSingleton.requirement.length < 16) throw new ReleaseArtifactError("SDK UI singleton契約が不正です");
  return manifest;
}

export function verifyManifestPackageFiles({ manifest, directory, manifestFile, exactDirectory = false }) {
  const expected = new Set([...(manifestFile ? [manifestFile] : []), ...manifest.packages.map(({ file }) => file)]);
  if (exactDirectory) {
    const actual = readdirSync(directory).sort();
    if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) throw new ReleaseArtifactError("artifact file集合がmanifestと一致しません");
  }
  for (const item of manifest.packages) {
    const packagePath = path.join(directory, item.file);
    const stat = lstatSync(packagePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ReleaseArtifactError("SDK packageは通常ファイルが必要です");
    const bytes = readFileSync(packagePath);
    if (bytes.length !== item.size || sha256(bytes) !== item.sha256) throw new ReleaseArtifactError("SDK package hashが一致しません");
    tarEntries(packagePath);
  }
  return manifest;
}

export function verifyReleaseArtifact({ directory, expectedSource, expectedManifestSha256 }) {
  if (!path.isAbsolute(directory) || !COMMIT.test(expectedSource ?? "")) throw new ReleaseArtifactError("artifact検証入力が不正です");
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ReleaseArtifactError("artifactは通常directoryが必要です");
  const names = readdirSync(directory).sort();
  const manifests = names.filter((name) => /^niho-photo-sdk-.+-[a-f0-9]{40}\.json$/u.test(name));
  if (manifests.length !== 1 || !Object.values(SDK_RELEASE_PROFILES).some(({ directoryFiles }) => names.length === directoryFiles)) throw new ReleaseArtifactError("artifact file集合が不正です");
  for (const name of names) {
    if (!SAFE_FILE.test(name)) throw new ReleaseArtifactError("artifact file名が不正です");
    const item = lstatSync(path.join(directory, name));
    if (!item.isFile() || item.isSymbolicLink()) throw new ReleaseArtifactError("artifactのsymlink・特殊fileは禁止です");
  }
  const manifestFile = manifests[0];
  const manifestBytes = readFileSync(path.join(directory, manifestFile));
  const manifestSha256 = sha256(manifestBytes);
  if (expectedManifestSha256 !== undefined && (!SHA256.test(expectedManifestSha256) || manifestSha256 !== expectedManifestSha256)) throw new ReleaseArtifactError("release manifest輸送hashが一致しません");
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { throw new ReleaseArtifactError("release manifestがJSONではありません"); }
  validateReleaseManifest(manifest, expectedSource);
  if (manifestFile !== `niho-photo-sdk-${manifest.version}-${expectedSource}.json`) throw new ReleaseArtifactError("release manifest file名が不正です");
  verifyManifestPackageFiles({ manifest, directory, manifestFile, exactDirectory: true });
  return { manifest, manifestFile, manifestSha256, assets: names };
}

function parseArguments(argv) {
  const allowed = new Set(["--directory", "--expected-source", "--expected-manifest-sha256", "--github-output", "--receipt", "--artifact-id", "--artifact-digest", "--artifact-name", "--run-id", "--run-attempt"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || values[key] !== undefined) throw new ReleaseArtifactError("artifact verifier引数が不正です");
    values[key] = value;
  }
  if (!values["--directory"] || !values["--expected-source"]) throw new ReleaseArtifactError("artifact verifier引数が不足しています");
  return values;
}

function writeReceipt(file, result, values) {
  const artifactId = values["--artifact-id"];
  const artifactDigest = values["--artifact-digest"];
  const artifactName = values["--artifact-name"];
  const runId = values["--run-id"];
  const runAttempt = values["--run-attempt"];
  const canonicalArtifactDigest = normalizeArtifactDigest(artifactDigest);
  if (!/^[1-9]\d*$/u.test(artifactId ?? "") || !/^niho-photo-sdk-[a-f0-9]{40}-run-[1-9]\d*-attempt-[1-9]\d*$/u.test(artifactName ?? "") || !/^[1-9]\d*$/u.test(runId ?? "") || !/^[1-9]\d*$/u.test(runAttempt ?? "") || artifactName !== `niho-photo-sdk-${result.manifest.source.commit}-run-${runId}-attempt-${runAttempt}`) throw new ReleaseArtifactError("artifact receipt入力が不正です");
  const receipt = {
    schemaVersion: 1,
    repository: result.manifest.repository,
    sourceSha: result.manifest.source.commit,
    sourceOwnershipDigest: result.manifest.sourceOwnership.digest,
    version: result.manifest.version,
    runId,
    runAttempt,
    artifact: { id: artifactId, name: artifactName, digest: canonicalArtifactDigest },
    releaseManifest: { file: result.manifestFile, sha256: result.manifestSha256 },
  };
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o644 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = parseArguments(process.argv.slice(2));
    const result = verifyReleaseArtifact({ directory: path.resolve(values["--directory"]), expectedSource: values["--expected-source"], expectedManifestSha256: values["--expected-manifest-sha256"] });
    if (values["--github-output"]) appendFileSync(values["--github-output"], `manifest-file=${result.manifestFile}\nmanifest-sha256=${result.manifestSha256}\nversion=${result.manifest.version}\nsource-sha=${result.manifest.source.commit}\nasset-count=${result.assets.length}\n`);
    if (values["--receipt"]) writeReceipt(path.resolve(values["--receipt"]), result, values);
    console.log(`SDK release artifactを検証しました（${result.assets.length} files）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "SDK release artifact検証に失敗しました");
    process.exitCode = 1;
  }
}
