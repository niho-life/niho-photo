import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createPhotoWebRelease, normalizeSdkAttestationOutput, sha256 } from "./release-lib.mjs";
import { createSdkAttestationProof, parseArguments } from "./prepare-sdk-attestation.mjs";
import { SDK_RELEASE_PROFILES } from "../sdk/verify-release-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = [];
const temp = (prefix) => {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
};
after(() => temporary.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

const integrity = (value) => `sha256-${Buffer.from(value, "hex").toString("base64")}`;
const record = (name, index = 1) => {
  const digest = index.toString(16).slice(-1).repeat(64);
  return { path: name, sha256: digest, integrity: integrity(digest), size: index };
};
const runtimeRecord = (name, index) => {
  const digest = index.toString(16).slice(-1).repeat(64);
  return { name, sha256: digest, integrity: integrity(digest), size: index };
};

function sdkManifestFixture() {
  const source = { commit: "a".repeat(40), tree: "b".repeat(40) };
  const profile = SDK_RELEASE_PROFILES[2];
  const ownership = profile.ownedSourcePaths.map((name, index) => ({ path: name, sha256: String(index + 1).padStart(64, "0"), files: 1 }));
  const ownershipDigest = createHash("sha256").update(ownership.map(({ path: name, sha256: digest, files }) => `${name}\0${digest}\0${files}\n`).join("")).digest("hex");
  const packages = profile.packages.map(([id, name], index) => {
    const digest = (index + 1).toString(16).repeat(64);
    return { id, name, file: `${name}-0.1.7.tgz`, sha256: digest, integrity: integrity(digest), size: index + 1 };
  });
  const manifest = {
    schemaVersion: 2,
    releaseReady: true,
    repository: "niho-life/niho-photo",
    version: "0.1.7",
    source,
    sourceOwnership: { algorithm: "sha256-git-file-set-v1", digest: ownershipDigest, paths: ownership },
    buildTooling: { node: "24.x", files: [record("package.json", 1), record("package-lock.json", 2)] },
    packages,
    engine: {
      version: "niho-14",
      crateVersion: "0.27.0",
      contracts: [
        record("packages/photo-editing/src/develop-engine/develop-engine-manifest.ts", 3),
        record("packages/photo-editing/src/develop-engine/develop-settings.ts", 4),
        record("packages/develop-engine/crates/niho-develop/src/settings.rs", 5),
      ],
      buildInputs: [
        record("packages/develop-engine/Cargo.lock", 6),
        record("packages/develop-engine/Cargo.toml", 7),
        record("packages/develop-engine/rust-toolchain.toml", 8),
        record("packages/develop-engine/crates/niho-develop-wasm/Cargo.toml", 9),
        record("packages/develop-engine/crates/niho-develop-wasm/src/lib.rs", 10),
      ],
      manifest: { file: "manifest-0.27.0.json", sha256: "b".repeat(64), integrity: integrity("b".repeat(64)), size: 11 },
      runtimeFiles: [runtimeRecord("runtime.js", 12), runtimeRecord("runtime.wasm", 13), runtimeRecord("runtime.d.ts", 14)],
    },
    recipeCompatibility: {
      format: "javascript-esm-with-declarations",
      supportedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      engineIdentifiers: ["niho-14"],
      nodeRuntimeValidator: true,
      package: "niho-photo-contract",
      export: ".",
    },
    uiSingleton: { package: "niho-photo-ui", hostExport: "niho-photo-editing/sdk-dialog-host", requirement: "Render one shared dialog host." },
  };
  return manifest;
}

function sdkReceiptFixture(manifest, manifestBytes) {
  const source = manifest.source.commit;
  return {
    schemaVersion: 1,
    repository: manifest.repository,
    sourceSha: source,
    sourceOwnershipDigest: manifest.sourceOwnership.digest,
    version: manifest.version,
    runId: "21",
    runAttempt: "2",
    artifact: { id: "72", name: `niho-photo-sdk-${source}-run-21-attempt-2`, digest: `sha256:${"c".repeat(64)}` },
    releaseManifest: { file: `niho-photo-sdk-${manifest.version}-${source}.json`, sha256: sha256(manifestBytes) },
  };
}

function sdkAttestationOutput(manifest, receipt, manifestBytes) {
  const source = manifest.source.commit;
  const repository = "https://github.com/niho-life/niho-photo";
  const workflow = ".github/workflows/photo-sdk-release.yml";
  const identity = `${repository}/${workflow}@refs/heads/main`;
  const invocation = `${repository}/actions/runs/${receipt.runId}/attempts/${receipt.runAttempt}`;
  return [{ verificationResult: {
    statement: {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: `niho-photo-sdk-${manifest.version}-${source}.json`, digest: { sha256: sha256(manifestBytes) } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        buildDefinition: {
          externalParameters: { workflow: { repository, path: workflow, ref: "refs/heads/main" } },
          internalParameters: { github: { event_name: "workflow_dispatch", repository_id: 1426802549, repository_owner_id: 345807639 } },
          resolvedDependencies: [{ uri: `git+${repository}@refs/heads/main`, digest: { gitCommit: source } }],
        },
        runDetails: { builder: { id: identity }, metadata: { invocationId: invocation } },
      },
    },
    signature: { certificate: {
      subjectAlternativeName: identity,
      githubWorkflowRepository: "niho-life/niho-photo",
      githubWorkflowRef: "refs/heads/main",
      githubWorkflowSHA: source,
      sourceRepositoryURI: repository,
      sourceRepositoryIdentifier: 1426802549,
      sourceRepositoryOwnerIdentifier: 345807639,
      sourceRepositoryRef: "refs/heads/main",
      sourceRepositoryDigest: source,
      sourceRepositoryVisibilityAtSigning: "public",
      buildConfigURI: identity,
      buildConfigDigest: source,
      buildSignerURI: identity,
      buildSignerDigest: source,
      buildTrigger: "workflow_dispatch",
      runInvocationURI: invocation,
    } },
    verifiedTimestamps: [{ type: "Tlog", uri: "https://rekor.sigstore.dev", timestamp: "2026-10-29T12:00:00Z" }],
  } }];
}

function inputFixture() {
  const parent = temp("niho-photo-web-input-");
  const inputDirectory = path.join(parent, "payload");
  for (const directory of ["server", "static", "provenance"]) mkdirSync(path.join(inputDirectory, directory), { recursive: true });
  writeFileSync(path.join(inputDirectory, "server/photo-web.mjs"), "// synthetic server bundle\n");
  const sdkManifest = sdkManifestFixture();
  const sdkManifestBytes = Buffer.from(`${JSON.stringify(sdkManifest, null, 2)}\n`);
  const sdkManifestFile = `niho-photo-sdk-${sdkManifest.version}-${sdkManifest.source.commit}.json`;
  const receipt = sdkReceiptFixture(sdkManifest, sdkManifestBytes);
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const evidence = {
    schemaVersion: 1,
    provider: "github-actions-sigstore",
    repository: "niho-life/niho-photo",
    workflow: ".github/workflows/photo-sdk-release.yml",
    ref: "refs/heads/main",
    sourceCommit: sdkManifest.source.commit,
    subjectFile: sdkManifestFile,
    subjectSha256: sha256(sdkManifestBytes),
    runId: receipt.runId,
    runAttempt: receipt.runAttempt,
    predicateType: "https://slsa.dev/provenance/v1",
    transparencyLog: { uri: "https://rekor.sigstore.dev", timestamp: "2026-10-29T12:00:00Z" },
  };
  const staticBuild = {
    schemaVersion: 1,
    buildId: "build-123",
    sdk: { sdkVersion: sdkManifest.version, sourceCommit: sdkManifest.source.commit, manifestSha256: sha256(sdkManifestBytes) },
  };
  writeFileSync(path.join(inputDirectory, "static/photo-build.json"), `${JSON.stringify(staticBuild, null, 2)}\n`);
  writeFileSync(path.join(inputDirectory, "static/index.html"), "<!doctype html><html></html>\n");
  writeFileSync(path.join(inputDirectory, "provenance/sdk-manifest.json"), sdkManifestBytes);
  writeFileSync(path.join(inputDirectory, "provenance/sdk-receipt.json"), receiptBytes);
  writeFileSync(path.join(inputDirectory, "provenance/sdk-attestation.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return { inputDirectory, sdkManifest, receipt, evidence, sdkManifestBytes };
}

test("SDK attestation evidenceを公式workflow/source/run/subjectへ束縛する", () => {
  const fixture = inputFixture();
  const manifestFile = `niho-photo-sdk-${fixture.sdkManifest.version}-${fixture.sdkManifest.source.commit}.json`;
  const output = sdkAttestationOutput(fixture.sdkManifest, fixture.receipt, fixture.sdkManifestBytes);
  const evidence = normalizeSdkAttestationOutput(output, fixture.sdkManifest, manifestFile, fixture.sdkManifestBytes, fixture.receipt);
  assert.equal(evidence.subjectSha256, sha256(fixture.sdkManifestBytes));
  const wrong = structuredClone(output);
  wrong[0].verificationResult.statement.predicate.buildDefinition.internalParameters.github.event_name = "pull_request";
  assert.throws(() => normalizeSdkAttestationOutput(wrong, fixture.sdkManifest, manifestFile, fixture.sdkManifestBytes, fixture.receipt), /official workflow/u);
});

test("SDK proof helper runs the trusted GitHub verifier and writes only normalized evidence", () => {
  const fixture = inputFixture();
  const directory = path.join(temp("niho-photo-web-sdk-proof-"), "sdk");
  mkdirSync(directory);
  const manifestFile = `niho-photo-sdk-${fixture.sdkManifest.version}-${fixture.sdkManifest.source.commit}.json`;
  const manifestPath = path.join(directory, manifestFile);
  const receiptPath = path.join(directory, "photo-sdk-artifact-receipt.json");
  const outputPath = path.join(directory, "sdk-attestation.json");
  writeFileSync(manifestPath, fixture.sdkManifestBytes);
  writeFileSync(receiptPath, `${JSON.stringify(fixture.receipt, null, 2)}\n`);
  let calls = 0;
  createSdkAttestationProof({ manifestPath, receiptPath, outputPath, runCli: (command, args) => {
    calls += 1;
    assert.equal(command, "gh");
    assert.deepEqual(args.slice(0, 3), ["attestation", "verify", manifestPath]);
    return JSON.stringify(sdkAttestationOutput(fixture.sdkManifest, fixture.receipt, fixture.sdkManifestBytes));
  } });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), fixture.evidence);
  assert.throws(() => createSdkAttestationProof({ manifestPath, receiptPath, outputPath, runCli: () => "[]" }), /already exist/u);
});

test("SDK proof CLI maps required flags to the proof helper inputs", () => {
  assert.deepEqual(parseArguments([
    "--manifest", "/tmp/sdk.json",
    "--receipt", "/tmp/receipt.json",
    "--output", "/tmp/evidence.json",
  ]), {
    manifestPath: "/tmp/sdk.json",
    receiptPath: "/tmp/receipt.json",
    outputPath: "/tmp/evidence.json",
  });
});

test("Photo Web release archive is deterministic USTAR and binds every payload byte", () => {
  const fixture = inputFixture();
  const outputDirectory = path.join(temp("niho-photo-web-release-output-"), "release");
  const result = createPhotoWebRelease({
    inputDirectory: fixture.inputDirectory,
    outputDirectory,
    sourceSha: "c".repeat(40),
    sourceTree: "d".repeat(40),
    toolingCommit: "e".repeat(40),
    runId: "123",
    runAttempt: "1",
    artifact: { id: "456", name: `niho-photo-web-${"c".repeat(40)}-run-123-attempt-1`, digest: `sha256:${"f".repeat(64)}` },
  });
  const archivePath = path.join(outputDirectory, result.archiveFile);
  const archiveBytes = readFileSync(archivePath);
  assert.equal(result.manifest.archive.sha256, sha256(archiveBytes));
  assert.equal(result.manifest.provenance.artifact.id, "456");
  assert.deepEqual(execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" }).trim().split("\n").filter((name) => name && !name.endsWith("/")).sort(),
    result.manifest.files.map(({ path: name }) => name).sort());
  const repeatedOutput = path.join(temp("niho-photo-web-release-repeat-"), "release");
  const repeated = createPhotoWebRelease({
    inputDirectory: fixture.inputDirectory,
    outputDirectory: repeatedOutput,
    sourceSha: "c".repeat(40),
    sourceTree: "d".repeat(40),
    toolingCommit: "e".repeat(40),
    runId: "123",
    runAttempt: "1",
    artifact: { id: "456", name: `niho-photo-web-${"c".repeat(40)}-run-123-attempt-1`, digest: `sha256:${"f".repeat(64)}` },
  });
  assert.equal(repeated.manifestSha256, result.manifestSha256);
  assert.deepEqual(readFileSync(path.join(repeatedOutput, repeated.archiveFile)), archiveBytes);
});

test("Photo Web release builder rejects symlink payloads and artifact identity mismatch", () => {
  const fixture = inputFixture();
  const linked = path.join(fixture.inputDirectory, "static/linked");
  symlinkSync(path.join(fixture.inputDirectory, "static/index.html"), linked);
  const base = {
    inputDirectory: fixture.inputDirectory,
    outputDirectory: path.join(temp("niho-photo-web-rejected-"), "release"),
    sourceSha: "c".repeat(40),
    sourceTree: "d".repeat(40),
    toolingCommit: "e".repeat(40),
    runId: "123",
    runAttempt: "1",
    artifact: { id: "456", name: `niho-photo-web-${"c".repeat(40)}-run-123-attempt-1`, digest: `sha256:${"f".repeat(64)}` },
  };
  assert.throws(() => createPhotoWebRelease(base), /links/u);
  rmSync(linked);
  assert.throws(() => createPhotoWebRelease({ ...base, artifact: { ...base.artifact, name: "other" } }), /artifact identity/u);
  assert.equal(lstatSync(path.dirname(base.outputDirectory)).isDirectory(), true);
});
