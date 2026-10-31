import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { containsPrivateReference, runtimeTokenPath } from "./publication-lib.mjs";

export const lockfiles = ["apps/camera/src-tauri/Cargo.lock", "apps/camera/tools/webview-isolation-probe/Cargo.lock", "package-lock.json", "packages/desktop-account/Cargo.lock", "packages/desktop-photo/Cargo.lock", "packages/develop-engine/Cargo.lock"].sort();
// repo に入っている lockfile はすべて `lockfiles` に載せる（SBOM は全 lock の inventory）。PR の試験と main の成果物生成が同じ判定を使う。
export const lockfilePattern = /(?:^|\/)(?:package-lock\.json|Cargo\.lock|yarn\.lock|pnpm-lock\.yaml|Package\.resolved)$/;
export const contractFiles = ["packages/desktop-account/contract/native-account-v2.json", "packages/niho-cloud-contract/package.json", "packages/niho-cloud-contract/v1/security-cases.json", "docs/security/cloud-contract-source.json"];
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function artifactName(commit, arch) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !["arm64", "x64"].includes(arch)) throw new Error("成果物識別子が不正です");
  return `niho-photo-${commit}-macos-${arch}`;
}

export function workflowArtifactName(commit, arch, runId, runAttempt) {
  const stem = artifactName(commit, arch);
  if (!/^[1-9][0-9]*$/.test(runId ?? "") || !/^[1-9][0-9]*$/.test(runAttempt ?? "")) throw new Error("workflow成果物識別子が不正です");
  return `${stem}-run-${runId}-attempt-${runAttempt}`;
}

// 環境のdenylistではなくビルドに必要な公開値だけを渡す。署名・API・npm設定等は引き継がない。
export function buildEnvironment(input, root, isolated = {}) {
  const env = Object.fromEntries(["PATH", "LANG", "DEVELOPER_DIR", "SDKROOT", "RUSTUP_HOME"].filter((key) => input[key]).map((key) => [key, input[key]]));
  if (!isolated.home || !isolated.cargoHome || !isolated.tmpdir || !isolated.npmUserConfig || !isolated.npmGlobalConfig) throw new Error("隔離build設定が必要です");
  const remap = [[root, "source"], [input.RUSTUP_HOME, "toolchain"], [isolated.tmpdir, "build-temp"]].filter(([from]) => from).map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  return { ...env, HOME: isolated.home, CARGO_HOME: isolated.cargoHome, TMPDIR: isolated.tmpdir, NPM_CONFIG_USERCONFIG: isolated.npmUserConfig, NPM_CONFIG_GLOBALCONFIG: isolated.npmGlobalConfig, CI: "true", CSC_IDENTITY_AUTO_DISCOVERY: "false", RUSTUP_TOOLCHAIN: "1.98.1", CARGO_BUILD_JOBS: "2", CARGO_PROFILE_RELEASE_DEBUG: "0", CARGO_PROFILE_RELEASE_STRIP: "debuginfo", CARGO_ENCODED_RUSTFLAGS: remap.join("\x1f") };
}

export function createArtifactReceipt({ artifactId, artifactDigest, artifactName: name, commit, runId, runAttempt }) {
  const stemPattern = /^niho-photo-([a-f0-9]{40})-macos-(arm64|x64)-run-([1-9][0-9]*)-attempt-([1-9][0-9]*)$/;
  const match = stemPattern.exec(name ?? "");
  if (!/^[1-9][0-9]*$/.test(artifactId ?? "") || !/^[a-f0-9]{64}$/.test(artifactDigest ?? "") || !/^[a-f0-9]{40}$/.test(commit ?? "") || !/^[1-9][0-9]*$/.test(runId ?? "") || !/^[1-9][0-9]*$/.test(runAttempt ?? "") || !match || match[1] !== commit || match[3] !== runId || match[4] !== runAttempt) throw new Error("Actions artifact receiptが不正です");
  return [
    "## Public release evidence artifact",
    "",
    "- Repository: `niho-life/niho-photo`",
    `- Commit: \`${commit}\``,
    `- Workflow run: \`${runId}\` (attempt \`${runAttempt}\`)`,
    `- Artifact name: \`${name}\``,
    `- Artifact ID: \`${artifactId}\``,
    `- Artifact digest (SHA-256): \`${artifactDigest}\``,
    "",
  ].join("\n");
}

export function assertPublicBytes(bytes, forbiddenRoots = []) {
  const text = bytes.toString("utf8");
  const normalized = text.replace(/\\+/g, "/");
  if (containsPrivateReference(text)) throw new Error("成果物に非公開参照があります [private-reference]（値は非表示）");
  if (forbiddenRoots.filter(Boolean).some((root) => text.includes(root))) throw new Error("成果物に非公開参照があります [build-root]（値は非表示）");
  if (/(?:^|[\s\x00\x22\x27\x60(=])\/(?:Users|Volumes|home|private|root)\//i.test(normalized) || /(?:^|[\s\x00\x22\x27\x60(=])file:\/\/\/(?:Users|Volumes|home|private|root)\//i.test(normalized) || /(?:^|[\s\x00\x22\x27\x60(=])[a-z]:\/Users\//i.test(normalized)) throw new Error("成果物に非公開参照があります [absolute-path]（値は非表示）");
  if (/sourceMappingURL\s*=|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/.test(text) || /["']?(?:access_token|refresh_token|id_token|client_secret|password)["']?\s*[:=]\s*["'][^"']{8,}["']/i.test(text)) throw new Error("成果物に秘密またはsource mapがあります（値は非表示）");
}

export async function guardBundle(root, forbiddenRoots = []) {
  let count = 0;
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const full = path.join(directory, name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      const stat = await lstat(full);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("成果物の特殊ファイルは禁止です");
      if (/\.map$|\.dSYM(?:\/|$)|(?:^|\/)(?:\.env[^/]*|\.git|\.DS_Store|logs?|node_modules)(?:\/|$)|\.(?:p8|p12|pem|key|log)$/i.test(relative) || runtimeTokenPath(relative)) throw new Error("成果物の禁止ファイルです（値は非表示）");
      if (stat.isDirectory()) await visit(full);
      else { assertPublicBytes(await readFile(full), forbiddenRoots); count++; }
    }
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("appディレクトリが必要です");
  await visit(root);
  if (!count) throw new Error("空のappは禁止です");
  return count;
}

export function npmComponents(bytes) {
  const lock = JSON.parse(bytes);
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error("npm lock v3が必要です");
  const result = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (entry.link) continue;
    const name = entry.name ?? (location.includes("node_modules/") ? location.split("node_modules/").at(-1) : undefined);
    if (!name || !entry.version) throw new Error("npm依存の名前と版が必要です");
    if (entry.resolved && !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved)) throw new Error("公開npm registry以外は禁止です");
    const purl = `pkg:npm/${name.replace(/^@/, "%40")}@${encodeURIComponent(entry.version)}`;
    result.push({ type: location === "" || !location.includes("node_modules/") ? "application" : "library", name, version: entry.version, purl, "bom-ref": purl });
  }
  return result;
}

// Cargo.lock v3/v4の[[package]]からinventoryを作る。依存graphや実際のlink対象とは主張しない。
export function cargoComponents(bytes) {
  const text = bytes.toString("utf8");
  if (!/^version = [34]$/m.test(text)) throw new Error("Cargo lock v3/v4が必要です");
  const blocks = text.split(/^\[\[package\]\]\s*$/m).slice(1);
  if (!blocks.length) throw new Error("Cargo依存がありません");
  return blocks.map((block) => {
    const value = (key) => block.match(new RegExp(`^${key} = "([^"\\r\\n]+)"$`, "m"))?.[1];
    const name = value("name"), version = value("version"), source = value("source"), checksum = value("checksum");
    if (!name || !version || (source && source !== "registry+https://github.com/rust-lang/crates.io-index") || (source && !/^[a-f0-9]{64}$/.test(checksum ?? ""))) throw new Error("Cargo依存の公開registry・checksumが不正です");
    const purl = `pkg:cargo/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
    return { type: "library", name, version, purl, "bom-ref": purl, ...(checksum ? { hashes: [{ alg: "SHA-256", content: checksum }] } : {}) };
  });
}

export function createSbom(commit, locks) {
  if (!/^[a-f0-9]{40}$/.test(commit) || JSON.stringify(Object.keys(locks).sort()) !== JSON.stringify(lockfiles)) throw new Error("SBOMのcommit/lockfile集合が不正です");
  const components = new Map();
  for (const file of lockfiles) {
    for (const component of file.endsWith(".json") ? npmComponents(locks[file]) : cargoComponents(locks[file])) {
      const existing = components.get(component.purl);
      if (existing?.hashes && component.hashes && JSON.stringify(existing.hashes) !== JSON.stringify(component.hashes)) throw new Error("同一依存のchecksumが一致しません");
      components.set(component.purl, { ...existing, ...component });
    }
  }
  const bom = { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { component: { type: "application", name: "niho-photo", version: commit }, properties: [{ name: "niho:coverage", value: "All npm and Cargo lock entries, including development, optional and platform-specific dependencies; inventory, not a linked-binary dependency graph." }, ...lockfiles.map((file) => ({ name: "niho:lockfile", value: file }))] }, components: [...components.values()].sort((a, b) => a.purl.localeCompare(b.purl, "en")) };
  assertPublicBytes(jsonBytes(bom));
  return bom;
}

// schemaは使うJSON Schema keywordを限定。未知keywordは実装・schemaの乖離として拒否する。
export function validateSchema(value, schema, document = schema) {
  const supported = new Set(["$schema", "$id", "$defs", "$ref", "description", "type", "properties", "required", "additionalProperties", "items", "minItems", "uniqueItems", "pattern", "minimum", "minLength", "const", "enum"]);
  if (Object.keys(schema).some((key) => !supported.has(key))) throw new Error("未対応のschema keywordです");
  if (schema.$ref) {
    if (!/^#\/\$defs\/[A-Za-z]+$/.test(schema.$ref)) throw new Error("schema refが不正です");
    const target = document.$defs?.[schema.$ref.split("/").at(-1)];
    if (!target) throw new Error("schema refがありません");
    return validateSchema(value, target, document);
  }
  const fail = () => { throw new Error("release manifest schemaに一致しません"); };
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type && (schema.type === "integer" ? !Number.isSafeInteger(value) : kind !== schema.type)) fail();
  if (Object.hasOwn(schema, "const") && JSON.stringify(value) !== JSON.stringify(schema.const)) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (kind === "string" && ((schema.pattern && !new RegExp(schema.pattern).test(value)) || value.length < (schema.minLength ?? 0))) fail();
  if (kind === "number" && value < (schema.minimum ?? -Infinity)) fail();
  if (kind === "array") {
    if (value.length < (schema.minItems ?? 0) || (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length)) fail();
    if (schema.items) value.forEach((item) => validateSchema(item, schema.items, document));
  }
  if (kind === "object") {
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) fail();
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateSchema(item, schema.properties[key], document);
      else if (schema.additionalProperties === false) fail();
    }
  }
}

export function validateManifest(manifest, schema) {
  validateSchema(manifest, schema);
  const name = artifactName(manifest.commit, manifest.platform.arch);
  if (manifest.artifact.name !== `${name}.zip` || manifest.sbom.name !== `${name}.cdx.json` || JSON.stringify(manifest.locks.map((item) => item.path).sort()) !== JSON.stringify(lockfiles) || new Set(manifest.locks.map((item) => item.path)).size !== lockfiles.length) throw new Error("成果物名またはlockfile集合が不正です");
  const expected = [...contractFiles].sort();
  if (JSON.stringify(manifest.contracts.files.map((item) => item.path).sort()) !== JSON.stringify(expected)) throw new Error("contractファイル集合が不正です");
  assertPublicBytes(jsonBytes(manifest));
}

export function createManifest({ commit, tree, arch, runId, runAttempt, tools, locks, contracts, artifactBytes, sbomBytes, checkedFiles }) {
  const name = artifactName(commit, arch);
  const account = JSON.parse(contracts[contractFiles[0]]), cloud = JSON.parse(contracts[contractFiles[1]]), cases = JSON.parse(contracts[contractFiles[2]]), source = JSON.parse(contracts[contractFiles[3]]);
  if (account.version !== 2 || cloud.name !== "@niho/cloud-contract" || cloud.version !== "1.0.0" || cases.contractVersion !== "1" || source.repository !== "niho-coliving/niho-docs" || !/^[a-f0-9]{40}$/.test(source.commit)) throw new Error("contract pinの更新審査が必要です");
  return {
    schemaVersion: 1, repository: "niho-life/niho-photo", commit, tree,
    platform: { os: "macos", arch }, workflowRun: { id: runId, attempt: runAttempt },
    build: { mode: "release", signing: "ad-hoc", updaterArtifacts: false, officialUpdates: false, checkedFiles }, tools,
    locks: lockfiles.map((file) => ({ path: file, sha256: hash(locks[file]) })),
    contracts: { accountVersion: 2, cloudVersion: 1, cloudPackageVersion: "1.0.0", docsSourceCommit: source.commit, files: contractFiles.map((file) => ({ path: file, sha256: hash(contracts[file]) })) },
    artifact: { name: `${name}.zip`, sha256: hash(artifactBytes), bytes: artifactBytes.length }, sbom: { name: `${name}.cdx.json`, sha256: hash(sbomBytes), bytes: sbomBytes.length },
  };
}
