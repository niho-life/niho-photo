import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import {
  PHOTO_WEB_SHARING_ENV,
  chainPhotoWebCloudHandlers,
  readPhotoWebSharingConfiguration,
} from "../src/server/sharing-config.ts";

const KEY_A = Buffer.alloc(32, 1).toString("base64url");
const KEY_B = Buffer.alloc(32, 2).toString("base64url");
const PREFIX = "/synthetic-sharing-backend";

function env(values) {
  return { [PHOTO_WEB_SHARING_ENV.keys]: values.keys, [PHOTO_WEB_SHARING_ENV.upstreamPathPrefix]: values.prefix };
}

describe("shared-album BFF configuration (private ops values only)", () => {
  it("mounts the routes only with both values, and never echoes a value in an error", () => {
    assert.equal(readPhotoWebSharingConfiguration({}), null);
    const configured = readPhotoWebSharingConfiguration(env({ keys: `${KEY_A},${KEY_B}`, prefix: PREFIX }));
    assert.deepEqual(configured?.keys.map((key) => Buffer.from(key).toString("base64url")), [KEY_A, KEY_B]);
    assert.equal(configured?.upstreamPathPrefix, PREFIX);
    for (const broken of [
      { keys: KEY_A },
      { prefix: PREFIX },
      { keys: "", prefix: PREFIX },
      { keys: Buffer.alloc(16, 1).toString("base64url"), prefix: PREFIX },
      { keys: `${KEY_A},${KEY_B},${KEY_A}`, prefix: PREFIX },
      { keys: `${KEY_A.slice(0, -1)}+`, prefix: PREFIX },
    ]) {
      assert.throws(() => readPhotoWebSharingConfiguration(env(broken)), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(KEY_A), false);
        assert.equal(error.message.includes(PREFIX), false);
        return true;
      });
    }
  });

  it("asks the pending-invite routes, then the sharing routes, then the personal routes", async () => {
    const seen = [];
    const handler = chainPhotoWebCloudHandlers(
      async (request) => (new URL(request.url).pathname.startsWith("/cloud/sharing/v1/invites/pending") ? new Response("pending") : null),
      async (request) => (new URL(request.url).pathname.startsWith("/cloud/sharing/v1/") ? new Response("sharing") : null),
      async (request) => { seen.push(new URL(request.url).pathname); return new Response("personal"); },
    );
    assert.equal(await (await handler(new Request("https://photo.example.test/cloud/sharing/v1/invites/pending"))).text(), "pending");
    assert.equal(await (await handler(new Request("https://photo.example.test/cloud/sharing/v1/albums"))).text(), "sharing");
    assert.equal(await (await handler(new Request("https://photo.example.test/cloud/v2/photos"))).text(), "personal");
    assert.deepEqual(seen, ["/cloud/v2/photos"]);
    assert.equal(await chainPhotoWebCloudHandlers(async () => null)(new Request("https://photo.example.test/elsewhere")), null);
  });
});
