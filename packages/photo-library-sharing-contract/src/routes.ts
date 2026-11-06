/**
 * HTTP routes of the signed-in user's sharing/hosted-library operations, under the same Photo origin as the personal
 * `/cloud/v2` routes. The BFF maps the same suffix to the trusted upstream prefix. Connector (device credential)
 * traffic is a separate protocol and is not routed here.
 *
 * Every path parameter is one opaque segment. Query, body and Range carry the remaining request fields exactly once.
 */
import { findUnexpectedRequestFields } from "./policy.ts";
import type { PhotoByteRange, SharingMutationOperation, SharingOperation, SharingOperationMap } from "./v1.ts";

export const SHARING_CLOUD_PATH_PREFIX = "/cloud/sharing/v1";
/** Same capture/key headers as `/cloud/v2`: selectors and fences checked against the verified session, never proof. */
export const SHARING_HEADERS = {
  actorId: "X-NIHO-Photo-Actor-Id",
  sessionId: "X-NIHO-Photo-Session-Id",
  sessionEpoch: "X-NIHO-Photo-Session-Epoch",
  idempotencyKey: "Idempotency-Key",
  range: "Range",
} as const;

export type SharingRouteMethod = "GET" | "POST" | "PUT" | "DELETE";
export interface SharingRoute {
  readonly method: SharingRouteMethod;
  /** Suffix after the prefix. `{field}` is one opaque segment taken from the request field of the same name. */
  readonly path: string;
  /** Request fields sent as query parameters, each at most once. */
  readonly query: readonly string[];
  /** Fields of the closed JSON body; `[]` is `{}`. null: no body (GET/DELETE). */
  readonly body: readonly string[] | null;
  /** The request's `range` travels as a single `Range: bytes=start-end` header. */
  readonly range: boolean;
  /** `Idempotency-Key` is required for every mutation and refused otherwise. */
  readonly idempotencyKey: boolean;
}
type RouteMap = {
  readonly [K in SharingOperation]: SharingRoute & { readonly idempotencyKey: K extends SharingMutationOperation ? true : false };
};

const get = (path: string, query: readonly string[] = [], range = false) => ({ method: "GET", path, query, body: null, range, idempotencyKey: false }) as const;
const post = (path: string, body: readonly string[] = []) => ({ method: "POST", path, query: [], body, range: false, idempotencyKey: true }) as const;
const PAGE = ["cursor", "limit"] as const;
const PHOTO = "/libraries/{libraryId}/photos/{photoId}";

export const SHARING_ROUTES = {
  "libraries.list": get("/libraries"),
  "libraries.get": get("/libraries/{libraryId}"),
  "storage.get": get("/storage"),
  "connectors.approvePairing": post("/connectors/pairings/approve", ["userCode", "target"]),
  "connectors.get": get("/connectors/{connectorId}"),
  "connectors.revoke": post("/connectors/{connectorId}/revoke"),

  "hostedPhotos.list": get("/libraries/{libraryId}/photos", ["sort", ...PAGE]),
  "hostedPhotos.get": get(PHOTO),
  "hostedPhotos.info": get(`${PHOTO}/info`),
  "hostedPhotos.content": get(`${PHOTO}/assets/{assetId}/content`, [], true),
  "hostedPhotos.exclude": post(`${PHOTO}/exclude`),
  "hostedMasks.startUpload": post(`${PHOTO}/mask-uploads`, ["surfaceId", "sizeBytes", "width", "height"]),
  "hostedMasks.completeUpload": post(`${PHOTO}/mask-uploads/{uploadId}/complete`),
  "hostedRecipes.put": { method: "PUT", path: `${PHOTO}/recipe`, query: [], body: ["expectedRevision", "sourceGeneration", "settings", "baseVersion"], range: false, idempotencyKey: true },
  "hostedRecipeConflicts.list": get(`${PHOTO}/recipe-conflicts`, PAGE),
  "hostedRecipeConflicts.get": get(`${PHOTO}/recipe-conflicts/{conflictId}`),
  "hostedRecipeConflicts.resolve": post(`${PHOTO}/recipe-conflicts/{conflictId}/resolve`, ["expectedRevision", "decision"]),
  "exports.request": post(`${PHOTO}/exports`, ["recipeRevision"]),
  "exports.get": get("/exports/{exportId}"),
  "exports.content": get("/exports/{exportId}/content", [], true),
  "portability.export": post("/libraries/{libraryId}/portable-exports", ["mode"]),
  "portability.get": get("/portable-exports/{exportId}"),
  "portability.restore": post("/libraries/{libraryId}/restore", ["manifestSha256"]),

  "albums.list": get("/albums", PAGE),
  "albums.get": get("/albums/{albumId}"),
  "albums.create": post("/albums", ["name"]),
  "albums.rename": post("/albums/{albumId}/rename", ["expectedRevision", "name"]),
  "albums.delete": { method: "DELETE", path: "/albums/{albumId}", query: ["expectedRevision"], body: null, range: false, idempotencyKey: true },

  "albumItems.list": get("/albums/{albumId}/items", PAGE),
  "albumItems.get": get("/albums/{albumId}/items/{itemId}"),
  "albumItems.addPhoto": post("/albums/{albumId}/photo-items", ["source"]),
  "albumItems.addFile": post("/albums/{albumId}/file-items", ["rendition"]),
  "albumItems.replace": post("/albums/{albumId}/items/{itemId}/replace", ["expectedRevision", "content"]),
  "albumItems.commitUpload": post("/albums/{albumId}/uploads/{uploadId}/commit"),
  "albumItems.cancelUpload": post("/albums/{albumId}/uploads/{uploadId}/cancel"),
  "albumItems.remove": { method: "DELETE", path: "/albums/{albumId}/items/{itemId}", query: [], body: null, range: false, idempotencyKey: true },
  "albumItems.download": get("/albums/{albumId}/items/{itemId}/renditions/{renditionId}/content", ["variant"], true),

  "invites.list": get("/albums/{albumId}/invites"),
  "invites.create": post("/albums/{albumId}/invites", ["role"]),
  "invites.revoke": post("/albums/{albumId}/invites/{inviteLinkId}/revoke"),
  /** The invite secret travels in the body only: never in a URL, log or storage. */
  "invites.join": post("/invites/join", ["secret"]),

  "members.list": get("/albums/{albumId}/members", PAGE),
  "members.changeRole": post("/albums/{albumId}/members/{membershipId}/role", ["expectedRevision", "role"]),
  "members.remove": { method: "DELETE", path: "/albums/{albumId}/members/{membershipId}", query: [], body: null, range: false, idempotencyKey: true },
  "members.leave": post("/albums/{albumId}/leave"),
} as const satisfies RouteMap;

/** Query parameters that carry non-negative safe integers; every other query value is a string. */
const NUMERIC_QUERY = new Set(["limit", "expectedRevision"]);
const OPAQUE_MAX_BYTES = 512;
const encoder = new TextEncoder();

export class SharingRouteError extends Error {
  readonly code = "invalid_request" as const;
  constructor() {
    super("photo-library-sharing-contract: invalid_request");
    this.name = "SharingRouteError";
  }
}
const invalid = (): never => { throw new SharingRouteError(); };

/** Same rule as `/cloud/v2`: 1..512 bytes, trimmed, not a dot segment, no slash/backslash/control/format characters. */
export function isOpaqueSegmentValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && encoder.encode(value).byteLength <= OPAQUE_MAX_BYTES &&
    value === value.trim() && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}
export function encodeOpaqueSegment(value: unknown): string {
  return isOpaqueSegmentValue(value) ? encodeURIComponent(value) : invalid();
}
/** Accepts only the canonical encoding of a valid opaque value. */
export function decodeOpaqueSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return isOpaqueSegmentValue(decoded) && encodeURIComponent(decoded) === segment ? decoded : null;
  } catch {
    return null;
  }
}

const params = (path: string): string[] => [...path.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1] as string);
export function routeFields(operation: SharingOperation): { readonly path: readonly string[]; readonly query: readonly string[]; readonly body: readonly string[]; readonly range: boolean } {
  const route: SharingRoute = SHARING_ROUTES[operation];
  return { path: params(route.path), query: route.query, body: route.body ?? [], range: route.range };
}

export interface EncodedSharingRequest {
  readonly method: SharingRouteMethod;
  /** Full path including SHARING_CLOUD_PATH_PREFIX. */
  readonly path: string;
  /** Encoded query string without "?"; "" when empty. */
  readonly query: string;
  readonly body: Readonly<Record<string, unknown>> | null;
  readonly range: PhotoByteRange | null;
  readonly idempotencyKey: boolean;
}

/** Client side: places every request field exactly once. Rejects unexpected fields at any depth. */
export function encodeSharingRequest<K extends SharingOperation>(operation: K, request: SharingOperationMap[K]["request"]): EncodedSharingRequest {
  const route: SharingRoute = SHARING_ROUTES[operation];
  const value = request as unknown as Readonly<Record<string, unknown>>;
  if (value === null || typeof value !== "object" || findUnexpectedRequestFields(operation, value).length) invalid();
  const path = route.path.replace(/\{([A-Za-z]+)\}/g, (_, field: string) => encodeOpaqueSegment(value[field]));
  const query = new URLSearchParams();
  for (const field of route.query) {
    const item = value[field];
    if (item === undefined) continue;
    if (NUMERIC_QUERY.has(field) ? !(Number.isSafeInteger(item) && (item as number) >= 0) : typeof item !== "string") invalid();
    query.append(field, String(item));
  }
  const body = route.body === null ? null : Object.fromEntries(route.body.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
  const range = route.range ? ((value.range as PhotoByteRange | undefined) ?? null) : null;
  return { method: route.method, path: `${SHARING_CLOUD_PATH_PREFIX}${path}`, query: query.toString(), body, range, idempotencyKey: route.idempotencyKey };
}

/** Server/BFF side: the operation and decoded path parameters for a method and full path, or null. */
export function matchSharingRoute(method: string, fullPath: string): { readonly operation: SharingOperation; readonly params: Readonly<Record<string, string>> } | null {
  if (!fullPath.startsWith(`${SHARING_CLOUD_PATH_PREFIX}/`)) return null;
  const segments = fullPath.slice(SHARING_CLOUD_PATH_PREFIX.length).split("/").slice(1);
  for (const [operation, route] of Object.entries(SHARING_ROUTES) as [SharingOperation, SharingRoute][]) {
    if (route.method !== method) continue;
    const template = route.path.split("/").slice(1);
    if (template.length !== segments.length) continue;
    const found: Record<string, string> = {};
    let ok = true;
    for (let index = 0; index < template.length && ok; index++) {
      const part = template[index] as string;
      const segment = segments[index] as string;
      const param = /^\{([A-Za-z]+)\}$/.exec(part)?.[1];
      if (!param) ok = part === segment;
      else {
        const decoded = decodeOpaqueSegment(segment);
        if (decoded === null) ok = false;
        else found[param] = decoded;
      }
    }
    if (ok) return { operation, params: found };
  }
  return null;
}

/**
 * Server/BFF side: rebuilds the closed request from the matched route. Unknown or repeated query parameters, a body
 * on GET/DELETE, body fields outside the route and unexpected nested fields are invalid_request.
 */
export function decodeSharingRequest<K extends SharingOperation>(
  operation: K,
  input: {
    readonly params: Readonly<Record<string, string>>;
    readonly query: URLSearchParams;
    readonly body: unknown;
    readonly range: PhotoByteRange | null;
  },
): SharingOperationMap[K]["request"] {
  const route: SharingRoute = SHARING_ROUTES[operation];
  const request: Record<string, unknown> = { ...input.params };
  const seen = new Set<string>();
  input.query.forEach((raw, key) => {
    if (!route.query.includes(key) || seen.has(key)) invalid();
    seen.add(key);
    if (NUMERIC_QUERY.has(key)) {
      if (!/^(0|[1-9]\d{0,15})$/.test(raw) || !Number.isSafeInteger(Number(raw))) invalid();
      request[key] = Number(raw);
    } else {
      request[key] = raw;
    }
  });
  if (route.body === null) {
    if (input.body !== null && input.body !== undefined) invalid();
  } else {
    if (input.body === null || typeof input.body !== "object" || Array.isArray(input.body)) invalid();
    for (const [key, item] of Object.entries(input.body as Record<string, unknown>)) {
      if (!route.body.includes(key) || Object.hasOwn(request, key)) invalid();
      request[key] = item;
    }
  }
  if (input.range !== null) {
    if (!route.range) invalid();
    request.range = input.range;
  }
  if (findUnexpectedRequestFields(operation, request).length) invalid();
  return request as SharingOperationMap[K]["request"];
}
