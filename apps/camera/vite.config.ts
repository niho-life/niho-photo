import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// NIHO photo の画面（Tauri の frontendDist）。tauri dev は devUrl（http://localhost:1430）を、tauri build は dist/ を読む。
//
// 共有の package（packages/photo-editing = niho-photo-editing・packages/ui = niho-ui）はソースのまま読む（exports が src/*.ts）。
// package の npm の依存は各 package.json の peerDependencies に書いてあり、camera の中では apps/camera/node_modules の実体を読む
// 公開移植前の内部構成については docs/migration/mac-client.md を参照。
// package の外のファイル（../../packages/*）から import しても camera の 1 つになるよう、peerDependencies を全部 dedupe する
// （二重の React はフックを壊す）。
const SHARED_PACKAGE_DIRS = ["../../packages/photo-editing", "../../packages/ui", "../../packages/desktop-account/ts"].map((dir) =>
  fileURLToPath(new URL(dir, import.meta.url)),
);

/** 共有の package の peerDependencies（名前順・重複なし）。 */
export function sharedPackagePeerDependencies(): string[] {
  const names = new Set<string>();
  for (const dir of SHARED_PACKAGE_DIRS) {
    const manifest = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { peerDependencies?: Record<string, string> };
    for (const name of Object.keys(manifest.peerDependencies ?? {})) names.add(name);
  }
  return [...names].sort();
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    // dev server が共有の package のソースを配れるようにする（apps/camera の外）
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url)), ...SHARED_PACKAGE_DIRS] },
  },
  resolve: {
    dedupe: sharedPackagePeerDependencies(),
  },
  // 現像の Worker（packages/photo-editing の develop-engine.worker.ts）は module worker で、ほかのファイルを import する
  worker: {
    format: "es",
  },
  build: {
    // 最低 macOS 14（tauri.conf.json の minimumSystemVersion）の WKWebView = Safari 17
    target: "safari17",
    outDir: "dist",
    emptyOutDir: true,
    // 画面は .app の中から読む（通信しない）ので、1 つの bundle の大きさで読み込みは遅くならない
    chunkSizeWarningLimit: 2048,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
  },
});
