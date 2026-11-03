import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { installPhotoStaticWorker } from "../src/pwa/worker-runtime.js";

const ORIGIN = "https://photo.example";
const BUILD = "a".repeat(64);
const safeHeaders = (contentType) => ({
  "cache-control": "public, max-age=31536000, immutable",
  "content-type": contentType,
});
const sha = async (body) => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const asset = async (path, body, contentType, kind) => ({
  path,
  sha256: await sha(body),
  sizeBytes: new TextEncoder().encode(body).byteLength,
  contentType,
  kind,
});

async function fixture() {
  const bodies = {
    "/assets/app.js": "console.log('static')",
    "/assets/app.css": "body{color:#123}",
    "/icons/app.png": "png-static",
    "/develop-engine/engine.wasm": "wasm-static",
    "/offline.html": "<!doctype html><p>offline</p>",
  };
  const manifest = {
    schemaVersion: 1,
    buildId: BUILD,
    assets: [
      await asset("/assets/app.js", bodies["/assets/app.js"], "application/javascript", "script"),
      await asset("/assets/app.css", bodies["/assets/app.css"], "text/css", "style"),
      await asset("/icons/app.png", bodies["/icons/app.png"], "image/png", "icon"),
      await asset("/develop-engine/engine.wasm", bodies["/develop-engine/engine.wasm"], "application/wasm", "engine"),
      await asset("/offline.html", bodies["/offline.html"], "text/html", "offline"),
    ],
    offlinePath: "/offline.html",
  };
  return { bodies, manifest };
}

function basic(body, init = {}) {
  const response = new Response(body, init);
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
}

function cloneResponse(response) {
  const clone = response.clone();
  if (response.type === "basic") Object.defineProperty(clone, "type", { value: "basic" });
  return clone;
}

function fakeScope(fetcher, initialStores = new Map(), timer = globalThis) {
  const listeners = new Map();
  const stores = initialStores;
  const cache = (name) => ({
    async match(key) {
      const value = stores.get(name)?.get(typeof key === "string" ? key : key.url);
      return value ? cloneResponse(value) : undefined;
    },
    async put(key, response) {
      if (!stores.has(name)) stores.set(name, new Map());
      stores.get(name).set(typeof key === "string" ? key : key.url, cloneResponse(response));
    },
    async delete(key) {
      return stores.get(name)?.delete(typeof key === "string" ? key : key.url) ?? false;
    },
    async keys() {
      return [...(stores.get(name)?.keys() ?? [])];
    },
  });
  const scope = {
    location: new URL(`${ORIGIN}/photo-sw.js`),
    registration: { scope: `${ORIGIN}/` },
    crypto,
    setTimeout: timer.setTimeout.bind(timer),
    clearTimeout: timer.clearTimeout.bind(timer),
    fetch: fetcher,
    caches: {
      async open(name) {
        if (!stores.has(name)) stores.set(name, new Map());
        return cache(name);
      },
      async keys() { return [...stores.keys()]; },
      async delete(name) { return stores.delete(name); },
    },
    clients: { async matchAll() { return []; } },
    skipWaitingCalls: 0,
    async skipWaiting() { this.skipWaitingCalls += 1; },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const fire = async (type, fields = {}) => {
    let responsePromise;
    const waited = [];
    const event = {
      ...fields,
      respondWith(value) { responsePromise = Promise.resolve(value); },
      waitUntil(value) { waited.push(Promise.resolve(value)); },
    };
    listeners.get(type)?.(event);
    const response = responsePromise ? await responsePromise : undefined;
    await Promise.all(waited);
    return response;
  };
  return { scope, stores, fire, listeners };
}

function staticRequest(path, init = {}) {
  return {
    method: "GET",
    mode: "same-origin",
    url: `${ORIGIN}${path}`,
    headers: new Headers(),
    ...init,
  };
}

describe("installPhotoStaticWorker static boundary", () => {
  it("runs from its standalone function source in a classic-worker-like VM", async () => {
    const { manifest, bodies } = await fixture();
    const worker = fakeScope(async () => basic(bodies["/assets/app.js"], { headers: safeHeaders("application/javascript") }));
    const embedded = vm.runInNewContext(`(${installPhotoStaticWorker.toString()})`, {
      URL,
      Request,
      Response,
      Headers,
      ReadableStream,
      Uint8Array,
      AbortController,
      MessageChannel,
      crypto,
      setTimeout,
      clearTimeout,
    });
    embedded(worker.scope, manifest);
    const response = await worker.fire("fetch", { request: staticRequest("/assets/app.js") });
    assert.equal(await response.text(), bodies["/assets/app.js"]);
  });

  it("verifies real SHA-256 bytes, uses credential-free redirect-error requests, then serves a verified cache hit", async () => {
    const { manifest, bodies } = await fixture();
    const requests = [];
    const worker = fakeScope(async (request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      const descriptor = manifest.assets.find((entry) => entry.path === path);
      return basic(bodies[path], { headers: safeHeaders(descriptor.contentType) });
    });
    installPhotoStaticWorker(worker.scope, manifest);

    const first = await worker.fire("fetch", { request: staticRequest("/assets/app.js") });
    assert.equal(await first.text(), bodies["/assets/app.js"]);
    assert.equal(requests[0].credentials, "omit");
    assert.equal(requests[0].redirect, "error");
    assert.equal(requests[0].cache, "no-store");
    assert.equal(requests.length, 1);

    const second = await worker.fire("fetch", { request: staticRequest("/assets/app.js") });
    assert.equal(await second.text(), bodies["/assets/app.js"]);
    assert.equal(requests.length, 1);
  });

  it("accepts only exact hash-pinned engine JSON alongside runtime bytes", async () => {
    const { manifest } = await fixture();
    const body = '{"schemaVersion":1}';
    manifest.assets.push(await asset("/develop-engine/pinned/manifest.json", body, "application/json", "engine"));
    const worker = fakeScope(async () => basic(body, { headers: safeHeaders("application/json") }));
    installPhotoStaticWorker(worker.scope, manifest);
    const response = await worker.fire("fetch", { request: staticRequest("/develop-engine/pinned/manifest.json") });
    assert.equal(await response.text(), body);
    assert.equal(await worker.fire("fetch", { request: staticRequest("/api/library.json") }), undefined);
  });

  it("supports only the manifest's exact static namespaces and leaves risky requests untouched", async () => {
    const { manifest, bodies } = await fixture();
    const requests = [];
    const worker = fakeScope(async (request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      const descriptor = manifest.assets.find((entry) => entry.path === path);
      return basic(bodies[path], { headers: safeHeaders(descriptor.contentType) });
    });
    installPhotoStaticWorker(worker.scope, manifest);

    for (const path of ["/assets/app.css", "/icons/app.png", "/develop-engine/engine.wasm"]) {
      const response = await worker.fire("fetch", { request: staticRequest(path) });
      assert.equal(response.status, 200);
    }
    const untouched = [
      staticRequest("/api/photos"),
      staticRequest("/auth/callback"),
      staticRequest("/photo-content/signed-token"),
      staticRequest("/assets/app.js?owner=1"),
      staticRequest("/assets/app.js", { headers: new Headers({ authorization: "secret" }) }),
      staticRequest("/assets/app.js", { headers: new Headers({ range: "bytes=0-3" }) }),
      staticRequest("/offline.html", { mode: "navigate" }),
    ];
    for (const request of untouched) assert.equal(await worker.fire("fetch", { request }), undefined);
    assert.equal(requests.length, 3);
  });

  it("rejects malformed manifests synchronously", async () => {
    const { manifest } = await fixture();
    const worker = fakeScope(async () => { throw new Error("unused"); });
    const variants = [
      { ...manifest, buildId: "ABC" },
      { ...manifest, offlinePath: "/missing.html" },
      { ...manifest, assets: [...manifest.assets, manifest.assets[0]] },
      { ...manifest, assets: manifest.assets.map((entry, index) => index ? entry : { ...entry, path: "/assets/../api/x" }) },
      { ...manifest, assets: manifest.assets.map((entry, index) => index ? entry : { ...entry, path: "/assets/a%2fb.js" }) },
      { ...manifest, assets: manifest.assets.map((entry, index) => index ? entry : { ...entry, sha256: "G".repeat(64) }) },
      { ...manifest, assets: manifest.assets.map((entry, index) => index ? entry : { ...entry, sizeBytes: 9 * 1024 * 1024 }) },
      { ...manifest, assets: manifest.assets.map((entry, index) => index ? entry : { ...entry, contentType: "text/html" }) },
    ];
    for (const variant of variants) assert.throws(() => installPhotoStaticWorker(worker.scope, variant), /Invalid static manifest/);
  });

  it("never serves or stores bad hash, size, MIME, partial, personalized, or redirected network responses", async (context) => {
    const { manifest } = await fixture();
    const cases = [
      ["hash", "wrong", { headers: safeHeaders("application/javascript") }],
      ["size", "x", { headers: safeHeaders("application/javascript") }],
      ["mime", "console.log('static')", { headers: safeHeaders("text/css") }],
      ["partial", "console.log('static')", { headers: { ...safeHeaders("application/javascript"), "content-range": "bytes 0-1/2" } }],
      ["private", "console.log('static')", { headers: { ...safeHeaders("application/javascript"), "cache-control": "private, immutable" } }],
      ["vary-cookie", "console.log('static')", { headers: { ...safeHeaders("application/javascript"), vary: "Cookie" } }],
      ["redirect", "console.log('static')", { status: 200, headers: safeHeaders("application/javascript"), redirected: true }],
    ];
    for (const [name, body, init] of cases) {
      await context.test(name, async () => {
        const worker = fakeScope(async () => {
          const response = basic(body, init);
          if (init.redirected) Object.defineProperty(response, "redirected", { value: true });
          return response;
        });
        installPhotoStaticWorker(worker.scope, manifest);
        await assert.rejects(worker.fire("fetch", { request: staticRequest("/assets/app.js") }));
        assert.equal(worker.stores.get(`niho-photo-web-static-${BUILD}`)?.size ?? 0, 0);
      });
    }
  });

  it("discards a corrupt cache hit and safely falls back to verified network", async () => {
    const { manifest, bodies } = await fixture();
    let network = 0;
    const cacheName = `niho-photo-web-static-${BUILD}`;
    const stores = new Map([[cacheName, new Map([[`${ORIGIN}/assets/app.js`, new Response("corrupt", { headers: safeHeaders("application/javascript") })]])]]);
    const worker = fakeScope(async () => {
      network += 1;
      return basic(bodies["/assets/app.js"], { headers: safeHeaders("application/javascript") });
    }, stores);
    installPhotoStaticWorker(worker.scope, manifest);
    const response = await worker.fire("fetch", { request: staticRequest("/assets/app.js") });
    assert.equal(await response.text(), bodies["/assets/app.js"]);
    assert.equal(network, 1);
  });

  it("serves verified network bytes when CacheStorage is unavailable or a quota write rejects", async () => {
    const { manifest, bodies } = await fixture();
    for (const failure of ["open", "put"]) {
      const worker = fakeScope(async () => basic(bodies["/assets/app.js"], { headers: safeHeaders("application/javascript") }));
      if (failure === "open") worker.scope.caches.open = async () => { throw new Error("unavailable"); };
      else {
        const originalOpen = worker.scope.caches.open;
        worker.scope.caches.open = async (...args) => ({ ...(await originalOpen(...args)), put: async () => { throw new Error("quota"); } });
      }
      installPhotoStaticWorker(worker.scope, manifest);
      const response = await worker.fire("fetch", { request: staticRequest("/assets/app.js") });
      assert.equal(await response.text(), bodies["/assets/app.js"]);
    }
  });

  it("bounds a hostile body read/cancel and disables a hanging cache operation without hanging the response", async () => {
    const { manifest, bodies } = await fixture();
    const fastDeadlineTimer = {
      setTimeout(callback, milliseconds) {
        return setTimeout(callback, milliseconds >= 1_000 ? 0 : milliseconds);
      },
      clearTimeout,
    };

    let cancelled = false;
    const hostile = fakeScope(async () => basic(new ReadableStream({
      pull() { return new Promise(() => undefined); },
      cancel() { cancelled = true; },
    }), { headers: safeHeaders("application/javascript") }), new Map(), fastDeadlineTimer);
    installPhotoStaticWorker(hostile.scope, manifest);
    await assert.rejects(hostile.fire("fetch", { request: staticRequest("/assets/app.js") }), /timed out/);
    assert.equal(cancelled, true);

    const hangingCache = fakeScope(
      async () => basic(bodies["/assets/app.js"], { headers: safeHeaders("application/javascript") }),
      new Map(),
      fastDeadlineTimer,
    );
    hangingCache.scope.caches.open = async () => new Promise(() => undefined);
    installPhotoStaticWorker(hangingCache.scope, manifest);
    const response = await hangingCache.fire("fetch", { request: staticRequest("/assets/app.js") });
    assert.equal(await response.text(), bodies["/assets/app.js"]);
  });

  it("retains at most two hostile body/digest tasks after their public deadlines", async () => {
    const { manifest } = await fixture();
    const fast = { setTimeout: (callback) => setTimeout(callback, 0), clearTimeout };
    let reads = 0;
    const worker = fakeScope(async () => ({
      status: 200, type: "basic", redirected: false,
      headers: new Headers(safeHeaders("application/javascript")),
      body: {
        getReader() {
          reads += 1;
          return { read: () => new Promise(() => {}), cancel: () => new Promise(() => {}), releaseLock() {} };
        },
        cancel: () => new Promise(() => {}),
      },
    }), new Map(), fast);
    worker.scope.caches.open = async () => { throw new Error("no cache"); };
    installPhotoStaticWorker(worker.scope, manifest);
    for (let i = 0; i < 5; i += 1) await assert.rejects(worker.fire("fetch", { request: staticRequest("/assets/app.js") }));
    assert.equal(reads, 2);
  });

  it("caps unresolved fetches and cancels a response arriving after timeout", async () => {
    const { manifest, bodies } = await fixture();
    const fast = { setTimeout: (callback) => setTimeout(callback, 0), clearTimeout };
    let fetches = 0;
    let release;
    const worker = fakeScope(() => {
      fetches += 1;
      return new Promise((resolve) => { release = resolve; });
    }, new Map(), fast);
    worker.scope.caches.open = async () => { throw new Error("no cache"); };
    installPhotoStaticWorker(worker.scope, manifest);
    for (let i = 0; i < 5; i += 1) await assert.rejects(worker.fire("fetch", { request: staticRequest("/assets/app.js") }));
    assert.equal(fetches, 2);
    let cancelled = false;
    const late = basic(bodies["/assets/app.js"], { headers: safeHeaders("application/javascript") });
    late.body.cancel = async () => { cancelled = true; };
    release(late);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  });

  it("admits only two response bodies at once and does not fetch a third body while both slots are occupied", async () => {
    const { manifest, bodies } = await fixture();
    const bytes = new TextEncoder().encode(bodies["/assets/app.js"]);
    const releases = [];
    let fetches = 0;
    const worker = fakeScope(async () => {
      fetches += 1;
      let delivered = false;
      return {
        status: 200,
        statusText: "OK",
        type: "basic",
        redirected: false,
        headers: new Headers(safeHeaders("application/javascript")),
        body: {
          getReader() {
            return {
              read() {
                if (delivered) return Promise.resolve({ done: true });
                return new Promise((resolve) => releases.push(() => {
                  delivered = true;
                  resolve({ done: false, value: bytes });
                }));
              },
              cancel() { return Promise.resolve(); },
              releaseLock() {},
            };
          },
        },
      };
    });
    worker.scope.caches.open = async () => { throw new Error("disabled for admission test"); };
    installPhotoStaticWorker(worker.scope, manifest);
    const pending = [1, 2].map(() => worker.fire("fetch", { request: staticRequest("/assets/app.js") }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 2);
    assert.equal(releases.length, 2);
    let thirdSettled = false;
    const third = worker.fire("fetch", { request: staticRequest("/assets/app.js") });
    void third.then(() => { thirdSettled = true; }, () => { thirdSettled = true; });
    pending.push(third);
    await new Promise((resolve) => setImmediate(resolve));
    const thirdQueued = !thirdSettled && fetches === 2;

    releases.shift()();
    for (let turn = 0; turn < 10 && (fetches < 3 || releases.length < 2); turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    while (releases.length) releases.shift()();
    const outcomes = await Promise.allSettled(pending);
    assert.equal(thirdQueued, true, "a later request must wait for ordinary body verification");
    assert.equal(fetches, 3);
    assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled"));
    const responses = outcomes.map((outcome) => outcome.value);
    assert.deepEqual(await Promise.all(responses.map((response) => response.text())), [bodies["/assets/app.js"], bodies["/assets/app.js"], bodies["/assets/app.js"]]);
  });

  it("queues a later static fetch after two ordinary network requests are already pending", async () => {
    const { manifest, bodies } = await fixture();
    const releases = [];
    let fetches = 0;
    const worker = fakeScope(() => {
      fetches += 1;
      return new Promise((resolve) => releases.push(() => resolve(basic(bodies["/assets/app.js"], {
        headers: safeHeaders("application/javascript"),
      }))));
    });
    worker.scope.caches.open = async () => { throw new Error("disabled for fetch admission test"); };
    installPhotoStaticWorker(worker.scope, manifest);
    const first = worker.fire("fetch", { request: staticRequest("/assets/app.js") });
    const second = worker.fire("fetch", { request: staticRequest("/assets/app.js") });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 2);
    let thirdSettled = false;
    const third = worker.fire("fetch", { request: staticRequest("/assets/app.js") });
    void third.then(() => { thirdSettled = true; }, () => { thirdSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    const thirdQueued = !thirdSettled && fetches === 2;
    releases.shift()();
    await first;
    for (let turn = 0; turn < 20 && fetches < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    while (releases.length) releases.shift()();
    const outcomes = await Promise.allSettled([first, second, third]);
    assert.equal(thirdQueued, true, "a later request must wait for ordinary fetches");
    assert.equal(fetches, 3);
    assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled"));
  });

  it("queues healthy work in the remaining slot after one timed-out fetch is retained", async () => {
    const { manifest, bodies } = await fixture();
    let firstDeadline = true;
    const timer = {
      setTimeout(callback, milliseconds) { return setTimeout(callback, firstDeadline ? 0 : milliseconds); },
      clearTimeout,
    };
    let fetches = 0;
    let releaseSecond;
    const response = () => basic(bodies["/assets/app.js"], { headers: safeHeaders("application/javascript") });
    const worker = fakeScope(() => {
      fetches += 1;
      if (fetches === 1) return new Promise(() => {});
      if (fetches === 2) return new Promise((resolve) => { releaseSecond = () => resolve(response()); });
      return Promise.resolve(response());
    }, new Map(), timer);
    worker.scope.caches.open = async () => { throw new Error("no cache"); };
    installPhotoStaticWorker(worker.scope, manifest);
    await assert.rejects(worker.fire("fetch", { request: staticRequest("/assets/app.js") }));
    firstDeadline = false;
    const second = worker.fire("fetch", { request: staticRequest("/assets/app.js") });
    await new Promise((resolve) => setImmediate(resolve));
    let thirdSettled = false;
    const third = worker.fire("fetch", { request: staticRequest("/assets/app.js") });
    void third.then(() => { thirdSettled = true; }, () => { thirdSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    const queued = !thirdSettled && fetches === 2;
    releaseSecond();
    const results = await Promise.allSettled([second, third]);
    assert.equal(queued, true);
    assert.ok(results.every((result) => result.status === "fulfilled"));
    assert.equal(fetches, 3);
  });

  it("pre-caches only verified anonymous offline HTML without auto-activation", async () => {
    const { manifest, bodies } = await fixture();
    const fetched = [];
    const worker = fakeScope(async (request) => {
      fetched.push(new URL(request.url).pathname);
      return basic(bodies["/offline.html"], { headers: safeHeaders("text/html") });
    });
    installPhotoStaticWorker(worker.scope, manifest);
    await worker.fire("install");
    assert.deepEqual(fetched, ["/offline.html"]);
    assert.equal(worker.scope.skipWaitingCalls, 0);
  });

  it("uses only the verified anonymous fallback for exact-root network failure and never intercepts callbacks", async () => {
    const { manifest, bodies } = await fixture();
    const worker = fakeScope(async (request) => {
      if (new URL(request.url).pathname === "/offline.html") return basic(bodies["/offline.html"], { headers: safeHeaders("text/html") });
      throw new Error("offline");
    });
    installPhotoStaticWorker(worker.scope, manifest);
    await worker.fire("install");
    const fallback = await worker.fire("fetch", { request: staticRequest("/", { mode: "navigate" }) });
    assert.equal(await fallback.text(), bodies["/offline.html"]);
    assert.equal(await worker.fire("fetch", { request: staticRequest("/auth/callback", { mode: "navigate" }) }), undefined);
  });

  it("keeps at most current plus one own version cache and preserves unrelated caches without claiming clients", async () => {
    const { manifest } = await fixture();
    const oldOne = `niho-photo-web-static-${"b".repeat(64)}`;
    const oldTwo = `niho-photo-web-static-${"c".repeat(64)}`;
    const stores = new Map([
      ["foreign-cache", new Map()],
      [oldOne, new Map()],
      [oldTwo, new Map()],
      ["niho-photo-web-static-malformed", new Map()],
      [`niho-photo-web-static-${BUILD}`, new Map()],
    ]);
    const worker = fakeScope(async () => { throw new Error("unused"); }, stores);
    installPhotoStaticWorker(worker.scope, manifest);
    await worker.fire("activate");
    assert.deepEqual([...stores.keys()].sort(), ["foreign-cache", oldTwo, `niho-photo-web-static-${BUILD}`].sort());
    assert.equal("claim" in worker.scope.clients, false);
  });
});

describe("installPhotoStaticWorker explicit update consensus", () => {
  const nonce = "b".repeat(64);
  const makeClient = (id, reply = true) => ({
    id,
    type: "window",
    url: `${ORIGIN}/${id}`,
    results: [],
    postMessage(message, ports) {
      if (message.type === "PHOTO_UPDATE_CHECK") {
        const answer = typeof reply === "function" ? reply(message) : { nonce: message.nonce, buildId: message.buildId, allow: reply };
        ports[0].postMessage(answer);
      } else this.results.push(message);
    },
  });

  it("requires every in-scope window acknowledgement, then approves only the requester and activates", async () => {
    const { manifest } = await fixture();
    const requester = makeClient("requester");
    const other = makeClient("other");
    const worker = fakeScope(async () => { throw new Error("unused"); });
    worker.scope.clients.matchAll = async () => [requester, other];
    installPhotoStaticWorker(worker.scope, manifest);
    await worker.fire("message", { data: { type: "PHOTO_REQUEST_UPDATE", nonce }, source: requester });
    assert.deepEqual(requester.results, [{ type: "PHOTO_UPDATE_APPROVED", nonce, buildId: BUILD }]);
    assert.deepEqual(other.results, []);
    assert.equal(worker.scope.skipWaitingCalls, 1);
  });

  it("fails closed for denial, wrong nonce, missing requester, and source spoof", async (context) => {
    const { manifest } = await fixture();
    for (const [name, reply, includeRequester, sourceUrl] of [
      ["denial", false, true, `${ORIGIN}/requester`],
      ["wrong nonce", () => ({ nonce: "c".repeat(64), buildId: BUILD, allow: true }), true, `${ORIGIN}/requester`],
      ["missing requester", true, false, `${ORIGIN}/requester`],
      ["cross-origin source", true, true, "https://evil.example/requester"],
    ]) {
      await context.test(name, async () => {
        const requester = makeClient("requester", reply);
        requester.url = sourceUrl;
        const other = makeClient("other", reply);
        const worker = fakeScope(async () => { throw new Error("unused"); });
        worker.scope.clients.matchAll = async () => includeRequester ? [requester, other] : [other];
        installPhotoStaticWorker(worker.scope, manifest);
        await worker.fire("message", { data: { type: "PHOTO_REQUEST_UPDATE", nonce }, source: requester });
        assert.equal(worker.scope.skipWaitingCalls, 0);
        if (sourceUrl.startsWith(ORIGIN)) assert.equal(requester.results.at(-1)?.type, "PHOTO_UPDATE_BLOCKED");
        else assert.equal(requester.results.length, 0);
      });
    }
  });

  it("times out a silent window, closes its port, and never treats elapsed time as consent", async () => {
    const { manifest } = await fixture();
    let receivedPort;
    const requester = {
      id: "silent",
      type: "window",
      url: `${ORIGIN}/silent`,
      results: [],
      postMessage(message, ports) {
        if (message.type === "PHOTO_UPDATE_CHECK") receivedPort = ports[0];
        else this.results.push(message);
      },
    };
    const fastUpdateTimer = {
      setTimeout(callback, milliseconds) { return setTimeout(callback, milliseconds >= 20_000 ? 0 : milliseconds); },
      clearTimeout,
    };
    const worker = fakeScope(async () => { throw new Error("unused"); }, new Map(), fastUpdateTimer);
    worker.scope.clients.matchAll = async () => [requester];
    installPhotoStaticWorker(worker.scope, manifest);
    await worker.fire("message", { data: { type: "PHOTO_REQUEST_UPDATE", nonce }, source: requester });
    assert.equal(requester.results.at(-1)?.type, "PHOTO_UPDATE_BLOCKED");
    assert.equal(worker.scope.skipWaitingCalls, 0);
    assert.ok(receivedPort);
  });

  it("counts only the first valid reply from each port and blocks when another window stays silent", async () => {
    const { manifest } = await fixture();
    const requester = {
      id: "duplicate-requester",
      type: "window",
      url: `${ORIGIN}/duplicate-requester`,
      results: [],
      postMessage(message, ports) {
        if (message.type === "PHOTO_UPDATE_CHECK") {
          const reply = { nonce: message.nonce, buildId: message.buildId, allow: true };
          ports[0].postMessage(reply);
          ports[0].postMessage(reply);
        } else this.results.push(message);
      },
    };
    const silent = {
      id: "silent-other",
      type: "window",
      url: `${ORIGIN}/silent-other`,
      postMessage() {},
    };
    const fastUpdateTimer = {
      setTimeout(callback, milliseconds) { return setTimeout(callback, milliseconds >= 20_000 ? 0 : milliseconds); },
      clearTimeout,
    };
    const worker = fakeScope(async () => { throw new Error("unused"); }, new Map(), fastUpdateTimer);
    worker.scope.clients.matchAll = async () => [requester, silent];
    installPhotoStaticWorker(worker.scope, manifest);
    await worker.fire("message", { data: { type: "PHOTO_REQUEST_UPDATE", nonce }, source: requester });
    assert.equal(requester.results.at(-1)?.type, "PHOTO_UPDATE_BLOCKED");
    assert.equal(worker.scope.skipWaitingCalls, 0);
  });

  it("shares one deadline across delayed client discovery and acknowledgement collection", async () => {
    const { manifest } = await fixture();
    let clockNow = 0;
    let nextTimer = 0;
    const timers = new Map();
    const clock = {
      setTimeout(callback, milliseconds) {
        nextTimer += 1;
        timers.set(nextTimer, { at: clockNow + Math.max(0, milliseconds), callback });
        return nextTimer;
      },
      clearTimeout(timer) { timers.delete(timer); },
      advance(milliseconds) {
        clockNow += milliseconds;
        while (true) {
          const due = [...timers.entries()]
            .filter(([, task]) => task.at <= clockNow)
            .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
          if (!due) return;
          timers.delete(due[0]);
          due[1].callback();
        }
      },
    };
    const requester = {
      id: "delayed-silent",
      type: "window",
      url: `${ORIGIN}/delayed-silent`,
      results: [],
      postMessage(message) {
        if (message.type !== "PHOTO_UPDATE_CHECK") this.results.push(message);
      },
    };
    const worker = fakeScope(async () => { throw new Error("unused"); }, new Map(), clock);
    worker.scope.clients.matchAll = async () => new Promise((resolve) => {
      worker.scope.setTimeout(() => resolve([requester]), 15_000);
    });
    installPhotoStaticWorker(worker.scope, manifest);

    const originalNow = Date.now;
    Date.now = () => clockNow;
    try {
      let settled = false;
      const update = worker.fire("message", { data: { type: "PHOTO_REQUEST_UPDATE", nonce }, source: requester })
        .then(() => { settled = true; });
      clock.advance(15_000);
      await new Promise((resolve) => setImmediate(resolve));
      clock.advance(4_999);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      clock.advance(1);
      await update;
      assert.equal(clockNow, 20_000);
      assert.equal(requester.results.at(-1)?.type, "PHOTO_UPDATE_BLOCKED");
      assert.equal(worker.scope.skipWaitingCalls, 0);
    } finally {
      Date.now = originalNow;
    }
  });
});
