import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { photoSdkWorkflowFailures } from "./photo-sdk-workflow-lib.mjs";

const workflow = JSON.parse(await readFile(new URL("../../.github/workflows/photo-sdk-release.yml", import.meta.url), "utf8"));

test("SDK release workflowはmain dispatchのbuild/publishだけを許可する", () => assert.deepEqual(photoSdkWorkflowFailures(workflow), []));

for (const [name, mutate] of [
  ["builder OIDC permission", (value) => { value.jobs.build.permissions = { "id-token": "write" }; }],
  ["attestation omitted", (value) => { value.jobs.publish.steps = value.jobs.publish.steps.filter((step) => step.id !== "attest"); }],
  ["attestation subject changed", (value) => { value.jobs.publish.steps.find((step) => step.id === "attest").with["subject-path"] = "unverified.json"; }],
  ["attestation OIDC permission omitted", (value) => { delete value.jobs.publish.permissions["id-token"]; }],
  ["build write permission", (value) => { value.jobs.build.permissions = { contents: "write" }; }],
  ["unfixed action", (value) => { value.jobs.build.steps[0].uses = "actions/checkout@v4"; }],
  ["non-main dispatch", (value) => { value.jobs.build.steps.find((step) => step.id === "source").run = "git checkout HEAD"; }],
  ["PR artifact upload", (value) => { delete value.jobs.build.steps.find((step) => step.id === "upload").if; }],
  ["artifact by name", (value) => { const step = value.jobs.publish.steps.find((item) => item.uses?.startsWith("actions/download-artifact@")); delete step.with["artifact-ids"]; step.with.name = "sdk"; }],
  ["transport hash omitted", (value) => { value.jobs.publish.steps.find((step) => step.name === "mainのverifierで輸送内容を再検証").run = "node scripts/sdk/verify-release-artifact.mjs"; }],
  ["artifact script executed", (value) => { value.jobs.publish.steps.find((step) => step.name === "mainのverifierで輸送内容を再検証").run = "node $SDK_ARTIFACT_DIR/script.mjs"; }],
  ["publish install", (value) => { value.jobs.publish.steps.push({ run: "npm install" }); }],
  ["release overwrite", (value) => { value.jobs.publish.steps.find((step) => step.name === "新規tagとGitHub Releaseを作成").run += "\ngh release upload --clobber"; }],
  ["application latest overwritten", (value) => { value.jobs.publish.steps.find((step) => step.name === "新規tagとGitHub Releaseを作成").run = value.jobs.publish.steps.find((step) => step.name === "新規tagとGitHub Releaseを作成").run.replace("--latest=false", ""); }],
  ["receipt digest omitted", (value) => { delete value.jobs.publish.steps.find((step) => step.name === "mainのverifierで輸送内容を再検証").env.SDK_ARTIFACT_DIGEST; }],
  ["rust-src omitted", (value) => { const step = value.jobs.build.steps.find((item) => item.name === "固定Rust/WASM toolchainを準備"); step.run = step.run.replace(" --component rust-src", ""); }],
  ["real engine smoke omitted", (value) => { value.jobs.build.steps.find((step) => step.name === "実WASMをbuildしてSDKを検証").run = "npm run sdk:smoke"; }],
]) test(`SDK release workflowの危険な変更を拒否: ${name}`, () => {
  const changed = structuredClone(workflow);
  mutate(changed);
  assert.ok(photoSdkWorkflowFailures(changed).length > 0);
});
