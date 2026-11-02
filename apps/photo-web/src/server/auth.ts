import {
  createPhotoAuthService,
  type PhotoAuthService,
  type PhotoAuthServiceOptions,
} from "../../../../packages/photo-cloud-session/src/server/index.ts";

export interface PhotoWebAuthAdapterOptions extends Omit<PhotoAuthServiceOptions, "configuration"> {
  readonly enabled: boolean;
  readonly configuration?: unknown;
}

/**
 * Photo Web host boundary. Deployment remains closed until the private producer registration,
 * stable sessionEpoch DTO, endpoint map, and feature flag are accepted and supplied together.
 */
export function createPhotoWebAuthAdapter(options: PhotoWebAuthAdapterOptions): PhotoAuthService {
  const { enabled, configuration, ...dependencies } = options;
  return createPhotoAuthService({
    ...dependencies,
    configuration: enabled ? configuration : null,
  });
}

/** Safe runtime default for source builds and public CI: every operation fails closed with 503. */
export const photoWebAuth: PhotoAuthService = createPhotoWebAuthAdapter({ enabled: false });
