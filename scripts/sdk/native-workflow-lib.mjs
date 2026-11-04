const pins = new Map([
  ["actions/attest", "1e69f48acb82d1966a394da916b4c1698aa569d6"],
  ["actions/checkout", "11bd71901bbe5b1630ceea73d27597364c9af683"],
  ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
  ["actions/upload-artifact", "cf430e030ddbb5b0abf93d22962f4752f3646cd9"],
]);

export const rendererPublishCondition = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'niho-life/niho-photo' && github.run_attempt == 1 && github.actor == github.triggering_actor";
const targets = {
  build_linux: "x86_64-unknown-linux-gnu",
  build_macos: "aarch64-apple-darwin",
};

export function photoRendererWorkflowFailures(workflow) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const serialized = JSON.stringify(workflow);
  if (workflow.name !== "Photo native renderer release") fail("native renderer workflow名が不正");
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read" })) fail("native renderer workflow既定権限はcontents: readのみ");
  if (JSON.stringify(workflow.defaults) !== JSON.stringify({ run: { shell: "bash" } })) fail("native renderer workflowのrun shellはbash固定が必要です");
  if (Object.keys(workflow.on ?? {}).join(",") !== "workflow_dispatch") fail("native renderer releaseはmanual dispatchだけ");
  const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
  if (Object.keys(inputs).join(",") !== "source_sha" || inputs.source_sha?.required !== true || inputs.source_sha?.type !== "string") fail("native renderer inputはsource_shaだけ");
  if (/\$\{\{[^}]*\b(?:secrets|vars)\b[^}]*\}\}|pull_request_target/u.test(serialized)) fail("native renderer workflowへsecret/variable/特権eventを追加できません");
  if (workflow.concurrency?.["cancel-in-progress"] !== false || typeof workflow.concurrency?.group !== "string") fail("native renderer concurrencyが不正");
  if (Object.keys(workflow.jobs ?? {}).sort().join(",") !== "build_linux,build_macos,publish") fail("native renderer job集合が不正");

  for (const [jobName, target] of Object.entries(targets)) {
    const job = workflow.jobs?.[jobName];
    const expectedRunner = jobName === "build_linux" ? "ubuntu-24.04" : "macos-26";
    if (job?.["runs-on"] !== expectedRunner || job?.permissions || job?.environment || job?.["timeout-minutes"] !== 60) fail(`${jobName}はhosted/read-only/60分に固定`);
    if (jobName === "build_linux" && (job?.container?.image !== "rust@sha256:c49256cbe5ea0188bc658a689500d70c41eb51f009a7a7be209caf60a944f3ec" || job?.container?.options !== "--platform linux/amd64")) fail("Linux Rust image/amd64 digest pinが不正");
    if (jobName === "build_macos" && job?.container) fail("macOS builderにcontainerを追加できません");
    const trust = job?.steps?.find((step) => step.id === "trust");
    for (const token of ["refs/heads/main", "niho-life/niho-photo", "^[a-f0-9]{40}$", "git -C tooling merge-base --is-ancestor", "refs/remotes/origin/main", "RENDERER_RUN_ATTEMPT", "RENDERER_TRIGGERING_ACTOR", "git -C tooling rev-parse HEAD"]) if (!trust?.run?.includes(token)) fail(`${jobName}のmain/manual/source/actor guardが不足`);
    const checkouts = job?.steps?.filter((step) => step.uses?.startsWith("actions/checkout@")) ?? [];
    if (checkouts.length !== 2 || checkouts[0].with?.ref !== "${{ github.sha }}" || checkouts[0].with?.path !== "tooling" || checkouts[0].with?.["fetch-depth"] !== 0 || checkouts[1].with?.ref !== "${{ steps.trust.outputs.source-sha }}" || checkouts[1].with?.path !== "source" || checkouts.some((step) => step.with?.["persist-credentials"] !== false)) fail(`${jobName}のtrusted/candidate checkout境界が不正`);
    const build = job?.steps?.find((step) => step.id === "build");
    if (!build?.run?.startsWith("node tooling/scripts/sdk/native-renderer.mjs build ") || !build.run.includes(`--target ${target}`) || !build.run.includes('--source "$GITHUB_WORKSPACE/source"') || build.run.includes("source/scripts/")) fail(`${jobName}はtrusted helperでsourceのrendererだけをbuildする必要があります`);
    if (jobName === "build_macos" && job?.steps?.find((step) => step.name === "固定Rust toolchainを準備")?.run !== "rustup toolchain install 1.98.1 --profile minimal") fail("macOS Rust toolchain pinが不正");
    const upload = job?.steps?.filter((step) => step.uses?.startsWith("actions/upload-artifact@")) ?? [];
    if (upload.length !== 1 || upload[0].id !== "upload" || upload[0].if !== rendererPublishCondition || upload[0].with?.name !== "${{ steps.names.outputs.artifact-name }}" || upload[0].with?.["if-no-files-found"] !== "error" || upload[0].with?.["compression-level"] !== 0) fail(`${jobName} artifact upload境界が不正`);
    const outputKeys = Object.keys(job?.outputs ?? {}).sort().join(",");
    if (outputKeys !== "archive-sha256,artifact-digest,artifact-id,artifact-name,binary-sha256,engine-tree,engine-version,source-sha,target") fail(`${jobName} output identityが不足`);
  }

  const publish = workflow.jobs?.publish;
  if (publish?.["runs-on"] !== "ubuntu-24.04" || publish?.["timeout-minutes"] !== 10 || JSON.stringify(publish?.needs) !== JSON.stringify(["build_linux", "build_macos"]) || publish?.if !== rendererPublishCondition || publish?.environment || JSON.stringify(publish?.permissions) !== JSON.stringify({ actions: "read", contents: "write", "id-token": "write", attestations: "write" })) fail("native renderer publisherのneeds/guard/最小権限が不正");
  const publisherCheckout = publish?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
  if (publisherCheckout?.with?.ref !== "${{ github.sha }}" || publisherCheckout?.with?.["fetch-depth"] !== 1 || publisherCheckout?.with?.["persist-credentials"] !== false) fail("publisherはdispatch main toolingへ固定する必要があります");
  const trust = publish?.steps?.find((step) => step.id === "trust");
  for (const token of ["git rev-parse HEAD", "LINUX_SOURCE_SHA", "MACOS_SOURCE_SHA", "LINUX_ENGINE_TREE", "MACOS_ENGINE_TREE"]) if (!trust?.run?.includes(token)) fail("publisher root/source/tree guardが不足");
  if ((publish?.steps ?? []).some((step) => step.uses?.startsWith("actions/download-artifact@"))) fail("digestをfail-closed検証できないdownload Actionは使用できません");
  const manifest = publish?.steps?.find((step) => step.id === "manifest");
  const fetchRun = (output) => `python3 scripts/sdk/native_renderer_artifact.py --artifact-id "$RENDERER_ARTIFACT_ID" --artifact-name "$RENDERER_ARTIFACT_NAME" --artifact-digest "$RENDERER_ARTIFACT_DIGEST" --run-id "$RENDERER_RUN_ID" --run-attempt "$RENDERER_RUN_ATTEMPT" --builder-source "$RENDERER_BUILDER_SOURCE" --source "$RENDERER_SOURCE_SHA" --target "$RENDERER_TARGET" --output "$RUNNER_TEMP/${output}"`;
  for (const [name, job, target, output] of [["Linux artifactをexact ID/digestでDATA取得", "build_linux", "x86_64-unknown-linux-gnu", "renderer-download-linux"], ["macOS artifactをexact ID/digestでDATA取得", "build_macos", "aarch64-apple-darwin", "renderer-download-macos"]]) {
    const fetch = publish?.steps?.find((step) => step.name === name);
    const expectedEnv = {
      GH_TOKEN: "${{ github.token }}",
      RENDERER_ARTIFACT_DIGEST: `\${{ needs.${job}.outputs.artifact-digest }}`,
      RENDERER_ARTIFACT_ID: `\${{ needs.${job}.outputs.artifact-id }}`,
      RENDERER_ARTIFACT_NAME: `\${{ needs.${job}.outputs.artifact-name }}`,
      RENDERER_BUILDER_SOURCE: "${{ steps.trust.outputs.builder-source-sha }}",
      RENDERER_RUN_ATTEMPT: "${{ github.run_attempt }}",
      RENDERER_RUN_ID: "${{ github.run_id }}",
      RENDERER_SOURCE_SHA: "${{ steps.trust.outputs.source-sha }}",
      RENDERER_TARGET: target,
    };
    if (fetch?.run !== fetchRun(output) || JSON.stringify(fetch?.env) !== JSON.stringify(expectedEnv) || publish.steps.indexOf(fetch) <= publish.steps.indexOf(trust) || publish.steps.indexOf(fetch) >= publish.steps.indexOf(manifest)) fail(`${target} artifactのtrusted REST取得・実ZIP digest・identity入力が不正`);
  }
  if (!manifest?.run?.startsWith("node scripts/sdk/native-renderer.mjs publish ") || !manifest.run.includes("--linux-artifact-id") || !manifest.run.includes("--linux-artifact-digest") || !manifest.run.includes("--linux-engine-tree") || !manifest.run.includes("--linux-engine-version") || !manifest.run.includes("--linux-target") || !manifest.run.includes("--linux-archive-sha256") || !manifest.run.includes("--linux-binary-sha256") || !manifest.run.includes("--macos-artifact-id") || !manifest.run.includes("--macos-artifact-digest") || !manifest.run.includes("--macos-engine-tree") || !manifest.run.includes("--macos-engine-version") || !manifest.run.includes("--macos-target") || !manifest.run.includes("--macos-archive-sha256") || !manifest.run.includes("--macos-binary-sha256") || !manifest.run.includes("--builder-source") || Object.keys(manifest?.env ?? {}).filter((key) => /ARTIFACT_(?:ID|DIGEST|NAME)$/u.test(key)).length !== 6) fail("publisher DATA verifierのartifact/source/tree/target/binary identityが不足");
  const attest = publish?.steps?.find((step) => step.id === "attest");
  if (attest?.uses !== "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6" || attest?.with?.["subject-path"] !== "${{ runner.temp }}/renderer-release/${{ steps.manifest.outputs.manifest-file }}" || attest?.with?.["create-storage-record"] !== true || publish.steps.indexOf(attest) <= publish.steps.indexOf(manifest)) fail("native manifestの公式attestationが不正");
  const release = publish?.steps?.find((step) => step.name === "新規source tagとnative専用releaseを作成");
  for (const token of ["photo-renderer-$RENDERER_SOURCE_SHA", "gh api \"repos/niho-life/niho-photo/git/ref/tags/$tag\"", "gh release view", "gh api --method POST repos/niho-life/niho-photo/git/refs", "gh release create", "--verify-tag", "--target", "--latest=false", "niho-photo-renderer-$RENDERER_SOURCE_SHA.json", "x86_64-unknown-linux-gnu.tgz", "aarch64-apple-darwin.tgz"]) if (!release?.run?.includes(token)) fail("native専用releaseのCAS/exact asset契約が不足");
  if (/(?:--clobber|--force|release upload)/u.test(release?.run ?? "")) fail("既存native release/tagを上書きできません");

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step["continue-on-error"]) fail("native renderer workflowの失敗を無視できません");
      if (step.uses) {
        const [name, pin, extra] = step.uses.split("@");
        if (extra || !/^[a-f0-9]{40}$/u.test(pin ?? "") || pins.get(name) !== pin) fail("native renderer Action pinが未検証です");
        if (name === "actions/checkout" && (step.with?.["persist-credentials"] !== false || step.with?.token || step.with?.["ssh-key"])) fail("native renderer checkoutはcredentialを保持できません");
      }
      if (step.run && /\$\{\{\s*github\.(?:event|head_ref|ref_name)/u.test(step.run)) fail("event入力をshellへ直接展開できません");
      if (jobName === "publish" && step.run && /(?:^|\s)(?:cargo|rustc|npm|npx)\s/u.test(step.run)) fail("publisherはbinary build/npm lifecycleを実行できません");
      if (jobName === "publish" && step.run && /(?:renderer-download-(?:linux|macos))\/(?:niho-develop-render|package\/bin)/u.test(step.run)) fail("publisherはcandidate binaryを実行できません");
    }
  }
  return [...new Set(failures)];
}
