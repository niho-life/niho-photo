import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { artifactName, buildEnvironment, contractFiles, createManifest, createSbom, guardBundle, jsonBytes, lockfilePattern, lockfiles, validateManifest, assertPublicBytes, workflowArtifactName } from "./release-evidence-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
let stage = "context/clean checkout";
let isolatedRoot;
try {
  const commit = process.env.GITHUB_SHA;
  const name = artifactName(commit, process.arch);
  if (process.platform !== "darwin" || process.env.GITHUB_REPOSITORY !== "niho-life/niho-photo" || process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== "refs/heads/main" || !/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? "") || !/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")) throw new Error("公開main push専用です");
  if (run("git", ["rev-parse", "HEAD"]).trim() !== commit || run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim()) throw new Error("exact SHAのclean checkoutが必要です");
  const committedLocks = run("git", ["ls-files", "-z"]).split("\0").filter((file) => lockfilePattern.test(file)).sort();
  if (JSON.stringify(committedLocks) !== JSON.stringify(lockfiles)) throw new Error("全lockfileの収録範囲を更新してください");
  stage = "toolchain/contract/lockfile";
  isolatedRoot = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "niho-photo-public-build-"));
  const isolatedHome = path.join(isolatedRoot, "home"), cargoHome = path.join(isolatedRoot, "cargo"), npmUserConfig = path.join(isolatedRoot, "npm-user.npmrc"), npmGlobalConfig = path.join(isolatedRoot, "npm-global.npmrc");
  await Promise.all([mkdir(isolatedHome), mkdir(cargoHome), writeFile(npmUserConfig, ""), writeFile(npmGlobalConfig, "")]);
  const env = buildEnvironment(process.env, root, { home: isolatedHome, cargoHome, tmpdir: isolatedRoot, npmUserConfig, npmGlobalConfig });
  const tool = (command, args) => run(command, args, { env }).trim();
  const tools = { node: process.version, npm: tool("npm", ["--version"]), rustc: tool("rustc", ["--version"]), cargo: tool("cargo", ["--version"]), xcode: tool("xcodebuild", ["-version"]), tauri: JSON.parse(await readFile(path.join(root, "node_modules/@tauri-apps/cli/package.json"), "utf8")).version };
  const contracts = Object.fromEntries(await Promise.all(contractFiles.map(async (file) => [file, await readFile(path.join(root, file))])));
  const locks = Object.fromEntries(await Promise.all(lockfiles.map(async (file) => [file, await readFile(path.join(root, file))])));
  const sbom = jsonBytes(createSbom(commit, locks));
  // npm lifecycle PATHだけをnpmに設定させ、ビルド自身が署名/認証等の環境を再度allowlistする。
  stage = "release build";
  run("npm", ["run", "build:evidence", "--workspace", "apps/camera"], { env, stdio: ["ignore", "ignore", "ignore"] });
  stage = "app公開guard/ad-hoc署名";
  const app = path.join(root, "apps/camera/src-tauri/target/release/bundle/macos/NIHO photo.app");
  const forbiddenRoots = [root, process.env.HOME, env.HOME, process.env.CARGO_HOME, env.CARGO_HOME, process.env.TMPDIR, env.TMPDIR, process.env.RUNNER_TEMP, process.env.GITHUB_WORKSPACE];
  const checkedFiles = await guardBundle(app, forbiddenRoots);
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const { spawnSync } = await import("node:child_process");
  const inspected = spawnSync("codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
  if (inspected.status !== 0 || !/^Signature=adhoc$/m.test(inspected.stderr) || /^TeamIdentifier=(?!not set$).+/m.test(inspected.stderr)) throw new Error("ad-hoc署名が必要です");
  stage = "archive/manifest/SBOM";
  const output = path.join(root, "dist/release-evidence");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("成果物の出力先は空である必要があります");
  const artifact = `${name}.zip`;
  run("ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noacl", "--keepParent", app, path.join(output, artifact)]);
  const packaged = await readFile(path.join(output, artifact));
  const manifest = createManifest({ commit, tree: run("git", ["rev-parse", `${commit}^{tree}`]).trim(), arch: process.arch, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, tools, locks, contracts, artifactBytes: packaged, sbomBytes: sbom, checkedFiles });
  const schema = JSON.parse(await readFile(path.join(root, "docs/releases/manifest-v1.schema.json"), "utf8"));
  validateManifest(manifest, schema);
  assertPublicBytes(sbom, forbiddenRoots);
  await writeFile(path.join(output, `${name}.cdx.json`), sbom);
  await writeFile(path.join(output, `${name}.manifest.json`), jsonBytes(manifest));
  // ビルド中のlockfile/追跡ソース変化を成功にしない。
  stage = "build後clean checkout";
  if (run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim()) throw new Error("ビルドが公開ソースを変更しました");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `name=${workflowArtifactName(commit, process.arch, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT)}\n`);
  console.log(`公開検証成果物を生成しました（${checkedFiles} app files検査済み）`);
} catch {
  // 子プロセスのstdout/stderrは絶対pathや検出値を含み得る。evidenceにもエラーにも転記しない。
  console.error(`公開検証成果物の生成を停止しました: ${stage}（値は非表示）`);
  process.exitCode = 1;
} finally {
  if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true });
}
