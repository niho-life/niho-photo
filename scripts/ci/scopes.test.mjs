import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scopes, selectPhotoCandidate, selectPhotoSdk, selectScopes, changedFiles } from "./scopes.mjs";
import { scopeCommands } from "./run-scope.mjs";
const all = Object.values(scopes).map((s) => s.root);
const selected = (files, present = all) => selectScopes(files, present).filter((s) => s.selected && s.present).map((s) => s.scope);

test("文書変更でもpublicationはworkflow側で常時実行、package実行だけ省略", () => {
  assert.deepEqual(selected(["README.md"]), []);
  assert.deepEqual(selected(["packages/ui/src/cn.ts"]), ["photo-editing", "camera", "desktop-photo", "desktop-account"]);
  assert.deepEqual(selected(["packages/niho-cloud-contract/src/v1.ts"]), ["photo-editing"]);
  assert.deepEqual(selected(["packages/develop-engine/core.rs"]), ["camera", "desktop-photo", "develop-engine"]);
  assert.equal(selectScopes(["packages/develop-engine/core.rs"], all).find((s) => s.scope === "develop-engine").swift, true);
  assert.deepEqual(selected(["apps/camera/src-tauri/main.rs"]), ["camera"]);
  assert.deepEqual(selected(["packages/desktop-account/login.ts"]), ["camera", "desktop-photo", "desktop-account"]);
  for (const name of [".github/workflows/public-ci.yml", "scripts/ci/scopes.mjs", "package-lock.json", "docs/security/publication-manifest.json"]) assert.equal(selected([name]).length, 5);
});

test("SDK実buildは所有sourceと生成器だけを選択する", () => {
  for (const name of ["packages/photo-editing/src/index.ts", "packages/ui/src/cn.ts", "packages/niho-cloud-contract/src/v1.ts", "packages/develop-engine/Cargo.toml", "packages/desktop-photo/Cargo.toml", "sdk/release-set.json", "scripts/sdk/release-set-lib.mjs", "package.json", "package-lock.json", "LICENSE.md", ".github/workflows/photo-sdk-release.yml"]) assert.equal(selectPhotoSdk([name]), true, name);
  for (const name of ["apps/camera/src/main.ts", "packages/desktop-account/Cargo.toml", "README.md"]) assert.equal(selectPhotoSdk([name]), false, name);
});

test("Mac candidate proofはapp・SDK所有source・account・builder契約だけを選択する", () => {
  for (const name of ["apps/camera/src/main.ts", "packages/photo-editing/src/index.ts", "packages/ui/src/cn.ts", "packages/niho-cloud-contract/src/v1.ts", "packages/develop-engine/build-macos-native.mjs", "packages/desktop-photo/Cargo.toml", "packages/desktop-account/Cargo.toml", "sdk/release-set.json", "scripts/sdk/release-set-lib.mjs", "scripts/candidate/mac-candidate-lib.mjs", "package.json", "package-lock.json", "LICENSE.md", ".github/workflows/photo-candidate-release.yml", ".github/workflows/photo-sdk-release.yml", "scripts/ci/photo-candidate-workflow-lib.mjs", "scripts/ci/release-evidence-lib.mjs"]) assert.equal(selectPhotoCandidate([name]), true, name);
  for (const name of ["README.md", "docs/ci/public-ci.md", "docs/security/publication-gates.md"]) assert.equal(selectPhotoCandidate([name]), false, name);
});

test("未導入scopeを成功したテストと扱わず、ディレクトリ導入時に自動で選択", () => {
  const result = selectScopes([".github/workflows/public-ci.yml"], ["packages/photo-editing"]);
  assert.equal(result.filter((s) => s.present).length, 1);
  assert.equal(result.find((s) => s.scope === "camera").present, false);
  assert.deepEqual(selected(["apps/camera/package.json"], ["apps/camera"]), ["camera"]);
});

test("比較元にbranch/PR入力を受け付けない", () => {
  assert.throws(() => changedFiles("/tmp", "pull_request", { pull_request: { base: { sha: "main; touch unsafe" } } }), /commit/);
  assert.deepEqual(changedFiles("/tmp", "push", { before: "0".repeat(40) }), [".github/workflows/public-ci.yml"]);
});

test("native導入後はmetadata不足を拒否、公開標準コマンドだけを生成", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "photo-scopes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, value) => { const full = path.join(root, name); await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, typeof value === "string" ? value : JSON.stringify(value)); };
  await put("packages/develop-engine/Cargo.toml", "[workspace]\n");
  await assert.rejects(() => scopeCommands(root, "develop-engine"));
  await put("packages/develop-engine/public-ci.json", { schemaVersion: 1, syntheticFixtures: true, unsigned: true, cargoManifests: ["Cargo.toml"], swiftPackages: [] });
  await put("packages/develop-engine/Cargo.lock", "");
  await put("packages/develop-engine/LICENSES.md", "公開依存ライセンスを記録。\n");
  assert.deepEqual((await scopeCommands(root, "develop-engine")).map(([command, args]) => [command, args[0]]), [["cargo", "fmt"], ["cargo", "clippy"], ["cargo", "test"]]);
  await put("packages/develop-engine/public-ci.json", { schemaVersion: 1, syntheticFixtures: true, unsigned: true, cargoManifests: ["../private/Cargo.toml"], swiftPackages: [] });
  await assert.rejects(() => scopeCommands(root, "develop-engine"), /パス/);
});

test("npm scopeの必須script欠落を成功扱いにしない", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "photo-npm-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "apps/camera"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: ["apps/camera"] }));
  await writeFile(path.join(root, "apps/camera/package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }));
  await assert.rejects(() => scopeCommands(root, "camera"), /script test/);
});

test("desktop-accountはTSとRustの両方を検査する", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "photo-account-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, value) => {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, typeof value === "string" ? value : JSON.stringify(value));
  };
  await put("package.json", { workspaces: ["packages/desktop-account/ts"] });
  await put("packages/desktop-account/ts/package.json", { scripts: { typecheck: "tsc", test: "vitest", lint: "eslint" } });
  await put("packages/desktop-account/public-ci.json", { schemaVersion: 1, syntheticFixtures: true, unsigned: true, cargoManifests: ["Cargo.toml"], swiftPackages: [] });
  await put("packages/desktop-account/Cargo.toml", "[package]\nname = \"niho-desktop-account\"\n");
  await put("packages/desktop-account/Cargo.lock", "");
  await put("packages/desktop-account/LICENSES.md", "公開依存ライセンスを記録。\n");
  assert.deepEqual((await scopeCommands(root, "desktop-account")).map(([command, args]) => [command, args[0]]), [
    ["npm", "run"], ["npm", "run"], ["npm", "run"], ["cargo", "fmt"], ["cargo", "clippy"], ["cargo", "test"],
  ]);
});

test("aggregateは想定外skip、失敗、取消を拒否する", () => {
  const needs = Object.fromEntries(["plan", "publication", "secrets", "dependencies", "photo-editing", "photo-sdk", "photo-candidate", "native", "swift"].map((name) => [name, { result: "success" }]));
  needs.plan.outputs = { "photo-editing": "true", "photo-sdk": "true", "photo-candidate": "true", "has-native": "true", "has-swift": "true" };
  const script = fileURLToPath(new URL("./aggregate.mjs", import.meta.url));
  const run = () => spawnSync(process.execPath, [script], { env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", CI_NEEDS: JSON.stringify(needs) }, encoding: "utf8" }).status;
  assert.equal(run(), 0);
  for (const result of ["skipped", "failure", "cancelled"]) { needs.native.result = result; assert.equal(run(), 1); }
  needs.native.result = "skipped";
  needs.plan.outputs["has-native"] = "false";
  needs.swift.result = "failure";
  assert.equal(run(), 1);
  needs.swift.result = "skipped";
  needs.plan.outputs["has-swift"] = "false";
  needs["photo-sdk"].result = "skipped";
  needs.plan.outputs["photo-sdk"] = "false";
  needs["photo-candidate"].result = "skipped";
  needs.plan.outputs["photo-candidate"] = "false";
  assert.equal(run(), 0);
});

test("現像の公開CIは固定toolchain・実RAW・fit再生成・WASM parityまで含む", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const commands = await scopeCommands(root, "develop-engine");
  assert.ok(commands.some(([command,args]) => command === "rustup" && args.includes("1.98.1")));
  assert.ok(commands.some(([command,args]) => command === "python3" && args.includes("packages/develop-engine/tools/independent-profile/check.py")));
  assert.ok(commands.some(([command,args]) => command === "python3" && args.includes("test_teacher_render_cache.py")));
  assert.ok(commands.some(([command,args]) => command === "cargo" && args.includes("build") && args.includes("wasm32-unknown-unknown")));
  assert.ok(commands.some(([command,args]) => command === "cargo" && args.includes("test") && args.includes("niho7_cross_target")));
  assert.ok(commands.some(([command,args]) => command === "cargo" && args.includes("test") && args.includes("color_points")));
  assert.ok(commands.some(([command,args]) => command === "cargo" && args.includes("test") && args.includes("geometry_perspective")));
  assert.ok(commands.some(([command,args]) => command === "cargo" && args.includes("test") && args.includes("detail_cross_target")));
  for (const test of ["masks_settings", "masks_geometry_map", "masks_cross_target", "api_cross_target", "upright", "heal", "lens"]) {
    assert.ok(commands.some(([command,args]) => command === "cargo" && args.includes("wasm32-unknown-unknown") && args.includes("test") && args.includes(test)), test);
  }  assert.equal(commands.some(([command]) => command === "swift"), false, "SwiftはmacOS 26の専用jobで実行する");
});

test("main pushは文書だけでもexact SHAのcamera公開成果物を生成する", () => {
  const result = selectScopes(["README.md"], all, true).filter((scope) => scope.selected);
  assert.deepEqual(result.map((scope) => scope.scope), ["camera"]);
});
