/**
 * 共有アルバムの部品の試験と見た目の確認に使う合成データ（B08 #249）。写真は SVG のグラデーションで描き、実写真・実在の利用者・
 * 内部 URL を含めない。明るい写真と暗い写真の両方を入れ、写真の上の札の読みやすさを確かめられるようにする。
 */

import type {
  PhotoSharedAlbum,
  PhotoSharedAlbumInviteLink,
  PhotoSharedAlbumItem,
  PhotoSharedAlbumMember,
  PhotoSharedAlbumPerson,
  PhotoSharedAlbumSummary,
  PhotoSharedAlbumUpload,
  PhotoStorageLocation,
} from "./photo-shared-album-model";

/** 合成の写真（2 色のグラデーションと丸）。 */
export function photoSharedAlbumSyntheticImage(from: string, to: string, accent = "rgba(255,255,255,0.35)"): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>`
    + `<rect width="240" height="240" fill="url(#g)"/><circle cx="170" cy="70" r="34" fill="${accent}"/>`
    + `<path d="M0 190 L70 130 L130 175 L180 140 L240 185 L240 240 L0 240 Z" fill="rgba(0,0,0,0.18)"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const PALETTE: readonly [string, string][] = [
  ["#F6D8AE", "#E58F65"],
  ["#1B2A41", "#324A5F"],
  ["#FDFCF7", "#E9E4D4"],
  ["#A3C9A8", "#4F7C5A"],
  ["#F2A7B8", "#8E5572"],
  ["#0B0C10", "#2E3440"],
  ["#BFD7EA", "#5B8DB8"],
  ["#FFE8A3", "#F2B134"],
  ["#D7CCE8", "#6B5B95"],
  ["#C9E4DE", "#2A9D8F"],
  ["#FFFFFF", "#F4F1EA"],
  ["#3D2C2E", "#8C5E58"],
];

export const PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE = {
  owner: { userId: "fixture-owner", displayName: "中村", isSelf: false },
  ownerSelf: { userId: "fixture-owner", displayName: "中村", isSelf: true },
  contributor: { userId: "fixture-contributor", displayName: "佐藤 花子", isSelf: false },
  contributorSelf: { userId: "fixture-contributor", displayName: "佐藤 花子", isSelf: true },
  viewer: { userId: "fixture-viewer", displayName: "鈴木", isSelf: false },
  longName: { userId: "fixture-long", displayName: "とても長い名前の拠点スタッフ山田太郎", isSelf: false },
} as const satisfies Record<string, PhotoSharedAlbumPerson>;

export function photoSharedAlbumFixtureItem(
  index: number,
  overrides: Partial<PhotoSharedAlbumItem> = {},
): PhotoSharedAlbumItem {
  const [from, to] = PALETTE[index % PALETTE.length];
  return {
    itemId: `fixture-item-${index}`,
    kind: "ownerPhoto",
    state: "published",
    addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.owner,
    thumbnailUrl: photoSharedAlbumSyntheticImage(from, to),
    isNew: false,
    ...overrides,
  };
}

export const PHOTO_SHARED_ALBUM_FIXTURE_ALBUM: PhotoSharedAlbum = {
  albumId: "fixture-album",
  name: "鎌倉の拠点 2026 秋",
  role: "owner",
  owner: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.ownerSelf,
  memberCount: 3,
  itemCount: 12,
  coverUrl: photoSharedAlbumSyntheticImage("#F6D8AE", "#E58F65"),
  preparing: null,
  capacity: { state: "available" },
  hostedMacStatus: "online",
  accessEnded: false,
};

/** オーナーが見るアルバムの項目（新着・準備中・更新待ちを含む）。 */
export function photoSharedAlbumFixtureItems(): PhotoSharedAlbumItem[] {
  return [
    photoSharedAlbumFixtureItem(0, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributor, kind: "memberEdit", isNew: true }),
    photoSharedAlbumFixtureItem(1, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.longName, kind: "fileUpload", isNew: true }),
    photoSharedAlbumFixtureItem(2, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.ownerSelf }),
    photoSharedAlbumFixtureItem(3, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.ownerSelf, state: "updatePending" }),
    photoSharedAlbumFixtureItem(4, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.ownerSelf }),
    photoSharedAlbumFixtureItem(5, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributor, kind: "memberEdit" }),
    photoSharedAlbumFixtureItem(6, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.ownerSelf, state: "preparing", thumbnailUrl: null }),
    photoSharedAlbumFixtureItem(7, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.ownerSelf }),
    photoSharedAlbumFixtureItem(8, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.ownerSelf }),
    photoSharedAlbumFixtureItem(9, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.viewer, state: "removed" }),
    photoSharedAlbumFixtureItem(10, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributor, kind: "fileUpload", isNew: true }),
    photoSharedAlbumFixtureItem(11, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.ownerSelf }),
  ];
}

export const PHOTO_SHARED_ALBUM_FIXTURE_MEMBERS: readonly PhotoSharedAlbumMember[] = [
  { ...PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributor, role: "contributor" },
  { ...PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.ownerSelf, role: "owner" },
  { ...PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.viewer, role: "viewer" },
  { ...PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.longName, role: "contributor" },
];

/** 2026-11-07T00:00:00Z 起点の合成時刻。 */
export const PHOTO_SHARED_ALBUM_FIXTURE_NOW = Date.parse("2026-11-07T00:00:00.000Z");

export const PHOTO_SHARED_ALBUM_FIXTURE_LINKS: readonly PhotoSharedAlbumInviteLink[] = [
  { linkId: "fixture-link-contributor", role: "contributor", expiresAt: "2026-11-14T00:00:00.000Z", revoked: false },
  { linkId: "fixture-link-viewer-old", role: "viewer", expiresAt: "2026-11-01T00:00:00.000Z", revoked: false },
];

export function photoSharedAlbumFixtureUploads(): PhotoSharedAlbumUpload[] {
  return [
    { uploadId: "fixture-upload-1", name: "IMG_0412.JPG", previewUrl: photoSharedAlbumSyntheticImage("#BFD7EA", "#5B8DB8"), phase: "added", fraction: null, reason: null },
    { uploadId: "fixture-upload-2", name: "IMG_0413.JPG", previewUrl: photoSharedAlbumSyntheticImage("#FFE8A3", "#F2B134"), phase: "sending", fraction: 0.62, reason: null },
    { uploadId: "fixture-upload-3", name: "夕方の海辺で撮った長いファイル名の写真.HEIC", previewUrl: null, phase: "checking", fraction: null, reason: null },
    { uploadId: "fixture-upload-4", name: "IMG_0415.JPG", previewUrl: null, phase: "waiting", fraction: null, reason: null },
    { uploadId: "fixture-upload-5", name: "DSC_0001.NEF", previewUrl: null, phase: "notAdded", fraction: null, reason: "unsupported" },
    { uploadId: "fixture-upload-6", name: "IMG_0416.JPG", previewUrl: null, phase: "failed", fraction: null, reason: null },
  ];
}

export function photoSharedAlbumFixtureSummaries(): PhotoSharedAlbumSummary[] {
  return [
    { ...PHOTO_SHARED_ALBUM_FIXTURE_ALBUM },
    {
      albumId: "fixture-album-2",
      name: "週末のワークショップ",
      role: "contributor",
      owner: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributor,
      memberCount: 5,
      itemCount: 48,
      coverUrl: photoSharedAlbumSyntheticImage("#1B2A41", "#324A5F"),
      preparing: null,
    },
    {
      albumId: "fixture-album-3",
      name: "とても長いアルバムの名前が二行に収まるかを確かめるための共有アルバム",
      role: "viewer",
      owner: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.longName,
      memberCount: 2,
      itemCount: 7,
      coverUrl: photoSharedAlbumSyntheticImage("#A3C9A8", "#4F7C5A"),
      preparing: null,
    },
    {
      albumId: "fixture-album-4",
      name: "新しい共有",
      role: "owner",
      owner: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.ownerSelf,
      memberCount: 1,
      itemCount: 40,
      coverUrl: null,
      preparing: { done: 12, total: 40 },
    },
  ];
}

export const PHOTO_STORAGE_LOCATION_FIXTURES: readonly PhotoStorageLocation[] = [
  { locationId: "fixture-hosted", kind: "hostedMac", name: "自宅の Mac mini", hostedMacStatus: "sleeping", usage: null },
  { locationId: "fixture-cloud", kind: "nihoCloud", name: null, hostedMacStatus: null, usage: { usedBytes: 1.2 * 1024 ** 3, quotaBytes: 5 * 1024 ** 3 } },
  { locationId: "fixture-this-mac", kind: "thisMac", name: null, hostedMacStatus: null, usage: null },
];
