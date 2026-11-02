export type PhotoIdentityTransport = "browser-session" | "mac-bearer";

/** Safe UI fencing metadata. It is never an authorization proof. */
export interface PhotoIdentity {
  readonly userId: string;
  readonly sessionId: string;
  readonly sessionEpoch: string;
  readonly transport: PhotoIdentityTransport;
  readonly expiresAt: string;
}

export interface PhotoIdentityValidationOptions {
  readonly now: number;
  readonly allowExpired?: boolean;
  readonly requiredTransport?: PhotoIdentityTransport;
}

const ID_MAX_BYTES = 256;
const MAX_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const IDENTITY_KEYS = ["expiresAt", "sessionEpoch", "sessionId", "transport", "userId"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && new TextEncoder().encode(value).byteLength <= ID_MAX_BYTES
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function parseExpiry(value: unknown, options: PhotoIdentityValidationOptions): string | null {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return null;
  if ((!options.allowExpired && time <= options.now) || time > options.now + MAX_LIFETIME_MS) return null;
  return value;
}

/** Parses the closed producer/native metadata DTO. Unknown claims are rejected, not ignored. */
export function parsePhotoIdentity(
  value: unknown,
  options: PhotoIdentityValidationOptions,
): PhotoIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, IDENTITY_KEYS)) return null;
  if (!isOpaqueId(value.userId) || !isOpaqueId(value.sessionId) || !isOpaqueId(value.sessionEpoch)) return null;
  if (value.transport !== "browser-session" && value.transport !== "mac-bearer") return null;
  if (options.requiredTransport !== undefined && value.transport !== options.requiredTransport) return null;
  const expiresAt = parseExpiry(value.expiresAt, options);
  if (expiresAt === null) return null;
  return Object.freeze({
    userId: value.userId,
    sessionId: value.sessionId,
    sessionEpoch: value.sessionEpoch,
    transport: value.transport,
    expiresAt,
  });
}

/** Expiry rotation is not a logical account/session change. */
export function samePhotoIdentityScope(left: PhotoIdentity, right: PhotoIdentity): boolean {
  return left.userId === right.userId
    && left.sessionId === right.sessionId
    && left.sessionEpoch === right.sessionEpoch
    && left.transport === right.transport;
}

export function isPhotoIdentityExpired(identity: PhotoIdentity, now: number): boolean {
  return Date.parse(identity.expiresAt) <= now;
}
