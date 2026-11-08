import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const verifierManifest = path.join("scripts", "release", "updater-signature-verify", "Cargo.toml");

export function readPinnedUpdaterKey(root) {
  const config = JSON.parse(readFileSync(path.join(root, "apps/camera/src-tauri/tauri.conf.json"), "utf8"));
  const updater = config.plugins?.updater;
  const encodedKey = updater?.pubkey;
  if (typeof encodedKey !== "string" || updater.requireSignedVersion !== true) throw new Error("updater key configuration is invalid");

  const keyBytes = Buffer.from(encodedKey, "base64");
  if (keyBytes.toString("base64") !== encodedKey) throw new Error("updater key encoding is invalid");
  const publicKeyText = keyBytes.toString("utf8");
  if (!Buffer.from(publicKeyText, "utf8").equals(keyBytes)) throw new Error("updater public key is not UTF-8");
  const lines = publicKeyText.trimEnd().split(/\r?\n/u);
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment:") || !/^[A-Za-z0-9+/]{56}$/u.test(lines[1])) {
    throw new Error("updater public key is invalid");
  }

  return {
    publicKeyText,
    sha256: createHash("sha256").update(encodedKey).digest("hex"),
  };
}

export function verifyUpdaterArchiveSignature({ root, publicKeyText, archivePath, signaturePath, version }) {
  try {
    execFileSync("cargo", [
      "run", "--quiet", "--locked", "--manifest-path", verifierManifest, "--",
      publicKeyText, archivePath, signaturePath, version,
    ], {
      cwd: root,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
    });
  } catch {
    throw new Error("updater signature does not match the pinned key, archive, and version");
  }
}
