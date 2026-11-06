/**
 * The executor's renderer on the Mac app and the browser: the existing develop engine (#197) and its JPEG export and
 * capture-time EXIF writer. No new pixel code and no engine version change; the capability declared is the probed
 * one (`probePhotoWebRenderer` / `probeCameraPhotoRenderer`), so jobs bound to another manifest are refused.
 *
 * Limits are declared from what this path really does: it decodes originals up to 4096 px on the long edge, so a larger
 * original is `full_resolution_unavailable` (a bytes-returning native full-size renderer is a separate port). Only
 * formats rendered from the original itself are declared (JPEG, PNG); RAW/HEIC/TIFF need their #197 working copy and
 * are not claimed here until that input is connected.
 */
import type { DevelopEngine } from "niho-photo-editing/develop-engine/develop-engine-client";
import { cropBoxFromGeometry, developFrameSize, readDevelopGeometry } from "niho-photo-editing/develop-engine/develop-geometry";
import { DEVELOP_WEB_IMAGE_JPEG_QUALITY, exportDevelopJpeg } from "niho-photo-editing/develop-engine/develop-render-input";
import { readDevelopSettings } from "niho-photo-editing/develop-engine/develop-settings";
import { readJpegPixelSize } from "niho-photo-editing/image-bytes-metadata";
import { cropOutputSize } from "niho-photo-editing/photo-editing-crop";

import type { PhotoFormat, RenderCapability } from "./contract";
import { SourceDeviceRenderFailure, type DeviceRenderer } from "./render-output";

/** Long edge the browser/WebView engine decodes in one shot (`develop-engine-worker-core`). */
export const DEVELOP_ENGINE_FULL_RESOLUTION_MAX_EDGE = 4096;
export const DEVELOP_ENGINE_RENDER_FORMATS: readonly PhotoFormat[] = ["jpeg", "png"];
/** Rounding of the crop box against the engine's integer output size. */
const FULL_RESOLUTION_TOLERANCE_PX = 2;

export interface CreateDevelopEngineDeviceRendererOptions {
  /** A ready engine created from the probed, pinned manifest. */
  readonly engine: Pick<DevelopEngine, "exportJpeg" | "exportWorkingCopyJpeg" | "withCaptureExif">;
  /** The probed renderer capability (its manifest sha256 is what jobs are bound to). */
  readonly capability: RenderCapability;
  /** JPEG quality on the engine's 1–100 scale (default: the engine's own web export quality, 90). */
  readonly quality?: number;
}

export function createDevelopEngineDeviceRenderer(options: CreateDevelopEngineDeviceRendererOptions): DeviceRenderer {
  const quality = options.quality ?? DEVELOP_WEB_IMAGE_JPEG_QUALITY;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new RangeError("quality is on the engine's 1-100 scale");
  return {
    capability: options.capability,
    formats: DEVELOP_ENGINE_RENDER_FORMATS,
    fullResolutionMaxEdge: DEVELOP_ENGINE_FULL_RESOLUTION_MAX_EDGE,
    async render(input, signal) {
      const settings = readDevelopSettings(input.recipe.settings);
      if (settings === null) throw new SourceDeviceRenderFailure("unsupported_settings");
      // The full-resolution size is what the recipe's geometry gives at the source's native scale: 90° rotations swap
      // the frame, the crop box (straightened or not) is measured in frame pixels.
      const geometry = readDevelopGeometry(settings);
      const box = cropBoxFromGeometry(geometry, developFrameSize({ width: input.source.width, height: input.source.height }, geometry.rotate));
      if (box === null) throw new SourceDeviceRenderFailure("unsupported_settings");
      const expected = cropOutputSize(box);
      const maxDimension = input.maxEdge ?? Math.max(expected.width, expected.height);
      // The engine takes ownership of the bytes it is given; pass a copy so the source stays intact.
      const bytes = new Uint8Array(input.source.bytes).buffer;
      const jpeg = await exportDevelopJpeg(options.engine as DevelopEngine, { kind: "original", bytes }, settings, {
        maxDimension,
        quality,
        maskSurfaces: input.loadMaskSurface,
      });
      // The engine cannot be interrupted mid-export; a cancelled job drops the result here.
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
      const size = readJpegPixelSize(jpeg);
      if (!size) throw new SourceDeviceRenderFailure("renderer_unavailable");
      const fullResolution = input.maxEdge === null &&
        Math.abs(size.width - expected.width) <= FULL_RESOLUTION_TOLERANCE_PX && Math.abs(size.height - expected.height) <= FULL_RESOLUTION_TOLERANCE_PX;
      // The engine writes untagged sRGB.
      return { bytes: jpeg, width: size.width, height: size.height, colorProfile: "sRGB", fullResolution };
    },
    async withCaptureTime(jpeg, capturedAtUtc, offsetMinutes) {
      return await options.engine.withCaptureExif(new Uint8Array(jpeg), capturedAtUtc, offsetMinutes);
    },
  };
}
