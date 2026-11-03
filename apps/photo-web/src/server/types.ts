import type { PhotoAuthService } from "../../../../packages/photo-cloud-session/src/server/service.ts";
import type { PhotoStaticBuildResult } from "../build/types.ts";

export interface LoadPhotoWebStaticStoreOptions {
  /** Trusted C06 generator output directory, never a value derived from Request.url. */
  readonly directory: string;
  /** Trusted in-process result returned by preparePhotoStaticBundle. */
  readonly build: PhotoStaticBuildResult;
}

export interface PhotoWebStaticStore {
  /** Deep-frozen, public-only snapshot. It never exposes the caller's build object. */
  readonly build: PhotoStaticBuildResult;
  get(path: string, head?: boolean): Response | null;
}

export interface PhotoWebNavigationErrorCopy {
  readonly title: string;
  readonly message: string;
  readonly homeLabel: string;
}

export type PhotoWebCloudHandler = (request: Request) => Promise<Response | null>;

export interface PhotoWebFetchHostOptions {
  readonly enabled: boolean;
  /**
   * Trusted C08 configuration: one exact public HTTPS origin, including its explicit port.
   * C06 does not read process.env or infer proxy/forwarded-host configuration.
   */
  readonly origin: string;
  /** Existing C01 implementation is the only credential/session consumer. */
  readonly auth: PhotoAuthService;
  readonly staticStore: PhotoWebStaticStore;
  /** Trusted C02 route port. It receives the original Request and returns null for unknown routes. */
  readonly cloudHandler?: PhotoWebCloudHandler;
  /** Trusted C08 anonymous-document security policy; an enforced CSP is mandatory. */
  readonly documentHeaders: Readonly<Record<string, string>>;
  readonly navigationErrorCopy: PhotoWebNavigationErrorCopy;
}
