import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  NIHO_PRODUCTION_ORIGIN,
  PHOTO_AUDIENCE,
  PHOTO_CALLBACK_PATH,
  PHOTO_WEB_CLIENT_ID,
  PHOTO_WEB_ORIGIN,
  createPhotoAuthService,
} from "@niho/photo-cloud-session/server";
import {
  PERSONAL_PHOTO_CLOUD_HOST_LIMITS,
  createPendingInviteHandler,
  createPersonalPhotoCloudProxy,
} from "@niho/photo-cloud-library/server";

import type { PhotoStaticBuildResult } from "../build/types.ts";
import { PHOTO_WEB_NAVIGATION_ERROR_COPY, PHOTO_WEB_SERVER_AUTH_COPY } from "../copy.ts";
import { createPhotoWebFetchHost } from "./fetch-host.ts";
import { createPhotoWebNodeServer } from "./node-server.ts";
import {
  chainPhotoWebCloudHandlers,
  readPhotoWebPendingInviteConfiguration,
  type PhotoWebPendingInviteConfiguration,
} from "./pending-invite-config.ts";
import { loadRetainedPhotoWebStaticStore } from "./static-store.ts";
import type { LoadPhotoWebStaticStoreOptions } from "./types.ts";

const CURRENT_STATIC_DIRECTORY = process.env.PHOTO_WEB_STATIC_DIRECTORY ?? "/app/static";
const ACCEPTED_PRIOR_DIRECTORY = process.env.PHOTO_WEB_ACCEPTED_PRIOR_DIRECTORY ?? "/app/accepted-prior";
const BUILD_FILE = "photo-build.json";
const MAX_BUILD_BYTES = 256 * 1024;
const SAFE_RELEASE_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const AUTH_ENDPOINTS = Object.freeze({
  begin: "/api/auth/photo-connect/begin",
  confirmation: "/api/auth/photo-connect/request",
  exchange: "/api/auth/photo-connect/exchange",
  introspect: "/api/auth/photo-connect/introspect",
  refresh: "/api/auth/photo-connect/refresh",
  revoke: "/api/auth/photo-connect/revoke",
  cancel: "/api/auth/photo-connect/cancel",
});
const CLOUD_API_PREFIX = "/api/me/photo-cloud/v2";

export const PHOTO_WEB_DOCUMENT_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob: data:; connect-src 'self' https://storage.googleapis.com; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://niho.life",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

async function readBuild(directory: string): Promise<PhotoStaticBuildResult> {
  const file = path.join(directory, BUILD_FILE);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_BUILD_BYTES) {
    throw new Error("Photo Web build metadata is unavailable");
  }
  const bytes = await readFile(file);
  if (bytes.byteLength !== info.size) throw new Error("Photo Web build metadata changed");
  return JSON.parse(bytes.toString("utf8")) as PhotoStaticBuildResult;
}

async function acceptedPriorStores(root: string): Promise<readonly LoadPhotoWebStaticStoreOptions[]> {
  let canonicalRoot: string;
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid prior root");
    canonicalRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = (await readdir(canonicalRoot)).sort((left, right) => left.localeCompare(right, "en"));
  const stores: LoadPhotoWebStaticStoreOptions[] = [];
  for (const name of names) {
    if (!SAFE_RELEASE_DIRECTORY.test(name)) throw new Error("Invalid accepted prior release directory");
    const release = path.join(canonicalRoot, name);
    const info = await lstat(release);
    const canonical = await realpath(release);
    if (!info.isDirectory() || info.isSymbolicLink() || canonical !== release) {
      throw new Error("Invalid accepted prior release directory");
    }
    const directory = path.join(release, "static");
    stores.push(Object.freeze({ directory, build: await readBuild(directory) }));
  }
  return Object.freeze(stores);
}

export async function createPhotoWebProductionServer(options: {
  readonly currentDirectory: string;
  readonly acceptedPrior?: readonly LoadPhotoWebStaticStoreOptions[];
  readonly cloudEnabled: boolean;
  /** Private ops configuration of the pending-invite cookie; without it those routes are not mounted. */
  readonly pendingInvite?: PhotoWebPendingInviteConfiguration | null;
  readonly fetch?: typeof fetch;
}) {
  const current = Object.freeze({ directory: options.currentDirectory, build: await readBuild(options.currentDirectory) });
  const staticStore = await loadRetainedPhotoWebStaticStore({
    current,
    ...(options.acceptedPrior === undefined ? {} : { acceptedPrior: options.acceptedPrior }),
  });
  const auth = createPhotoAuthService({
    configuration: options.cloudEnabled ? {
      enabled: true,
      photoOrigin: PHOTO_WEB_ORIGIN,
      nihoOrigin: NIHO_PRODUCTION_ORIGIN,
      clientId: PHOTO_WEB_CLIENT_ID,
      audience: PHOTO_AUDIENCE,
      callbackPath: PHOTO_CALLBACK_PATH,
      endpoints: AUTH_ENDPOINTS,
      copy: PHOTO_WEB_SERVER_AUTH_COPY,
    } : null,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const personalCloud = options.cloudEnabled ? createPersonalPhotoCloudProxy({
    authService: auth,
    upstreamOrigin: NIHO_PRODUCTION_ORIGIN,
    upstreamPathPrefix: CLOUD_API_PREFIX,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }) : undefined;
  const pendingInvite = options.cloudEnabled && options.pendingInvite ? createPendingInviteHandler({
    photoOrigin: PHOTO_WEB_ORIGIN,
    authService: auth,
    upstreamOrigin: NIHO_PRODUCTION_ORIGIN,
    upstreamPathPrefix: options.pendingInvite.upstreamPathPrefix,
    keys: options.pendingInvite.keys,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }) : undefined;
  const cloudHandler = personalCloud !== undefined && pendingInvite !== undefined
    ? chainPhotoWebCloudHandlers(pendingInvite, personalCloud)
    : personalCloud;
  const handler = createPhotoWebFetchHost({
    enabled: true,
    cloudEnabled: options.cloudEnabled,
    origin: PHOTO_WEB_ORIGIN,
    auth,
    staticStore,
    ...(cloudHandler === undefined ? {} : { cloudHandler }),
    documentHeaders: PHOTO_WEB_DOCUMENT_HEADERS,
    navigationErrorCopy: PHOTO_WEB_NAVIGATION_ERROR_COPY,
  });
  return createPhotoWebNodeServer({
    enabled: true,
    origin: PHOTO_WEB_ORIGIN,
    handler,
    limits: {
      maxActiveRequests: 16,
      maxRequestBytes: 5 * 1024 * 1024,
      maxResponseBytes: PERSONAL_PHOTO_CLOUD_HOST_LIMITS.maxResponseBytes,
      requestTimeoutMs: PERSONAL_PHOTO_CLOUD_HOST_LIMITS.requestTimeoutMs,
    },
  });
}

async function start(): Promise<void> {
  if (process.env.PORT !== undefined && process.env.PORT !== "8080") {
    throw new Error("Photo Web PORT must be 8080");
  }
  const cloudEnabled = process.env.PHOTO_WEB_CLOUD_ENABLED === "true";
  const pendingInvite = cloudEnabled ? readPhotoWebPendingInviteConfiguration(process.env) : null;
  const acceptedPrior = await acceptedPriorStores(ACCEPTED_PRIOR_DIRECTORY);
  const server = await createPhotoWebProductionServer({
    currentDirectory: CURRENT_STATIC_DIRECTORY,
    acceptedPrior,
    cloudEnabled,
    pendingInvite,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(8080, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

void start().catch((error: unknown) => {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "startup_failed";
  process.stderr.write(`Photo Web startup failed (${code})\n`);
  process.exitCode = 1;
});
