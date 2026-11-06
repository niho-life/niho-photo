import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const DIST_DIRECTORY = path.join(APP_DIRECTORY, "dist");
const GENERATED_DIRECTORIES = ["web", "server", "static"];

async function cleanGeneratedBuilds() {
  let rootInfo;
  try {
    rootInfo = await lstat(DIST_DIRECTORY);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || await realpath(DIST_DIRECTORY) !== path.join(await realpath(APP_DIRECTORY), "dist")) {
    throw new Error("Photo Web build output directory is not a local directory");
  }
  for (const name of GENERATED_DIRECTORIES) {
    const target = path.join(DIST_DIRECTORY, name);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Photo Web generated output is not a local directory: ${name}`);
    }
    await rm(target, { recursive: true });
  }
}

cleanGeneratedBuilds().catch(() => {
  process.stderr.write("Photo Web generated output cleanup failed\n");
  process.exitCode = 1;
});
