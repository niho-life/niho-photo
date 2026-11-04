import { describe, expect, it, vi } from "vitest";

import { cameraPhotoManifestUrl, createCameraPhotoMaskValidator, probeCameraPhotoRenderer } from "./camera-photo-renderer";

const proof = { sdkVersion: "14.0.0", crateVersion: "0.27.0", manifestSha256: "a".repeat(64), sdkSourceCommit: "b".repeat(40) };
const declaration = { schemaVersion: 1 as const, crateVersion: "0.27.0", settingsVersions: [9], engines: ["niho-14"], features: ["masks" as const], maskKinds: ["brush" as const], maskSurfaces: true };

describe("Camera bundled renderer proof", () => {
  it("accepts only the exact immutable alias on a known Tauri protocol and host", () => {
    expect(cameraPhotoManifestUrl(proof, { href: "http://tauri.localhost/index.html" }))
      .toBe(`http://tauri.localhost/develop-engine/${proof.manifestSha256}/manifest-0.27.0.json`);
    expect(cameraPhotoManifestUrl(proof, { href: "tauri://localhost/index.html" }))
      .toBe(`tauri://localhost/develop-engine/${proof.manifestSha256}/manifest-0.27.0.json`);
    expect(cameraPhotoManifestUrl(proof, { href: "file:///Applications/NIHO/index.html" })).toBeNull();
    expect(cameraPhotoManifestUrl(proof, { href: "https://tauri.localhost.evil.example/index.html" })).toBeNull();
  });

  it("publishes the actual declaration only after disposing the probe", async () => {
    const events: string[] = [];
    const result = await probeCameraPhotoRenderer({
      proof, signal: new AbortController().signal,
      location: { href: "http://tauri.localhost/index.html" },
      createEngine: () => ({
        ready: async () => { events.push("ready"); return true; },
        renderCapabilities: async () => { events.push("capability"); return declaration; },
        dispose: () => { events.push("dispose"); },
      }),
    });
    expect(events).toEqual(["ready", "capability", "dispose"]);
    expect(result?.capability).toMatchObject({ sdkVersion: "14.0.0", crateVersion: "0.27.0", engines: ["niho-14"] });
  });

  it("fails closed for a late abort or mismatched actual crate", async () => {
    const controller = new AbortController();
    const dispose = vi.fn();
    expect(await probeCameraPhotoRenderer({
      proof, signal: controller.signal, location: { href: "http://tauri.localhost/" },
      createEngine: () => ({ ready: async () => { controller.abort(); return true; }, renderCapabilities: async () => declaration, dispose }),
    })).toBeNull();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(await probeCameraPhotoRenderer({
      proof, signal: new AbortController().signal, location: { href: "http://tauri.localhost/" },
      createEngine: () => ({ ready: async () => true, renderCapabilities: async () => ({ ...declaration, crateVersion: "0.26.0" }), dispose() {} }),
    })).toBeNull();
  });
});

describe("Camera cloud mask validator", () => {
  it("requires a real SDK encode/decode round trip before admitting bitmap editing", async () => {
    const dispose = vi.fn();
    const encodeMaskSurface = vi.fn(async () => ({ id: "a".repeat(64), png: new Uint8Array([1]) }));
    const validateMaskSurface = vi.fn(async () => ({ id: "a".repeat(64), width: 1, height: 1 }));
    const validator = createCameraPhotoMaskValidator({
      engineAssets: { manifestUrl: () => "tauri://localhost/develop-engine/manifest.json" },
      createEngine: () => ({ ready: async () => true, encodeMaskSurface, validateMaskSurface, dispose }),
    });
    await expect(validator.ready(new AbortController().signal)).resolves.toBe(true);
    expect(encodeMaskSurface).toHaveBeenCalledWith(1, 1, new Uint8Array([0]));
    expect(validateMaskSurface).toHaveBeenCalledWith(new Uint8Array([1]));
    validator.dispose();
    validator.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps bitmap editing closed for a legacy runtime with no encoding API", async () => {
    const validator = createCameraPhotoMaskValidator({
      engineAssets: { manifestUrl: () => "tauri://localhost/develop-engine/manifest.json" },
      createEngine: () => ({ ready: async () => true, dispose() {} }),
    });
    await expect(validator.ready(new AbortController().signal)).resolves.toBe(false);
    validator.dispose();
  });

  it("lazily validates copied bytes through the bundled SDK and disposes its runtime", async () => {
    const validateMaskSurface = vi.fn(async (png: Uint8Array) => ({ id: "a".repeat(64), width: png[0]!, height: 1 }));
    const dispose = vi.fn();
    const createEngine = vi.fn(() => ({ ready: async () => true, validateMaskSurface, dispose }));
    const validator = createCameraPhotoMaskValidator({
      engineAssets: { manifestUrl: () => "tauri://localhost/develop-engine/manifest.json", preferNative: false },
      createEngine,
    });
    const bytes = new Uint8Array([2]);
    expect(createEngine).not.toHaveBeenCalled();
    await expect(validator.validateMaskSurface(bytes, new AbortController().signal)).resolves.toEqual({
      id: "a".repeat(64), width: 2, height: 1,
    });
    expect(createEngine).toHaveBeenCalledOnce();
    expect(validateMaskSurface).toHaveBeenCalledOnce();
    expect(bytes).toEqual(new Uint8Array([2]));
    validator.dispose();
    validator.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("stops waiting when the current identity scope is aborted", async () => {
    const validateMaskSurface = vi.fn(() => new Promise<{ id: string; width: number; height: number }>(() => undefined));
    const validator = createCameraPhotoMaskValidator({
      engineAssets: { manifestUrl: () => "tauri://localhost/develop-engine/manifest.json", preferNative: false },
      createEngine: () => ({ ready: async () => true, validateMaskSurface, dispose() {} }),
    });
    const controller = new AbortController();
    const pending = validator.validateMaskSurface(new Uint8Array([1]), controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(new DOMException("Aborted", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    validator.dispose();
  });
});
