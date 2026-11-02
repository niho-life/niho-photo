export const PHOTO_WEB_ORIGIN = "https://photo.niho.life" as const;
export const NIHO_PRODUCTION_ORIGIN = "https://niho.life" as const;
export const PHOTO_WEB_CLIENT_ID = "niho-photo-web" as const;
export const PHOTO_AUDIENCE = "niho-photo" as const;
export const PHOTO_CALLBACK_PATH = "/auth/callback" as const;

export type PhotoAuthProducerOperation =
  | "begin"
  | "exchange"
  | "introspect"
  | "refresh"
  | "revoke"
  | "cancel"
  | "confirmation";

export type PhotoAuthProducerPaths = Readonly<Record<PhotoAuthProducerOperation, string>>;

export interface PhotoAuthCopy {
  readonly startTitle: string;
  readonly startMessage: string;
  readonly startSubmitLabel: string;
  readonly relayTitle: string;
  readonly relayMessage: string;
  readonly relaySubmitLabel: string;
}

export interface PhotoAuthConfiguration {
  readonly enabled: true;
  readonly photoOrigin: typeof PHOTO_WEB_ORIGIN;
  readonly nihoOrigin: typeof NIHO_PRODUCTION_ORIGIN;
  readonly clientId: typeof PHOTO_WEB_CLIENT_ID;
  readonly audience: typeof PHOTO_AUDIENCE;
  readonly callbackPath: typeof PHOTO_CALLBACK_PATH;
  readonly endpoints: PhotoAuthProducerPaths;
  readonly copy: PhotoAuthCopy;
}

const CONFIG_KEYS = [
  "audience",
  "callbackPath",
  "clientId",
  "copy",
  "enabled",
  "endpoints",
  "nihoOrigin",
  "photoOrigin",
] as const;
const ENDPOINT_KEYS = ["begin", "cancel", "confirmation", "exchange", "introspect", "refresh", "revoke"] as const;
const COPY_KEYS = [
  "relayMessage",
  "relaySubmitLabel",
  "relayTitle",
  "startMessage",
  "startSubmitLabel",
  "startTitle",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function trustedPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= 256
    && value.startsWith("/")
    && !value.startsWith("//")
    && /^\/[A-Za-z0-9._~/-]+$/.test(value)
    && !value.split("/").some((part) => part === "." || part === "..")
    && new URL(value, NIHO_PRODUCTION_ORIGIN).pathname === value;
}

function requiredCopy(value: unknown): value is PhotoAuthCopy {
  if (!isRecord(value) || !exactKeys(value, COPY_KEYS)) return false;
  return COPY_KEYS.every((key) => typeof value[key] === "string"
    && value[key].length > 0
    && value[key].length <= 200
    && !/[\p{Cc}\p{Cf}]/u.test(value[key] as string));
}

/** Startup configuration is trusted only after all fixed product values and explicit paths match. */
export function parsePhotoAuthConfiguration(value: unknown): PhotoAuthConfiguration | null {
  if (!isRecord(value) || !exactKeys(value, CONFIG_KEYS)
    || value.enabled !== true
    || value.photoOrigin !== PHOTO_WEB_ORIGIN
    || value.nihoOrigin !== NIHO_PRODUCTION_ORIGIN
    || value.clientId !== PHOTO_WEB_CLIENT_ID
    || value.audience !== PHOTO_AUDIENCE
    || value.callbackPath !== PHOTO_CALLBACK_PATH
    || !isRecord(value.endpoints)
    || !requiredCopy(value.copy)) return null;
  const endpoints = value.endpoints;
  if (!exactKeys(endpoints, ENDPOINT_KEYS)
    || !ENDPOINT_KEYS.every((key) => trustedPath(endpoints[key]))
    || new Set(ENDPOINT_KEYS.map((key) => endpoints[key])).size !== ENDPOINT_KEYS.length) return null;
  const endpointCopy = Object.freeze(Object.fromEntries(
    ENDPOINT_KEYS.map((key) => [key, endpoints[key] as string]),
  )) as PhotoAuthProducerPaths;
  const copy = value.copy as unknown as PhotoAuthCopy;
  const copyCopy = Object.freeze(Object.fromEntries(
    COPY_KEYS.map((key) => [key, copy[key]]),
  )) as unknown as PhotoAuthCopy;
  return Object.freeze({
    enabled: true,
    photoOrigin: PHOTO_WEB_ORIGIN,
    nihoOrigin: NIHO_PRODUCTION_ORIGIN,
    clientId: PHOTO_WEB_CLIENT_ID,
    audience: PHOTO_AUDIENCE,
    callbackPath: PHOTO_CALLBACK_PATH,
    endpoints: endpointCopy,
    copy: copyCopy,
  });
}
