import path from "node:path";
import { fileURLToPath } from "node:url";

import { PHOTO_WEB_APPLICATION_COPY, PHOTO_WEB_OFFLINE_COPY } from "../src/copy.ts";
import { preparePhotoStaticBundle } from "../src/build/static-bundle.ts";

const APP_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_DIRECTORY = fileURLToPath(new URL("../../../", import.meta.url));

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1) throw new Error("usage: prepare-static.mts [output-directory]");
  const outputDirectory = path.resolve(arguments_[0] ?? path.join(APP_DIRECTORY, "dist/static"));
  const build = await preparePhotoStaticBundle({
    builtWebDirectory: path.join(APP_DIRECTORY, "dist/web"),
    outputDirectory,
    sdkPackageDirectory: path.join(REPOSITORY_DIRECTORY, "node_modules/niho-photo-develop-engine-runtime"),
    offlineCopy: PHOTO_WEB_OFFLINE_COPY,
    applicationCopy: PHOTO_WEB_APPLICATION_COPY,
  });
  process.stdout.write(`${build.buildId}\n`);
}

main().catch((error: unknown) => {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "io_failure";
  process.stderr.write(`Photo Web static build failed (${code})\n`);
  process.exitCode = 1;
});
