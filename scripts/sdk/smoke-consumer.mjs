#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SdkReleaseError, verifyReleaseManifestFiles } from "./release-set-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new SdkReleaseError(`${name} に値が必要です`);
  return argv[index + 1];
}

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CI: "true", npm_config_cache: path.join(cwd, ".npm-cache"), npm_config_update_notifier: "false" },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new SdkReleaseError(`${command} consumer smoke に失敗しました${detail ? `\n${detail}` : ""}`);
  }
}

function linkDependency(consumer, dependency) {
  const source = path.join(repoRoot, "node_modules", ...dependency.split("/"));
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new SdkReleaseError(`consumer smoke dependency がありません: ${dependency}`);
  const target = path.join(consumer, "node_modules", ...dependency.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  if (!existsSync(target)) symlinkSync(source, target, "dir");
}

function outputFiles(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? outputFiles(path.join(root, entry.name), relative) : [relative];
  });
}

export function smokeConsumer(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = verifyReleaseManifestFiles(absoluteManifest);
  const releaseDirectory = path.dirname(absoluteManifest);
  const consumer = mkdtempSync(path.join(tmpdir(), "niho-photo-sdk-consumer-"));
  try {
    writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify({ name: "niho-photo-sdk-consumer-smoke", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`);
    const tarballs = manifest.packages.map((item) => path.join(releaseDirectory, item.file));
    run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--legacy-peer-deps", ...tarballs, path.join(repoRoot, "packages/ui")], consumer);
    for (const dependency of [
      "react",
      "react-dom",
      "@types/react",
      "@types/react-dom",
      "@types/node",
      "@tanstack/react-query",
      "lucide-react",
      "@radix-ui/react-dialog",
      "@radix-ui/react-popover",
      "clsx",
      "tailwind-merge",
      "vitest",
    ]) linkDependency(consumer, dependency);

    mkdirSync(path.join(consumer, "src"));
    writeFileSync(path.join(consumer, "src/main.tsx"), `
import { BrowserPhotoEditingWorkbench } from "niho-photo-editing/editor/browser-photo-editing-workbench";
import { PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME } from "niho-photo-editing/editor/photo-editing-button-classes";
import { createDevelopEngine } from "niho-photo-editing/develop-engine/develop-engine-client";
import type { DevelopSettings } from "niho-photo-editing/develop-engine/develop-settings";
import type { PhotoLibrary } from "niho-photo-editing/library/photo-library";
import { PhotoEditingDialogHost } from "niho-photo-editing/sdk-dialog-host";
import { readDevelopSettings, type DevelopSettings as NodeDevelopSettings } from "niho-photo-contract";
import "niho-photo-ui/styles/tokens.css";

const engine = createDevelopEngine();
const recipe: DevelopSettings = { v: 1, engine: "niho-13" };
const nodeRecipe: NodeDevelopSettings | null = readDevelopSettings(recipe);
const sdk = { BrowserPhotoEditingWorkbench, PhotoEditingDialogHost, engine, recipe, nodeRecipe, PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME };
document.body.dataset.sdkExports = Object.keys(sdk).sort().join(",");
export type PhotoLibraryContract = PhotoLibrary;
`);
    writeFileSync(path.join(consumer, "index.html"), '<!doctype html><html><body><script type="module" src="/src/main.tsx"></script></body></html>\n');
    writeFileSync(path.join(consumer, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node", "react", "react-dom", "react/experimental"],
      },
      include: ["src"],
    }, null, 2)}\n`);
    writeFileSync(path.join(consumer, "vite.config.mjs"), `export default { build: { outDir: "dist", emptyOutDir: true } };\n`);
    writeFileSync(path.join(consumer, "contract-smoke.mjs"), `
import assert from "node:assert/strict";
import {
  DEVELOP_SETTINGS_LOOKS,
  NIHO6_DEVELOP_SETTINGS_LOOKS,
  developSettingsEngineIdentifiers,
  developSettingsOnWorkingCopy,
  isEditableDevelopSettings,
  newDevelopSettingsEngine,
  neutralDevelopSettings,
  readDevelopSettings,
  signedWorkingCopyState,
  supportedDevelopSettingsVersions,
} from "niho-photo-contract";

assert.deepEqual([...supportedDevelopSettingsVersions], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.ok(developSettingsEngineIdentifiers.includes("niho-13"));
assert.ok(DEVELOP_SETTINGS_LOOKS.includes("niho-standard-1"));
assert.ok(NIHO6_DEVELOP_SETTINGS_LOOKS.includes("niho-interim-1"));
assert.equal(newDevelopSettingsEngine("raster.d1"), "niho-14");
assert.equal(neutralDevelopSettings("raster.d1").engine, "niho-14");
assert.equal(signedWorkingCopyState("raster.d1", null), "unsigned");
for (const v of supportedDevelopSettingsVersions) assert.ok(readDevelopSettings({ v, engine: "niho-1" }));
const unknown = { v: 1, engine: "niho-1", futureTopLevel: { keep: true } };
assert.deepEqual(readDevelopSettings(unknown), unknown);
for (const invalid of [
  { v: 10, engine: "niho-1" },
  { v: 4, engine: "niho-1", colorPoints: [{ id: "broken" }] },
  { v: 5, engine: "niho-1", masks: [{ id: "broken" }] },
  { v: 6, engine: "niho-1", detail: { sharpening: {} } },
  { v: 8, engine: "niho-1", heal: [{ id: "broken" }] },
  { v: 9, engine: "niho-1", lens: { unsupported: true } },
]) {
  assert.equal(readDevelopSettings(invalid), null);
  assert.equal(isEditableDevelopSettings(invalid), false);
}
const existing = developSettingsOnWorkingCopy({ v: 1, engine: "niho-1", futureTopLevel: 1 }, "raster.d1");
assert.equal(existing.engine, "niho-1");
assert.equal(existing.futureTopLevel, 1);
`);
    writeFileSync(path.join(consumer, "src/dialog-singleton.test.tsx"), `
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";

import { appDialog as mainAppDialog } from "niho-ui/app-dialog";
import { appDialog as sdkAppDialog } from "niho-photo-ui/app-dialog";
import { PhotoEditingDialogHost } from "niho-photo-editing/sdk-dialog-host";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("SDK dialog host uses the SDK UI store and not the app niho-ui store", async () => {
  expect(sdkAppDialog).not.toBe(mainAppDialog);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<PhotoEditingDialogHost container={container} />); });
  await expect(mainAppDialog.confirm({ title: "MAIN STORE", confirmLabel: "OK" })).rejects.toThrow(/not mounted/);
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = sdkAppDialog.confirm({ title: "SDK STORE", confirmLabel: "OK" });
  });
  expect(container.textContent).toContain("SDK STORE");
  expect(container.textContent).not.toContain("MAIN STORE");
  await act(async () => { root.unmount(); });
  await expect(pending).resolves.toBe(false);
  container.remove();
});
`);

    run(process.execPath, [path.join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", path.join(consumer, "tsconfig.json")], consumer);
    run(process.execPath, [path.join(repoRoot, "node_modules/vite/bin/vite.js"), "build", "--config", path.join(consumer, "vite.config.mjs")], consumer);
    run(process.execPath, [path.join(consumer, "contract-smoke.mjs")], consumer);
    run(process.execPath, [path.join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", "src/dialog-singleton.test.tsx", "--environment", "jsdom"], consumer);
    const files = outputFiles(path.join(consumer, "dist"));
    if (!files.some((file) => file.endsWith(".css"))) throw new SdkReleaseError("consumer bundle に UI CSS がありません");
    if (files.filter((file) => file.endsWith(".js")).length < 2) throw new SdkReleaseError("consumer bundle に develop-engine Worker chunk がありません");
    const photoPackage = JSON.parse(readFileSync(path.join(consumer, "node_modules/niho-photo-editing/package.json"), "utf8"));
    if (photoPackage.peerDependencies?.react === undefined || photoPackage.peerDependencies?.["niho-photo-ui"] !== manifest.version || photoPackage.dependencies?.react) throw new SdkReleaseError("React/UI singleton の peer dependency 契約が不正です");
    return { files, consumer };
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== "--manifest") throw new SdkReleaseError("使い方: smoke-consumer.mjs --manifest <release manifest>");
    const result = smokeConsumer(option(argv, "--manifest"));
    console.log(`repo 外 consumer smoke が通りました（${result.files.length} files）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "consumer smoke に失敗しました");
    process.exitCode = 1;
  }
}
