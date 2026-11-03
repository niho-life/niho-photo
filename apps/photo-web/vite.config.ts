import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const APP_DIR = fileURLToPath(new URL(".", import.meta.url));
const SHARED_PACKAGE_DIRS = ["../../packages/photo-editing", "../../packages/ui"].map((dir) =>
  fileURLToPath(new URL(dir, import.meta.url)),
);
const DEVELOP_ENGINE_WORKER = fileURLToPath(
  new URL("../../packages/photo-editing/src/develop-engine/develop-engine.worker.ts", import.meta.url),
);
const DEVELOP_ENGINE_EXPORT_WORKER = fileURLToPath(
  new URL("../../packages/photo-editing/src/develop-engine/develop-engine-export.worker.ts", import.meta.url),
);

export function sharedPackagePeerDependencies(): string[] {
  const names = new Set<string>();
  for (const dir of SHARED_PACKAGE_DIRS) {
    const manifest = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as {
      peerDependencies?: Record<string, string>;
    };
    for (const name of Object.keys(manifest.peerDependencies ?? {})) names.add(name);
  }
  return [...names].sort();
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: false,
  server: {
    host: "127.0.0.1",
    strictPort: true,
    fs: { allow: [APP_DIR, ...SHARED_PACKAGE_DIRS] },
  },
  resolve: {
    alias: [{ find: DEVELOP_ENGINE_WORKER, replacement: DEVELOP_ENGINE_EXPORT_WORKER }],
    dedupe: sharedPackagePeerDependencies(),
  },
  worker: {
    format: "es",
  },
  build: {
    target: "safari17",
    assetsInlineLimit: 0,
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: false,
  },
});
