import { actionPins } from "./workflow-lib.mjs";

const publishCondition = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'niho-life/niho-photo'";
const expectedPermissions = { actions: "read", contents: "write", "id-token": "write", attestations: "write" };
const expectedBuildPermissions = { contents: "read", attestations: "read" };
const releaseActionPins = new Map([
  ...actionPins,
  ["actions/download-artifact", "d3f86a106a0bac45b974a628896c90dbdf5c8093"],
  ["actions/attest", "1e69f48acb82d1966a394da916b4c1698aa569d6"],
]);

export function photoWebWorkflowFailures(workflow) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const serialized = JSON.stringify(workflow);
  const dispatch = workflow.on?.workflow_dispatch;
  const build = workflow.jobs?.build;
  const publish = workflow.jobs?.publish;
  if (workflow.name !== "Photo Web release" || Object.keys(workflow.on ?? {}).join(",") !== "workflow_dispatch"
    || Object.keys(dispatch ?? {}).length !== 0) fail("Photo Web release workflowはinputなしの手動実行だけにする");
  if (JSON.stringify(workflow.permissions) !== JSON.stringify(expectedBuildPermissions)) fail("Photo Web releaseの既定権限をcontents/attestations readに限定する");
  if (workflow.concurrency?.["cancel-in-progress"] !== false || typeof workflow.concurrency?.group !== "string") fail("Photo Web release concurrencyが不正です");
  if (Object.keys(workflow.jobs ?? {}).sort().join(",") !== "build,publish") fail("Photo Web release job集合が不正です");
  if (build?.name !== "Build and verify Photo Web release" || build?.["runs-on"] !== "ubuntu-24.04"
    || build?.["timeout-minutes"] !== 60 || build?.permissions || build?.environment) fail("Photo Web build jobのrunner/権限が不正です");
  if (publish?.name !== "Publish immutable Photo Web release" || JSON.stringify(publish?.needs) !== JSON.stringify(["build"])
    || publish?.if !== publishCondition || publish?.["runs-on"] !== "ubuntu-24.04" || publish?.["timeout-minutes"] !== 15
    || JSON.stringify(publish?.permissions) !== JSON.stringify(expectedPermissions) || publish?.environment) {
    fail("Photo Web publisherの固定job名/条件/最小権限が不正です");
  }
  if (/\$\{\{[^}]*\b(?:secrets|vars)\b[^}]*\}\}|pull_request_target/u.test(serialized)) fail("Photo Web releaseへsecret/vars/privileged eventを追加できません");
  if (/PHOTO_WEB_CLOUD_ENABLED[^\n]*true/u.test(serialized)) fail("Photo Web cloud admission must remain off by default");

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    let checkout = false;
    for (const step of job.steps ?? []) {
      if (step["continue-on-error"]) fail("Photo Web release stepの失敗を無視できません");
      if (step.uses) {
        const [name, pin, extra] = step.uses.split("@");
        if (extra || !/^[a-f0-9]{40}$/u.test(pin ?? "") || releaseActionPins.get(name) !== pin) fail("Photo Web release action pinが未検証です");
        if (name === "actions/checkout") {
          checkout = true;
          if (step.with?.["persist-credentials"] !== false || step.with?.token || step.with?.["ssh-key"]) fail("Photo Web release checkoutにcredentialを保持できません");
        }
      }
      if (step.run && /\$\{\{\s*github\.(?:event|head_ref|ref_name)/u.test(step.run)) fail("Photo Web release shellへevent値を展開できません");
      if (jobName === "publish" && step.run && /(?:^|\s)(?:npm|npx|cargo|rustc|wasm-bindgen)\s/u.test(step.run)) fail("Photo Web publish jobでbuild/installを実行できません");
    }
    if (!checkout) fail("Photo Web release jobにはcredentialを保持しないcheckoutが必要です");
  }

  const source = build?.steps?.find((step) => step.id === "source");
  if (!source?.run?.includes("refs/heads/main") || !source.run.includes("niho-life/niho-photo")
    || !source.run.includes("^[a-f0-9]{40}$") || !source.run.includes("git rev-parse HEAD")
    || source?.env?.PHOTO_WEB_WORKFLOW_SHA !== "${{ github.sha }}") fail("Photo Web release sourceは公式main workflow SHAへ固定する必要があります");
  const sdkProof = build?.steps?.find((step) => step.name === "公開SDK releaseとSigstore証跡を検証");
  if (!sdkProof?.run?.includes("prepare-published-sdk.mjs") || !sdkProof.run.includes("prepare-sdk-attestation.mjs")
    || !sdkProof.run.includes("sdk-baseline.json") || !sdkProof.run.includes('--github-output "$GITHUB_OUTPUT"')
    || sdkProof.env?.GH_TOKEN !== "${{ github.token }}") fail("Photo Web releaseはbaseline SDK manifest/receipt/署名を検証する必要があります");
  const upload = build?.steps?.find((step) => step.id === "upload");
  if (upload?.uses !== `actions/upload-artifact@${releaseActionPins.get("actions/upload-artifact")}`
    || JSON.stringify(upload.with) !== JSON.stringify({
      name: "${{ steps.names.outputs.artifact-name }}",
      path: "${{ runner.temp }}/photo-web-build/",
      "if-no-files-found": "error",
      "retention-days": 30,
      "compression-level": 0,
      "include-hidden-files": false,
    })) fail("Photo Web build outputs must use one bounded immutable Actions artifact");
  const download = publish?.steps?.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  if (JSON.stringify(download?.with) !== JSON.stringify({
    "artifact-ids": "${{ needs.build.outputs.artifact-id }}",
    path: "${{ runner.temp }}/photo-web-build",
    "merge-multiple": true,
  })) fail("Photo Web publisher must download the exact build artifact by ID");
  const attest = publish?.steps?.find((step) => step.uses?.startsWith("actions/attest@"));
  if (attest?.with?.["create-storage-record"] !== false || !String(attest?.with?.["subject-path"] ?? "").includes("niho-photo-web-${{ needs.build.outputs.source-sha }}.json")) fail("Photo Web manifest must be Sigstore-attested without an extra storage record");
  const release = publish?.steps?.find((step) => step.name === "immutable tagと3 assetだけを公開");
  if (!release?.run?.includes("gh api --method POST repos/niho-life/niho-photo/git/refs")
    || !release.run.includes("gh release create") || !release.run.includes("--verify-tag") || !release.run.includes("--latest=false")
    || /(?:--clobber|--force|release upload)/u.test(release.run)) fail("Photo Web releaseはtagと3 assetを新規immutable releaseとして公開する必要があります");
  const packageRelease = publish?.steps?.find((step) => step.name === "archiveとmanifestを生成して再検証");
  if (packageRelease?.env?.PHOTO_WEB_ARTIFACT_DIGEST !== "sha256:${{ needs.build.outputs.artifact-digest }}") fail("Photo Web publisher must normalize the upload-artifact SHA-256 prefix");
  return [...new Set(failures)];
}
