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

test("branch も変更も無い座席だけが空き", () => {
  assert.equal(isFree({ branch: "", dirty: false }), true);
  assert.equal(isFree({ branch: "", dirty: false, ahead: 0 }), true);
  assert.equal(isFree({ branch: "feature/x", dirty: false }), false);
  assert.equal(isFree({ branch: "", dirty: true }), false);
  // detach したまま commit した座席は、push するまで空きにしない
  assert.equal(isFree({ branch: "", dirty: false, ahead: 1 }), false);
});

test("変更・未 push・先行 commit があれば空けない", () => {
  assert.match(releaseBlocker({ branch: "feature/x", dirty: true, upstream: "origin/feature/x", ahead: 0 }), /変更/);
  assert.match(releaseBlocker({ branch: "feature/x", dirty: false, upstream: null, ahead: 1 }), /push されていません/);
  assert.equal(releaseBlocker({ branch: "feature/x", dirty: false, upstream: null, ahead: 0 }), null);
  assert.match(releaseBlocker({ branch: "feature/x", dirty: false, upstream: "origin/feature/x", ahead: 2 }), /2 件/);
  assert.equal(releaseBlocker({ branch: "feature/x", dirty: false, upstream: "origin/feature/x", ahead: 0 }), null);
  assert.equal(releaseBlocker({ branch: "", dirty: false, upstream: null, ahead: 0 }), null);
  assert.match(releaseBlocker({ branch: "", dirty: false, upstream: null, ahead: 2 }), /branch の無い commit が 2 件/);
});

test("push 先が消えた branch は自動では空けない", () => {
  assert.match(releaseBlocker({ branch: "feature/x", dirty: false, upstream: null, tracked: true, ahead: 3 }), /push 先が消えています/);
});
