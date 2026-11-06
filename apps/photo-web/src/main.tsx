import type { PhotoLibraryPresets } from "niho-photo-editing/library/photo-library";
import { PHOTO_EDITING_PRESET_WRITE_ERROR } from "niho-photo-editing/photo-editing-copy";

import type { PhotoStaticBuildResult } from "./build/types.ts";
import { startPhotoWebApplication } from "./browser/application.ts";
import { PHOTO_WEB_TRANSFER_COPY } from "./copy.ts";
import "./styles.css";

declare const __PHOTO_WEB_SDK_VERSION__: unknown;
declare const __PHOTO_WEB_CRATE_VERSION__: unknown;
declare const __PHOTO_WEB_RUNTIME_MANIFEST_SHA256__: unknown;
declare const __PHOTO_WEB_SOURCE_COMMIT__: unknown;
declare const __PHOTO_WEB_MANIFEST_URL__: unknown;

const MIB = 1024 * 1024;
const RUNTIME_PATH = "/photo-runtime.json";
const RUNTIME_MAX_BYTES = 64;
const RUNTIME_TIMEOUT_MS = 3_000;
const PHOTO_ICON_URL = "/icons/photo-6b5a38eb49eced3de9ebf1a3b43ffe29b6d0efedfb80f7563bce96a0ddf3820b.png";

function compileValue(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

export function readPhotoWebCompileProof(): PhotoStaticBuildResult["sdk"] | null {
  const sdkVersion = compileValue(typeof __PHOTO_WEB_SDK_VERSION__ === "undefined" ? undefined : __PHOTO_WEB_SDK_VERSION__, 64);
  const crateVersion = compileValue(typeof __PHOTO_WEB_CRATE_VERSION__ === "undefined" ? undefined : __PHOTO_WEB_CRATE_VERSION__, 64);
  const manifestSha256 = compileValue(
    typeof __PHOTO_WEB_RUNTIME_MANIFEST_SHA256__ === "undefined" ? undefined : __PHOTO_WEB_RUNTIME_MANIFEST_SHA256__,
    64,
  );
  const sourceCommit = compileValue(typeof __PHOTO_WEB_SOURCE_COMMIT__ === "undefined" ? undefined : __PHOTO_WEB_SOURCE_COMMIT__, 40);
  const manifestUrl = compileValue(typeof __PHOTO_WEB_MANIFEST_URL__ === "undefined" ? undefined : __PHOTO_WEB_MANIFEST_URL__, 512);
  if (sdkVersion === null || crateVersion === null || manifestSha256 === null || sourceCommit === null || manifestUrl === null
    || !/^\d+\.\d+\.\d+$/.test(sdkVersion) || !/^\d+\.\d+\.\d+$/.test(crateVersion)
    || !/^[a-f0-9]{64}$/.test(manifestSha256) || !/^[a-f0-9]{40}$/.test(sourceCommit)) return null;
  let url: URL;
  try { url = new URL(manifestUrl, globalThis.location.origin); } catch { return null; }
  if (url.origin !== globalThis.location.origin || url.username || url.password || url.search || url.hash
    || url.pathname !== `/develop-engine/${manifestSha256}/manifest-${crateVersion}.json`) return null;
  return Object.freeze({ sdkVersion, crateVersion, sourceCommit, manifestSha256, manifestUrl: url.pathname });
}

async function readBoundedText(response: Response, signal: AbortSignal): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RUNTIME_MAX_BYTES)) return null;
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) return null;
      const item = await reader.read();
      if (item.done) break;
      if (!ArrayBuffer.isView(item.value) || item.value.byteLength === 0) continue;
      const chunk = new Uint8Array(item.value.buffer, item.value.byteOffset, item.value.byteLength);
      total += chunk.byteLength;
      if (total > RUNTIME_MAX_BYTES) return null;
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  } finally {
    try { await reader.cancel(); } catch { /* Response ownership ends here. */ }
  }
}

export async function readPhotoWebCloudAdmission(fetchFn: typeof fetch = globalThis.fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_TIMEOUT_MS);
  try {
    const url = new URL(RUNTIME_PATH, globalThis.location.origin);
    if (url.origin !== globalThis.location.origin || url.pathname !== RUNTIME_PATH) return false;
    const response = await fetchFn(url.href, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok || response.status !== 200 || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return false;
    const text = await readBoundedText(response, controller.signal);
    if (text === null) return false;
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && Object.keys(value).length === 1 && Object.hasOwn(value, "cloudEnabled")
      && (value as { readonly cloudEnabled?: unknown }).cloudEnabled === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function rejectedPresetMutation(): Promise<never> {
  return Promise.reject(new Error(PHOTO_EDITING_PRESET_WRITE_ERROR));
}

export const PHOTO_WEB_READ_ONLY_PRESETS: PhotoLibraryPresets = Object.freeze({
  readOnly: true,
  list: async () => [],
  create: rejectedPresetMutation,
  rename: rejectedPresetMutation,
  delete: rejectedPresetMutation,
  nameMaxChars: 100,
  xmpMaxBytes: 512 * 1024,
  describeError: (_error, fallback) => fallback,
  isNameTaken: () => false,
});

export async function startPhotoWebMain(rootElement: HTMLElement): Promise<void> {
  const proof = readPhotoWebCompileProof();
  const enabled = proof !== null && await readPhotoWebCloudAdmission();
  const build: Pick<PhotoStaticBuildResult, "sdk"> = {
    sdk: proof ?? { sdkVersion: "", crateVersion: "", sourceCommit: "", manifestSha256: "", manifestUrl: "" },
  };
  startPhotoWebApplication({
    rootElement,
    iconUrl: PHOTO_ICON_URL,
    enabled,
    build,
    presets: PHOTO_WEB_READ_ONLY_PRESETS,
    memoryBudgets: {
      originalBytes: 200 * MIB * 3,
      workingCopyBytes: 32 * MIB * 2,
      previewBytes: 32 * MIB,
    },
    downloadBudget: { maxBytes: 200 * MIB, maxEntries: 1 },
    transferCopy: PHOTO_WEB_TRANSFER_COPY,
  });
}

const root = document.getElementById("root");
if (root !== null) void startPhotoWebMain(root);
