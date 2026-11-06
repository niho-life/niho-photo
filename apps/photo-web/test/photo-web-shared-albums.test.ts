import { describe, expect, it } from "vitest";

import { photoWebInviteUrl, photoWebOriginalsNote, takePhotoWebInviteSecret } from "../src/browser/shared-albums";

function at(url: string) {
  const location = new URL(url) as unknown as Location;
  const calls: string[] = [];
  const history = { state: null, replaceState: (_state: unknown, _title: string, next: string) => { calls.push(next); } } as unknown as History;
  return { target: { location, history }, calls };
}

describe("Photo Web invite links (B08)", () => {
  it("puts the secret in the fragment, which never reaches the server", () => {
    const url = photoWebInviteUrl("https://photo.example.test", "synthetic-invite-secret-value");
    expect(url).toBe("https://photo.example.test/#invite=synthetic-invite-secret-value");
    expect(new URL(url).pathname).toBe("/");
    expect(new URL(url).search).toBe("");
  });

  it("reads the secret once and removes it from the address bar", () => {
    const { target, calls } = at("https://photo.example.test/#invite=synthetic-invite-secret-value");
    expect(takePhotoWebInviteSecret(target)).toBe("synthetic-invite-secret-value");
    expect(calls).toEqual(["/"]);
  });

  it("ignores other fragments and refuses malformed secrets (still removing them)", () => {
    expect(takePhotoWebInviteSecret(at("https://photo.example.test/#photos").target)).toBeNull();
    const bad = at("https://photo.example.test/#invite=%3Cscript%3E");
    expect(takePhotoWebInviteSecret(bad.target)).toBeNull();
    expect(bad.calls).toEqual(["/"]);
  });

  it("remembers the originals note per actor without writing the user ID", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as unknown as Storage;
    const note = photoWebOriginalsNote("synthetic-user-1", storage);
    expect(note.shown()).toBe(false);
    note.markShown();
    expect(photoWebOriginalsNote("synthetic-user-1", storage).shown()).toBe(true);
    expect(photoWebOriginalsNote("synthetic-user-2", storage).shown()).toBe(false);
    expect([...values.keys()].join()).not.toContain("synthetic-user");
  });
});
