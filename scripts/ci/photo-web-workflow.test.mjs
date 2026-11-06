import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { photoWebWorkflowFailures } from "./photo-web-workflow-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = JSON.parse(readFileSync(path.join(root, ".github/workflows/photo-web-release.yml"), "utf8"));

test("Photo Web formal releaseはmanual main publisher・SDK proof・pinned actionだけを使う", () => {
  assert.deepEqual(photoWebWorkflowFailures(workflow), []);
});

test("Photo Web release guard rejects pull request triggers, wider permissions and cloud admission", () => {
  const pullRequest = structuredClone(workflow);
  pullRequest.on.pull_request = {};
  assert.ok(photoWebWorkflowFailures(pullRequest).some((message) => message.includes("手動実行だけ")));

  const widerPermissions = structuredClone(workflow);
  widerPermissions.permissions.contents = "write";
  assert.ok(photoWebWorkflowFailures(widerPermissions).some((message) => message.includes("既定権限")));

  const cloudEnabled = structuredClone(workflow);
  cloudEnabled.jobs.publish.steps.push({ run: "PHOTO_WEB_CLOUD_ENABLED=true" });
  assert.ok(photoWebWorkflowFailures(cloudEnabled).some((message) => message.includes("admission")));
});

test("Photo Web release guard rejects wrong publisher identity, unpinned actions, and force replacement", () => {
  const wrongJob = structuredClone(workflow);
  wrongJob.jobs.publish.name = "Publish candidate";
  assert.ok(photoWebWorkflowFailures(wrongJob).some((message) => message.includes("固定job名")));

  const unpinned = structuredClone(workflow);
  unpinned.jobs.publish.steps[1].uses = "actions/setup-node@main";
  assert.ok(photoWebWorkflowFailures(unpinned).some((message) => message.includes("action pin")));

  const force = structuredClone(workflow);
  force.jobs.publish.steps.at(-1).run += "\ngh release upload --clobber";
  assert.ok(photoWebWorkflowFailures(force).some((message) => message.includes("immutable release")));
});
