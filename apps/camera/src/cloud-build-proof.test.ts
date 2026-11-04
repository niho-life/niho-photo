import { describe, expect, it } from "vitest";

import { parsePhotoCloudBuildProof, readPhotoCloudBuildProof } from "./cloud-build-proof";

const proof = { sdkVersion: "0.1.9", crateVersion: "0.27.0", manifestSha256: "a".repeat(64), sdkSourceCommit: "b".repeat(40) };

describe("cloud build proof", () => {
  it("keeps development cloud closed without an official declaration", () => {
    expect(readPhotoCloudBuildProof()).toBeNull();
  });
  it("retains exact verified runtime and SDK source identity", () => {
    expect(parsePhotoCloudBuildProof(proof)).toEqual(proof);
    expect(Object.isFrozen(parsePhotoCloudBuildProof(proof))).toBe(true);
  });
  it.each([null, { ...proof, manifestSha256: "niho-14" }, { ...proof, sdkSourceCommit: "main" },
    { ...proof, credential: "unexpected" }, { ...proof, sdkVersion: "0.1.9/other" }])(
    "rejects an incomplete or ambiguous declaration", (value) => {
      expect(parsePhotoCloudBuildProof(value)).toBeNull();
    },
  );
});
