import { describe, expect, it } from "vitest";

import { parseDevelopRendererCapabilities } from "./develop-renderer-capabilities";

const VALID = {
  schemaVersion: 1,
  crateVersion: "0.23.0",
  settingsVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  engines: ["niho-1", "niho-14"],
  features: ["geometry", "masks", "colorGradingLuminance"],
  maskKinds: ["linear", "radial", "brush", "subject", "sky"],
  maskSurfaces: true,
} as const;

describe("parseDevelopRendererCapabilities", () => {
  it("schema 1 の正確な宣言を deep clone/freeze する", () => {
    const source = {
      ...VALID,
      settingsVersions: [...VALID.settingsVersions],
      engines: [...VALID.engines],
      features: [...VALID.features],
      maskKinds: [...VALID.maskKinds],
    };
    const parsed = parseDevelopRendererCapabilities(source);
    expect(parsed).toEqual(VALID);
    expect(parsed).not.toBe(source);
    expect(parsed?.engines).not.toBe(source.engines);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.settingsVersions)).toBe(true);
    expect(Object.isFrozen(parsed?.engines)).toBe(true);
    expect(Object.isFrozen(parsed?.features)).toBe(true);
    expect(Object.isFrozen(parsed?.maskKinds)).toBe(true);
  });

  it.each([
    ["missing", (({ engines: _engines, ...value }) => value)(VALID)],
    ["unknown schema", { ...VALID, schemaVersion: 2 }],
    ["extra", { ...VALID, sdkVersion: "1" }],
    ["duplicate settings", { ...VALID, settingsVersions: [1, 1] }],
    ["unsafe settings", { ...VALID, settingsVersions: [Number.MAX_SAFE_INTEGER + 1] }],
    ["non-positive settings", { ...VALID, settingsVersions: [0] }],
    ["invalid semver", { ...VALID, crateVersion: "niho-develop 0.23.0" }],
    ["unknown feature", { ...VALID, features: ["geometry", "future"] }],
    ["duplicate feature", { ...VALID, features: ["geometry", "geometry"] }],
    ["mask kinds without masks feature", { ...VALID, features: ["geometry", "colorGradingLuminance"] }],
    ["unknown mask", { ...VALID, maskKinds: ["linear", "depth"] }],
    ["duplicate mask", { ...VALID, maskKinds: ["linear", "linear"] }],
    ["duplicate engine", { ...VALID, engines: ["niho-1", "niho-1"] }],
    ["invalid engine token", { ...VALID, engines: ["niho 1"] }],
    ["oversized engine token", { ...VALID, engines: [`n${"i".repeat(64)}`] }],
    ["oversized settings", { ...VALID, settingsVersions: Array.from({ length: 33 }, (_, index) => index + 1) }],
    ["oversized engines", { ...VALID, engines: Array.from({ length: 65 }, (_, index) => `niho-${index}`) }],
    ["oversized feature array", { ...VALID, features: ["geometry", "masks", "colorGradingLuminance", "geometry"] }],
    ["oversized string", { ...VALID, crateVersion: `1.0.0+${"a".repeat(64)}` }],
  ])("%s を拒否する", (_name, value) => {
    expect(parseDevelopRendererCapabilities(value)).toBeNull();
  });
});
