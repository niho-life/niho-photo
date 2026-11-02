import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { acceptanceCases } from "./cases.mjs";

const results = new Set(["pass", "fail", "blocked", "not-run"]);
const sha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const reference = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const exactKeys = (value, expected) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));

/** 証跡の記録漏れを検出する。実handler/provider/実機の実行や証跡の内容監査は別途必要。 */
export function inspectEvidence(value) {
  const invalid = () => ({ valid: false, complete: false, error: "invalid-evidence" });
  if (!exactKeys(value, ["schemaVersion", "photoSourceSha", "backendSourceSha", "sdkManifestSha256", "records"])
    || value.schemaVersion !== 1 || typeof value.photoSourceSha !== "string" || !sha.test(value.photoSourceSha)
    || typeof value.backendSourceSha !== "string" || !sha.test(value.backendSourceSha)
    || typeof value.sdkManifestSha256 !== "string" || !digest.test(value.sdkManifestSha256)
    || !Array.isArray(value.records) || value.records.length > 1000) return invalid();
  const slots = new Map(acceptanceCases.flatMap((item) => item.required.map((surface) => [`${item.id}/${surface}`, null])));
  for (const record of value.records) {
    if (!exactKeys(record, ["caseId", "surface", "result", "observations", "evidenceRef"])
      || typeof record.caseId !== "string" || typeof record.surface !== "string" || !results.has(record.result)
      || !Number.isSafeInteger(record.observations) || record.observations < 0
      || typeof record.evidenceRef !== "string" || !reference.test(record.evidenceRef)
      || (record.result === "pass" && record.observations === 0)) return invalid();
    const key = `${record.caseId}/${record.surface}`;
    if (!slots.has(key) || slots.get(key) !== null) return invalid();
    slots.set(key, record.result);
  }
  const pending = [...slots].filter(([, result]) => result !== "pass").map(([slot, result]) => ({ slot, result: result ?? "missing" }));
  return { valid: true, complete: pending.length === 0, total: slots.size, passed: slots.size - pending.length, pending };
}

export async function main(file) {
  try {
    if (!file) throw new Error();
    const buffer = await readFile(file);
    if (buffer.byteLength > 1024 * 1024) throw new Error();
    const report = inspectEvidence(JSON.parse(buffer.toString("utf8")));
    // 利用者が渡した値・path・例外・生の証跡を出力しない。
    console.log(JSON.stringify(report));
    return !report.valid ? 2 : report.complete ? 0 : 1;
  } catch {
    console.error("証跡を読めません。非公開のJSONファイルを1つ指定してください（入力値は非表示）。");
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.length === 3 ? process.argv[2] : undefined);
}
