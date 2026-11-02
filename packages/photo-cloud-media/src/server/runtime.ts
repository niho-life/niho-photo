import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RenderCapability } from "../../../photo-library-contract/src/v2.ts";
import { CloudMediaError } from "../types.ts";
import baseline from "../../sdk-baseline.json" with { type: "json" };
import contractFiles from "../../contract-files.json" with { type: "json" };

const SHA256 = /^[a-f0-9]{64}$/;
const GLUE = `niho_develop_wasm-${baseline.engine.crateVersion}.js`;
const WASM = `niho_develop_wasm_bg-${baseline.engine.crateVersion}.wasm`;

export interface ContractRuntime {
  supportsDevelopSettingsWrite(value: unknown): boolean;
  readDevelopSettings(value: unknown): Record<string, unknown> | null;
  isEditableDevelopSettings(value: unknown): boolean;
  developSettingsOnWorkingCopy(value: Record<string, unknown> | null, baseVersion: string, meta?: unknown): Record<string, unknown>;
}

export interface DevelopRuntime {
  initSync(input: { readonly module: Uint8Array }): unknown;
  capabilities(): string;
  imageSize(bytes: Uint8Array): unknown;
  validateSettings(settings: string): string;
  version(): string;
  Developer: {
    new(bytes: Uint8Array, maxDimension: number): DevelopInstance;
    openWorkingCopy(bytes: Uint8Array, metaJson: string): DevelopInstance;
  };
}

export interface DevelopInstance {
  readonly width: number;
  readonly height: number;
  exportPng(settings: string, maxDimension: number): Uint8Array;
  setMaskSurface(id: string, bytes: Uint8Array): void;
  hasMaskSurface(id: string): boolean;
  free(): void;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Pure byte verifier used by negative tests without mutating installed packages. */
export function verifyExactBytes(bytes: Uint8Array, expected: { readonly sha256: string; readonly sizeBytes: number }): boolean {
  return Number.isSafeInteger(expected.sizeBytes) && expected.sizeBytes >= 0 && SHA256.test(expected.sha256)
    && bytes.byteLength === expected.sizeBytes && sha256(bytes) === expected.sha256;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

let contractPromise: Promise<ContractRuntime> | undefined;
export function loadVerifiedContract(): Promise<ContractRuntime> {
  contractPromise ??= (async () => {
    try {
      const packageUrl = new URL(import.meta.resolve("niho-photo-contract/package.json"));
      const packageJson: unknown = JSON.parse((await readFile(packageUrl)).toString("utf8"));
      if (!record(packageJson) || packageJson.version !== contractFiles.sdkVersion
        || contractFiles.sdkVersion !== baseline.releaseTag.slice("photo-sdk-v".length)
        || contractFiles.sourceCommit !== baseline.sourceCommit || !SHA256.test(contractFiles.packageSha256)) throw new Error();
      const root = new URL("./", packageUrl);
      for (const expected of contractFiles.files) {
        const bytes = await readFile(new URL(expected.path, root));
        if (!verifyExactBytes(bytes, { sha256: expected.sha256, sizeBytes: expected.sizeBytes })) throw new Error();
      }
      return await import("niho-photo-contract") as unknown as ContractRuntime;
    } catch {
      throw new CloudMediaError("renderer_unavailable");
    }
  })();
  return contractPromise;
}

type ManifestFile = { readonly sha256: string; readonly bytes: number };
type RuntimeManifest = {
  readonly schemaVersion: number;
  readonly engine: string;
  readonly version: string;
  readonly source: { readonly repository: string; readonly commit: string };
  readonly files: Readonly<Record<string, ManifestFile>>;
};

let runtimePromise: Promise<{ readonly runtime: DevelopRuntime; readonly renderer: RenderCapability }> | undefined;
export function loadVerifiedDevelopRuntime(): Promise<{ readonly runtime: DevelopRuntime; readonly renderer: RenderCapability }> {
  runtimePromise ??= (async () => {
    try {
      const manifestUrl = new URL(import.meta.resolve("niho-photo-develop-engine-runtime/manifest"));
      const packageUrl = new URL("../../package.json", manifestUrl);
      const packageJson: unknown = JSON.parse((await readFile(packageUrl)).toString("utf8"));
      const sdkVersion = baseline.releaseTag.slice("photo-sdk-v".length);
      if (!record(packageJson) || packageJson.version !== sdkVersion) throw new Error();
      const manifestBytes = await readFile(manifestUrl);
      if (!verifyExactBytes(manifestBytes, {
        sha256: baseline.engine.manifest.sha256,
        sizeBytes: baseline.engine.manifest.size,
      })) throw new Error();
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as RuntimeManifest;
      if (manifest.schemaVersion !== 1 || manifest.engine !== baseline.engine.version
        || manifest.version !== baseline.engine.crateVersion || manifest.source.repository !== baseline.repository
        || manifest.source.commit !== baseline.sourceCommit) throw new Error();
      const glueExpected = manifest.files[GLUE];
      const wasmExpected = manifest.files[WASM];
      if (!glueExpected || !wasmExpected) throw new Error();
      const glueSpecifier = `niho-photo-develop-engine-runtime/${GLUE}`;
      const wasmSpecifier = `niho-photo-develop-engine-runtime/${WASM}`;
      const [glueBytes, wasmBytes] = await Promise.all([
        readFile(new URL(import.meta.resolve(glueSpecifier))),
        readFile(new URL(import.meta.resolve(wasmSpecifier))),
      ]);
      if (!verifyExactBytes(glueBytes, { sha256: glueExpected.sha256, sizeBytes: glueExpected.bytes })
        || !verifyExactBytes(wasmBytes, { sha256: wasmExpected.sha256, sizeBytes: wasmExpected.bytes })) throw new Error();
      const runtime = await import(glueSpecifier) as unknown as DevelopRuntime;
      runtime.initSync({ module: wasmBytes });
      if (runtime.version() !== `niho-develop ${baseline.engine.crateVersion} (engine ${baseline.engine.version})`) throw new Error();
      const rawCapabilities: unknown = JSON.parse(runtime.capabilities());
      if (!record(rawCapabilities) || !record(rawCapabilities.masks) || !Array.isArray(rawCapabilities.masks.kinds)
        || rawCapabilities.masks.surfaces !== true) throw new Error();
      const maskKinds = rawCapabilities.masks.kinds.filter((kind): kind is string => typeof kind === "string");
      const renderer: RenderCapability = Object.freeze({
        sdkVersion,
        crateVersion: baseline.engine.crateVersion,
        manifestSha256: baseline.engine.manifest.sha256,
        settingsVersions: Object.freeze([...baseline.recipeCompatibility.supportedVersions]),
        engines: Object.freeze([...baseline.recipeCompatibility.engineIdentifiers]),
        features: Object.freeze(["geometry", "masks"]),
        maskKinds: Object.freeze(maskKinds),
        maskSurfaces: true,
      });
      return { runtime, renderer };
    } catch {
      throw new CloudMediaError("renderer_unavailable");
    }
  })();
  return runtimePromise;
}
