/**
 * Compatibility adapter between the unchanged personal v2 port and this contract.
 *
 * Direction is one way: a personal v2 library can appear as a `nihoCloud` library and as an album source.
 * Nothing here turns a hosted library, a shared album or another user's access into a v2 scope, rewrites the v2
 * owner, flips v2 `albums: false`, or applies the v2 5 GiB pool to shared storage.
 */
import { PHOTO_LIBRARY_CONTRACT_VERSION } from "../../photo-library-contract/src/v2.ts";
import type {
  PersonalPhotoLibrary,
  Photo as PersonalPhoto,
  PhotoSessionScope,
  RenderCapability,
  VerifiedPhotoActor,
} from "../../photo-library-contract/src/v2.ts";
import type { AlbumItemSource, Library, NihoCloudLibrary, RenderBinding } from "./v1.ts";

export const PERSONAL_V2_COMPATIBILITY = {
  personalContractVersion: PHOTO_LIBRARY_CONTRACT_VERSION,
  /** v2 capability flags stay false. Sharing is discovered only through this contract. */
  personalCapabilities: { albums: false, publicSharing: false },
  /** The v2 5 GiB pool covers nihoCloud originals and masks only, exactly as before. */
  personalQuotaScope: "nihoCloudOriginalsAndMasks",
  /** Hosted previews, renditions and export staging are charged to SharedStorageUsage of the owner. */
  sharedQuotaScope: "ownerSharedStorage",
  /** v2 originals are immutable; a different original is a different photo. */
  personalSourceGeneration: 1,
} as const;

export class PersonalV2CompatibilityError extends Error {
  readonly code: "unsupported_contract" | "personal_capability_changed" | "renderer_mismatch";
  constructor(code: PersonalV2CompatibilityError["code"]) {
    super(`photo-library-sharing-contract: ${code}`);
    this.name = "PersonalV2CompatibilityError";
    this.code = code;
  }
}

/** Presents a verified personal v2 library as the owner's `nihoCloud` library. v2 data is read, never changed. */
export function nihoCloudLibraryFromPersonalV2(library: PersonalPhotoLibrary): NihoCloudLibrary {
  if (library.contractVersion !== PHOTO_LIBRARY_CONTRACT_VERSION) throw new PersonalV2CompatibilityError("unsupported_contract");
  if (library.capabilities.albums !== false || library.capabilities.publicSharing !== false) {
    throw new PersonalV2CompatibilityError("personal_capability_changed");
  }
  return {
    contractVersion: 1,
    kind: "nihoCloud",
    id: library.id,
    owner: { type: "user", userId: library.owner.userId },
    lifecycle: library.state === "deleting" ? "deleting" : "active",
    metadataRevision: library.revision,
    metadataAuthority: "niho",
    originals: "niho",
    port: "personalCloudV2",
  };
}

/**
 * The only path into the personal v2 port: the actor's own active `nihoCloud` library. Hosted, local and
 * album-derived access always return null, so a v2 client never receives a non-personal scope.
 */
export function personalV2ScopeFor(library: Library, actor: VerifiedPhotoActor): PhotoSessionScope | null {
  if (library.kind !== "nihoCloud" || library.lifecycle !== "active") return null;
  if (library.owner.userId !== actor.userId) return null;
  return { actorId: actor.userId, libraryId: library.id, sessionEpoch: actor.sessionEpoch };
}

/** An album source pointing at the adder's own personal photo. Album access never implies v2 ownership. */
export function albumSourceFromPersonalV2(scope: PhotoSessionScope, photoId: PersonalPhoto["id"]): AlbumItemSource {
  return { kind: "libraryPhoto", libraryId: scope.libraryId, photoId };
}

/**
 * Binding of a personal v2 photo for a rendition job: the immutable original hash, the exact recipe and the
 * executor's accepted renderer.
 */
export function renderBindingFromPersonalV2(photo: PersonalPhoto, renderer: RenderCapability): RenderBinding {
  // The executor's renderer must support the recipe engine; its manifest becomes part of the binding.
  if (!renderer.engines.includes(photo.recipe.settings.engine)) throw new PersonalV2CompatibilityError("renderer_mismatch");
  return {
    sourceGeneration: PERSONAL_V2_COMPATIBILITY.personalSourceGeneration,
    sourceSha256: photo.original.sha256,
    recipeRevision: photo.recipe.revision,
    settingsSha256: photo.recipe.settingsSha256,
    engine: photo.recipe.settings.engine,
    rendererManifestSha256: renderer.manifestSha256,
    maskSurfaceIds: [...photo.recipe.maskSurfaceIds],
  };
}
