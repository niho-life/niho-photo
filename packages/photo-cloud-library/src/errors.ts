import type { PhotoErrorCode, PhotoErrorEnvelope } from "@niho/photo-personal-cloud-contract";
import { PHOTO_EDITING_PERSONAL_CLOUD_COPY } from "niho-photo-editing/photo-editing-copy";
import type { PhotoLibraryErrors } from "niho-photo-editing/library/photo-library";

export type PersonalPhotoCloudErrorCode =
  | "invalid_identity"
  | "scope_changed"
  | "disposed"
  | "invalid_response"
  | "unsupported"
  | "not_found"
  | "too_large"
  | "unavailable";

export class PersonalPhotoCloudError extends Error {
  constructor(readonly code: PersonalPhotoCloudErrorCode) {
    super(code);
    this.name = "PersonalPhotoCloudError";
  }
}

type ErrorDetails = {
  code: PhotoErrorCode;
  retryable: boolean;
  currentRevision: number | null;
  conflictId: string | null;
};

export function readPhotoError(error: unknown): ErrorDetails | null {
  if (!isRecord(error) || !isRecord(error.error)) return null;
  const value = error.error;
  if (typeof value.code !== "string" || typeof value.requestId !== "string" || typeof value.retryable !== "boolean") {
    return null;
  }
  if (!PHOTO_ERROR_CODES.has(value.code as PhotoErrorCode)) return null;
  const currentRevision = value.currentRevision;
  const conflictId = value.conflictId;
  if (currentRevision !== undefined && !isSafeNonNegativeInteger(currentRevision)) return null;
  if (conflictId !== undefined && typeof conflictId !== "string") return null;
  return {
    code: value.code as PhotoErrorCode,
    retryable: value.retryable,
    currentRevision: currentRevision ?? null,
    conflictId: conflictId ?? null,
  };
}

export function isPhotoErrorEnvelope(error: unknown): error is PhotoErrorEnvelope {
  return readPhotoError(error) !== null;
}

export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

export function publicError(error: unknown): PersonalPhotoCloudError | Error {
  if (isAbortError(error)) return error;
  if (error instanceof PersonalPhotoCloudError) return error;
  const backend = readPhotoError(error);
  if (backend?.code === "unauthenticated") return new PersonalPhotoCloudError("scope_changed");
  if (backend?.code === "not_found" || backend?.code === "photo_deleted") return new PersonalPhotoCloudError("not_found");
  if (backend?.code === "request_too_large") return new PersonalPhotoCloudError("too_large");
  if (backend?.code === "unsupported_format" || backend?.code === "unsupported_settings") {
    return new PersonalPhotoCloudError("unsupported");
  }
  return new PersonalPhotoCloudError("unavailable");
}

export const personalPhotoCloudErrors: PhotoLibraryErrors = {
  describe(error, fallback) {
    if (error instanceof PersonalPhotoCloudError) return describeCode(error.code);
    const backend = readPhotoError(error);
    if (backend) return describeBackendCode(backend.code);
    return fallback;
  },
  describeStorageError(error, fallback) {
    if (error instanceof PersonalPhotoCloudError) return describeCode(error.code);
    const backend = readPhotoError(error);
    return backend ? describeBackendCode(backend.code) : fallback;
  },
  describeDeleteFailure(errors) {
    if (errors.length === 1) return this.describe(errors[0], PHOTO_EDITING_PERSONAL_CLOUD_COPY.unavailable);
    return PHOTO_EDITING_PERSONAL_CLOUD_COPY.deleteFailedCount(errors.length);
  },
  isNativeError() {
    return false;
  },
  describeNative() {
    return PHOTO_EDITING_PERSONAL_CLOUD_COPY.unsupported;
  },
  isPermanentSaveFailure(error) {
    const backend = readPhotoError(error);
    return backend?.code === "not_found" || backend?.code === "invalid_request" || backend?.code === "origin_rejected";
  },
  isNotFound(error) {
    if (error instanceof PersonalPhotoCloudError) return error.code === "not_found";
    const backend = readPhotoError(error);
    return backend?.code === "not_found" || backend?.code === "photo_deleted";
  },
  readQuotaExceeded() {
    return null;
  },
  describeQuotaExceeded() {
    return PHOTO_EDITING_PERSONAL_CLOUD_COPY.quotaExceeded;
  },
  readDevelopRevisionStale() {
    return null;
  },
  isExportFolderNotFound() {
    return false;
  },
};

function describeCode(code: PersonalPhotoCloudErrorCode): string {
  switch (code) {
    case "invalid_identity":
    case "scope_changed":
    case "disposed":
      return PHOTO_EDITING_PERSONAL_CLOUD_COPY.notConnected;
    case "invalid_response":
      return PHOTO_EDITING_PERSONAL_CLOUD_COPY.invalidResponse;
    case "unsupported":
      return PHOTO_EDITING_PERSONAL_CLOUD_COPY.unsupported;
    case "not_found":
      return PHOTO_EDITING_PERSONAL_CLOUD_COPY.notFound;
    case "too_large":
      return PHOTO_EDITING_PERSONAL_CLOUD_COPY.tooLarge;
    case "unavailable":
      return PHOTO_EDITING_PERSONAL_CLOUD_COPY.unavailable;
  }
}

function describeBackendCode(code: PhotoErrorCode): string {
  if (code === "not_found" || code === "photo_deleted") return PHOTO_EDITING_PERSONAL_CLOUD_COPY.notFound;
  if (code === "quota_exceeded") return PHOTO_EDITING_PERSONAL_CLOUD_COPY.quotaExceeded;
  if (code === "request_too_large") return PHOTO_EDITING_PERSONAL_CLOUD_COPY.tooLarge;
  if (code === "unsupported_format" || code === "unsupported_settings") return PHOTO_EDITING_PERSONAL_CLOUD_COPY.unsupported;
  return PHOTO_EDITING_PERSONAL_CLOUD_COPY.unavailable;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const PHOTO_ERROR_CODES = new Set<PhotoErrorCode>([
  "invalid_request",
  "invalid_cursor",
  "unauthenticated",
  "origin_rejected",
  "not_found",
  "quota_exceeded",
  "revision_conflict",
  "idempotency_conflict",
  "upload_state_conflict",
  "photo_deleted",
  "account_deleting",
  "upload_expired",
  "cursor_expired",
  "request_too_large",
  "unsupported_format",
  "range_not_satisfiable",
  "content_rejected",
  "pixel_limit_exceeded",
  "unsupported_settings",
  "missing_mask_surface",
  "rate_limited",
  "temporarily_unavailable",
]);
