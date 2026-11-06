#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPhotoWebRelease } from "./release-lib.mjs";

export class PhotoWebReleaseCliError extends Error {}

function parseArguments(argv) {
  const allowed = new Set([
    "--input-dir", "--output-dir", "--source-sha", "--source-tree", "--tooling-commit",
    "--run-id", "--run-attempt", "--artifact-id", "--artifact-name", "--artifact-digest",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || values[key] !== undefined) throw new PhotoWebReleaseCliError("Photo Web release arguments are invalid");
    values[key] = value;
  }
  if ([...allowed].some((key) => !values[key])) throw new PhotoWebReleaseCliError("Photo Web release is missing a required argument");
  return values;
}

export function createPhotoWebReleaseFromArguments(values) {
  return createPhotoWebRelease({
    inputDirectory: values["--input-dir"],
    outputDirectory: values["--output-dir"],
    sourceSha: values["--source-sha"],
    sourceTree: values["--source-tree"],
    toolingCommit: values["--tooling-commit"],
    runId: values["--run-id"],
    runAttempt: values["--run-attempt"],
    artifact: { id: values["--artifact-id"], name: values["--artifact-name"], digest: values["--artifact-digest"] },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = createPhotoWebReleaseFromArguments(parseArguments(process.argv.slice(2)));
    console.log(`Photo Web data archive prepared (${result.manifest.archive.fileCount} files)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Photo Web release preparation failed");
    process.exitCode = 1;
  }
}
