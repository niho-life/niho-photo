#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SdkReleaseError, verifyReleaseManifestFiles } from "./release-set-lib.mjs";

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new SdkReleaseError(`${name} に値が必要です`);
  return argv[index + 1];
}

function installRuntimePackages(consumer, tarballs) {
  try {
    execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--legacy-peer-deps", ...tarballs], {
      cwd: consumer,
      encoding: "utf8",
      env: { ...process.env, CI: "true", npm_config_update_notifier: "false" },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new SdkReleaseError(`実engine smoke用package installに失敗しました${detail ? `\n${detail}` : ""}`);
  }
}

export async function smokeRealEngine(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = verifyReleaseManifestFiles(absoluteManifest);
  const releaseDirectory = path.dirname(absoluteManifest);
  const packageById = new Map(manifest.packages.map((item) => [item.id, item]));
  const contract = packageById.get("photo-contract");
  const runtime = packageById.get("develop-engine-runtime");
  if (!contract || !runtime) throw new SdkReleaseError("実engine smokeに必要なpackageがありません");
  const consumer = mkdtempSync(path.join(tmpdir(), "niho-photo-real-engine-smoke-"));
  try {
    writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify({ name: "niho-photo-real-engine-smoke", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`);
    installRuntimePackages(consumer, [contract, runtime].map(({ file }) => path.join(releaseDirectory, file)));

    const runtimeRoot = path.join(consumer, "node_modules", runtime.name, "develop-engine", manifest.engine.version);
    const runtimeJs = manifest.engine.runtimeFiles.find(({ name }) => name.endsWith(".js") && !name.endsWith(".d.ts"));
    const runtimeWasm = manifest.engine.runtimeFiles.find(({ name }) => name.endsWith(".wasm"));
    if (!runtimeJs || !runtimeWasm) throw new SdkReleaseError("実engine smoke用WASM closureが不足しています");
    const glue = await import(pathToFileURL(path.join(runtimeRoot, runtimeJs.name)).href);
    if (typeof glue.initSync !== "function" || typeof glue.version !== "function" || typeof glue.validateSettings !== "function" || typeof glue.neutralSettings !== "function") throw new SdkReleaseError("実engineの必須exportがありません");
    glue.initSync({ module: readFileSync(path.join(runtimeRoot, runtimeWasm.name)) });
    assert.equal(glue.version(), `niho-develop ${manifest.engine.crateVersion} (engine ${manifest.engine.version})`);

    const contractModule = await import(pathToFileURL(path.join(consumer, "node_modules", contract.name, "dist/index.js")).href);
    if (typeof contractModule.neutralDevelopSettings !== "function") throw new SdkReleaseError("Node recipe契約のneutralDevelopSettingsがありません");
    const settings = contractModule.neutralDevelopSettings(null);
    const issues = JSON.parse(glue.validateSettings(JSON.stringify(settings)));
    assert.deepEqual(issues, []);

    // スレッドの版（#151）: 平らに置いた glue が helper を版つきの名前で読み、共有メモリで 1 本のまま動く（pool は起こさない）。
    const threadsFiles = manifest.engine.threads?.runtimeFiles;
    if (threadsFiles) {
      const threadsJs = threadsFiles.find(({ name }) => /^niho_develop_wasm_threads-.+\.js$/u.test(name));
      const threadsWasm = threadsFiles.find(({ name }) => name.endsWith(".wasm"));
      if (!threadsJs || !threadsWasm) throw new SdkReleaseError("実engine smoke用のスレッドのWASM closureが不足しています");
      // helper は Worker の中で message を待つ（self）。Node には self が無いので、読むだけのために置く。
      globalThis.self ??= new EventTarget();
      const threadsGlue = await import(pathToFileURL(path.join(runtimeRoot, threadsJs.name)).href);
      if (typeof threadsGlue.initSync !== "function" || typeof threadsGlue.initThreadPool !== "function" || typeof threadsGlue.version !== "function" || typeof threadsGlue.validateSettings !== "function") throw new SdkReleaseError("スレッドの実engineの必須exportがありません");
      const exports = threadsGlue.initSync({ module: readFileSync(path.join(runtimeRoot, threadsWasm.name)) });
      if (!(exports.memory.buffer instanceof SharedArrayBuffer)) throw new SdkReleaseError("スレッドの実engineが共有メモリではありません");
      assert.equal(threadsGlue.version(), glue.version());
      assert.deepEqual(JSON.parse(threadsGlue.validateSettings(JSON.stringify(settings))), []);
    }
    return { engine: manifest.engine.version, crateVersion: manifest.engine.crateVersion, threads: Boolean(threadsFiles) };
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== "--manifest") throw new SdkReleaseError("使い方: smoke-real-engine.mjs --manifest <release manifest>");
    const result = await smokeRealEngine(option(argv, "--manifest"));
    console.log(`実WASMとNode recipe契約を検証しました（${result.engine} / ${result.crateVersion}${result.threads ? "・スレッドの版" : ""}）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "実WASM smokeに失敗しました");
    process.exitCode = 1;
  }
}
