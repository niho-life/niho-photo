import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as defer } from "node:timers/promises";
import { describe, it } from "node:test";

import { createPhotoWebFetchHost } from "../src/server/fetch-host.ts";

const ORIGIN = "https://photo.example:8443";

describe("retained dependency budget", () => {
  it("keeps aborted ports leased until settlement, shares auth/cloud limits, and preserves static serving", async () => {
    let calls = 0;
    let release;
    let cancelled = 0;
    const cloudHandler = () => {
      calls += 1;
      return new Promise((resolve) => { release ??= resolve; });
    };
    const host = createPhotoWebFetchHost(options({ cloudHandler }));
    for (let index = 0; index < 16; index += 1) {
      const controller = new AbortController();
      const response = host(new Request(`${ORIGIN}/cloud-probe`, { signal: controller.signal }));
      controller.abort();
      assert.equal((await promptly(response)).status, 499);
    }
    assert.equal(calls, 16);
    assert.equal((await host(new Request(`${ORIGIN}/cloud-probe`))).status, 503);
    assert.equal((await host(new Request(`${ORIGIN}/auth/session`))).status, 503);
    assert.equal(calls, 16);
    assert.equal((await host(new Request(`${ORIGIN}/`))).status, 200);
    release(new Response(new ReadableStream({ cancel() { cancelled += 1; } })));
    await defer();
    assert.equal(cancelled, 1);
    assert.equal((await host(new Request(`${ORIGIN}/auth/session`))).status, 200);
    const separate = createPhotoWebFetchHost(options());
    assert.equal((await separate(new Request(`${ORIGIN}/auth/session`))).status, 200);
  });
});

async function promptly(promise, milliseconds = 100) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("host did not settle promptly")), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function cancellationResponse(mode, calls, status = 503) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("PRIVATE_BODY"));
    },
    cancel() {
      calls.count += 1;
      if (mode === "never") return new Promise(() => {});
      if (mode === "throw") throw new Error("private cancel throw");
      return Promise.reject(new Error("private cancel rejection"));
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/html", "X-Private": "secret" } });
}

function staticStore() {
  const bytes = new TextEncoder().encode("<!doctype html><p>app</p>");
  return {
    build: {},
    get(path, head = false) {
      if (path !== "/" && path !== "/assets/app.js") return null;
      return new Response(head ? null : bytes, {
        headers: {
          "Cache-Control": path === "/" ? "no-store" : "public, max-age=31536000, immutable",
          "Content-Length": String(bytes.byteLength),
          "Content-Type": path === "/" ? "text/html" : "application/javascript",
          ETag: '"hash"',
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  };
}

function fakeAuth(overrides = {}) {
  const fallback = async () => Response.json({ ok: true });
  return {
    start: fallback,
    callback: fallback,
    session: fallback,
    refresh: fallback,
    logout: fallback,
    cancel: fallback,
    ...overrides,
  };
}

function options(overrides = {}) {
  return {
    enabled: true,
    origin: ORIGIN,
    auth: fakeAuth(),
    staticStore: staticStore(),
    documentHeaders: {
      "Content-Security-Policy": "default-src 'self'",
      "Referrer-Policy": "no-referrer",
    },
    navigationErrorCopy: { title: "認証エラー", message: "もう一度お試しください。", homeLabel: "ホームへ" },
    ...overrides,
  };
}

describe("createPhotoWebFetchHost", () => {
  it("dispatches only the six exact C01 public paths to their matching methods", async () => {
    const routes = {
      "/auth/start": "start",
      "/auth/callback": "callback",
      "/auth/session": "session",
      "/auth/refresh": "refresh",
      "/auth/logout": "logout",
      "/auth/cancel": "cancel",
    };
    const auth = fakeAuth();
    for (const method of Object.values(routes)) auth[method] = async () => new Response(method);
    const host = createPhotoWebFetchHost(options({ auth }));
    for (const [route, method] of Object.entries(routes)) {
      assert.equal(await (await host(new Request(`${ORIGIN}${route}`))).text(), method);
    }
    assert.equal((await host(new Request(`${ORIGIN}/auth/start/`))).status, 404);
  });

  it("routes fixed C01 methods and preserves successful relay body, CSP, referrer policy, and cookies", async () => {
    let received;
    const relay = "<!doctype html><form>relay</form>";
    const host = createPhotoWebFetchHost(options({
      auth: fakeAuth({
        start: async (request) => {
          received = request;
          const headers = new Headers({
            "Cache-Control": "private",
            "Content-Security-Policy": "default-src 'none'; script-src 'nonce-c01'",
            "Content-Type": "text/html; charset=utf-8",
            "Referrer-Policy": "origin",
          });
          headers.append("Set-Cookie", "pending=one; Path=/; HttpOnly");
          headers.append("Set-Cookie", "old=; Max-Age=0; Path=/");
          return new Response(relay, { headers });
        },
      }),
    }));
    const request = new Request(`${ORIGIN}/auth/start`, { method: "POST", body: "" });
    const response = await host(request);
    assert.equal(received, request);
    assert.equal(await response.text(), relay);
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; script-src 'nonce-c01'");
    assert.equal(response.headers.get("referrer-policy"), "origin");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(response.headers.getSetCookie(), ["pending=one; Path=/; HttpOnly", "old=; Max-Age=0; Path=/"]);
  });

  it("renders escaped generic HTML only for start/callback navigation failures without reflection", async () => {
    const headers = new Headers({
      "Content-Type": "text/html",
      Location: "https://owner.invalid/private?state=HEADERSECRET",
      "Referrer-Policy": "origin",
      "X-Owner-Detail": "private detail",
    });
    headers.append("Set-Cookie", "pending=; Max-Age=0; Path=/");
    const host = createPhotoWebFetchHost(options({
      auth: fakeAuth({ start: async () => new Response("private_url=https://owner.invalid&state=SECRET", { status: 400, headers }) }),
      navigationErrorCopy: { title: "失敗 <写真>", message: "再試行 & 安全", homeLabel: '戻る "home"' },
    }));
    const response = await host(new Request(`${ORIGIN}/auth/start?state=QUERYSECRET`, {
      method: "POST",
      headers: { Accept: "text/html" },
    }));
    const html = await response.text();
    assert.equal(response.status, 400);
    assert.match(html, /失敗 &lt;写真&gt;/);
    assert.match(html, /再試行 &amp; 安全/);
    assert.match(html, /戻る &quot;home&quot;/);
    assert.match(html, /href="\/"/);
    assert.equal(/owner\.invalid|SECRET|QUERYSECRET/.test(html), false);
    assert.equal(response.headers.has("location"), false);
    assert.equal(response.headers.has("x-owner-detail"), false);
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(response.headers.getSetCookie(), ["pending=; Max-Age=0; Path=/"]);
  });

  it("keeps session/API JSON bodies while suppressing dynamic caching", async () => {
    const host = createPhotoWebFetchHost(options({
      auth: fakeAuth({ session: async () => Response.json({ error: "unauthenticated" }, { status: 401 }) }),
      cloudHandler: async () => new Response('{"item":1}', {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=99",
          "Content-Type": "application/json",
          "Set-Cookie": "cloud=1; Path=/",
        },
      }),
    }));
    const session = await host(new Request(`${ORIGIN}/auth/session`, { method: "GET" }));
    assert.equal(session.status, 401);
    assert.deepEqual(await session.json(), { error: "unauthenticated" });
    assert.match(session.headers.get("content-type"), /^application\/json/);
    const cloud = await host(new Request(`${ORIGIN}/api/items`, { headers: { Authorization: "Bearer opaque" } }));
    assert.equal(await cloud.text(), '{"item":1}');
    assert.equal(cloud.headers.get("cache-control"), "no-store");
    assert.equal(cloud.headers.get("x-content-type-options"), "nosniff");
    assert.equal(cloud.headers.has("access-control-allow-origin"), false);
    assert.deepEqual(cloud.headers.getSetCookie(), ["cloud=1; Path=/"]);
  });

  it("uses exact origin/static routing and never falls back to the app document", async () => {
    const seen = [];
    const host = createPhotoWebFetchHost(options({ cloudHandler: async (request) => { seen.push(request); return null; } }));
    const root = await host(new Request(`${ORIGIN}/`, { headers: { Cookie: "secret=1", Authorization: "Bearer secret" } }));
    assert.match(await root.text(), /<p>app<\/p>/);
    assert.equal(root.headers.get("content-security-policy"), "default-src 'self'");
    assert.equal((await host(new Request(`${ORIGIN}/?x=1`))).status, 400);
    const method = await host(new Request(`${ORIGIN}/assets/app.js`, { method: "POST" }));
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "GET, HEAD");
    assert.equal((await host(new Request(`${ORIGIN}/missing`))).status, 404);
    assert.equal(seen.length, 1);
    assert.equal((await host(new Request("https://photo.example/", { headers: { "X-Forwarded-Host": "photo.example:8443" } }))).status, 400);
    assert.equal((await host(new Request("https://photo.example:9443/", { headers: { "X-Forwarded-Host": "photo.example:8443" } }))).status, 400);
  });

  it("passes the exact C02 Request and disposes a late body after abort", async () => {
    let release;
    let received;
    let cancelled = false;
    const pending = new Promise((resolve) => { release = resolve; });
    const host = createPhotoWebFetchHost(options({
      cloudHandler: async (request) => {
        received = request;
        await pending;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      },
    }));
    const controller = new AbortController();
    const request = new Request(`${ORIGIN}/api/slow`, { signal: controller.signal });
    const promise = host(request);
    controller.abort();
    release();
    const response = await promise;
    assert.equal(received, request);
    assert.equal(response.status, 499);
    assert.deepEqual(await response.json(), { error: "request_cancelled" });
    assert.equal(cancelled, true);
  });

  it("returns 499 promptly when noncooperative auth or cloud ports ignore abort", async (context) => {
    for (const kind of ["auth", "cloud"]) {
      await context.test(kind, async () => {
        let calls = 0;
        const stopped = () => {
          calls += 1;
          return new Promise(() => {});
        };
        const host = kind === "auth"
          ? createPhotoWebFetchHost(options({ auth: fakeAuth({ session: stopped }) }))
          : createPhotoWebFetchHost(options({ cloudHandler: stopped }));
        const controller = new AbortController();
        const request = new Request(`${ORIGIN}${kind === "auth" ? "/auth/session" : "/api/stopped"}`, {
          signal: controller.signal,
        });
        const pending = host(request);
        controller.abort();
        const response = await promptly(pending);
        assert.equal(calls, 1);
        assert.equal(response.status, 499);
        assert.deepEqual(await response.json(), { error: "request_cancelled" });
      });
    }
  });

  it("does not start a handler for an already-aborted request", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const host = createPhotoWebFetchHost(options({
      cloudHandler: async () => { calls += 1; return new Response("late"); },
    }));
    const response = await promptly(host(new Request(`${ORIGIN}/api/aborted`, { signal: controller.signal })));
    assert.equal(response.status, 499);
    assert.equal(calls, 0);
  });

  it("cancels a late response once and absorbs a late rejection after returning 499", async () => {
    let resolveLate;
    let rejectLate;
    const calls = { count: 0 };
    const unhandled = [];
    const observeUnhandled = (reason) => { unhandled.push(reason); };
    process.on("unhandledRejection", observeUnhandled);
    try {
      const resolvingHost = createPhotoWebFetchHost(options({
        cloudHandler: () => new Promise((resolve) => { resolveLate = resolve; }),
      }));
      const resolveController = new AbortController();
      const resolving = resolvingHost(new Request(`${ORIGIN}/api/late-response`, { signal: resolveController.signal }));
      resolveController.abort();
      const cancelledResponse = await promptly(resolving);
      assert.equal(cancelledResponse.status, 499);
      resolveLate(cancellationResponse("never", calls));
      await defer();
      assert.equal(calls.count, 1);

      const rejectingHost = createPhotoWebFetchHost(options({
        cloudHandler: () => new Promise((_resolve, reject) => { rejectLate = reject; }),
      }));
      const rejectController = new AbortController();
      const rejecting = rejectingHost(new Request(`${ORIGIN}/api/late-rejection`, { signal: rejectController.signal }));
      rejectController.abort();
      assert.equal((await promptly(rejecting)).status, 499);
      rejectLate(new Error("private late rejection"));
      await defer();
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("never waits for body cancellation in navigation failures or late 499 cleanup", async (context) => {
    for (const mode of ["never", "throw", "reject"]) {
      await context.test(mode, async () => {
        const navigationCalls = { count: 0 };
        const navigationHost = createPhotoWebFetchHost(options({
          auth: fakeAuth({ start: async () => cancellationResponse(mode, navigationCalls) }),
        }));
        const navigation = await promptly(navigationHost(new Request(`${ORIGIN}/auth/start`, {
          method: "POST",
          headers: { Accept: "text/html" },
        })));
        assert.equal(navigation.status, 503);
        assert.match(await navigation.text(), /認証エラー/);
        assert.equal(navigationCalls.count, 1);

        let resolveLate;
        const lateCalls = { count: 0 };
        const lateHost = createPhotoWebFetchHost(options({
          auth: fakeAuth({ start: () => new Promise((resolve) => { resolveLate = resolve; }) }),
        }));
        const controller = new AbortController();
        const pending = lateHost(new Request(`${ORIGIN}/auth/start`, {
          method: "POST",
          headers: { Accept: "text/html" },
          signal: controller.signal,
        }));
        controller.abort();
        const aborted = await promptly(pending);
        assert.equal(aborted.status, 499);
        assert.match(aborted.headers.get("content-type"), /^application\/json/);
        assert.equal((await aborted.text()).includes("PRIVATE_BODY"), false);
        resolveLate(cancellationResponse(mode, lateCalls));
        await defer();
        assert.equal(lateCalls.count, 1);
      });
    }
  });

  it("removes its abort listener after success, rejection, and abort", async (context) => {
    for (const mode of ["success", "rejection", "abort"]) {
      await context.test(mode, async () => {
        const controller = new AbortController();
        const request = new Request(`${ORIGIN}/api/listener`, { signal: controller.signal });
        const baseline = getEventListeners(request.signal, "abort").length;
        const host = createPhotoWebFetchHost(options({
          cloudHandler: mode === "success" ? async () => new Response("ok")
            : mode === "rejection" ? async () => { throw new Error("private"); }
              : () => new Promise(() => {}),
        }));
        const pending = host(request);
        if (mode === "abort") controller.abort();
        await promptly(pending);
        assert.equal(getEventListeners(request.signal, "abort").length, baseline);
      });
    }
  });

  it("closes invalid or uncloneable auth, cloud, and static responses to a generic 503", async (context) => {
    const consumed = async () => {
      const response = new Response("PRIVATE_CONSUMED_BODY", { headers: { "X-Private": "secret" } });
      await response.text();
      return response;
    };
    const cases = [
      ["auth error response", () => createPhotoWebFetchHost(options({ auth: fakeAuth({ session: async () => Response.error() }) })), "/auth/session"],
      ["cloud error response", () => createPhotoWebFetchHost(options({ cloudHandler: async () => Response.error() })), "/api/error"],
      ["static error response", () => createPhotoWebFetchHost(options({ staticStore: { build: {}, get: () => Response.error() } })), "/"],
      ["auth consumed body", () => createPhotoWebFetchHost(options({ auth: fakeAuth({ session: consumed }) })), "/auth/session"],
      ["cloud consumed body", () => createPhotoWebFetchHost(options({ cloudHandler: consumed })), "/api/consumed"],
      ["static consumed body", async () => {
        const response = await consumed();
        return createPhotoWebFetchHost(options({ staticStore: { build: {}, get: () => response } }));
      }, "/"],
    ];
    for (const [name, makeHost, route] of cases) {
      await context.test(name, async () => {
        const host = await makeHost();
        const response = await promptly(host(new Request(`${ORIGIN}${route}`)));
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: "temporarily_unavailable" });
        assert.equal([...response.headers].some(([header]) => header === "x-private"), false);
      });
    }
  });

  it("turns a C02 exception into a detail-free 503", async () => {
    const host = createPhotoWebFetchHost(options({
      cloudHandler: async () => { throw new Error("private /owner/path credential=secret"); },
    }));
    const response = await host(new Request(`${ORIGIN}/api/failure`));
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(/owner|credential|secret/.test(body), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("snapshots the configured origin port and trusted port functions", async () => {
    let oldCalls = 0;
    let newCalls = 0;
    const mutable = options({
      auth: fakeAuth({ session: async () => { oldCalls += 1; return Response.json({ version: "old" }); } }),
    });
    const host = createPhotoWebFetchHost(mutable);
    mutable.origin = "https://photo.example:9443";
    mutable.auth.session = async () => { newCalls += 1; return Response.json({ version: "new" }); };
    mutable.documentHeaders["Content-Security-Policy"] = "default-src *";
    const response = await host(new Request(`${ORIGIN}/auth/session`));
    assert.deepEqual(await response.json(), { version: "old" });
    assert.equal(oldCalls, 1);
    assert.equal(newCalls, 0);
    assert.equal((await host(new Request("https://photo.example:9443/auth/session"))).status, 400);
  });

  it("fails disabled/invalid configuration closed without invoking dependencies", async (context) => {
    await context.test("disabled", async () => {
      let reads = 0;
      const disabled = {
        enabled: false,
        get origin() { reads += 1; throw new Error("must not read"); },
        get auth() { reads += 1; throw new Error("must not read"); },
        get staticStore() { reads += 1; throw new Error("must not read"); },
      };
      const response = await createPhotoWebFetchHost(disabled)(new Request(`${ORIGIN}/`));
      assert.equal(response.status, 503);
      assert.equal(reads, 0);
    });
    for (const documentHeaders of [
      { "Referrer-Policy": "no-referrer" },
      { "Content-Security-Policy": "default-src 'self'", "Cache-Control": "public" },
      { "Content-Security-Policy": "default-src 'self'", "Set-Cookie": "x=1" },
      { "Content-Security-Policy": "default-src 'self'", "Access-Control-Allow-Origin": "*" },
      { "Content-Security-Policy": "default-src 'self'", "Transfer-Encoding": "chunked" },
    ]) {
      await context.test(JSON.stringify(documentHeaders), async () => {
        let calls = 0;
        const response = await createPhotoWebFetchHost(options({
          documentHeaders,
          staticStore: { build: {}, get() { calls += 1; return new Response("unsafe"); } },
        }))(new Request(`${ORIGIN}/`));
        assert.equal(response.status, 503);
        assert.equal(calls, 0);
      });
    }
    for (const origin of ["http://photo.example/", "https://user@photo.example/", "https://photo.example/path", "https://photo.example/?x=1"] ) {
      await context.test(origin, async () => {
        assert.equal((await createPhotoWebFetchHost(options({ origin }))(new Request(`${ORIGIN}/`))).status, 503);
      });
    }
  });
});
