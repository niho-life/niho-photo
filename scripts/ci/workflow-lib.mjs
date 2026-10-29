// GitHub ActionsはYAMLの部分集合であるJSONを受理する。構造検査を外部依存なしで行う。
export const actionPins = new Map([
  ["actions/checkout", "11bd71901bbe5b1630ceea73d27597364c9af683"],
  ["actions/upload-artifact", "cf430e030ddbb5b0abf93d22962f4752f3646cd9"],
  ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
  ["actions/dependency-review-action", "3c4e3dcb1aa7874d2c16be7d79418e9b7efd6261"],
]);
const candidateProofCommand = "set -euo pipefail\nnpm run sdk:build-engine-runtime -- --output \"$SDK_RUNTIME_DIR\"\nnpm run sdk:pack -- --output \"$SDK_RELEASE_DIR\" --source \"$CANDIDATE_SOURCE_SHA\" --engine-assets \"$SDK_RUNTIME_DIR\"\nsdk_version=$(node -p 'require(\"./sdk/release-set.json\").version')\ncandidate_version=\"0.0.0\"\nsdk_manifest=\"$SDK_RELEASE_DIR/niho-photo-sdk-$sdk_version-$CANDIDATE_SOURCE_SHA.json\"\nsdk_manifest_sha=$(shasum -a 256 \"$sdk_manifest\" | cut -d ' ' -f 1)\nnode -e 'require(\"node:fs\").writeFileSync(process.argv[1], JSON.stringify({NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY: \"AIza\" + \"0\".repeat(35)}) + \"\\n\")' \"$FIREBASE_CONFIG\"\nnpm run candidate:build -- --sdk-directory \"$SDK_RELEASE_DIR\" --sdk-mode local-validation --sdk-manifest-sha256 \"$sdk_manifest_sha\" --app-source \"$CANDIDATE_SOURCE_SHA\" --version \"$candidate_version\" --public-firebase-config \"$FIREBASE_CONFIG\" --node-modules \"$GITHUB_WORKSPACE/node_modules\" --output \"$CANDIDATE_OUTPUT\" --run-id \"$CANDIDATE_RUN_ID\" --run-attempt \"$CANDIDATE_RUN_ATTEMPT\"\ncandidate_manifest=$(find \"$CANDIDATE_OUTPUT\" -maxdepth 1 -type f -name '*.candidate.json')\nif [[ -z \"$candidate_manifest\" || \"$(find \"$CANDIDATE_OUTPUT\" -maxdepth 1 -type f -name '*.candidate.json' | wc -l | tr -d ' ')\" != \"1\" ]]; then exit 1; fi\ncandidate_manifest_sha=$(shasum -a 256 \"$candidate_manifest\" | cut -d ' ' -f 1)\nnpm run candidate:verify -- --directory \"$CANDIDATE_OUTPUT\" --expected-manifest-sha256 \"$candidate_manifest_sha\" --expected-source \"$CANDIDATE_SOURCE_SHA\" --expected-version \"$candidate_version\" --expected-sdk-mode local-validation --expected-sdk-version \"$sdk_version\" --expected-sdk-manifest-sha256 \"$sdk_manifest_sha\" --run-id \"$CANDIDATE_RUN_ID\" --run-attempt \"$CANDIDATE_RUN_ATTEMPT\"";
export function workflowFailures(workflow) {
  const failures = [];
  const fail = (message) => failures.push(message);
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read" })) fail("workflow権限はcontents: readのみ");
  if (Object.keys(workflow.on ?? {}).sort().join(",") !== "pull_request,push") fail("workflow eventはpull_request/pushのみ");
  if (JSON.stringify(workflow.on?.push) !== JSON.stringify({ branches: ["main"] }) || JSON.stringify(workflow.on?.pull_request) !== "{}") fail("全PRとmain pushを検査する必要あり");
  if (workflow.concurrency?.["cancel-in-progress"] !== true || typeof workflow.concurrency?.group !== "string") fail("concurrencyが必要");
  if (/\$\{\{[^}]*\b(?:secrets|vars)\b[^}]*\}\}|\bid-token\b|pull_request_target/.test(JSON.stringify(workflow))) fail("secret/権限付きcontextは禁止");
  const aggregate = workflow.jobs?.aggregate;
  if (aggregate?.name !== "Public CI required" || aggregate.if !== "always()") fail("安定aggregate checkが必要");
  if (Object.keys(workflow.jobs ?? {}).filter((name) => name !== "aggregate").sort().join(",") !== [...(aggregate?.needs ?? [])].sort().join(",")) fail("aggregateは全jobに依存する必要あり");
  const dependencyReview = workflow.jobs?.dependencies?.steps?.filter((step) => step.uses?.startsWith("actions/dependency-review-action@")) ?? [];
  const reviewInputs = {
    "fail-on-severity": "moderate",
    "fail-on-scopes": "runtime,development,unknown",
    "deny-licenses": "AGPL-1.0-only,AGPL-1.0-or-later,AGPL-3.0-only,AGPL-3.0-or-later",
    "allow-ghsas": "GHSA-wrw7-89jp-8q8g",
    "comment-summary-in-pr": "never",
    "retry-on-snapshot-warnings": true,
    "retry-on-snapshot-warnings-timeout": 120,
  };
  if (dependencyReview.length !== 1 || JSON.stringify(dependencyReview[0].with) !== JSON.stringify(reviewInputs)) fail("依存レビューの検査範囲・例外は監査済み設定に固定する");
  const sdkTests = workflow.jobs?.["photo-editing"]?.steps?.filter((step) => step.run === "npm run sdk:test") ?? [];
  if (sdkTests.length !== 1 || sdkTests[0]["continue-on-error"]) fail("SDK packageとrepo外consumer smokeの検証が必要");
  const sdkBuild = workflow.jobs?.["photo-sdk"];
  const sdkBuildCommand = "set -euo pipefail\nnpm run sdk:build-engine-runtime -- --output \"$SDK_RUNTIME_DIR\"\nnpm run sdk:pack -- --output \"$SDK_RELEASE_DIR\" --source \"$SDK_SOURCE_SHA\" --engine-assets \"$SDK_RUNTIME_DIR\"\nmanifest=\"$SDK_RELEASE_DIR/niho-photo-sdk-$(node -p 'require(\"./sdk/release-set.json\").version')-$SDK_SOURCE_SHA.json\"\nnpm run sdk:smoke -- --manifest \"$manifest\"\nnpm run sdk:smoke-real-engine -- --manifest \"$manifest\"\nnode scripts/sdk/verify-release-artifact.mjs --directory \"$SDK_RELEASE_DIR\" --expected-source \"$SDK_SOURCE_SHA\"";
  const sdkBuildSteps = sdkBuild?.steps?.filter((step) => step.name === "実WASM・pack・repo外consumerを検証") ?? [];
  if (sdkBuild?.if !== "needs.plan.outputs.photo-sdk == 'true'" || JSON.stringify(sdkBuild?.needs) !== JSON.stringify(["plan", "publication"]) || sdkBuild?.["runs-on"] !== "ubuntu-24.04" || sdkBuild?.["timeout-minutes"] !== 30 || sdkBuildSteps.length !== 1 || sdkBuildSteps[0].run !== sdkBuildCommand || sdkBuildSteps[0].env?.SDK_SOURCE_SHA !== "${{ github.sha }}") fail("SDK所有source変更はrequired CIで実WASM→pack→consumerを検証する必要があります");
  const candidate = workflow.jobs?.["photo-candidate"];
  const candidateSteps = candidate?.steps ?? [];
  const candidateBuild = candidateSteps.find((step) => step.name === "current SHAから完全Mac candidateを実build");
  const candidateEnv = {
    CANDIDATE_OUTPUT: "${{ runner.temp }}/photo-candidate",
    CANDIDATE_RUN_ATTEMPT: "${{ github.run_attempt }}",
    CANDIDATE_RUN_ID: "${{ github.run_id }}",
    CANDIDATE_SOURCE_SHA: "${{ github.sha }}",
    FIREBASE_CONFIG: "${{ runner.temp }}/photo-candidate-public-config.json",
    SDK_RELEASE_DIR: "${{ runner.temp }}/photo-candidate-sdk",
    SDK_RUNTIME_DIR: "${{ runner.temp }}/photo-candidate-runtime",
  };
  if (candidate?.name !== "Photo Mac candidate proof" || candidate?.if !== "needs.plan.outputs.photo-candidate == 'true'" || JSON.stringify(candidate?.needs) !== JSON.stringify(["plan", "publication"]) || candidate?.["runs-on"] !== "macos-26" || candidate?.["timeout-minutes"] !== 90 || candidate?.env?.CI !== "true" || candidateSteps.length !== 6 || candidateSteps.find((step) => step.name === "lock済みNode依存をoverlay前に準備")?.run !== "npm ci --ignore-scripts --no-audit --no-fund" || candidateSteps.find((step) => step.name === "candidate data fixtureを検証")?.run !== "node --test scripts/candidate/*.test.mjs" || candidateSteps.find((step) => step.name === "固定Rust/WASM toolchainを準備")?.run !== "rustup toolchain install 1.98.1 --profile minimal --target wasm32-unknown-unknown\ncargo +1.98.1 install wasm-bindgen-cli --version 0.2.129 --locked" || candidateBuild?.run !== candidateProofCommand || JSON.stringify(candidateBuild?.env) !== JSON.stringify(candidateEnv)) fail("Mac candidate proofはcurrent SHAの実WASM/SDK/native/Tauri buildとdata検証が必要です");
  const evidenceCondition = "matrix.scope == 'camera' && github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'niho-life/niho-photo'";
  const evidence = workflow.jobs?.native?.steps?.filter((step) => step.id === "release-evidence") ?? [];
  const uploads = Object.entries(workflow.jobs ?? {}).flatMap(([job, value]) => (value.steps ?? []).filter((step) => step.uses?.startsWith("actions/upload-artifact@")).map((step) => ({ job, step })));
  if (evidence.length !== 1 || evidence[0].if !== evidenceCondition || evidence[0].run !== "rustup toolchain install 1.98.1 --profile minimal\nnode scripts/ci/release-evidence.mjs" || evidence[0]["continue-on-error"]) fail("公開成果物生成はcamera/main pushの検証後だけ");
  const uploadInputs = { name: "${{ steps.release-evidence.outputs.name }}", path: "dist/release-evidence/", "if-no-files-found": "error", "retention-days": 30, "compression-level": 0, "include-hidden-files": false };
  if (uploads.length !== 1 || uploads[0].job !== "native" || uploads[0].step.id !== "upload-release-evidence" || uploads[0].step.if !== evidenceCondition || uploads[0].step["continue-on-error"] || JSON.stringify(uploads[0].step.with) !== JSON.stringify(uploadInputs)) fail("公開成果物は検査済みdirectoryだけを固定条件で保存する");
  const receipts = workflow.jobs?.native?.steps?.filter((step) => step.id === "release-artifact-receipt") ?? [];
  const receiptEnv = {
    RELEASE_ARTIFACT_ID: "${{ steps.upload-release-evidence.outputs.artifact-id }}",
    RELEASE_ARTIFACT_DIGEST: "${{ steps.upload-release-evidence.outputs.artifact-digest }}",
    RELEASE_ARTIFACT_NAME: "${{ steps.release-evidence.outputs.name }}",
  };
  if (receipts.length !== 1 || receipts[0].if !== evidenceCondition || receipts[0].run !== "node scripts/ci/write-artifact-receipt.mjs" || JSON.stringify(receipts[0].env) !== JSON.stringify(receiptEnv) || receipts[0]["continue-on-error"]) fail("Actions artifact ID/digestは検査後にjob summaryへ記録する");
  for (const job of Object.values(workflow.jobs ?? {})) {
    if (!["ubuntu-24.04", "macos-26"].includes(job["runs-on"])) fail("GitHub-hosted runnerのみ");
    if (job.environment || job.permissions || job.uses || job.container || job.services) fail("jobへの権限/環境/再利用workflow追加は禁止");
    // native（Client）は macos-26 で develop-engine が 16〜24 分かかり、試験が増えると 30 分を超える（#153 の後）
    const timeoutLimit = job === candidate ? 90 : job === workflow.jobs?.native ? 45 : 30;
    if (!Number.isInteger(job["timeout-minutes"]) || job["timeout-minutes"] > timeoutLimit) fail(`${timeoutLimit}分以内のtimeoutが必要`);
    let checkout = false;
    for (const step of job.steps ?? []) {
      if (step.uses) {
        const [name, pin, extra] = step.uses.split("@");
        if (extra || !/^[0-9a-f]{40}$/.test(pin ?? "") || actionPins.get(name) !== pin) fail("未検証/未固定Actionは禁止");
        if (name === "actions/checkout") {
          checkout = true;
          if (step.with?.["persist-credentials"] !== false || step.with?.token || step.with?.["ssh-key"]) fail("checkout認証情報の保持は禁止");
        }
      }
      if (step.run && /\$\{\{\s*github\.(?:event|head_ref|ref_name)/.test(step.run)) fail("PR入力のshell展開は禁止");
    }
    if (!checkout) fail("各jobに安全なcheckoutが必要");
  }
  return [...new Set(failures)];
}
