import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PHOTO_UPDATER_RELEASE,
  buildUpdaterManifest,
  validateCandidateReleaseMetadata,
  verifyCandidateAttestation,
  candidateReleaseAssetNames,
  sdkProofReleaseMetadata,
} from "./mac-updater-release-lib.mjs";
import { candidateContract } from "../candidate/mac-candidate-lib.mjs";
import { decodeUpdaterSignature, readPinnedUpdaterKey, verifyUpdaterArchiveSignature } from "./updater-signature.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("Tauri .sigのBase64を復号し、曖昧なencodingと不正UTF-8を拒否する", () => {
  const raw = "untrusted comment: fixture\nfixture-signature\ntrusted comment: timestamp:1\tversion:1.2.3\nfixture-global-signature\n";
  const encoded = Buffer.from(raw).toString("base64");
  assert.equal(decodeUpdaterSignature(`${encoded}\n`), raw);
  for (const invalid of ["", raw, `${encoded}%`, Buffer.from([0xff]).toString("base64")]) {
    assert.throws(() => decodeUpdaterSignature(invalid), /canonical Base64/u);
  }
});

test("Rust verifierへMinisignテキストを渡し、配布用の元.sigを保持する", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "photo-signature-test-"));
  const previousPath = process.env.PATH;
  const raw = "untrusted comment: fixture\nfixture-signature\ntrusted comment: timestamp:1\tversion:1.2.3\nfixture-global-signature\n";
  const encoded = Buffer.from(raw).toString("base64");
  const signaturePath = path.join(temporary, "archive.sig");
  const observation = path.join(temporary, "observed.json");
  const cargo = path.join(temporary, "cargo");
  try {
    writeFileSync(signaturePath, encoded);
    writeFileSync(cargo, `#!${process.execPath}\nconst fs = require("node:fs");\nconst signaturePath = process.argv.at(-2);\nconst text = fs.readFileSync(signaturePath, "utf8");\nif (text !== ${JSON.stringify(raw)}) process.exit(1);\nfs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ signaturePath, version: process.argv.at(-1) }));\n`);
    chmodSync(cargo, 0o700);
    process.env.PATH = `${temporary}${path.delimiter}${previousPath ?? ""}`;
    verifyUpdaterArchiveSignature({ root: temporary, publicKeyText: "public fixture", archivePath: path.join(temporary, "archive"), signaturePath, version: "1.2.3" });
    const observed = JSON.parse(readFileSync(observation, "utf8"));
    assert.equal(observed.version, "1.2.3");
    assert.equal(readFileSync(signaturePath, "utf8"), encoded);
    assert.equal(existsSync(observed.signaturePath), false);
    const linkedSignature = path.join(temporary, "linked.sig");
    symlinkSync(signaturePath, linkedSignature);
    assert.throws(() => verifyUpdaterArchiveSignature({ root: temporary, publicKeyText: "public fixture", archivePath: path.join(temporary, "archive"), signaturePath: linkedSignature, version: "1.2.3" }), /signature does not match/u);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("署名準備はpublisherの7 assetsを受入れ、SDK証跡をcandidateに要求しない", () => {
  const manifest = {
    assets: ["photo.dmg", "photo.app.tar.gz", "photo.cdx.json"].map((name) => ({ name })),
    sdk: { manifestFile: "niho-photo-sdk-1.2.3-source.json" },
  };
  const names = candidateReleaseAssetNames("photo.candidate.json", manifest);
  assert.equal(names.length, 7);
  assert.ok(!names.includes("photo-sdk-artifact-receipt.json"));
  assert.ok(!names.includes("photo-sdk-release.json"));
  const workflow = JSON.parse(readFileSync(new URL("../../.github/workflows/photo-candidate-release.yml", import.meta.url), "utf8"));
  const publisher = workflow.jobs.publish.steps.find((step) => step.run?.includes("gh release create"));
  assert.ok(publisher);
  assert.doesNotMatch(publisher.run, /sdk-proof.*(?:photo-sdk-artifact-receipt|photo-sdk-release)\.json/u);
});

test("SDK ReleaseのAPI応答は既存proof形式へ正規化し、由来hashの照合を保つ", () => {
  const sha = "a".repeat(40);
  const tag = "photo-sdk-v1.2.3";
  const release = {
    id: 123, tag_name: tag, target_commitish: sha, draft: false, prerelease: false,
    published_at: "2026-11-09T00:00:00Z",
    assets: [{ name: "sdk.json", size: 32, state: "uploaded" },
      { name: "photo-sdk-artifact-receipt.json", size: 64, state: "uploaded" }],
  };
  const ref = { ref: `refs/tags/${tag}`, object: { type: "commit", sha } };
  const proof = sdkProofReleaseMetadata(release, ref);
  assert.deepEqual(proof, {
    schemaVersion: 1, repository: PHOTO_UPDATER_RELEASE.repository,
    releaseId: 123, tagName: tag, tagSha: sha, targetCommitish: sha,
    draft: false, prerelease: false, publishedAt: release.published_at,
    assets: [{ name: "photo-sdk-artifact-receipt.json", bytes: 64 }, { name: "sdk.json", bytes: 32 }],
  });
  assert.throws(() => sdkProofReleaseMetadata(release, { ...ref, object: { type: "commit", sha: "b".repeat(40) } }), /metadata/u);
  assert.throws(() => sdkProofReleaseMetadata({ ...release, draft: true }, ref), /metadata/u);
  assert.throws(() => sdkProofReleaseMetadata({ ...release, assets: [...release.assets, release.assets[0]] }, ref), /metadata/u);
  assert.throws(() => sdkProofReleaseMetadata({ ...release, assets: [{ name: "../receipt", size: 64, state: "uploaded" }] }, ref), /metadata/u);
  const previewTag = "photo-sdk-v1.2.3-rc.1+build.7";
  assert.equal(sdkProofReleaseMetadata({ ...release, tag_name: previewTag }, { ...ref, ref: `refs/tags/${previewTag}` }).tagName, previewTag);
  assert.throws(() => sdkProofReleaseMetadata({ ...release, tag_name: "photo-sdk-v1.2.3-rc.01" }, ref), /metadata/u);
});

function attestationFixture() {
  const workflow = PHOTO_UPDATER_RELEASE.candidateWorkflow;
  const sourceSha = "b".repeat(40);
  const manifestBytes = Buffer.from("candidate manifest fixture\n");
  const candidate = {
    manifestFile: "niho-photo-1.2.3-candidate.candidate.json",
    manifest: { run: { id: "123456", attempt: "2" } },
  };
  const identity = `${PHOTO_UPDATER_RELEASE.repositoryUrl}/${workflow}@${PHOTO_UPDATER_RELEASE.branchRef}`;
  const invocation = `${PHOTO_UPDATER_RELEASE.repositoryUrl}/actions/runs/123456/attempts/2`;
  return {
    manifestBytes,
    candidate,
    provenance: { toolingSourceSha: sourceSha },
    output: [{
      verificationResult: {
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          subject: [{ name: candidate.manifestFile, digest: { sha256: sha256(manifestBytes) } }],
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: {
            buildDefinition: {
              externalParameters: { workflow: { repository: PHOTO_UPDATER_RELEASE.repositoryUrl, path: workflow, ref: PHOTO_UPDATER_RELEASE.branchRef } },
              internalParameters: { github: { event_name: "workflow_dispatch", repository_id: "1426802549", repository_owner_id: "345807639" } },
              resolvedDependencies: [{ uri: `git+${PHOTO_UPDATER_RELEASE.repositoryUrl}@${PHOTO_UPDATER_RELEASE.branchRef}`, digest: { gitCommit: sourceSha } }],
            },
            runDetails: { builder: { id: identity }, metadata: { invocationId: invocation } },
          },
        },
        signature: { certificate: {
          subjectAlternativeName: identity,
          githubWorkflowRepository: PHOTO_UPDATER_RELEASE.repository,
          githubWorkflowRef: PHOTO_UPDATER_RELEASE.branchRef,
          githubWorkflowSHA: sourceSha,
          sourceRepositoryURI: PHOTO_UPDATER_RELEASE.repositoryUrl,
          sourceRepositoryRef: PHOTO_UPDATER_RELEASE.branchRef,
          sourceRepositoryDigest: sourceSha,
          sourceRepositoryVisibilityAtSigning: "public",
          buildConfigURI: identity,
          buildConfigDigest: sourceSha,
          buildSignerURI: identity,
          buildSignerDigest: sourceSha,
          buildTrigger: "workflow_dispatch",
          runInvocationURI: invocation,
        } },
        verifiedTimestamps: [{ type: "Tlog", uri: "https://rekor.sigstore.dev", timestamp: "2026-11-08T00:00:00Z" }],
      },
    }],
  };
}

test("candidate attestationは公式Photo main workflow・source・runを固定する", () => {
  const fixture = attestationFixture();
  assert.deepEqual(verifyCandidateAttestation(fixture.output, fixture), {
    toolingSourceSha: "b".repeat(40),
    runId: "123456",
    runAttempt: "2",
  });

  const altered = structuredClone(fixture.output);
  altered[0].verificationResult.signature.certificate.githubWorkflowSHA = "c".repeat(40);
  assert.throws(() => verifyCandidateAttestation(altered, fixture), /公式main workflow/u);
});

test("static updater manifestはversion署名をPhoto app releaseへ結び付ける", () => {
  const signature = Buffer.from("untrusted comment: signature from tauri secret key\nRWExampleSignature==\ntrusted comment: timestamp:123\nRWTrustedCommentSignature==\n").toString("base64");
  const manifest = buildUpdaterManifest({ version: "1.2.3", signature, archiveName: "niho-photo-1.2.3.app.tar.gz" });
  assert.deepEqual(manifest, {
    version: "1.2.3",
    notes: "NIHO photo 1.2.3 を公開しました。",
    platforms: {
      "darwin-aarch64": {
        signature,
        url: "https://github.com/niho-life/niho-photo/releases/download/photo-app-v1.2.3/niho-photo-1.2.3.app.tar.gz",
      },
    },
  });
  assert.throws(() => buildUpdaterManifest({ version: "1.2.3-beta.1", signature, archiveName: "niho-photo-1.2.3.app.tar.gz" }), /入力が不正/u);
  assert.throws(() => buildUpdaterManifest({ version: "1.2.3", signature: "unsigned", archiveName: "niho-photo-1.2.3.app.tar.gz" }), /入力が不正/u);
});

test("配布appは公式Release feed・固定鍵・version署名必須を持つ", () => {
  const config = JSON.parse(readFileSync(new URL("../../apps/camera/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const updater = config.plugins.updater;
  const pinned = readPinnedUpdaterKey(fileURLToPath(new URL("../..", import.meta.url)));
  assert.deepEqual(updater.endpoints, [PHOTO_UPDATER_RELEASE.feedUrl]);
  assert.equal(candidateContract.updaterFeed, PHOTO_UPDATER_RELEASE.feedUrl);
  assert.equal(sha256(Buffer.from(updater.pubkey)), candidateContract.updaterPublicKeySha256);
  assert.equal(pinned.sha256, candidateContract.updaterPublicKeySha256);
  assert.equal(Buffer.from(updater.pubkey, "base64").toString("utf8"), pinned.publicKeyText);
  assert.equal(updater.requireSignedVersion, true);
  assert.equal(candidateContract.updaterRequiresSignedVersion, updater.requireSignedVersion);
});

test("candidateをdownloadする前にRelease asset名とsizeを検証する", () => {
  const tag = "photo-candidate-v1.2.3-abcdef012345";
  const release = {
    tag_name: tag,
    draft: false,
    prerelease: true,
    assets: [
      { name: "photo-app.candidate.json", state: "uploaded", size: 512 },
      { name: "photo-app.tar.gz", state: "uploaded", size: 1024 },
    ],
  };
  assert.deepEqual(validateCandidateReleaseMetadata(release, tag), ["photo-app.candidate.json", "photo-app.tar.gz"]);
  assert.throws(() => validateCandidateReleaseMetadata({ ...release, assets: [{ ...release.assets[0], name: "../payload" }] }, tag), /asset一覧/u);
  assert.throws(() => validateCandidateReleaseMetadata({ ...release, assets: [{ ...release.assets[0], size: 250 * 1024 * 1024 + 1 }] }, tag), /asset一覧/u);
  assert.throws(() => validateCandidateReleaseMetadata({ ...release, draft: true }, tag), /未公開/u);
});
