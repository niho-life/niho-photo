import type {
  PersonalPhotoLibrary,
  Photo,
  RecipeCandidate,
  RecipeDocument,
  RenderCapability,
} from "@niho/photo-personal-cloud-contract";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  hasDevelopGeometry,
  readDevelopSettings,
  supportsDevelopSettingsWrite,
  type DevelopSettings,
} from "niho-photo-editing/develop-engine/develop-settings";
import { readDevelopMasks } from "niho-photo-editing/develop-engine/develop-masks";
import { hasPhotoEditingColorGradingNativeExportUnsupportedLuminance } from "niho-photo-editing/photo-editing-color-grading";

import { validateRenderer } from "./validation";

export function projectRecipeSettings(
  photo: Photo,
  cloud: PersonalPhotoLibrary,
  host: RenderCapability,
): DevelopSettings | null {
  const settings = readDevelopSettings(photo.recipe.settings);
  if (!settings || !supportsDevelopSettingsWrite(settings)) return null;
  const renderer = rendererIntersection(cloud.capabilities.renderer, host);
  if (!renderer || !renderer.settingsVersions.includes(settings.v) || !renderer.engines.includes(settings.engine)) return null;
  if (hasDevelopGeometry(settings) && !renderer.features.includes("geometry")) return null;
  if (
    hasPhotoEditingColorGradingNativeExportUnsupportedLuminance(settings) &&
    !renderer.features.includes("colorGradingLuminance")
  ) return null;
  const masks = readDevelopMasks(settings);
  if (masks.length > 0 || photo.recipe.maskSurfaceIds.length > 0) {
    if (!renderer.features.includes("masks")) return null;
    if (masks.some((mask) => !renderer.maskKinds.includes(mask.kind))) return null;
    const settingsSurfaceIds = masks.flatMap((mask) => ("surface" in mask ? [mask.surface.id] : []));
    if (
      new Set(settingsSurfaceIds).size !== settingsSurfaceIds.length ||
      settingsSurfaceIds.length !== photo.recipe.maskSurfaceIds.length ||
      settingsSurfaceIds.some((id) => !photo.recipe.maskSurfaceIds.includes(id))
    ) return null;
    const needsSurfaces = photo.recipe.maskSurfaceIds.length > 0 ||
      masks.some((mask) => mask.kind === "brush" || mask.kind === "subject" || mask.kind === "sky");
    if (needsSurfaces && (!renderer.maskSurfaces || !cloud.capabilities.maskSurfaces)) return null;
    // The public adapter still has no bitmap mask reader. Preserve these recipes as read-only.
    if (needsSurfaces) return null;
  }
  return settings;
}

export function rendererIntersection(server: RenderCapability, host: RenderCapability): RenderCapability | null {
  validateRenderer(server);
  validateRenderer(host);
  if (
    server.sdkVersion !== host.sdkVersion ||
    server.crateVersion !== host.crateVersion ||
    server.manifestSha256 !== host.manifestSha256
  ) return null;
  const settingsVersions = intersection(server.settingsVersions, host.settingsVersions);
  const engines = intersection(server.engines, host.engines);
  if (settingsVersions.length === 0 || engines.length === 0) return null;
  return {
    sdkVersion: server.sdkVersion,
    crateVersion: server.crateVersion,
    manifestSha256: server.manifestSha256,
    settingsVersions,
    engines,
    features: intersection(server.features, host.features),
    maskKinds: intersection(server.maskKinds, host.maskKinds),
    maskSurfaces: server.maskSurfaces && host.maskSurfaces,
  };
}

export function recipeCandidateMatches(candidate: RecipeCandidate, recipe: RecipeDocument): boolean {
  return candidate.settingsSha256 === recipe.settingsSha256 && recipeCandidateBodyMatches(candidate, recipe);
}

export function recipeCandidateBodyMatches(
  candidate: Pick<RecipeCandidate, "settings" | "baseVersion" | "maskSurfaceIds">,
  recipe: Pick<RecipeDocument, "settings" | "baseVersion" | "maskSurfaceIds">,
): boolean {
  return candidate.baseVersion === recipe.baseVersion &&
    deepEqual(candidate.settings, recipe.settings) &&
    deepEqual(candidate.maskSurfaceIds, recipe.maskSurfaceIds);
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
  }
  return false;
}

export function jsonStructuralFingerprint(value: unknown): string {
  const canonical = canonicalJson(value, new Set<object>());
  return Array.from(sha256(new TextEncoder().encode(canonical)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Value is not finite JSON");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || !isPlainRecord(value) && !Array.isArray(value)) {
    throw new TypeError("Value is not plain JSON");
  }
  if (ancestors.has(value)) throw new TypeError("Value is cyclic");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function intersection<T extends string | number>(left: readonly T[], right: readonly T[]): T[] {
  const accepted = new Set(right);
  return left.filter((value) => accepted.has(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.prototype.propertyIsEnumerable.call(value, key));
}
