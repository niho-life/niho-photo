/**
 * Development only: the shared-album screens (B08 #249) on the synthetic server, before the real server and BFF exist.
 * Not part of the Photo Web build (`vite.config.ts` builds `index.html` only) and never served by the production host.
 *
 *   npm run dev:shared-albums            # http://127.0.0.1:5197/shared-albums.html
 */
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { sharedPackagePeerDependencies } from "../vite.config.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  root: HERE,
  plugins: [react(), tailwindcss()],
  publicDir: false,
  server: { host: "127.0.0.1", port: 5197, strictPort: true, fs: { allow: [REPO] } },
  preview: { host: "127.0.0.1", port: 5196, strictPort: true },
  resolve: { dedupe: [...sharedPackagePeerDependencies(), "@radix-ui/react-dialog", "@radix-ui/react-popover", "@tanstack/react-query"] },
  build: { outDir: fileURLToPath(new URL("../dist/dev-shared-albums", import.meta.url)), emptyOutDir: true, rollupOptions: { input: `${HERE}shared-albums.html` } },
});
