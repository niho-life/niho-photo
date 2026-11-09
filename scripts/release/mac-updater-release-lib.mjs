import { readFileSync } from "node:fs";
import path from "node:path";

import { assertStrictVersion, candidateContract, sha256, verifyCandidateDirectory, verifySdkProofDirectory } from "../candidate/mac-candidate-lib.mjs";

export const PHOTO_UPDATER_RELEASE = Object.freeze({
  repository: "niho-life/niho-photo",
  repositoryUrl: "https://github.com/niho-life/niho-photo",
  feedUrl: "https://github.com/niho-life/niho-photo/releases/latest/download/latest.json",
  candidateWorkflow: ".github/workflows/photo-candidate-release.yml",
  branchRef: "refs/heads/main",
  trigger: "workflow_dispatch",
  target: "darwin-aarch64",
});

const CANDIDATE_PROVENANCE = "niho-photo-candidate-provenance-v1";
const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
const REKOR_URL = "https://rekor.sigstore.dev";
const FULL_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const POSITIVE = /^[1-9]\d*$/u;
const CANDIDATE_TAG = /^photo-candidate-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([a-f0-9]{12})$/u;
const SAFE_ASSET = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const MAX_ASSET_BYTES = 250 * 1024 * 1024;

export class PhotoUpdaterReleaseError extends Error {}

// The candidate publisher exports seven assets. SDK receipt/metadata belong to
// the immutable SDK release and are reconstructed separately, then hash-checked
// against the candidate's attested transport provenance.
export function candidateReleaseAssetNames(manifestFile, manifest) {
  return [
    ...manifest.assets.map(({ name }) => name), manifestFile, manifest.sdk.manifestFile,
    "photo-candidate-artifact-receipt.json", "photo-candidate-provenance.json",
  ].sort();
}

export function sdkProofReleaseMetadata(rawRelease, tagRef) {
  try {
    if (!rawRelease?.tag_name?.startsWith("photo-sdk-v")) fail("SDK tagが不正です");
    assertStrictVersion(rawRelease.tag_name.slice("photo-sdk-v".length));
  } catch { fail("SDK Release/tag/asset metadataが不正です"); }
  if (!Number.isSafeInteger(rawRelease?.id) || rawRelease.id <= 0
    || rawRelease.draft !== false || typeof rawRelease.prerelease !== "boolean"
    || !FULL_SHA.test(rawRelease.target_commitish ?? "")
    || tagRef?.ref !== `refs/tags/${rawRelease.tag_name}`
    || tagRef.object?.type !== "commit" || tagRef.object.sha !== rawRelease.target_commitish
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(rawRelease.published_at ?? "")
    || !Array.isArray(rawRelease.assets) || rawRelease.assets.length === 0
    || rawRelease.assets.some((asset) => !SAFE_ASSET.test(asset?.name ?? "") || asset.state !== "uploaded"
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES)
    || new Set(rawRelease.assets.map(({ name }) => name)).size !== rawRelease.assets.length
    || !rawRelease.assets.some(({ name, size }) => name === "photo-sdk-artifact-receipt.json" && size <= 8 * 1024 * 1024)) {
    fail("SDK Release/tag/asset metadataが不正です");
  }
  return {
    schemaVersion: 1, repository: PHOTO_UPDATER_RELEASE.repository,
    releaseId: rawRelease.id, tagName: rawRelease.tag_name, tagSha: tagRef.object.sha,
    targetCommitish: rawRelease.target_commitish, draft: false, prerelease: rawRelease.prerelease,
    publishedAt: rawRelease.published_at,
    assets: rawRelease.assets.map(({ name, size: bytes }) => ({ name, bytes })).sort((left, right) => left.name.localeCompare(right.name, "en")),
  };
}

function fail(message) {
  throw new PhotoUpdaterReleaseError(message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(`${label} schemaが不正です`);
  return value;
}

function isHex(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateCandidateReleaseMetadata(release, tag) {
  if (!CANDIDATE_TAG.test(tag) || release?.tag_name !== tag || release.draft !== false || release.prerelease !== true
    || !Array.isArray(release.assets) || !release.assets.length) fail("candidate releaseが未公開またはprereleaseではありません");
  const names = release.assets.map((asset) => asset?.name);
  if (names.some((name) => typeof name !== "string" || !SAFE_ASSET.test(name)) || new Set(names).size !== names.length
    || release.assets.some((asset) => asset?.state !== "uploaded" || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES)) {
    fail("candidate release asset一覧が不正です");
  }
  return [...names].sort();
}

export function verifyCandidateAttestation(output, { candidate, manifestBytes, provenance }) {
  if (!Array.isArray(output) || output.length !== 1) fail("candidate attestationが一意ではありません");
  const result = output[0]?.verificationResult;
  const statement = result?.statement;
  const certificate = result?.signature?.certificate;
  const predicate = statement?.predicate;
  const manifest = candidate.manifest;
  const workflow = predicate?.buildDefinition?.externalParameters?.workflow;
  const github = predicate?.buildDefinition?.internalParameters?.github;
  const invocation = `${PHOTO_UPDATER_RELEASE.repositoryUrl}/actions/runs/${manifest.run.id}/attempts/${manifest.run.attempt}`;
  const workflowIdentity = `${PHOTO_UPDATER_RELEASE.repositoryUrl}/${PHOTO_UPDATER_RELEASE.candidateWorkflow}@${PHOTO_UPDATER_RELEASE.branchRef}`;
  const sourceSha = provenance.toolingSourceSha;
  const subjects = statement?.subject;
  const sources = Array.isArray(predicate?.buildDefinition?.resolvedDependencies)
    ? predicate.buildDefinition.resolvedDependencies.filter((item) => item?.uri === `git+${PHOTO_UPDATER_RELEASE.repositoryUrl}@${PHOTO_UPDATER_RELEASE.branchRef}`)
    : [];
  const tlog = Array.isArray(result?.verifiedTimestamps)
    ? result.verifiedTimestamps.find((item) => item?.type === "Tlog" && item.uri === REKOR_URL
      && typeof item.timestamp === "string" && Number.isFinite(Date.parse(item.timestamp)))
    : undefined;
  const subjectMatches = statement?._type === "https://in-toto.io/Statement/v1" && Array.isArray(subjects)
    && subjects.length === 1 && subjects[0]?.name === candidate.manifestFile
    && subjects[0]?.digest?.sha256 === sha256(manifestBytes);
  const certificateMatches = certificate?.subjectAlternativeName === workflowIdentity
    && certificate?.githubWorkflowRepository === PHOTO_UPDATER_RELEASE.repository
    && certificate?.githubWorkflowRef === PHOTO_UPDATER_RELEASE.branchRef
    && certificate?.githubWorkflowSHA === sourceSha
    && certificate?.sourceRepositoryURI === PHOTO_UPDATER_RELEASE.repositoryUrl
    && certificate?.sourceRepositoryRef === PHOTO_UPDATER_RELEASE.branchRef
    && certificate?.sourceRepositoryDigest === sourceSha
    && certificate?.sourceRepositoryVisibilityAtSigning === "public"
    && certificate?.buildConfigURI === workflowIdentity
    && certificate?.buildConfigDigest === sourceSha
    && certificate?.buildSignerURI === workflowIdentity
    && certificate?.buildSignerDigest === sourceSha
    && certificate?.buildTrigger === PHOTO_UPDATER_RELEASE.trigger;
  const invocationMatches = certificate?.runInvocationURI === invocation
    && predicate?.runDetails?.builder?.id === workflowIdentity
    && predicate?.runDetails?.metadata?.invocationId === invocation;
  const workflowMatches = workflow?.repository === PHOTO_UPDATER_RELEASE.repositoryUrl
    && workflow?.path === PHOTO_UPDATER_RELEASE.candidateWorkflow
    && workflow?.ref === PHOTO_UPDATER_RELEASE.branchRef
    && github?.event_name === PHOTO_UPDATER_RELEASE.trigger
    && String(github?.repository_id) === "1426802549"
    && String(github?.repository_owner_id) === "345807639";
  const sourceMatches = sources.length === 1 && sources[0]?.digest?.gitCommit === sourceSha;
  if (!isHex(sourceSha, FULL_SHA) || !subjectMatches || statement?.predicateType !== SLSA_PROVENANCE
    || !certificateMatches || !invocationMatches || !workflowMatches || !sourceMatches || !tlog) {
    fail("candidate attestationがPhotoの公式main workflowと一致しません");
  }
  return { toolingSourceSha: sourceSha, runId: manifest.run.id, runAttempt: manifest.run.attempt };
}

export function verifyCandidateTransportProof({ candidate, sdkProof, manifestBytes, receipt, receiptBytes, provenance }) {
  const manifest = candidate.manifest;
  const sdkSchema = sdkProof.manifest.schemaVersion;
  exactKeys(receipt, ["schemaVersion", "repository", "sourceSha", "sourceTree", "sourceOwnershipDigest", "version", "runId", "runAttempt", "artifact", "candidateManifest", "sdk"], "candidate receipt");
  exactKeys(receipt.artifact, ["id", "name", "digest"], "candidate artifact receipt");
  exactKeys(receipt.candidateManifest, ["file", "sha256"], "candidate manifest receipt");
  exactKeys(receipt.sdk, ["version", "sourceSha", "manifest", ...(sdkSchema >= 2 ? ["sdkManifestSchemaVersion"] : [])], "candidate SDK receipt");
  exactKeys(receipt.sdk.manifest, ["file", "sha256"], "candidate SDK manifest receipt");
  exactKeys(provenance, ["schemaVersion", "predicateType", "repository", "toolingSourceSha", "subject", "sdk", "workflow", "transportReceipt"], "candidate provenance");
  exactKeys(provenance.subject, ["sourceSha", "version", "candidateManifest"], "candidate provenance subject");
  exactKeys(provenance.subject.candidateManifest, ["file", "sha256"], "candidate provenance manifest");
  exactKeys(provenance.sdk, ["version", "sourceSha", "manifest", ...(sdkSchema >= 2 ? ["sdkManifestSchemaVersion"] : []), "release", "receipt"], "candidate provenance SDK");
  exactKeys(provenance.sdk.manifest, ["file", "sha256"], "candidate provenance SDK manifest");
  exactKeys(provenance.sdk.release, ["tag", "id", "metadataSha256"], "candidate provenance SDK release");
  exactKeys(provenance.sdk.receipt, ["file", "sha256"], "candidate provenance SDK receipt");
  exactKeys(provenance.workflow, ["runId", "runAttempt"], "candidate provenance workflow");
  exactKeys(provenance.transportReceipt, ["file", "sha256"], "candidate transport receipt");

  const expectedArtifactName = `niho-photo-candidate-${manifest.source.commit}-run-${manifest.run.id}-attempt-${manifest.run.attempt}`;
  const candidateManifestPin = { file: candidate.manifestFile, sha256: sha256(manifestBytes) };
  const sdkManifestPin = { file: sdkProof.manifestFile, sha256: sdkProof.manifestSha256 };
  const sdkManifestSchemaPin = sdkSchema >= 2 ? { sdkManifestSchemaVersion: sdkSchema } : {};
  const sdkReleaseMetadataBytes = readFileSync(path.join(sdkProof.directory, sdkProof.releaseFile));
  const sdkReceiptBytes = readFileSync(path.join(sdkProof.directory, sdkProof.receiptFile));
  const receiptPin = { file: "photo-candidate-artifact-receipt.json", sha256: sha256(receiptBytes) };
  const matched = receipt.schemaVersion === 1 && receipt.repository === PHOTO_UPDATER_RELEASE.repository
    && receipt.sourceSha === manifest.source.commit && receipt.sourceTree === manifest.source.tree
    && receipt.sourceOwnershipDigest === manifest.sourceOwnership.digest && receipt.version === manifest.version
    && receipt.runId === manifest.run.id && receipt.runAttempt === manifest.run.attempt
    && POSITIVE.test(String(receipt.artifact?.id)) && receipt.artifact.name === expectedArtifactName
    && /^sha256:[a-f0-9]{64}$/u.test(receipt.artifact.digest ?? "")
    && sameJson(receipt.candidateManifest, candidateManifestPin)
    && receipt.sdk.version === manifest.sdk.version && receipt.sdk.sourceSha === manifest.sdk.source.commit
    && sameJson(receipt.sdk.manifest, sdkManifestPin)
    && (sdkSchema < 2 || receipt.sdk.sdkManifestSchemaVersion === sdkSchema)
    && provenance.schemaVersion === 1 && provenance.predicateType === CANDIDATE_PROVENANCE
    && provenance.repository === PHOTO_UPDATER_RELEASE.repository && isHex(provenance.toolingSourceSha, FULL_SHA)
    && provenance.subject.sourceSha === manifest.source.commit && provenance.subject.version === manifest.version
    && sameJson(provenance.subject.candidateManifest, candidateManifestPin)
    && provenance.sdk.version === manifest.sdk.version && provenance.sdk.sourceSha === manifest.sdk.source.commit
    && sameJson(provenance.sdk.manifest, sdkManifestPin)
    && (sdkSchema < 2 || provenance.sdk.sdkManifestSchemaVersion === sdkSchema)
    && provenance.sdk.release.tag === sdkProof.release.tagName
    && provenance.sdk.release.id === String(sdkProof.release.releaseId)
    && provenance.sdk.release.metadataSha256 === sha256(sdkReleaseMetadataBytes)
    && provenance.sdk.receipt.file === sdkProof.receiptFile
    && provenance.sdk.receipt.sha256 === sha256(sdkReceiptBytes)
    && provenance.workflow.runId === manifest.run.id && provenance.workflow.runAttempt === manifest.run.attempt
    && provenance.transportReceipt.file === "photo-candidate-artifact-receipt.json"
    && provenance.transportReceipt.sha256 === receiptPin.sha256;
  if (!matched) fail("candidate receiptとprovenanceがmanifest/SDK proofに一致しません");
  return { toolingSourceSha: provenance.toolingSourceSha, receiptPin, candidateManifestPin };
}

export function buildUpdaterManifest({ version, signature, archiveName }) {
  const decodedSignature = typeof signature === "string" && /^[A-Za-z0-9+/]+={0,2}$/u.test(signature)
    ? Buffer.from(signature, "base64").toString("utf8")
    : "";
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)
    || typeof signature !== "string" || signature.length < 32 || signature.length > 16 * 1024
    || !decodedSignature.startsWith("untrusted comment: signature from tauri secret key\n")
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(decodedSignature)
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.app\.tar\.gz$/u.test(archiveName)) {
    fail("Tauri updater manifestの入力が不正です");
  }
  const tag = `photo-app-v${version}`;
  const url = `${PHOTO_UPDATER_RELEASE.repositoryUrl}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(archiveName)}`;
  return {
    version,
    notes: `NIHO photo ${version} を公開しました。`,
    platforms: {
      [PHOTO_UPDATER_RELEASE.target]: { signature, url },
    },
  };
}

export function expectedCandidateAssetNames(candidate) {
  return [
    ...candidate.assets,
    candidate.manifestFile,
  ];
}

export function verifyCandidateDirectoryForRelease(directory) {
  const candidate = verifyCandidateDirectory(directory);
  if (candidate.manifest.repository !== PHOTO_UPDATER_RELEASE.repository
    || candidate.manifest.app.updater.feed !== PHOTO_UPDATER_RELEASE.feedUrl
    || candidate.manifest.app.updater.publicKeySha256 !== candidateContract.updaterPublicKeySha256) {
    fail("candidateがPhoto公式updater契約と一致しません");
  }
  return candidate;
}

export function verifySdkProofForRelease({ directory, candidate }) {
  return verifySdkProofDirectory({
    directory,
    candidateManifest: candidate.manifest,
    expectedSdkVersion: candidate.manifest.sdk.version,
    expectedSdkManifestSha256: candidate.manifest.sdk.manifestSha256,
  });
}
