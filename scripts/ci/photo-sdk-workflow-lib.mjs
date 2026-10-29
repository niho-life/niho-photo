const pins = new Map([
  ["actions/attest", "1e69f48acb82d1966a394da916b4c1698aa569d6"],
  ["actions/checkout", "11bd71901bbe5b1630ceea73d27597364c9af683"],
  ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
  ["actions/upload-artifact", "cf430e030ddbb5b0abf93d22962f4752f3646cd9"],
  ["actions/download-artifact", "d3f86a106a0bac45b974a628896c90dbdf5c8093"],
]);

export const publishCondition = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'niho-life/niho-photo'";
export const buildCommand = "set -euo pipefail\nnpm run sdk:build-engine-runtime -- --output \"$SDK_RUNTIME_DIR\"\nnpm run sdk:pack -- --output \"$SDK_RELEASE_DIR\" --source \"$SDK_SOURCE_SHA\" --engine-assets \"$SDK_RUNTIME_DIR\"\nmanifest=\"$SDK_RELEASE_DIR/niho-photo-sdk-$(node -p 'require(\"./sdk/release-set.json\").version')-$SDK_SOURCE_SHA.json\"\nnpm run sdk:smoke -- --manifest \"$manifest\"\nnpm run sdk:smoke-real-engine -- --manifest \"$manifest\"";
export const publishVerifyCommand = "node scripts/sdk/verify-release-artifact.mjs --directory \"$SDK_ARTIFACT_DIR\" --expected-source \"$SDK_SOURCE_SHA\" --expected-manifest-sha256 \"$SDK_MANIFEST_SHA256\" --receipt \"$SDK_RECEIPT_FILE\" --artifact-id \"$SDK_ARTIFACT_ID\" --artifact-digest \"$SDK_ARTIFACT_DIGEST\" --artifact-name \"$SDK_ARTIFACT_NAME\" --run-id \"$SDK_RUN_ID\" --run-attempt \"$SDK_RUN_ATTEMPT\"";

// スレッドの版（#151）は固定の 1.98.1 の rust-src で std を作り直す（-Z build-std）。
export const toolchainCommand = "rustup toolchain install 1.98.1 --profile minimal --target wasm32-unknown-unknown --component rust-src\ncargo +1.98.1 install wasm-bindgen-cli --version 0.2.129 --locked";

export function photoSdkWorkflowFailures(workflow) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const serialized = JSON.stringify(workflow);
  if (workflow.name !== "Photo SDK release") fail("SDK workflow名が不正");
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read" })) fail("SDK workflow既定権限はcontents: readのみ");
  if (Object.keys(workflow.on ?? {}).join(",") !== "workflow_dispatch") fail("SDK release workflow eventはmanual dispatchのみ");
  const input = workflow.on?.workflow_dispatch?.inputs?.source_sha;
  if (Object.keys(workflow.on?.workflow_dispatch?.inputs ?? {}).join(",") !== "source_sha" || input?.required !== true || input?.type !== "string") fail("SDK dispatchはfull source SHA入力が必須");
  if (workflow.concurrency?.["cancel-in-progress"] !== false || typeof workflow.concurrency?.group !== "string") fail("SDK release concurrencyが不正");
  if (/\$\{\{[^}]*\b(?:secrets|vars)\b[^}]*\}\}|pull_request_target/u.test(serialized)) fail("SDK workflowへsecret/特権eventを追加できません");
  if (Object.keys(workflow.jobs ?? {}).sort().join(",") !== "build,publish") fail("SDK workflow job集合が不正");
  const build = workflow.jobs?.build;
  const publish = workflow.jobs?.publish;
  if (build?.["runs-on"] !== "ubuntu-24.04" || build?.permissions || build?.environment || build?.["timeout-minutes"] !== 60) fail("SDK buildはGitHub hosted/read-only jobに固定");
  if (publish?.["runs-on"] !== "ubuntu-24.04" || JSON.stringify(publish?.needs) !== JSON.stringify(["build"]) || publish?.if !== publishCondition || publish?.["timeout-minutes"] !== 10 || JSON.stringify(publish?.permissions) !== JSON.stringify({ actions: "read", contents: "write", "id-token": "write", attestations: "write" }) || publish?.environment) fail("SDK publishのrunner/条件/最小権限が不正");
  const expectedOutputs = {
    "artifact-id": "${{ steps.upload.outputs.artifact-id }}",
    "artifact-digest": "${{ steps.upload.outputs.artifact-digest }}",
    "artifact-name": "${{ steps.names.outputs.artifact-name }}",
    "manifest-sha256": "${{ steps.release.outputs.manifest-sha256 }}",
    "source-sha": "${{ steps.release.outputs.source-sha }}",
    version: "${{ steps.release.outputs.version }}",
  };
  if (JSON.stringify(build?.outputs) !== JSON.stringify(expectedOutputs)) fail("SDK build/publish output境界が不正");
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step["continue-on-error"]) fail("SDK workflowの失敗を無視できません");
      if (step.uses) {
        const [name, pin, extra] = step.uses.split("@");
        if (extra || !/^[a-f0-9]{40}$/u.test(pin ?? "") || pins.get(name) !== pin) fail("SDK workflowのAction pinが未検証です");
        if (name === "actions/checkout" && (step.with?.["persist-credentials"] !== false || step.with?.token || step.with?.["ssh-key"])) fail("SDK checkoutはcredentialを保持できません");
      }
      if (step.run && /\$\{\{\s*github\.(?:event|head_ref|ref_name)/u.test(step.run)) fail("SDK shellへevent入力を直接展開できません");
      if (jobName === "publish" && step.run && /(?:^|\s)(?:npm|npx|cargo|rustc|wasm-bindgen)\s/u.test(step.run)) fail("publish jobはartifactのbuild/installを実行できません");
    }
  }
  const source = build?.steps?.find((step) => step.id === "source");
  if (!source?.run?.includes("refs/heads/main") || !source.run.includes("^[a-f0-9]{40}$") || !source.run.includes("git merge-base --is-ancestor") || !source.run.includes("refs/remotes/origin/main") || !source.run.includes('"niho-life/niho-photo"') || source["continue-on-error"]) fail("dispatch sourceは新repository契約を持つmainのfull SHA祖先に限定する必要があります");
  const actualBuild = build?.steps?.find((step) => step.name === "実WASMをbuildしてSDKを検証");
  if (actualBuild?.run !== buildCommand || actualBuild?.env?.SDK_SOURCE_SHA !== "${{ steps.source.outputs.source-sha }}") fail("SDK buildは実WASM→pack→外部consumerを固定順で検証する必要があります");
  if (build?.steps?.find((step) => step.name === "固定Rust/WASM toolchainを準備")?.run !== toolchainCommand) fail("SDK buildは固定Rust 1.98.1のwasm targetとrust-src（スレッドの版）が必要です");
  const release = build?.steps?.find((step) => step.id === "release");
  if (!release?.run?.includes("verify-release-artifact.mjs") || !release.run.includes("--github-output \"$GITHUB_OUTPUT\"") || release.run.includes("--expected-manifest-sha256")) fail("build側release asset検証が不正です");
  const uploads = build?.steps?.filter((step) => step.uses?.startsWith("actions/upload-artifact@")) ?? [];
  const expectedUpload = { name: "${{ steps.names.outputs.artifact-name }}", path: "sdk-dist/release/", "if-no-files-found": "error", "retention-days": 30, "compression-level": 0, "include-hidden-files": false };
  if (uploads.length !== 1 || uploads[0].id !== "upload" || uploads[0].if !== publishCondition || JSON.stringify(uploads[0].with) !== JSON.stringify(expectedUpload)) fail("PRからSDK release artifactを保存できません");
  const checkout = publish?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
  if (checkout?.with?.ref !== "${{ github.sha }}" || checkout?.with?.["fetch-depth"] !== 1) fail("publish verifierはdispatchしたmain toolingを使う必要があります");
  const downloads = publish?.steps?.filter((step) => step.uses?.startsWith("actions/download-artifact@")) ?? [];
  const expectedDownload = { "artifact-ids": "${{ needs.build.outputs.artifact-id }}", path: "${{ runner.temp }}/photo-sdk-download", "merge-multiple": true };
  if (downloads.length !== 1 || JSON.stringify(downloads[0].with) !== JSON.stringify(expectedDownload)) fail("publish artifactはbuild artifact IDから固定pathへ取得する必要があります");
  const verify = publish?.steps?.find((step) => step.name === "mainのverifierで輸送内容を再検証");
  if (verify?.run !== publishVerifyCommand || verify?.env?.SDK_MANIFEST_SHA256 !== "${{ needs.build.outputs.manifest-sha256 }}" || verify?.env?.SDK_ARTIFACT_DIGEST !== "${{ needs.build.outputs.artifact-digest }}") fail("publishはmanifest hashと輸送receiptをmain verifierで照合する必要があります");
  const releaseStep = publish?.steps?.find((step) => step.name === "新規tagとGitHub Releaseを作成");
  if (!releaseStep?.run?.includes("gh api --method POST repos/niho-life/niho-photo/git/refs") || !releaseStep.run.includes("refs/tags/$tag") || !releaseStep.run.includes("gh release create") || !releaseStep.run.includes("--verify-tag") || !releaseStep.run.includes("--latest=false") || !releaseStep.run.includes('release_core="${SDK_VERSION%%+*}"') || !releaseStep.run.includes("release_flags+=(--prerelease)") || !releaseStep.run.includes("$SDK_RECEIPT_FILE") || /(?:--clobber|--force|release upload)/u.test(releaseStep?.run ?? "") || releaseStep?.env?.GH_TOKEN !== "${{ github.token }}") fail("SDK releaseは新repositoryでlatestを変更せず新規tagと検証済みassetだけを公開する必要があります");
  const attest = publish?.steps?.find((step) => step.id === "attest");
  const expectedAttest = {"subject-path": "${{ runner.temp }}/photo-sdk-download/niho-photo-sdk-${{ needs.build.outputs.version }}-${{ needs.build.outputs.source-sha }}.json", "create-storage-record": false};
  if (attest?.uses !== "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6" || JSON.stringify(attest?.with) !== JSON.stringify(expectedAttest) || publish.steps.indexOf(attest) <= publish.steps.indexOf(verify) || publish.steps.indexOf(attest) >= publish.steps.length - 1) fail("公開manifestの公式workflow attestationが不足しています");
  return [...new Set(failures)];
}
