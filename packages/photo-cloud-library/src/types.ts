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
  client: PersonalPhotoCloudClient;
  identity: PersonalPhotoCloudIdentity;
  hostRenderer: RenderCapability;
  engineAssets: PhotoLibraryEngineAssets;
  presets: PhotoLibraryPresets;
  memoryBudgets: PersonalPhotoCloudMemoryBudgets;
  clock?: { now(): number };
  urls?: PersonalPhotoCloudUrlFactory;
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
