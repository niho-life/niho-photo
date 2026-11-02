import type { PhotoOperationMap, PhotoRequestOptions } from "../src/v2.ts";

// These must stay compile errors: identifiers and stale recipes confer no authority.
// @ts-expect-error The caller cannot choose the library owner.
const forged: PhotoOperationMap["library.get"]["request"] = { ownerId: "synthetic-user-b" };
// @ts-expect-error Every recipe write requires expectedRevision and baseVersion.
const unconditional: PhotoOperationMap["recipes.put"]["request"] = { photoId: "synthetic-photo", settings: { v: 1, engine: "niho-14" } };
// @ts-expect-error Resolving a saved conflict is a CAS against the active recipe.
const unconditionalConflict: PhotoOperationMap["recipe-conflicts.resolve"]["request"] = { photoId: "synthetic-photo", conflictId: "synthetic-conflict", decision: "adopt" };
// @ts-expect-error The client selects a saved conflict by ID; it cannot replace its payload.
const clientSuppliedConflict: PhotoOperationMap["recipe-conflicts.resolve"]["request"] = { photoId: "synthetic-photo", conflictId: "synthetic-conflict", expectedRevision: 1, decision: "adopt", settings: { v: 1, engine: "niho-14" } };
void forged;
void unconditional;
void unconditionalConflict;
void clientSuppliedConflict;

// @ts-expect-error Photo has immediate purge only; the legacy trash API is not available.
const trash: PhotoOperationMap["photos.trash"] = {};
void trash;

declare const signal: AbortSignal;
// @ts-expect-error Deletion retries must retain their captured operation identity.
const noDeleteKey: PhotoRequestOptions<"photos.delete"> = { signal };
// @ts-expect-error Content ranges are domain values, never an HTTP header string.
const httpRange: PhotoOperationMap["content.get"]["request"] = { photoId: "synthetic-photo", assetId: "synthetic-asset", range: "bytes=0-9" };
// @ts-expect-error Content is a bounded stream with metadata, never a whole-original buffer.
const buffered: PhotoOperationMap["content.get"]["response"] = new Uint8Array(10);
void noDeleteKey;
void httpRange;
void buffered;
