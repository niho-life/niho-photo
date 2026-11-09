/**
 * Source port for jobs on a member's own NIHO-cloud photos, rendered by their signed-in Mac app or browser (B07 #248).
 * It reads the original through the existing personal library handle (`rawPhoto` + `readAsset`), so the same scope
 * fence, range checks and byte budget apply. The bytes are hashed and must equal the job's bound hash; nothing else
 * is substituted. Only capture time leaves the source (as UTC; the original's zone is not stored in v2).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { contentBytes } from "../content";
import type { PersonalPhotoCloudLibraryHandle } from "../types";

import type { LibraryId } from "./contract";
import type { RenderSourcePort } from "./render-executor";

/** v2 personal photos have a single source generation (B00 compat-v2 `personalSourceGeneration`). */
const PERSONAL_SOURCE_GENERATION = 1;

export function createPersonalCloudRenderSource(input: {
  readonly libraryId: LibraryId;
  readonly handle: Pick<PersonalPhotoCloudLibraryHandle, "rawPhoto" | "readAsset">;
  readonly loadMaskSurface?: (photoId: string, surfaceId: string) => Promise<Uint8Array | null>;
}): RenderSourcePort {
  return {
    async open(photo, expected, signal) {
      if (photo.libraryId !== input.libraryId) return { kind: "missing" };
      const current = await input.handle.rawPhoto(photo.photoId, { signal });
      if (current === null) return { kind: "missing" };
      if (expected.generation !== PERSONAL_SOURCE_GENERATION || current.original.sha256 !== expected.sha256) return { kind: "changed" };
      const bytes = await contentBytes(await input.handle.readAsset(photo.photoId, current.original, undefined, { signal }));
      if (bytesToHex(sha256(bytes)) !== expected.sha256) return { kind: "changed" };
      const captured = current.capturedAt === null ? null : new Date(current.capturedAt);
      const capturedAt = captured && Number.isFinite(captured.getTime()) ? captured.toISOString().slice(0, 19) : null;
      return {
        kind: "ok",
        source: {
          bytes, format: current.format, width: current.width, height: current.height,
          capturedAt, capturedAtOffset: capturedAt === null ? null : "+00:00",
        },
      };
    },
    async loadMaskSurface(photo, surfaceId) {
      if (photo.libraryId !== input.libraryId || !input.loadMaskSurface) return null;
      return await input.loadMaskSurface(photo.photoId, surfaceId);
    },
  };
}
