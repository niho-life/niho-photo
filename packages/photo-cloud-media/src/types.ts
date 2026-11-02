import type {
  PhotoAsset,
  RecipeDocument,
  Sha256,
  WorkingCopy,
} from "../../photo-library-contract/src/v2.ts";

/** Locator/credential-free input plan. It is a selector, never authorization proof. */
export type CloudRenderInput = {
  readonly photoId: string;
  readonly libraryId: string;
  readonly originalSha256: Sha256;
  readonly originalAssetId: string;
  readonly asset: PhotoAsset;
  /** Export remains bounded by this input's real pixels, not original dimensions. */
  readonly exportMaxEdge: number;
} & (
  | { readonly kind: "original"; readonly format: "jpeg" | "png" }
  | {
      readonly kind: "workingCopy";
      readonly encoding: WorkingCopy["encoding"];
      readonly baseVersion: string;
      readonly meta: WorkingCopy["meta"];
    }
);

export interface RenderInputLimits {
  readonly maxBytes: number;
  readonly maxPixels: number;
}

export type CloudRenderSelection =
  | { readonly state: "ready"; readonly input: CloudRenderInput }
  | {
      readonly state: "unavailable";
      readonly reason: "unsupported_settings" | "base_unavailable" | "media_pending" | "input_limit" | "invalid_metadata";
    };

/** C02 owns canonical JSON, recipe hash/base/mask validation and capability intersection. */
export interface ValidatedMediaRecipe {
  readonly canonicalSettings: string;
  readonly settingsSha256: Sha256;
  readonly baseVersion: string | null;
  readonly maskSurfaceIds: readonly Sha256[];
}
export type MediaRecipeValidator = (recipe: RecipeDocument) => ValidatedMediaRecipe;

export type CloudMediaErrorCode =
  | "invalid_input"
  | "input_limit"
  | "content_mismatch"
  | "unsupported_settings"
  | "renderer_unavailable"
  | "decoder_failed"
  | "invalid_output"
  | "timeout"
  | "cancelled";

/** Fixed diagnostics only; errors must never contain paths, bytes, URLs or upstream messages. */
export class CloudMediaError extends Error {
  readonly code: CloudMediaErrorCode;
  constructor(code: CloudMediaErrorCode) {
    super(`photo-cloud-media: ${code}`);
    this.name = "CloudMediaError";
    this.code = code;
  }
}
