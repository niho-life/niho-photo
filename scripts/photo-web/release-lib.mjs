import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { validateReleaseManifest } from "../sdk/verify-release-artifact.mjs";

export const PHOTO_WEB_RELEASE = Object.freeze({
  repository: "niho-life/niho-photo",
  repositoryId: "1426802549",
  ownerId: "345807639",
  workflow: ".github/workflows/photo-web-release.yml",
  workflowRef: "refs/heads/main",
  event: "workflow_dispatch",
  publishJob: "Publish immutable Photo Web release",
});

export const PHOTO_WEB_BUDGET = Object.freeze({
  archive: 32 * 1024 * 1024,
  expanded: 32 * 1024 * 1024,
  file: 8 * 1024 * 1024,
  count: 128,
  metadata: 2 * 1024 * 1024,
});

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const POSITIVE = /^[1-9]\d*$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@+,-]*$/u;
const SDK_RECEIPT_FILE = "photo-sdk-artifact-receipt.json";
const SDK_ATTESTATION_WORKFLOW = ".github/workflows/photo-sdk-release.yml";
const SDK_ATTESTATION_IDENTITY = `https://github.com/${PHOTO_WEB_RELEASE.repository}/${SDK_ATTESTATION_WORKFLOW}@${PHOTO_WEB_RELEASE.workflowRef}`;
const SDK_REPOSITORY_URI = `https://github.com/${PHOTO_WEB_RELEASE.repository}`;
const REQUIRED_PROOFS = Object.freeze([
  "provenance/sdk-manifest.json",
  "provenance/sdk-receipt.json",
  "provenance/sdk-attestation.json",
]);

export class PhotoWebReleaseBuildError extends Error {}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  throw new PhotoWebReleaseBuildError(message);
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`${label} schema is invalid`);
  }
  return value;
}

function ordinaryDirectory(directory, label) {
  const info = lstatSync(directory, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a regular directory`);
}

function ordinaryFile(file, maximum, label) {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximum) fail(`${label} must be a bounded regular file`);
  const bytes = readFileSync(file);
  if (bytes.byteLength !== info.size) fail(`${label} changed while being read`);
  return bytes;
}

export function validateSdkAttestationEvidence(value, manifest, manifestFile, manifestSha256) {
  exactKeys(value, ["schemaVersion", "provider", "repository", "workflow", "ref", "sourceCommit", "subjectFile", "subjectSha256", "runId", "runAttempt", "predicateType", "transparencyLog"], "SDK attestation evidence");
  exactKeys(value.transparencyLog, ["uri", "timestamp"], "SDK attestation transparency log");
  if (value.schemaVersion !== 1 || value.provider !== "github-actions-sigstore" || value.repository !== PHOTO_WEB_RELEASE.repository
    || value.workflow !== SDK_ATTESTATION_WORKFLOW || value.ref !== PHOTO_WEB_RELEASE.workflowRef
    || value.sourceCommit !== manifest.source.commit || value.subjectFile !== manifestFile || value.subjectSha256 !== manifestSha256
    || !POSITIVE.test(value.runId ?? "") || !POSITIVE.test(value.runAttempt ?? "")
    || value.predicateType !== "https://slsa.dev/provenance/v1" || value.transparencyLog.uri !== "https://rekor.sigstore.dev"
    || typeof value.transparencyLog.timestamp !== "string" || !Number.isFinite(Date.parse(value.transparencyLog.timestamp))) {
    fail("SDK attestation evidence does not match the published SDK manifest");
  }
  return value;
}

export function normalizeSdkAttestationOutput(output, manifest, manifestFile, manifestBytes, receipt) {
  if (!Array.isArray(output) || output.length !== 1) fail("SDK manifest attestation result is not unique");
  const result = output[0]?.verificationResult;
  const statement = result?.statement;
  const certificate = result?.signature?.certificate;
  const predicate = statement?.predicate;
  const subjects = statement?.subject;
  const workflow = predicate?.buildDefinition?.externalParameters?.workflow;
  const github = predicate?.buildDefinition?.internalParameters?.github;
  const dependencies = predicate?.buildDefinition?.resolvedDependencies;
  const sources = Array.isArray(dependencies)
    ? dependencies.filter((item) => item && typeof item.uri === "string" && item.uri.startsWith(`git+${SDK_REPOSITORY_URI}@`))
    : [];
  const tlog = Array.isArray(result?.verifiedTimestamps)
    ? result.verifiedTimestamps.find((item) => item?.type === "Tlog" && item.uri === "https://rekor.sigstore.dev"
      && typeof item.timestamp === "string" && Number.isFinite(Date.parse(item.timestamp)))
    : undefined;
  const invocation = `${SDK_REPOSITORY_URI}/actions/runs/${receipt.runId}/attempts/${receipt.runAttempt}`;
  const manifestSha256 = sha256(manifestBytes);
  const subjectMatches = statement?._type === "https://in-toto.io/Statement/v1" && Array.isArray(subjects) && subjects.length === 1
    && subjects[0]?.name === manifestFile && subjects[0]?.digest?.sha256 === manifestSha256;
  const certificateMatches = certificate?.subjectAlternativeName === SDK_ATTESTATION_IDENTITY
    && certificate?.githubWorkflowRepository === PHOTO_WEB_RELEASE.repository
    && certificate?.githubWorkflowRef === PHOTO_WEB_RELEASE.workflowRef
    && certificate?.githubWorkflowSHA === manifest.source.commit
    && certificate?.sourceRepositoryURI === SDK_REPOSITORY_URI
    && String(certificate?.sourceRepositoryIdentifier) === PHOTO_WEB_RELEASE.repositoryId
    && String(certificate?.sourceRepositoryOwnerIdentifier) === PHOTO_WEB_RELEASE.ownerId
    && certificate?.sourceRepositoryRef === PHOTO_WEB_RELEASE.workflowRef
    && certificate?.sourceRepositoryDigest === manifest.source.commit
    && certificate?.sourceRepositoryVisibilityAtSigning === "public"
    && certificate?.buildConfigURI === SDK_ATTESTATION_IDENTITY
    && certificate?.buildConfigDigest === manifest.source.commit
    && certificate?.buildSignerURI === SDK_ATTESTATION_IDENTITY
    && certificate?.buildSignerDigest === manifest.source.commit
    && certificate?.buildTrigger === PHOTO_WEB_RELEASE.event;
  const invocationMatches = certificate?.runInvocationURI === invocation
    && predicate?.runDetails?.builder?.id === SDK_ATTESTATION_IDENTITY
    && predicate?.runDetails?.metadata?.invocationId === invocation;
  const workflowMatches = workflow?.repository === SDK_REPOSITORY_URI && workflow?.path === SDK_ATTESTATION_WORKFLOW
    && workflow?.ref === PHOTO_WEB_RELEASE.workflowRef && github?.event_name === PHOTO_WEB_RELEASE.event
    && String(github?.repository_id) === PHOTO_WEB_RELEASE.repositoryId
    && String(github?.repository_owner_id) === PHOTO_WEB_RELEASE.ownerId;
  const sourceMatches = sources.length === 1 && sources[0]?.uri === `git+${SDK_REPOSITORY_URI}@${PHOTO_WEB_RELEASE.workflowRef}`
    && sources[0]?.digest?.gitCommit === manifest.source.commit;
  if (!subjectMatches || statement?.predicateType !== "https://slsa.dev/provenance/v1" || !certificateMatches
    || !invocationMatches || !workflowMatches || !sourceMatches || !tlog) {
    fail("SDK manifest attestation does not match the official workflow, source, run, and transparency log");
  }
  return validateSdkAttestationEvidence(Object.freeze({
    schemaVersion: 1,
    provider: "github-actions-sigstore",
    repository: PHOTO_WEB_RELEASE.repository,
    workflow: SDK_ATTESTATION_WORKFLOW,
    ref: PHOTO_WEB_RELEASE.workflowRef,
    sourceCommit: manifest.source.commit,
    subjectFile: manifestFile,
    subjectSha256: manifestSha256,
    runId: receipt.runId,
    runAttempt: receipt.runAttempt,
    predicateType: statement.predicateType,
    transparencyLog: Object.freeze({ uri: "https://rekor.sigstore.dev", timestamp: tlog.timestamp }),
  }), manifest, manifestFile, manifestSha256);
}

export function validateSdkReceiptEvidence(receipt, manifest, manifestFile, manifestSha256) {
  exactKeys(receipt, ["schemaVersion", "repository", "sourceSha", "sourceOwnershipDigest", "version", "runId", "runAttempt", "artifact", "releaseManifest"], "SDK release receipt");
  exactKeys(receipt.artifact, ["id", "name", "digest"], "SDK receipt artifact");
  exactKeys(receipt.releaseManifest, ["file", "sha256"], "SDK receipt manifest");
  if (receipt.schemaVersion !== 1 || receipt.repository !== PHOTO_WEB_RELEASE.repository || receipt.sourceSha !== manifest.source.commit
    || receipt.sourceOwnershipDigest !== manifest.sourceOwnership.digest || receipt.version !== manifest.version
    || !POSITIVE.test(receipt.runId ?? "") || !POSITIVE.test(receipt.runAttempt ?? "")
    || !POSITIVE.test(receipt.artifact.id ?? "")
    || receipt.artifact.name !== `niho-photo-sdk-${manifest.source.commit}-run-${receipt.runId}-attempt-${receipt.runAttempt}`
    || !/^sha256:[a-f0-9]{64}$/u.test(receipt.artifact.digest ?? "")
    || receipt.releaseManifest.file !== manifestFile || receipt.releaseManifest.sha256 !== manifestSha256) {
    fail("SDK release receipt does not match the published SDK manifest");
  }
  return receipt;
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || value.startsWith("/") || value.endsWith("/")
    || value.includes("\\") || value.includes("%") || !/^[\x21-\x7e]+$/u.test(value)) fail("release file path is invalid");
  if (value.split("/").some((part) => !SAFE_SEGMENT.test(part) || part.startsWith("."))) fail("release file path is invalid");
  return value;
}

function collectTree(root, prefix, records) {
  ordinaryDirectory(root, prefix);
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    const relative = safeRelativePath(`${prefix}/${entry.name}`);
    const info = lstatSync(file);
    if (info.isSymbolicLink()) fail("release payload cannot contain links");
    if (entry.isDirectory()) {
      collectTree(file, relative, records);
    } else if (entry.isFile()) {
      const bytes = ordinaryFile(file, PHOTO_WEB_BUDGET.file, relative);
      records.push({ path: relative, bytes });
      if (records.length > PHOTO_WEB_BUDGET.count) fail("release file count exceeds its budget");
    } else {
      fail("release payload contains a special file");
    }
  }
}

function octal(value, width) {
  const raw = value.toString(8).padStart(width - 1, "0");
  if (raw.length >= width) fail("USTAR numeric field is too large");
  return `${raw}\0`;
}

function putText(header, start, length, value) {
  const bytes = Buffer.from(value, "ascii");
  if (bytes.length > length) fail("USTAR text field is too long");
  bytes.copy(header, start);
}

function splitUstarPath(value) {
  if (Buffer.byteLength(value, "ascii") <= 100) return { name: value, prefix: "" };
  for (let index = value.lastIndexOf("/"); index > 0; index = value.lastIndexOf("/", index - 1)) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (Buffer.byteLength(prefix, "ascii") <= 155 && Buffer.byteLength(name, "ascii") <= 100) return { name, prefix };
  }
  fail("release file path cannot be represented in USTAR");
}

function ustarHeader(memberPath, { directory, size }) {
  const header = Buffer.alloc(512);
  const normalized = directory ? `${memberPath}/` : memberPath;
  const { name, prefix } = splitUstarPath(normalized);
  putText(header, 0, 100, name);
  putText(header, 100, 8, octal(directory ? 0o755 : 0o644, 8));
  putText(header, 108, 8, octal(0, 8));
  putText(header, 116, 8, octal(0, 8));
  putText(header, 124, 12, octal(size, 12));
  putText(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = directory ? 0x35 : 0x30;
  putText(header, 257, 6, "ustar\0");
  putText(header, 263, 2, "00");
  putText(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  putText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function createUstar(records) {
  const parents = new Set();
  for (const { path: value } of records) {
    const parts = value.split("/");
    for (let index = 1; index < parts.length; index += 1) parents.add(parts.slice(0, index).join("/"));
  }
  const directories = [...parents].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b, "en"));
  const chunks = [];
  for (const directory of directories) chunks.push(ustarHeader(directory, { directory: true, size: 0 }));
  for (const record of records) {
    chunks.push(ustarHeader(record.path, { directory: false, size: record.bytes.length }));
    chunks.push(record.bytes);
    const padding = (512 - (record.bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function jsonFile(file, label) {
  const bytes = ordinaryFile(file, PHOTO_WEB_BUDGET.metadata, label);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} is not UTF-8 JSON`); }
  return { bytes, value };
}

function validateInputLayout(root) {
  ordinaryDirectory(root, "build payload");
  const names = readdirSync(root).sort();
  if (JSON.stringify(names) !== JSON.stringify(["provenance", "server", "static"])) fail("build payload layout is not exact");
  ordinaryDirectory(path.join(root, "server"), "server payload");
  if (JSON.stringify(readdirSync(path.join(root, "server")).sort()) !== JSON.stringify(["photo-web.mjs"])) fail("server payload layout is not exact");
  ordinaryDirectory(path.join(root, "provenance"), "provenance payload");
  if (JSON.stringify(readdirSync(path.join(root, "provenance")).sort()) !== JSON.stringify(["sdk-attestation.json", "sdk-manifest.json", "sdk-receipt.json"])) fail("SDK provenance payload layout is not exact");
  ordinaryDirectory(path.join(root, "static"), "static payload");
}

function proofRecord(file, relative, maximum = PHOTO_WEB_BUDGET.metadata) {
  const bytes = ordinaryFile(file, maximum, relative);
  return Object.freeze({ file: relative, sha256: sha256(bytes), sizeBytes: bytes.length });
}

function validateBuildProof(build, sdkManifest, sdkManifestSha256) {
  if (!build || typeof build !== "object" || Array.isArray(build) || build.schemaVersion !== 1
    || typeof build.buildId !== "string" || !/^[A-Za-z0-9._:@+-]{1,160}$/u.test(build.buildId)
    || build.sdk?.sdkVersion !== sdkManifest.version || build.sdk?.sourceCommit !== sdkManifest.source.commit
    || build.sdk?.manifestSha256 !== sdkManifestSha256) fail("static build metadata is not bound to the SDK release");
  return build;
}

function validateWebManifest(manifest, { sourceSha, sourceTree, toolingCommit, records, archiveBytes, sdkManifest, sdkManifestSha256 }) {
  exactKeys(manifest, ["schemaVersion", "kind", "releaseId", "repository", "source", "sdk", "build", "archive", "files", "entrypoints", "provenance"], "Photo Web release manifest");
  exactKeys(manifest.repository, ["name", "id", "ownerId"], "Photo Web repository");
  exactKeys(manifest.source, ["commit", "tree"], "Photo Web source");
  exactKeys(manifest.sdk, ["version", "manifest", "runtimeManifestSha256", "source", "sourceOwnership", "receipt", "attestation"], "Photo Web SDK binding");
  exactKeys(manifest.build, ["staticBuildFile", "staticBuildSha256", "staticBuildId"], "Photo Web build");
  exactKeys(manifest.archive, ["file", "sha256", "sizeBytes", "expandedBytes", "fileCount"], "Photo Web archive");
  exactKeys(manifest.entrypoints, ["server", "staticRoot"], "Photo Web entrypoints");
  exactKeys(manifest.provenance, ["workflow", "ref", "event", "toolingCommit", "runId", "runAttempt", "artifact"], "Photo Web provenance");
  exactKeys(manifest.provenance.artifact, ["id", "name", "digest"], "Photo Web build artifact");
  const expectedNames = records.map(({ path: filePath }) => filePath);
  const actualNames = manifest.files.map(({ path: filePath }) => filePath);
  if (manifest.schemaVersion !== 1 || manifest.kind !== "niho-photo-web" || manifest.releaseId !== sourceSha
    || manifest.repository.name !== PHOTO_WEB_RELEASE.repository || manifest.repository.id !== PHOTO_WEB_RELEASE.repositoryId
    || manifest.repository.ownerId !== PHOTO_WEB_RELEASE.ownerId || manifest.source.commit !== sourceSha || manifest.source.tree !== sourceTree
    || manifest.sdk.version !== sdkManifest.version || manifest.sdk.runtimeManifestSha256 !== sdkManifest.engine.manifest.sha256
    || manifest.sdk.source.commit !== sdkManifest.source.commit || manifest.sdk.source.tree !== sdkManifest.source.tree
    || JSON.stringify(manifest.sdk.sourceOwnership) !== JSON.stringify(sdkManifest.sourceOwnership)
    || manifest.build.staticBuildFile !== "static/photo-build.json" || !SHA256.test(manifest.build.staticBuildSha256)
    || manifest.archive.file !== `niho-photo-web-${sourceSha}.tgz` || manifest.archive.sha256 !== sha256(archiveBytes)
    || manifest.archive.sizeBytes !== archiveBytes.length || manifest.archive.expandedBytes !== records.reduce((sum, item) => sum + item.sizeBytes, 0)
    || manifest.archive.fileCount !== records.length || JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
    || manifest.entrypoints.server !== "server/photo-web.mjs" || manifest.entrypoints.staticRoot !== "static"
    || manifest.provenance.workflow !== PHOTO_WEB_RELEASE.workflow || manifest.provenance.ref !== PHOTO_WEB_RELEASE.workflowRef
    || manifest.provenance.event !== PHOTO_WEB_RELEASE.event || manifest.provenance.toolingCommit !== toolingCommit
    || !POSITIVE.test(manifest.provenance.runId) || !POSITIVE.test(manifest.provenance.runAttempt)) {
    fail("Photo Web release manifest does not match its source, SDK, archive, and workflow inputs");
  }
  const inputHashes = new Map(records.map(({ path: filePath, sha256: digest, sizeBytes }) => [filePath, { sha256: digest, sizeBytes }]));
  for (const item of manifest.files) {
    exactKeys(item, ["path", "sha256", "sizeBytes", "mode"], "Photo Web file record");
    const actual = inputHashes.get(item.path);
    if (!actual || actual.sha256 !== item.sha256 || actual.sizeBytes !== item.sizeBytes || item.mode !== "0644") fail("Photo Web file inventory does not match the archive input");
  }
  if (manifest.sdk.manifest.file !== REQUIRED_PROOFS[0] || manifest.sdk.manifest.sha256 !== sdkManifestSha256
    || manifest.sdk.receipt.file !== REQUIRED_PROOFS[1] || manifest.sdk.attestation.file !== REQUIRED_PROOFS[2]) {
    fail("Photo Web SDK proof paths or hashes do not match the official SDK proof");
  }
}

export function createPhotoWebRelease({
  inputDirectory, outputDirectory, sourceSha, sourceTree, toolingCommit, runId, runAttempt, artifact,
}) {
  for (const [value, label] of [[sourceSha, "source commit"], [sourceTree, "source tree"], [toolingCommit, "tooling commit"]]) {
    if (!COMMIT.test(value ?? "")) fail(`${label} must be a full commit SHA`);
  }
  if (!POSITIVE.test(String(runId ?? "")) || !POSITIVE.test(String(runAttempt ?? ""))) fail("workflow run identity is invalid");
  if (!artifact || !POSITIVE.test(String(artifact.id ?? "")) || !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? "")
    || artifact.name !== `niho-photo-web-${sourceSha}-run-${runId}-attempt-${runAttempt}`) fail("build artifact identity is invalid");

  const input = path.resolve(inputDirectory);
  const output = path.resolve(outputDirectory);
  validateInputLayout(input);
  if (lstatSync(output, { throwIfNoEntry: false })) fail("release output must be a new directory");

  const manifestRead = jsonFile(path.join(input, "provenance/sdk-manifest.json"), "SDK manifest");
  const sdkManifest = validateReleaseManifest(manifestRead.value);
  const sdkManifestFile = `niho-photo-sdk-${sdkManifest.version}-${sdkManifest.source.commit}.json`;
  const sdkManifestSha256 = sha256(manifestRead.bytes);
  const receiptRead = jsonFile(path.join(input, "provenance/sdk-receipt.json"), "SDK release receipt");
  const sdkReceipt = validateSdkReceiptEvidence(receiptRead.value, sdkManifest, sdkManifestFile, sdkManifestSha256);
  const sdkAttestationRead = jsonFile(path.join(input, "provenance/sdk-attestation.json"), "SDK attestation proof");
  const sdkAttestation = validateSdkAttestationEvidence(sdkAttestationRead.value, sdkManifest, sdkManifestFile, sdkManifestSha256);
  if (sdkAttestation.runId !== sdkReceipt.runId || sdkAttestation.runAttempt !== sdkReceipt.runAttempt) fail("SDK attestation run identity does not match its release receipt");
  if (sdkReceipt.artifact.digest.length !== 71) fail("SDK receipt artifact digest is invalid");

  const staticBuildFile = path.join(input, "static/photo-build.json");
  const staticBuildRead = jsonFile(staticBuildFile, "Photo Web static build metadata");
  const staticBuild = validateBuildProof(staticBuildRead.value, sdkManifest, sdkManifestSha256);
  const files = [];
  collectTree(path.join(input, "server"), "server", files);
  collectTree(path.join(input, "static"), "static", files);
  collectTree(path.join(input, "provenance"), "provenance", files);
  for (const required of ["server/photo-web.mjs", "static/photo-build.json", ...REQUIRED_PROOFS]) {
    if (!files.some((record) => record.path === required)) fail(`release payload is missing ${required}`);
  }
  const fileRecords = files.map(({ path: filePath, bytes }) => ({ path: filePath, sha256: sha256(bytes), sizeBytes: bytes.length, mode: "0644" }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const expandedBytes = files.reduce((sum, record) => sum + record.bytes.length, 0);
  if (expandedBytes > PHOTO_WEB_BUDGET.expanded) fail("expanded release payload exceeds its budget");

  const archiveFile = `niho-photo-web-${sourceSha}.tgz`;
  const archiveBytes = createUstar(files.sort((a, b) => a.path.localeCompare(b.path, "en")));
  if (archiveBytes.length <= 0 || archiveBytes.length > PHOTO_WEB_BUDGET.archive) fail("compressed release archive exceeds its budget");
  const archive = Object.freeze({
    file: archiveFile,
    sha256: sha256(archiveBytes),
    sizeBytes: archiveBytes.length,
    expandedBytes,
    fileCount: files.length,
  });
  const sdk = Object.freeze({
    version: sdkManifest.version,
    manifest: proofRecord(path.join(input, "provenance/sdk-manifest.json"), REQUIRED_PROOFS[0]),
    runtimeManifestSha256: sdkManifest.engine.manifest.sha256,
    source: sdkManifest.source,
    sourceOwnership: sdkManifest.sourceOwnership,
    receipt: proofRecord(path.join(input, "provenance/sdk-receipt.json"), REQUIRED_PROOFS[1]),
    attestation: proofRecord(path.join(input, "provenance/sdk-attestation.json"), REQUIRED_PROOFS[2]),
  });
  const manifest = {
    schemaVersion: 1,
    kind: "niho-photo-web",
    releaseId: sourceSha,
    repository: { name: PHOTO_WEB_RELEASE.repository, id: PHOTO_WEB_RELEASE.repositoryId, ownerId: PHOTO_WEB_RELEASE.ownerId },
    source: { commit: sourceSha, tree: sourceTree },
    sdk,
    build: {
      staticBuildFile: "static/photo-build.json",
      staticBuildSha256: sha256(staticBuildRead.bytes),
      staticBuildId: staticBuild.buildId,
    },
    archive,
    files: fileRecords,
    entrypoints: { server: "server/photo-web.mjs", staticRoot: "static" },
    provenance: {
      workflow: PHOTO_WEB_RELEASE.workflow,
      ref: PHOTO_WEB_RELEASE.workflowRef,
      event: PHOTO_WEB_RELEASE.event,
      toolingCommit,
      runId: String(runId),
      runAttempt: String(runAttempt),
      artifact: { id: String(artifact.id), name: artifact.name, digest: artifact.digest },
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (manifestBytes.length > PHOTO_WEB_BUDGET.metadata) fail("Web manifest exceeds its metadata budget");
  validateWebManifest(manifest, { sourceSha, sourceTree, toolingCommit, records: fileRecords, archiveBytes, sdkManifest, sdkManifestSha256 });

  const outputNames = [
    `niho-photo-web-${sourceSha}.json`,
    archiveFile,
  ];
  mkdirSync(output, { recursive: false, mode: 0o755 });
  writeFileSync(path.join(output, outputNames[1]), archiveBytes, { flag: "wx", mode: 0o644 });
  writeFileSync(path.join(output, outputNames[0]), manifestBytes, { flag: "wx", mode: 0o644 });
  return Object.freeze({ manifest, manifestFile: outputNames[0], archiveFile, manifestSha256: sha256(manifestBytes) });
}
