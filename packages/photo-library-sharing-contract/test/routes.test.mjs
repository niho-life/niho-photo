import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  CONNECTOR_PATH_PREFIX,
  CONNECTOR_ROUTES,
  PENDING_INVITE_ROUTES,
  SHARING_CLOUD_PATH_PREFIX,
  SHARING_ROUTES,
  USER_RENDER_ROUTES,
  connectorRouteFields,
  decodeConnectorRequest,
  decodeUserRenderRequest,
  encodeConnectorRequest,
  encodeUserRenderRequest,
  matchConnectorRoute,
  matchPendingInviteRoute,
  matchUserRenderRoute,
  decodePendingInviteRequest,
  encodePendingInviteRequest,
  decodeOpaqueSegment,
  decodeSharingRequest,
  encodeOpaqueSegment,
  encodeSharingRequest,
  matchSharingRoute,
  routeFields,
} from "../src/routes.ts";
import { CONNECTOR_OPERATION_ACCESS, CONNECTOR_REQUEST_SHAPES, SHARING_OPERATION_ACCESS, SHARING_REQUEST_SHAPES } from "../src/v1.ts";
import { connectorResponses, responses } from "../fixtures/v1.ts";

const operations = Object.keys(SHARING_OPERATION_ACCESS);
const STREAMS = new Set(["hostedPhotos.content", "exports.content", "portability.content", "albumItems.download"]);

test("every user operation has exactly one route and connector traffic has none", () => {
  assert.equal(SHARING_CLOUD_PATH_PREFIX, "/cloud/sharing/v1");
  assert.deepEqual(Object.keys(SHARING_ROUTES).sort(), [...operations].sort());
  for (const operation of Object.keys(SHARING_ROUTES)) {
    assert(!operation.startsWith("connector.") && !operation.startsWith("renderJobs."), operation);
  }
});

test("each request field travels exactly once: path, query, body or Range", () => {
  for (const operation of operations) {
    const fields = routeFields(operation);
    const placed = [...fields.path, ...fields.query, ...fields.body, ...(fields.range ? ["range"] : [])];
    assert.equal(new Set(placed).size, placed.length, `${operation}: placed twice`);
    assert.deepEqual([...placed].sort(), Object.keys(SHARING_REQUEST_SHAPES[operation]).sort(), operation);
    const route = SHARING_ROUTES[operation];
    if (route.method === "GET" || route.method === "DELETE") assert.equal(route.body, null, operation);
    else assert.notEqual(route.body, null, operation);
    if (route.range) assert.equal(route.method, "GET", operation);
  }
  assert.deepEqual(routeFields("invites.join"), { path: [], query: [], body: ["secret"], range: false }, "the invite secret never enters a URL");
});

test("mutations require Idempotency-Key and reads refuse it", () => {
  for (const operation of operations) {
    const mutation = !STREAMS.has(operation) && "replayed" in responses[operation];
    assert.equal(SHARING_ROUTES[operation].idempotencyKey, mutation, operation);
  }
});

test("no two routes can match the same request", () => {
  for (const table of [{ ...SHARING_ROUTES, ...Object.fromEntries(Object.entries(USER_RENDER_ROUTES).map(([k, v]) => [`user:${k}`, v])) }, CONNECTOR_ROUTES]) {
    assertNoOverlap(table);
  }
});

function assertNoOverlap(table) {
  const entries = Object.entries(table);
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const [left, l] = entries[a];
      const [right, r] = entries[b];
      if (l.method !== r.method) continue;
      const ls = l.path.split("/");
      const rs = r.path.split("/");
      if (ls.length !== rs.length) continue;
      const overlap = ls.every((part, index) => part === rs[index] || part.startsWith("{") || rs[index].startsWith("{"));
      assert(!overlap, `${left} and ${right} overlap`);
    }
  }
}

const sampleValue = (field) => ({
  limit: 10, expectedRevision: 3, cursor: "synthetic-cursor", sort: "captured-desc", variant: "thumbnail",
  range: { start: 0, endInclusive: 9 },
})[field] ?? `synthetic ${field}`;

test("requests round-trip through encode, match and decode", () => {
  for (const operation of operations) {
    const fields = routeFields(operation);
    const request = {};
    for (const field of [...fields.path, ...fields.query, ...fields.body]) {
      request[field] = fields.path.includes(field) ? `synthetic/${field}`.replace("/", "-") + " 日本" : sampleValue(field);
    }
    // Body values are opaque to routing; the closed shape is checked separately.
    if (operation === "connectors.approvePairing") request.target = { kind: "newLibrary", name: "Synthetic" };
    if (operation === "albumItems.addPhoto") request.source = { kind: "libraryPhoto", libraryId: "l", photoId: "p" };
    if (operation === "albumItems.addFile") request.rendition = { sizeBytes: 1, sha256: "a", contentType: "image/jpeg", width: 1, height: 1, metadata: { capturedAt: null, capturedAtOffset: null, colorProfile: "sRGB", orientation: 1 } };
    if (operation === "albumItems.replace") request.content = { kind: "file", rendition: { sizeBytes: 1, sha256: "a", contentType: "image/jpeg", width: 1, height: 1, metadata: { capturedAt: null, capturedAtOffset: null, colorProfile: "sRGB", orientation: 1 } } };
    if (operation === "hostedRecipes.put") request.settings = { v: 5, engine: "niho-14", futureField: { keep: [1] } };
    if (fields.range) request.range = sampleValue("range");
    const encoded = encodeSharingRequest(operation, request);
    assert(encoded.path.startsWith(`${SHARING_CLOUD_PATH_PREFIX}/`), operation);
    assert(!encoded.path.includes(" ") && !encoded.path.includes("日"), `${operation}: segments are encoded`);
    const matched = matchSharingRoute(encoded.method, encoded.path);
    assert.equal(matched?.operation, operation, operation);
    const decoded = decodeSharingRequest(operation, {
      params: matched.params,
      query: new URLSearchParams(encoded.query),
      body: encoded.body === null ? null : JSON.parse(JSON.stringify(encoded.body)),
      range: encoded.range,
    });
    assert.deepEqual(decoded, request, operation);
  }
});

test("path IDs are single opaque segments", () => {
  for (const bad of ["", ".", "..", "a/b", "a\\b", " a", "a ", "a\u0000b", "a​b", "x".repeat(513)]) {
    assert.throws(() => encodeOpaqueSegment(bad), { code: "invalid_request" }, JSON.stringify(bad));
  }
  for (const good of ["a b", "日本", "a?b#c%d", "synthetic-album-a"]) {
    assert.equal(decodeOpaqueSegment(encodeOpaqueSegment(good)), good);
  }
  // Non-canonical or decoded-unsafe segments never match.
  assert.equal(decodeOpaqueSegment("a%2Fb"), null);
  assert.equal(decodeOpaqueSegment("%2E%2E"), null);
  assert.equal(decodeOpaqueSegment("%E0%A4%A"), null);
  assert.equal(matchSharingRoute("GET", `${SHARING_CLOUD_PATH_PREFIX}/albums/a%2Fb`), null);
  assert.equal(matchSharingRoute("GET", "/cloud/v2/albums/a"), null);
  assert.equal(matchSharingRoute("PATCH", `${SHARING_CLOUD_PATH_PREFIX}/albums/a`), null);
});

test("unknown or repeated query parameters, stray bodies and nested extras are rejected", () => {
  const decode = (operation, input) => () => decodeSharingRequest(operation, { params: {}, query: new URLSearchParams(), body: null, range: null, ...input });
  assert.throws(decode("albums.list", { query: new URLSearchParams("limit=1&limit=2") }), { code: "invalid_request" });
  assert.throws(decode("albums.list", { query: new URLSearchParams("ownerId=u") }), { code: "invalid_request" });
  assert.throws(decode("albums.list", { query: new URLSearchParams("limit=-1") }), { code: "invalid_request" });
  assert.throws(decode("albums.get", { params: { albumId: "a" }, body: {} }), { code: "invalid_request" });
  assert.throws(decode("albums.create", { body: { name: "n", ownerId: "u" } }), { code: "invalid_request" });
  assert.throws(decode("albums.create", { body: [] }), { code: "invalid_request" });
  assert.throws(decode("albumItems.addPhoto", { params: { albumId: "a" }, body: { source: { kind: "libraryPhoto", libraryId: "l", photoId: "p", path: "x" } } }), { code: "invalid_request" });
  assert.throws(decode("albums.get", { params: { albumId: "a" }, range: { start: 0 } }), { code: "invalid_request" });
  assert.throws(() => encodeSharingRequest("invites.join", { secret: "s", role: "owner" }), { code: "invalid_request" });
  assert.throws(() => encodeSharingRequest("albums.list", { limit: "10" }), { code: "invalid_request" });
});

test("the route table in the contract document matches SHARING_ROUTES", async () => {
  const doc = await readFile(new URL("../../../docs/architecture/photo-library-sharing.md", import.meta.url), "utf8");
  for (const [operation, route] of Object.entries(SHARING_ROUTES)) {
    assert(doc.includes(`| ${operation} | ${route.method} \`${route.path}\` |`), operation);
  }
});

test("connector and user render routes place each field once, key mutations, and round-trip", () => {
  const connectorOps = Object.keys(CONNECTOR_OPERATION_ACCESS);
  assert.equal(CONNECTOR_PATH_PREFIX, "/connector/v1");
  assert.deepEqual(Object.keys(CONNECTOR_ROUTES).sort(), [...connectorOps].sort());
  assert.deepEqual(Object.keys(USER_RENDER_ROUTES).sort(), connectorOps.filter((op) => op.startsWith("renderJobs.")).sort());
  for (const operation of connectorOps) {
    const fields = connectorRouteFields(operation);
    const placed = [...fields.path, ...fields.query, ...fields.body, ...(fields.range ? ["range"] : [])];
    assert.equal(new Set(placed).size, placed.length, operation);
    assert.deepEqual([...placed].sort(), Object.keys(CONNECTOR_REQUEST_SHAPES[operation]).sort(), operation);
    const mutation = operation in connectorResponses && "replayed" in connectorResponses[operation];
    assert.equal(CONNECTOR_ROUTES[operation].idempotencyKey, mutation, operation);
    if (operation.startsWith("renderJobs.")) {
      assert.equal(USER_RENDER_ROUTES[operation].idempotencyKey, mutation, operation);
      assert.deepEqual(USER_RENDER_ROUTES[operation].body, CONNECTOR_ROUTES[operation].body, operation);
    }
  }
  // Secrets stay out of URLs: poll secret, lease tokens and credential hashes travel in bodies.
  for (const [operation, route] of Object.entries(CONNECTOR_ROUTES)) {
    for (const secret of ["pollSecret", "leaseToken", "pollSecretSha256", "credentialSha256", "nextCredentialSha256"]) {
      assert(!route.path.includes(`{${secret}}`) && !route.query.includes(secret), `${operation}: ${secret}`);
    }
  }
  const samples = {
    "connector.startPairing": { platform: "macos", displayName: "Synthetic Mac", pollSecretSha256: "8".repeat(64), credentialSha256: "6".repeat(64) },
    "connector.pollPairing": { pairingId: "synthetic pairing", pollSecret: "synthetic" },
    "connector.rotateCredential": { nextCredentialSha256: "5".repeat(64) },
    "connector.heartbeat": { state: "online", renderer: null, replicaRevision: 4 },
    "connector.putIndex": { entries: [] },
    "connector.pullReplica": { sinceRevision: 0, limit: 100, cursor: "1:5" },
    "connector.ackReplica": { revision: 5 },
    "connector.getReplicaContent": { entity: "mask", id: "photo:surface", range: { start: 0, endInclusive: 9 } },
    "connector.startWorkingCopyUpload": {
      photoId: "photo-1", sourceGeneration: 2,
      workingCopy: {
        baseVersion: "niho-sdk-197", encoding: "png16", meta: { sdkVersion: "synthetic" },
        asset: { sha256: "a".repeat(64), sizeBytes: 8192, contentType: "image/png", width: 6000, height: 4000 },
      },
    },
    "connector.completeWorkingCopyUpload": { photoId: "photo-1", uploadId: "working-copy-upload" },
    "renderJobs.claim": { maxJobs: 2, purposes: ["preview"], prefer: { photoIds: ["synthetic photo"] } },
    "renderJobs.renewOutput": { jobId: "synthetic job", leaseToken: "lease", uploadId: "upload 1" },
    "renderJobs.startOutput": { jobId: "synthetic job", leaseToken: "lease", output: { kind: "preview", sizeBytes: 1, sha256: "a", contentType: "image/jpeg", width: 1, height: 1 } },
    "renderJobs.commit": { jobId: "synthetic job", leaseToken: "lease", uploadId: "upload" },
    "renderJobs.fail": { jobId: "synthetic job", leaseToken: "lease", code: "source_missing" },
  };
  for (const [operation, request] of Object.entries(samples)) {
    const encoded = encodeConnectorRequest(operation, request);
    const matched = matchConnectorRoute(encoded.method, encoded.path);
    assert.equal(matched?.operation, operation);
    const decoded = decodeConnectorRequest(operation, { params: matched.params, query: new URLSearchParams(encoded.query), body: encoded.body, range: encoded.range });
    assert.deepEqual(decoded, request, operation);
    if (operation.startsWith("renderJobs.")) {
      const user = encodeUserRenderRequest(operation, request);
      assert(user.path.startsWith(`${SHARING_CLOUD_PATH_PREFIX}/render-jobs/`), operation);
      const userMatch = matchUserRenderRoute(user.method, user.path);
      assert.equal(userMatch?.operation, operation);
      assert.deepEqual(decodeUserRenderRequest(operation, { params: userMatch.params, query: new URLSearchParams(user.query), body: user.body, range: user.range }), request);
      assert.equal(matchSharingRoute(user.method, user.path), null, "user render routes never shadow sharing routes");
    }
  }
  assert.equal(matchConnectorRoute("GET", `${SHARING_CLOUD_PATH_PREFIX}/albums/a`), null, "device credentials never reach user routes");
  assert.throws(() => encodeConnectorRequest("renderJobs.claim", { purposes: ["preview"], ownerId: "u" }), { code: "invalid_request" });
});

test("the connector route table in the contract document matches CONNECTOR_ROUTES", async () => {
  const doc = await readFile(new URL("../../../docs/architecture/photo-library-sharing.md", import.meta.url), "utf8");
  for (const [operation, route] of Object.entries(CONNECTOR_ROUTES)) {
    assert(doc.includes(`| ${operation} | ${route.method} \`${route.path}\` |`), operation);
  }
  for (const [operation, route] of Object.entries(USER_RENDER_ROUTES)) {
    assert(doc.includes(`| ${operation}（利用者の端末） | ${route.method} \`${route.path}\` |`), operation);
  }
});

test("pending invite routes are BFF-only, keyless, never collide with upstream routes and keep the secret in the body", async () => {
  assert.deepEqual(Object.keys(PENDING_INVITE_ROUTES).sort(), ["invites.holdPending", "invites.joinPending"]);
  for (const [operation, route] of Object.entries(PENDING_INVITE_ROUTES)) {
    assert.equal(route.idempotencyKey, false, operation);
    const full = `${SHARING_CLOUD_PATH_PREFIX}${route.path}`;
    assert.deepEqual(matchPendingInviteRoute(route.method, full), { operation, params: {} });
    assert.equal(matchSharingRoute(route.method, full), null, `${operation} is not an upstream route`);
    assert.equal(matchUserRenderRoute(route.method, full), null, operation);
  }
  for (const [operation, route] of Object.entries(SHARING_ROUTES)) {
    if (!route.path.includes("{")) assert.equal(matchPendingInviteRoute(route.method, `${SHARING_CLOUD_PATH_PREFIX}${route.path}`), null, operation);
  }
  const held = encodePendingInviteRequest("invites.holdPending", { secret: "synthetic-invite-secret" });
  assert.deepEqual(held, { method: "POST", path: "/cloud/sharing/v1/invites/pending", query: "", body: { secret: "synthetic-invite-secret" }, range: null, idempotencyKey: false });
  const input = (extra) => ({ params: {}, query: new URLSearchParams(), body: null, range: null, ...extra });
  assert.deepEqual(decodePendingInviteRequest("invites.holdPending", input({ body: held.body })), { secret: "synthetic-invite-secret" });
  const join = encodePendingInviteRequest("invites.joinPending", {});
  assert.deepEqual(join.body, {});
  assert.throws(() => decodePendingInviteRequest("invites.joinPending", input({ body: { secret: "x" } })), { code: "invalid_request" });
  assert.throws(() => decodePendingInviteRequest("invites.holdPending", input({ query: new URLSearchParams("secret=x"), body: {} })), { code: "invalid_request" });
  const doc = await readFile(new URL("../../../docs/architecture/photo-library-sharing.md", import.meta.url), "utf8");
  for (const [operation, route] of Object.entries(PENDING_INVITE_ROUTES)) {
    assert(doc.includes(`| ${operation} | ${route.method} \`${route.path}\` |`), operation);
  }
});
