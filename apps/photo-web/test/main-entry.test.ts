import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PHOTO_WEB_READ_ONLY_PRESETS,
  readPhotoWebCloudAdmission,
  readPhotoWebCompileProof,
} from "../src/main.tsx";

const sha = "a".repeat(64);
const commit = "b".repeat(40);

function setProof(overrides: Readonly<Record<string, unknown>> = {}): void {
  vi.stubGlobal("__PHOTO_WEB_SDK_VERSION__", "0.2.0");
  vi.stubGlobal("__PHOTO_WEB_CRATE_VERSION__", "0.27.0");
  vi.stubGlobal("__PHOTO_WEB_RUNTIME_MANIFEST_SHA256__", sha);
  vi.stubGlobal("__PHOTO_WEB_SOURCE_COMMIT__", commit);
  vi.stubGlobal("__PHOTO_WEB_MANIFEST_URL__", `/develop-engine/${sha}/manifest-0.27.0.json`);
  for (const [name, value] of Object.entries(overrides)) vi.stubGlobal(name, value);
}

afterEach(() => vi.unstubAllGlobals());

describe("Photo Web main entry", () => {
  it("fails closed without a complete compile-time SDK proof and preserves every proof field", () => {
    expect(readPhotoWebCompileProof()).toBeNull();
    setProof();
    expect(readPhotoWebCompileProof()).toEqual({
      sdkVersion: "0.2.0",
      crateVersion: "0.27.0",
      sourceCommit: commit,
      manifestSha256: sha,
      manifestUrl: `/develop-engine/${sha}/manifest-0.27.0.json`,
    });
    setProof({ __PHOTO_WEB_RUNTIME_MANIFEST_SHA256__: "c".repeat(64) });
    expect(readPhotoWebCompileProof()).toBeNull();
  });

  it("admits only exact strict-boolean runtime JSON and requests it without cache", async () => {
    const accepted = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ method: "GET", cache: "no-store", credentials: "omit", redirect: "error" });
      return new Response('{"cloudEnabled":true}\n', {
        headers: { "Content-Type": "application/json", "Content-Length": "22", "Cache-Control": "no-store" },
      });
    });
    await expect(readPhotoWebCloudAdmission(accepted)).resolves.toBe(true);
    for (const body of [
      '{"cloudEnabled":false}\n',
      '{"cloudEnabled":"true"}\n',
      '{"cloudEnabled":true,"configUrl":"/private"}\n',
      "true\n",
      "not-json",
    ]) {
      await expect(readPhotoWebCloudAdmission(async () => new Response(body, {
        headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(body).byteLength) },
      }))).resolves.toBe(false);
    }
  });

  it("provides a real read-only presets port and rejects every mutation", async () => {
    await expect(PHOTO_WEB_READ_ONLY_PRESETS.list()).resolves.toEqual([]);
    expect(PHOTO_WEB_READ_ONLY_PRESETS.readOnly).toBe(true);
    expect(PHOTO_WEB_READ_ONLY_PRESETS.nameMaxChars).toBe(100);
    expect(PHOTO_WEB_READ_ONLY_PRESETS.xmpMaxBytes).toBe(512 * 1024);
    await expect(PHOTO_WEB_READ_ONLY_PRESETS.create({ name: "x", xmp: "x" })).rejects.toThrow();
    await expect(PHOTO_WEB_READ_ONLY_PRESETS.rename("x", "y")).rejects.toThrow();
    await expect(PHOTO_WEB_READ_ONLY_PRESETS.delete("x")).rejects.toThrow();
  });
});
