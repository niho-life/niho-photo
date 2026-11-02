import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPublicSdkDependencies,
  approvedSdkPackageDependency,
  approvedSdkLockDependency,
  approvedSdkConsumerLockDependency,
} from "./publication-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const policy = JSON.parse(await readFile(path.join(root, "docs/security/publication-policy.json"), "utf8"));
const proofPath = "packages/photo-cloud-media/sdk-baseline.json";
const receiptPath = "docs/security/public-sdk-dependency-receipt.json";

test("SDK依存の無いpolicyは追加ファイルやnetworkを要求しない", async () => {
  assert.deepEqual(await readPublicSdkDependencies("/missing-unused-proof", {}), []);
  assert.deepEqual(await readPublicSdkDependencies("/missing-unused-proof", { publicSdkDependencies: [] }), []);
  await assert.rejects(readPublicSdkDependencies(root, { publicSdkDependencies: null }));
});

test("監査したconsumerと公式SDKのexact artifactだけを許可する", async () => {
  const entries = await readPublicSdkDependencies(root, policy);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(approvedSdkPackageDependency(entries, entry.consumer, entry.name, entry.url), true);
    assert.equal(approvedSdkLockDependency(entries, `node_modules/${entry.name}`, {
      version: entry.version, resolved: entry.url, integrity: entry.integrity,
    }), true);
    assert.equal(approvedSdkLockDependency(entries, `node_modules/${entry.name}`, {
      name: entry.name, version: entry.version, resolved: entry.url, integrity: entry.integrity,
    }), true);
    assert.equal(approvedSdkConsumerLockDependency(entry, "packages/photo-cloud-media", {
      dependencies: { [entry.name]: entry.url },
    }), true);
    assert.equal(approvedSdkConsumerLockDependency(entry, "packages/other", {
      dependencies: { [entry.name]: entry.url },
    }), false);
    for (const dependency of [{}, { dependencies: {} }, { dependencies: { [entry.name]: "changed" } }]) {
      assert.equal(approvedSdkConsumerLockDependency(entry, "packages/photo-cloud-media", dependency), false);
    }
    assert.equal(approvedSdkPackageDependency(entries, "packages/other/package.json", entry.name, entry.url), false);
    assert.equal(approvedSdkPackageDependency(entries, entry.consumer, entry.name, `${entry.url}?token=synthetic`), false);
    assert.equal(approvedSdkPackageDependency(entries, entry.consumer, "different-name", entry.url), false);
    assert.equal(approvedSdkLockDependency(entries, "node_modules/other", {
      version: entry.version, resolved: entry.url, integrity: entry.integrity,
    }), false);
    for (const mutation of [
      { name: "different-sdk-name" }, { name: null }, { name: 123 },
      { version: "999.0.0" }, { resolved: `${entry.url}?changed=true` },
      { integrity: "sha512-synthetic" }, { integrity: undefined }, { link: true },
    ]) {
      assert.equal(approvedSdkLockDependency(entries, `node_modules/${entry.name}`, {
        version: entry.version, resolved: entry.url, integrity: entry.integrity, ...mutation,
      }), false);
    }
  }
});

for (const [label, change] of [
  ["別repo", { url: "https://github.com/other/project/releases/download/v1/package.tgz" }],
  ["同repoの別path", { url: "https://github.com/niho-life/niho-photo/archive/main.tar.gz" }],
  ["可変版", { version: "latest" }],
  ["別source SHA", { sourceCommit: "a".repeat(40) }],
  ["別artifact hash", { sha256: "a".repeat(64) }],
  ["別artifact size", { sizeBytes: 1 }],
  ["別proof hash", { proofSha256: "a".repeat(64) }],
  ["別proof path", { proofPath: "../outside.json" }],
  ["別consumer", { consumer: "packages/other/package.json" }],
  ["未固定integrity", { integrity: "sha512-short" }],
  ["receiptと異なる有効長integrity", { integrity: `sha512-${"A".repeat(86)}==` }],
  ["未知field", { arbitraryOverride: true }],
]) {
  test(`SDK許可記録の${label}を拒否する`, async () => {
    const copy = structuredClone(policy);
    Object.assign(copy.publicSdkDependencies[0], change);
    await assert.rejects(readPublicSdkDependencies(root, copy));
  });
}

test("proof本文の差替え・欠落と許可記録重複を拒否する", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "photo-sdk-proof-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await assert.rejects(readPublicSdkDependencies(temporary, policy));
  await mkdir(path.dirname(path.join(temporary, proofPath)), { recursive: true });
  await mkdir(path.dirname(path.join(temporary, receiptPath)), { recursive: true });
  await writeFile(path.join(temporary, receiptPath), await readFile(path.join(root, receiptPath)));
  await writeFile(path.join(temporary, proofPath), await readFile(path.join(root, proofPath)));
  assert.equal((await readPublicSdkDependencies(temporary, policy)).length, 2);
  const proof = JSON.parse(await readFile(path.join(root, proofPath), "utf8"));
  proof.sourceCommit = "a".repeat(40);
  await writeFile(path.join(temporary, proofPath), `${JSON.stringify(proof)}\n`);
  await assert.rejects(readPublicSdkDependencies(temporary, policy));
  const duplicate = structuredClone(policy);
  duplicate.publicSdkDependencies[1] = duplicate.publicSdkDependencies[0];
  await assert.rejects(readPublicSdkDependencies(root, duplicate));
});

test("取得receiptのhash・参照先・本文の差替えを拒否する", async () => {
  for (const mutation of [{ sha256: "a".repeat(64) }, { path: "../other-receipt.json" }]) {
    const copy = structuredClone(policy);
    Object.assign(copy.publicSdkDependencyReceipt, mutation);
    await assert.rejects(readPublicSdkDependencies(root, copy));
  }
  const copy = structuredClone(policy);
  delete copy.publicSdkDependencyReceipt;
  await assert.rejects(readPublicSdkDependencies(root, copy));
});

test("C04の有効なSDK policyは必ず両artifactを固定する", async () => {
  const partial = structuredClone(policy);
  partial.publicSdkDependencies.pop();
  await assert.rejects(readPublicSdkDependencies(root, partial));
});
