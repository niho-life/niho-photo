import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

import { isOpaqueId, isSafeCredential } from "./protocol.ts";

export const PHOTO_PENDING_COOKIE = "__Host-niho-photo-pending" as const;
export const PHOTO_CREDENTIAL_COOKIE = "__Host-niho-photo-credential" as const;
const COOKIE_FLAGS = "HttpOnly; Secure; SameSite=Lax; Path=/";
const MAX_COOKIE_BYTES = 4096;

export interface PendingAttempt {
  readonly attemptId: string;
  readonly state: string;
  readonly verifier: string;
  readonly expiresAt: number;
}

export type AuthCookies =
  | { readonly ok: true; readonly pending: PendingAttempt | null; readonly credential: string | null }
  | { readonly ok: false };

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function cookieValues(header: string | null, name: string): string[] {
  if (header === null) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0 || part.slice(0, separator).trim() !== name) continue;
    values.push(part.slice(separator + 1).trim());
  }
  return values;
}

function singleton(values: readonly string[]): string | null | false {
  if (values.length === 0) return null;
  if (values.length !== 1 || values[0] === undefined || values[0].length === 0
    || Buffer.byteLength(values[0], "utf8") > MAX_COOKIE_BYTES) return false;
  return values[0];
}

export function encodePendingAttempt(pending: PendingAttempt): string {
  return Buffer.from(JSON.stringify(pending), "utf8").toString("base64url");
}

export function parsePendingAttempt(raw: string): PendingAttempt | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["attemptId", "expiresAt", "state", "verifier"])
    || !isOpaqueId(record.attemptId)
    || typeof record.state !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(record.state)
    || typeof record.verifier !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(record.verifier)
    || typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
  return Object.freeze({
    attemptId: record.attemptId,
    state: record.state,
    verifier: record.verifier,
    expiresAt: record.expiresAt,
  }) as PendingAttempt;
}

export function readAuthCookies(request: Request): AuthCookies {
  if (request.headers.has("authorization")) return { ok: false };
  const header = request.headers.get("cookie");
  const pendingRaw = singleton(cookieValues(header, PHOTO_PENDING_COOKIE));
  const credentialRaw = singleton(cookieValues(header, PHOTO_CREDENTIAL_COOKIE));
  if (pendingRaw === false || credentialRaw === false) return { ok: false };
  const pending = pendingRaw === null ? null : parsePendingAttempt(pendingRaw);
  if (pendingRaw !== null && pending === null) return { ok: false };
  if (credentialRaw !== null && !isSafeCredential(credentialRaw)) return { ok: false };
  return { ok: true, pending, credential: credentialRaw };
}

export function setPendingCookie(pending: PendingAttempt, now: number): string {
  const maxAge = Math.max(1, Math.ceil((pending.expiresAt - now) / 1000) + 10);
  return `${PHOTO_PENDING_COOKIE}=${encodePendingAttempt(pending)}; Max-Age=${maxAge}; ${COOKIE_FLAGS}`;
}

export function setCredentialCookie(credential: string, expiresAt: string, now: number): string {
  const maxAge = Math.max(1, Math.floor((Date.parse(expiresAt) - now) / 1000));
  const serialized = `${PHOTO_CREDENTIAL_COOKIE}=${credential}; Max-Age=${maxAge}; ${COOKIE_FLAGS}`;
  if (!isSafeCredential(credential) || Buffer.byteLength(serialized, "utf8") > MAX_COOKIE_BYTES) {
    throw new Error("invalid Photo cookie");
  }
  return serialized;
}

export function clearPendingCookie(): string {
  return `${PHOTO_PENDING_COOKIE}=; Max-Age=0; ${COOKIE_FLAGS}`;
}

export function clearCredentialCookie(): string {
  return `${PHOTO_CREDENTIAL_COOKIE}=; Max-Age=0; ${COOKIE_FLAGS}`;
}

export function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
