import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  realpathSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { assertSystemNativeSearchPaths } from "../../packages/develop-engine/build-macos-native.mjs";
import { parsePhotoCloudBuildProof } from "../../apps/camera/src/cloud-build-proof.ts";
import { assertPublicBytes, createSbom, lockfiles } from "../ci/release-evidence-lib.mjs";
import { readPublicSdkDependenciesSync } from "../ci/publication-lib.mjs";
import { normalizeArtifactDigest, sdkReleaseProfile, validateReleaseManifest, verifyManifestPackageFiles } from "../sdk/verify-release-artifact.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE_REPOSITORIES = new Set(["niho-coliving/niho-photo", "niho-life/niho-photo"]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const SAFE_ASSET = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const POSITIVE_INTEGER = /^[1-9]\d*$/u;
const MAX_ASSET_BYTES = 250 * 1024 * 1024;
const PRODUCT = "NIHO photo";
const BUNDLE_ID = "life.niho.camera";
const DEEP_LINK = "niho-camera";
const UPDATER_FEED = "https://niho.life/camera/updater/latest.json";
const EXPECTED_UPDATER_PUBLIC_KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFBNzVDN0FCNkY2QzBCN0UKUldSK0MyeHZxOGQxcW1vY3MyZlVFVjVXWjFJcjRpRGRHVnZmUy83UHZCR1FyQ05zSFZwVHVIaW0K";
const NOTICE_SOURCES = Object.freeze({
  "LICENSE.md": "LICENSE.md",
  "ASSET_LICENSE.md": "ASSET_LICENSE.md",
  "TRADEMARKS.md": "TRADEMARKS.md",
  "THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md",
  "engine/LICENSES.md": "packages/develop-engine/LICENSES.md",
  "engine/Adobe-DNG-SDK-LICENSE.txt": "packages/develop-engine/licenses/Adobe-DNG-SDK-LICENSE.txt",
  "fonts/OFL-Nunito.txt": "packages/ui/src/fonts/OFL-Nunito.txt",
});
const OVERLAY_PATHS = [
  "apps/camera/package.json",
  "apps/camera/src-tauri/tauri.conf.json",
  "apps/camera/src-tauri/Cargo.toml",
  "apps/camera/src-tauri/Cargo.lock",
];

export class CandidateError extends Error {}
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new CandidateError(`${path.basename(command)}の実行に失敗しました（値は非表示）`);
  return String(result.stdout ?? "");
}

export function assertStrictVersion(version) {
  const match = typeof version === "string" ? SEMVER.exec(version) : null;
  if (!match || (match[4]?.split(".") ?? []).some((item) => /^\d+$/u.test(item) && item.length > 1 && item.startsWith("0"))) {
    throw new CandidateError("release versionはstrict semverが必要です");
  }
  return version;
}

function assertFullSha(value, label) {
  if (!COMMIT.test(value ?? "")) throw new CandidateError(`${label}はfull commit SHAが必要です`);
  return value;
}

function ordinaryFile(file, label) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new CandidateError(`${label}は通常fileが必要です`);
  return stat;
}

function boundedOrdinaryFile(file, label) {
  const stat = ordinaryFile(file, label);
  if (stat.size <= 0 || stat.size > MAX_ASSET_BYTES) throw new CandidateError(`${label}は250 MiB以下の非空fileが必要です`);
  return stat;
}

function ordinaryDirectory(directory, label) {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new CandidateError(`${label}は通常directoryが必要です`);
  return stat;
}

function git(repoRoot, args, options = {}) {
  return run("git", ["-C", repoRoot, ...args], options);
}

export function stagePreparedNodeDependencies({ nodeModules, workspace }) {
  ordinaryDirectory(nodeModules, "prepared node_modules");
  if (path.basename(nodeModules) !== "node_modules") throw new CandidateError("prepared依存のrootが不正です");
  const prepared = path.dirname(nodeModules);
  for (const name of ["package.json", "package-lock.json"]) {
    const source = path.join(prepared, name), target = path.join(workspace, name);
    ordinaryFile(source, `prepared ${name}`);
    if (!readFileSync(source).equals(readFileSync(target))) throw new CandidateError("prepared依存のroot manifest/lockがapp sourceと一致しません");
  }
  const manifest = JSON.parse(readFileSync(path.join(workspace, "package.json"), "utf8"));
  if (!Array.isArray(manifest.workspaces) || manifest.workspaces.some((name) => typeof name !== "string" || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/u.test(name))) throw new CandidateError("prepared依存のworkspace集合が不正です");
  const paths = ["node_modules"];
  for (const name of manifest.workspaces) {
    const source = path.join(prepared, name, "package.json");
    ordinaryFile(source, "prepared workspace manifest");
    if (!readFileSync(source).equals(readFileSync(path.join(workspace, name, "package.json")))) throw new CandidateError("prepared workspace依存がapp sourceと一致しません");
    const relative = `${name}/node_modules`;
    if (lstatSync(path.join(prepared, relative), { throwIfNoEntry: false })) {
      ordinaryDirectory(path.join(prepared, relative), "prepared workspace node_modules");
      paths.push(relative);
    }
  }
  for (const relative of paths) {
    const target = path.join(workspace, relative);
    if (lstatSync(target, { throwIfNoEntry: false })) throw new CandidateError("build依存の配置先は新規pathが必要です");
    // npm workspace/.binの相対symlinkは同じlayoutのbuild workspace内へ向ける。
    cpSync(path.join(prepared, relative), target, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
  }
  return paths;
}

export function resolveCleanSource(repoRoot, sourceRef) {
  ordinaryDirectory(repoRoot, "repository");
  assertFullSha(sourceRef, "app source");
  const commit = git(repoRoot, ["rev-parse", "--verify", `${sourceRef}^{commit}`]).trim();
  const tree = git(repoRoot, ["rev-parse", "--verify", `${commit}^{tree}`]).trim();
  if (commit !== sourceRef || !COMMIT.test(tree)) throw new CandidateError("app source Git objectを解決できません");
  if (git(repoRoot, ["rev-parse", "HEAD"]).trim() !== commit) throw new CandidateError("candidate app sourceはcurrent HEADのfull SHAが必要です");
  if (git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).length !== 0) throw new CandidateError("candidate buildはclean Gitだけを受け付けます");
  return { commit, tree };
}

function gitEntries(repoRoot, commit, ownedPath) {
  const output = run("git", ["-C", repoRoot, "ls-tree", "-rz", "--full-tree", commit, "--", ownedPath]);
  const records = output.split("\0").filter(Boolean);
  if (!records.length) throw new CandidateError(`SDK owned sourceがありません: ${ownedPath}`);
  return records.map((record) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(record);
    if (!match) throw new CandidateError("SDK owned sourceにsymlinkまたは特殊fileがあります");
    return { mode: match[1], object: match[2], file: match[3] };
  }).sort((a, b) => a.file.localeCompare(b.file, "en"));
}

function gitBytes(repoRoot, commit, file) {
  const result = spawnSync("git", ["-C", repoRoot, "show", `${commit}:${file}`], { maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new CandidateError("Git objectを読めません");
  return result.stdout;
}

function ownershipDigest(records) {
  return sha256(Buffer.from(records.map(({ path: ownedPath, sha256: digest, files }) => `${ownedPath}\0${digest}\0${files}\n`).join("")));
}

function candidateSdkManifestSchemaVersion(sdk) {
  if (sdk?.sdkManifestSchemaVersion === undefined) return 1;
  if (sdk.sdkManifestSchemaVersion !== 2) throw new CandidateError("candidate SDK manifest schema profileが不正です");
  return 2;
}

function jsonFile(file, label) {
  boundedOrdinaryFile(file, label);
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { throw new CandidateError(`${label}がJSONではありません`); }
}

export function sourceOwnership(repoRoot, commit, sdkManifestSchemaVersion = 1) {
  assertFullSha(commit, "ownership source");
  let profile;
  try { profile = sdkReleaseProfile(sdkManifestSchemaVersion); } catch { throw new CandidateError("SDK manifest schema profileが不正です"); }
  const records = profile.ownedSourcePaths.map((ownedPath) => {
    const entries = gitEntries(repoRoot, commit, ownedPath);
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

export function assertOwnershipMatches(actual, expected) {
  if (actual?.algorithm !== "sha256-git-file-set-v1" || expected?.algorithm !== actual.algorithm || actual.digest !== expected.digest || JSON.stringify(actual.paths) !== JSON.stringify(expected.paths)) {
    throw new CandidateError("app sourceとSDKのsourceOwnershipが一致しません");
  }
  return actual;
}

export function assertSdkSelection({ mode, appSource, sdkSource, manifestSha256, expectedManifestSha256 }) {
  if (!["published", "local-validation"].includes(mode)) throw new CandidateError("SDK modeが不正です");
  assertFullSha(appSource, "app source");
  assertFullSha(sdkSource, "SDK source");
  if (!SHA256.test(manifestSha256 ?? "")) throw new CandidateError("SDK manifest hashが不正です");
  if (mode === "published" && (!SHA256.test(expectedManifestSha256 ?? "") || expectedManifestSha256 !== manifestSha256)) throw new CandidateError("published SDK manifest輸送hashが一致しません");
  if (mode === "local-validation" && sdkSource !== appSource) throw new CandidateError("local-validation SDKはcurrent app sourceと同じcommitが必要です");
  return { mode, appSource, sdkSource, manifestSha256 };
}

export function verifySdkDirectory({ directory, mode, appSource, expectedManifestSha256 }) {
  ordinaryDirectory(directory, "SDK directory");
  const names = readdirSync(directory).sort();
  const manifests = names.filter((name) => /^niho-photo-sdk-.+-[a-f0-9]{40}\.json$/u.test(name));
  if (manifests.length !== 1 || names.some((name) => !SAFE_ASSET.test(name))) throw new CandidateError("SDK asset集合または名前が不正です");
  const manifestFile = manifests[0];
  const manifestPath = path.join(directory, manifestFile);
  const manifestBytes = readFileSync(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch { throw new CandidateError("SDK manifestがJSONではありません"); }
  validateReleaseManifest(manifest);
  const profile = sdkReleaseProfile(manifest.schemaVersion);
  if (names.length !== profile.directoryFiles) throw new CandidateError("SDK asset集合または名前が不正です");
  verifyManifestPackageFiles({ manifest, directory, manifestFile, exactDirectory: true });
  if (manifestFile !== `niho-photo-sdk-${manifest.version}-${manifest.source.commit}.json`) throw new CandidateError("SDK manifest名が不正です");
  assertSdkSelection({ mode, appSource, sdkSource: manifest.source.commit, manifestSha256, expectedManifestSha256 });
  return { manifest, manifestFile, manifestSha256, mode };
}

export function materializeGitTree(repoRoot, commit, destination) {
  if (lstatSync(destination, { throwIfNoEntry: false })) throw new CandidateError("build workspaceは新規directoryが必要です");
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  const archive = path.join(path.dirname(destination), `source-${commit}.tar`);
  run("git", ["-C", repoRoot, "archive", "--format=tar", `--output=${archive}`, commit]);
  try {
    run("tar", ["-xf", archive, "-C", destination]);
  } finally {
    rmSync(archive, { force: true });
  }
  return destination;
}

function replaceOnce(text, expression, replacement, label) {
  const matches = [...text.matchAll(new RegExp(expression.source, expression.flags.includes("g") ? expression.flags : `${expression.flags}g`))];
  if (matches.length !== 1) throw new CandidateError(`${label}のversion位置が一意ではありません`);
  return text.replace(expression, replacement);
}

export function applyVersionOverlay(workspace, version) {
  assertStrictVersion(version);
  const beforeTree = new Map();
  for (const relative of OVERLAY_PATHS) beforeTree.set(relative, readFileSync(path.join(workspace, ...relative.split("/"))));
  const packagePath = path.join(workspace, "apps/camera/package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  packageJson.version = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const tauriPath = path.join(workspace, "apps/camera/src-tauri/tauri.conf.json");
  const tauri = JSON.parse(readFileSync(tauriPath, "utf8"));
  tauri.version = version;
  writeFileSync(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);
  const cargoPath = path.join(workspace, "apps/camera/src-tauri/Cargo.toml");
  writeFileSync(cargoPath, replaceOnce(readFileSync(cargoPath, "utf8"), /^(version\s*=\s*)"[^"]+"/mu, `$1"${version}"`, "camera Cargo.toml"));
  const lockPath = path.join(workspace, "apps/camera/src-tauri/Cargo.lock");
  const lockText = readFileSync(lockPath, "utf8");
  writeFileSync(lockPath, replaceOnce(lockText, /(\[\[package\]\]\nname = "niho_camera"\nversion = )"[^"]+"/u, `$1"${version}"`, "camera Cargo.lock"));
  return OVERLAY_PATHS.map((relative) => {
    const before = beforeTree.get(relative), after = readFileSync(path.join(workspace, ...relative.split("/")));
    if (before.equals(after)) throw new CandidateError("version overlayが変更を生みませんでした");
    return { path: relative, beforeSha256: sha256(before), afterSha256: sha256(after) };
  });
}

export function officialBuildEnvironment(input, { workspace, isolatedRoot, publicFirebaseKey, cloudBuildProof = null }) {
  if (!path.isAbsolute(workspace) || !path.isAbsolute(isolatedRoot)) throw new CandidateError("official build隔離pathが不正です");
  if (typeof publicFirebaseKey !== "string" || !/^AIza[A-Za-z0-9_-]{30,}$/u.test(publicFirebaseKey)) throw new CandidateError("公式candidateには公開Firebase Web API keyが必要です");
  const proof = parsePhotoCloudBuildProof(cloudBuildProof);
  if (cloudBuildProof !== null && !proof) throw new CandidateError("公式candidateのPhoto SDK proofが不正です");
  const inherited = Object.fromEntries(["PATH", "LANG", "DEVELOPER_DIR", "SDKROOT"].filter((key) => input[key]).map((key) => [key, input[key]]));
  const rustupHome = input.RUSTUP_HOME || (input.HOME ? path.join(input.HOME, ".rustup") : undefined);
  if (!path.isAbsolute(rustupHome ?? "")) throw new CandidateError("Rust toolchainの保存先は絶対pathが必要です");
  const home = path.join(isolatedRoot, "home"), cargoHome = path.join(isolatedRoot, "cargo-home"), temporary = path.join(isolatedRoot, "tmp");
  for (const directory of [home, cargoHome, temporary]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const remap = [[workspace, "app-source"], [isolatedRoot, "build-temp"], [rustupHome, "rust-toolchain"], [input.HOME, "build-user"]]
    .filter(([from]) => from)
    .flatMap(([from, to]) => [...new Set([from, ...(existsSync(from) ? [realpathSync(from)] : [])])].map((prefix) => [prefix, to]))
    .sort(([left], [right]) => right.length - left.length)
    .map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  const npmUser = path.join(isolatedRoot, "npm-user.npmrc"), npmGlobal = path.join(isolatedRoot, "npm-global.npmrc");
  writeFileSync(npmUser, "", { mode: 0o600 });
  writeFileSync(npmGlobal, "", { mode: 0o600 });
  return {
    ...inherited,
    HOME: home,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
    TMPDIR: temporary,
    NPM_CONFIG_USERCONFIG: npmUser,
    NPM_CONFIG_GLOBALCONFIG: npmGlobal,
    RUSTUP_TOOLCHAIN: "1.98.1",
    CARGO_TARGET_DIR: path.join(isolatedRoot, "cargo-target"),
    CARGO_BUILD_JOBS: "2",
    CARGO_PROFILE_RELEASE_DEBUG: "0",
    CARGO_PROFILE_RELEASE_STRIP: "debuginfo",
    CARGO_ENCODED_RUSTFLAGS: remap.join("\x1f"),
    NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY: publicFirebaseKey,
    // Do not inherit caller declarations: this value comes from the verified SDK manifest.
    NIHO_PHOTO_CLOUD_BUILD_PROOF: JSON.stringify(proof),
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    CI: "true",
  };
}

export function assertCandidatePublicBytes(bytes, allowedPublicFirebaseKey, artifactPath = "candidate bytes") {
  let text = bytes.toString("utf8");
  // Rustのstring poolでは隣の定数が区切りなしで続く。許可した完全一致bytesだけを先に除き、残るkeyを拒否する。
  if (allowedPublicFirebaseKey) text = text.replaceAll(allowedPublicFirebaseKey, "P".repeat(allowedPublicFirebaseKey.length));
  if (/AIza[A-Za-z0-9_-]{30,}/u.test(text)) throw new CandidateError(`${artifactPath}: candidateに許可されていないAPI keyがあります（値は非表示）`);
  try { assertPublicBytes(Buffer.from(text)); } catch (error) { throw new CandidateError(`${artifactPath}: ${error.message}`); }
}

export function inventoryTree(root, { allowedPublicFirebaseKey } = {}) {
  ordinaryDirectory(root, "candidate tree");
  const files = [];
  function visit(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.mode & 0o7000)) throw new CandidateError("candidate treeのsymlink・特殊file・SUID/SGID/stickyは禁止です");
      if (/(?:^|\/)(?:\.git|node_modules|target|\.DS_Store|\.env[^/]*|logs?)(?:\/|$)|\.(?:map|dSYM|p8|p12|pem|key|log)$/iu.test(relative)) throw new CandidateError("candidate treeに禁止fileがあります");
      if (stat.isDirectory()) visit(full, relative);
      else {
        const bytes = readFileSync(full);
        assertCandidatePublicBytes(bytes, allowedPublicFirebaseKey, relative);
        files.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length, executable: Boolean(stat.mode & 0o111) });
      }
    }
  }
  visit(root);
  if (!files.length) throw new CandidateError("candidate treeが空です");
  return files;
}

export function validateTarEntries(entries, expectedRoot) {
  if (!Array.isArray(entries) || !entries.length || !expectedRoot.endsWith(".app")) throw new CandidateError("app tarが空です");
  const prefix = `${expectedRoot}/`;
  for (const entry of entries) {
    if (!entry || !["file", "directory"].includes(entry.type) || entry.name.includes("\\") || entry.name.startsWith("/") || entry.name.split("/").some((part) => part === "..") || (entry.name !== expectedRoot && !entry.name.startsWith(prefix))) {
      throw new CandidateError("app tarにpath traversal・special entry・escaping linkがあります");
    }
  }
  return entries;
}

function archiveEntries(archive) {
  ordinaryFile(archive, "archive");
  const names = run("tar", ["-tzf", archive]).split("\n").filter(Boolean).map((name) => name.replace(/\/$/u, ""));
  const verbose = run("tar", ["-tvzf", archive]).split("\n").filter(Boolean);
  if (names.length !== verbose.length) throw new CandidateError("archive entry検査が一致しません");
  return names.map((name, index) => ({ name: name.replace(/^\.\//u, ""), type: verbose[index].startsWith("d") ? "directory" : verbose[index].startsWith("-") ? "file" : "special" }));
}

export function inspectAppTar(archive, expectedRoot = `${PRODUCT}.app`) {
  return validateTarEntries(archiveEntries(archive), expectedRoot);
}

export function extractSdkPackage({ sdkDirectory, manifest, packageId, destination }) {
  const record = manifest.packages.find(({ id }) => id === packageId);
  if (!record) throw new CandidateError("SDK packageがありません");
  const archive = path.join(sdkDirectory, record.file);
  const entries = archiveEntries(archive);
  validateTarEntries(entries.map((entry) => ({ ...entry, name: entry.name.replace(/^package\/?/u, "NIHO photo.app/") })), `${PRODUCT}.app`);
  if (lstatSync(destination, { throwIfNoEntry: false })) throw new CandidateError("SDK extract先は新規directoryが必要です");
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  run("tar", ["-xzf", archive, "-C", destination, "--strip-components", "1"]);
  return record;
}

function plistValue(plist, key) {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, "u").exec(plist)?.[1];
}

function toolVersion(binary, name) {
  const output = run(binary, ["version"], { cwd: "/", env: { HOME: tmpdir(), PATH: "/usr/bin:/bin" }, timeout: 30_000 }).trim();
  const version = new RegExp(`^${name} (\\d+\\.\\d+\\.\\d+)(?:\\s|$)`, "u").exec(output)?.[1];
  if (!version) throw new CandidateError("bundled native tool version検査に失敗しました");
  return version;
}

function validateNoticeRecords(records) {
  if (!Array.isArray(records) || JSON.stringify(records.map((record) => record?.path).sort()) !== JSON.stringify(Object.keys(NOTICE_SOURCES).sort()) || records.some((record) => !SHA256.test(record.sha256 ?? "") || !Number.isSafeInteger(record.bytes) || record.bytes <= 0)) {
    throw new CandidateError("appのlicense/notice集合が不正です");
  }
  return records;
}

export function stageCandidateNotices(workspace, directory) {
  if (lstatSync(directory, { throwIfNoEntry: false })) throw new CandidateError("notice stageは新規directoryが必要です");
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  const files = Object.entries(NOTICE_SOURCES).map(([name, source]) => {
    const file = path.join(workspace, ...source.split("/"));
    ordinaryFile(file, "notice source");
    const bytes = readFileSync(file);
    const target = path.join(directory, ...name.split("/"));
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
    return { path: name, sha256: sha256(bytes), bytes: bytes.length };
  });
  return { directory, files: validateNoticeRecords(files) };
}

export function verifyAppNoticeResources(appPath, records) {
  for (const record of validateNoticeRecords(records)) {
    const file = path.join(appPath, "Contents/Resources/third-party-notices", ...record.path.split("/"));
    ordinaryFile(file, "bundled notice");
    const bytes = readFileSync(file);
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new CandidateError("bundled license/notice hashが一致しません");
  }
  return records;
}

export function verifyBuiltApp({ appPath, workspace, version, sdkManifest, nativeManifest, expectedNotices, allowedPublicFirebaseKey }) {
  assertStrictVersion(version);
  ordinaryDirectory(appPath, "NIHO photo.app");
  const contents = path.join(appPath, "Contents");
  const plist = readFileSync(path.join(contents, "Info.plist"), "utf8");
  if (plistValue(plist, "CFBundleIdentifier") !== BUNDLE_ID || plistValue(plist, "CFBundleShortVersionString") !== version || plistValue(plist, "CFBundleVersion") !== version || !plist.includes(`<string>${DEEP_LINK}</string>`)) throw new CandidateError("app plist identity/version/deep linkが不正です");
  const executableName = plistValue(plist, "CFBundleExecutable");
  if (!executableName) throw new CandidateError("app executable identityがありません");
  const executable = path.join(contents, "MacOS", executableName);
  const executableBytes = readFileSync(executable);
  verifyRuntimeAssetBundle(machoRuntimeSection(executableBytes), sdkManifest);
  for (const value of [UPDATER_FEED, EXPECTED_UPDATER_PUBLIC_KEY]) if (!executableBytes.includes(Buffer.from(value))) throw new CandidateError("appに固定updater設定が埋め込まれていません");
  if (!executableBytes.includes(Buffer.from(allowedPublicFirebaseKey))) throw new CandidateError("appに公式public account configが埋め込まれていません");

  const native = nativeManifest.binaries.map((record) => {
    const bundled = path.join(contents, "MacOS", record.name);
    const bytes = readFileSync(bundled);
    const versionValue = toolVersion(bundled, record.name);
    // Tauriのad-hoc codesignはMach-O bytesを変更する。版・依存を実際のbundleで再検査し、
    // candidate manifestには署名後のhashを記録する（stage hashとのbyte一致は要求しない）。
    if (versionValue !== record.version) throw new CandidateError("bundled native tool versionがstage manifestと一致しません");
    const dylibs = run("otool", ["-L", bundled]).split("\n").slice(1).map((line) => line.trim().split(" (")[0]).filter(Boolean);
    if (dylibs.some((item) => !item.startsWith("/usr/lib/") && !item.startsWith("/System/"))) throw new CandidateError("bundled native toolがmacOS外のdylibを参照しています");
    assertSystemNativeSearchPaths(bundled, { PATH: "/usr/bin:/bin", HOME: tmpdir() });
    const architecture = run("lipo", ["-archs", bundled]).trim();
    if (architecture !== "arm64" || record.architecture !== architecture) throw new CandidateError("bundled native toolがarm64 thin binaryではありません");
    return { name: record.name, version: versionValue, architecture, sourceSha256: record.sha256, sha256: sha256(bytes), bytes: bytes.length, dylibs };
  });
  const calibration = nativeManifest.calibration.map((record) => {
    const bytes = readFileSync(path.join(contents, "Resources/develop-calibration", ...record.path.split("/")));
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new CandidateError("bundled calibration hashが一致しません");
    return record;
  });
  const registryProof = nativeManifest.registries.map((record) => {
    const output = run(path.join(contents, "MacOS/apple-raw-linear"), ["registry", path.join(contents, "Resources/develop-calibration", record.file)], { cwd: "/", env: { HOME: tmpdir(), PATH: "/usr/bin:/bin" }, timeout: 30_000 });
    const value = JSON.parse(output);
    if (value.registry !== record.file || value.cameras !== record.cameras) throw new CandidateError("bundled calibration registry検査が一致しません");
    return record;
  });

  const dist = path.join(workspace, "apps/camera/dist/develop-engine", sdkManifest.engine.version);
  const runtime = sdkManifest.engine.runtimeFiles.map((record) => {
    const bytes = readFileSync(path.join(dist, record.name));
    if (bytes.length !== record.size || sha256(bytes) !== record.sha256 || !executableBytes.includes(Buffer.from(`/develop-engine/${sdkManifest.engine.version}/${record.name}`))) throw new CandidateError("bundled wasm runtime hash/pathがSDKと一致しません");
    return { name: record.name, sha256: record.sha256, bytes: record.size };
  });
  const runtimeManifest = readFileSync(path.join(dist, sdkManifest.engine.manifest.file));
  if (runtimeManifest.length !== sdkManifest.engine.manifest.size || sha256(runtimeManifest) !== sdkManifest.engine.manifest.sha256 || !executableBytes.includes(Buffer.from(`/develop-engine/${sdkManifest.engine.version}/${sdkManifest.engine.manifest.file}`))) throw new CandidateError("bundled wasm manifestがSDKと一致しません");
  run("codesign", ["--verify", "--deep", "--strict", appPath]);
  const signingResult = spawnSync("codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const signing = `${signingResult.stdout ?? ""}\n${signingResult.stderr ?? ""}`;
  if (signingResult.error || signingResult.status !== 0 || !/Signature=adhoc/u.test(signing)) throw new CandidateError("appがad-hoc署名ではありません");
  const files = inventoryTree(appPath, { allowedPublicFirebaseKey });
  const notices = verifyAppNoticeResources(appPath, expectedNotices);
  return {
    identity: { product: PRODUCT, bundleId: BUNDLE_ID, version, deepLink: DEEP_LINK },
    updater: { feed: UPDATER_FEED, publicKeySha256: sha256(Buffer.from(EXPECTED_UPDATER_PUBLIC_KEY)), officialUpdates: true },
    signing: { mode: "ad-hoc", verified: true, detailSha256: sha256(Buffer.from(signing)) },
    executable: { path: `Contents/MacOS/${executableName}`, sha256: sha256(executableBytes), bytes: executableBytes.length },
    native,
    calibration,
    registries: registryProof,
    runtime: { engine: sdkManifest.engine.version, crateVersion: sdkManifest.engine.crateVersion, manifest: { name: sdkManifest.engine.manifest.file, sha256: sdkManifest.engine.manifest.sha256, bytes: sdkManifest.engine.manifest.size }, files: runtime },
    files,
    notices,
  };
}

export function createCandidateSbom(workspace, sourceSha) {
  const locks = Object.fromEntries(lockfiles.map((relative) => [relative, readFileSync(path.join(workspace, ...relative.split("/")))]));
  const publicSdkDependencies = readPublicSdkDependenciesSync(workspace, JSON.parse(readFileSync(path.join(workspace, "docs/security/publication-policy.json"), "utf8")));
  return createSbom(sourceSha, locks, publicSdkDependencies);
}

export function candidateBaseName({ version, sourceSha, runId, runAttempt }) {
  assertStrictVersion(version);
  assertFullSha(sourceSha, "candidate source");
  if (!/^[1-9]\d*$/u.test(runId ?? "") || !/^[1-9]\d*$/u.test(runAttempt ?? "")) throw new CandidateError("run/attemptが不正です");
  const base = `NIHO-photo-${version}-${sourceSha.slice(0, 12)}-run-${runId}-attempt-${runAttempt}`;
  if (!SAFE_ASSET.test(base)) throw new CandidateError("candidate asset名が不正です");
  return base;
}

export function packAppTar(appPath, output) {
  ordinaryDirectory(appPath, "app");
  if (lstatSync(output, { throwIfNoEntry: false })) throw new CandidateError("app tarは上書きできません");
  run("tar", ["-czf", output, "-C", path.dirname(appPath), path.basename(appPath)], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  inspectAppTar(output, path.basename(appPath));
  return { sha256: sha256(readFileSync(output)), bytes: statSync(output).size };
}

export function assertDmgRoot(mount) {
  const expected = ["Applications", `${PRODUCT}.app`].sort();
  if (JSON.stringify(readdirSync(mount).sort()) !== JSON.stringify(expected)) throw new CandidateError("DMG rootに想定外の配布物・metadata payloadがあります");
  ordinaryDirectory(path.join(mount, `${PRODUCT}.app`), "DMG app");
  const applications = path.join(mount, "Applications");
  if (!lstatSync(applications).isSymbolicLink() || readlinkSync(applications) !== "/Applications") throw new CandidateError("DMG Applications linkが不正です");
}

export function verifyDmgInventory(dmgPath, expectedFiles, { allowedPublicFirebaseKey } = {}) {
  if (process.platform !== "darwin") throw new CandidateError("DMG実inventory検証はmacOS専用です");
  if (!Array.isArray(expectedFiles) || !expectedFiles.length) throw new CandidateError("DMGには検証済みapp inventoryが必要です");
  const before = boundedOrdinaryFile(dmgPath, "DMG");
  const digest = sha256(readFileSync(dmgPath));
  const scratch = mkdtempSync(path.join(tmpdir(), "niho-photo-dmg-verify-"));
  const mount = path.join(scratch, "volume");
  mkdirSync(mount, { mode: 0o700 });
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: scratch };
  let attached = false;
  try {
    run("/usr/bin/hdiutil", ["verify", dmgPath], { env, timeout: 120_000 });
    run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, "-plist", dmgPath], { env, timeout: 120_000 });
    attached = true;
    assertDmgRoot(mount);
    // 実際に配布するreadonly imageを読む。候補のprogram/scriptは実行しない。
    const actual = inventoryTree(path.join(mount, `${PRODUCT}.app`), { allowedPublicFirebaseKey });
    const normalize = (records) => records.map(({ path: name, sha256: hash, bytes, executable }) => ({ path: name, sha256: hash, bytes, executable })).sort((a, b) => a.path.localeCompare(b.path, "en"));
    if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expectedFiles))) throw new CandidateError("DMGの実app inventoryが検証済みappと一致しません");
  } finally {
    if (attached) run("/usr/bin/hdiutil", ["detach", mount], { env, timeout: 120_000 });
    // detach失敗時はmount directoryを削除しない。
    rmSync(scratch, { recursive: true, force: true });
  }
  const after = boundedOrdinaryFile(dmgPath, "DMG");
  if (before.size !== after.size || sha256(readFileSync(dmgPath)) !== digest) throw new CandidateError("DMGが実inventory検証中に変更されました");
  return { sha256: digest, bytes: after.size };
}

export function packDmg(appPath, output, expectedFiles, options = {}) {
  if (process.platform !== "darwin") throw new CandidateError("DMG生成はmacOS専用です");
  if (lstatSync(output, { throwIfNoEntry: false })) throw new CandidateError("DMGは上書きできません");
  const stage = mkdtempSync(path.join(tmpdir(), "niho-photo-dmg-"));
  try {
    cpSync(appPath, path.join(stage, path.basename(appPath)), { recursive: true, verbatimSymlinks: true });
    symlinkSync("/Applications", path.join(stage, "Applications"));
    run("hdiutil", ["create", "-volname", PRODUCT, "-srcfolder", stage, "-format", "UDZO", output]);
    return verifyDmgInventory(output, expectedFiles, options);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function validateCandidateManifest(manifest, fileName) {
  const sdkManifestSchemaVersion = candidateSdkManifestSchemaVersion(manifest?.sdk);
  const sdkProfile = sdkReleaseProfile(sdkManifestSchemaVersion);
  const sdkKeys = ["mode", "version", "source", "manifestFile", "manifestSha256", "packages", ...(sdkManifestSchemaVersion === 2 ? ["sdkManifestSchemaVersion"] : [])].sort();
  if (JSON.stringify(Object.keys(manifest?.sdk ?? {}).sort()) !== JSON.stringify(sdkKeys) || manifest?.schemaVersion !== 1 || !RELEASE_REPOSITORIES.has(manifest.repository) || manifest.product !== PRODUCT || manifest.bundleId !== BUNDLE_ID || !COMMIT.test(manifest.source?.commit ?? "") || !COMMIT.test(manifest.source?.tree ?? "") || !["published", "local-validation"].includes(manifest.sdk?.mode) || !SAFE_ASSET.test(manifest.sdk?.manifestFile ?? "") || !SHA256.test(manifest.sdk?.manifestSha256 ?? "") || !COMMIT.test(manifest.sdk?.source?.commit ?? "") || !COMMIT.test(manifest.sdk?.source?.tree ?? "") || (manifest.sdk.mode === "local-validation" && manifest.sdk.source.commit !== manifest.source.commit) || manifest.sourceOwnership?.algorithm !== "sha256-git-file-set-v1" || !SHA256.test(manifest.sourceOwnership?.digest ?? "") || manifest.sourceOwnership.digest !== ownershipDigest(manifest.sourceOwnership.paths ?? []) || JSON.stringify((manifest.sourceOwnership.paths ?? []).map(({ path: name }) => name)) !== JSON.stringify(sdkProfile.ownedSourcePaths) || manifest.sourceOwnership.paths.some((item) => !SHA256.test(item.sha256 ?? "") || !Number.isSafeInteger(item.files) || item.files <= 0) || manifest.publicAccountConfig?.name !== "NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY" || !SHA256.test(manifest.publicAccountConfig?.sha256 ?? "") || manifest.publicAccountConfig?.included !== true || manifest.build?.officialUpdates !== true || manifest.build?.updaterArtifacts !== false || manifest.build?.signing !== "ad-hoc" || manifest.build?.toolchain?.target !== "aarch64-apple-darwin" || !String(manifest.build?.toolchain?.rust ?? "").startsWith("rustc 1.98.1 ") || !["node", "swift", "tauri"].every((key) => typeof manifest.build?.toolchain?.[key] === "string" && manifest.build.toolchain[key].length > 2) || manifest.app?.identity?.product !== PRODUCT || manifest.app?.identity?.bundleId !== BUNDLE_ID || manifest.app?.identity?.version !== manifest.version || manifest.app?.identity?.deepLink !== DEEP_LINK || manifest.app?.updater?.feed !== UPDATER_FEED || manifest.app?.updater?.publicKeySha256 !== candidateContract.updaterPublicKeySha256 || manifest.app?.updater?.officialUpdates !== true || !Array.isArray(manifest.app?.files) || !manifest.app.files.length || !Array.isArray(manifest.overlays) || manifest.overlays.map(({ path: name }) => name).join("\0") !== OVERLAY_PATHS.join("\0") || manifest.overlays.some(({ beforeSha256, afterSha256 }) => !SHA256.test(beforeSha256 ?? "") || !SHA256.test(afterSha256 ?? "") || beforeSha256 === afterSha256)) throw new CandidateError("candidate manifest基本契約が不正です");
  assertStrictVersion(manifest.sdk.version);
  const packageIds = sdkProfile.packages.map(([id]) => id);
  if (!Array.isArray(manifest.sdk.packages) || JSON.stringify(manifest.sdk.packages.map(({ id }) => id).sort()) !== JSON.stringify(packageIds.sort()) || manifest.sdk.packages.some((item) => !SAFE_ASSET.test(item.file ?? "") || !SHA256.test(item.sha256 ?? "") || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > MAX_ASSET_BYTES)) throw new CandidateError("candidate SDK package pinが不正です");
  const appPaths = new Set();
  for (const record of manifest.app.files) {
    if (typeof record?.path !== "string" || record.path.startsWith("/") || record.path.includes("\\") || record.path.split("/").some((part) => !part || part === "." || part === "..") || appPaths.has(record.path) || !SHA256.test(record.sha256 ?? "") || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || typeof record.executable !== "boolean") throw new CandidateError("candidate app file inventoryが不正です");
    appPaths.add(record.path);
  }
  for (const notice of validateNoticeRecords(manifest.app.notices)) {
    if (!manifest.app.files.some((file) => file.path === `Contents/Resources/third-party-notices/${notice.path}` && file.sha256 === notice.sha256 && file.bytes === notice.bytes && file.executable === false)) throw new CandidateError("candidateのlicense/notice inventoryが一致しません");
  }
  if (JSON.stringify((manifest.app.native ?? []).map(({ name }) => name).sort()) !== JSON.stringify(["apple-raw-linear", "niho-camera-cutout", "niho-develop-render"]) || manifest.app.native.some((item) => !/^\d+\.\d+\.\d+$/u.test(item.version ?? "") || item.architecture !== "arm64" || !SHA256.test(item.sourceSha256 ?? "") || !SHA256.test(item.sha256 ?? "") || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !Array.isArray(item.dylibs) || item.dylibs.some((dylib) => !dylib.startsWith("/usr/lib/") && !dylib.startsWith("/System/")))) throw new CandidateError("candidate native proofが不正です");
  const proofFiles = [manifest.app.executable, ...manifest.app.native.map((item) => ({ ...item, path: `Contents/MacOS/${item.name}` })), ...(Array.isArray(manifest.app.calibration) ? manifest.app.calibration : []).map((item) => ({ ...item, path: `Contents/Resources/develop-calibration/${item.path}` }))];
  if (!manifest.app.executable || proofFiles.some((item) => !manifest.app.files.some((file) => file.path === item.path && file.sha256 === item.sha256 && file.bytes === item.bytes))) throw new CandidateError("candidate executable/native/calibration proofがapp inventoryと一致しません");
  if (!Array.isArray(manifest.app.calibration) || !manifest.app.calibration.length || manifest.app.calibration.some((item) => typeof item.path !== "string" || item.path.includes("..") || !SHA256.test(item.sha256 ?? "") || !Number.isSafeInteger(item.bytes) || item.bytes <= 0) || !/^niho-[1-9]\d*$/u.test(manifest.app.runtime?.engine ?? "") || !SEMVER.test(manifest.app.runtime?.crateVersion ?? "") || !SHA256.test(manifest.app.runtime?.manifest?.sha256 ?? "") || !Array.isArray(manifest.app.runtime?.files) || !manifest.app.runtime.files.length || manifest.app.runtime.files.some((item) => !SAFE_ASSET.test(item.name ?? "") || !SHA256.test(item.sha256 ?? "") || !Number.isSafeInteger(item.bytes) || item.bytes <= 0)) throw new CandidateError("candidate resource proofが不正です");
  assertStrictVersion(manifest.version);
  const base = candidateBaseName({ version: manifest.version, sourceSha: manifest.source.commit, runId: manifest.run.id, runAttempt: manifest.run.attempt });
  if (fileName !== `${base}.candidate.json`) throw new CandidateError("candidate manifest名が不正です");
  const expected = [`${base}.app.tar.gz`, `${base}.cdx.json`, `${base}.dmg`];
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== expected.length || manifest.assets.some((item, index) => item.name !== expected[index] || !SHA256.test(item.sha256 ?? "") || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > MAX_ASSET_BYTES)) throw new CandidateError("candidate asset契約が不正です");
  return { base, expected };
}

export function verifyCandidateDirectory(directory) {
  ordinaryDirectory(directory, "candidate directory");
  const names = readdirSync(directory).sort();
  if (names.some((name) => !SAFE_ASSET.test(name))) throw new CandidateError("candidate asset名が不正です");
  const manifests = names.filter((name) => name.endsWith(".candidate.json"));
  if (manifests.length !== 1 || names.length !== 4) throw new CandidateError("candidate asset集合が不正です");
  const manifestFile = manifests[0];
  const manifestPath = path.join(directory, manifestFile);
  boundedOrdinaryFile(manifestPath, "candidate manifest");
  const manifestBytes = readFileSync(manifestPath);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { throw new CandidateError("candidate manifestがJSONではありません"); }
  const { expected } = validateCandidateManifest(manifest, manifestFile);
  const exact = [...expected, manifestFile].sort();
  if (JSON.stringify(names) !== JSON.stringify(exact)) throw new CandidateError("candidate assetの不足またはextraがあります");
  for (const asset of manifest.assets) {
    const file = path.join(directory, asset.name);
    boundedOrdinaryFile(file, "candidate asset");
    const bytes = readFileSync(file);
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw new CandidateError("candidate asset hashが一致しません");
  }
  const tar = manifest.assets.find(({ name }) => name.endsWith(".app.tar.gz"));
  inspectAppTar(path.join(directory, tar.name));
  const inventory = spawnSync("python3", [fileURLToPath(new URL("./verify-app-tar-inventory.py", import.meta.url)), manifestPath, path.join(directory, tar.name)], { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (inventory.error || inventory.status !== 0) throw new CandidateError("app tar inventoryの実file/hash/size/modeが検証済みappと一致しません");
  const sbom = JSON.parse(readFileSync(path.join(directory, manifest.assets.find(({ name }) => name.endsWith(".cdx.json")).name), "utf8"));
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6" || sbom.metadata?.component?.version !== manifest.source.commit) throw new CandidateError("candidate SBOM proofが不正です");
  return { manifest, manifestFile, manifestSha256: sha256(manifestBytes), assets: expected };
}

function sdkAssetRecords(manifest, manifestFile, manifestBytes, receiptFile, receiptBytes) {
  return [
    { name: manifestFile, bytes: manifestBytes.length },
    ...manifest.packages.map(({ file: name, size: bytes }) => ({ name, bytes })),
    { name: receiptFile, bytes: receiptBytes.length },
  ].sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function validateSdkReceipt(receipt, candidate, sdkManifest, manifestFile, manifestSha256) {
  if (receipt?.schemaVersion !== 1 || receipt.repository !== sdkManifest.repository || receipt.sourceSha !== candidate.sdk.source.commit || receipt.sourceOwnershipDigest !== candidate.sourceOwnership.digest || receipt.version !== candidate.sdk.version || !POSITIVE_INTEGER.test(receipt.runId ?? "") || !POSITIVE_INTEGER.test(receipt.runAttempt ?? "") || !POSITIVE_INTEGER.test(receipt.artifact?.id ?? "") || receipt.artifact?.name !== `niho-photo-sdk-${candidate.sdk.source.commit}-run-${receipt.runId}-attempt-${receipt.runAttempt}` || !/^sha256:[a-f0-9]{64}$/u.test(receipt.artifact?.digest ?? "") || receipt.releaseManifest?.file !== manifestFile || receipt.releaseManifest?.sha256 !== manifestSha256) throw new CandidateError("SDK release receipt契約が不正です");
  return receipt;
}

export function verifySdkProofDirectory({ directory, candidateManifest, expectedSdkVersion, expectedSdkManifestSha256 }) {
  ordinaryDirectory(directory, "SDK proof directory");
  assertStrictVersion(expectedSdkVersion);
  if (!SHA256.test(expectedSdkManifestSha256 ?? "") || candidateManifest.sdk.version !== expectedSdkVersion || candidateManifest.sdk.manifestSha256 !== expectedSdkManifestSha256) throw new CandidateError("SDK proof期待値がcandidateと一致しません");
  const receiptFile = "photo-sdk-artifact-receipt.json", releaseFile = "photo-sdk-release.json", manifestFile = candidateManifest.sdk.manifestFile;
  const names = readdirSync(directory).sort();
  if (JSON.stringify(names) !== JSON.stringify([manifestFile, receiptFile, releaseFile].sort())) throw new CandidateError("SDK proof file集合が不正です");
  for (const name of names) boundedOrdinaryFile(path.join(directory, name), "SDK proof file");
  const manifestBytes = readFileSync(path.join(directory, manifestFile));
  if (sha256(manifestBytes) !== expectedSdkManifestSha256) throw new CandidateError("SDK proof manifest hashが一致しません");
  let sdkManifest;
  try { sdkManifest = JSON.parse(manifestBytes.toString("utf8")); } catch { throw new CandidateError("SDK proof manifestがJSONではありません"); }
  validateReleaseManifest(sdkManifest, candidateManifest.sdk.source.commit);
  const candidateSchemaVersion = candidateSdkManifestSchemaVersion(candidateManifest.sdk);
  if (sdkManifest.schemaVersion !== candidateSchemaVersion) throw new CandidateError("SDK proof manifest schemaがcandidateと一致しません");
  if (sdkManifest.version !== expectedSdkVersion || manifestFile !== `niho-photo-sdk-${expectedSdkVersion}-${candidateManifest.sdk.source.commit}.json` || JSON.stringify(sdkManifest.source) !== JSON.stringify(candidateManifest.sdk.source)) throw new CandidateError("SDK proof manifest identityが一致しません");
  assertOwnershipMatches(candidateManifest.sourceOwnership, sdkManifest.sourceOwnership);
  const packages = sdkManifest.packages.map(({ id, name, file, sha256: digest, size }) => ({ id, name, file, sha256: digest, bytes: size }));
  if (JSON.stringify(packages) !== JSON.stringify(candidateManifest.sdk.packages)) throw new CandidateError("SDK proof package pinがcandidateと一致しません");
  const receiptBytes = readFileSync(path.join(directory, receiptFile));
  const receipt = validateSdkReceipt(jsonFile(path.join(directory, receiptFile), "SDK release receipt"), candidateManifest, sdkManifest, manifestFile, expectedSdkManifestSha256);
  const release = jsonFile(path.join(directory, releaseFile), "SDK release metadata");
  const expectedAssets = sdkAssetRecords(sdkManifest, manifestFile, manifestBytes, receiptFile, receiptBytes);
  if (release?.schemaVersion !== 1 || release.repository !== candidateManifest.repository || !Number.isSafeInteger(release.releaseId) || release.releaseId <= 0 || release.tagName !== `photo-sdk-v${expectedSdkVersion}` || release.tagSha !== candidateManifest.sdk.source.commit || release.targetCommitish !== candidateManifest.sdk.source.commit || release.draft !== false || typeof release.prerelease !== "boolean" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(release.publishedAt ?? "") || JSON.stringify(release.assets) !== JSON.stringify(expectedAssets)) throw new CandidateError("SDK release metadata契約が不正です");
  return { directory, manifest: sdkManifest, manifestFile, manifestSha256: expectedSdkManifestSha256, receipt, receiptFile, release, releaseFile };
}

export function writeCandidateTransportProof({ candidate, sdkProof, artifactId, artifactDigest, artifactName, toolingSourceSha, receiptFile, provenanceFile }) {
  assertFullSha(toolingSourceSha, "publisher tooling source");
  const sdkManifestSchemaVersion = candidateSdkManifestSchemaVersion(candidate.manifest.sdk);
  let canonicalArtifactDigest;
  try { canonicalArtifactDigest = normalizeArtifactDigest(artifactDigest); } catch { throw new CandidateError("candidate artifact receipt入力が不正です"); }
  if (!POSITIVE_INTEGER.test(artifactId ?? "") || artifactName !== `niho-photo-candidate-${candidate.manifest.source.commit}-run-${candidate.manifest.run.id}-attempt-${candidate.manifest.run.attempt}`) throw new CandidateError("candidate artifact receipt入力が不正です");
  const receipt = {
    schemaVersion: 1,
    repository: candidate.manifest.repository,
    sourceSha: candidate.manifest.source.commit,
    sourceTree: candidate.manifest.source.tree,
    sourceOwnershipDigest: candidate.manifest.sourceOwnership.digest,
    version: candidate.manifest.version,
    runId: candidate.manifest.run.id,
    runAttempt: candidate.manifest.run.attempt,
    artifact: { id: artifactId, name: artifactName, digest: canonicalArtifactDigest },
    candidateManifest: { file: candidate.manifestFile, sha256: candidate.manifestSha256 },
    sdk: {
      version: candidate.manifest.sdk.version,
      sourceSha: candidate.manifest.sdk.source.commit,
      manifest: { file: sdkProof.manifestFile, sha256: sdkProof.manifestSha256 },
      ...(sdkManifestSchemaVersion === 2 ? { sdkManifestSchemaVersion: 2 } : {}),
    },
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(receiptFile, receiptBytes, { flag: "wx", mode: 0o644 });
  const provenance = {
    schemaVersion: 1,
    predicateType: "niho-photo-candidate-provenance-v1",
    repository: candidate.manifest.repository,
    toolingSourceSha,
    subject: { sourceSha: candidate.manifest.source.commit, version: candidate.manifest.version, candidateManifest: receipt.candidateManifest },
    sdk: {
      version: candidate.manifest.sdk.version,
      sourceSha: candidate.manifest.sdk.source.commit,
      manifest: receipt.sdk.manifest,
      ...(sdkManifestSchemaVersion === 2 ? { sdkManifestSchemaVersion: 2 } : {}),
      release: { tag: sdkProof.release.tagName, id: String(sdkProof.release.releaseId), metadataSha256: sha256(readFileSync(path.join(sdkProof.directory, sdkProof.releaseFile))) },
      receipt: { file: sdkProof.receiptFile, sha256: sha256(readFileSync(path.join(sdkProof.directory, sdkProof.receiptFile))) },
    },
    workflow: { runId: candidate.manifest.run.id, runAttempt: candidate.manifest.run.attempt },
    transportReceipt: { file: path.basename(receiptFile), sha256: sha256(receiptBytes) },
  };
  writeFileSync(provenanceFile, `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  return { receipt, provenance };
}

export const candidateContract = Object.freeze({
  product: PRODUCT,
  bundleId: BUNDLE_ID,
  deepLink: DEEP_LINK,
  updaterFeed: UPDATER_FEED,
  updaterPublicKeySha256: sha256(Buffer.from(EXPECTED_UPDATER_PUBLIC_KEY)),
  overlayPaths: OVERLAY_PATHS,
  noticePaths: Object.keys(NOTICE_SOURCES),
  maxAssetBytes: MAX_ASSET_BYTES,
});

const RUNTIME_BUNDLE_MAGIC = Buffer.from("NIHO-PHOTO-RT1\0\0");

function runtimeAssetRecords(sdkManifest) {
  const engine = sdkManifest.engine;
  return [...engine.runtimeFiles, { name: engine.manifest.file, sha256: engine.manifest.sha256, size: engine.manifest.size }]
    .map((record) => ({ ...record, path: `/develop-engine/${engine.version}/${record.name}` }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function stageRuntimeAssetBundle(workspace, sdkManifest, output) {
  const records = runtimeAssetRecords(sdkManifest);
  const payload = [], index = [];
  let offset = 0;
  for (const record of records) {
    const bytes = readFileSync(path.join(workspace, "packages/develop-engine/public", record.path.slice(1)));
    if (bytes.length !== record.size || sha256(bytes) !== record.sha256) throw new CandidateError("runtime asset bundleの元bytesがSDKと一致しません");
    index.push({ path: record.path, offset, bytes: bytes.length });
    payload.push(bytes);
    offset += bytes.length;
  }
  const header = Buffer.alloc(24), encoded = Buffer.from(JSON.stringify(index));
  RUNTIME_BUNDLE_MAGIC.copy(header);
  header.writeBigUInt64LE(BigInt(encoded.length), 16);
  writeFileSync(output, Buffer.concat([header, encoded, ...payload]), { flag: "wx", mode: 0o600 });
  return output;
}

export function machoRuntimeSection(binary) {
  if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf || binary.readUInt32LE(4) !== 0x0100000c) throw new CandidateError("runtime sectionにはarm64 thin Mach-Oが必要です");
  const count = binary.readUInt32LE(16), commandBytes = binary.readUInt32LE(20);
  if (count > 4096 || commandBytes > binary.length - 32) throw new CandidateError("runtime Mach-O load command範囲が不正です");
  let cursor = 32;
  const found = [];
  const name = (offset) => binary.subarray(offset, offset + 16).toString("ascii").replace(/\0.*$/su, "");
  for (let i = 0; i < count; i++) {
    if (cursor + 8 > 32 + commandBytes) throw new CandidateError("runtime Mach-O load commandが短すぎます");
    const command = binary.readUInt32LE(cursor), size = binary.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > 32 + commandBytes) throw new CandidateError("runtime Mach-O command sizeが不正です");
    if (command === 0x19) {
      if (size < 72) throw new CandidateError("runtime segmentが短すぎます");
      const sections = binary.readUInt32LE(cursor + 64);
      if (sections > 1024 || size !== 72 + sections * 80) throw new CandidateError("runtime section tableが不正です");
      for (let j = 0; j < sections; j++) {
        const section = cursor + 72 + j * 80;
        if (name(section) !== "__niho_runtime") continue;
        if (name(section + 16) !== "__DATA_CONST" || name(cursor + 8) !== "__DATA_CONST") throw new CandidateError("runtime section segmentが不正です");
        const length = binary.readBigUInt64LE(section + 40), offset = binary.readUInt32LE(section + 48);
        if (length === 0n || length > BigInt(MAX_ASSET_BYTES) || offset < 32 + commandBytes || BigInt(offset) + length > BigInt(binary.length) || (binary.readUInt32LE(section + 64) & 0xff) !== 0) throw new CandidateError("runtime section bounds/typeが不正です");
        const vm = binary.readBigUInt64LE(cursor + 24), vmSize = binary.readBigUInt64LE(cursor + 32), fileOffset = binary.readBigUInt64LE(cursor + 40), fileSize = binary.readBigUInt64LE(cursor + 48), address = binary.readBigUInt64LE(section + 32);
        if (fileOffset > BigInt(offset) || BigInt(offset) + length > fileOffset + fileSize || fileOffset + fileSize > BigInt(binary.length) || address < vm || address + length > vm + vmSize || address - vm !== BigInt(offset) - fileOffset) throw new CandidateError("runtime sectionのfile/VM mappingが不正です");
        found.push(binary.subarray(offset, offset + Number(length)));
      }
    }
    cursor += size;
  }
  if (cursor !== 32 + commandBytes || found.length !== 1) throw new CandidateError("SDK runtime sectionは一意でなければなりません");
  return found[0];
}

export function verifyRuntimeAssetBundle(bundle, sdkManifest) {
  if (bundle.length < 24 || !bundle.subarray(0, 16).equals(RUNTIME_BUNDLE_MAGIC)) throw new CandidateError("SDK runtime bundle headerが不正です");
  const length = bundle.readBigUInt64LE(16);
  if (length === 0n || length > 65536n || length > BigInt(bundle.length - 24)) throw new CandidateError("SDK runtime index sizeが不正です");
  const start = 24 + Number(length);
  let index;
  try { index = JSON.parse(bundle.subarray(24, start).toString("utf8")); } catch { throw new CandidateError("SDK runtime indexがJSONではありません"); }
  if (JSON.stringify(index) !== bundle.subarray(24, start).toString("utf8")) throw new CandidateError("SDK runtime indexがcanonical JSONではありません");
  const records = runtimeAssetRecords(sdkManifest);
  if (!Array.isArray(index) || index.length !== records.length) throw new CandidateError("SDK runtime asset集合が不正です");
  let offset = 0;
  for (let i = 0; i < records.length; i++) {
    const expected = records[i], actual = index[i];
    if (!actual || Object.keys(actual).sort().join(",") !== "bytes,offset,path" || actual.path !== expected.path || actual.offset !== offset || actual.bytes !== expected.size) throw new CandidateError("SDK runtime tableがSDKと一致しません");
    const bytes = bundle.subarray(start + offset, start + offset + actual.bytes);
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) throw new CandidateError("埋込runtime実bytesがSDK hash/sizeと一致しません");
    offset += actual.bytes;
  }
  if (start + offset !== bundle.length) throw new CandidateError("SDK runtime bundleに余分なpayloadがあります");
  return true;
}
