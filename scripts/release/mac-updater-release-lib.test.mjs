import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PHOTO_UPDATER_RELEASE,
  buildUpdaterManifest,
  validateCandidateReleaseMetadata,
  verifyCandidateAttestation,
} from "./mac-updater-release-lib.mjs";
import { candidateContract } from "../candidate/mac-candidate-lib.mjs";
import { readPinnedUpdaterKey } from "./updater-signature.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
  assert.equal(sha256(Buffer.from(updater.pubkey)), candidateContract.updaterPublicKeySha256);
  assert.equal(pinned.sha256, candidateContract.updaterPublicKeySha256);
  assert.equal(Buffer.from(updater.pubkey, "base64").toString("utf8"), pinned.publicKeyText);
  assert.equal(updater.requireSignedVersion, true);
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
