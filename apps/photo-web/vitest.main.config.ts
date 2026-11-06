import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "jsdom", include: ["test/main-entry.test.ts", "test/browser-renderer.test.ts"] },
  resolve: { dedupe: ["react", "react-dom", "@tanstack/react-query", "niho-ui"] },
});
