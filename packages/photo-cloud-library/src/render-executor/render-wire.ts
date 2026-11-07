/**
 * Wire for render jobs on the signed-in user's own device (B07 #248): the contract's `USER_RENDER_ROUTES` under
 * `/cloud/sharing/v1`, the same capture headers and `Idempotency-Key` rules as the other shared-album clients.
 * Every answer is checked before the executor sees it; the BFF runs the same checks before forwarding it.
 *
 * The executor still decides what it runs (bound inputs, its own renderer, this device's jobs only); these checks only
 * refuse answers that do not have the contract's shape or do not answer the request.
 */
import { PersonalPhotoCloudError } from "../errors";
import { JSON_LIMITS, isOpaqueWireId, isValidIdempotencyKey } from "../wire";
import {
  RENDITION_METADATA_FIELDS,
  SHARING_LIMITS,
  SharingRouteError,
  encodeUserRenderRequest,
  findUnexpectedConnectorFields,
} from "../sharing/contract";
import { exactRecord, isInstant, isRecord, safeNonNegative, validateReceipt, type EncodedSharingRequest } from "../sharing/membership-wire";

import type { RenderExecutorOperation, RenderExecutorOperationMap } from "./contract";

export const RENDER_JOB_OPERATIONS = [
  "renderJobs.claim",
  "renderJobs.startOutput",
  "renderJobs.renewOutput",
  "renderJobs.commit",
  "renderJobs.fail",
] as const satisfies readonly RenderExecutorOperation[];

/** Keyed: replaying a lost answer with the same key returns the same jobs, upload or result. */
const MUTATIONS: ReadonlySet<RenderExecutorOperation> = new Set(["renderJobs.claim", "renderJobs.startOutput", "renderJobs.commit", "renderJobs.fail"]);
const PURPOSES: ReadonlySet<string> = new Set(["albumItem", "preview", "export"]);
const JOB_STATES: ReadonlySet<string> = new Set(["queued", "waitingForHost", "claimed", "committed", "failed", "superseded", "cancelled"]);
const FAILURE_CODES: ReadonlySet<string> = new Set([
  "decoder_failed", "unsupported_format", "unsupported_settings", "renderer_unavailable",
  "source_missing", "source_changed", "full_resolution_unavailable", "input_limit",
]);
const METADATA_FIELDS: ReadonlySet<string> = new Set(RENDITION_METADATA_FIELDS);
const SHA256 = /^[0-9a-f]{64}$/u;
/** A claim takes a small window of jobs (the executor's default is 2 × its concurrency). */
const MAX_CLAIM_JOBS = 16;
const MAX_LEASE_TOKEN_BYTES = 512;
const MAX_ENGINE_BYTES = 128;
const textEncoder = new TextEncoder();

export function isRenderJobOperation(value: unknown): value is RenderExecutorOperation {
  return typeof value === "string" && (RENDER_JOB_OPERATIONS as readonly string[]).includes(value);
}

/** Validates and places one request with the contract's user render table. A malformed request is never sent. */
export function encodeRenderJobRequest(operation: string, request: unknown, idempotencyKey: string | undefined): EncodedSharingRequest<RenderExecutorOperation> {
  if (!isRenderJobOperation(operation)) throw new PersonalPhotoCloudError("unsupported");
  validateRenderJobRequest(operation, request);
  const mutation = MUTATIONS.has(operation);
  if (mutation ? !isValidIdempotencyKey(idempotencyKey) : idempotencyKey !== undefined) invalid();
  let route: ReturnType<typeof encodeUserRenderRequest>;
  try {
    route = encodeUserRenderRequest(operation, request as never);
  } catch (error) {
    if (error instanceof SharingRouteError) invalid();
    throw error;
  }
  if (route.idempotencyKey !== mutation || route.query !== "") invalid();
  return {
    operation,
    method: route.method,
    path: route.path,
    body: route.body === null ? null : textEncoder.encode(JSON.stringify(route.body)),
    idempotencyKey: mutation ? (idempotencyKey as string) : null,
  };
}

export function renderJobResponseLimit(operation: RenderExecutorOperation): number {
  // A claim carries complete recipes (up to the personal recipe limit each).
  return operation === "renderJobs.claim" ? JSON_LIMITS.list : JSON_LIMITS.success;
}

/** Closed shape (B00 connector shapes, shared by the user render routes) plus the value rules the server re-checks. */
export function validateRenderJobRequest(operation: RenderExecutorOperation, request: unknown): void {
  if (!isRecord(request) || findUnexpectedConnectorFields(operation, request).length > 0) invalid();
  const value = request;
  if (operation === "renderJobs.claim") {
    if (value.maxJobs !== undefined && !integerBetween(value.maxJobs, 1, MAX_CLAIM_JOBS)) invalid();
    if (value.purposes !== undefined) {
      if (!Array.isArray(value.purposes) || value.purposes.length === 0 || value.purposes.some((purpose) => !PURPOSES.has(String(purpose)))
        || new Set(value.purposes).size !== value.purposes.length) invalid();
    }
    if (value.prefer !== undefined) {
      const prefer = exactRecord(value.prefer, ["photoIds"], ["photoIds"]);
      if (!Array.isArray(prefer.photoIds) || prefer.photoIds.length > SHARING_LIMITS.claimPreferMaxPhotos || prefer.photoIds.some((id) => !isOpaqueWireId(id))) invalid();
    }
    return;
  }
  if (!isOpaqueWireId(value.jobId) || !isLeaseToken(value.leaseToken)) invalid();
  switch (operation) {
    case "renderJobs.startOutput":
      checkOutputRequest(value.output);
      return;
    case "renderJobs.renewOutput":
    case "renderJobs.commit":
      if (!isOpaqueWireId(value.uploadId)) invalid();
      return;
    case "renderJobs.fail":
      if (!FAILURE_CODES.has(String(value.code))) invalid();
      return;
  }
}

/** Checks a decoded success body against the request it answers. */
export function validateRenderJobResponse<K extends RenderExecutorOperation>(
  operation: K,
  request: RenderExecutorOperationMap[K]["request"],
  raw: unknown,
): RenderExecutorOperationMap[K]["response"] {
  const done = raw as RenderExecutorOperationMap[K]["response"];
  const fields = request as Record<string, unknown>;
  switch (operation) {
    case "renderJobs.claim": {
      const body = exactRecord(validateReceipt(raw).value, ["jobs"], ["jobs"]);
      const maxJobs = (fields.maxJobs as number | undefined) ?? 1;
      if (!Array.isArray(body.jobs) || body.jobs.length > maxJobs) invalid();
      const ids = new Set<string>();
      for (const claimed of body.jobs) {
        const entry = exactRecord(claimed, ["job", "lease"], ["job", "lease"]);
        const job = validateRenderJob(entry.job);
        const lease = exactRecord(entry.lease, ["jobId", "leaseToken", "expiresAt"], ["jobId", "leaseToken", "expiresAt"]);
        if (lease.jobId !== job.id || !isLeaseToken(lease.leaseToken) || !isInstant(lease.expiresAt)) invalid();
        // Claimed jobs only, each once, for a signed-in user's device.
        if (job.state !== "claimed" || job.executor.kind !== "userDevice" || ids.has(job.id)) invalid();
        ids.add(job.id);
      }
      return done;
    }
    case "renderJobs.startOutput": {
      const receipt = validateReceipt(raw);
      const start = exactRecord(receipt.value, ["uploadId", "expiresAt", "ticket"], ["uploadId", "expiresAt", "ticket"]);
      if (!isOpaqueWireId(start.uploadId) || !isInstant(start.expiresAt)) invalid();
      // The bearer ticket comes only in the first answer; a replay continues with renewOutput.
      if (receipt.replayed ? start.ticket !== null : !isTicketShape(start.ticket)) invalid();
      return done;
    }
    case "renderJobs.renewOutput": {
      const renewed = exactRecord(raw, ["uploadId", "expiresAt", "ticket"], ["uploadId", "expiresAt", "ticket"]);
      if (renewed.uploadId !== fields.uploadId || !isInstant(renewed.expiresAt) || !isTicketShape(renewed.ticket)) invalid();
      return done;
    }
    case "renderJobs.commit":
    case "renderJobs.fail": {
      const job = validateRenderJob(validateReceipt(raw).value);
      if (job.id !== fields.jobId) invalid();
      return done;
    }
  }
  return invalid();
}

/** One render job as the contract describes it (`RenderJob`). */
function validateRenderJob(value: unknown): { readonly id: string; readonly state: string; readonly executor: { readonly kind: string } } {
  const keys = ["id", "purpose", "executor", "photo", "binding", "recipe", "state", "attempt", "createdAt", "leaseExpiresAt", "failure", "expectedOutput"];
  const job = exactRecord(value, keys, keys);
  if (!isOpaqueWireId(job.id) || !JOB_STATES.has(String(job.state)) || !safeNonNegative(job.attempt) || !isInstant(job.createdAt)) invalid();
  if (job.leaseExpiresAt !== null && !isInstant(job.leaseExpiresAt)) invalid();
  if (job.failure !== null && !FAILURE_CODES.has(String(job.failure))) invalid();
  checkPurpose(job.purpose);
  const executor = isRecord(job.executor) ? job.executor : invalid();
  if (executor.kind === "userDevice") exactRecord(executor, ["kind", "userId"], ["kind", "userId"]);
  else if (executor.kind === "hostedMac") exactRecord(executor, ["kind", "connectorId"], ["kind", "connectorId"]);
  else invalid();
  if (!isOpaqueWireId(executor.userId ?? executor.connectorId)) invalid();
  const photo = exactRecord(job.photo, ["libraryId", "photoId"], ["libraryId", "photoId"]);
  if (!isOpaqueWireId(photo.libraryId) || !isOpaqueWireId(photo.photoId)) invalid();
  checkBinding(job.binding);
  checkRecipe(job.recipe);
  if (job.expectedOutput !== null) {
    const size = exactRecord(job.expectedOutput, ["width", "height"], ["width", "height"]);
    if (!integerBetween(size.width, 1, Number.MAX_SAFE_INTEGER) || !integerBetween(size.height, 1, Number.MAX_SAFE_INTEGER)) invalid();
  }
  return job as unknown as { readonly id: string; readonly state: string; readonly executor: { readonly kind: string } };
}

function checkPurpose(value: unknown): void {
  const purpose = isRecord(value) ? value : invalid();
  if (purpose.kind === "albumItem") {
    const item = exactRecord(purpose, ["kind", "albumId", "itemId", "itemRevision"], ["kind", "albumId", "itemId", "itemRevision"]);
    if (!isOpaqueWireId(item.albumId) || !isOpaqueWireId(item.itemId) || !safeNonNegative(item.itemRevision)) invalid();
  } else if (purpose.kind === "preview") {
    exactRecord(purpose, ["kind"], ["kind"]);
  } else if (purpose.kind === "export") {
    const exported = exactRecord(purpose, ["kind", "exportId"], ["kind", "exportId"]);
    if (!isOpaqueWireId(exported.exportId)) invalid();
  } else invalid();
}

function checkBinding(value: unknown): void {
  const keys = ["sourceGeneration", "sourceSha256", "recipeRevision", "settingsSha256", "engine", "rendererManifestSha256", "maskSurfaceIds"];
  const binding = exactRecord(value, keys, keys);
  if (!safeNonNegative(binding.sourceGeneration) || !isSha256(binding.sourceSha256) || !safeNonNegative(binding.recipeRevision)) invalid();
  if (!isSha256(binding.settingsSha256) || !isEngine(binding.engine) || !isSha256(binding.rendererManifestSha256)) invalid();
  if (!Array.isArray(binding.maskSurfaceIds) || binding.maskSurfaceIds.some((id) => !isSha256(id))) invalid();
}

function checkRecipe(value: unknown): void {
  const keys = ["revision", "settings", "settingsSha256", "baseVersion", "maskSurfaceIds", "updatedAt"];
  const recipe = exactRecord(value, keys, keys);
  if (!safeNonNegative(recipe.revision) || !isSha256(recipe.settingsSha256) || !isInstant(recipe.updatedAt)) invalid();
  if (recipe.baseVersion !== null && (typeof recipe.baseVersion !== "string" || recipe.baseVersion.length === 0 || recipe.baseVersion.length > 256)) invalid();
  if (!Array.isArray(recipe.maskSurfaceIds) || recipe.maskSurfaceIds.some((id) => !isSha256(id))) invalid();
  const settings = isRecord(recipe.settings) ? recipe.settings : invalid();
  if (!safeNonNegative(settings.v) || !isEngine(settings.engine)) invalid();
}

function checkOutputRequest(value: unknown): void {
  const output = isRecord(value) ? value : invalid();
  if (output.kind === "rendition") {
    const keys = ["kind", "sizeBytes", "sha256", "contentType", "width", "height", "metadata"];
    const rendition = exactRecord(output, keys, keys);
    if (rendition.contentType !== "image/jpeg" || !integerBetween(rendition.sizeBytes, 1, SHARING_LIMITS.fileUploadMaxBytes) || !isSha256(rendition.sha256)) invalid();
    checkPixels(rendition.width, rendition.height);
    const metadata = isRecord(rendition.metadata) ? rendition.metadata : invalid();
    if (Object.keys(metadata).some((key) => !METADATA_FIELDS.has(key))) invalid();
  } else if (output.kind === "preview") {
    const keys = ["kind", "sizeBytes", "sha256", "contentType", "width", "height"];
    const preview = exactRecord(output, keys, keys);
    if ((preview.contentType !== "image/jpeg" && preview.contentType !== "image/png") || !integerBetween(preview.sizeBytes, 1, SHARING_LIMITS.fileUploadMaxBytes) || !isSha256(preview.sha256)) invalid();
    checkPixels(preview.width, preview.height);
  } else invalid();
}

function checkPixels(width: unknown, height: unknown): void {
  if (!integerBetween(width, 1, Number.MAX_SAFE_INTEGER) || !integerBetween(height, 1, Number.MAX_SAFE_INTEGER)) invalid();
  if ((width as number) * (height as number) > SHARING_LIMITS.renditionMaxPixels) invalid();
}

function isTicketShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = ["url", "method", "headers", "expiresAt", "resumeOffsetBytes"];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) return false;
  // The trusted provider origin is checked again by the uploader (and by the BFF) before any byte is sent.
  return typeof value.url === "string" && value.url.startsWith("https://") && value.method === "PUT" && isInstant(value.expiresAt)
    && isRecord(value.headers) && Object.values(value.headers).every((header) => typeof header === "string") && safeNonNegative(value.resumeOffsetBytes);
}

function isLeaseToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && textEncoder.encode(value).byteLength <= MAX_LEASE_TOKEN_BYTES
    && !/[\p{Cc}\p{Cf}\s]/u.test(value);
}
function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
function isEngine(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && textEncoder.encode(value).byteLength <= MAX_ENGINE_BYTES && !/[\p{Cc}\p{Cf}]/u.test(value);
}
function integerBetween(value: unknown, min: number, max: number): value is number {
  return safeNonNegative(value) && value >= min && value <= max;
}
function invalid(): never {
  throw new PersonalPhotoCloudError("invalid_response");
}
