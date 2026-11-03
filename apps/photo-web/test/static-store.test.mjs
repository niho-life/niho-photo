import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { preparePhotoStaticBundle } from "../src/build/static-bundle.ts";
import { loadPhotoWebStaticStore, PhotoWebStaticStoreError } from "../src/server/static-store.ts";

const resolveSdk = createRequire(new URL("../../../packages/photo-cloud-media/package.json", import.meta.url));
const SDK = path.dirname(path.dirname(path.dirname(resolveSdk.resolve("niho-photo-develop-engine-runtime/manifest"))));

let root;
let output;
let build;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function cloneBuild() {
  return structuredClone(build);
}

async function rejected(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof PhotoWebStaticStoreError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, "Photo web static store preparation failed");
    assert.equal(error.message.includes(root), false);
    return true;
  });
}

async function copiedOutput(name) {
  const target = path.join(root, name);
  await cp(output, target, { recursive: true });
  return target;
}

function target(directory, route) {
  return path.join(directory, ...(route === "/" ? ["index.html"] : route.slice(1).split("/")));
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "photo-web-store-"));
  const web = path.join(root, "web");
  await mkdir(path.join(web, "assets"), { recursive: true });
  await writeFile(path.join(web, "index.html"), "<!doctype html><html><body>photo</body></html>");
  await writeFile(path.join(web, "assets/app.js"), "globalThis.photoApp=true;");
  await writeFile(path.join(web, "assets/theme.css"), "body{color:#123}");
  output = path.join(root, "bundle");
  build = await preparePhotoStaticBundle({
    builtWebDirectory: web,
    outputDirectory: output,
    sdkPackageDirectory: SDK,
    offlineCopy: { title: "オフライン", message: "接続を確認してください。" },
    applicationCopy: { name: "NIHO photo", shortName: "Photo", description: "写真を編集する" },
  });
});

after(async () => {
  await chmod(root, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe("loadPhotoWebStaticStore", () => {
  it("loads actual builder bytes, filters caller metadata, and serves stable immutable blobs", async () => {
    const stableOutput = await copiedOutput("stable");
    const supplied = cloneBuild();
    supplied.privateUrl = "https://private.invalid";
    supplied.files[0].credential = "secret";
    const store = await loadPhotoWebStaticStore({ directory: stableOutput, build: supplied });
    assert.equal(Object.isFrozen(store), true);
    assert.equal(Object.isFrozen(store.build), true);
    assert.equal("privateUrl" in store.build, false);
    assert.equal("credential" in store.build.files[0], false);

    const descriptors = [
      { path: "/", sha256: build.document.sha256, sizeBytes: build.document.sizeBytes, cache: false },
      ...build.files.map((file) => ({ ...file, cache: true })),
      { ...build.worker, cache: false },
      { ...build.webManifest, cache: false },
    ];
    for (const descriptor of descriptors) {
      const response = store.get(descriptor.path);
      assert.ok(response);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(bytes.byteLength, descriptor.sizeBytes);
      assert.equal(digest(bytes), descriptor.sha256);
      assert.equal(response.headers.get("content-length"), String(descriptor.sizeBytes));
      assert.equal(response.headers.get("etag"), `"${descriptor.sha256}"`);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("cache-control"), descriptor.cache ? "public, max-age=31536000, immutable, no-transform" : "no-store");
      assert.equal(response.headers.has("set-cookie"), false);
      assert.equal(response.headers.has("vary"), false);
    }
    assert.equal(store.get("/photo-sw.js").headers.get("service-worker-allowed"), "/");
    const head = store.get("/", true);
    assert.equal(head.headers.get("content-length"), String(build.document.sizeBytes));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(store.get("/unknown"), null);

    const script = build.files.find((file) => file.path === "/assets/app.js");
    const before = new Uint8Array(await store.get(script.path).arrayBuffer());
    await writeFile(target(stableOutput, script.path), Buffer.alloc(script.sizeBytes, 0x78));
    assert.deepEqual(new Uint8Array(await store.get(script.path).arrayBuffer()), before);

    const metadata = await store.get("/photo-build.json").json();
    assert.deepEqual(metadata, build);
    assert.equal(JSON.stringify(metadata).includes("private.invalid"), false);
    assert.equal(store.get("/photo-build.json").headers.get("cache-control"), "no-store");
  });

  it("rejects missing or corrupt executable, WASM, worker, document, and metadata bytes", async (context) => {
    const cases = [
      ["script missing", (copy) => unlink(target(copy, "/assets/app.js"))],
      ["wasm corrupt", async (copy) => {
        const wasm = build.files.find((file) => file.path.endsWith(".wasm"));
        const bytes = await readFile(target(copy, wasm.path));
        bytes[0] ^= 0xff;
        await writeFile(target(copy, wasm.path), bytes);
      }],
      ["worker corrupt", async (copy) => {
        const bytes = await readFile(path.join(copy, "photo-sw.js"));
        bytes[0] ^= 0xff;
        await writeFile(path.join(copy, "photo-sw.js"), bytes);
      }],
      ["document corrupt", async (copy) => {
        const bytes = await readFile(path.join(copy, "index.html"));
        bytes[0] ^= 0xff;
        await writeFile(path.join(copy, "index.html"), bytes);
      }],
      ["metadata corrupt", (copy) => writeFile(path.join(copy, "photo-build.json"), "{}")],
      ["install manifest corrupt", (copy) => writeFile(path.join(copy, "manifest.webmanifest"), "{}")],
    ];
    for (const [name, mutate] of cases) {
      await context.test(name, async () => {
        const copy = await copiedOutput(`corrupt-${name.replaceAll(" ", "-")}`);
        await mutate(copy);
        await rejected(loadPhotoWebStaticStore({ directory: copy, build }), "invalid_artifact");
      });
    }
  });

  it("rejects symlinks and a FIFO without waiting for a writer", async () => {
    const linked = await copiedOutput("symlink");
    await unlink(target(linked, "/assets/app.js"));
    await symlink(path.join(linked, "index.html"), target(linked, "/assets/app.js"));
    await rejected(loadPhotoWebStaticStore({ directory: linked, build }), "invalid_artifact");

    const fifo = await copiedOutput("fifo");
    await unlink(target(fifo, "/assets/app.js"));
    assert.equal(spawnSync("mkfifo", [target(fifo, "/assets/app.js")], { stdio: "ignore" }).status, 0);
    const modulePath = fileURLToPath(new URL("../src/server/static-store.ts", import.meta.url));
    const probe = `import {pathToFileURL} from "node:url";
      const {loadPhotoWebStaticStore,PhotoWebStaticStoreError}=await import(pathToFileURL(process.argv[1]));
      try { await loadPhotoWebStaticStore({directory:process.argv[2],build:JSON.parse(process.argv[3])}); process.exit(2); }
      catch(error) { process.exit(error instanceof PhotoWebStaticStoreError && error.code==="invalid_artifact" ? 0 : 3); }`;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", probe,
      modulePath, fifo, JSON.stringify(build)], { timeout: 2_000, stdio: "ignore" });
    assert.equal(child.error?.code, undefined);
    assert.equal(child.status, 0);
  });

  it("rejects public budget excess, collisions, unsafe routes, and inconsistent PWA metadata before reads", async (context) => {
    await context.test("count budget", async () => {
      const candidate = cloneBuild();
      const seed = candidate.files.find((file) => file.path === "/assets/app.js");
      while (candidate.files.length < 126) candidate.files.push({ ...seed, path: `/assets/extra-${candidate.files.length}.js` });
      candidate.files.sort((left, right) => left.path.localeCompare(right.path, "en"));
      candidate.pwa.assets = candidate.files.filter((file) => file.kind !== "notice");
      await rejected(loadPhotoWebStaticStore({ directory: output, build: candidate }), "budget_exceeded");
    });
    await context.test("byte budget", async () => {
      const candidate = cloneBuild();
      const seed = candidate.files.find((file) => file.path === "/assets/app.js");
      for (let index = 0; index < 5; index += 1) {
        candidate.files.push({ ...seed, path: `/assets/huge-${index}.js`, sizeBytes: 8 * 1024 * 1024 });
      }
      candidate.files.sort((left, right) => left.path.localeCompare(right.path, "en"));
      candidate.pwa.assets = candidate.files.filter((file) => file.kind !== "notice");
      await rejected(loadPhotoWebStaticStore({ directory: output, build: candidate }), "budget_exceeded");
    });
    await context.test("collision", async () => {
      const candidate = cloneBuild();
      candidate.files.splice(1, 0, structuredClone(candidate.files[0]));
      await rejected(loadPhotoWebStaticStore({ directory: output, build: candidate }), "invalid_artifact");
    });
    for (const unsafe of [
      "/assets/%2e/app.js", "/assets\\app.js", "/assets/../app.js", "/assets/app.js?x", "/assets/app.js#x",
      "/assets//app.js", "/auth/session.js", "/api/app.js", "/photos/app.js", "/uploads/app.js",
    ]) {
      await context.test(unsafe, async () => {
        const candidate = cloneBuild();
        const index = candidate.files.findIndex((file) => file.path === "/assets/app.js");
        candidate.files[index].path = unsafe;
        const pwaIndex = candidate.pwa.assets.findIndex((file) => file.path === "/assets/app.js");
        if (pwaIndex >= 0) candidate.pwa.assets[pwaIndex].path = unsafe;
        await rejected(loadPhotoWebStaticStore({ directory: output, build: candidate }), "invalid_artifact");
      });
    }
    await context.test("build id mismatch", async () => {
      const candidate = cloneBuild();
      candidate.pwa.buildId = "0".repeat(64);
      await rejected(loadPhotoWebStaticStore({ directory: output, build: candidate }), "invalid_artifact");
    });
    await context.test("SDK manifest hash mismatch", async () => {
      const candidate = cloneBuild();
      const manifest = candidate.files.find((file) => file.path === candidate.sdk.manifestUrl);
      manifest.sha256 = "0".repeat(64);
      const pwaManifest = candidate.pwa.assets.find((file) => file.path === candidate.sdk.manifestUrl);
      if (pwaManifest !== manifest) pwaManifest.sha256 = "0".repeat(64);
      await rejected(loadPhotoWebStaticStore({ directory: output, build: candidate }), "invalid_artifact");
    });
  });
});
