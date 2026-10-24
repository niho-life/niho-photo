// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEVELOP_SETTINGS_DRAFT_MAX_BYTES,
  canRestoreDevelopSettingsDraft,
  listDevelopSettingsDrafts,
  listDevelopSettingsDraftsForPhotos,
  markDevelopSettingsDraftConflicted,
  removeDevelopSettingsDraft,
  writeDevelopSettingsDraft,
} from "./develop-settings-draft";
import { neutralDevelopSettings } from "./develop-settings";

const scope = { actorId: "user-a", spotId: "spot-a", photoId: "photo-a" };

beforeEach(() => {
  localStorage.clear();
});

describe("develop settings draft storage", () => {
  it("actor・拠点・写真・draftごとに分離し、最新順で同じscopeだけを読む", () => {
    expect(writeDevelopSettingsDraft({ identity: { ...scope, draftId: "tab-a" }, startedRevision: 2, settings: neutralDevelopSettings(), now: 10 }).ok).toBe(true);
    expect(writeDevelopSettingsDraft({ identity: { ...scope, draftId: "tab-b" }, startedRevision: 2, settings: { ...neutralDevelopSettings(), exposure: 1 }, now: 20 }).ok).toBe(true);
    expect(writeDevelopSettingsDraft({ identity: { ...scope, actorId: "user-b", draftId: "tab-c" }, startedRevision: 2, settings: neutralDevelopSettings(), now: 30 }).ok).toBe(true);
    expect(writeDevelopSettingsDraft({ identity: { ...scope, spotId: "spot-b", draftId: "tab-d" }, startedRevision: 2, settings: neutralDevelopSettings(), now: 40 }).ok).toBe(true);
    expect(writeDevelopSettingsDraft({ identity: { ...scope, photoId: "photo-b", draftId: "tab-e" }, startedRevision: 2, settings: neutralDevelopSettings(), now: 50 }).ok).toBe(true);

    const result = listDevelopSettingsDrafts(scope);
    expect(result.ok).toBe(true);
    expect(result.drafts.map((draft) => draft.draftId)).toEqual(["tab-b", "tab-a"]);
  });

  it("指定した複数写真だけから同じactor・拠点のdraftを読む", () => {
    expect(writeDevelopSettingsDraft({ identity: { ...scope, draftId: "photo-a" }, startedRevision: 2, settings: neutralDevelopSettings(), now: 10 }).ok).toBe(true);
    expect(writeDevelopSettingsDraft({ identity: { ...scope, photoId: "photo-b", draftId: "photo-b" }, startedRevision: 2, settings: neutralDevelopSettings(), now: 20 }).ok).toBe(true);
    expect(writeDevelopSettingsDraft({ identity: { ...scope, actorId: "user-b", draftId: "other-actor" }, startedRevision: 2, settings: neutralDevelopSettings(), now: 30 }).ok).toBe(true);

    const result = listDevelopSettingsDraftsForPhotos(
      { actorId: scope.actorId, spotId: scope.spotId },
      ["photo-b", "photo-c", "photo-a"],
    );
    expect(result.ok).toBe(true);
    expect(result.drafts.map((draft) => draft.photoId)).toEqual(["photo-b", "photo-a"]);
  });

  it("同じdraftの世代を進め、古い世代からは削除しない", () => {
    const first = writeDevelopSettingsDraft({ identity: { ...scope, draftId: "tab-a" }, startedRevision: 2, settings: neutralDevelopSettings(), now: 10 });
    const second = writeDevelopSettingsDraft({ identity: { ...scope, draftId: "tab-a" }, startedRevision: 2, settings: { ...neutralDevelopSettings(), exposure: 1 }, now: 20 });
    if (!first.ok || !second.ok) throw new Error("draft write failed");

    expect(removeDevelopSettingsDraft(first.draft)).toBe(true);
    expect(listDevelopSettingsDrafts(scope).drafts[0]?.generation).toBe(2);
    expect(removeDevelopSettingsDraft(second.draft)).toBe(true);
    expect(listDevelopSettingsDrafts(scope).drafts).toEqual([]);
  });

  it("別タブが削除の読取と削除の間に新しい世代を書いても、その世代を消さない", () => {
    const identity = { ...scope, draftId: "racing-tab" };
    const first = writeDevelopSettingsDraft({ identity, startedRevision: 2, settings: neutralDevelopSettings(), now: 10 });
    if (!first.ok) throw new Error("draft write failed");
    const originalGet = Storage.prototype.getItem;
    let advanced = false;
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      const value = originalGet.call(this, key);
      if (!advanced && key.endsWith(first.draft.writeId)) {
        advanced = true;
        expect(writeDevelopSettingsDraft({ identity, startedRevision: 2, settings: { ...neutralDevelopSettings(), exposure: 2 }, now: 20, previous: first.draft }).ok).toBe(true);
      }
      return value;
    });
    try { removeDevelopSettingsDraft(first.draft); } finally { read.mockRestore(); }
    expect(listDevelopSettingsDrafts(scope).drafts.map((draft) => draft.settings.exposure)).toEqual([2]);
  });

  it("revision_staleの印を対象draftだけに付け、次の設定退避にも引き継ぐ", () => {
    const identity = { ...scope, draftId: "tab-a" };
    expect(writeDevelopSettingsDraft({ identity, startedRevision: 2, settings: neutralDevelopSettings(), now: 10 }).ok).toBe(true);
    expect(markDevelopSettingsDraftConflicted(identity)).toBe(true);
    expect(writeDevelopSettingsDraft({ identity, startedRevision: 2, settings: { ...neutralDevelopSettings(), exposure: 1 }, now: 20 }).ok).toBe(true);
    expect(listDevelopSettingsDrafts(scope).drafts[0]?.conflicted).toBe(true);
  });

  it("壊れた・未知版・巨大な値は適用せず、無断で削除しない", () => {
    localStorage.setItem("niho:photo-develop-draft:v1:user-a:spot-a:photo-a:broken", "{");
    localStorage.setItem(
      "niho:photo-develop-draft:v1:user-a:spot-a:photo-a:unknown",
      JSON.stringify({ schema: 1, ...scope, draftId: "unknown", generation: 1, updatedAt: 1, startedRevision: 0, settings: { v: 99, engine: "niho-6" } }),
    );
    localStorage.setItem("niho:photo-develop-draft:v1:user-a:spot-a:photo-a:huge", "x".repeat(DEVELOP_SETTINGS_DRAFT_MAX_BYTES + 1));

    expect(listDevelopSettingsDrafts(scope).drafts).toEqual([]);
    expect(localStorage.length).toBe(3);
  });

  it("非有限値相当・長すぎる文字列・上限超過のsettingsを書かない", () => {
    expect(writeDevelopSettingsDraft({ identity: { ...scope, draftId: "nan" }, startedRevision: 0, settings: { ...neutralDevelopSettings(), exposure: Number.NaN } }).ok).toBe(false);
    expect(writeDevelopSettingsDraft({ identity: { ...scope, draftId: "long" }, startedRevision: 0, settings: { ...neutralDevelopSettings(), note: "x".repeat(5000) } }).ok).toBe(false);
    expect(writeDevelopSettingsDraft({ identity: { ...scope, draftId: "large" }, startedRevision: 0, settings: { ...neutralDevelopSettings(), data: "x".repeat(DEVELOP_SETTINGS_DRAFT_MAX_BYTES) } }).ok).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it("storage例外を呼び出し側へ結果で返し、throwしない", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(writeDevelopSettingsDraft({ identity: { ...scope, draftId: "tab-a" }, startedRevision: 0, settings: neutralDevelopSettings() }).ok).toBe(false);
    setItem.mockRestore();

    localStorage.setItem("unrelated", "value");
    const key = vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(listDevelopSettingsDrafts(scope).ok).toBe(false);
    key.mockRestore();
  });

  it("niho-6 の draft は standard-1 / interim-1 のルックだけを書き・読む（#18397）", () => {
    expect(writeDevelopSettingsDraft({ identity: { ...scope, draftId: "six" }, startedRevision: 0, settings: { ...neutralDevelopSettings(), exposure: 1 }, now: 10 }).ok).toBe(true);
    expect(writeDevelopSettingsDraft({ identity: { ...scope, draftId: "six-wrong-look" }, startedRevision: 0, settings: { ...neutralDevelopSettings(), look: "niho-standard-2" } }).ok).toBe(false);
    localStorage.setItem(
      "niho:photo-develop-draft:v1:user-a:spot-a:photo-a:wrong-look:w",
      JSON.stringify({ schema: 1, ...scope, draftId: "wrong-look", writeId: "w", generation: 1, updatedAt: 1, startedRevision: 0, settings: { v: 1, engine: "niho-6", look: "niho-standard-3" } }),
    );
    expect(listDevelopSettingsDrafts(scope).drafts.map((draft) => draft.draftId)).toEqual(["six"]);
  });
});

describe("canRestoreDevelopSettingsDraft", () => {
  const current = { ...neutralDevelopSettings(), exposure: 0.5 };
  const legacyDraft = { ...neutralDevelopSettings(), engine: "niho-2", exposure: 1.25 };

  it("土台・数式・ルックが今と同じ draft だけを戻す", () => {
    const base = { currentSettings: current, inputBase: null, hasSavedSettings: true };
    expect(canRestoreDevelopSettingsDraft({ ...base, draftSettings: { ...current, exposure: 1 } })).toBe(true);
    expect(canRestoreDevelopSettingsDraft({ ...base, draftSettings: { ...current, base: "raster.x" } })).toBe(false);
    expect(canRestoreDevelopSettingsDraft({ ...base, draftSettings: { ...current, look: "niho-interim-1" } })).toBe(false);
    expect(canRestoreDevelopSettingsDraft({ ...base, draftSettings: { ...current, engine: "niho-1" } })).toBe(false);
    expect(canRestoreDevelopSettingsDraft({ ...base, draftSettings: { ...current, v: 99 as 1 } })).toBe(false);
  });

  it("保存したことの無い写真では、既定が niho-14 になる前の niho-2 / niho-6 / niho-10 / niho-12 / niho-13 draft も戻す（土台・ルックが同じときだけ）", () => {
    expect(current.engine).toBe("niho-14");
    const unsaved = { currentSettings: current, inputBase: null, hasSavedSettings: false };
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: legacyDraft })).toBe(true);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: { ...legacyDraft, engine: "niho-6" } })).toBe(true);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: { ...legacyDraft, engine: "niho-10" } })).toBe(true);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: { ...legacyDraft, engine: "niho-12" } })).toBe(true);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: { ...legacyDraft, engine: "niho-13" } })).toBe(true);
    // unsigned RAW の作業コピーの上の、既定が niho-2 だったころの draft も同じ
    const legacyRaw = "raw-apple.d8.p1.e1.cal-none";
    expect(
      canRestoreDevelopSettingsDraft({
        currentSettings: neutralDevelopSettings(legacyRaw),
        inputBase: legacyRaw,
        hasSavedSettings: false,
        draftSettings: { ...neutralDevelopSettings(legacyRaw), engine: "niho-2", exposure: 1 },
      }),
    ).toBe(true);
    // raster の作業コピーの上の draft も同じ
    const raster = "raster.ci2.p2.e2.icc-srgb";
    expect(
      canRestoreDevelopSettingsDraft({
        currentSettings: neutralDevelopSettings(raster),
        inputBase: raster,
        hasSavedSettings: false,
        draftSettings: { ...neutralDevelopSettings(raster), engine: "niho-2", exposure: 1 },
      }),
    ).toBe(true);
    // 保存済みの写真・ルック違い・土台違い・niho-2 以外の数式・今が niho-6 でないときは戻さない
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, hasSavedSettings: true, draftSettings: legacyDraft })).toBe(false);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: { ...legacyDraft, look: "niho-interim-1" } })).toBe(false);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: { ...legacyDraft, base: raster } })).toBe(false);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: { ...legacyDraft, engine: "niho-1" } })).toBe(false);
    expect(
      canRestoreDevelopSettingsDraft({ ...unsaved, currentSettings: { ...current, engine: "niho-2" }, draftSettings: { ...current } }),
    ).toBe(false);
    // 今が保存済みの旧数式（niho-10 / niho-12 / niho-13）なら、新しい既定の niho-14 draft で読み替えない
    expect(
      canRestoreDevelopSettingsDraft({ ...unsaved, currentSettings: { ...current, engine: "niho-10" }, draftSettings: { ...current } }),
    ).toBe(false);
    expect(
      canRestoreDevelopSettingsDraft({ ...unsaved, currentSettings: { ...current, engine: "niho-12" }, draftSettings: { ...current } }),
    ).toBe(false);
    expect(
      canRestoreDevelopSettingsDraft({ ...unsaved, currentSettings: { ...current, engine: "niho-13" }, draftSettings: { ...current } }),
    ).toBe(false);
  });

  it("未保存signed RAWは既定切替前のniho-7/4/3 draftを旧pairのまま戻し、保存済み・別base・不正pairは拒否する", () => {
    const base = "raw-apple.d8.p3.e4.cal-panasonic-dc-s5-apple-v4.lens-apple";
    const currentSettings = { ...neutralDevelopSettings(base), engine: "niho-11", look: "niho-standard-5" };
    const old7 = { ...currentSettings, engine: "niho-7", exposure: 1 };
    const old4 = { ...currentSettings, engine: "niho-4", look: "niho-standard-3", exposure: 0.8 };
    const old3 = { ...currentSettings, engine: "niho-3", look: "niho-standard-2", exposure: 0.6 };
    const unsaved = { currentSettings, inputBase: base, hasSavedSettings: false };
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: old7 })).toBe(true);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: old4 })).toBe(true);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: old3 })).toBe(true);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, hasSavedSettings: true, draftSettings: old4 })).toBe(false);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, inputBase: `${base}.other`, draftSettings: old4 })).toBe(false);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: { ...old4, look: "niho-standard-2" } })).toBe(false);
    expect(canRestoreDevelopSettingsDraft({ ...unsaved, draftSettings: { ...old4, engine: "niho-6", look: "niho-standard-1" } })).toBe(false);
    expect(canRestoreDevelopSettingsDraft({
      ...unsaved,
      currentSettings: { ...currentSettings, engine: "niho-4", look: "niho-standard-3" },
      draftSettings: old3,
    })).toBe(false);
  });
});
