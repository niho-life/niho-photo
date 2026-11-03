import {
  PHOTO_ERROR_STATUS,
  PHOTO_LIMITS,
  type PersonalPhotoLibrary,
  type PhotoErrorCode,
  type PhotoErrorEnvelope,
  type PhotoOperation,
  type PhotoOperationMap,
  type StartUploadRequest,
  type UploadTicket,
} from "@niho/photo-personal-cloud-contract";

import { PersonalPhotoCloudError } from "./errors";
import { awaitBounded } from "./await";
import {
  isUploadTicketShape,
  validateInfo,
  validateJsonDepth,
  validateLibrary,
  validateLookup,
  validatePage,
  validatePhoto,
  validateStartUploadResponse,
  validateUpload,
} from "./validation";

export const PHOTO_CLOUD_PATH_PREFIX = "/cloud/v2";
export const PHOTO_CAPTURE_HEADERS = {
  actorId: "X-NIHO-Photo-Actor-Id",
  sessionId: "X-NIHO-Photo-Session-Id",
  sessionEpoch: "X-NIHO-Photo-Session-Epoch",
} as const;
export const PHOTO_IDEMPOTENCY_HEADER = "Idempotency-Key";
export const PHOTO_CONTENT_HEADERS = {
  sha256: "X-NIHO-Photo-Sha256",
  totalBytes: "X-NIHO-Photo-Total-Bytes",
} as const;
export const JSON_LIMITS = { list: PHOTO_LIMITS.maxPageBytes, success: PHOTO_LIMITS.maxRecipeBodyBytes, error: 64 * 1024 } as const;
export const TRANSPORT_TIMEOUT_MS = 15_000;
export const MAX_UPLOAD_URL_BYTES = 8 * 1024;
export const GCS_CHUNK_BYTES = 8 * 1024 ** 2;
export const TRUSTED_GCS_UPLOAD_ORIGIN = "https://storage.googleapis.com";

const textEncoder = new TextEncoder();
const OPAQUE_ID_MAX_BYTES = 512;
const KEY_MAX_BYTES = PHOTO_LIMITS.maxIdempotencyKeyBytes;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTENT_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]*"))*$/u;

export type WireOperation =
  | "library.get" | "photos.list" | "photos.get" | "photos.info" | "photos.lookup"
  | "uploads.start" | "uploads.get" | "uploads.renew" | "uploads.complete" | "uploads.cancel"
  | "photos.delete" | "content.get";

export type EncodedOperation = {
  readonly operation: WireOperation;
  readonly method: "GET" | "POST" | "DELETE";
  readonly suffix: string;
  readonly query: string;
  readonly body: Uint8Array<ArrayBuffer> | null;
  readonly range: string | null;
  readonly idempotencyKey: string | null;
  readonly responseContext?: ResponseValidationContext;
};

export type ResponseValidationContext =
  | { readonly kind: "lookup"; readonly requestedSha256s: readonly string[] }
  | { readonly kind: "start"; readonly contentType: string };

export function encodeOperation(
  operation: PhotoOperation,
  request: unknown,
  idempotencyKey: string | undefined,
): EncodedOperation {
  const body = (value: unknown): Uint8Array<ArrayBuffer> => textEncoder.encode(JSON.stringify(value));
  const noKey = (): null => {
    if (idempotencyKey !== undefined) invalidRequest();
    return null;
  };
  const requiredKey = (): string => {
    if (!boundedOpaque(idempotencyKey, 1, KEY_MAX_BYTES) || idempotencyKey.includes(",") || /[\p{Cc}\p{Cf}]/u.test(idempotencyKey)) invalidRequest();
    return idempotencyKey;
  };
  if (operation === "library.get") {
    exactRecord(request, []); return { operation, method: "GET", suffix: "/library", query: "", body: null, range: null, idempotencyKey: noKey() };
  }
  if (operation === "photos.list") {
    const value = exactRecord(request, ["cursor", "limit", "sort", "formats", "edited", "editable"], true);
    const query = new URLSearchParams();
    if (value.cursor !== undefined) query.set("cursor", opaque(value.cursor));
    if (value.limit !== undefined) {
      if (!integerBetween(value.limit, 1, PHOTO_LIMITS.listMaxCount)) invalidRequest();
      query.set("limit", String(value.limit));
    }
    if (value.sort !== undefined) {
      if (value.sort !== "added-desc" && value.sort !== "captured-desc") invalidRequest();
      query.set("sort", value.sort);
    }
    if (value.formats !== undefined) {
      if (!Array.isArray(value.formats) || value.formats.length === 0 || !value.formats.every(isFormat)) invalidRequest();
      for (const format of value.formats) query.append("formats", format);
    }
    for (const name of ["edited", "editable"] as const) {
      const item = value[name];
      if (item !== undefined) {
        if (typeof item !== "boolean") invalidRequest();
        query.set(name, String(item));
      }
    }
    return { operation, method: "GET", suffix: "/photos", query: query.toString(), body: null, range: null, idempotencyKey: noKey() };
  }
  if (operation === "photos.lookup") {
    const value = exactRecord(request, ["sha256s"]);
    if (!Array.isArray(value.sha256s) || value.sha256s.length === 0 || value.sha256s.length > PHOTO_LIMITS.lookupMaxCount || !value.sha256s.every(isSha256) || new Set(value.sha256s).size !== value.sha256s.length) invalidRequest();
    return { operation, method: "POST", suffix: "/photos/lookup", query: "", body: body({ sha256s: value.sha256s }), range: null, idempotencyKey: noKey(), responseContext: { kind: "lookup", requestedSha256s: [...value.sha256s] as string[] } };
  }
  if (operation === "uploads.start") {
    const value = validateStartRequest(request);
    return { operation, method: "POST", suffix: "/uploads", query: "", body: body(value), range: null, idempotencyKey: requiredKey(), responseContext: { kind: "start", contentType: value.contentType } };
  }
  if (operation === "photos.get" || operation === "photos.info" || operation === "photos.delete") {
    const value = exactRecord(request, ["photoId"]);
    const id = encodeOpaqueSegment(value.photoId);
    const suffix = `/photos/${id}${operation === "photos.info" ? "/info" : ""}`;
    return { operation, method: operation === "photos.delete" ? "DELETE" : "GET", suffix, query: "", body: null, range: null, idempotencyKey: operation === "photos.delete" ? requiredKey() : noKey() };
  }
  if (operation === "uploads.get" || operation === "uploads.renew" || operation === "uploads.complete" || operation === "uploads.cancel") {
    const value = exactRecord(request, ["uploadId"]);
    const action = operation.split(".")[1];
    const suffix = `/uploads/${encodeOpaqueSegment(value.uploadId)}${action === "get" ? "" : `/${action}`}`;
    const mutation = action === "complete" || action === "cancel";
    return { operation, method: action === "get" ? "GET" : "POST", suffix, query: "", body: action === "get" ? null : body({}), range: null, idempotencyKey: mutation ? requiredKey() : noKey() };
  }
  if (operation === "content.get") {
    const value = exactRecord(request, ["photoId", "assetId", "range"], true);
    let range: string | null = null;
    if (value.range !== undefined) {
      const rangeValue = exactRecord(value.range, ["start", "endInclusive"], true);
      if (!safeNonNegative(rangeValue.start) || (rangeValue.endInclusive !== undefined && (!safeNonNegative(rangeValue.endInclusive) || rangeValue.endInclusive < rangeValue.start))) invalidRequest();
      range = `bytes=${rangeValue.start}-${rangeValue.endInclusive ?? ""}`;
    }
    return { operation, method: "GET", suffix: `/photos/${encodeOpaqueSegment(value.photoId)}/assets/${encodeOpaqueSegment(value.assetId)}/content`, query: "", body: null, range, idempotencyKey: noKey() };
  }
  throw new PersonalPhotoCloudError("unsupported");
}

export function parseIncomingOperation(request: Request): EncodedOperation | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${PHOTO_CLOUD_PATH_PREFIX}/`) && url.pathname !== PHOTO_CLOUD_PATH_PREFIX) return null;
  if (url.hash !== "") invalidRequest();
  if (request.headers.has("authorization")) invalidRequest();
  const relative = url.pathname.slice(PHOTO_CLOUD_PATH_PREFIX.length);
  const segments = relative.split("/").slice(1);
  if (segments.some((segment) => segment.length === 0 || decodeSegment(segment) === null)) invalidRequest();
  const method = request.method.toUpperCase();
  const key = request.headers.get(PHOTO_IDEMPOTENCY_HEADER) ?? undefined;
  const range = request.headers.get("Range");
  let operation: PhotoOperation;
  let rawRequest: unknown;
  if (method === "GET" && relative === "/library") { operation = "library.get"; rawRequest = {}; }
  else if (method === "GET" && relative === "/photos") { operation = "photos.list"; rawRequest = parseListQuery(url.searchParams); }
  else if (method === "POST" && relative === "/photos/lookup") { operation = "photos.lookup"; rawRequest = undefined; }
  else if (method === "POST" && relative === "/uploads") { operation = "uploads.start"; rawRequest = undefined; }
  else {
    const photo = /^\/photos\/([^/]+)$/u.exec(relative);
    const info = /^\/photos\/([^/]+)\/info$/u.exec(relative);
    const upload = /^\/uploads\/([^/]+)$/u.exec(relative);
    const uploadAction = /^\/uploads\/([^/]+)\/(renew|complete|cancel)$/u.exec(relative);
    const content = /^\/photos\/([^/]+)\/assets\/([^/]+)\/content$/u.exec(relative);
    if (photo && (method === "GET" || method === "DELETE")) { operation = method === "GET" ? "photos.get" : "photos.delete"; rawRequest = { photoId: decodeRequired(photo[1]) }; }
    else if (info && method === "GET") { operation = "photos.info"; rawRequest = { photoId: decodeRequired(info[1]) }; }
    else if (upload && method === "GET") { operation = "uploads.get"; rawRequest = { uploadId: decodeRequired(upload[1]) }; }
    else if (uploadAction && method === "POST") { operation = `uploads.${uploadAction[2]}` as "uploads.renew" | "uploads.complete" | "uploads.cancel"; rawRequest = { uploadId: decodeRequired(uploadAction[1]) }; }
    else if (content && method === "GET") {
      operation = "content.get";
      rawRequest = { photoId: decodeRequired(content[1]), assetId: decodeRequired(content[2]), ...(range === null ? {} : { range: parseRequestRange(range) }) };
    } else invalidRequest();
  }
  if (operation !== "photos.list" && url.search !== "") invalidRequest();
  const encoded = rawRequest === undefined ? null : encodeOperation(operation, rawRequest, key);
  if (encoded !== null) {
    if (encoded.range !== range) invalidRequest();
    return encoded;
  }
  return { operation: operation as WireOperation, method: method as "POST", suffix: relative, query: "", body: null, range: null, idempotencyKey: key ?? null };
}

export async function readAndEncodeIncomingBody(request: Request, encoded: EncodedOperation): Promise<EncodedOperation> {
  const expectsBody = encoded.operation === "photos.lookup" || encoded.operation === "uploads.start"
    || encoded.operation === "uploads.renew" || encoded.operation === "uploads.complete" || encoded.operation === "uploads.cancel";
  if (!expectsBody) {
    if (request.body !== null) invalidRequest();
    return encoded;
  }
  if (request.headers.get("Content-Type")?.toLowerCase() !== "application/json") invalidRequest();
  const bytes = await readBoundedBody(request.body, PHOTO_LIMITS.maxRecipeBodyBytes, request.signal);
  const raw = parseJsonBytes(bytes);
  if (encoded.operation === "photos.lookup" || encoded.operation === "uploads.start") {
    const checked = encodeOperation(encoded.operation, raw, encoded.idempotencyKey ?? undefined);
    if (checked.suffix !== encoded.suffix) invalidRequest();
    return checked;
  }
  exactRecord(raw, []);
  return encoded;
}

export function validateOperationResponse<K extends WireOperation>(
  operation: K,
  value: unknown,
  ownerId: string,
  libraryId: string,
  context?: ResponseValidationContext,
): PhotoOperationMap[K]["response"] {
  let checked: unknown;
  if (operation === "library.get") checked = validateLibrary(value as PersonalPhotoLibrary, ownerId, libraryId);
  else if (operation === "photos.list") checked = validatePage(value as PhotoOperationMap["photos.list"]["response"], libraryId);
  else if (operation === "photos.get") checked = validatePhoto(value as PhotoOperationMap["photos.get"]["response"], libraryId);
  else if (operation === "photos.info") checked = validateInfo(value as PhotoOperationMap["photos.info"]["response"]);
  else if (operation === "photos.lookup") {
    const record = exactRecord(value, ["matches"]);
    if (context?.kind !== "lookup") invalidResponse();
    checked = { matches: validateLookup(record.matches as PhotoOperationMap["photos.lookup"]["response"]["matches"], new Set(context.requestedSha256s)) };
  } else if (operation === "uploads.start") {
    const receipt = validateReceipt(value);
    checked = { ...receipt, value: validateStartUploadResponse(receipt.value as PhotoOperationMap["uploads.start"]["response"]["value"], libraryId) };
  } else if (operation === "uploads.get") checked = validateUpload(value as PhotoOperationMap["uploads.get"]["response"], libraryId);
  else if (operation === "uploads.renew") {
    const record = exactRecord(value, ["upload", "ticket"]);
    const upload = validateUpload(record.upload as PhotoOperationMap["uploads.get"]["response"], libraryId);
    if (upload.state !== "reserved") invalidResponse();
    checked = { upload, ticket: validateTicketShape(record.ticket) };
  } else if (operation === "uploads.complete" || operation === "uploads.cancel") {
    const receipt = validateReceipt(value);
    checked = { ...receipt, value: validateUpload(receipt.value as PhotoOperationMap["uploads.get"]["response"], libraryId) };
  } else if (operation === "photos.delete") {
    const record = exactRecord(value, ["state"]);
    if (record.state !== "purged") invalidResponse();
    checked = record;
  } else invalidResponse();
  return checked as PhotoOperationMap[K]["response"];
}

export function validateResponseTickets(
  operation: WireOperation,
  value: unknown,
  context: ResponseValidationContext | undefined,
  trustedOrigin: string,
  now: number,
): void {
  if (operation !== "uploads.start" && operation !== "uploads.renew") return;
  if (!isRecord(value)) invalidResponse();
  const root = operation === "uploads.start" ? exactResponseRecord(value, "value") : value;
  if (!isRecord(root)) invalidResponse();
  if (operation === "uploads.start" && root.kind === "existing") {
    exactRecord(root, ["kind", "photo"]);
    return;
  }
  const ticket = root.ticket;
  if (ticket === null && operation === "uploads.start") return;
  if (ticket === undefined || ticket === null) invalidResponse();
  const upload = root.upload;
  if (!isRecord(upload) || !isRecord(upload.target) || !safePositive(upload.sizeBytes)) invalidResponse();
  let expectedContentType: string | null = null;
  if (operation === "uploads.start" && context?.kind === "start") expectedContentType = context.contentType;
  else if (operation === "uploads.renew" && upload.target.kind === "original" && isFormat(upload.target.format)) {
    expectedContentType = canonicalContentType(upload.target.format);
  }
  if (expectedContentType === null) invalidResponse();
  validateTicket(ticket, { trustedOrigin, expectedContentType, expectedSize: upload.sizeBytes, now });
}

export function validateTicket(
  value: unknown,
  options: { readonly trustedOrigin: string; readonly expectedContentType?: string; readonly expectedSize: number; readonly now: number },
): UploadTicket {
  const ticket = validateTicketShape(value);
  let url: URL;
  try { url = new URL(ticket.url); } catch { invalidResponse(); }
  if (textEncoder.encode(ticket.url).byteLength > MAX_UPLOAD_URL_BYTES || url.protocol !== "https:" || url.origin !== options.trustedOrigin || url.username !== "" || url.password !== "" || url.hash !== "") invalidResponse();
  if (Date.parse(ticket.expiresAt) <= options.now || ticket.resumeOffsetBytes > options.expectedSize) invalidResponse();
  const entries = Object.entries(ticket.headers);
  if (entries.some(([name]) => name.toLowerCase() !== "content-type") || new Set(entries.map(([name]) => name.toLowerCase())).size !== entries.length) invalidResponse();
  const contentType = entries.find(([name]) => name.toLowerCase() === "content-type")?.[1];
  if (contentType !== undefined && (!CONTENT_TYPE.test(contentType) || (options.expectedContentType !== undefined && contentType !== options.expectedContentType))) invalidResponse();
  if (options.expectedContentType !== undefined && contentType !== options.expectedContentType) invalidResponse();
  return Object.freeze({ ...ticket, headers: Object.freeze(contentType === undefined ? {} : { "Content-Type": contentType }) });
}

export async function readBoundedJson(response: Response, maximumBytes: number, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly value: unknown }> {
  try {
    const contentType = response.headers.get("Content-Type");
    if (contentType === null || contentType.includes(",") || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) invalidResponse();
    const declared = response.headers.get("Content-Length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) invalidResponse();
    const bytes = await readBoundedBody(response.body, maximumBytes, signal);
    return { bytes, value: parseJsonBytes(bytes) };
  } catch (error) {
    void response.body?.cancel(error).catch(() => undefined);
    throw error;
  }
}

export async function readBoundedBody(stream: ReadableStream<Uint8Array> | null, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (stream === null) invalidResponse();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await awaitBounded(reader.read(), {
        signal,
        timeoutMs: TRANSPORT_TIMEOUT_MS,
        onTimeout: () => { void reader.cancel(new PersonalPhotoCloudError("unavailable")).catch(() => undefined); },
      });
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) invalidResponse();
      if (result.value.byteLength === 0) continue;
      total += result.value.byteLength;
      if (total > maximumBytes) invalidResponse();
      chunks.push(result.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { try { reader.releaseLock(); } catch { /* a timed-out read can still own the lock */ } }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export function parsePhotoError(value: unknown, status: number): PhotoErrorEnvelope {
  const root = exactRecord(value, ["error"]);
  const error = exactRecord(root.error, ["code", "requestId", "retryable", "currentRevision", "conflictId", "retryAfterSeconds"], true);
  if (typeof error.code !== "string" || !(error.code in PHOTO_ERROR_STATUS) || PHOTO_ERROR_STATUS[error.code as PhotoErrorCode] !== status || !boundedOpaque(error.requestId, 1, 512) || typeof error.retryable !== "boolean") invalidResponse();
  if (error.currentRevision !== undefined && !safeNonNegative(error.currentRevision)) invalidResponse();
  if (error.conflictId !== undefined && !boundedOpaque(error.conflictId, 1, 512)) invalidResponse();
  if (error.retryAfterSeconds !== undefined && !safeNonNegative(error.retryAfterSeconds)) invalidResponse();
  return root as unknown as PhotoErrorEnvelope;
}

export function responseJsonLimit(operation: WireOperation): number { return operation === "photos.list" ? JSON_LIMITS.list : JSON_LIMITS.success; }

function validateStartRequest(value: unknown): StartUploadRequest {
  const record = exactRecord(value, ["target", "sizeBytes", "sha256", "contentType"]);
  const target = exactRecord(record.target, ["kind", "fileName", "format", "photoId"], true);
  if (!safePositive(record.sizeBytes) || record.sizeBytes > PHOTO_LIMITS.maxFileBytes || !isSha256(record.sha256) || !boundedOpaque(record.contentType, 1, 255) || !CONTENT_TYPE.test(record.contentType)) invalidRequest();
  if (target.kind === "original") {
    if (!boundedOpaque(target.fileName, 1, PHOTO_LIMITS.maxFileNameBytes) || !isFormat(target.format) || target.photoId !== undefined) invalidRequest();
  } else if (target.kind === "mask") {
    if (!boundedOpaque(target.photoId, 1, OPAQUE_ID_MAX_BYTES) || target.fileName !== undefined || target.format !== undefined || record.sizeBytes > PHOTO_LIMITS.maxMaskBytes) invalidRequest();
  } else invalidRequest();
  return value as StartUploadRequest;
}

function validateReceipt(value: unknown): { readonly value: unknown; readonly replayed: boolean } {
  const record = exactRecord(value, ["value", "replayed"]);
  if (typeof record.replayed !== "boolean") invalidResponse();
  return { value: record.value, replayed: record.replayed };
}
function exactResponseRecord(value: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) invalidResponse();
  return value[key];
}
function validateTicketShape(value: unknown): UploadTicket { if (!isUploadTicketShape(value)) invalidResponse(); return value; }
function parseJsonBytes(bytes: Uint8Array): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { invalidResponse(); }
  try {
    const value: unknown = JSON.parse(text);
    // A replayed start receipt nests settings at value.upload.result.photo.recipe.settings.
    validateJsonDepth(value, PHOTO_LIMITS.maxJsonDepth + 6);
    return value;
  } catch { invalidResponse(); }
}
function parseListQuery(query: URLSearchParams): Record<string, unknown> {
  const allowed = new Set(["cursor", "limit", "sort", "formats", "edited", "editable"]);
  for (const key of query.keys()) if (!allowed.has(key)) invalidRequest();
  const scalar = (name: string): string | undefined => { const values = query.getAll(name); if (values.length > 1) invalidRequest(); return values[0]; };
  const result: Record<string, unknown> = {};
  const cursor = scalar("cursor"); if (cursor !== undefined) result.cursor = cursor;
  const limit = scalar("limit"); if (limit !== undefined) { if (!/^\d+$/u.test(limit)) invalidRequest(); result.limit = Number(limit); }
  const sort = scalar("sort"); if (sort !== undefined) result.sort = sort;
  const formats = query.getAll("formats"); if (formats.length > 0) result.formats = formats;
  for (const name of ["edited", "editable"]) { const value = scalar(name); if (value !== undefined) { if (value !== "true" && value !== "false") invalidRequest(); result[name] = value === "true"; } }
  return result;
}
function parseRequestRange(value: string): { start: number; endInclusive?: number } {
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value); if (!match) invalidRequest();
  const start = Number(match[1]); const end = match[2] === "" ? undefined : Number(match[2]);
  if (!safeNonNegative(start) || (end !== undefined && (!safeNonNegative(end) || end < start))) invalidRequest();
  return end === undefined ? { start } : { start, endInclusive: end };
}
function exactRecord(value: unknown, keys: readonly string[], optional = false): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidRequest();
  const record = value as Record<string, unknown>; const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) invalidRequest();
  if (!optional && keys.some((key) => !(key in record))) invalidRequest();
  return record;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function encodeOpaqueSegment(value: unknown): string { return encodeURIComponent(opaque(value)); }
function opaque(value: unknown): string { if (!boundedOpaque(value, 1, OPAQUE_ID_MAX_BYTES) || value === "." || value === ".." || value.includes("/") || value.includes("\\") || /[\p{Cc}\p{Cf}]/u.test(value)) invalidRequest(); return value; }
function decodeSegment(value: string): string | null { try { const decoded = decodeURIComponent(value); return encodeURIComponent(decoded) === value && opaque(decoded) ? decoded : null; } catch { return null; } }
function decodeRequired(value: string): string { const decoded = decodeSegment(value); if (decoded === null) invalidRequest(); return decoded; }
function boundedOpaque(value: unknown, minimum: number, maximum: number): value is string { return typeof value === "string" && value.length >= minimum && textEncoder.encode(value).byteLength <= maximum && value === value.trim(); }
function safeNonNegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function safePositive(value: unknown): value is number { return safeNonNegative(value) && value > 0; }
function integerBetween(value: unknown, min: number, max: number): value is number { return safeNonNegative(value) && value >= min && value <= max; }
function isSha256(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function isFormat(value: unknown): value is "jpeg" | "png" | "heic" | "heif" | "tiff" | "raw" { return typeof value === "string" && ["jpeg", "png", "heic", "heif", "tiff", "raw"].includes(value); }
export function canonicalContentType(format: "jpeg" | "png" | "heic" | "heif" | "tiff" | "raw"): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "heic") return "image/heic";
  if (format === "heif") return "image/heif";
  if (format === "tiff") return "image/tiff";
  return "application/octet-stream";
}
function invalidRequest(): never { throw new PersonalPhotoCloudError("invalid_response"); }
function invalidResponse(): never { throw new PersonalPhotoCloudError("invalid_response"); }
