import type { PhotoStaticManifest } from "./types";
/** Runtime body is self-contained and tested as a classic worker; build embeds function source. */
export declare function installPhotoStaticWorker(scope: unknown, manifest: PhotoStaticManifest): void;
