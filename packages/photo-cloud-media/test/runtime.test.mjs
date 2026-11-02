import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pins from "../contract-files.json" with { type: "json" };

test("altered package entry cannot execute while version and all compiled file hashes remain correct", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "photo-contract-entry-test-"));
  try {
    const official = new URL("./", import.meta.resolve("niho-photo-contract/package.json"));
    for (const file of pins.files) {
      const destination = join(fixture, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(fileURLToPath(new URL(file.path, official)), destination);
    }
    const metadata = JSON.parse(await readFile(new URL("package.json", official), "utf8"));
    metadata.exports["."] = "./unverified-entry.mjs";
    await writeFile(join(fixture, "package.json"), JSON.stringify(metadata));
    await writeFile(join(fixture, "unverified-entry.mjs"), "globalThis.executedUnverifiedContract = true; export const synthetic = true;\n");
    // Isolate module-cache and resolver hooks to this synthetic installation. Production has no loader hook.
    const script = `
      import { registerHooks } from 'node:module';
      import { pathToFileURL } from 'node:url';
      import { join } from 'node:path';
      const fixture = process.argv[2];
      const hooks = registerHooks({resolve(specifier, context, next) {
        if (specifier === 'niho-photo-contract/package.json') return {url:pathToFileURL(join(fixture,'package.json')).href,shortCircuit:true};
        if (specifier === 'niho-photo-contract') return {url:pathToFileURL(join(fixture,'unverified-entry.mjs')).href,shortCircuit:true};
        return next(specifier,context);
      }});
      try {
        const {loadVerifiedContract} = await import(process.argv[3]);
        try {
          await loadVerifiedContract();
          process.stdout.write(JSON.stringify({accepted:true,executed:globalThis.executedUnverifiedContract===true}));
        } catch (error) {
          process.stdout.write(JSON.stringify({accepted:false,executed:globalThis.executedUnverifiedContract===true,code:error.code}));
        }
      } finally { hooks.deregister(); }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-", fixture, new URL("../src/server/runtime.ts", import.meta.url).href], {
      input: script,
      encoding: "utf8",
      cwd: fixture,
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    assert.equal(child.status, 0, "isolated verifier must finish");
    assert.deepEqual(JSON.parse(child.stdout), { accepted: false, executed: false, code: "renderer_unavailable" });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
