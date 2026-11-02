import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { digest, verifyPublication, parseInventory } from "./publication-lib.mjs";
const realRoot = fileURLToPath(new URL("../../", import.meta.url));
const baseline = "a".repeat(40), candidate = "b".repeat(40);
const header = "source_commit,source_path,sha256,size_bytes,category,origin,license_evidence,redistribution,decision\n";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "photo-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, bytes) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), bytes); };
  const json = async (name, value) => put(name, `${JSON.stringify(value, null, 2)}\n`);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const policy = JSON.parse(await readFile(path.join(realRoot, "docs/security/publication-policy.json"), "utf8"));
  delete policy.publicSdkDependencies; // SDKを使わない基準fixture。SDK例外は専用の拒否試験で検証する。
  await json("docs/security/publication-policy.json", policy);
  await put("docs/legal/asset-inventory.csv", header);
  const source = "export const exposure = 0;\n";
  await put("packages/example/src/exposure.ts", source);
  const manifest = { schemaVersion: 1, issue: 11, sourceBaseline: { repository: "niho-app", commit: baseline }, auditedCandidate: { repository: "niho-clients", commit: candidate }, importedFiles: [{ path: "packages/example/src/exposure.ts", source: { repository: "niho-app", commit: baseline, path: "packages/example/src/exposure.ts", sha256: digest(source) }, outputSha256: digest(source), modifications: [] }], generatedFiles: [], excludedSources: [], deferredScopes: [] };
  const save = () => json("docs/security/publication-manifest.json", manifest);
  await save();
  return { root, put, json, manifest, save, check: async () => (await verifyPublication(root)).failures };
}

const rejected = async (f, pattern) => assert.ok((await f.check()).some((failure) => pattern.test(failure)), `拒否されませんでした: ${pattern}`);

test("監査済みソースは許可し、manifest hash更新だけでは出典を偽装できない", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.check(), []);
  await f.put("packages/example/src/exposure.ts", "export const exposure = 1;\n");
  await rejected(f, /ハッシュ不一致/);
  f.manifest.importedFiles[0].outputSha256 = digest("export const exposure = 1;\n");
  await f.save();
  await rejected(f, /変更理由不正/);
  f.manifest.importedFiles[0].modifications = ["露光の合成テストの期待値を更新。"];
  await f.save();
  assert.deepEqual(await f.check(), []);
  f.manifest.importedFiles[0].source.commit = candidate;
  await f.save();
  await rejected(f, /出典不正/);
});

test("Docsの外部固定SHAだけを共通contractの許可出典として認める", async (t) => {
  const f = await fixture(t);
  const sourceCommit = "c".repeat(40);
  const repository = "niho-coliving/niho-docs";
  const sourcePath = "packages/niho-cloud-contract/src/v1.ts";
  const source = "export const contract = 1;\n";
  await f.put(sourcePath, source);
  f.manifest.externalSources = [{ repository, commit: sourceCommit }];
  f.manifest.importedFiles.push({
    path: sourcePath,
    source: { repository, commit: sourceCommit, path: sourcePath, sha256: digest(source) },
    outputSha256: digest(source),
    modifications: [],
  });
  await f.json("docs/security/cloud-contract-source.json", {
    schemaVersion: 1,
    repository,
    commit: sourceCommit,
    files: [{ source: sourcePath, target: sourcePath }],
  });
  await f.save();
  assert.deepEqual(await f.check(), []);
  f.manifest.externalSources.push({ repository: "attacker/repo", commit: sourceCommit });
  await f.save();
  await rejected(f, /外部出典契約不正/);
  f.manifest.externalSources.pop();
  const extraPath = "packages/niho-cloud-contract/src/unlisted.ts";
  await f.put(extraPath, "export const unlisted = true;\n");
  f.manifest.importedFiles.push({
    path: extraPath,
    source: { repository, commit: sourceCommit, path: extraPath, sha256: digest("export const unlisted = true;\n") },
    outputSha256: digest("export const unlisted = true;\n"),
    modifications: [],
  });
  await f.save();
  await rejected(f, /外部出典契約不正/);
  f.manifest.importedFiles.pop();
  f.manifest.importedFiles[1].source.commit = "d".repeat(40);
  await f.save();
  await rejected(f, /外部出典契約不正/);
});

test("packages外の禁止パス、秘密ファイル、巨大fixtureも拒否する", async (t) => {
  const f = await fixture(t);
  for (const name of ["apps/api/index.ts", "docs/.env.production", "misc/ID_RSA", "misc/key.PEM", ".gitmodules", ".npmrc", ".gitleaksignore", "sample.ICC"]) await f.put(name, "synthetic forbidden input\n");
  await f.put("docs/oversize.txt", Buffer.alloc(52428801, 65));
  const failures = await f.check();
  assert.equal(failures.filter((v) => v.startsWith("公開禁止パス")).length, 8);
  assert.ok(failures.some((v) => /サイズ超過/.test(v)));
  const policy = JSON.parse(await readFile(path.join(f.root, "docs/security/publication-policy.json")));
  policy.forbiddenBasenames = [];
  policy.forbiddenPathPrefixes = [];
  policy.forbiddenExtensions = [];
  await f.json("docs/security/publication-policy.json", policy);
  assert.equal((await f.check()).filter((v) => v.startsWith("公開禁止パス")).length, 8);
});

test("symlinkとsubmoduleとmanifest未登録ソースを拒否する", async (t) => {
  const f = await fixture(t);
  await symlink("docs/security/publication-policy.json", path.join(f.root, "linked"));
  await f.put("packages/extra/new.ts", "export {};\n");
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${candidate},vendor/module`], { cwd: f.root });
  const failures = await f.check();
  assert.ok(failures.some((v) => /通常ファイル以外/.test(v)));
  assert.ok(failures.some((v) => /symlink\/submodule/.test(v)));
  assert.ok(failures.some((v) => /未登録ソース/.test(v)));
});

test("未承認binaryとテキスト画像も拒否し、公開可能台帳のexact bytesだけ許可する", async (t) => {
  const f = await fixture(t);
  const name = "packages/example/assets/icon.bin";
  const bytes = Buffer.from([137, 80, 78, 71, 0, 13, 10]);
  await f.put(name, bytes);
  await rejected(f, /公開許可未確認/);
  f.manifest.importedFiles.push({ path: name, source: { repository: "niho-app", commit: baseline, path: name, sha256: digest(bytes) }, outputSha256: digest(bytes), modifications: [] });
  await f.save();
  await f.put("docs/legal/asset-inventory.csv", `${header}${candidate},${name},${digest(bytes)},${bytes.length},icon,独立作成した合成のアイコン,オーナーの公開許可を確認済み,独立再配布禁止,公開可能\n`);
  assert.deepEqual(await f.check(), []);
  const changed = Buffer.from([137, 80, 78, 71, 0, 14, 10]);
  await f.put(name, changed);
  f.manifest.importedFiles[1].outputSha256 = digest(changed);
  f.manifest.importedFiles[1].modifications = ["未監査バイトへの差し替えを試す。"];
  await f.save();
  await rejected(f, /公開許可未確認/);
  await f.put("docs/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  await rejected(f, /未登録資産/);
});

test("所有者作成の合成binary fixtureは由来とexact bytesの記録で公開できる", async (t) => {
  const f = await fixture(t);
  const name = "packages/example/fixtures/synthetic.bin";
  const bytes = Buffer.from([0x49, 0x49, 0x55, 0x00, 0, 0, 0, 0]);
  await f.put(name, bytes);
  f.manifest.generatedFiles.push({ path: name, sha256: digest(bytes), origin: "実写真と独立した手作りRW2ヘッダー。個人情報と埋込thumbnailは含まない。" });
  await f.save();
  await rejected(f, /公開許可未確認/);
  await f.put("docs/legal/asset-inventory.csv", `${header}${candidate},${name},${digest(bytes)},${bytes.length},fixture,オーナーが独立作成した合成RAW,由来と不要metadataの不在を確認,独立再配布禁止,公開可能\n`);
  assert.deepEqual(await f.check(), []);
});

test("要置換fixtureの元バイト列はrenameでも拒否し、独立合成JSONへ置換できる", async (t) => {
  const f = await fixture(t);
  const original = '{"sample":"unreviewed"}\n';
  const name = "packages/example/fixtures/sample.json";
  await f.put("docs/legal/asset-inventory.csv", `${header}${candidate},private/original.json,${digest(original)},${Buffer.byteLength(original)},fixture,生成元未確認の既存入力,公開許可未確認の入力,不可,要置換\n`);
  await f.put(name, original);
  f.manifest.generatedFiles.push({ path: name, sha256: digest(original), origin: "独立生成と申告したが既存バイトを流用。" });
  await f.save();
  await rejected(f, /非公開\/要置換/);
  const synthetic = '{"sample":[0,1,2]}\n';
  await f.put(name, synthetic);
  f.manifest.generatedFiles[0].sha256 = digest(synthetic);
  f.manifest.generatedFiles[0].origin = "0から2までの整数を手書きした独立合成fixture。";
  await f.save();
  assert.deepEqual(await f.check(), []);
});

test("private URL/package参照の値をエラーへ出力しない", async (t) => {
  const f = await fixture(t);
  const privateUrl = "https://" + "10.1.2.3" + "/sensitive-marker";
  await f.put("docs/example.md", `${privateUrl}\n`);
  await f.json("package.json", { dependencies: { "private-package": "git+" + privateUrl } });
  const failures = await f.check();
  assert.ok(failures.some((v) => /非公開参照/.test(v)));
  assert.ok(failures.some((v) => /package参照/.test(v)));
  assert.ok(failures.every((v) => !v.includes("sensitive-marker") && !v.includes("10.1.2.3")));
});

test("manifest重複、欠落、path traversal、policyサイズ緩和を拒否する", async (t) => {
  const f = await fixture(t);
  f.manifest.importedFiles.push(f.manifest.importedFiles[0]);
  f.manifest.generatedFiles.push({ path: "../outside", sha256: "a".repeat(64), origin: "不正な外部パスへのアクセスを試す。" });
  await f.save();
  await rejected(f, /重複/);
  await rejected(f, /パス不正/);
  await rm(path.join(f.root, "packages/example/src/exposure.ts"));
  await rejected(f, /ファイル欠落/);
  const policy = JSON.parse(await readFile(path.join(f.root, "docs/security/publication-policy.json")));
  policy.maxFileBytes = 52428801;
  await f.json("docs/security/publication-policy.json", policy);
  await assert.rejects(f.check, /policy/);
});

test("CSV内の引用カンマを解釈し、不正な列数と引用符は拒否する", () => {
  const row = `${header}${candidate},source,${"c".repeat(64)},1,fixture,"合成,入力",許可あり,不可,公開可能\n`;
  assert.equal(parseInventory(row)[0].origin, "合成,入力");
  assert.throws(() => parseInventory(`${header}wrong,columns\n`));
  assert.throws(() => parseInventory(`${header}"unterminated\n`));
});

test("理由付きmanifest更新は出典とschemaを保持し、未登録ファイルを追加しない", async (t) => {
  const f = await fixture(t);
  for (const script of ["scripts/update-publication-manifest.mjs", "scripts/ci/publication-lib.mjs", "scripts/ci/workflow-lib.mjs", "scripts/ci/photo-sdk-workflow-lib.mjs", "scripts/ci/photo-candidate-workflow-lib.mjs", "scripts/ci/image-metadata.mjs"]) await f.put(script, await readFile(path.join(realRoot, script)));
  const before = structuredClone(f.manifest);
  const changed = "export const exposure = 2;\n";
  await f.put(before.importedFiles[0].path, changed);
  const script = path.join(f.root, "scripts/update-publication-manifest.mjs");
  execFileSync(process.execPath, [script, "--path", before.importedFiles[0].path, "--reason", "独立合成の露光入力に合わせて既定値を変更。"], { stdio: "pipe" });
  const updated = JSON.parse(await readFile(path.join(f.root, "docs/security/publication-manifest.json")));
  assert.deepEqual(updated.sourceBaseline, before.sourceBaseline);
  assert.deepEqual(updated.importedFiles[0].source, before.importedFiles[0].source);
  assert.equal(updated.schemaVersion, 1);
  assert.equal(updated.importedFiles[0].outputSha256, digest(changed));
  assert.equal(updated.importedFiles[0].modifications.length, 1);
  assert.deepEqual(await f.check(), []);
  const manifestBytes = await readFile(path.join(f.root, "docs/security/publication-manifest.json"));
  assert.throws(() => execFileSync(process.execPath, [script, "--path", "unregistered.ts", "--reason", "未登録ファイルの自動追加を試す。"], { stdio: "pipe" }));
  assert.deepEqual(await readFile(path.join(f.root, "docs/security/publication-manifest.json")), manifestBytes);
});

test("50MiBの境界は許可し、それを超えるサイズpolicyは拒否する", async (t) => {
  const f = await fixture(t);
  await f.put("docs/exact-limit.txt", Buffer.alloc(50 * 1024 * 1024, 65));
  assert.deepEqual(await f.check(), []);
  await f.put("docs/exact-limit.txt", Buffer.alloc(50 * 1024 * 1024 + 1, 65));
  await rejected(f, /サイズ超過/);
});

test("private絶対pathとprivate-key headerを値を表示せず拒否する", async (t) => {
  const f = await fixture(t);
  const privatePath = "/" + "Users/" + "example-person/hidden-photo";
  await f.put("docs/private-reference.md", privatePath + "\n");
  await f.put("docs/key-example.txt", "-----BEGIN " + "PRIVATE KEY-----\n");
  const failures = await f.check();
  assert.equal(failures.filter((v) => /非公開参照/.test(v)).length, 2);
  assert.ok(failures.every((v) => !v.includes("example-person") && !v.includes("hidden-photo")));
});

test("JSONでescapeされたWindows pathとLinux root pathを値を表示せず拒否する", async (t) => {
  const f = await fixture(t);
  const slash = String.fromCharCode(92);
  const marker = "private-marker";
  const windowsPath = "c:" + slash + slash + "Users" + slash + slash + marker + slash + slash + "photo.jpg";
  const rootPath = "/" + "root/" + marker + "/photo.jpg";
  await f.put("docs/windows-reference.md", JSON.stringify({ path: windowsPath }));
  await f.put("docs/linux-reference.md", JSON.stringify({ path: rootPath }));
  const failures = await f.check();
  assert.equal(failures.filter((v) => /非公開参照/.test(v)).length, 2);
  assert.ok(failures.every((v) => !v.includes(marker)));
});

test("登録したDCPでも独立測定・検証証拠が無ければ拒否する", async (t) => {
  const f = await fixture(t);
  const name = "packages/example/profiles/independent.dcp";
  const bytes = Buffer.from([73, 73, 82, 67, 0, 0, 0, 0]);
  await f.put(name, bytes);
  f.manifest.generatedFiles.push({ path: name, sha256: digest(bytes), origin: "独立測定と申告しただけの不十分なDCP。" });
  await f.save();
  await f.put("docs/legal/asset-inventory.csv", `${header}${candidate},${name},${digest(bytes)},${bytes.length},fixture,独立測定と申告した合成入力,生成証拠が不足した入力,独立再配布禁止,公開可能\n`);
  await rejected(f, /独立DCPの生成証拠/);
});

test("画像containerのICC/EXIFと不正なRW2は台帳登録だけでは許可しない", async (t) => {
  const f = await fixture(t);
  const inputs = [
    ["packages/example/fixtures/image.png", Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from([0,0,0,0]), Buffer.from("iCCP"), Buffer.alloc(4)])],
    ["packages/example/fixtures/raw.rw2", Buffer.from([73,73,85,0,0,0,0,0])],
  ];
  for (const [name, bytes] of inputs) {
    await f.put(name, bytes);
    f.manifest.generatedFiles.push({ path: name, sha256: digest(bytes), origin: "禁止metadataの拒否を確認する合成container。" });
  }
  await f.save();
  await rejected(f, /PNGに不要metadata/);
  await rejected(f, /RW2ヘッダー不正/);
});

test("正規化した資産は元source SHAと監査済みoutput SHAを両方照合する", async (t) => {
  const f = await fixture(t);
  const name = "packages/example/assets/normalized.bin";
  const original = Buffer.from([0,1,2,3]), output = Buffer.from([0,1,2]);
  await f.put(name, output);
  f.manifest.importedFiles.push({ path:name, source:{ repository:"niho-app", commit:baseline, path:name, sha256:digest(original) }, outputSha256:digest(output), modifications:["合成metadataの末尾1 byteを除去し監査済み出力を記録。"] });
  await f.save();
  const auditedHeader = header.trim() + ",source_sha256\n";
  const row = (sourceHash) => `${auditedHeader}${baseline},${name},${digest(output)},${output.length},fixture,独立した合成metadataの正規化,入力と出力のhashを個別に監査,独立再配布禁止,公開可能,${sourceHash}\n`;
  await f.put("docs/legal/asset-inventory.csv", row(digest(original)));
  assert.deepEqual(await f.check(), []);
  await f.put("docs/legal/asset-inventory.csv", row("0".repeat(64)));
  await rejected(f, /公開許可未確認/);
});

test("runtime tokenの置き場はGitignoreを無視してもfixtureを含む全公開候補で拒否する", async (t) => {
  const f = await fixture(t);
  for (const name of ["misc/refresh-token.json", "fixtures/access_token.json", "misc/id-token.txt", "misc/account-secrets/pending.json", "misc/oauth-tokens/export", "misc/Account-Session.JSON", "misc/tokens", "misc/runtime-tokens/copy.bin", "misc/pending", "fixtures/pending.json", "misc/public-account-v2/account-secrets/refresh-token"]) {
    await f.put(name, "synthetic-runtime-copy\n");
    await rejected(f, /公開禁止パス/);
    await rm(path.join(f.root, name));
  }
});

test("公式SDKのexact consumer/proof/lockを統合検査し、consumer・lock・proofの差替えを拒否する", async (t) => {
  const f = await fixture(t);
  const policy = JSON.parse(await readFile(path.join(realRoot, "docs/security/publication-policy.json"), "utf8"));
  await f.json("docs/security/publication-policy.json", policy);
  const consumer = "packages/photo-cloud-media/package.json";
  const proofPath = "packages/photo-cloud-media/sdk-baseline.json";
  const proof = await readFile(path.join(realRoot, proofPath));
  const receiptPath = policy.publicSdkDependencyReceipt.path;
  const receipt = await readFile(path.join(realRoot, receiptPath));
  const pkg = { name: "@niho/photo-cloud-media", private: true,
    dependencies: Object.fromEntries(policy.publicSdkDependencies.map((entry) => [entry.name, entry.url])) };
  const pkgBytes = `${JSON.stringify(pkg, null, 2)}\n`;
  await f.put(consumer, pkgBytes);
  await f.put(proofPath, proof);
  await f.put(receiptPath, receipt);
  f.manifest.generatedFiles.push(
    { path: consumer, sha256: digest(pkgBytes), origin: "公式SDK依存の合成consumer検証" },
    { path: proofPath, sha256: digest(proof), origin: "公開済み公式SDKの固定baseline proof" },
    { path: receiptPath, sha256: digest(receipt), origin: "公式取得物の両digestを固定したreceipt" },
  );
  await f.save();
  const lock = { lockfileVersion: 3, packages: Object.fromEntries(policy.publicSdkDependencies.map((entry) =>
    [`node_modules/${entry.name}`, { version: entry.version, resolved: entry.url, integrity: entry.integrity }])) };
  lock.packages["packages/photo-cloud-media"] = { dependencies: { ...pkg.dependencies } };
  await f.json("package-lock.json", lock);
  assert.deepEqual(await f.check(), []);
  const workspaceLock = lock.packages["packages/photo-cloud-media"];
  for (const dependencies of [{}, { ...pkg.dependencies, [policy.publicSdkDependencies[0].name]: "changed" }]) {
    workspaceLock.dependencies = dependencies;
    await f.json("package-lock.json", lock);
    await rejected(f, /固定公式SDKのconsumer lock依存欠落/);
  }
  workspaceLock.dependencies = { ...pkg.dependencies };
  await f.json("package-lock.json", lock);
  const firstLockPath = Object.keys(lock.packages)[0];
  const firstLock = lock.packages[firstLockPath];
  delete lock.packages[firstLockPath];
  await f.json("package-lock.json", lock);
  await rejected(f, /公式SDKのlock依存欠落/);
  lock.packages[firstLockPath] = firstLock;
  await f.json("package-lock.json", lock);
  const oneDependency = structuredClone(pkg);
  delete oneDependency.dependencies[policy.publicSdkDependencies[0].name];
  const reduced = `${JSON.stringify(oneDependency, null, 2)}\n`;
  await f.put(consumer, reduced);
  f.manifest.generatedFiles.find((entry) => entry.path === consumer).sha256 = digest(reduced);
  await f.save();
  await rejected(f, /公式SDKに対応するconsumer依存欠落/);
  await f.put(consumer, pkgBytes);
  f.manifest.generatedFiles.find((entry) => entry.path === consumer).sha256 = digest(pkgBytes);
  await f.save();
  const noSdk = `${JSON.stringify({ ...pkg, dependencies: {} }, null, 2)}\n`;
  await f.put(consumer, noSdk);
  f.manifest.generatedFiles.find((entry) => entry.path === consumer).sha256 = digest(noSdk);
  await f.save();
  await f.json("package-lock.json", { lockfileVersion: 3, packages: {} });
  await rejected(f, /固定公式SDKのconsumer依存欠落/);
  await rejected(f, /固定公式SDKのlock依存欠落/);
  await f.put(consumer, pkgBytes);
  f.manifest.generatedFiles.find((entry) => entry.path === consumer).sha256 = digest(pkgBytes);
  await f.save();
  await f.json("package-lock.json", lock);
  const first = Object.values(lock.packages)[0];
  const originalIntegrity = first.integrity;
  first.integrity = "sha512-modified";
  await f.json("package-lock.json", lock);
  await rejected(f, /公開registry以外のlock依存/);
  first.integrity = originalIntegrity;
  await f.json("package-lock.json", lock);
  const other = "packages/other/package.json";
  await f.put(other, pkgBytes);
  f.manifest.generatedFiles.push({ path: other, sha256: digest(pkgBytes), origin: "別consumerの拒否境界を確認" });
  await f.save();
  await rejected(f, /非公開\/非registry package参照.*packages\/other/);
  await rm(path.join(f.root, other));
  f.manifest.generatedFiles.pop();
  const changedProof = `${proof.toString("utf8")}\n`;
  await f.put(proofPath, changedProof);
  f.manifest.generatedFiles.find((entry) => entry.path === proofPath).sha256 = digest(changedProof);
  await f.save();
  await rejected(f, /公式SDK依存の公開proof不正/);
});
