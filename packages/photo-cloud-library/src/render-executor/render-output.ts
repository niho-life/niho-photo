/**
 * One finished output (full-resolution rendition or reduced preview) from one original and one exact recipe, on the
 * device that holds the original (B07 #248). Pixels come from the existing engine through `DeviceRenderer`; nothing
 * here changes them. This module decides what may be rendered at all, scrubs and verifies metadata, and hashes the
 * bytes for the upload request. The job executor and the "add from this device" flow (B12) both use it.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readJpegPixelSize } from "niho-photo-editing/image-bytes-metadata";

import {
  SHARING_LIMITS,
  sanitizeRenditionMetadata,
  type PhotoFormat,
  type RecipeDocument,
  type RenderBinding,
  type RenderCapability,
  type RenderFailureCode,
  type RenderOutputRequest,
  type RenditionMetadata,
} from "./contract";
import { renditionMetadataViolations, stripJpegMetadata } from "./jpeg-metadata";

/** A refusal with the contract's failure code; the executor reports it with `renderJobs.fail`. */
export class SourceDeviceRenderFailure extends Error {
  constructor(readonly code: RenderFailureCode) {
    super(code);
    this.name = "SourceDeviceRenderFailure";
  }
}

/** The original, already checked against the bound generation and hash by the source port. */
export interface RenderSource {
  readonly bytes: Uint8Array;
  readonly format: PhotoFormat;
  /** Oriented pixel size of the original. */
  readonly width: number;
  readonly height: number;
  /** Capture time as recorded (local date-time without zone) and its UTC offset. Nothing else is read from the source. */
  readonly capturedAt: string | null;
  readonly capturedAtOffset: string | null;
}

export interface RenderedJpeg {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly colorProfile: "sRGB" | "displayP3";
  /**
   * The renderer's proof that a rendition is the full-resolution photo: its size equals what the recipe's geometry
   * (rotation, crop) gives at the source's native scale. Always false for previews.
   */
  readonly fullResolution: boolean;
}

/** The device's existing engine (#197), adapted. Implementations never resample a rendition below full resolution. */
export interface DeviceRenderer {
  readonly capability: RenderCapability;
  /** Formats this renderer decodes from the original at full resolution. Anything else is `unsupported_format`. */
  readonly formats: readonly PhotoFormat[];
  /** Longest source edge rendered at full resolution; above it a rendition is `full_resolution_unavailable`. */
  readonly fullResolutionMaxEdge: number;
  render(
    input: {
      readonly source: RenderSource;
      readonly recipe: RecipeDocument;
      /** null: full resolution (rendition). A number: preview long edge. */
      readonly maxEdge: number | null;
      readonly loadMaskSurface: (surfaceId: string) => Promise<Uint8Array | null>;
    },
    signal: AbortSignal,
  ): Promise<RenderedJpeg>;
  /** Writes the allowed capture-time EXIF (engine `withCaptureExif`). Omitted: the server writes capture time. */
  withCaptureTime?(jpeg: Uint8Array, capturedAtUtc: string, offsetMinutes: number): Promise<Uint8Array>;
}

export interface FinishedOutput {
  readonly kind: "rendition" | "preview";
  readonly bytes: Uint8Array;
  readonly request: RenderOutputRequest;
}

/** Long edge of previews (the contract's preview is a reduced working image, never shown as full resolution). */
export const SOURCE_DEVICE_PREVIEW_MAX_EDGE = 1280;
const OFFSET = /^([+-])(\d{2}):(\d{2})$/u;

/**
 * Whether this device may render a job at all, before reading or decoding anything. A job whose own recipe and
 * binding disagree, or that is bound to another renderer, is refused rather than rendered with different inputs.
 */
export function checkRenderable(capability: RenderCapability, binding: RenderBinding, recipe: RecipeDocument): RenderFailureCode | null {
  const sameMasks = recipe.maskSurfaceIds.length === binding.maskSurfaceIds.length &&
    [...recipe.maskSurfaceIds].sort().every((id, index) => id === [...binding.maskSurfaceIds].sort()[index]);
  if (recipe.revision !== binding.recipeRevision || recipe.settingsSha256 !== binding.settingsSha256 || recipe.settings.engine !== binding.engine || !sameMasks) {
    return "unsupported_settings";
  }
  if (binding.rendererManifestSha256 !== capability.manifestSha256 || !capability.engines.includes(binding.engine)) return "renderer_unavailable";
  if (!capability.settingsVersions.includes(recipe.settings.v)) return "unsupported_settings";
  if (binding.maskSurfaceIds.length > 0 && !capability.maskSurfaces) return "unsupported_settings";
  return null;
}

export async function renderFinishedOutput(input: {
  readonly renderer: DeviceRenderer;
  readonly source: RenderSource;
  readonly recipe: RecipeDocument;
  readonly binding: RenderBinding;
  readonly kind: "rendition" | "preview";
  readonly loadMaskSurface: (surfaceId: string) => Promise<Uint8Array | null>;
  readonly previewMaxEdge?: number;
  readonly signal: AbortSignal;
}): Promise<FinishedOutput> {
  const { renderer, source, kind, signal } = input;
  const refused = checkRenderable(renderer.capability, input.binding, input.recipe);
  if (refused) throw new SourceDeviceRenderFailure(refused);
  if (!renderer.formats.includes(source.format)) throw new SourceDeviceRenderFailure("unsupported_format");
  const sourceEdge = Math.max(source.width, source.height);
  if (!(source.width > 0 && source.height > 0) || source.bytes.byteLength > SHARING_LIMITS.fileUploadMaxBytes || source.width * source.height > SHARING_LIMITS.renditionMaxPixels) {
    throw new SourceDeviceRenderFailure("input_limit");
  }
  // A rendition is the full-resolution photo. A renderer that can only decode a downscaled source refuses instead of
  // publishing a smaller image as the finished photo (Epic §9).
  if (kind === "rendition" && sourceEdge > renderer.fullResolutionMaxEdge) throw new SourceDeviceRenderFailure("full_resolution_unavailable");
  const previewMaxEdge = input.previewMaxEdge ?? SOURCE_DEVICE_PREVIEW_MAX_EDGE;

  const rendered = await renderer.render(
    { source, recipe: input.recipe, maxEdge: kind === "rendition" ? null : previewMaxEdge, loadMaskSurface: input.loadMaskSurface },
    signal,
  );
  throwIfAborted(signal);
  // Never publish a smaller image as the finished photo: the renderer must prove the rendition is full resolution.
  if (kind === "rendition" && !rendered.fullResolution) throw new SourceDeviceRenderFailure("full_resolution_unavailable");
  if (kind === "preview" && Math.max(rendered.width, rendered.height) > previewMaxEdge) throw new SourceDeviceRenderFailure("renderer_unavailable");
  // Finished photos are untagged sRGB: the scrub drops ICC profiles, so another colour space would be misread.
  if (rendered.colorProfile !== "sRGB") throw new SourceDeviceRenderFailure("renderer_unavailable");

  let bytes: Uint8Array | null = stripJpegMetadata(rendered.bytes);
  if (bytes === null) throw new SourceDeviceRenderFailure("renderer_unavailable");
  const metadata: RenditionMetadata = sanitizeRenditionMetadata({
    capturedAt: source.capturedAt,
    capturedAtOffset: source.capturedAtOffset,
    colorProfile: rendered.colorProfile,
  });
  if (kind === "rendition" && metadata.capturedAt !== null && metadata.capturedAtOffset !== null && renderer.withCaptureTime) {
    const offsetMinutes = parseOffsetMinutes(metadata.capturedAtOffset);
    const utc = new Date(`${metadata.capturedAt}${metadata.capturedAtOffset}`).toISOString();
    bytes = await renderer.withCaptureTime(bytes, utc, offsetMinutes);
    throwIfAborted(signal);
  }
  // The finished bytes must carry nothing beyond the allow-list, whatever the renderer did.
  if (renditionMetadataViolations(bytes).length > 0) throw new SourceDeviceRenderFailure("renderer_unavailable");
  const size = readJpegPixelSize(bytes);
  if (!size || size.width !== rendered.width || size.height !== rendered.height) throw new SourceDeviceRenderFailure("renderer_unavailable");
  if (bytes.byteLength > SHARING_LIMITS.fileUploadMaxBytes) throw new SourceDeviceRenderFailure("input_limit");

  const common = { sizeBytes: bytes.byteLength, sha256: bytesToHex(sha256(bytes)), contentType: "image/jpeg" as const, width: size.width, height: size.height };
  const request: RenderOutputRequest = kind === "rendition" ? { kind: "rendition", ...common, metadata } : { kind: "preview", ...common };
  return { kind, bytes, request };
}

function parseOffsetMinutes(offset: string): number {
  const match = OFFSET.exec(offset);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
