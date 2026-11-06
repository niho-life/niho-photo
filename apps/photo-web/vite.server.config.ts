import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const APP_DIR = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: APP_DIR,
  ssr: { noExternal: true },
  build: {
    ssr: "src/server/entry.ts",
    target: "node24",
    outDir: "dist/server",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
  },
});
