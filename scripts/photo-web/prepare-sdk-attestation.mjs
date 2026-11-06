#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseManifest } from "../sdk/verify-release-artifact.mjs";
import {
  normalizeSdkAttestationOutput,
  sha256,
  validateSdkReceiptEvidence,
} from "./release-lib.mjs";

export class PhotoWebSdkProofError extends Error {}

function fail(message) {
  throw new PhotoWebSdkProofError(message);
}

export function parseArguments(argv) {
  const allowed = new Set(["--manifest", "--receipt", "--output"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || values[key] !== undefined) fail("SDK attestation proof arguments are invalid");
    values[key] = value;
  }
  if ([...allowed].some((key) => !values[key])) fail("SDK attestation proof is missing a required argument");
  return {
    manifestPath: values["--manifest"],
    receiptPath: values["--receipt"],
    outputPath: values["--output"],
  };
}

function readRegularFile(filePath, maximumBytes, label) {
  const absolute = path.resolve(filePath);
  const info = lstatSync(absolute, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) fail(`${label} must be a bounded regular file`);
  const bytes = readFileSync(absolute);
  if (bytes.length !== info.size) fail(`${label} changed while being read`);
  return { absolute, bytes };
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} is not UTF-8 JSON`); }
}

export function createSdkAttestationProof({ manifestPath, receiptPath, outputPath, runCli = execFileSync }) {
  const manifestFileInput = readRegularFile(manifestPath, 2 * 1024 * 1024, "SDK manifest");
  const receiptInput = readRegularFile(receiptPath, 2 * 1024 * 1024, "SDK release receipt");
  const output = path.resolve(outputPath);
  if (lstatSync(output, { throwIfNoEntry: false })) fail("SDK attestation proof output must not already exist");
  const manifest = validateReleaseManifest(parseJson(manifestFileInput.bytes, "SDK manifest"));
  const manifestFile = path.basename(manifestFileInput.absolute);
  if (manifestFile !== `niho-photo-sdk-${manifest.version}-${manifest.source.commit}.json`) fail("SDK manifest filename is inconsistent");
  const receipt = parseJson(receiptInput.bytes, "SDK release receipt");
  validateSdkReceiptEvidence(receipt, manifest, manifestFile, sha256(manifestFileInput.bytes));

  let stdout;
  try {
    stdout = runCli("gh", [
      "attestation", "verify", manifestFileInput.absolute,
      "--repo", "niho-life/niho-photo",
      "--signer-workflow", "niho-life/niho-photo/.github/workflows/photo-sdk-release.yml",
      "--format", "json",
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    fail("GitHub CLI could not verify the published SDK attestation");
  }
  const evidence = normalizeSdkAttestationOutput(parseJson(Buffer.from(String(stdout)), "GitHub SDK attestation result"),
    manifest, manifestFile, manifestFileInput.bytes, receipt);
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = createSdkAttestationProof(parseArguments(process.argv.slice(2)));
    console.log(`SDK Sigstore proof prepared (run ${result.runId}, attempt ${result.runAttempt})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "SDK Sigstore proof preparation failed");
    process.exitCode = 1;
  }
}
