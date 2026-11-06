import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it } from "node:test";

import { createPhotoWebNodeServer } from "../src/server/node-server.ts";

const ORIGIN = "https://photo.example:8443";
const HOST = "photo.example:8443";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function bounded(promise, label, milliseconds = 3_000) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function start(handler, overrides = {}) {
  const server = createPhotoWebNodeServer({ enabled: true, origin: ORIGIN, handler, ...overrides });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    server,
    async close() {
      server.closeIdleConnections();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        await bounded(new Promise((resolve) => { server.close(() => resolve()); }), "server close");
      }
    },
  };
}

function request(port, options = {}) {
  const { body, headers = {}, method = "GET", path = "/", collect = true } = options;
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      agent: false,
      headers: { Host: HOST, ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => { if (collect) chunks.push(chunk); });
      response.once("end", () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          complete: response.complete,
        });
      });
      response.once("error", reject);
    });
    outgoing.once("error", reject);
    if (body === undefined) outgoing.end();
    else outgoing.end(body);
  });
}

function rawRequest(port, message) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(3_000, () => { socket.destroy(new Error("raw request timed out")); });
    socket.once("connect", () => { socket.end(message, "latin1"); });
    socket.on("data", (chunk) => { chunks.push(chunk); });
    socket.once("error", reject);
    socket.once("close", (hadError) => {
      if (!hadError) resolve(Buffer.concat(chunks).toString("latin1"));
    });
  });
}

function statusOf(raw) {
  const match = /^HTTP\/1\.1 (\d{3}) /u.exec(raw);
  assert.ok(match, `missing HTTP status in ${JSON.stringify(raw.slice(0, 80))}`);
  return Number(match[1]);
}

function prematureRequest(port, path = "/") {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: "127.0.0.1", port, path, agent: false, headers: { Host: HOST } }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode, complete: response.complete }));
      response.once("aborted", () => resolve({ status: response.statusCode, complete: false }));
      response.once("error", () => resolve({ status: response.statusCode, complete: false }));
    });
    outgoing.once("error", (error) => {
      if (error.code === "ECONNRESET") resolve({ status: null, complete: false });
      else reject(error);
    });
    outgoing.end();
  });
}

describe("createPhotoWebNodeServer HTTP boundary", () => {
  it("creates a closed server without listening and defaults disabled or invalid options to 503", async () => {
    let calls = 0;
    const disabled = createPhotoWebNodeServer({
      enabled: false,
      origin: ORIGIN,
      handler: async () => { calls += 1; return new Response("private"); },
    });
    assert.equal(disabled.listening, false);

    const fixture = await start(async () => { calls += 1; return new Response("private"); }, {
      limits: { maxActiveRequests: 65 },
    });
    try {
      const response = await bounded(request(fixture.port), "closed response");
      assert.equal(response.status, 503);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.deepEqual(JSON.parse(response.body), { error: "temporarily_unavailable" });
      assert.equal(calls, 0);
    } finally {
      await fixture.close();
    }
  });

  it("uses the fixed HTTPS origin, preserves opaque target/cookie/origin, strips forwarding, and keeps Set-Cookie fields", async () => {
    let seen;
    const fixture = await start(async (incoming) => {
      seen = incoming;
      const headers = new Headers({
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain",
        "X-Representation": "kept",
      });
      headers.append("Set-Cookie", "one=1; Path=/; HttpOnly");
      headers.append("Set-Cookie", "two=2; Path=/; Secure");
      return new Response("ok", { status: 201, headers });
    });
    try {
      const response = await request(fixture.port, {
        path: "/api/%66ile?id=a%2Fb&opaque=%2Evalue",
        headers: {
          Cookie: "session=opaque",
          Origin: ORIGIN,
          Forwarded: "host=upstream.invalid",
          "X-Forwarded-For": "192.0.2.1",
          "X-Forwarded-Host": "upstream.invalid",
          "X-Forwarded-Proto": "http",
          "X-Forwarded-Client-Cert": "synthetic",
        },
      });
      assert.equal(response.status, 201);
      assert.equal(response.body, "ok");
      assert.equal(seen.url, `${ORIGIN}/api/%66ile?id=a%2Fb&opaque=%2Evalue`);
      assert.equal(seen.headers.get("host"), HOST);
      assert.equal(seen.headers.get("cookie"), "session=opaque");
      assert.equal(seen.headers.get("origin"), ORIGIN);
      assert.equal(seen.headers.has("forwarded"), false);
      assert.equal(seen.headers.has("x-forwarded-for"), false);
      assert.equal(seen.headers.has("x-forwarded-host"), false);
      assert.equal(seen.headers.has("x-forwarded-proto"), false);
      assert.equal(seen.headers.has("x-forwarded-client-cert"), false);
      assert.deepEqual(response.headers["set-cookie"], ["one=1; Path=/; HttpOnly", "two=2; Path=/; Secure"]);
      assert.equal(response.headers["x-representation"], "kept");
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    } finally {
      await fixture.close();
    }
  });

  it("rejects duplicate/wrong Host, absolute or normalizing targets, malformed targets, and ambiguous lengths", async (context) => {
    let calls = 0;
    const fixture = await start(async () => { calls += 1; return new Response("unexpected"); });
    const cases = [
      ["duplicate host", `GET / HTTP/1.1\r\nHost: ${HOST}\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`],
      ["wrong host", "GET / HTTP/1.1\r\nHost: photo.example\r\nConnection: close\r\n\r\n"],
      ["absolute form", `GET ${ORIGIN}/private HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`],
      ["authority-like", `GET //upstream.invalid/x HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`],
      ["double slash", `GET /a//private HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`],
      ["literal dot segment", `GET /a/../private HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`],
      ["encoded dot segment", `GET /a/%2e%2E/private HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`],
      ["backslash", `GET /a\\private HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`],
      ["fragment", `GET /a#private HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`],
      ["encoded control", `GET /a%0dprivate HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`],
      ["malformed percent", `GET /a%2 HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`],
      ["length plus transfer", `POST / HTTP/1.1\r\nHost: ${HOST}\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`],
    ];
    try {
      for (const [name, message] of cases) {
        await context.test(name, async () => {
          const raw = await bounded(rawRequest(fixture.port, message), name);
          assert.equal(statusOf(raw), name === "wrong host" ? 403 : 400);
          assert.match(raw, /Cache-Control: no-store/iu);
          assert.doesNotMatch(raw, /upstream\.invalid|unexpected/iu);
        });
      }
      assert.equal(calls, 0);
    } finally {
      await fixture.close();
    }
  });

  it("rejects excessive field count and unsupported methods without invoking the host", async () => {
    let calls = 0;
    const fixture = await start(async () => { calls += 1; return new Response("unexpected"); });
    try {
      const many = Array.from({ length: 64 }, (_unused, index) => `X-${index}: value\r\n`).join("");
      assert.equal(statusOf(await rawRequest(fixture.port,
        `GET / HTTP/1.1\r\nHost: ${HOST}\r\n${many}Connection: close\r\n\r\n`)), 400);
      const trace = await request(fixture.port, { method: "TRACE" });
      assert.equal(trace.status, 405);
      assert.match(trace.headers.allow, /GET/u);
      const connect = await rawRequest(fixture.port,
        `CONNECT upstream.invalid:443 HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
      assert.equal(statusOf(connect), 405);
      assert.equal(calls, 0);
    } finally {
      await fixture.close();
    }
  });
});

describe("request streaming and leases", () => {
  it("streams a POST into Request before the upload finishes and permits async work after normal completion", async () => {
    const firstRead = deferred();
    const finishHost = deferred();
    let signal;
    const fixture = await start(async (incoming) => {
      signal = incoming.signal;
      const reader = incoming.body.getReader();
      const first = await reader.read();
      assert.equal(Buffer.from(first.value).toString(), "first");
      firstRead.resolve();
      const second = await reader.read();
      assert.equal(Buffer.from(second.value).toString(), "second");
      assert.equal((await reader.read()).done, true);
      await nextTurn();
      assert.equal(incoming.signal.aborted, false);
      await finishHost.promise;
      return new Response("complete");
    });
    try {
      const response = new Promise((resolve, reject) => {
        const outgoing = http.request({
          host: "127.0.0.1", port: fixture.port, method: "POST", path: "/upload", agent: false,
          headers: { Host: HOST, "Transfer-Encoding": "chunked" },
        }, (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => { chunks.push(chunk); });
          incoming.once("end", () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        outgoing.once("error", reject);
        outgoing.write("first");
        void bounded(firstRead.promise, "first request chunk").then(() => { outgoing.end("second"); }, reject);
      });
      await bounded(firstRead.promise, "request streamed");
      finishHost.resolve();
      assert.deepEqual(await bounded(response, "POST response"), { status: 200, body: "complete" });
      assert.equal(signal.aborted, false);
    } finally {
      await fixture.close();
    }
  });

  it("enforces declared and chunked request budgets and never calls the handler for an early declared overflow", async () => {
    let calls = 0;
    const fixture = await start(async (incoming) => {
      calls += 1;
      try {
        await incoming.arrayBuffer();
      } catch {
        // The adapter owns the public error after aborting the body.
      }
      return new Response("old owner response");
    }, { limits: { maxRequestBytes: 5 } });
    try {
      const declared = await request(fixture.port, {
        method: "POST",
        headers: { "Content-Length": "6" },
        body: "123456",
      });
      assert.equal(declared.status, 413);
      assert.equal(calls, 0);
      const chunked = await request(fixture.port, {
        method: "POST",
        headers: { "Transfer-Encoding": "chunked" },
        body: "123456",
      });
      assert.equal(chunked.status, 413);
      assert.equal(chunked.headers["cache-control"], "no-store");
      assert.doesNotMatch(chunked.body, /old owner response/u);
      assert.equal(calls, 1);
    } finally {
      await fixture.close();
    }
  });

  it("closes an unread upload after an early handler response instead of draining it", async () => {
    const called = deferred();
    const fixture = await start(async () => {
      called.resolve();
      return new Response("early");
    });
    try {
      const result = new Promise((resolve, reject) => {
        const outgoing = http.request({
          host: "127.0.0.1", port: fixture.port, method: "POST", path: "/early", agent: false,
          headers: { Host: HOST, "Transfer-Encoding": "chunked" },
        }, (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => { chunks.push(chunk); });
          incoming.once("end", () => resolve({
            status: incoming.statusCode,
            connection: incoming.headers.connection,
            body: Buffer.concat(chunks).toString(),
          }));
        });
        outgoing.once("error", reject);
        outgoing.write(Buffer.alloc(1024, 1));
      });
      await bounded(called.promise, "early handler");
      const response = await bounded(result, "early response");
      assert.equal(response.status, 200);
      assert.equal(response.connection, "close");
      assert.equal(response.body, "early");
    } finally {
      await fixture.close();
    }
  });

  it("closes a partially-read locked upload after flushing the early response", async () => {
    const firstRead = deferred();
    const fixture = await start(async (incoming) => {
      const reader = incoming.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.equal(first.value.byteLength, 1024);
      firstRead.resolve();
      // Deliberately leave the body locked and partially unread.
      return new Response("partial");
    });
    try {
      const result = new Promise((resolve, reject) => {
        const outgoing = http.request({
          host: "127.0.0.1", port: fixture.port, method: "POST", path: "/partial", agent: false,
          headers: { Host: HOST, "Transfer-Encoding": "chunked" },
        }, (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => { chunks.push(chunk); });
          incoming.once("end", () => resolve({
            status: incoming.statusCode,
            connection: incoming.headers.connection,
            body: Buffer.concat(chunks).toString(),
          }));
        });
        outgoing.once("error", reject);
        outgoing.write(Buffer.alloc(1024, 1));
      });
      await bounded(firstRead.promise, "partial request read");
      const response = await bounded(result, "partial early response");
      assert.equal(response.status, 200);
      assert.equal(response.connection, "close");
      assert.equal(response.body, "partial");
    } finally {
      await fixture.close();
    }
  });

  it("caps concurrent work for ordinary requests until the full response task finishes", async () => {
    const release = deferred();
    let calls = 0;
    const fixture = await start(async () => {
      calls += 1;
      await release.promise;
      return new Response("first");
    }, { limits: { maxActiveRequests: 1 } });
    try {
      const first = request(fixture.port, { path: "/first" });
      while (calls === 0) await nextTurn();
      const rejected = await request(fixture.port, { path: "/second" });
      assert.equal(rejected.status, 503);
      assert.equal(calls, 1);
      release.resolve();
      assert.equal((await bounded(first, "first capped request")).body, "first");
    } finally {
      await fixture.close();
    }
  });

  it("finishes a timeout promptly, retains a noncooperative handler slot, and discards a late body", async () => {
    const late = deferred();
    const cancelled = deferred();
    let calls = 0;
    const fixture = await start(() => {
      calls += 1;
      if (calls === 1) return late.promise;
      return Promise.resolve(new Response("new"));
    }, { limits: { maxActiveRequests: 1, requestTimeoutMs: 40 } });
    try {
      const timedOut = await bounded(request(fixture.port, { path: "/slow" }), "handler timeout");
      assert.equal(timedOut.status, 503);
      const capped = await request(fixture.port, { path: "/still-retained" });
      assert.equal(capped.status, 503);
      assert.equal(calls, 1);
      late.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); } })));
      await bounded(cancelled.promise, "late response cancellation");
      await nextTurn();
      const fresh = await request(fixture.port, { path: "/fresh" });
      assert.equal(fresh.status, 200);
      assert.equal(fresh.body, "new");
      assert.equal(calls, 2);
    } finally {
      await fixture.close();
    }
  });

  it("keeps an aborted never-settling handler leased", async () => {
    const invoked = deferred();
    const aborted = deferred();
    let calls = 0;
    const fixture = await start((incoming) => {
      calls += 1;
      invoked.resolve();
      incoming.signal.addEventListener("abort", () => { aborted.resolve(); }, { once: true });
      return new Promise(() => {});
    }, { limits: { maxActiveRequests: 1, requestTimeoutMs: 2_000 } });
    try {
      const outgoing = http.request({ host: "127.0.0.1", port: fixture.port, path: "/abort", agent: false,
        headers: { Host: HOST } });
      outgoing.on("error", () => {});
      outgoing.end();
      await bounded(invoked.promise, "never handler invocation");
      outgoing.destroy();
      await bounded(aborted.promise, "handler abort signal");
      const capped = await request(fixture.port, { path: "/after-abort" });
      assert.equal(capped.status, 503);
      assert.equal(calls, 1);
    } finally {
      await fixture.close();
    }
  });
});

describe("response streaming and metadata", () => {
  it("delivers streaming chunks before the upstream response finishes", async () => {
    const release = deferred();
    const firstAtClient = deferred();
    const fixture = await start(async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        await release.promise;
        controller.enqueue(new TextEncoder().encode("second"));
        controller.close();
      },
    })));
    try {
      const complete = new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: fixture.port, path: "/stream", agent: false, headers: { Host: HOST } }, (response) => {
          const chunks = [];
          response.on("data", (chunk) => {
            chunks.push(chunk);
            if (Buffer.concat(chunks).includes("first")) firstAtClient.resolve();
          });
          response.once("end", () => resolve(Buffer.concat(chunks).toString()));
          response.once("error", reject);
        }).once("error", reject);
      });
      await bounded(firstAtClient.promise, "first streamed response chunk");
      release.resolve();
      assert.equal(await bounded(complete, "stream completion"), "firstsecond");
    } finally {
      await fixture.close();
    }
  });

  it("does not read another upstream chunk until ServerResponse drain", async () => {
    const blocked = deferred();
    let pulls = 0;
    let blockedResponse;
    const fixture = await start(async () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls <= 3) controller.enqueue(new TextEncoder().encode(String(pulls)));
        else controller.close();
      },
    }, { highWaterMark: 0 })));
    fixture.server.on("request", (incoming, outgoing) => {
      if (incoming.url !== "/backpressure") return;
      const originalWrite = outgoing.write;
      let first = true;
      outgoing.write = function (...args) {
        const result = originalWrite.apply(this, args);
        if (!first) return result;
        first = false;
        blockedResponse = outgoing;
        blocked.resolve();
        return false;
      };
    });
    try {
      const complete = request(fixture.port, { path: "/backpressure" });
      await bounded(blocked.promise, "forced response backpressure");
      await nextTurn();
      assert.equal(pulls, 1);
      blockedResponse.emit("drain");
      const response = await bounded(complete, "backpressure completion");
      assert.equal(response.status, 200);
      assert.equal(response.body, "123");
      assert.equal(pulls, 4);
    } finally {
      await fixture.close();
    }
  });

  it("cancels a slow response when the client closes", async () => {
    const cancelled = deferred();
    const fixture = await start(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("first")); },
      pull() { return new Promise(() => {}); },
      cancel() { cancelled.resolve(); },
    })));
    try {
      await bounded(new Promise((resolve, reject) => {
        const outgoing = http.get({ host: "127.0.0.1", port: fixture.port, path: "/slow-stream", agent: false,
          headers: { Host: HOST } }, (response) => {
          response.once("data", () => {
            outgoing.destroy();
            response.destroy();
            resolve();
          });
        });
        outgoing.once("error", (error) => {
          if (error.code === "ECONNRESET") resolve();
          else reject(error);
        });
      }), "client abort");
      await bounded(cancelled.promise, "upstream response cancel");
    } finally {
      await fixture.close();
    }
  });

  it("contains response stream and ServerResponse errors without process-level failures", async () => {
    const processErrors = [];
    const onUnhandled = (error) => { processErrors.push(error); };
    const onUncaught = (error) => { processErrors.push(error); };
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUncaught);
    const fixture = await start(async (incoming) => {
      if (incoming.url.endsWith("/stream-error")) {
        return new Response(new ReadableStream({ pull(controller) { controller.error(new Error("synthetic stream error")); } }));
      }
      return new Response("healthy");
    });
    fixture.server.on("request", (incoming, outgoing) => {
      if (incoming.url === "/outgoing-error") {
        queueMicrotask(() => { outgoing.emit("error", new Error("synthetic outgoing error")); });
      }
    });
    try {
      const streamFailure = await bounded(prematureRequest(fixture.port, "/stream-error"), "stream error response");
      assert.equal(streamFailure.complete, false);
      const outgoingFailure = await bounded(prematureRequest(fixture.port, "/outgoing-error"), "outgoing error response");
      assert.equal(outgoingFailure.complete, false);
      await nextTurn();
      assert.deepEqual(processErrors, []);
      const healthy = await request(fixture.port, { path: "/healthy" });
      assert.equal(healthy.status, 200);
      assert.equal(healthy.body, "healthy");
    } finally {
      await fixture.close();
      process.removeListener("unhandledRejection", onUnhandled);
      process.removeListener("uncaughtException", onUncaught);
    }
  });

  it("cancels a slow response when the adapter deadline expires", async () => {
    const cancelled = deferred();
    const fixture = await start(async () => new Response(new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled.resolve(); },
    })), { limits: { requestTimeoutMs: 40 } });
    try {
      const response = await bounded(prematureRequest(fixture.port, "/deadline-stream"), "response deadline");
      assert.equal(response.complete, false);
      await bounded(cancelled.promise, "deadline response cancel");
    } finally {
      await fixture.close();
    }
  });

  it("implements HEAD and bodyless statuses without writing an upstream body", async (context) => {
    const cancelled = [];
    const fixture = await start(async (incoming) => {
      if (incoming.url.endsWith("/empty")) return new Response(null, { status: 204 });
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("must-not-be-sent")); },
        cancel() { cancelled.push(incoming.method); },
      }), { headers: { "Content-Length": "16", "Content-Type": "text/plain" } });
    });
    try {
      await context.test("HEAD", async () => {
        const response = await request(fixture.port, { method: "HEAD", path: "/head" });
        assert.equal(response.status, 200);
        assert.equal(response.body, "");
        assert.equal(response.headers["content-length"], "16");
      });
      await context.test("204", async () => {
        const response = await request(fixture.port, { path: "/empty" });
        assert.equal(response.status, 204);
        assert.equal(response.body, "");
      });
      assert.deepEqual(cancelled, ["HEAD"]);
    } finally {
      await fixture.close();
    }
  });

  it("returns fixed 503 for Response.error, consumed bodies, invalid lengths, and excessive headers", async (context) => {
    const fixture = await start(async (incoming) => {
      if (incoming.url.endsWith("/error")) return Response.error();
      if (incoming.url.endsWith("/used")) {
        const used = new Response("private consumed body");
        await used.text();
        return used;
      }
      if (incoming.url.endsWith("/length")) return new Response("private", { headers: { "Content-Length": "invalid" } });
      const headers = new Headers();
      for (let index = 0; index < 65; index += 1) headers.set(`X-${index}`, "value");
      return new Response("private", { headers });
    });
    try {
      for (const path of ["/error", "/used", "/length", "/headers"]) {
        await context.test(path, async () => {
          const response = await request(fixture.port, { path });
          assert.equal(response.status, 503);
          assert.equal(response.headers["cache-control"], "no-store");
          assert.doesNotMatch(response.body, /private|consumed/iu);
        });
      }
    } finally {
      await fixture.close();
    }
  });

  it("bounds response bytes, accepts exact lengths, and destroys truncated responses", async (context) => {
    const fixture = await start(async (incoming) => {
      if (incoming.url.endsWith("/declared")) return new Response("x", { headers: { "Content-Length": "6" } });
      if (incoming.url.endsWith("/actual")) return new Response("123456");
      if (incoming.url.endsWith("/exact")) return new Response("12345", { headers: { "Content-Length": "5" } });
      return new Response("123", { headers: { "Content-Length": "5" } });
    }, { limits: { maxResponseBytes: 5 } });
    try {
      await context.test("declared", async () => {
        const response = await request(fixture.port, { path: "/declared" });
        assert.equal(response.status, 503);
      });
      await context.test("actual", async () => {
        const response = await prematureRequest(fixture.port, "/actual");
        assert.ok(response.status === null || response.status === 200);
        assert.equal(response.complete, false);
      });
      await context.test("truncated", async () => {
        const response = await prematureRequest(fixture.port, "/truncated");
        assert.ok(response.status === null || response.status === 200);
        assert.equal(response.complete, false);
      });
      await context.test("exact", async () => {
        const response = await request(fixture.port, { path: "/exact" });
        assert.equal(response.status, 200);
        assert.equal(response.complete, true);
        assert.equal(response.body, "12345");
      });
    } finally {
      await fixture.close();
    }
  });
});

describe("aborted request body", () => {
  it("settles a cooperative body consumer and releases its request lease", async () => {
    const entered = deferred();
    const bodySettled = deferred();
    const fixture = await start(async (incoming) => {
      if (incoming.method === "POST") {
        entered.resolve();
        try { await incoming.text(); } catch { /* client abort */ }
        finally { bodySettled.resolve(); }
      }
      return new Response("ok");
    }, { limits: { maxActiveRequests: 1 } });
    const outgoing = http.request({ host: "127.0.0.1", port: fixture.port, method: "POST",
      headers: { Host: HOST, "Content-Length": "20" }, agent: false });
    outgoing.on("error", () => {});
    try {
      outgoing.write("part");
      await bounded(entered.promise, "body consumer entered");
      outgoing.destroy();
      await bounded(bodySettled.promise, "aborted body consumer settled");
      await nextTurn();
      assert.equal((await request(fixture.port)).status, 200);
    } finally {
      outgoing.destroy();
      await fixture.close();
    }
  });
});
