import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "vite";
import configuration from "../vite.config.ts";

// Compile the real mount + complete shared style pipeline without starting an app/server or writing output.
test("browser build keeps shared styles and the stateless export worker, without native or server modules", { timeout: 30_000 }, async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const entryId = "photo-web-test-entry";
  const virtualId = "\0" + entryId;
  const graphs = { main: [], worker: [] };
  const collect = (name) => ({
    name: "photo-web-test-graph-" + name,
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === "chunk") graphs[name].push(...Object.keys(chunk.modules));
      }
    },
  });
  const output = await build({
    ...configuration,
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      ...configuration.plugins,
      {
        name: "photo-web-test-entry",
        resolveId(id) { if (id === entryId) return virtualId; },
        load(id) {
          if (id !== virtualId) return null;
          // The emitted fixture is never executed or distributed; retaining the factory exercises its whole graph.
          return `import {mountPhotoWeb} from ${JSON.stringify(root + "src/browser/mount.tsx")};
`
            + `import ${JSON.stringify(root + "src/styles.css")};
`
            + `import {PHOTO_WEB_VIEW_COPY} from ${JSON.stringify(root + "src/copy.ts")};\n`
            + "globalThis.__photoWebCompileFixture = {mountPhotoWeb, copy:PHOTO_WEB_VIEW_COPY};";
        },
      },
      collect("main"),
    ],
    worker: { ...configuration.worker, plugins: () => [collect("worker")] },
    build: { ...configuration.build, write: false, rolldownOptions: { input: entryId } },
  });
  const files = (Array.isArray(output) ? output : [output]).flatMap((result) => result.output);
  const ids = [...graphs.main, ...graphs.worker].map((id) => id.replaceAll("\\", "/"));
  const forbidden = /@tauri-apps|(?:^|\/)node:|__vite-browser-external|\/(?:browser|native)-analysis-store[./]|\/native-glue[./]|\/desktop-account\/|\/apps\/camera\/|\/photo-web\/src\/(?:server|build)\//;
  const appRoot = root.replaceAll("\\", "/");
  assert.deepEqual(ids.filter((id) => forbidden.test(id)
    || id.startsWith(appRoot + "src/server/") || id.startsWith(appRoot + "src/build/")
    || id.includes("/photo-cloud-session/src/server/")), []);
  assert.ok(graphs.main.some((id) => id.endsWith("/editor/browser-photo-editing-workbench.tsx")));
  assert.ok(graphs.worker.some((id) => id.endsWith("/develop-engine-export.worker.ts")));
  assert.equal(graphs.worker.some((id) => id.endsWith("/develop-engine.worker.ts")), false);
  const css = files.filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
    .map((item) => typeof item.source === "string" ? item.source : Buffer.from(item.source).toString("utf8")).join("\n");
  assert.match(css, /--photo-editing-surface\s*:/);
  assert.match(css, /font-size:106\.25%/);
  assert.match(css, /\.flex\s*\{[^}]*display:flex/);
  assert.ok(files.some((item) => item.type === "asset" && item.fileName.endsWith(".woff2")));
});
