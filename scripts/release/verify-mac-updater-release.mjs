#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PHOTO_UPDATER_RELEASE, PhotoUpdaterReleaseError } from "./mac-updater-release-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const APP_TAG = /^photo-app-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function fail(message) {
  throw new PhotoUpdaterReleaseError(message);
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

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== "--release-tag" || argv[2] !== "--prepared-dir" || !APP_TAG.test(argv[1])) {
    fail("--release-tag photo-app-v<version> --prepared-dir <directory> が必要です");
  }
  return { tag: argv[1], directory: path.resolve(argv[3]) };
}

function regularFile(filePath, label, maxBytes = 250 * 1024 * 1024) {
  const info = lstatSync(filePath, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maxBytes) fail(`${label}が通常fileまたはsize制限を満たしません`);
  const bytes = readFileSync(filePath);
  if (bytes.length !== info.size) fail(`${label}の読取sizeが変化しました`);
  return bytes;
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail(`${label}がJSONではありません`); }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main(argv) {
  const { tag, directory } = parseArguments(argv);
  const evidence = parseJson(regularFile(path.join(directory, "release-evidence.json"), "release evidence", 8 * 1024 * 1024), "release evidence");
  if (evidence?.schemaVersion !== 1 || evidence.repository !== PHOTO_UPDATER_RELEASE.repository
    || evidence.releaseTag !== tag || tag !== `photo-app-v${evidence.version}`
    || evidence.updateFeed !== PHOTO_UPDATER_RELEASE.feedUrl || !Array.isArray(evidence.assets) || !evidence.assets.length) {
    fail("prepared evidenceが対象Releaseと一致しません");
  }
  const names = evidence.assets.map((asset) => asset.name).sort();
  if (new Set(names).size !== names.length || names.some((name) => typeof name !== "string" || path.basename(name) !== name)) fail("prepared evidence asset一覧が不正です");
  for (const asset of evidence.assets) {
    if (!/^[a-f0-9]{64}$/u.test(asset.sha256 ?? "") || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) fail("prepared evidence hash/sizeが不正です");
    const localBytes = regularFile(path.join(directory, asset.name), "prepared release asset");
    if (localBytes.length !== asset.bytes || sha256(localBytes) !== asset.sha256) fail("prepared assetがevidenceから変化しています");
  }
  const localNames = readdirSync(directory).sort();
  const expectedLocalNames = [...names, "release-evidence.json", "release-notes.md", "publish-draft-instructions.txt"].sort();
  if (JSON.stringify(localNames) !== JSON.stringify(expectedLocalNames)) fail("prepared directoryのfile集合が不正です");

  const release = parseJson(Buffer.from(run("gh", ["api", `repos/${PHOTO_UPDATER_RELEASE.repository}/releases/latest`])), "published latest release");
  if (release?.tag_name !== tag || release.draft !== false || release.prerelease !== false) fail("Photo app ReleaseがGitHubのlatest releaseではありません");
  const assets = Array.isArray(release.assets) ? release.assets.map((asset) => asset.name).sort() : [];
  if (JSON.stringify(assets) !== JSON.stringify(names)) fail("published Release asset集合がprepared evidenceと違います");

  const temporary = mkdtempSync(path.join(tmpdir(), "niho-photo-release-check-"));
  try {
    run("gh", ["release", "download", tag, "--repo", PHOTO_UPDATER_RELEASE.repository, "--dir", temporary]);
    const downloadedNames = readdirSync(temporary).sort();
    if (JSON.stringify(downloadedNames) !== JSON.stringify(names)) fail("published Releaseのdownload asset集合が不正です");
    for (const asset of evidence.assets) {
      const bytes = regularFile(path.join(temporary, asset.name), "published release asset");
      if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) fail("published assetがowner-reviewed bytesと一致しません");
    }

    const served = await fetch(PHOTO_UPDATER_RELEASE.feedUrl, { redirect: "follow", cache: "no-store" });
    if (!served.ok) fail("Photo updater latest.json endpointがHTTP successではありません");
    const remoteManifestBytes = Buffer.from(await served.arrayBuffer());
    const localManifestBytes = regularFile(path.join(directory, "latest.json"), "prepared updater manifest", 64 * 1024);
    if (!remoteManifestBytes.equals(localManifestBytes)) fail("公開latest.jsonがprepared manifestと一致しません");
    const manifest = parseJson(remoteManifestBytes, "served updater manifest");
    const signatureName = names.find((name) => name.endsWith(".app.tar.gz.sig"));
    if (!signatureName) fail("prepared updater signatureがありません");
    const signatureBytes = regularFile(path.join(directory, signatureName), "prepared updater signature", 16 * 1024);
    const archiveName = evidence.assets.find((asset) => asset.name.endsWith(".app.tar.gz"))?.name;
    const platform = manifest.platforms?.[PHOTO_UPDATER_RELEASE.target];
    if (manifest.version !== evidence.version || platform?.signature !== signatureBytes.toString("utf8").trim()
      || typeof archiveName !== "string"
      || platform.url !== `${PHOTO_UPDATER_RELEASE.repositoryUrl}/releases/download/${tag}/${encodeURIComponent(archiveName)}`) {
      fail("公開latest.jsonのversion/signature/archive URLがRelease assetと一致しません");
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`Photo updater Releaseとlatest.jsonをread-back検証しました（${evidence.version}）。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof PhotoUpdaterReleaseError ? error.message : "Photo updater Release検証に失敗しました（詳細とsecretは非表示）");
    process.exitCode = 1;
  });
}
