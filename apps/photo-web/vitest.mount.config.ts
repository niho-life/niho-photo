import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/browser-mount.test.tsx", "test/browser-renderer.test.ts"],
    environmentOptions: { jsdom: { url: "https://photo.niho.life/" } },
  },
  resolve: {
    dedupe: ["react", "react-dom", "@tanstack/react-query", "niho-ui"],
  },
});
