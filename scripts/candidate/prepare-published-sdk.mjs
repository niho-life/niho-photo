#!/usr/bin/env node
import { appendFileSync, cpSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CandidateError, assertStrictVersion, verifySdkDirectory, verifySdkProofDirectory } from "./mac-candidate-lib.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RECEIPT_FILE = "photo-sdk-artifact-receipt.json";
const RELEASE_FILE = "photo-sdk-release.json";

function parse(argv) {
  const allowed = new Set(["--sdk-directory", "--sdk-receipt", "--release-json", "--tag-sha", "--expected-version", "--expected-manifest-sha256", "--output", "--github-output"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || values[key] !== undefined) throw new CandidateError("published SDK proof引数が不正です");
    values[key] = value;
  }
  for (const key of allowed) if (!values[key]) throw new CandidateError(`published SDK proofに${key}が必要です`);
  return values;
}

function ordinaryFile(file, label) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new CandidateError(`${label}は通常の非空fileが必要です`);
  return stat;
}

export function preparePublishedSdkProof(values) {
  const sdkDirectory = path.resolve(values["--sdk-directory"]);
  const receiptPath = path.resolve(values["--sdk-receipt"]);
  const releasePath = path.resolve(values["--release-json"]);
  const output = path.resolve(values["--output"]);
  const tagSha = values["--tag-sha"], expectedVersion = assertStrictVersion(values["--expected-version"]), expectedManifestSha256 = values["--expected-manifest-sha256"];
  if (!COMMIT.test(tagSha ?? "") || !SHA256.test(expectedManifestSha256 ?? "") || lstatSync(output, { throwIfNoEntry: false })) throw new CandidateError("published SDK proof入力が不正です");
  ordinaryFile(receiptPath, "SDK release receipt");
  ordinaryFile(releasePath, "SDK release metadata input");
  const sdk = verifySdkDirectory({ directory: sdkDirectory, mode: "published", appSource: tagSha, expectedManifestSha256 });
  if (sdk.manifest.version !== expectedVersion || sdk.manifest.source.commit !== tagSha) throw new CandidateError("published SDK tag/version/sourceが一致しません");
  let rawRelease;
  try { rawRelease = JSON.parse(readFileSync(releasePath, "utf8")); } catch { throw new CandidateError("SDK release metadata inputがJSONではありません"); }
  const expectedAssets = [
    { name: sdk.manifestFile, bytes: statSync(path.join(sdkDirectory, sdk.manifestFile)).size },
    ...sdk.manifest.packages.map(({ file: name }) => ({ name, bytes: statSync(path.join(sdkDirectory, name)).size })),
    { name: RECEIPT_FILE, bytes: statSync(receiptPath).size },
  ].sort((left, right) => left.name.localeCompare(right.name, "en"));
  const releaseAssets = (rawRelease.assets ?? []).map(({ name, size: bytes }) => ({ name, bytes })).sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (!Number.isSafeInteger(rawRelease.id) || rawRelease.id <= 0 || rawRelease.tag_name !== `photo-sdk-v${expectedVersion}` || rawRelease.target_commitish !== tagSha || rawRelease.draft !== false || typeof rawRelease.prerelease !== "boolean" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(rawRelease.published_at ?? "") || JSON.stringify(releaseAssets) !== JSON.stringify(expectedAssets)) throw new CandidateError("SDK GitHub release契約が不正です");
  mkdirSync(output, { recursive: false, mode: 0o755 });
  cpSync(path.join(sdkDirectory, sdk.manifestFile), path.join(output, sdk.manifestFile), { errorOnExist: true, force: false });
  cpSync(receiptPath, path.join(output, RECEIPT_FILE), { errorOnExist: true, force: false });
  const release = {
    schemaVersion: 1,
    repository: "niho-life/niho-photo",
    releaseId: rawRelease.id,
    tagName: rawRelease.tag_name,
    tagSha,
    targetCommitish: rawRelease.target_commitish,
    draft: false,
    prerelease: rawRelease.prerelease,
    publishedAt: rawRelease.published_at,
    assets: expectedAssets,
  };
  writeFileSync(path.join(output, RELEASE_FILE), `${JSON.stringify(release, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  const candidateManifest = {
    repository: "niho-life/niho-photo",
    sdk: { ...(sdk.manifest.schemaVersion === 2 ? { sdkManifestSchemaVersion: 2 } : {}), version: sdk.manifest.version, source: sdk.manifest.source, manifestFile: sdk.manifestFile, manifestSha256: sdk.manifestSha256, packages: sdk.manifest.packages.map(({ id, name, file, sha256, size: bytes }) => ({ id, name, file, sha256, bytes })) },
    sourceOwnership: sdk.manifest.sourceOwnership,
  };
  verifySdkProofDirectory({ directory: output, candidateManifest, expectedSdkVersion: expectedVersion, expectedSdkManifestSha256: expectedManifestSha256 });
  if (values["--github-output"]) appendFileSync(values["--github-output"], `sdk-source-sha=${tagSha}\nsdk-version=${expectedVersion}\nsdk-manifest-file=${sdk.manifestFile}\nsdk-manifest-sha256=${sdk.manifestSha256}\n`);
  return { output, sdk };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = preparePublishedSdkProof(parse(process.argv.slice(2)));
    console.log(`published SDK proofを生成しました（${result.sdk.manifest.version}）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "published SDK proof生成に失敗しました");
    process.exitCode = 1;
  }
}
