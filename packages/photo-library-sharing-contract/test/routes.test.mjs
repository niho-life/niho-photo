import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  SHARING_CLOUD_PATH_PREFIX,
  SHARING_ROUTES,
  decodeOpaqueSegment,
  decodeSharingRequest,
  encodeOpaqueSegment,
  encodeSharingRequest,
  matchSharingRoute,
  routeFields,
} from "../src/routes.ts";
import { SHARING_OPERATION_ACCESS, SHARING_REQUEST_SHAPES } from "../src/v1.ts";
import { responses } from "../fixtures/v1.ts";

const operations = Object.keys(SHARING_OPERATION_ACCESS);
const STREAMS = new Set(["hostedPhotos.content", "exports.content", "albumItems.download"]);

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
  const entries = Object.entries(SHARING_ROUTES);
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
});

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
