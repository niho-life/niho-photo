import { describe, expect, it } from "vitest";

import {
  PHOTO_SHARED_ALBUM_FIXTURE_ALBUM,
  PHOTO_SHARED_ALBUM_FIXTURE_LINKS,
  PHOTO_SHARED_ALBUM_FIXTURE_NOW,
  PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE,
  photoSharedAlbumFixtureItem,
  photoSharedAlbumFixtureUploads,
} from "./photo-shared-album-fixtures";
import {
  activePhotoSharedAlbumInviteLink,
  photoSharedAlbumCanAdd,
  photoSharedAlbumCanManageMembers,
  photoSharedAlbumCanRemoveItem,
  photoSharedAlbumInviteExpiryLabel,
  photoSharedAlbumItemLabel,
  photoSharedAlbumItemSavable,
  photoSharedAlbumItemStatus,
  photoSharedAlbumNotice,
  photoSharedAlbumUploadHeadline,
  photoSharedAlbumUploadPhaseLabel,
  photoStorageLocationName,
  photoStorageLocationStatus,
  summarizePhotoSharedAlbumUploads,
  visiblePhotoSharedAlbumItems,
  type PhotoSharedAlbum,
} from "./photo-shared-album-model";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("共有アルバムの役割と権限（Epic §10）", () => {
  it("追加できるのはオーナーと「写真を追加できる」だけで、解除後は誰も追加できない", () => {
    expect(photoSharedAlbumCanAdd({ role: "owner", accessEnded: false })).toBe(true);
    expect(photoSharedAlbumCanAdd({ role: "contributor", accessEnded: false })).toBe(true);
    expect(photoSharedAlbumCanAdd({ role: "viewer", accessEnded: false })).toBe(false);
    expect(photoSharedAlbumCanAdd({ role: "owner", accessEnded: true })).toBe(false);
  });

  it("招待・役割の変更はオーナーだけ", () => {
    expect(photoSharedAlbumCanManageMembers("owner")).toBe(true);
    expect(photoSharedAlbumCanManageMembers("contributor")).toBe(false);
    expect(photoSharedAlbumCanManageMembers("viewer")).toBe(false);
  });

  it("オーナーはどの項目も外せ、「写真を追加できる」は自分の項目だけ、見るだけは外せない", () => {
    const mine = photoSharedAlbumFixtureItem(0, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributorSelf });
    const others = photoSharedAlbumFixtureItem(1, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.owner });
    expect(photoSharedAlbumCanRemoveItem("owner", others)).toBe(true);
    expect(photoSharedAlbumCanRemoveItem("contributor", mine)).toBe(true);
    expect(photoSharedAlbumCanRemoveItem("contributor", others)).toBe(false);
    expect(photoSharedAlbumCanRemoveItem("viewer", mine)).toBe(false);
  });

  it("保存できるのは完成写真がある項目（更新待ちは直前の完成写真）", () => {
    expect(photoSharedAlbumItemSavable({ state: "published" })).toBe(true);
    expect(photoSharedAlbumItemSavable({ state: "updatePending" })).toBe(true);
    expect(photoSharedAlbumItemSavable({ state: "preparing" })).toBe(false);
    expect(photoSharedAlbumItemSavable({ state: "removed" })).toBe(false);
  });
});

describe("見せる項目", () => {
  const items = [
    photoSharedAlbumFixtureItem(0, { itemId: "published" }),
    photoSharedAlbumFixtureItem(1, { itemId: "removed", state: "removed" }),
    photoSharedAlbumFixtureItem(2, { itemId: "others-preparing", state: "preparing", addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributor }),
    photoSharedAlbumFixtureItem(3, { itemId: "my-preparing", state: "preparing", addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributorSelf }),
  ];

  it("削除した項目は誰にも見せない", () => {
    for (const role of ["owner", "contributor", "viewer"] as const) {
      expect(visiblePhotoSharedAlbumItems(items, role).map((item) => item.itemId)).not.toContain("removed");
    }
  });

  it("準備中はオーナーと追加者にだけ見せ、他のメンバーには完成した写真だけを見せる", () => {
    expect(visiblePhotoSharedAlbumItems(items, "owner").map((item) => item.itemId)).toEqual(["published", "others-preparing", "my-preparing"]);
    expect(visiblePhotoSharedAlbumItems(items, "contributor").map((item) => item.itemId)).toEqual(["published", "my-preparing"]);
    const viewerItems = items.map((item) => ({ ...item, addedBy: { ...item.addedBy, isSelf: false } }));
    expect(visiblePhotoSharedAlbumItems(viewerItems, "viewer").map((item) => item.itemId)).toEqual(["published"]);
  });
});

describe("項目の状態と読み上げ", () => {
  it("オーナーの写真で常設 Mac が止まっていれば「Mac の起動後に更新」、それ以外は準備中・更新待ち", () => {
    expect(photoSharedAlbumItemStatus({ state: "preparing", kind: "ownerPhoto" }, "sleeping")).toBe("Mac の起動後に更新");
    expect(photoSharedAlbumItemStatus({ state: "updatePending", kind: "ownerPhoto" }, "unreachable")).toBe("Mac の起動後に更新");
    expect(photoSharedAlbumItemStatus({ state: "preparing", kind: "ownerPhoto" }, "online")).toBe("準備中");
    expect(photoSharedAlbumItemStatus({ state: "preparing", kind: "memberEdit" }, "sleeping")).toBe("準備中");
    expect(photoSharedAlbumItemStatus({ state: "updatePending", kind: "fileUpload" }, null)).toBe("更新待ち");
    expect(photoSharedAlbumItemStatus({ state: "published", kind: "ownerPhoto" }, "sleeping")).toBeNull();
  });

  it("読み上げ名に位置・追加者・状態・新着を入れ、内部識別子を出さない", () => {
    const label = photoSharedAlbumItemLabel(
      photoSharedAlbumFixtureItem(0, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.contributor, state: "updatePending", kind: "memberEdit", isNew: true }),
      { index: 2, total: 24 },
      null,
    );
    expect(label).toBe("写真 3/24、佐藤 花子さんが追加、更新待ち、新着");
    expect(label).not.toMatch(/memberEdit|updatePending|contributor/);
    expect(photoSharedAlbumItemLabel(photoSharedAlbumFixtureItem(0, { addedBy: PHOTO_SHARED_ALBUM_FIXTURE_PEOPLE.ownerSelf }), { index: 0, total: 1 }, null))
      .toBe("写真 1/1、あなたが追加");
  });
});

describe("アルバムの状態の 1 行（Epic §12）", () => {
  const album = (overrides: Partial<PhotoSharedAlbum>): PhotoSharedAlbum => ({ ...PHOTO_SHARED_ALBUM_FIXTURE_ALBUM, ...overrides });
  const waitingOwnerItem = photoSharedAlbumFixtureItem(0, { state: "preparing", kind: "ownerPhoto" });

  it("できるときは出さない", () => {
    expect(photoSharedAlbumNotice(album({}), [photoSharedAlbumFixtureItem(0)])).toBeNull();
  });

  it("容量不足はメンバーには「アルバムがいっぱいです」、オーナーには使用量と次の操作", () => {
    const full = { state: "full", ownerUsage: { usedBytes: 5 * 1024 ** 3, quotaBytes: 5 * 1024 ** 3 } } as const;
    expect(photoSharedAlbumNotice(album({ role: "contributor", capacity: { state: "full", ownerUsage: null } }), [])).toEqual({
      kind: "full",
      text: "アルバムがいっぱいです",
      actionLabel: null,
    });
    expect(photoSharedAlbumNotice(album({ role: "owner", capacity: full }), [])).toEqual({
      kind: "full",
      text: "容量がいっぱいです（5 / 5 GB）",
      actionLabel: "容量を確認",
    });
  });

  it("常設 Mac の休止はオーナーの写真を待っているときだけ出し、メンバーには出さない", () => {
    expect(photoSharedAlbumNotice(album({ hostedMacStatus: "sleeping" }), [waitingOwnerItem])).toEqual({ kind: "macWaiting", text: "Mac の起動後に更新" });
    expect(photoSharedAlbumNotice(album({ hostedMacStatus: "sleeping" }), [photoSharedAlbumFixtureItem(0)])).toBeNull();
    expect(photoSharedAlbumNotice(album({ hostedMacStatus: "online" }), [waitingOwnerItem])).toBeNull();
    expect(photoSharedAlbumNotice(album({ role: "contributor", hostedMacStatus: "sleeping" }), [waitingOwnerItem])).toBeNull();
  });

  it("準備中は進み具合だけを出す", () => {
    expect(photoSharedAlbumNotice(album({ preparing: { done: 3, total: 12 } }), [])).toEqual({ kind: "preparing", text: "準備中 3/12", fraction: 0.25 });
    expect(photoSharedAlbumNotice(album({ preparing: { done: 12, total: 12 } }), [])).toBeNull();
  });

  it("解除後が最優先で、戻る操作を付ける", () => {
    expect(photoSharedAlbumNotice(album({ accessEnded: true, capacity: { state: "full", ownerUsage: null }, preparing: { done: 1, total: 2 } }), [waitingOwnerItem]))
      .toEqual({ kind: "accessEnded", text: "このアルバムは見られなくなりました", actionLabel: "共有アルバムへ" });
  });
});

describe("招待リンクの有効期限", () => {
  const now = PHOTO_SHARED_ALBUM_FIXTURE_NOW;
  const link = (expiresIn: number, revoked = false) => ({
    linkId: "link",
    role: "viewer" as const,
    expiresAt: new Date(now + expiresIn).toISOString(),
    revoked,
  });

  it("短いラベルにする", () => {
    expect(photoSharedAlbumInviteExpiryLabel(link(7 * DAY), now)).toBe("あと7日");
    expect(photoSharedAlbumInviteExpiryLabel(link(DAY + 5 * HOUR), now)).toBe("あと1日");
    expect(photoSharedAlbumInviteExpiryLabel(link(5 * HOUR + 10), now)).toBe("あと5時間");
    expect(photoSharedAlbumInviteExpiryLabel(link(20 * 60_000), now)).toBe("まもなく期限切れ");
  });

  it("期限切れ・無効化・読めない期限は使えないリンクとして扱う", () => {
    expect(photoSharedAlbumInviteExpiryLabel(link(-1), now)).toBeNull();
    expect(photoSharedAlbumInviteExpiryLabel(link(DAY, true), now)).toBeNull();
    expect(photoSharedAlbumInviteExpiryLabel({ ...link(DAY), expiresAt: "not-a-date" }, now)).toBeNull();
  });

  it("その役割の使えるリンクのうち、いちばん長く使えるものを選ぶ", () => {
    expect(activePhotoSharedAlbumInviteLink(PHOTO_SHARED_ALBUM_FIXTURE_LINKS, "contributor", now)?.linkId).toBe("fixture-link-contributor");
    expect(activePhotoSharedAlbumInviteLink(PHOTO_SHARED_ALBUM_FIXTURE_LINKS, "viewer", now)).toBeNull();
    const links = [
      { ...link(2 * DAY), linkId: "short" },
      { ...link(6 * DAY), linkId: "long" },
      { ...link(9 * DAY, true), linkId: "revoked" },
    ];
    expect(activePhotoSharedAlbumInviteLink(links, "viewer", now)?.linkId).toBe("long");
  });
});

describe("追加の進捗", () => {
  it("動いている間は「追加中 n/m」、終わったら結果", () => {
    const uploads = photoSharedAlbumFixtureUploads();
    const summary = summarizePhotoSharedAlbumUploads(uploads);
    expect(summary).toEqual({ total: 6, settled: 3, added: 1, notAdded: 2, active: true });
    expect(photoSharedAlbumUploadHeadline(summary)).toBe("追加中 3/6");
    expect(photoSharedAlbumUploadHeadline({ total: 3, settled: 3, added: 3, notAdded: 0, active: false })).toBe("3枚を追加しました");
    expect(photoSharedAlbumUploadHeadline({ total: 3, settled: 3, added: 1, notAdded: 2, active: false })).toBe("2枚を追加できませんでした");
  });

  it("段階と理由を日本語の短いラベルにする", () => {
    expect(photoSharedAlbumUploadPhaseLabel({ phase: "checking", reason: null })).toBe("確認中");
    expect(photoSharedAlbumUploadPhaseLabel({ phase: "notAdded", reason: "albumFull" })).toBe("アルバムがいっぱいです");
    expect(photoSharedAlbumUploadPhaseLabel({ phase: "notAdded", reason: "accessEnded" })).toBe("共有が解除されました");
    expect(photoSharedAlbumUploadPhaseLabel({ phase: "notAdded", reason: null })).toBe("追加できませんでした");
  });
});

describe("保存先", () => {
  it("名前は種類から決め、自前サーバーは付けた名前を使う", () => {
    expect(photoStorageLocationName({ kind: "nihoCloud", name: "x" })).toBe("NIHO クラウド");
    expect(photoStorageLocationName({ kind: "thisMac", name: null })).toBe("この Mac");
    expect(photoStorageLocationName({ kind: "hostedMac", name: " 自宅の Mac " })).toBe("自宅の Mac");
    expect(photoStorageLocationName({ kind: "hostedMac", name: "  " })).toBe("自前サーバー");
  });

  it("自前サーバーの状態だけを短く出し、休止中は起動後に更新することを添える", () => {
    expect(photoStorageLocationStatus({ kind: "hostedMac", hostedMacStatus: "online" })).toBe("接続中");
    expect(photoStorageLocationStatus({ kind: "hostedMac", hostedMacStatus: "sleeping" })).toBe("休止中・Mac の起動後に更新");
    expect(photoStorageLocationStatus({ kind: "hostedMac", hostedMacStatus: "unreachable" })).toBe("接続できません");
    expect(photoStorageLocationStatus({ kind: "nihoCloud", hostedMacStatus: null })).toBeNull();
  });
});
