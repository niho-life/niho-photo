import { describe, expect, it, vi } from "vitest";

import { cameraPhotoManifestUrl, probeCameraPhotoRenderer } from "./camera-photo-renderer";

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
