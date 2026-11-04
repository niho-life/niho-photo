import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { photoRendererWorkflowFailures } from "../sdk/native-workflow-lib.mjs";

const workflow = JSON.parse(await readFile(new URL("../../.github/workflows/photo-renderer-release.yml", import.meta.url), "utf8"));

test("native renderer releaseはread-only 2 builderとDATA-only publisherへ分離される", () => {
  assert.deepEqual(photoRendererWorkflowFailures(workflow), []);
});

test("trusted artifact取得helperはofflineでZIPとmetadata改竄を拒否する", () => {
  const result = spawnSync("python3", [new URL("../sdk/native_renderer_artifact_test.py", import.meta.url).pathname], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, mutate] of [
  ["PR event", (value) => { value.on.pull_request = {}; }],
  ["command input", (value) => { value.on.workflow_dispatch.inputs.command = { required: true, type: "string" }; }],
  ["default bash omitted", (value) => { delete value.defaults; }],
  ["default bash changed", (value) => { value.defaults.run.shell = "sh"; }],
  ["Linux write permission", (value) => { value.jobs.build_linux.permissions = { contents: "write" }; }],
  ["builder OIDC", (value) => { value.jobs.build_macos.permissions = { "id-token": "write" }; }],
  ["publisher write omitted", (value) => { delete value.jobs.publish.permissions.contents; }],
  ["floating action", (value) => { value.jobs.build_linux.steps[0].uses = "actions/checkout@v4"; }],
  ["Rust image floating tag", (value) => { value.jobs.build_linux.container.image = "rust:1.98.1-bookworm"; }],
  ["source checkout executes helper", (value) => { value.jobs.build_linux.steps.find((step) => step.id === "build").run = "node source/scripts/sdk/native-renderer.mjs build"; }],
  ["main guard omitted", (value) => { value.jobs.build_macos.steps.find((step) => step.id === "trust").run = "printf ok"; }],
  ["rerun guard omitted", (value) => { value.jobs.publish.if = value.jobs.publish.if.replace(" && github.run_attempt == 1", ""); }],
  ["artifact upload on PR", (value) => { delete value.jobs.build_linux.steps.find((step) => step.id === "upload").if; }],
  ["artifact ID pin changed", (value) => { value.jobs.publish.steps.find((item) => item.name.startsWith("Linux artifact")).env.RENDERER_ARTIFACT_ID = "7"; }],
  ["artifact digest pin omitted", (value) => { delete value.jobs.publish.steps.find((item) => item.name.startsWith("macOS artifact")).env.RENDERER_ARTIFACT_DIGEST; }],
  ["artifact run pin omitted", (value) => { delete value.jobs.publish.steps.find((item) => item.name.startsWith("Linux artifact")).env.RENDERER_RUN_ID; }],
  ["artifact builder pin changed", (value) => { value.jobs.publish.steps.find((item) => item.name.startsWith("macOS artifact")).env.RENDERER_BUILDER_SOURCE = "${{ github.sha }}"; }],
  ["artifact source pin changed", (value) => { value.jobs.publish.steps.find((item) => item.name.startsWith("Linux artifact")).env.RENDERER_SOURCE_SHA = "${{ github.sha }}"; }],
  ["artifact target pin changed", (value) => { value.jobs.publish.steps.find((item) => item.name.startsWith("macOS artifact")).env.RENDERER_TARGET = "x86_64-unknown-linux-gnu"; }],
  ["trusted fetch helper changed", (value) => { value.jobs.publish.steps.find((item) => item.name.startsWith("Linux artifact")).run = "gh api repos/niho-life/niho-photo/actions/artifacts/7/zip"; }],
  ["download action reintroduced", (value) => { value.jobs.publish.steps.push({ uses: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093" }); }],
  ["artifact digest verifier omitted", (value) => { value.jobs.publish.steps.find((step) => step.id === "manifest").run = "node scripts/sdk/native-renderer.mjs publish"; }],
  ["attestation omitted", (value) => { value.jobs.publish.steps = value.jobs.publish.steps.filter((step) => step.id !== "attest"); }],
  ["attestation subject changed", (value) => { value.jobs.publish.steps.find((step) => step.id === "attest").with["subject-path"] = "unverified.json"; }],
  ["candidate binary executed", (value) => { value.jobs.publish.steps.find((step) => step.id === "manifest").run += "\n$RUNNER_TEMP/renderer-download-linux/niho-develop-render"; }],
  ["publisher npm lifecycle", (value) => { value.jobs.publish.steps.push({ run: "npm install" }); }],
  ["release overwrite", (value) => { value.jobs.publish.steps.at(-1).run += "\ngh release upload --clobber"; }],
]) test(`native renderer workflowの危険な変更を拒否: ${name}`, () => {
  const changed = structuredClone(workflow);
  mutate(changed);
  assert.ok(photoRendererWorkflowFailures(changed).length > 0);
});
