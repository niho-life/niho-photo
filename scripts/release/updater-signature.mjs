import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

export function decodeUpdaterSignature(signatureText) {
  const encoded = signatureText.trim();
  const bytes = Buffer.from(encoded, "base64");
  const decoded = bytes.toString("utf8");
  if (!encoded || bytes.toString("base64") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes)) {
    throw new Error("Tauri updater signature must be canonical Base64 UTF-8");
  }
  return decoded;
}

export function verifyUpdaterArchiveSignature({ root, publicKeyText, archivePath, signaturePath, version }) {
  let temporary;
  try {
    const metadata = lstatSync(signaturePath);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 16 * 1024) throw new Error("invalid signature file");
    const signatureBytes = readFileSync(signaturePath);
    if (signatureBytes.length !== metadata.size) throw new Error("signature file changed");
    const signatureText = decodeUpdaterSignature(signatureBytes.toString("utf8"));
    temporary = mkdtempSync(path.join(tmpdir(), "niho-photo-minisign-"));
    const decodedSignaturePath = path.join(temporary, "signature.minisig");
    writeFileSync(decodedSignaturePath, signatureText, { flag: "wx", mode: 0o600 });
    execFileSync("cargo", [
      "run", "--quiet", "--locked", "--manifest-path", verifierManifest, "--",
      publicKeyText, archivePath, decodedSignaturePath, version,
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
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
