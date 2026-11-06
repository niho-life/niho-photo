import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import engineBaseline from "../../packages/photo-cloud-media/sdk-baseline.json" with { type: "json" };
import buildBaseline from "./src/build/build-baseline.json" with { type: "json" };

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

function compileProof(): Readonly<Record<string, string>> {
  const runtime = engineBaseline.engine;
  if (engineBaseline.sourceCommit !== buildBaseline.sourceCommit
    || engineBaseline.releaseTag !== `photo-sdk-v${buildBaseline.sdkVersion}`
    || typeof runtime.crateVersion !== "string" || typeof runtime.manifest?.sha256 !== "string") {
    throw new Error("Photo Web SDK baseline is inconsistent");
  }
  return Object.freeze({
    __PHOTO_WEB_SDK_VERSION__: buildBaseline.sdkVersion,
    __PHOTO_WEB_CRATE_VERSION__: runtime.crateVersion,
    __PHOTO_WEB_RUNTIME_MANIFEST_SHA256__: runtime.manifest.sha256,
    __PHOTO_WEB_SOURCE_COMMIT__: buildBaseline.sourceCommit,
    __PHOTO_WEB_MANIFEST_URL__: `/develop-engine/${runtime.manifest.sha256}/manifest-${runtime.crateVersion}.json`,
  });
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: Object.fromEntries(Object.entries(compileProof()).map(([key, value]) => [key, JSON.stringify(value)])),
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
