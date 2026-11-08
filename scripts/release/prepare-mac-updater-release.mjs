#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PHOTO_UPDATER_RELEASE,
  PhotoUpdaterReleaseError,
  buildUpdaterManifest,
  verifyCandidateAttestation,
  verifyCandidateDirectoryForRelease,
  verifyCandidateTransportProof,
  verifySdkProofForRelease,
  validateCandidateReleaseMetadata,
} from "./mac-updater-release-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPOSITORY_URLS = new Set(["https://github.com/niho-life/niho-photo.git"]);
const CANDIDATE_TAG = /^photo-candidate-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([a-f0-9]{12})$/u;
const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;

function fail(message) {
  throw new PhotoUpdaterReleaseError(message);
}

function parseArguments(argv) {
  const allowed = new Set(["--candidate-tag", "--signing-key-path", "--output-dir"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || values[key]) fail("引数が不正です");
    values[key] = value;
  }
  if ([...allowed].some((key) => !values[key])) fail("--candidate-tag、--signing-key-path、--output-dirが必要です");
  if (!CANDIDATE_TAG.test(values["--candidate-tag"])) fail("candidate tagの形式が不正です");
  return {
    candidateTag: values["--candidate-tag"],
    keyPath: path.resolve(values["--signing-key-path"]),
    outputPath: path.resolve(values["--output-dir"]),
  };
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch {
    fail(`${path.basename(command)}の実行に失敗しました`);
  }
}

function git(...args) {
  return run("git", args).trim();
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label}がJSONではありません`);
  }
}

function readOrdinaryFile(filePath, maxBytes, label) {
  const info = lstatSync(filePath, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maxBytes) fail(`${label}が通常fileまたはsize制限を満たしません`);
  const bytes = readFileSync(filePath);
  if (bytes.length !== info.size) fail(`${label}の読取sizeが変化しました`);
  return bytes;
}

function requireCurrentMain() {
  const origin = git("remote", "get-url", "origin");
  if (!REPOSITORY_URLS.has(origin) || git("branch", "--show-current") !== "main") fail("niho-photoのclean main checkoutで実行してください");
  if (git("status", "--porcelain").length) fail("変更のないclean checkoutが必要です");
  run("git", ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"]);
  if (git("rev-parse", "HEAD") !== git("rev-parse", "refs/remotes/origin/main")) fail("checkoutをorigin/mainへ更新してください");
}

function verifySigningKeyPath(keyPath) {
  const info = lstatSync(keyPath, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) fail("signing keyは通常fileが必要です");
  if (process.getuid && info.uid !== process.getuid()) fail("signing keyのownerが現在のユーザーと一致しません");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) fail("signing keyはownerのみ読めるpermissionが必要です");
}

function copyAssetsToProofDirectories({ incoming, candidate, candidateDirectory, sdkDirectory }) {
  mkdirSync(candidateDirectory, { mode: 0o700 });
  mkdirSync(sdkDirectory, { mode: 0o700 });
  for (const name of [...candidate.manifest.assets.map(({ name: assetName }) => assetName), candidate.manifestFile]) {
    copyFileSync(path.join(incoming, name), path.join(candidateDirectory, name));
  }
  for (const name of [candidate.manifest.sdk.manifestFile, "photo-sdk-artifact-receipt.json", "photo-sdk-release.json"]) {
    copyFileSync(path.join(incoming, name), path.join(sdkDirectory, name));
  }
}

function expectedAssetNames(manifestFile, manifest) {
  return [
    ...manifest.assets.map(({ name }) => name),
    manifestFile,
    manifest.sdk.manifestFile,
    "photo-sdk-artifact-receipt.json",
    "photo-sdk-release.json",
    "photo-candidate-artifact-receipt.json",
    "photo-candidate-provenance.json",
  ].sort();
}

function releaseNotes({ version, candidateTag, sourceSha, sdkVersion }) {
  return [
    `NIHO photo ${version}`,
    "",
    `Candidate: ${candidateTag}`,
    `Source: ${sourceSha}`,
    `Photo SDK: ${sdkVersion}`,
    "",
    "Mac用Tauri updater署名付きの公式配布です。更新の確認と適用はアプリ起動時に行い、インストールは終了時、反映は次回起動時です。",
  ].join("\n") + "\n";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function publishInstructions({ tag, sourceSha, assets }) {
  const assetsList = assets.map((name) => `  "$ASSET_DIR/${name}"`).join(" \\\n");
  return [
    "# Owner-reviewed GitHub Release publication",
    "# Run these commands manually after reviewing every prepared asset.",
    "ASSET_DIR=\"/replace/with/the/prepared/output-directory\"",
    `gh api --method POST repos/${PHOTO_UPDATER_RELEASE.repository}/git/refs -f ref=refs/tags/${tag} -f sha=${sourceSha}`,
    `gh release create ${tag} --repo ${PHOTO_UPDATER_RELEASE.repository} --verify-tag --target ${sourceSha} --draft --latest=false --title 'NIHO photo ${tag.slice("photo-app-v".length)}' --notes-file "$ASSET_DIR/release-notes.md" \\\n${assetsList}`,
    "",
    `# Inspect the draft and assets, then publish it as this repository's latest release:`,
    `gh release edit ${tag} --repo ${PHOTO_UPDATER_RELEASE.repository} --draft=false --latest`,
    `npm run photo:release:verify -- --release-tag ${tag} --prepared-dir "$ASSET_DIR"`,
    "",
    "# A claimed version/tag is never reused. If the tag was created and publication failed, choose a higher app version.",
  ].join("\n") + "\n";
}

function main(argv) {
  const { candidateTag, keyPath, outputPath } = parseArguments(argv);
  requireCurrentMain();
  verifySigningKeyPath(keyPath);
  if (lstatSync(outputPath, { throwIfNoEntry: false })) fail("output directoryは新規pathが必要です");

  const temporary = mkdtempSync(path.join(tmpdir(), "niho-photo-updater-"));
  let outputCreated = false;
  let completed = false;
  try {
    const incoming = path.join(temporary, "candidate-assets");
    const candidateDirectory = path.join(temporary, "candidate-proof");
    const sdkDirectory = path.join(temporary, "sdk-proof");
    mkdirSync(incoming, { mode: 0o700 });
    const releaseBytes = run("gh", ["api", `repos/${PHOTO_UPDATER_RELEASE.repository}/releases/tags/${candidateTag}`]);
    const release = parseJson(Buffer.from(releaseBytes), "candidate release metadata");
    const releaseAssetNames = validateCandidateReleaseMetadata(release, candidateTag);
    const tagRef = parseJson(Buffer.from(run("gh", ["api", `repos/${PHOTO_UPDATER_RELEASE.repository}/git/ref/tags/${candidateTag}`])), "candidate tag ref");
    run("gh", ["release", "download", candidateTag, "--repo", PHOTO_UPDATER_RELEASE.repository, "--dir", incoming]);

    const manifestFiles = readdirSync(incoming).filter((name) => name.endsWith(".candidate.json"));
    if (manifestFiles.length !== 1) fail("candidate manifestが一意ではありません");
    const manifestFile = manifestFiles[0];
    const manifestBytes = readOrdinaryFile(path.join(incoming, manifestFile), MAX_METADATA_BYTES, "candidate manifest");
    const candidateManifest = parseJson(manifestBytes, "candidate manifest");
    if (candidateManifest.repository !== PHOTO_UPDATER_RELEASE.repository
      || candidateManifest.source?.commit?.slice(0, 12) !== candidateTag.slice(-12)
      || candidateTag !== `photo-candidate-v${candidateManifest.version}-${candidateManifest.source.commit.slice(0, 12)}`) {
      fail("candidate tagとmanifest identityが一致しません");
    }
    if (tagRef?.ref !== `refs/tags/${candidateTag}` || tagRef.object?.type !== "commit" || tagRef.object?.sha !== candidateManifest.source.commit) fail("candidate Git tagがsource commitを指していません");
    const expected = expectedAssetNames(manifestFile, candidateManifest);
    const actual = readdirSync(incoming).sort();
    const releaseNames = releaseAssetNames;
    if (JSON.stringify(actual) !== JSON.stringify(expected) || JSON.stringify(releaseNames) !== JSON.stringify(expected)) {
      fail("candidate release assetの不足、重複、またはextraがあります");
    }
    for (const name of expected) {
      const assetPath = path.join(incoming, name);
      const info = lstatSync(assetPath, { throwIfNoEntry: false });
      if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 250 * 1024 * 1024) fail("candidate releaseに通常fileでないassetまたはsize超過があります");
    }

    copyAssetsToProofDirectories({ incoming, candidate: { manifest: candidateManifest, manifestFile }, candidateDirectory, sdkDirectory });
    const candidate = verifyCandidateDirectoryForRelease(candidateDirectory);
    const sdkProof = verifySdkProofForRelease({ directory: sdkDirectory, candidate });
    const receiptBytes = readOrdinaryFile(path.join(incoming, "photo-candidate-artifact-receipt.json"), MAX_METADATA_BYTES, "candidate artifact receipt");
    const receipt = parseJson(receiptBytes, "candidate artifact receipt");
    const provenance = parseJson(readOrdinaryFile(path.join(incoming, "photo-candidate-provenance.json"), MAX_METADATA_BYTES, "candidate provenance"), "candidate provenance");
    const transport = verifyCandidateTransportProof({ candidate, sdkProof, manifestBytes, receipt, receiptBytes, provenance });
    const statementBytes = run("gh", [
      "attestation", "verify", path.join(candidateDirectory, candidate.manifestFile),
      "--repo", PHOTO_UPDATER_RELEASE.repository,
      "--signer-workflow", `${PHOTO_UPDATER_RELEASE.repository}/${PHOTO_UPDATER_RELEASE.candidateWorkflow}`,
      "--signer-digest", transport.toolingSourceSha,
      "--source-digest", transport.toolingSourceSha,
      "--source-ref", PHOTO_UPDATER_RELEASE.branchRef,
      "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
      "--deny-self-hosted-runners",
      "--predicate-type", SLSA_PROVENANCE,
      "--format", "json",
    ]);
    const attestationOutput = parseJson(Buffer.from(statementBytes), "GitHub attestation result");
    verifyCandidateAttestation(attestationOutput, { candidate, manifestBytes, provenance });
    git("merge-base", "--is-ancestor", candidate.manifest.source.commit, "refs/remotes/origin/main");

    const archiveName = candidate.manifest.assets.find((asset) => asset.name.endsWith(".app.tar.gz"))?.name;
    if (!archiveName) fail("Tauri updater archiveがありません");
    const archivePath = path.join(candidateDirectory, archiveName);
    const signaturePath = `${archivePath}.sig`;
    if (lstatSync(signaturePath, { throwIfNoEntry: false })) fail("signature outputが既に存在します");
    run("npm", ["--prefix", "apps/camera", "run", "tauri", "--", "signer", "sign", "--private-key-path", keyPath, "--app-version", candidate.manifest.version, archivePath], { stdio: "inherit" });
    const signatureBytes = readOrdinaryFile(signaturePath, MAX_SIGNATURE_BYTES, "Tauri signature");
    const signature = signatureBytes.toString("utf8").trim();
    const updaterManifest = buildUpdaterManifest({ version: candidate.manifest.version, signature, archiveName });
    const releaseTag = `photo-app-v${candidate.manifest.version}`;
    const outputNames = [...expected, `${archiveName}.sig`, "latest.json"];

    mkdirSync(outputPath, { mode: 0o700 });
    outputCreated = true;
    for (const name of expected) copyFileSync(path.join(incoming, name), path.join(outputPath, name));
    writeFileSync(path.join(outputPath, `${archiveName}.sig`), signatureBytes, { flag: "wx", mode: 0o644 });
    writeFileSync(path.join(outputPath, "latest.json"), `${JSON.stringify(updaterManifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    writeFileSync(path.join(outputPath, "release-notes.md"), releaseNotes({
      version: candidate.manifest.version,
      candidateTag,
      sourceSha: candidate.manifest.source.commit,
      sdkVersion: candidate.manifest.sdk.version,
    }), { flag: "wx", mode: 0o644 });
    writeFileSync(path.join(outputPath, "publish-draft-instructions.txt"), publishInstructions({
      tag: releaseTag,
      sourceSha: candidate.manifest.source.commit,
      assets: outputNames,
    }), { flag: "wx", mode: 0o600 });
    writeFileSync(path.join(outputPath, "release-evidence.json"), `${JSON.stringify({
      schemaVersion: 1,
      repository: PHOTO_UPDATER_RELEASE.repository,
      sourceSha: candidate.manifest.source.commit,
      version: candidate.manifest.version,
      sdkVersion: candidate.manifest.sdk.version,
      candidateTag,
      candidateManifest: { file: candidate.manifestFile, sha256: candidate.manifestSha256 },
      candidateWorkflowSha: transport.toolingSourceSha,
      releaseTag,
      updateFeed: PHOTO_UPDATER_RELEASE.feedUrl,
      assets: outputNames.map((name) => {
        const bytes = readFileSync(path.join(outputPath, name));
        return { name, bytes: bytes.length, sha256: sha256(bytes) };
      }).sort((left, right) => left.name.localeCompare(right.name, "en")),
    }, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    console.log(`Photo updater配布用assetsを準備しました（${candidate.manifest.version} / source ${candidate.manifest.source.commit}）。GitHub Releaseは未作成です。`);
    console.log(`出力先: ${path.basename(outputPath)}（候補appは一度も実行していません）`);
    completed = true;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    if (outputCreated && !completed) rmSync(outputPath, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof PhotoUpdaterReleaseError ? error.message : "Photo updater配布準備に失敗しました（詳細とsecretは非表示）");
    process.exitCode = 1;
  }
}
