import type {
  PersonalPhotoCloudClient,
  Photo,
  PhotoAsset,
  PhotoByteRange,
  PhotoContent,
  QuotaUsage,
  RenderCapability,
  VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";
import type {
  PhotoLibrary,
  PhotoLibraryEngineAssets,
  PhotoLibraryPresets,
  PhotoLibraryRequestOptions,
} from "niho-photo-editing/library/photo-library";
import type { PersonalPhotoResumableUploadState } from "./browser/resumable-upload";

/** Native host keeps provider authority private; the shared barrier owns durable PNGs and operation keys. */
export type PersonalPhotoCloudMaskUploader = {
  upload(input: {
    readonly photoId: string;
    readonly surfaceId: string;
    readonly bytes: Uint8Array;
    readonly idempotencyKey: string;
    readonly uploadState: PersonalPhotoResumableUploadState;
    readonly compareAndSetUploadState: (
      expected: PersonalPhotoResumableUploadState,
      next: PersonalPhotoResumableUploadState,
      signal: AbortSignal,
    ) => Promise<boolean>;
    readonly signal: AbortSignal;
  }): Promise<void>;
};

export type PersonalPhotoCloudMaskValidator = {
  validateMaskSurface(png: Uint8Array, signal: AbortSignal): Promise<{ readonly id: string; readonly width: number; readonly height: number }>;
};

export type PersonalPhotoCloudIdentity = {
  getSnapshot(): VerifiedPhotoActor | null;
  subscribe(listener: () => void): () => void;
};

export type PersonalPhotoCloudMemoryBudgets = {
  /** Adapterの一時materialization上限。Blob/Fileへの移管後のcaller所有メモリは含めない。 */
  originalBytes: number;
  /** Adapterの一時materialization上限。ArrayBufferへの移管後のcaller所有メモリは含めない。 */
  workingCopyBytes: number;
  /** 一時materializationと、releaseまでadapterが保持するBlob URLの合計上限。 */
  previewBytes: number;
};

export type PersonalPhotoCloudUrlFactory = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
};

export type CreatePersonalPhotoCloudLibraryOptions = {
  /** Native binary port. Invoked only after the shared journal's durable barrier. */
  maskUploader?: PersonalPhotoCloudMaskUploader;
  client: PersonalPhotoCloudClient;
  identity: PersonalPhotoCloudIdentity;
  hostRenderer: RenderCapability;
  engineAssets: PhotoLibraryEngineAssets;
  presets: PhotoLibraryPresets;
  memoryBudgets: PersonalPhotoCloudMemoryBudgets;
  clock?: { now(): number };
  urls?: PersonalPhotoCloudUrlFactory;
  /** Actual host SDK decoder; declarations alone never enable bitmap recipes. */
  maskSurfaceValidator?: {
    validateMaskSurface(png: Uint8Array): Promise<{ id: string; width: number; height: number }>;
  };
  /** Verified bitmap reader paired with the validator. */
  maskSurfaceReader?: {
    loadMaskSurface(photoId: string, surfaceId: string): Promise<Uint8Array | null>;
  };
};

export type PersonalPhotoCloudLibraryHandle = {
  library: PhotoLibrary;
  usage(options?: PhotoLibraryRequestOptions): Promise<QuotaUsage>;
  rawPhoto(photoId: string, options?: PhotoLibraryRequestOptions): Promise<Photo | null>;
  readAsset(
    photoId: string,
    asset: PhotoAsset,
    range?: PhotoByteRange,
    options?: PhotoLibraryRequestOptions,
  ): Promise<PhotoContent>;
  /** UIが表示を終えたedited previewのBlob URLを明示的に解放する。省略時は全件。 */
  releasePreviewResources(photoIds?: readonly string[]): void;
  dispose(): void;
};
