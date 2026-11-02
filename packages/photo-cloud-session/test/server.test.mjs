import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AUTH_PUBLIC_PATHS,
  PHOTO_CREDENTIAL_COOKIE,
  PHOTO_PENDING_COOKIE,
  PhotoAuthorizationError,
  createPhotoAuthService,
  parsePhotoAuthConfiguration,
} from "../src/server/index.ts";
import { parsePendingAttempt, setCredentialCookie } from "../src/server/cookies.ts";
import { MAX_CREDENTIAL_BYTES } from "../src/server/protocol.ts";
import {
  createPhotoWebAuthAdapter,
  photoWebAuth,
} from "../../../apps/photo-web/src/server/auth.ts";

const NOW = Date.parse("2026-11-03T00:00:00.000Z");
const PHOTO_ORIGIN = "https://photo.niho.life";
const NIHO_ORIGIN = "https://niho.life";
const HOST = "photo.niho.life";
const CREDENTIAL = "synthetic-photo-credential-alpha-0001";

const config = {
  enabled: true,
  photoOrigin: PHOTO_ORIGIN,
  nihoOrigin: NIHO_ORIGIN,
  clientId: "niho-photo-web",
  audience: "niho-photo",
  callbackPath: "/auth/callback",
  endpoints: {
    begin: "/synthetic/photo-auth/begin",
    exchange: "/synthetic/photo-auth/exchange",
    introspect: "/synthetic/photo-auth/introspect",
    refresh: "/synthetic/photo-auth/refresh",
    revoke: "/synthetic/photo-auth/revoke",
    cancel: "/synthetic/photo-auth/cancel",
    confirmation: "/synthetic/photo-auth/confirmation",
  },
  copy: {
    startTitle: "接続を確認しています",
    startMessage: "本人確認へ移動します。",
    startSubmitLabel: "続ける",
    relayTitle: "写真に戻ります",
    relayMessage: "写真に安全に戻ります。",
    relaySubmitLabel: "戻る",
  },
};

function actor(overrides = {}) {
  return {
    userId: "synthetic-user-alpha",
    sessionId: "synthetic-parent-session-alpha",
    sessionEpoch: "synthetic-server-epoch-1",
    transport: "browser-session",
    expiresAt: "2026-11-03T01:00:00.000Z",
    ...overrides,
  };
}

function actorEnvelope(overrides = {}) {
  const value = actor(overrides);
  return {
    actor: { id: value.userId },
    sessionId: value.sessionId,
    sessionEpoch: value.sessionEpoch,
    expiresAt: value.expiresAt,
    clientId: config.clientId,
    audience: config.audience,
    refreshRequired: false,
  };
}

function credentialEnvelope(overrides = {}) {
  return { ...actorEnvelope(overrides), credential: CREDENTIAL };
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function request(path, { method = "POST", origin = PHOTO_ORIGIN, host = HOST, headers = {}, body } = {}) {
  return new Request(`${PHOTO_ORIGIN}${path}`, {
    method,
    headers: { host, origin, ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

function callbackRequest(body, options = {}) {
  return request(AUTH_PUBLIC_PATHS.callback, {
    origin: options.origin ?? PHOTO_ORIGIN,
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.headers ?? {}),
    },
    body,
  });
}

function randomSequence() {
  let counter = 0;
  return () => String.fromCharCode(65 + (counter++ % 20)).repeat(43);
}

function cookiePair(response, name) {
  const value = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  assert.ok(value, `missing ${name}`);
  return value.split(";", 1)[0];
}

function cookieValue(pair) {
  return pair.slice(pair.indexOf("=") + 1);
}

function createProducer(overrides = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body, init });
    if (overrides[path]) return overrides[path]({ path, body, init, calls });
    switch (path) {
      case config.endpoints.begin:
        return json({
          attemptId: "synthetic-attempt-id-alpha-0001",
          expiresAt: "2026-11-03T00:05:00.000Z",
          confirmationPath: config.endpoints.confirmation,
        });
      case config.endpoints.exchange:
      case config.endpoints.refresh:
        return json(credentialEnvelope());
      case config.endpoints.introspect:
        return json(actorEnvelope());
      case config.endpoints.cancel:
      case config.endpoints.revoke:
        return new Response(null, { status: 204 });
      default:
        throw new Error("unexpected synthetic path");
    }
  };
  return { fetch, calls };
}

function service(producer = createProducer(), overrides = {}) {
  return {
    producer,
    auth: createPhotoAuthService({
      configuration: config,
      fetch: producer.fetch,
      now: () => NOW,
      randomValue: randomSequence(),
      ...overrides,
    }),
  };
}

async function begin(auth) {
  const response = await auth.start(request(AUTH_PUBLIC_PATHS.start));
  assert.equal(response.status, 200);
  const pendingCookie = cookiePair(response, PHOTO_PENDING_COOKIE);
  const pending = parsePendingAttempt(cookieValue(pendingCookie));
  assert.ok(pending);
  return { response, pendingCookie, pending };
}

test("startup config accepts only exact Photo product values and explicit closed paths", () => {
  const parsed = parsePhotoAuthConfiguration(config);
  assert.deepEqual(parsed, config);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.endpoints), true);
  assert.equal(Object.isFrozen(parsed.copy), true);
  config.endpoints.begin = "/synthetic/mutated";
  assert.equal(parsed.endpoints.begin, "/synthetic/photo-auth/begin");
  config.endpoints.begin = "/synthetic/photo-auth/begin";
  config.copy.startTitle = "mutated";
  assert.equal(parsed.copy.startTitle, "接続を確認しています");
  config.copy.startTitle = "接続を確認しています";
  assert.equal(parsePhotoAuthConfiguration({ ...config, photoOrigin: "https://other.invalid" }), null);
  assert.equal(parsePhotoAuthConfiguration({ ...config, clientId: "editor-web" }), null);
  assert.equal(parsePhotoAuthConfiguration({ ...config, endpoints: { ...config.endpoints, begin: "https://private.invalid/start" } }), null);
  assert.equal(parsePhotoAuthConfiguration({ ...config, extra: true }), null);
});

test("missing config or feature flag OFF stays fail-closed with 503", async () => {
  const auth = createPhotoAuthService({ configuration: null, fetch: async () => { throw new Error("must not call"); } });
  for (const [method, path] of [
    ["start", AUTH_PUBLIC_PATHS.start],
    ["callback", AUTH_PUBLIC_PATHS.callback],
    ["session", AUTH_PUBLIC_PATHS.session],
    ["refresh", AUTH_PUBLIC_PATHS.refresh],
    ["logout", AUTH_PUBLIC_PATHS.logout],
    ["cancel", AUTH_PUBLIC_PATHS.cancel],
  ]) {
    const response = await auth[method](request(path, { method: method === "session" ? "GET" : "POST" }));
    assert.equal(response.status, 503);
  }
});

test("Photo Web host adapter is unconfigured by default and OFF ignores supplied config", async () => {
  assert.equal((await photoWebAuth.start(request(AUTH_PUBLIC_PATHS.start))).status, 503);
  const disabled = createPhotoWebAuthAdapter({ enabled: false, configuration: config });
  assert.equal((await disabled.start(request(AUTH_PUBLIC_PATHS.start))).status, 503);
});

test("start creates S256/state, fixed confirmation POST, and host-only HttpOnly cookie", async () => {
  const { auth, producer } = service();
  const { response, pending } = await begin(auth);
  const call = producer.calls[0];
  assert.equal(call.path, config.endpoints.begin);
  assert.deepEqual(Object.keys(call.body).sort(), [
    "clientId",
    "codeChallenge",
    "codeChallengeMethod",
    "protocolVersion",
    "responseMode",
    "state",
  ]);
  assert.equal(call.body.clientId, "niho-photo-web");
  assert.equal(call.body.protocolVersion, 2);
  assert.equal(call.body.codeChallengeMethod, "S256");
  assert.equal(call.body.codeChallenge, createHash("sha256").update(pending.verifier, "ascii").digest("base64url"));
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.cache, "no-store");
  assert.equal(call.init.redirect, "error");
  const html = await response.text();
  assert.match(html, /method="post"/);
  assert.match(html, /synthetic\/photo-auth\/confirmation/);
  assert.doesNotMatch(html, new RegExp(pending.verifier));
  const setCookie = response.headers.getSetCookie().join("\n");
  assert.match(setCookie, /__Host-niho-photo-pending=/);
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Lax; Path=\//);
  assert.doesNotMatch(setCookie, /editor/i);
  assert.match(response.headers.get("content-security-policy"), /script-src 'nonce-/);
  assert.equal(response.headers.get("referrer-policy"), "origin");
});

test("begin accepts a bounded short opaque ID and rejects an extra secret field", async () => {
  const shortIdProducer = createProducer({
    [config.endpoints.begin]: () => json({
      attemptId: "a",
      expiresAt: "2026-11-03T00:05:00.000Z",
      confirmationPath: config.endpoints.confirmation,
    }),
  });
  assert.equal((await service(shortIdProducer).auth.start(request(AUTH_PUBLIC_PATHS.start))).status, 200);

  const legacyExtra = createProducer({
    [config.endpoints.begin]: () => json({
      attemptId: "a",
      extraSecret: "must-not-be-accepted",
      expiresAt: "2026-11-03T00:05:00.000Z",
      confirmationPath: config.endpoints.confirmation,
    }),
  });
  assert.equal((await service(legacyExtra).auth.start(request(AUTH_PUBLIC_PATHS.start))).status, 503);
});

test("begin cancels the previous attempt before creating a new one", async () => {
  const { auth, producer } = service();
  const first = await begin(auth);
  producer.calls.length = 0;
  const response = await auth.start(request(AUTH_PUBLIC_PATHS.start, { headers: { cookie: first.pendingCookie } }));
  assert.equal(response.status, 200);
  assert.deepEqual(producer.calls.map((call) => call.path), [config.endpoints.cancel, config.endpoints.begin]);
  assert.deepEqual(producer.calls[0].body, {
    clientId: config.clientId,
    attemptId: first.pending.attemptId,
    codeVerifier: first.pending.verifier,
  });
});

test("cross-site callback relays by same-origin POST before pending cookie verification", async () => {
  const { auth, producer } = service();
  const response = await auth.callback(callbackRequest(
    `code=${"c".repeat(20)}&state=${"s".repeat(43)}`,
    { origin: NIHO_ORIGIN },
  ));
  assert.equal(response.status, 200);
  assert.equal(producer.calls.length, 0);
  const html = await response.text();
  assert.match(html, /action="https:\/\/photo\.niho\.life\/auth\/callback"/);
  assert.match(html, /name="code"/);
  assert.match(html, /name="state"/);
  assert.match(response.headers.get("content-security-policy"), /form-action 'self'/);
  assert.equal(response.headers.get("referrer-policy"), "origin");
});

test("same-origin callback exchanges once, replaces only Photo cookie, and removes secrets from URL", async () => {
  const { auth, producer } = service();
  const started = await begin(auth);
  producer.calls.length = 0;
  const code = "synthetic-code-alpha-0001";
  const response = await auth.callback(callbackRequest(
    `code=${code}&state=${started.pending.state}`,
    { cookie: started.pendingCookie },
  ));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  assert.equal(response.headers.get("location").includes(code), false);
  assert.equal(producer.calls[0].path, config.endpoints.exchange);
  assert.deepEqual(producer.calls[0].body, {
    clientId: config.clientId,
    audience: config.audience,
    attemptId: started.pending.attemptId,
    code,
    codeVerifier: started.pending.verifier,
  });
  assert.equal("replaceCredential" in producer.calls[0].body, false);
  const cookies = response.headers.getSetCookie().join("\n");
  assert.match(cookies, /__Host-niho-photo-pending=; Max-Age=0/);
  assert.match(cookies, /__Host-niho-photo-credential=synthetic-photo-credential/);
  assert.equal((await response.text()).includes(CREDENTIAL), false);
  const replay = await auth.callback(callbackRequest(
    `code=${code}&state=${started.pending.state}`,
  ));
  assert.equal(replay.status, 400);
});

test("exchange replaceCredential can only come from the current Photo cookie", async () => {
  const { auth, producer } = service();
  const started = await begin(auth);
  producer.calls.length = 0;
  const cookie = `${started.pendingCookie}; ${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}`;
  const response = await auth.callback(callbackRequest(
    `code=${"c".repeat(20)}&state=${started.pending.state}`,
    { cookie },
  ));
  assert.equal(response.status, 303);
  assert.equal(producer.calls[0].body.replaceCredential, CREDENTIAL);
});

test("callback rejects duplicate fields, query, wrong host/origin, oversized body, and aborted body", async () => {
  const { auth, producer } = service();
  const cases = [
    callbackRequest(`code=${"c".repeat(20)}&code=${"d".repeat(20)}&state=${"s".repeat(43)}`),
    new Request(`${PHOTO_ORIGIN}/auth/callback?code=hidden`, { method: "POST", headers: { host: HOST, origin: PHOTO_ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "code=x" }),
    callbackRequest(`code=${"c".repeat(20)}&state=${"s".repeat(43)}`, { headers: { host: "evil.invalid" } }),
    callbackRequest(`code=${"c".repeat(20)}&state=${"s".repeat(43)}`, { origin: "https://evil.invalid" }),
    callbackRequest("x", { headers: { "content-length": "4097" } }),
  ];
  for (const candidate of cases) assert.equal((await auth.callback(candidate)).status, candidate === cases[4] ? 413 : 400);
  const controller = new AbortController();
  controller.abort();
  const aborted = new Request(`${PHOTO_ORIGIN}/auth/callback`, {
    method: "POST",
    headers: { host: HOST, origin: PHOTO_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: `code=${"c".repeat(20)}&state=${"s".repeat(43)}`,
    signal: controller.signal,
  });
  assert.equal((await auth.callback(aborted)).status, 400);
  assert.equal(producer.calls.length, 0);
});

test("callback body timeout is bounded through injected timers without waiting", async () => {
  let fire;
  const stream = new ReadableStream({ pull() { return new Promise(() => {}); } });
  const { auth } = service(createProducer(), {
    callbackBody: {
      setTimer: (callback) => { fire = callback; return 1; },
      clearTimer: () => {},
    },
  });
  const pending = auth.callback(new Request(`${PHOTO_ORIGIN}/auth/callback`, {
    method: "POST",
    headers: { host: HOST, origin: PHOTO_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: stream,
    duplex: "half",
  }));
  await Promise.resolve();
  fire();
  assert.equal((await pending).status, 400);
});

test("callback with an already-used or locked body returns fixed 400", async () => {
  const { auth } = service();
  const used = callbackRequest(`code=${"c".repeat(20)}&state=${"s".repeat(43)}`);
  await used.text();
  assert.equal((await auth.callback(used)).status, 400);

  const locked = callbackRequest(`code=${"c".repeat(20)}&state=${"s".repeat(43)}`);
  const reader = locked.body.getReader();
  assert.equal((await auth.callback(locked)).status, 400);
  reader.releaseLock();
});

test("duplicate cookies and ambiguous bearer plus cookie are rejected", async () => {
  const { auth, producer } = service();
  const duplicate = `${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}; ${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}`;
  const duplicateResponse = await auth.session(request(AUTH_PUBLIC_PATHS.session, { method: "GET", headers: { cookie: duplicate } }));
  assert.equal(duplicateResponse.status, 401);
  const ambiguousResponse = await auth.session(request(AUTH_PUBLIC_PATHS.session, {
    method: "GET",
    headers: { cookie: `${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}`, authorization: "Bearer synthetic-native-proof" },
  }));
  assert.equal(ambiguousResponse.status, 401);
  assert.equal(producer.calls.length, 0);
});

test("every protected request introspects and returns only canonical actor metadata", async () => {
  const { auth, producer } = service();
  const response = await auth.session(new Request(`${PHOTO_ORIGIN}${AUTH_PUBLIC_PATHS.session}`, {
    method: "GET",
    headers: { host: HOST, cookie: `${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}` },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), actor());
  assert.deepEqual(producer.calls.map((call) => call.path), [config.endpoints.introspect]);
  assert.deepEqual(producer.calls[0].body, {
    clientId: config.clientId,
    audience: config.audience,
    credential: CREDENTIAL,
  });
  assert.equal(response.headers.getSetCookie().length, 0);
});

test("verified identity IDs and revocation epochs remain opaque", async () => {
  const expected = actor({ userId: "u:1", sessionId: "parent:1", sessionEpoch: "revocation:1/active" });
  const { auth } = service(createProducer({
    [config.endpoints.introspect]: () => json(actorEnvelope(expected)),
  }));
  const actual = await auth.authorize(request("/api/library", {
    method: "GET",
    headers: { cookie: `${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}` },
  }));
  assert.deepEqual(actual, expected);
});

test("wrong client and invalid or excessive expiry fail closed without leaking producer data", async () => {
  for (const payload of [
    { ...actorEnvelope(), clientId: "editor-web" },
    actorEnvelope({ expiresAt: "2027-12-03T01:00:00.000Z" }),
    actorEnvelope({ expiresAt: "not-an-instant" }),
    { ...actorEnvelope(), actor: { ...actor(), displayName: "must-not-pass" } },
    { ...actorEnvelope(), transport: "browser-session" },
    { ...actorEnvelope(), sessionEpoch: undefined },
  ]) {
    const producer = createProducer({ [config.endpoints.introspect]: () => json(payload) });
    const { auth } = service(producer);
    const response = await auth.session(request(AUTH_PUBLIC_PATHS.session, {
      method: "GET",
      headers: { cookie: `${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}` },
    }));
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /editor|displayName|2027/);
  }
});

test("refresh requires introspected stable user, parent session, and server epoch", async () => {
  const mismatches = [
    { userId: "synthetic-user-other" },
    { sessionId: "synthetic-parent-session-other" },
    { sessionEpoch: "synthetic-server-epoch-2" },
  ];
  for (const mismatch of mismatches) {
    const producer = createProducer({
      [config.endpoints.refresh]: () => json(credentialEnvelope(mismatch)),
    });
    const { auth } = service(producer);
    const response = await auth.refresh(request(AUTH_PUBLIC_PATHS.refresh, {
      headers: { cookie: `${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}` },
    }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.deepEqual(producer.calls.map((call) => call.path), [config.endpoints.introspect, config.endpoints.refresh]);
  }
});

test("stable refresh rotates only the Photo credential and exposes no credential in JSON", async () => {
  const rotated = "synthetic-photo-credential-rotated-0002";
  const producer = createProducer({
    [config.endpoints.refresh]: () => json({ ...credentialEnvelope({ expiresAt: "2026-11-03T02:00:00.000Z" }), credential: rotated }),
  });
  const { auth } = service(producer);
  const response = await auth.refresh(request(AUTH_PUBLIC_PATHS.refresh, {
    headers: { cookie: `${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}` },
  }));
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.expiresAt, "2026-11-03T02:00:00.000Z");
  assert.equal(JSON.stringify(value).includes(rotated), false);
  assert.match(response.headers.getSetCookie()[0], new RegExp(rotated));
  assert.deepEqual(producer.calls[1].body, {
    clientId: config.clientId,
    audience: config.audience,
    credential: CREDENTIAL,
  });
});

test("credential limits include serialized cookie overhead before reporting success", async () => {
  const expiry = new Date(NOW + 31 * 24 * 60 * 60 * 1000).toISOString();
  assert.ok(Buffer.byteLength(setCredentialCookie("a".repeat(MAX_CREDENTIAL_BYTES), expiry, NOW)) <= 4096);
  assert.throws(() => setCredentialCookie("a".repeat(MAX_CREDENTIAL_BYTES + 1), expiry, NOW), /invalid Photo cookie/);
  for (const size of [MAX_CREDENTIAL_BYTES + 1, 4096]) {
    const oversized = { ...credentialEnvelope(), credential: "a".repeat(size) };
    const { auth } = service(createProducer({
      [config.endpoints.exchange]: () => json(oversized),
      [config.endpoints.refresh]: () => json(oversized),
    }));
    const started = await begin(auth);
    const exchanged = await auth.callback(callbackRequest(`code=${"c".repeat(43)}&state=${started.pending.state}`, { cookie: started.pendingCookie }));
    const refreshed = await auth.refresh(request(AUTH_PUBLIC_PATHS.refresh, { headers: { cookie: `${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}` } }));
    for (const response of [exchanged, refreshed]) {
      assert.equal(response.status, 503);
      assert.equal(response.headers.has("set-cookie"), false);
      assert.equal(response.headers.has("location"), false);
    }
  }
});

test("logout and cancel enforce same-origin CSRF inside each public method", async () => {
  const { auth, producer } = service();
  for (const [method, path] of [["start", "/auth/start"], ["refresh", "/auth/refresh"], ["logout", "/auth/logout"], ["cancel", "/auth/cancel"]]) {
    const response = await auth[method](request(path, { origin: NIHO_ORIGIN }));
    assert.equal(response.status, 400);
  }
  assert.equal(producer.calls.length, 0);
});

test("logout forwards both late-exchange verifier and current credential, then clears cookies", async () => {
  const { auth, producer } = service();
  const started = await begin(auth);
  producer.calls.length = 0;
  const cookies = `${started.pendingCookie}; ${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}`;
  const response = await auth.logout(request(AUTH_PUBLIC_PATHS.logout, { headers: { cookie: cookies } }));
  assert.equal(response.status, 204);
  assert.deepEqual(new Set(producer.calls.map((call) => call.path)), new Set([config.endpoints.cancel, config.endpoints.revoke]));
  const cancel = producer.calls.find((call) => call.path === config.endpoints.cancel);
  assert.equal(cancel.body.codeVerifier, started.pending.verifier);
  const revoke = producer.calls.find((call) => call.path === config.endpoints.revoke);
  assert.deepEqual(revoke.body, {
    clientId: config.clientId,
    audience: config.audience,
    credential: CREDENTIAL,
  });
  assert.match(response.headers.getSetCookie().join("\n"), /Max-Age=0/);
});

test("a stale cookie is never locally trusted after logout and must be introspected again", async () => {
  let revoked = false;
  const producer = createProducer({
    [config.endpoints.revoke]: () => { revoked = true; return new Response(null, { status: 204 }); },
    [config.endpoints.introspect]: () => revoked
      ? json({ error: "synthetic-revoked" }, 401)
      : json(actorEnvelope()),
  });
  const { auth } = service(producer);
  const oldCookie = `${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}`;
  assert.equal((await auth.logout(request(AUTH_PUBLIC_PATHS.logout, { headers: { cookie: oldCookie } }))).status, 204);
  const stale = await auth.session(request(AUTH_PUBLIC_PATHS.session, {
    method: "GET",
    headers: { cookie: oldCookie },
  }));
  assert.equal(stale.status, 401);
  assert.equal(producer.calls.at(-1).path, config.endpoints.introspect);
});

test("cancel forwards the exact PKCE verifier and does not clear an existing credential", async () => {
  const { auth, producer } = service();
  const started = await begin(auth);
  producer.calls.length = 0;
  const cookies = `${started.pendingCookie}; ${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}`;
  const response = await auth.cancel(request(AUTH_PUBLIC_PATHS.cancel, { headers: { cookie: cookies } }));
  assert.equal(response.status, 204);
  assert.equal(producer.calls.length, 1);
  assert.equal(producer.calls[0].path, config.endpoints.cancel);
  assert.deepEqual(producer.calls[0].body, {
    clientId: config.clientId,
    attemptId: started.pending.attemptId,
    codeVerifier: started.pending.verifier,
  });
  const setCookies = response.headers.getSetCookie().join("\n");
  assert.match(setCookies, /__Host-niho-photo-pending=; Max-Age=0/);
  assert.doesNotMatch(setCookies, /__Host-niho-photo-credential=/);
});

test("retryable logout/cancel failures preserve every cookie and never claim remote success", async () => {
  const failing = createProducer({
    [config.endpoints.cancel]: () => json({ internal: "synthetic-sensitive-upstream-body" }, 503),
  });
  const { auth } = service(failing);
  const started = await begin(auth);
  for (const [method, path] of [["cancel", AUTH_PUBLIC_PATHS.cancel], ["logout", AUTH_PUBLIC_PATHS.logout]]) {
    const response = await auth[method](request(path, { headers: { cookie: started.pendingCookie } }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.doesNotMatch(await response.text(), /sensitive|attempt|credential/);
  }
});

test("server-only authorization closure re-introspects, checks capture, and keeps credential out of result", async () => {
  const { auth, producer } = service();
  const protectedRequest = request("/api/synthetic/photos", {
    method: "GET",
    headers: { cookie: `${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}` },
  });
  const result = await auth.withAuthorizedCredential(protectedRequest, {
    userId: actor().userId,
    sessionId: actor().sessionId,
    sessionEpoch: actor().sessionEpoch,
    transport: actor().transport,
  }, async (credential, verifiedActor) => ({ ok: credential === CREDENTIAL, actor: verifiedActor }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.actor, actor());
  assert.deepEqual(producer.calls.map((call) => call.path), [config.endpoints.introspect]);
  await assert.rejects(
    auth.withAuthorizedCredential(protectedRequest, {
      userId: actor().userId,
      sessionId: actor().sessionId,
      sessionEpoch: "synthetic-stale-epoch",
      transport: actor().transport,
    }, async () => "must-not-run"),
    (error) => error instanceof PhotoAuthorizationError && error.status === 403 && error.code === "scope_changed",
  );
});

test("generic authorization allows filters but enforces Origin on unsafe methods", async () => {
  const { auth } = service();
  const cookie = `${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}`;
  const filtered = new Request(`${PHOTO_ORIGIN}/api/synthetic/photos?cursor=opaque&limit=25`, {
    method: "GET",
    headers: { host: HOST, cookie },
  });
  assert.equal((await auth.authorize(filtered)).userId, actor().userId);

  const absentOrigin = new Request(`${PHOTO_ORIGIN}/api/synthetic/photos?cursor=opaque`, {
    method: "POST",
    headers: { host: HOST, cookie },
  });
  const foreignOrigin = request("/api/synthetic/photos?cursor=opaque", {
    method: "POST",
    origin: "https://evil.invalid",
    headers: { cookie },
  });
  for (const candidate of [absentOrigin, foreignOrigin]) {
    await assert.rejects(
      auth.authorize(candidate),
      (error) => error instanceof PhotoAuthorizationError && error.status === 503,
    );
    await assert.rejects(
      auth.withAuthorizedCredential(candidate, null, async () => "must-not-run"),
      (error) => error instanceof PhotoAuthorizationError && error.status === 503,
    );
  }

  const foreignGet = request("/api/synthetic/photos?cursor=opaque", {
    method: "GET",
    origin: "https://evil.invalid",
    headers: { cookie },
  });
  await assert.rejects(
    auth.authorize(foreignGet),
    (error) => error instanceof PhotoAuthorizationError && error.status === 503,
  );
});

test("upstream bodies, thrown messages, credential, code, and state never appear in errors", async () => {
  const secret = "synthetic-sensitive-upstream-body-and-token";
  const producer = createProducer({
    [config.endpoints.introspect]: () => new Response(secret, { status: 500, headers: { "content-type": "text/plain" } }),
  });
  const { auth } = service(producer);
  const response = await auth.session(request(AUTH_PUBLIC_PATHS.session, {
    method: "GET",
    headers: { cookie: `${PHOTO_CREDENTIAL_COOKIE}=${CREDENTIAL}` },
  }));
  const body = await response.text();
  assert.equal(response.status, 503);
  assert.equal(body.includes(secret), false);
  assert.equal(body.includes(CREDENTIAL), false);
});
