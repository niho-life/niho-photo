import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/session-client.test.ts"],
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
});
