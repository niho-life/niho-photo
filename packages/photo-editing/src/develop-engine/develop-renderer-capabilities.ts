export const DEVELOP_RENDERER_FEATURES = ["geometry", "masks", "colorGradingLuminance"] as const;
export type DevelopRendererFeature = (typeof DEVELOP_RENDERER_FEATURES)[number];

export const DEVELOP_RENDERER_MASK_KINDS = ["linear", "radial", "brush", "subject", "sky"] as const;
export type DevelopRendererMaskKind = (typeof DEVELOP_RENDERER_MASK_KINDS)[number];

/** The renderer contract declared by the running develop runtime. */
export type DevelopRendererCapabilities = Readonly<{
  schemaVersion: 1;
  crateVersion: string;
  settingsVersions: readonly number[];
  engines: readonly string[];
  features: readonly DevelopRendererFeature[];
  maskKinds: readonly DevelopRendererMaskKind[];
  maskSurfaces: boolean;
}>;

const CAPABILITY_KEYS = [
  "schemaVersion",
  "crateVersion",
  "settingsVersions",
  "engines",
  "features",
  "maskKinds",
  "maskSurfaces",
] as const;
const MAX_CRATE_VERSION_LENGTH = 64;
const MAX_SETTINGS_VERSIONS = 32;
const MAX_ENGINES = 64;
const MAX_ENGINE_LENGTH = 64;
const ENGINE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === CAPABILITY_KEYS.length && CAPABILITY_KEYS.every((key) => Object.hasOwn(value, key));
}

function readUniqueArray<T>(
  value: unknown,
  maxLength: number,
  read: (item: unknown) => T | null,
): readonly T[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxLength) return null;
  const result: T[] = [];
  const seen = new Set<T>();
  for (const item of value) {
    const parsed = read(item);
    if (parsed === null || seen.has(parsed)) return null;
    seen.add(parsed);
    result.push(parsed);
  }
  return Object.freeze(result);
}

/**
 * Reads schema 1 without inferring anything from an SDK or crate version.
 * Invalid, incomplete, unknown or oversized declarations close to `null`.
 * A successful result is a fresh deeply frozen snapshot.
 */
export function parseDevelopRendererCapabilities(value: unknown): DevelopRendererCapabilities | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value) || value.schemaVersion !== 1 || typeof value.maskSurfaces !== "boolean") {
      return null;
    }
    if (
      typeof value.crateVersion !== "string" ||
      value.crateVersion.length === 0 ||
      value.crateVersion.length > MAX_CRATE_VERSION_LENGTH ||
      !SEMVER.test(value.crateVersion)
    ) {
      return null;
    }
    const settingsVersions = readUniqueArray(value.settingsVersions, MAX_SETTINGS_VERSIONS, (item) =>
      typeof item === "number" && Number.isSafeInteger(item) && item > 0 ? item : null,
    );
    const engines = readUniqueArray(value.engines, MAX_ENGINES, (item) =>
      typeof item === "string" && item.length > 0 && item.length <= MAX_ENGINE_LENGTH && ENGINE_TOKEN.test(item) ? item : null,
    );
    const features = readUniqueArray(value.features, DEVELOP_RENDERER_FEATURES.length, (item) =>
      typeof item === "string" && DEVELOP_RENDERER_FEATURES.includes(item as DevelopRendererFeature)
        ? (item as DevelopRendererFeature)
        : null,
    );
    const maskKinds = readUniqueArray(value.maskKinds, DEVELOP_RENDERER_MASK_KINDS.length, (item) =>
      typeof item === "string" && DEVELOP_RENDERER_MASK_KINDS.includes(item as DevelopRendererMaskKind)
        ? (item as DevelopRendererMaskKind)
        : null,
    );
    if (!settingsVersions || !engines || !features || !maskKinds) return null;
    return Object.freeze({
      schemaVersion: 1,
      crateVersion: value.crateVersion,
      settingsVersions,
      engines,
      features,
      maskKinds,
      maskSurfaces: value.maskSurfaces,
    });
  } catch {
    return null;
  }
}
