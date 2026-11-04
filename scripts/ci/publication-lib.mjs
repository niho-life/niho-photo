import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { workflowFailures } from "./workflow-lib.mjs";
import { photoSdkWorkflowFailures } from "./photo-sdk-workflow-lib.mjs";
import { photoRendererWorkflowFailures } from "./photo-renderer-workflow-lib.mjs";
import { photoCandidateWorkflowFailures } from "./photo-candidate-workflow-lib.mjs";
import { imageMetadataFailures } from "./image-metadata.mjs";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

const excludedDcpHashes = new Set(["ff4f884171f3792846744c8da8d725448a062dfeafb128a8b009fbeb2caa283f", "12ac8236ed7a937f13ba774127ee7af246b976a7722af433d085ee66aee81392", "855c325d2cfc279a660a04b72b98d808247109240a07eba382513f9292944c8c", "34ddf4b685008ecc0f74bcdbdf7d338ca47d79f2ac877e69bd5e9a4b3ee88d4b", "0514ff2a75217ea9e9905f95021eac929632497033f1e5276dc219f127cd0772", "62e665762a5455ed277447a9b6b9797109ee3275d2dc8f4aabe520f4d5d2da17", "66ce1f81f3f2224806763f7227e0fd8b91c3413bfd7667e47f5c3d4d53075325", "26c1e264102de36a03654ddb11c549344a2afc1b144202fe209baac2e2e87f2c"]);
const excludedMatrixHashes = new Set(["93a514bf2fd9e05874b30daba0a9a9865e3b7cd7d3c2d8fe170a0549adf58b31", "b523bab42634a8962d0c269220bb87f5a8d3e8b783e9943a1b2064c9d26f7d5d", "2141ee710124fd18706d50e45adb0a382827baf384a65f3956954b55eb640ab1", "8906a50e539c1bae17c9984634eb0c5d22444b65aeeb32ac7e2c8700f625babe", "866ae6e35eca40571698251c235f724f0a5e18a4cfec8b71937af8b0df1b95e3", "1752ae691161e00587621130f3157847b900af2fcf28d409b5c226a69335dcbb", "302ac9b1cf15f03e40a54b1a0defaafe1e84273fd61356a9f805a96d57cb3c92"]);
export function containsExcludedMatrix(text) {
  const values = [...text.matchAll(/(?<![A-Za-z_])[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/g)].map((m) => Number(m[0]));
  for (let index = 0; index + 9 <= values.length; index++) {
    const row = values.slice(index, index + 9);
    for (const scale of [1, 10000]) {
      const scaled = row.map((v) => Math.round(v * scale));
      if (scaled.some((v, i) => !Number.isSafeInteger(v) || Math.abs(v - row[i] * scale) > 1e-7)) continue;
      if (excludedMatrixHashes.has(digest(scaled.join(',')))) return true;
    }
  }
  return false;
}

const sha256 = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const forbiddenPrefixes = ["apps/api/", "apps/web/", "ops/", "infra/", "archive/", "private/", "secrets/", "release/", "target/", "node_modules/"];
const forbiddenNames = [".env", "id_rsa", "id_ed25519", "credentials.json", "service-account.json", ".gitmodules", ".npmrc", ".gitleaks.toml", ".gitleaksignore", ".git-credentials", ".netrc", "id_ecdsa", "id_dsa"];
const forbiddenExtensions = [".p12", ".p8", ".pem", ".key", ".mobileprovision", ".cer", ".crt", ".db", ".sqlite", ".onnx", ".mlmodel", ".mlmodelc", ".icc", ".icm", ".pfx", ".jks", ".keystore", ".sqlite3", ".dmg", ".pkg", ".exe", ".msi", ".ipa", ".aab", ".apk"];
const assetExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".heic", ".tif", ".tiff", ".svg", ".ico", ".icns", ".woff", ".woff2", ".ttf", ".otf", ".bin", ".wasm", ".f32", ".hex", ".xmp", ".dcp", ".icc", ".icm", ".pdf", ".zip", ".gz", ".mp4", ".mov", ".raw", ".rw2", ".dng", ".nef", ".cr2", ".arw", ".wav", ".mp3", ".aiff", ".flac"]);
export const isAsset = (name) => assetExtensions.has(path.posix.extname(name).toLowerCase()) || /(?:^|\/)(?:fixtures?|calibration|models?|profiles?|data|assets|looks|presets)(?:\/|$)/i.test(name);
export const isSource = (name) => /^(?:packages|apps)\//.test(name);
export const validPath = (name) => typeof name === "string" && name.length > 0 && !/[\x00-\x1f\x7f\\]/.test(name) && !name.startsWith("/") && !name.startsWith("../") && name !== "." && name === path.posix.normalize(name);
const meaningful = (value) => typeof value === "string" && value.trim().length >= 8;

// CSVの引用符、カンマ、改行を扱い、権利判断の列ずれを黙認しない。
export function parseInventory(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && quoted && text[i + 1] === '"') { field += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) { row.push(field); field = ""; }
    else if (c === "\n" && !quoted) { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (quoted) throw new Error("資産台帳CSVの引用符が閉じていません");
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift();
  if (!headers || new Set(headers).size !== headers.length || !["source_commit", "source_path", "sha256", "size_bytes", "origin", "license_evidence", "redistribution", "decision"].every((key) => headers.includes(key))) throw new Error("資産台帳の必須列がありません");
  return rows.filter((r) => r.some(Boolean)).map((r) => {
    if (r.length !== headers.length) throw new Error("資産台帳の列数が不正です");
    return Object.fromEntries(headers.map((key, index) => [key, r[index]]));
  });
}

export function repositoryFiles(root) {
  const tracked = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, , stage] = line.slice(0, tab).split(" ");
    if (stage !== "0") throw new Error("未解決のGit conflictがあります");
    return { name: line.slice(tab + 1), mode };
  });
  const extra = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).map((name) => ({ name, mode: "100644" }));
  return [...tracked, ...extra];
}

export function runtimeTokenPath(name) {
  const lower = name.toLowerCase();
  return /(?:^|\/)(?:account-secrets|oauth-tokens|runtime-tokens)(?:\/|$)/.test(lower) ||
    /(?:^|\/)(?:pending|tokens?|access[-_]token|refresh[-_]token|id[-_]token|account[-_]session|oauth[-_]session|credentials)(?:\.(?:json|jsonl|txt|bin|token|bak|backup))?$/.test(lower);
}

function pathForbidden(name, policy) {
  const lower = name.toLowerCase();
  const basename = path.posix.basename(lower);
  return runtimeTokenPath(name) || [...forbiddenPrefixes, ...policy.forbiddenPathPrefixes].some((prefix) => lower.startsWith(prefix.toLowerCase())) ||
    [...forbiddenNames, ...policy.forbiddenBasenames].includes(basename) || /^\.env(?:\.|$)/.test(basename) ||
    [...forbiddenExtensions, ...policy.forbiddenExtensions].includes(path.posix.extname(lower)) ||
    /(?:^|\/)(?:\.git|node_modules|target)(?:\/|$)/.test(lower);
}

export function containsPrivateReference(text) {
  // 値はエラーに含めない。公開ドキュメント内の移行元の名前だけはURLではないため許容。
  // JSON/JS文字列のescaped backslashも通常のpath separatorに揃えて検査する。
  const normalizedPaths = text.replace(/\\+/g, "/");
  if (/(?:^|[\s\x22\x27\x60(=])(?:\/(?:Users|Volumes|home|private|root)\/|[a-z]:\/Users\/)/im.test(normalizedPaths)) return true;
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) return true;
  const urls = text.match(/(?:https?|ssh|git\+https|git\+ssh):\/\/[^\s<>"'`]+|git@[A-Za-z0-9.-]+:[^\s<>"'`]+/gi) ?? [];
  return urls.some((url) => {
    const normalized = url.toLowerCase();
    if (/github\.com[/:]niho-coliving\/(?:niho-app|niho-clients)(?:[/.#?]|$)/.test(normalized)) return true;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      return Boolean(parsed.username || parsed.password) || /(?:\.internal|\.local|\.ts\.net)$/.test(host) || /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) || /(?:^|\.)(?:app-stg\.niho\.life|supabase\.co|hitohako\.jpn\.org)$/.test(host);
    } catch { return /^git@/i.test(url); }
  });
}

export async function verifyPublication(root) {
  const failures = [];
  const fail = (code, name = "") => failures.push(`${code}${name ? `: ${JSON.stringify(name)}` : ""}`);
  const readJson = async (name) => JSON.parse(await readFile(path.join(root, name), "utf8"));
  const policy = await readJson("docs/security/publication-policy.json");
  const manifest = await readJson("docs/security/publication-manifest.json");
  if (policy.schemaVersion !== 1 || !Number.isSafeInteger(policy.maxFileBytes) || policy.maxFileBytes <= 0 || policy.maxFileBytes > 52428800 || policy.assetManifestRequired !== true || policy.assetManifestPath !== "docs/security/publication-manifest.json" || !["forbiddenPathPrefixes", "forbiddenBasenames", "forbiddenExtensions"].every((key) => Array.isArray(policy[key]) && policy[key].every((v) => typeof v === "string"))) throw new Error("公開policyの契約が不正です");
  const externalSources = manifest.externalSources ?? [];
  if (manifest.schemaVersion !== 1 || !commit.test(manifest.sourceBaseline?.commit ?? "") || !manifest.sourceBaseline?.repository || !commit.test(manifest.auditedCandidate?.commit ?? "") || !Array.isArray(externalSources) || externalSources.some((item) => !item?.repository || !commit.test(item.commit ?? "")) || !Array.isArray(manifest.importedFiles) || !Array.isArray(manifest.generatedFiles) || !Array.isArray(manifest.excludedSources) || !Array.isArray(manifest.deferredScopes)) throw new Error("公開manifestのschemaが不正です");
  if (externalSources.length > 0) {
    try {
      const { validatePublicationSources, validateSyncManifest } = await import("./cloud-contract-sync.mjs");
      const syncManifest = validateSyncManifest(await readJson("docs/security/cloud-contract-source.json"));
      validatePublicationSources(syncManifest, manifest);
    } catch {
      fail("外部出典契約不正");
    }
  }
  const inventory = parseInventory(await readFile(path.join(root, "docs/legal/asset-inventory.csv"), "utf8"));
  for (const row of inventory) {
    if (!commit.test(row.source_commit) || !validPath(row.source_path) || !sha256.test(row.sha256) || !Number.isSafeInteger(Number(row.size_bytes)) || Number(row.size_bytes) < 0 || !["公開可能", "要置換", "非公開維持"].includes(row.decision)) fail("資産台帳の記録不正");
  }
  const approved = new Map();
  for (const [kind, entries] of [["imported", manifest.importedFiles], ["generated", manifest.generatedFiles]]) {
    for (const entry of entries) {
      if (!validPath(entry.path)) { fail("manifestパス不正"); continue; }
      if (approved.has(entry.path)) fail("manifest重複", entry.path);
      approved.set(entry.path, { ...entry, kind });
      if (!sha256.test((kind === "imported" ? entry.outputSha256 : entry.sha256) ?? "")) fail("manifestハッシュ不正", entry.path);
      if (kind === "imported") {
        const baselineSource = entry.source?.repository === manifest.sourceBaseline.repository && entry.source?.commit === manifest.sourceBaseline.commit;
        const externalSource = externalSources.some((item) => item.repository === entry.source?.repository && item.commit === entry.source?.commit);
        if (!entry.source || !validPath(entry.source.path) || !(baselineSource || externalSource) || !sha256.test(entry.source.sha256 ?? "")) fail("manifest出典不正", entry.path);
        if (entry.source && validPath(entry.source.path) && pathForbidden(entry.source.path, policy)) fail("manifest出典禁止パス", entry.path);
        if (!Array.isArray(entry.modifications) || entry.modifications.some((v) => !meaningful(v)) || (entry.source?.sha256 !== entry.outputSha256 && !entry.modifications?.length)) fail("manifest変更理由不正", entry.path);
      } else if (!meaningful(entry.origin)) fail("manifest生成元未記録", entry.path);
    }
  }
  for (const excluded of manifest.excludedSources) {
    if (!validPath(excluded.sourcePath) || !meaningful(excluded.reason) || (excluded.sourceSha256 && !sha256.test(excluded.sourceSha256))) fail("manifest除外記録不正");
  }
  let publicSdkDependencies = [];
  try { publicSdkDependencies = await readPublicSdkDependencies(root, policy); }
  catch { fail("公式SDK依存の公開proof不正"); }
  const files = repositoryFiles(root);
  const existing = new Set(files.map(({ name }) => name));
  const workspaceNames = new Set();
  const workspacePaths = new Set();
  const sdkConsumers = new Set();
  const sdkLocks = new Set();
  const sdkConsumerLocks = new Set();
  for (const { name } of files.filter(({ name }) => isSource(name) && name.endsWith("/package.json"))) {
    try { workspaceNames.add((await readJson(name)).name); workspacePaths.add(path.posix.dirname(name)); } catch { fail("package JSON不正", name); }
  }
  for (const { name, mode } of files) {
    if (!validPath(name)) { fail("公開パス不正"); continue; }
    if (pathForbidden(name, policy)) fail("公開禁止パス", name);
    if (mode === "120000" || mode === "160000") { fail("symlink/submodule禁止", name); continue; }
    let stat;
    let unsafeParent = false;
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      try { if (!(await lstat(path.join(root, ...parts.slice(0, i)))).isDirectory()) unsafeParent = true; }
      catch { unsafeParent = true; }
    }
    if (unsafeParent) { fail("通常ディレクトリ以外の親は禁止", name); continue; }
    try { stat = await lstat(path.join(root, name)); } catch { fail("追跡ファイル欠落", name); continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) { fail("通常ファイル以外は禁止", name); continue; }
    if (stat.size > policy.maxFileBytes) { fail("公開サイズ超過", name); continue; }
    const bytes = await readFile(path.join(root, name));
    const hash = digest(bytes);
    const entry = approved.get(name);
    if (excludedDcpHashes.has(hash)) fail("除外済み旧DCPのバイト列", name);
    for (const violation of imageMetadataFailures(name, bytes)) fail(violation, name);
    if (name.toLowerCase().endsWith('.dcp')) {
      const proof = (manifest.independentProfiles ?? []).find((item) => item.path === name);
      if (entry?.kind !== 'generated' || !proof || proof.initialMatrix !== 'none' || !Array.isArray(proof.inputs) || proof.inputs.length < 3 || !proof.inputs.every((v) => sha256.test(v)) || !sha256.test(proof.measurementsSha256 ?? '') || !sha256.test(proof.validationSha256 ?? '') || proof.outputSha256 !== hash || !sha256.test(proof.specSha256 ?? '')) fail("独立DCPの生成証拠未確認", name);
      else {
        try {
          if (!validPath(proof.measurementsPath) || !validPath(proof.validationPath) || !validPath(proof.specPath)) throw new Error();
          const measurements = await readFile(path.join(root, proof.measurementsPath));
          const validation = await readFile(path.join(root, proof.validationPath));
          const spec = await readFile(path.join(root, proof.specPath));
          if (!validPath(proof.measurementsPath) || !validPath(proof.validationPath) || digest(measurements) !== proof.measurementsSha256 || digest(validation) !== proof.validationSha256 || digest(spec) !== proof.specSha256 || JSON.parse(validation).passed !== true) fail("独立DCPの測定/検証hash不一致", name);
        } catch { fail("独立DCPの測定/検証欠落", name); }
      }
    }
    if (isSource(name) && !entry) fail("manifest未登録ソース", name);
    if (entry && hash !== (entry.outputSha256 ?? entry.sha256)) fail("manifestハッシュ不一致", name);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* binary requires exact asset approval below */ }
    const binary = bytes.includes(0) || text === undefined;
    if (binary || isAsset(name)) {
      if (!entry) fail("manifest未登録資産", name);
      const sourcePath = entry?.source?.path ?? name;
      const sourceHash = entry?.source?.sha256 ?? hash;
      const publicAsset = inventory.some((row) => row.source_path === sourcePath && (row.source_sha256 ?? row.sha256) === sourceHash && row.sha256 === hash && Number(row.size_bytes) === bytes.length && row.decision === "公開可能" && meaningful(row.origin) && meaningful(row.license_evidence) && row.redistribution && (!entry?.source || row.source_commit === manifest.auditedCandidate.commit || row.source_commit === entry.source.commit));
      const independentSynthetic = !binary && /(?:^|\/)fixtures?\//i.test(name) && /\.(?:json|csv|txt)$/.test(name) && entry?.kind === "generated" && meaningful(entry.origin) && !inventory.some((row) => row.sha256 === hash && Number(row.size_bytes) === bytes.length && row.decision !== "公開可能");
      if (!publicAsset && !independentSynthetic) fail("資産の公開許可未確認", name);
      if (inventory.some((row) => row.sha256 === hash && Number(row.size_bytes) === bytes.length && row.decision !== "公開可能")) fail("非公開/要置換の元資産", name);
    }
    if (text !== undefined && /^packages\/develop-engine\//.test(name) && /\.(?:rs|py|json|mjs)$/.test(name) && containsExcludedMatrix(text)) fail("除外済み行列の転記", name);
    if (text !== undefined && containsPrivateReference(text)) fail("非公開参照検出（値は非表示）", name);
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(name)) {
      try {
        const validator = name === ".github/workflows/public-ci.yml" ? workflowFailures : name === ".github/workflows/photo-sdk-release.yml" ? photoSdkWorkflowFailures : name === ".github/workflows/photo-renderer-release.yml" ? photoRendererWorkflowFailures : name === ".github/workflows/photo-candidate-release.yml" ? photoCandidateWorkflowFailures : null;
        if (!validator) throw new Error();
        for (const violation of validator(JSON.parse(text))) fail(violation, name);
      }
      catch { fail("workflowは構造検査可能なJSON形式で記述", name); }
    }
    if (name.endsWith("package.json")) {
      try {
        const pkg = JSON.parse(text);
        if (isSource(name) && pkg.private !== true) fail("npm公開禁止設定なし", name);
        for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides"]) {
          for (const [dependency, version] of Object.entries(pkg[section] ?? {})) {
            const approvedSdk = approvedSdkPackageDependency(publicSdkDependencies, name, dependency, version);
            if (approvedSdk && section === "dependencies") sdkConsumers.add(dependency);
            if (!approvedSdk && (typeof version !== "string" || /(?:https?:|git[+:]|github:|file:|link:|ssh:|\/\/)/i.test(version) || ((/^@niho\//.test(dependency) || /^niho-/.test(dependency)) && !workspaceNames.has(dependency)))) fail("非公開/非registry package参照", name);
          }
        }
      } catch { fail("package JSON不正", name); }
    }
    if (name === "package-lock.json") {
      const lock = JSON.parse(text);
      if (lock.lockfileVersion !== 3) fail("lock形式不正", name);
      for (const [lockPath, dependency] of Object.entries(lock.packages ?? {})) {
        for (const entry of publicSdkDependencies) {
          if (approvedSdkConsumerLockDependency(entry, lockPath, dependency)) sdkConsumerLocks.add(entry.name);
        }
        if (approvedSdkLockDependency(publicSdkDependencies, lockPath, dependency)) sdkLocks.add(lockPath.slice("node_modules/".length));
        if (dependency.link && !workspacePaths.has(dependency.resolved)) fail("公開workspace以外へのlock link", name);
        if (dependency.resolved && !dependency.link && !/^https:\/\/registry\.npmjs\.org\//.test(dependency.resolved) && !approvedSdkLockDependency(publicSdkDependencies, lockPath, dependency)) fail("公開registry以外のlock依存", name);
      }
    }
  }
  for (const name of sdkConsumers) if (!sdkLocks.has(name)) fail("公式SDKのlock依存欠落");
  for (const name of sdkLocks) if (!sdkConsumers.has(name)) fail("公式SDKに対応するconsumer依存欠落");
  for (const entry of publicSdkDependencies) {
    if (!sdkConsumers.has(entry.name)) fail("固定公式SDKのconsumer依存欠落");
    if (!sdkLocks.has(entry.name)) fail("固定公式SDKのlock依存欠落");
    if (!sdkConsumerLocks.has(entry.name)) fail("固定公式SDKのconsumer lock依存欠落");
  }
  for (const name of approved.keys()) if (!existing.has(name)) fail("manifestファイル欠落", name);
  return { failures: [...new Set(failures)], fileCount: files.length, imported: manifest.importedFiles.length, generated: manifest.generatedFiles.length };
}

// 公開依存と配布SBOMで共有する固定SDK proof。SDK ownership対象の本moduleへ集約する。
const REPOSITORY = "niho-life/niho-photo";
const CONSUMER = "packages/photo-cloud-media/package.json";
const PROOF_PATH = "packages/photo-cloud-media/sdk-baseline.json";
const RECEIPT_PATH = "docs/security/public-sdk-dependency-receipt.json";
const NAMES = new Set(["niho-photo-contract", "niho-photo-develop-engine-runtime"]);
const verifiedDependencies = new WeakSet();
const HEX256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const invalid = () => { throw new Error("公開SDK依存の固定proofが不正です"); };
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Only the two audited artifacts from this repository, bound to one declared consumer. */
export async function readPublicSdkDependencies(root, policy) {
  return readPublicSdkDependenciesSync(root, policy);
}

export function readPublicSdkDependenciesSync(root, policy) {
  const entries = policy.publicSdkDependencies === undefined ? [] : policy.publicSdkDependencies;
  if (!Array.isArray(entries) || (entries.length !== 0 && entries.length !== NAMES.size)) invalid();
  if (entries.length === 0) return [];
  const receiptPolicy = policy.publicSdkDependencyReceipt;
  if (!record(receiptPolicy) || Object.keys(receiptPolicy).length !== 2
    || receiptPolicy.path !== RECEIPT_PATH || !HEX256.test(receiptPolicy.sha256 ?? "")) invalid();
  const receiptBytes = readFileSync(path.join(root, RECEIPT_PATH));
  if (digest(receiptBytes) !== receiptPolicy.sha256) invalid();
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  if (!record(receipt) || receipt.schemaVersion !== 1 || receipt.repository !== REPOSITORY
    || !Array.isArray(receipt.artifacts) || receipt.artifacts.length !== NAMES.size) invalid();
  const proofBytes = readFileSync(path.join(root, PROOF_PATH));
  const proof = JSON.parse(proofBytes.toString("utf8"));
  const names = new Set();
  for (const entry of entries) {
    if (!record(entry) || Object.keys(entry).length !== 10 || !NAMES.has(entry.name) || names.has(entry.name)
      || entry.consumer !== CONSUMER || entry.proofPath !== PROOF_PATH
      || typeof entry.version !== "string" || !/^\d+\.\d+\.\d+$/.test(entry.version)
      || !COMMIT.test(entry.sourceCommit ?? "") || !HEX256.test(entry.sha256 ?? "")
      || !HEX256.test(entry.proofSha256 ?? "") || digest(proofBytes) !== entry.proofSha256
      || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0 || entry.sizeBytes > 52_428_800
      || typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) invalid();
    const filename = `${entry.name}-${entry.version}.tgz`;
    const receipts = receipt.artifacts.filter((item) => record(item) && item.name === entry.name);
    const accepted = receipts[0];
    if (receipts.length !== 1 || receipt.releaseTag !== `photo-sdk-v${entry.version}`
      || receipt.sourceCommit !== entry.sourceCommit || accepted.url !== entry.url
      || accepted.file !== filename || accepted.sizeBytes !== entry.sizeBytes
      || accepted.sha256 !== entry.sha256 || accepted.integrity !== entry.integrity) invalid();
    if (entry.url !== `https://github.com/${REPOSITORY}/releases/download/photo-sdk-v${entry.version}/${filename}`
      || !record(proof) || proof.schemaVersion !== 1 || proof.repository !== REPOSITORY
      || proof.releaseTag !== `photo-sdk-v${entry.version}` || proof.sourceCommit !== entry.sourceCommit
      || !Array.isArray(proof.packages)) invalid();
    const artifacts = proof.packages.filter((item) => record(item) && item.name === entry.name);
    const artifact = artifacts[0];
    if (artifacts.length !== 1 || artifact.file !== filename || artifact.sha256 !== entry.sha256
      || artifact.size !== entry.sizeBytes
      || artifact.integrity !== `sha256-${Buffer.from(entry.sha256, "hex").toString("base64")}`) invalid();
    names.add(entry.name);
  }
  const verified = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
  verifiedDependencies.add(verified);
  return verified;
}

export function isVerifiedPublicSdkDependencies(entries) {
  return Array.isArray(entries) && (entries.length === 0 || verifiedDependencies.has(entries));
}

export function approvedSdkPackageDependency(entries, consumer, name, specifier) {
  return entries.some((entry) => entry.consumer === consumer && entry.name === name && entry.url === specifier);
}

export function approvedSdkLockDependency(entries, lockPath, dependency) {
  return record(dependency) && !dependency.link && entries.some((entry) =>
    lockPath === `node_modules/${entry.name}` && dependency.version === entry.version
    && (dependency.name === undefined || dependency.name === entry.name)
    && dependency.resolved === entry.url && dependency.integrity === entry.integrity);
}

export function approvedSdkConsumerLockDependency(entry, lockPath, dependency) {
  return lockPath === entry.consumer.slice(0, -"/package.json".length)
    && record(dependency) && record(dependency.dependencies)
    && dependency.dependencies[entry.name] === entry.url;
}
