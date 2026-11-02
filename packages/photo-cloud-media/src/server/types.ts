import type {
  Photo,
  PhotoAsset,
  RenderCapability,
  Sha256,
} from "../../../photo-library-contract/src/v2.ts";
import type { CloudRenderInput, MediaRecipeValidator } from "../types.ts";

/** Trusted existing backend read model, never parsed from a request body. */
export interface MediaSource {
  readonly ownerId: string;
  readonly originalGeneration: string;
  readonly lifecycleGeneration: number;
  readonly photo: Photo;
}

export interface MediaIdentity {
  readonly version: 1;
  readonly ownerId: string;
  readonly libraryId: string;
  readonly photoId: string;
  readonly lifecycleGeneration: number;
  readonly originalGeneration: string;
  readonly original: PhotoAsset;
  readonly format: Photo["format"];
  readonly width: number;
  readonly height: number;
  readonly inputAsset: PhotoAsset;
  readonly baseVersion: string | null;
  readonly encoding: "original" | "png16" | "jpeg8";
  readonly workingCopyMetaSha256: Sha256 | null;
  readonly recipeRevision: number;
  readonly settingsSha256: Sha256;
  readonly maskSurfaceIds: readonly Sha256[];
  readonly rendererManifestSha256: Sha256;
  readonly outputPolicy: { readonly thumbnailMaxEdge: number; readonly previewMaxEdge: number };
}

export interface MediaMaskInput {
  readonly surfaceId: Sha256;
  readonly asset: PhotoAsset;
}

export interface ProviderRenderRequest {
  readonly source: MediaSource;
  readonly input: CloudRenderInput;
  readonly masks: readonly MediaMaskInput[];
  /** Existing backend resolves ownership and immutable generation before opening bytes. */
  readonly readAsset: (asset: PhotoAsset, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;
  readonly signal: AbortSignal;
}

export interface MediaRenderedAsset {
  readonly kind: "thumbnail" | "preview";
  readonly bytes: Uint8Array;
  readonly sha256: Sha256;
  readonly contentType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly colorSpace: "srgb";
  readonly orientationApplied: true;
  readonly privateMetadataRemoved: true;
}

export interface MediaRenderResult {
  readonly identity: MediaIdentity;
  readonly identityKey: Sha256;
  readonly renderer: RenderCapability;
  readonly assets: readonly MediaRenderedAsset[];
}

export interface PinnedMediaProviderOptions {
  /** Trusted deployment setting. Each call creates/removes a private child directory. */
  readonly scratchRoot: string;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxMaskTotalBytes: number;
  readonly validateRecipe: MediaRecipeValidator;
}

/** Rendering does not register ingest support or publish anything. Backend owns claim/publish fences. */
export interface PinnedMediaProvider {
  render(request: ProviderRenderRequest): Promise<MediaRenderResult>;
}
