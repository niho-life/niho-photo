import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as defer } from "node:timers/promises";
import { describe, it } from "node:test";
import vm from "node:vm";
import { PhotoStaticBuildError, preparePhotoStaticBundle } from "../src/build/static-bundle.ts";

const resolveSdk = createRequire(new URL("../../../packages/photo-cloud-media/package.json", import.meta.url));
const SDK = path.dirname(path.dirname(path.dirname(resolveSdk.resolve("niho-photo-develop-engine-runtime/manifest"))));
const ENGINE_MANIFEST = "develop-engine/niho-14/manifest-0.27.0.json";
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporary(context, prefix = "photo-static-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function webFixture(root, assets = [
  ["app.js", "globalThis.photoApp=true;"],
  ["theme.css", "body{color:#123}"],
]) {
  const web = path.join(root, "web");
  await mkdir(path.join(web, "assets"), { recursive: true });
  await writeFile(path.join(web, "index.html"), "<!doctype html><html><body>photo</body></html>");
  for (const [relative, contents] of assets) {
    const target = path.join(web, "assets", relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return web;
}

function options(web, output, sdk = SDK) {
  return {
    builtWebDirectory: web,
    outputDirectory: output,
    sdkPackageDirectory: sdk,
    offlineCopy: { title: "オフライン <写真>", message: "接続を確認して、もう一度お試しください。" },
    applicationCopy: { name: "NIHO photo", shortName: "Photo", description: "写真を編集する" },
  };
}

async function rejected(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof PhotoStaticBuildError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, "Photo static bundle preparation failed");
    assert.equal(error.message.includes("/"), false);
    return true;
  });
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested);
}

async function copiedBytes(output, descriptor) {
  const bytes = await readFile(path.join(output, ...descriptor.path.slice(1).split("/")));
  assert.equal(bytes.byteLength, descriptor.sizeBytes);
  assert.equal(digest(bytes), descriptor.sha256);
  return bytes;
}

async function treeFingerprint(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const fingerprint = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) fingerprint.push(...await treeFingerprint(root, child));
    else fingerprint.push([child, digest(await readFile(path.join(root, child)))]);
  }
  return fingerprint;
}

describe("preparePhotoStaticBundle", () => {
  it("builds an immutable, byte-exact bundle and a self-contained classic worker", async (context) => {
    const root = await temporary(context);
    const firstWeb = await webFixture(path.join(root, "one"), [
      ["nested/font.woff2", Buffer.from("font")],
      ["theme.css", "body{color:#123}"],
      ["app.js", "globalThis.photoApp=true;"],
    ]);
    const secondWeb = await webFixture(path.join(root, "two"), [
      ["app.js", "globalThis.photoApp=true;"],
      ["theme.css", "body{color:#123}"],
      ["nested/font.woff2", Buffer.from("font")],
    ]);
    const firstOutput = path.join(root, "bundle-one");
    const secondOutput = path.join(root, "bundle-two");
    const first = await preparePhotoStaticBundle(options(firstWeb, firstOutput));
    const second = await preparePhotoStaticBundle(options(secondWeb, secondOutput));

    assert.equal(first.buildId, second.buildId);
    assert.deepEqual(first, second);
    assert.match(first.buildId, /^[a-f0-9]{64}$/);
    assertDeepFrozen(first);
    assert.throws(() => first.pwa.assets.push({}));
    assert.throws(() => { first.sdk.sdkVersion = "changed"; });

    const documentBytes = await readFile(path.join(firstOutput, "index.html"));
    assert.equal(documentBytes.byteLength, first.document.sizeBytes);
    assert.equal(digest(documentBytes), first.document.sha256);
    for (const file of first.files) await copiedBytes(firstOutput, file);

    const pwaPaths = new Set(first.pwa.assets.map((asset) => asset.path));
    assert.equal(pwaPaths.has("/index.html"), false);
    assert.equal(pwaPaths.has("/photo-sw.js"), false);
    assert.equal(pwaPaths.has("/photo-build.json"), false);
    assert.equal(pwaPaths.has("/manifest.webmanifest"), false);
    assert.equal([...pwaPaths].some((entry) => entry.startsWith("/api/")), false);
    for (const notice of first.files.filter((file) => file.kind === "notice")) assert.equal(pwaPaths.has(notice.path), false);
    assert.equal(first.pwa.assets.filter((asset) => asset.kind === "offline").length, 1);
    assert.equal(first.pwa.offlinePath, first.pwa.assets.find((asset) => asset.kind === "offline").path);

    const prefix = `/develop-engine/${first.sdk.manifestSha256}/`;
    for (const file of first.files.filter((entry) => entry.kind === "engine" || entry.kind === "notice")) {
      const relative = file.path.slice(prefix.length);
      const source = file.kind === "notice"
        ? path.join(SDK, ...relative.split("/"))
        : path.join(SDK, "develop-engine/niho-14", relative);
      assert.deepEqual(await copiedBytes(firstOutput, file), await readFile(source));
    }
    assert.equal(first.files.some((file) => file.path.endsWith(".d.ts")), false);

    const offline = (await readFile(path.join(firstOutput, ...first.pwa.offlinePath.slice(1).split("/")))).toString("utf8");
    assert.match(offline, /^<!doctype html><html lang="ja">/);
    assert.match(offline, /オフライン &lt;写真&gt;/);
    assert.equal(/<script|<form|credential|https?:/iu.test(offline), false);

    const workerBytes = await readFile(path.join(firstOutput, "photo-sw.js"));
    assert.equal(workerBytes.byteLength, first.worker.sizeBytes);
    assert.equal(digest(workerBytes), first.worker.sha256);
    const manifestBytes = await readFile(path.join(firstOutput, "manifest.webmanifest"));
    assert.equal(digest(manifestBytes), first.webManifest.sha256);
    assert.equal(manifestBytes.byteLength, first.webManifest.sizeBytes);
    const install = JSON.parse(manifestBytes);
    assert.deepEqual([install.id, install.start_url, install.scope], ["/", "/", "/"]);
    assert.equal(install.name, "NIHO photo");
    assert.equal(install.display, "standalone");
    assert.equal(install.orientation, "any");
    assert.deepEqual(Object.keys(install).sort(), ["background_color", "description", "display", "icons", "id", "lang", "name", "orientation", "scope", "short_name", "start_url", "theme_color"]);
    assert.equal(first.files.find((file) => file.path === install.icons[0].src).sha256, install.icons[0].src.match(/[a-f0-9]{64}/)[0]);
    const listeners = [];
    const self = {
      location: { href: "https://photo.example/photo-sw.js" },
      addEventListener(type) { listeners.push(type); },
      setTimeout,
      clearTimeout,
    };
    vm.runInNewContext(workerBytes.toString("utf8"), { self, URL });
    assert.deepEqual(listeners.sort(), ["activate", "fetch", "install", "message"]);
    assert.equal(workerBytes.toString("utf8").includes("import "), false);

    const metadata = JSON.parse(await readFile(path.join(firstOutput, "photo-build.json"), "utf8"));
    assert.deepEqual(metadata, first);
    assert.equal(JSON.stringify(metadata).includes(root), false);
    assert.equal(JSON.stringify(metadata).includes(SDK), false);
  });

  it("rejects symlinks, noncanonical paths, hidden or unknown files, and extra root artifacts", async (context) => {
    for (const [name, mutate] of [
      ["symlink", async (web) => symlink(path.join(web, "index.html"), path.join(web, "assets/link.js"))],
      ["percent path", async (web) => writeFile(path.join(web, "assets/%2e.js"), "x")],
      ["hidden file", async (web) => writeFile(path.join(web, "assets/.secret.js"), "x")],
      ["source map", async (web) => writeFile(path.join(web, "assets/app.js.map"), "{}")],
      ["json", async (web) => writeFile(path.join(web, "assets/data.json"), "{}")],
      ["extra root", async (web) => writeFile(path.join(web, "robots.txt"), "x")],
    ]) {
      await context.test(name, async (child) => {
        const root = await temporary(child);
        const web = await webFixture(root);
        await mutate(web);
        await rejected(preparePhotoStaticBundle(options(web, path.join(root, "out"))), "invalid_artifact");
        await assert.rejects(lstat(path.join(root, "out")), { code: "ENOENT" });
      });
    }

    await context.test("depth", async (child) => {
      const root = await temporary(child);
      const web = await webFixture(root);
      const deep = path.join(web, "assets", ...Array.from({ length: 8 }, (_, index) => `d${index}`), "app.js");
      await mkdir(path.dirname(deep), { recursive: true });
      await writeFile(deep, "x");
      await rejected(preparePhotoStaticBundle(options(web, path.join(root, "out"))), "invalid_artifact");
    });
  });

  it("enforces bounded reads, shared nested budgets, file counts, and source traversal", async (context) => {
    await context.test("per-file bytes", async (child) => {
      const root = await temporary(child, "photo-static-large-");
      const web = await webFixture(root, [["large.js", Buffer.alloc(MAX_FILE_BYTES + 1)]]);
      await rejected(preparePhotoStaticBundle(options(web, path.join(root, "out"))), "budget_exceeded");
    });

    await context.test("nested aggregate bytes", async (child) => {
      const root = await temporary(child, "photo-static-budget-");
      const web = await webFixture(root, []);
      const block = Buffer.alloc(7 * 1024 * 1024, 1);
      for (let index = 0; index < 5; index += 1) {
        const target = path.join(web, "assets", `directory-${index}`, "app.js");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, block);
      }
      await rejected(preparePhotoStaticBundle(options(web, path.join(root, "out"))), "budget_exceeded");
      await assert.rejects(lstat(path.join(root, "out")), { code: "ENOENT" });
    });

    await context.test("public file count", async (child) => {
      const root = await temporary(child, "photo-static-count-");
      const web = await webFixture(root, []);
      for (let index = 0; index < 126; index += 1) {
        await writeFile(path.join(web, "assets", `asset-${String(index).padStart(3, "0")}.js`), "x");
      }
      await rejected(preparePhotoStaticBundle(options(web, path.join(root, "out"))), "budget_exceeded");
    });

    await context.test("source entry traversal", async (child) => {
      const root = await temporary(child, "photo-static-entries-");
      const web = await webFixture(root, []);
      for (let index = 0; index < 255; index += 1) {
        await mkdir(path.join(web, "assets", `empty-${String(index).padStart(3, "0")}`));
      }
      await rejected(preparePhotoStaticBundle(options(web, path.join(root, "out"))), "budget_exceeded");
    });
  });

  it("rejects SDK manifest, runtime, notice, and package identity tampering without touching the audit cache", async (context) => {
    for (const [name, relative, mutation] of [
      ["manifest", ENGINE_MANIFEST, "{}"],
      ["runtime", "develop-engine/niho-14/niho_develop_wasm-0.27.0.js", "tampered"],
      ["notice", "LICENSE.md", "tampered"],
      ["package", "package.json", JSON.stringify({ name: "other", version: "0.1.7" })],
    ]) {
      await context.test(name, async (child) => {
        const root = await temporary(child, "photo-static-sdk-");
        const web = await webFixture(root);
        const sdk = path.join(root, "sdk");
        await cp(SDK, sdk, { recursive: true });
        await writeFile(path.join(sdk, ...relative.split("/")), mutation);
        await rejected(preparePhotoStaticBundle(options(web, path.join(root, "out"), sdk)), "invalid_artifact");
        await assert.rejects(lstat(path.join(root, "out")), { code: "ENOENT" });
      });
    }
    const originalManifest = await readFile(path.join(SDK, ENGINE_MANIFEST));
    assert.equal(digest(originalManifest), "c3f175559b61ab5823c166abff9361aed9e2c00a1f090fbe665720f879fe321e");
  });

  it("protects an existing output and rejects input/output containment", async (context) => {
    const root = await temporary(context);
    const web = await webFixture(root);
    const output = path.join(root, "existing");
    await mkdir(output);
    await writeFile(path.join(output, "owner.txt"), "keep");
    await rejected(preparePhotoStaticBundle(options(web, output)), "output_exists");
    assert.equal(await readFile(path.join(output, "owner.txt"), "utf8"), "keep");

    await rejected(preparePhotoStaticBundle(options(web, path.join(web, "nested-output"))), "invalid_input");
    const webAlias = path.join(root, "web-alias");
    await symlink(web, webAlias);
    await rejected(preparePhotoStaticBundle(options(web, path.join(webAlias, "aliased-output"))), "invalid_input");
    const outer = path.join(root, "outer-output");
    await mkdir(outer);
    const inside = await webFixture(outer);
    await rejected(preparePhotoStaticBundle(options(inside, outer)), "invalid_input");
  });

  it("rejects output inside the SDK source without changing any audit-cache bytes", async (context) => {
    const root = await temporary(context);
    const web = await webFixture(root);
    const output = path.join(SDK, "c06-static-output-forbidden-test");
    await assert.rejects(lstat(output), { code: "ENOENT" });
    const before = await treeFingerprint(SDK);
    await rejected(preparePhotoStaticBundle(options(web, output)), "invalid_input");
    await assert.rejects(lstat(output), { code: "ENOENT" });
    assert.deepEqual(await treeFingerprint(SDK), before);
  });

  it("snapshots primitive options before the first asynchronous filesystem operation", async (context) => {
    const root = await temporary(context);
    const web = await webFixture(root);
    const output = path.join(root, "out");
    const mutable = options(web, output);
    const build = preparePhotoStaticBundle(mutable);
    mutable.outputDirectory = path.join(root, "mutated-output");
    mutable.offlineCopy.title = "mutated";
    mutable.applicationCopy.name = "mutated";
    const result = await build;
    assert.equal((await lstat(output)).isDirectory(), true);
    await assert.rejects(lstat(mutable.outputDirectory), { code: "ENOENT" });
    const offline = await readFile(path.join(output, ...result.pwa.offlinePath.slice(1).split("/")), "utf8");
    assert.match(offline, /オフライン &lt;写真&gt;/);
    assert.equal(offline.includes("mutated"), false);
  });

  it("removes only its newly owned output after a mid-write collision", async (context) => {
    const root = await temporary(context);
    const web = await webFixture(root);
    const output = path.join(root, "out");
    const parentMarker = path.join(root, "parent-owner.txt");
    await writeFile(parentMarker, "keep");

    const injected = (async () => {
      for (let attempt = 0; attempt < 10_000; attempt += 1) {
        try {
          await lstat(output);
          await writeFile(path.join(output, "develop-engine"), "collision", { flag: "wx" });
          return;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await defer();
        }
      }
      throw new Error("injection did not observe output");
    })();
    await rejected(preparePhotoStaticBundle(options(web, output)), "io_failure");
    await injected;
    await assert.rejects(lstat(output), { code: "ENOENT" });
    assert.equal(await readFile(parentMarker, "utf8"), "keep");
    assert.equal((await lstat(web)).isDirectory(), true);
    assert.equal((await lstat(SDK)).isDirectory(), true);
  });

  it("rejects invalid offline copy without disclosing its raw value", async (context) => {
    const root = await temporary(context);
    const web = await webFixture(root);
    for (const offlineCopy of [
      { title: "", message: "message" },
      { title: "title", message: "bad\nmessage" },
      { title: "title", message: "x".repeat(4097) },
      { title: "bad\ud800", message: "message" },
    ]) {
      await rejected(preparePhotoStaticBundle({ ...options(web, path.join(root, `out-${Math.random()}`)), offlineCopy }), "invalid_input");
    }
  });
  it("rejects a FIFO SDK input without waiting for a writer", async (context) => {
    const root = await temporary(context);
    const web = await webFixture(root);
    const sdk = path.join(root, "fifo-sdk");
    await mkdir(sdk);
    const created = spawnSync("mkfifo", [path.join(sdk, "package.json")], { stdio: "ignore" });
    assert.equal(created.status, 0);
    const modulePath = fileURLToPath(new URL("../src/build/static-bundle.ts", import.meta.url));
    const probe = `import {pathToFileURL} from "node:url";
      const {preparePhotoStaticBundle,PhotoStaticBuildError}=await import(pathToFileURL(process.argv[1]));
      try { await preparePhotoStaticBundle(JSON.parse(process.argv[2])); process.exit(2); }
      catch(error) { process.exit(error instanceof PhotoStaticBuildError && error.code==="invalid_artifact" ? 0 : 3); }`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", probe, modulePath,
      JSON.stringify(options(web, path.join(root, "output"), sdk))], { timeout: 2_000, stdio: "ignore" });
    assert.equal(child.error?.code, undefined);
    assert.equal(child.status, 0);
  });

});

describe("Photo install manifest", () => {
  it("binds application copy to build identity without accepting caller config", async (context) => {
    const root = await temporary(context);
    const web = await webFixture(root);
    const firstOptions = options(web, path.join(root, "one"));
    firstOptions.applicationCopy.identity = "ignored";
    const first = await preparePhotoStaticBundle(firstOptions);
    const second = await preparePhotoStaticBundle({ ...options(web, path.join(root, "two")),
      applicationCopy: { ...firstOptions.applicationCopy, name: 'Photo "日本語" <>' } });
    assert.notEqual(first.buildId, second.buildId);
    const manifest = JSON.parse(await readFile(path.join(root, "two/manifest.webmanifest"), "utf8"));
    assert.equal(manifest.name, 'Photo "日本語" <>');
    assert.equal("identity" in manifest, false);
    for (const applicationCopy of [undefined, { name: "x", shortName: "", description: "x" },
      { name: "x".repeat(4097), shortName: "x", description: "x" },
      { name: "x", shortName: "x", description: "bad\nvalue" }]) {
      await rejected(preparePhotoStaticBundle({ ...options(web, path.join(root, "invalid")), applicationCopy }), "invalid_input");
    }
  });
});
