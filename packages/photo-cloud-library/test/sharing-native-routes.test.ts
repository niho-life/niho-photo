import { readFileSync } from "node:fs";

import { SHARING_ROUTES } from "@niho/photo-library-sharing-contract/routes";
import { describe, expect, it } from "vitest";

import { SHARED_ALBUM_ITEM_OPERATIONS, SHARED_ALBUM_MEMBERSHIP_OPERATIONS } from "../src/sharing";

/** The Mac native session's allowlist (`packages/desktop-account/src/sharing_routes.json`, read by `photo_sharing.rs`). */
const NATIVE = JSON.parse(readFileSync(new URL("../../desktop-account/src/sharing_routes.json", import.meta.url), "utf8")) as {
  readonly routes: readonly {
    readonly operation: string;
    readonly method: string;
    readonly path: string;
    readonly query: readonly string[];
    readonly body: readonly string[] | null;
    readonly idempotencyKey: boolean;
  }[];
};

describe("Mac native sharing route table", () => {
  it("is exactly the shared-album operations, with the contract's routes", () => {
    // JSON operations of the two clients, plus the finished-photo download (bytes, opened by `camera_sharing_content_open`)
    const operations = [...SHARED_ALBUM_ITEM_OPERATIONS, ...SHARED_ALBUM_MEMBERSHIP_OPERATIONS, "albumItems.download"];
    expect(NATIVE.routes.map((route) => route.operation).sort()).toEqual([...new Set(operations)].sort());
    for (const route of NATIVE.routes) {
      const contract = SHARING_ROUTES[route.operation as keyof typeof SHARING_ROUTES];
      expect(contract, route.operation).toBeDefined();
      expect(
        { method: route.method, path: route.path, query: route.query, body: route.body, idempotencyKey: route.idempotencyKey },
        route.operation,
      ).toEqual({
        method: contract.method,
        path: contract.path,
        query: [...contract.query],
        body: contract.body === null ? null : [...contract.body],
        idempotencyKey: contract.idempotencyKey,
      });
    }
  });
});
