import { appDialog } from "niho-ui/app-dialog";
import {
  createBrowserPhotoSessionHost,
  type PhotoIdentity,
  type PhotoSessionHostBridge,
} from "../../../../packages/photo-cloud-session/src/index.ts";
import type { PhotoLibraryPresets } from "niho-photo-editing/library/photo-library";
import type { PhotoStaticBuildResult } from "../build/types.ts";
import { PHOTO_WEB_VIEW_COPY } from "../copy.ts";
import { mountPhotoWeb, type MountedPhotoWeb } from "./mount.tsx";
import { createPhotoWebConnectionFactory, type PhotoWebRevocationReason } from "./connection.ts";
import type { CreatePhotoWebRuntimeOptions } from "../runtime/types.ts";
import type { PhotoWebTransferCopy } from "../view/types.ts";
import type { PersonalPhotoCloudMemoryBudgets } from "@niho/photo-cloud-library";

export interface StartPhotoWebApplicationOptions {
  readonly rootElement: HTMLElement;
  readonly iconUrl: string;
  readonly enabled: boolean;
  /** Verified metadata returned by the static build factory used for this exact page. */
  readonly build: Pick<PhotoStaticBuildResult, "sdk">;
  /** The C00 preset owner is a mandatory runtime dependency. */
  readonly presets: PhotoLibraryPresets;
  /** Optional additional application cleanup; the shared durable journals are purged by the connection factory. */
  readonly clearRevokedScope?: (identity: PhotoIdentity, reason: PhotoWebRevocationReason) => void | Promise<void>;
  readonly memoryBudgets: PersonalPhotoCloudMemoryBudgets;
  readonly downloadBudget: CreatePhotoWebRuntimeOptions["downloadBudget"];
  /** Transfer controls stay hidden until the complete shared C00 copy is supplied. */
  readonly transferCopy?: PhotoWebTransferCopy;
  readonly sessionHost?: PhotoSessionHostBridge;
  /** Same-origin authentication and BFF requests only. */
  readonly fetch?: typeof fetch;
  /** Public object-storage upload transport; kept separate from the authenticated BFF fetch. */
  readonly providerFetch?: typeof fetch;
}

/** Official Web/PWA entry point. Deployment code supplies only accepted build and owner ports. */
export function startPhotoWebApplication(options: StartPhotoWebApplicationOptions): MountedPhotoWeb {
  if (typeof globalThis.location === "undefined" || globalThis.location.origin.length === 0) {
    throw new TypeError("Photo Web requires a browser origin");
  }
  const composition = createPhotoWebConnectionFactory({
    origin: globalThis.location.origin,
    rendererProof: {
      sdkVersion: options.build.sdk.sdkVersion,
      crateVersion: options.build.sdk.crateVersion,
      sourceCommit: options.build.sdk.sourceCommit,
      manifestSha256: options.build.sdk.manifestSha256,
      manifestUrl: options.build.sdk.manifestUrl,
    },
    presets: options.presets,
    memoryBudgets: options.memoryBudgets,
    ...(options.clearRevokedScope === undefined ? {} : { clearRevokedScope: options.clearRevokedScope }),
    ...(options.transferCopy === undefined ? {} : { transferCopy: options.transferCopy }),
    ...(options.fetch === undefined ? {} : { cloudFetch: options.fetch }),
    ...(options.providerFetch === undefined ? {} : { providerFetch: options.providerFetch }),
  });
  const sessionHost = options.sessionHost ?? createBrowserPhotoSessionHost(
    options.fetch === undefined ? {} : { fetch: options.fetch },
  );
  return mountPhotoWeb({
    rootElement: options.rootElement,
    iconUrl: options.iconUrl,
    copy: PHOTO_WEB_VIEW_COPY,
    runtimeOptions: {
      enabled: options.enabled,
      copy: PHOTO_WEB_VIEW_COPY,
      downloadBudget: options.downloadBudget,
      connect: composition.connect,
      guards: composition.guards,
      cancelDialogs: () => appDialog.cancelAll(),
      sessionHost,
    },
  });
}
