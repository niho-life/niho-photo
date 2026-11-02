import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceCases } from "./cases.mjs";
import { inspectEvidence } from "./verify-evidence.mjs";

// 記録検査器を試す合成値。製品の合格記録ではなく、ファイルにも保存しない。
const ledger = () => ({
  schemaVersion: 1, photoSourceSha: "a".repeat(40), backendSourceSha: "b".repeat(40), sdkManifestSha256: "c".repeat(64),
  records: acceptanceCases.flatMap((item) => item.required.map((surface) => ({
    caseId: item.id, surface, result: "pass", observations: 1, evidenceRef: "synthetic-verifier-test",
  }))),
});

test("空集合・unitだけ・欠測を製品受入の完了にしない", () => {
  const value = ledger();
  value.records = [];
  const empty = inspectEvidence(value);
  assert.equal(empty.valid, true);
  assert.equal(empty.complete, false);
  assert.equal(empty.passed, 0);
  value.records = ledger().records.filter((record) => record.surface === "unit");
  const units = inspectEvidence(value);
  assert.equal(units.complete, false);
  assert.ok(units.pending.some((item) => item.slot.endsWith("/storage-provider")));
  assert.ok(units.pending.some((item) => item.slot.endsWith("/iphone-safari")));
});

test("正確なsource/SDK識別子と全試験面の記録を要求する", () => {
  assert.equal(inspectEvidence(ledger()).complete, true);
  for (const field of ["photoSourceSha", "backendSourceSha", "sdkManifestSha256"]) {
    for (const replacement of ["latest", [ledger()[field]], null]) {
      const value = ledger();
      value[field] = replacement;
      assert.equal(inspectEvidence(value).valid, false);
    }
  }
});

test("失敗・block・未実行を残し、0件pass・重複・未知面を拒否する", () => {
  for (const result of ["fail", "blocked", "not-run"]) {
    const value = ledger();
    value.records[0].result = result;
    assert.equal(inspectEvidence(value).complete, false);
  }
  const mutations = [
    (value) => { value.records[0].observations = 0; },
    (value) => { value.records.push({ ...value.records[0] }); },
    (value) => { value.records[0].surface = "simulator"; },
    (value) => { value.records[0].caseId = "unknown"; },
    (value) => { value.records[0].result = "success"; },
  ];
  for (const mutate of mutations) {
    const value = ledger();
    mutate(value);
    assert.equal(inspectEvidence(value).valid, false);
  }
});

test("入力の秘密・URL・自由文や未知fieldを検査結果へ反射しない", () => {
  for (const evidenceRef of ["https://private.example.test/photo?credential=canary", "secret canary", "../credential"]) {
    const value = ledger();
    value.records[0].evidenceRef = evidenceRef;
    assert.deepEqual(inspectEvidence(value), { valid: false, complete: false, error: "invalid-evidence" });
  }
  const value = ledger();
  value.credential = "synthetic-secret";
  assert.equal(inspectEvidence(value).valid, false);
  assert.equal(inspectEvidence(null).valid, false);
});
