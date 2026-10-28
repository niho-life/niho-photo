import { execFileSync } from "node:child_process";
import { appendFile, readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const scopes = {
  "photo-editing": { paths: ["packages/photo-editing/", "packages/niho-cloud-contract/", "packages/ui/"], root: "packages/photo-editing", runner: "ubuntu-24.04", kind: "npm", workspaces: ["packages/ui", "packages/photo-editing"] },
  camera: { paths: ["apps/camera/", "packages/desktop-account/", "packages/desktop-photo/", "packages/photo-editing/", "packages/ui/", "packages/develop-engine/"], root: "apps/camera", runner: "macos-14", kind: "npm", workspaces: ["apps/camera"], native: true },
  "desktop-photo": { paths: ["packages/desktop-photo/", "packages/desktop-account/", "packages/photo-editing/", "packages/ui/", "packages/develop-engine/"], root: "packages/desktop-photo", runner: "macos-14", kind: "native" },
  "desktop-account": { paths: ["packages/desktop-account/", "packages/ui/"], root: "packages/desktop-account", runner: "macos-14", kind: "hybrid", workspaces: ["packages/desktop-account/ts"] },
  // cutout-brush-parity.json は niho-camera-cutout の Swift 試験も読む（TS の筆との照合）
  "develop-engine": { paths: ["packages/develop-engine/", "packages/photo-editing/src/fixtures/cutout-brush-parity.json"], root: "packages/develop-engine", runner: "macos-14", kind: "native", swift: true },
};

const photoSdkPrefixes = ["packages/photo-editing/", "packages/ui/", "packages/niho-cloud-contract/", "packages/develop-engine/", "packages/desktop-photo/", "sdk/", "scripts/sdk/"];
const photoSdkFiles = new Set(["package.json", "package-lock.json", "LICENSE.md", "ASSET_LICENSE.md", "TRADEMARKS.md", "THIRD_PARTY_NOTICES.md"]);
const photoCandidatePrefixes = ["apps/camera/", "packages/photo-editing/", "packages/ui/", "packages/niho-cloud-contract/", "packages/develop-engine/", "packages/desktop-photo/", "packages/desktop-account/", "sdk/", "scripts/sdk/", "scripts/candidate/"];
const photoCandidateFiles = new Set(["package.json", "package-lock.json", "LICENSE.md", "ASSET_LICENSE.md", "TRADEMARKS.md", "THIRD_PARTY_NOTICES.md"]);

export function selectPhotoSdk(changed) {
  return changed.some((name) => photoSdkFiles.has(name) || photoSdkPrefixes.some((prefix) => name.startsWith(prefix)) || /^\.github\/workflows\/(?:public-ci|photo-sdk-release)\.yml$/u.test(name) || /^scripts\/ci\/(?:aggregate|scopes|workflow|photo-sdk-workflow)(?:-lib)?(?:\.test)?\.mjs$/u.test(name));
}

export function selectPhotoCandidate(changed) {
  return changed.some((name) => photoCandidateFiles.has(name) || photoCandidatePrefixes.some((prefix) => name.startsWith(prefix)) || /^\.github\/workflows\/(?:public-ci|photo-sdk-release|photo-candidate-release)\.yml$/u.test(name) || /^scripts\/ci\/(?:aggregate|scopes|workflow|photo-candidate-workflow|publication|release-evidence)(?:-lib)?(?:\.test)?\.mjs$/u.test(name));
}

export function selectScopes(changed, present, mainPush = false) {
  const all = changed.some((name) => /^(?:\.github\/|scripts\/|docs\/(?:security|legal|ci|contracts)\/)/.test(name) || /^(?:package(?:-lock)?\.json|\.node-version|\.nvmrc)$/.test(name));
  return Object.entries(scopes).map(([scope, config]) => ({ scope, runner: config.runner, swift: config.swift === true, present: present.includes(config.root), selected: (mainPush && scope === "camera") || all || changed.some((name) => config.paths.some((prefix) => name.startsWith(prefix))) }));
}

export function changedFiles(root, eventName, event, head = "HEAD") {
  const base = eventName === "pull_request" ? event.pull_request?.base?.sha : eventName === "push" ? event.before : undefined;
  if (!base || /^0+$/.test(base)) return [".github/workflows/public-ci.yml"];
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("比較元commitが不正です");
  // branch名やPRタイトルはコマンドへ渡さない。引数配列とcommit SHAだけを使用する。
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, head, "--"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}

export async function plan(root, eventName, event, changed = changedFiles(root, eventName, event)) {
  const present = [];
  for (const config of Object.values(scopes)) {
    try { await access(path.join(root, config.root)); present.push(config.root); } catch { /* 未導入を明示する */ }
  }
  return selectScopes(changed, present, eventName === "push");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    const changed = changedFiles(root, process.env.GITHUB_EVENT_NAME, event);
    const result = await plan(root, process.env.GITHUB_EVENT_NAME, event, changed);
    for (const item of result) console.log(`${item.scope}: ${item.present ? item.selected ? "実行" : "変更なし" : "未導入（追加時に自動有効）"}`);
    const include = result.filter((item) => item.scope !== "photo-editing" && item.present && item.selected).map(({ scope }) => ({ scope }));
    // 空matrixもvalidな値にし、job自体はhas-workでskipする。
    const matrix = { include: include.length ? include : [{ scope: "camera" }] };
    await appendFile(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\nhas-native=${include.length > 0}\nhas-swift=${result.some((item) => item.swift && item.present && item.selected)}\nphoto-editing=${result.some((item) => item.scope === "photo-editing" && item.present && item.selected)}\nphoto-sdk=${selectPhotoSdk(changed)}\nphoto-candidate=${selectPhotoCandidate(changed)}\n`);
  } catch {
    console.error("変更範囲の判定に失敗しました（入力値は非表示）");
    process.exitCode = 1;
  }
}
