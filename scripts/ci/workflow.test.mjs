import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { workflowFailures } from "./workflow-lib.mjs";
const workflow = JSON.parse(await readFile(new URL("../../.github/workflows/public-ci.yml", import.meta.url), "utf8"));
test("公開workflowの権限、runner、pin、aggregate契約", () => assert.deepEqual(workflowFailures(workflow), []));
test("PR proofはダミー公開値を実行時生成し通常形式のapp版を使う", () => {
  const command = workflow.jobs["photo-candidate"].steps.find((step) => step.name === "current SHAから完全Mac candidateを実build").run;
  assert.doesNotMatch(command, /AIza[A-Za-z0-9_-]{30,}/u);
  assert.ok(command.includes('"AIza" + "0".repeat(35)'));
  assert.ok(command.includes('candidate_version="0.0.0"'));
});
const swiftPackage = await readFile(new URL("../../packages/develop-engine/tools/apple-raw-linear/Package.swift", import.meta.url), "utf8");
const swiftToolsVersion = swiftPackage.match(/^\/\/ swift-tools-version: (\d+\.\d+)/m)?.[1];
test("現像Swift packageは新しいCore Image SDKのGitHub-hosted runnerで検証する", () => {
  const job = workflow.jobs.swift;
  assert.equal(job?.if, "needs.plan.outputs.has-swift == 'true'");
  assert.equal(job?.["runs-on"], "macos-26");
  assert.equal(swiftToolsVersion, "6.0");
  assert.ok(job.steps.some((step) => step.run === "swift test --package-path packages/develop-engine/tools/apple-raw-linear"));
});
for (const [name, mutate] of [
  ["tag Action", (w) => { w.jobs.plan.steps[0].uses = "actions/checkout@v4"; }],
  ["unverified Action commit", (w) => { w.jobs.plan.steps[0].uses = `actions/checkout@${"a".repeat(40)}`; }],
  ["write permission", (w) => { w.permissions.contents = "write"; }],
  ["job permission", (w) => { w.jobs.plan.permissions = { contents: "write" }; }],
  ["credential persistence", (w) => { w.jobs.plan.steps[0].with["persist-credentials"] = true; }],
  ["private runner", (w) => { w.jobs.native["runs-on"] = ["self-hosted"]; }],
  ["production environment", (w) => { w.jobs.native.environment = "production"; }],
  ["privileged event", (w) => { w.on["pull_request" + "_target"] = {}; }],
  ["secret reference", (w) => { w.jobs.plan.env = { TOKEN: "${{ secrets." + "SYNTHETIC }}" }; }],
  ["serialized secrets context", (w) => { w.jobs.plan.env = { TOKEN: "${{ toJSON(secrets) }}" }; }],
  ["serialized vars context", (w) => { w.jobs.plan.env = { TOKEN: "${{ toJSON(vars) }}" }; }],
  ["shell injection", (w) => { w.jobs.plan.steps.push({ run: "echo '${{ github.event.pull_request.title }}'" }); }],
  ["aggregate bypass", (w) => { w.jobs.aggregate.needs = ["plan"]; }],
  ["concurrency disabled", (w) => { w.concurrency["cancel-in-progress"] = false; }],
  ["unreviewed advisory exception", (w) => { w.jobs.dependencies.steps[1].with["allow-ghsas"] += ",GHSA-0000-0000-0000"; }],
  ["weaker vulnerability threshold", (w) => { w.jobs.dependencies.steps[1].with["fail-on-severity"] = "high"; }],
  ["SDK consumer smoke omitted", (w) => { w.jobs["photo-editing"].steps = w.jobs["photo-editing"].steps.filter((step) => step.run !== "npm run sdk:test"); }],
  ["SDK rust-src omitted", (w) => { const step = w.jobs["photo-sdk"].steps.find((item) => item.name === "固定Rust/WASM toolchainを準備"); step.run = step.run.replace(" --component rust-src", ""); }],
  ["SDK real engine smoke omitted", (w) => { w.jobs["photo-sdk"].steps.find((step) => step.name === "実WASM・pack・repo外consumerを検証").run = "npm run sdk:smoke"; }],
  ["candidate proof skipped", (w) => { w.jobs["photo-candidate"].if = "false"; }],
  ["candidate fixture omitted", (w) => { w.jobs["photo-candidate"].steps = w.jobs["photo-candidate"].steps.filter((step) => step.name !== "candidate data fixtureを検証"); }],
  ["candidate local SDK pin omitted", (w) => { w.jobs["photo-candidate"].steps.find((step) => step.name === "current SHAから完全Mac candidateを実build").run = "npm run candidate:build"; }],
]) test(`workflowの危険な変更を拒否: ${name}`, () => {
  const changed = structuredClone(workflow);
  mutate(changed);
  assert.ok(workflowFailures(changed).length > 0);
});

for (const [name, mutate] of [
  ["PR artifact upload", (w) => { delete w.jobs.native.steps.find((step) => step.id === "upload-release-evidence").if; }],
  ["unverified artifact path", (w) => { w.jobs.native.steps.find((step) => step.id === "upload-release-evidence").with.path = "."; }],
  ["missing artifact tolerated", (w) => { w.jobs.native.steps.find((step) => step.id === "upload-release-evidence").with["if-no-files-found"] = "warn"; }],
  ["upload ID not retained", (w) => { delete w.jobs.native.steps.find((step) => step.id === "upload-release-evidence").id; }],
  ["artifact digest not recorded", (w) => { delete w.jobs.native.steps.find((step) => step.id === "release-artifact-receipt").env.RELEASE_ARTIFACT_DIGEST; }],
  ["receipt failure ignored", (w) => { w.jobs.native.steps.find((step) => step.id === "release-artifact-receipt")["continue-on-error"] = true; }],
  ["evidence failure ignored", (w) => { w.jobs.native.steps.find((step) => step.id === "release-evidence")["continue-on-error"] = true; }],
  ["release guard bypassed", (w) => { w.jobs.native.steps.find((step) => step.id === "release-evidence").run = "npm run build"; }],
]) test(`release evidenceの危険な変更を拒否: ${name}`, () => {
  const changed = structuredClone(workflow);
  mutate(changed);
  assert.ok(workflowFailures(changed).length > 0);
});
