import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const realRoot = fileURLToPath(new URL("../../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("公開guardはmanifest外も含めてrepository全体の禁止pathを検査する", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-publication-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, bytes) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), bytes);
  };
  const sourcePath = "packages/example/src/index.ts";
  const source = "export const safe = true;\n";
  const hash = digest(source);
  const commit = "a".repeat(40);
  await put("scripts/verify-publication.mjs", await readFile(path.join(realRoot, "scripts/verify-publication.mjs")));
  for (const name of ["scripts/ci/publication-lib.mjs", "scripts/ci/workflow-lib.mjs", "scripts/ci/photo-sdk-workflow-lib.mjs", "scripts/sdk/native-workflow-lib.mjs", "scripts/ci/photo-candidate-workflow-lib.mjs", "scripts/ci/image-metadata.mjs"]) {
    try { await put(name, await readFile(path.join(realRoot, name))); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const policy = JSON.parse(await readFile(path.join(realRoot, "docs/security/publication-policy.json"), "utf8"));
  delete policy.publicSdkDependencies; // SDKを使わない基準fixture。
  await put("docs/security/publication-policy.json", `${JSON.stringify(policy)}\n`);
  await put("docs/security/publication-manifest.json", `${JSON.stringify({
    schemaVersion: 1,
    issue: 1,
    sourceBaseline: { repository: "niho-app", commit },
    auditedCandidate: { repository: "niho-photo", commit: "b".repeat(40) },
    importedFiles: [{ path: sourcePath, source: { repository: "niho-app", commit, path: sourcePath, sha256: hash }, outputSha256: hash, modifications: [] }],
    generatedFiles: [], excludedSources: [], deferredScopes: [],
  }, null, 2)}\n`);
  await put("docs/legal/asset-inventory.csv", "source_commit,source_path,sha256,size_bytes,category,origin,license_evidence,redistribution,decision\n");
  await put("package-lock.json", '{"name":"fixture","version":"0.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"0.0.0"}}}\n');
  await put(sourcePath, source);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  const script = path.join(root, "scripts/verify-publication.mjs");
  let result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const forbiddenPaths = ["apps/web/config.ts", "secrets/credentials.json", "misc/signing.p12"];
  for (const name of forbiddenPaths) await put(name, "synthetic forbidden fixture\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  for (const name of forbiddenPaths) assert.ok(output.includes(name), `未検出: ${name}`);
  assert.ok(!output.includes("synthetic forbidden fixture"));
});
