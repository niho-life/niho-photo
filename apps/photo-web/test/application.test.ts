import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  connectionOptions: [] as unknown[],
  mountOptions: [] as unknown[],
  connect: vi.fn(),
  guards: Object.freeze({}),
  mounted: Object.freeze({ mounted: true }),
}));

vi.mock("niho-ui/app-dialog", () => ({ appDialog: { cancelAll: vi.fn() } }));
vi.mock("../src/browser/connection.ts", () => ({
  createPhotoWebConnectionFactory: (options: unknown) => {
    harness.connectionOptions.push(options);
    return { connect: harness.connect, guards: harness.guards };
  },
}));
vi.mock("../src/browser/mount.tsx", () => ({
  mountPhotoWeb: (options: unknown) => {
    harness.mountOptions.push(options);
    return harness.mounted;
  },
}));

import type { PhotoLibraryPresets } from "niho-photo-editing/library/photo-library";
import type { PhotoSessionHostBridge } from "@niho/photo-cloud-session";
import { startPhotoWebApplication } from "../src/browser/application.ts";

describe("Photo Web official application entry", () => {
  beforeEach(() => {
    harness.connectionOptions.length = 0;
    harness.mountOptions.length = 0;
    vi.stubGlobal("location", { origin: "https://photo.example.test" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps authenticated BFF and public uploader fetch ports separate", () => {
    const bffFetch: typeof fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const providerFetch: typeof fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const sessionHost = {} as PhotoSessionHostBridge;
    const rootElement = {} as HTMLElement;

    const mounted = startPhotoWebApplication({
      rootElement,
      iconUrl: "/icons/photo-512.png",
      enabled: true,
      build: {
        sdk: {
          sdkVersion: "0.1.9",
          crateVersion: "0.27.0",
          sourceCommit: "a".repeat(40),
          manifestSha256: "b".repeat(64),
          manifestUrl: "/develop-engine/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/manifest-0.27.0.json",
        },
      },
      presets: {} as PhotoLibraryPresets,
      clearRevokedScope: () => undefined,
      memoryBudgets: { originalBytes: 1024, workingCopyBytes: 1024, previewBytes: 1024 },
      downloadBudget: { maxBytes: 1024, maxEntries: 2 },
      sessionHost,
      fetch: bffFetch,
      providerFetch,
    });

    expect(mounted).toBe(harness.mounted);
    expect(harness.connectionOptions).toHaveLength(1);
    expect(harness.connectionOptions[0]).toMatchObject({
      origin: "https://photo.example.test",
      cloudFetch: bffFetch,
      providerFetch,
    });
    expect(harness.mountOptions).toHaveLength(1);
    expect(harness.mountOptions[0]).toMatchObject({ rootElement });
  });
});
