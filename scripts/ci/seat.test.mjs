import assert from "node:assert/strict";
import { test } from "node:test";
import { isFree, parseSeat, releaseBlocker, seatPath, validTopic } from "../seat.mjs";

test("座席は root の clone の隣に番号で並ぶ", () => {
  assert.equal(seatPath("/work/niho-photo", 3), "/work/niho-photo-3");
});

test("座席の番号は 1〜8 だけ", () => {
  assert.equal(parseSeat("1"), 1);
  assert.equal(parseSeat("8"), 8);
  assert.equal(parseSeat("0"), null);
  assert.equal(parseSeat("9"), null);
  assert.equal(parseSeat("2.5"), null);
  assert.equal(parseSeat(undefined), null);
});

test("topic は小文字・数字・ハイフンだけ", () => {
  assert.equal(validTopic("preset-thumbnail-yield"), true);
  assert.equal(validTopic("Preset"), false);
  assert.equal(validTopic("-start"), false);
  assert.equal(validTopic("a/b"), false);
  assert.equal(validTopic("x"), false);
});

test("clean な topic branch は参照を残して再利用できる", () => {
  assert.equal(isFree({ branch: "", dirty: false }), true);
  assert.equal(isFree({ branch: "", dirty: false, ahead: 0 }), true);
  assert.equal(isFree({ branch: "feature/x", dirty: false }), true);
  assert.equal(isFree({ branch: "feature/x", dirty: false, ahead: 3 }), true);
  assert.equal(isFree({ branch: "", dirty: true }), false);
  assert.equal(isFree({ branch: "feature/x", dirty: true, ahead: 0 }), false);
  // branch がない detached commit は保存先の ref がないため空きにしない
  assert.equal(isFree({ branch: "", dirty: false, ahead: 1 }), false);
});

test("branch は push 先や未 push commit の状態に関係なく ref を残して切り替えられる", () => {
  assert.equal(releaseBlocker({ branch: "feature/x", dirty: false, ahead: 3 }), null);
  assert.equal(releaseBlocker({ branch: "feature/x", dirty: false, ahead: 0 }), null);
  assert.equal(releaseBlocker({ branch: "feature/x", dirty: true, ahead: 0 })?.includes("変更"), true);
  assert.equal(releaseBlocker({ branch: "", dirty: false, ahead: 0 }), null);
  assert.match(releaseBlocker({ branch: "", dirty: false, ahead: 2 }), /branch の無い commit が 2 件/);
});
