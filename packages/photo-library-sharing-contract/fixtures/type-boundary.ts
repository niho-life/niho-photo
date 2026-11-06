import type {
  AlbumItem,
  ConnectorRequestOptions,
  AlbumRole,
  HostConnector,
  HostConnectorState,
  InviteLink,
  LibraryKind,
  RenditionMetadata,
  RenditionUploadRequest,
  RestoreReport,
  PortableAlbumItem,
  SharingOperationMap,
  SharingRequestOptions,
} from "../src/v1.ts";
import type { PersonalPhotoLibrary } from "../../photo-library-contract/src/v2.ts";

// These must stay compile errors. Identifiers, owners and roles in a request confer no authority.
declare const upload: RenditionUploadRequest;
// @ts-expect-error The caller cannot claim to be the album owner.
const forgedOwner: SharingOperationMap["albumItems.addFile"]["request"] = { albumId: "synthetic-album-a", ownerId: "synthetic-user-a", rendition: upload };
// @ts-expect-error The caller cannot declare its own role when joining.
const forgedRole: SharingOperationMap["invites.join"]["request"] = { secret: "synthetic", role: "owner" };
// @ts-expect-error Invite links and role changes never grant ownership.
const grantOwner: SharingOperationMap["invites.create"]["request"] = { albumId: "synthetic-album-a", role: "owner" };
// @ts-expect-error Role changes are a CAS against the membership revision.
const unconditionalRole: SharingOperationMap["members.changeRole"]["request"] = { albumId: "synthetic-album-a", userId: "synthetic-user-v", role: "viewer" };
// @ts-expect-error Album renames are a CAS against the album revision.
const unconditionalRename: SharingOperationMap["albums.rename"]["request"] = { albumId: "synthetic-album-a", name: "x" };
// @ts-expect-error Hosted recipe saves bind the source generation they were edited against.
const generationless: SharingOperationMap["hostedRecipes.put"]["request"] = { libraryId: "l", photoId: "p", expectedRevision: 1, settings: { v: 1, engine: "niho-14" }, baseVersion: null };
// @ts-expect-error A storage locator or path is never part of the public contract.
const locator: SharingOperationMap["libraries.get"]["request"] = { libraryId: "synthetic", path: "synthetic-root" };
void forgedOwner;
void forgedRole;
void grantOwner;
void unconditionalRole;
void unconditionalRename;
void generationless;
void locator;

declare const item: AlbumItem;
// @ts-expect-error Album items never carry another person's recipe, mask or original.
void item.recipe;
// @ts-expect-error Renditions keep only the metadata allow-list.
const gps: RenditionMetadata = { capturedAt: null, capturedAtOffset: null, colorProfile: "sRGB", orientation: 1, gps: { latitude: 0, longitude: 0 } };
// @ts-expect-error Orientation is baked into the pixels.
const rotated: RenditionMetadata = { capturedAt: null, capturedAtOffset: null, colorProfile: "sRGB", orientation: 6 };
// @ts-expect-error A portable export never carries a member's source reference.
const memberSource: PortableAlbumItem = { itemId: "i", kind: "memberEdit", source: { kind: "devicePhoto", deviceSourceRef: "d" }, renditionSha256: null };
void memberSource;
// @ts-expect-error A restore never grants memberships from a snapshot.
const restoredAccess: RestoreReport = { libraryId: "l", restoredPhotos: 0, restoredAlbums: 0, membershipsRestored: 2, mismatches: [] };
void gps;
void rotated;
void restoredAccess;

// Vocabulary shared with the UI is closed. Phase-2 values must not appear in v1.
// @ts-expect-error Own R2 storage is phase 2 (B02).
const r2: LibraryKind = "ownR2";
// @ts-expect-error Collaborative editing is phase 2 (B06).
const editor: AlbumRole = "editor";
// @ts-expect-error Connector states are online / sleeping / unreachable only.
const offline: HostConnectorState = "offline";
declare const connector: HostConnector;
// @ts-expect-error v1 connectors dial out only; an inbound relay is phase 2 (B04).
const relay: HostConnector = { ...connector, transport: "relay" };
// @ts-expect-error Invite links always carry role, expiresAt and revoked.
const partialLink: InviteLink = { id: "i", albumId: "a", role: "viewer", createdBy: "u", createdAt: "t", expiresAt: "t", revokedAt: null, joinCount: 0 };
void r2;
void editor;
void offline;
void relay;
void partialLink;

declare const signal: AbortSignal;
// @ts-expect-error Every album mutation keeps its operation identity for unknown results.
const keyless: SharingRequestOptions<"albumItems.addPhoto"> = { signal };
// @ts-expect-error Pairing start is replayable only with a captured operation key.
const pairingKeyless: ConnectorRequestOptions<"connector.startPairing"> = { signal };
void pairingKeyless;
// @ts-expect-error Reads carry no idempotency key.
const keyedRead: SharingRequestOptions<"albums.get"> = { signal, idempotencyKey: "synthetic" };
void keyless;
void keyedRead;

declare const personal: PersonalPhotoLibrary;
// @ts-expect-error The personal v2 contract stays albums: false; sharing is not added by flipping it.
const flipped: PersonalPhotoLibrary = { ...personal, capabilities: { ...personal.capabilities, albums: true } };
void flipped;
