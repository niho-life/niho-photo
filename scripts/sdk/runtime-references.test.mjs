import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { rewriteVersionedRuntimeReferences } from "./build-develop-engine-runtime.mjs";

test("media producerのSDK契約は実native sourceのtool/decoderと一致する", () => {
  const source = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
  const api = source("packages/develop-engine/crates/niho-develop/src/api.rs");
  const swift = source("packages/develop-engine/tools/apple-raw-linear/Sources/apple-raw-linear/CLI.swift");
  const desktop = source("packages/desktop-photo/src/develop.rs");
  const match = (text, pattern) => {
    const value = pattern.exec(text)?.[1];
    assert.ok(value, "required source version is absent");
    return value;
  };
  assert.equal(match(api, /PERSONAL_MEDIA_PROVIDER_VERSION: &str = "([^"]+)"/u),
    match(swift, /static let version = "([^"]+)"/u));
  assert.equal(match(api, /PERSONAL_MEDIA_DECODER_VERSION: &str = "([^"]+)"/u),
    match(desktop, /const RASTER_DECODER_VERSION: &str = "([^"]+)"/u));
});

test("web glueの仮想module IDを保ち実ファイル参照だけを版指定する", () => {
  const input = Buffer.from([
    'const imports = { "./niho_develop_wasm_bg.js": import0 };',
    'module_or_path = new URL("niho_develop_wasm_bg.wasm", import.meta.url);',
    '/* @ts-self-types="./niho_develop_wasm.d.ts" */',
  ].join("\n"));
  const output = rewriteVersionedRuntimeReferences("niho_develop_wasm.js", input, "0.25.0").toString();
  assert.match(output, /"\.\/niho_develop_wasm_bg\.js": import0/u);
  assert.match(output, /new URL\("niho_develop_wasm_bg-0\.25\.0\.wasm"/u);
  assert.match(output, /niho_develop_wasm-0\.25\.0\.d\.ts/u);
});

test("仮想module IDと同名の外部JS参照は許可しない", () => {
  for (const reference of [
    'import("./niho_develop_wasm_bg.js")',
    'new URL("./niho_develop_wasm_bg.js", import.meta.url)',
  ]) {
    assert.throws(() => rewriteVersionedRuntimeReferences("niho_develop_wasm.js", Buffer.from(reference), "0.25.0"), /unversioned runtime/u);
  }
});
