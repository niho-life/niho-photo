import { parsePhotoIdentity, type PhotoIdentity } from "../identity.ts";
import type { PhotoAuthConfiguration } from "./config.ts";

export const ATTEMPT_MAX_LIFETIME_MS = 10 * 60 * 1000;
export const RESPONSE_MAX_BYTES = 16 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;

const CREDENTIAL = /^[A-Za-z0-9._~-]{16,4096}$/;
const BEGIN_KEYS = ["attemptId", "confirmationPath", "expiresAt"] as const;
const ACTOR_KEYS = ["id"] as const;
const ACTOR_ENVELOPE_KEYS = [
  "actor",
  "audience",
  "clientId",
  "expiresAt",
  "refreshRequired",
  "sessionEpoch",
  "sessionId",
] as const;
const CREDENTIAL_KEYS = [...ACTOR_ENVELOPE_KEYS, "credential"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isSafeCredential(value: unknown): value is string {
  return typeof value === "string" && CREDENTIAL.test(value);
}

export function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value === value.trim() && new TextEncoder().encode(value).byteLength <= 256
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

export interface ProducerBeginPayload {
  readonly attemptId: string;
  readonly expiresAt: string;
}

export function parseProducerBegin(
  value: unknown,
  config: PhotoAuthConfiguration,
  now: number,
): ProducerBeginPayload | null {
  if (!isRecord(value) || !exactKeys(value, BEGIN_KEYS)
    || value.confirmationPath !== config.endpoints.confirmation
    || !isOpaqueId(value.attemptId)
    || typeof value.expiresAt !== "string") return null;
  const expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiry)
    || new Date(expiry).toISOString() !== value.expiresAt
    || expiry <= now
    || expiry > now + ATTEMPT_MAX_LIFETIME_MS) return null;
  return Object.freeze({ attemptId: value.attemptId, expiresAt: value.expiresAt });
}

export function parseProducerActor(
  value: unknown,
  config: PhotoAuthConfiguration,
  now: number,
): PhotoIdentity | null {
  if (!isRecord(value) || !exactKeys(value, ACTOR_ENVELOPE_KEYS)
    || value.clientId !== config.clientId
    || value.audience !== config.audience
    || !isRecord(value.actor)
    || !exactKeys(value.actor, ACTOR_KEYS)
    || !isOpaqueId(value.actor.id)
    || !isOpaqueId(value.sessionId)
    || !isOpaqueId(value.sessionEpoch)
    || typeof value.refreshRequired !== "boolean") return null;
  return parsePhotoIdentity({
    userId: value.actor.id,
    sessionId: value.sessionId,
    sessionEpoch: value.sessionEpoch,
    expiresAt: value.expiresAt,
    transport: "browser-session",
  }, { now, requiredTransport: "browser-session" });
}

export interface ProducerCredentialPayload {
  readonly credential: string;
  readonly actor: PhotoIdentity;
}

export function parseProducerCredential(
  value: unknown,
  config: PhotoAuthConfiguration,
  now: number,
): ProducerCredentialPayload | null {
  if (!isRecord(value) || !exactKeys(value, CREDENTIAL_KEYS)
    || value.clientId !== config.clientId
    || value.audience !== config.audience
    || !isSafeCredential(value.credential)) return null;
  const actor = parseProducerActor({
    actor: value.actor,
    audience: value.audience,
    clientId: value.clientId,
    expiresAt: value.expiresAt,
    refreshRequired: value.refreshRequired,
    sessionEpoch: value.sessionEpoch,
    sessionId: value.sessionId,
  }, config, now);
  return actor === null ? null : Object.freeze({ credential: value.credential, actor });
}
