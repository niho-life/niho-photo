/**
 * Shared albums: membership and invite links (B05 #246), albums, items and the owner's shared storage (B12 #254). The
 * same-origin clients, the UI-facing actions and a synthetic in-memory server for development and tests. Not wired
 * into any host yet.
 */
export {
  createBrowserSharedAlbumClient,
  createSharedAlbumClientOnTransport,
  type CreateBrowserSharedAlbumClientOptions,
  type SharedAlbumClient,
} from "./album-client";
export { createSharingClientOnTransport, type SharingTransport } from "./sharing-http";
export { type EncodedSharingRequest } from "./membership-wire";
export {
  SharedAlbumFileError,
  createSharedAlbumItems,
  deviceRenderFile,
  prepareAlbumFile,
  type CreateSharedAlbumItemsOptions,
  type PreparedAlbumFile,
  type SharedAlbumFileProblem,
  type SharedAlbumItemResult,
  type SharedAlbumItems,
  type SharedAlbumItemsTransport,
} from "./album-items";
export { SHARED_ALBUM_ITEM_OPERATIONS, type SharedAlbumItemOperation } from "./album-wire";
export {
  createBrowserSharedAlbumScreensPort,
  createSharedAlbumScreensPort,
  holdBrowserPendingInvite,
  prepareBrowserAlbumFile,
  sharedAlbumInviteLinkView,
  sharedAlbumItemView,
  sharedAlbumMemberView,
  sharedAlbumPermissionsView,
  sharedAlbumSummaryView,
  sharedAlbumView,
  type CreateBrowserSharedAlbumScreensPortOptions,
  type CreateSharedAlbumScreensPortOptions,
} from "./album-screens";
export {
  createBrowserSharedAlbumMembershipClient,
  createSharedAlbumMembershipClientOnTransport,
  type CreateBrowserSharedAlbumMembershipClientOptions,
  type SharedAlbumMembershipClient,
} from "./membership-client";
export {
  createSharedAlbumMembership,
  sharingRecoveryOf,
  type CreateSharedAlbumMembershipOptions,
  type SharedAlbumInvite,
  type SharedAlbumMembership,
  type SharedAlbumMembershipTransport,
} from "./membership";
export {
  SHARED_ALBUM_MEMBERSHIP_OPERATIONS,
  SHARING_CLOUD_PATH_PREFIX,
  isSharingErrorEnvelope,
  type SharedAlbumMembershipOperation,
} from "./membership-wire";
export {
  SHARED_ALBUM_MOCK_OPERATIONS,
  SHARED_ALBUM_MOCK_TICKET_PREFIX,
  createSharedAlbumMockServer,
  type CreateSharedAlbumMockServerOptions,
  type SharedAlbumMockClient,
  type SharedAlbumMockLibraryPhoto,
  type SharedAlbumMockOperation,
  type SharedAlbumMockServer,
  type SharedAlbumMockUser,
} from "./membership-mock";
