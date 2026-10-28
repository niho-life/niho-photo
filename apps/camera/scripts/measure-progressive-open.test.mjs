import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const harness = path.join(path.dirname(fileURLToPath(import.meta.url)), "measure-progressive-open.mjs");

describe("progressive measurement publication boundary", () => {
  it("probeの画像識別情報を捨て、許可した有限の時間だけをcold/warm集計する", () => {
    const privateName = "owned-fixture-name.rw2";
    const privateHash = "b".repeat(64);
    const output = execFileSync(process.execPath, [harness,
      "--case", `fixture=${privateName}`, "--probe", process.execPath,
      "--probe-arg", "-e", "--probe-arg", `process.stdout.write(JSON.stringify({
        input: "${privateName}", sha256: "${privateHash}",
        stagesMs: { editable: 123, presetRenderUpdated: 80, presetThumbnailBlocked: 40, presetRender: 30, serialNumber: 42, encode: -1, decode: null }
      }))`, "--runs", "1",
    ], { encoding: "utf8" });
    expect(output).not.toContain(privateName);
    expect(output).not.toContain(privateHash);
    expect(output).not.toContain("serialNumber");
    expect(output).not.toContain('"encode"');
    expect(output).not.toContain('"decode"');
    const rows = JSON.parse(output).measurements;
    const allowed = { editable: 123, presetRenderUpdated: 80, presetThumbnailBlocked: 40, presetRender: 30 };
    expect(rows.filter((row) => row.stagesMs).map((row) => row.stagesMs)).toEqual([allowed, allowed]);
    expect(rows.filter((row) => row.summary).map((row) => [row.condition, row.runs, row.osFileCache])).toEqual([
      ["cold", 1, "retained"], ["warm", 1, "retained"],
    ]);
  });
});
