/**
 * Shared-album membership and invite links (B05 #246): the same-origin client, the UI-facing actions and a synthetic
 * in-memory server for development and tests. Not wired into any host yet.
 */
export {
  createBrowserSharedAlbumMembershipClient,
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
  createSharedAlbumMockServer,
  type CreateSharedAlbumMockServerOptions,
  type SharedAlbumMockClient,
  type SharedAlbumMockOperation,
  type SharedAlbumMockServer,
  type SharedAlbumMockUser,
} from "./membership-mock";
