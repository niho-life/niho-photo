/**
 * Same-origin client for render jobs on the signed-in user's own device (B07 #248), on the shared-album HTTP core: the
 * verified-session scope fence, capture headers, header deadline and bounded JSON. It never retries by itself; the
 * executor replays lost answers with the same key.
 */
import {
  createSharingClientOnTransport,
  createSharingHttpClient,
  type CreateSharingHttpClientOptions,
  type SharingTransport,
} from "../sharing/sharing-http";

import type { RenderExecutorOperation } from "./contract";
import type { RenderExecutorTransport } from "./render-executor";
import { encodeRenderJobRequest, isRenderJobOperation, renderJobResponseLimit, validateRenderJobResponse } from "./render-wire";

export interface RenderJobClient extends RenderExecutorTransport {
  dispose(): void;
}

/** Same render-job wire over an already authenticated native session (for example the Mac bearer transport). */
export function createRenderJobClientOnTransport(transport: SharingTransport): RenderJobClient {
  const core = createSharingClientOnTransport<RenderExecutorOperation>(transport, {
    supports: isRenderJobOperation,
    encode: encodeRenderJobRequest,
    responseLimit: renderJobResponseLimit,
    validate: (operation, request, raw) => validateRenderJobResponse(operation, request as never, raw),
  });
  return {
    async request(operation, request, requestOptions) {
      const key = "idempotencyKey" in requestOptions ? (requestOptions as { readonly idempotencyKey: string }).idempotencyKey : undefined;
      return (await core.send(operation, request, requestOptions.signal, key)) as never;
    },
    dispose: () => core.dispose(),
  };
}

/** Same-origin browser client for a signed-in browser session. */
export function createBrowserRenderJobClient(options: CreateSharingHttpClientOptions): RenderJobClient {
  const transport = createSharingHttpClient<RenderExecutorOperation>(options, {
    supports: isRenderJobOperation,
    encode: encodeRenderJobRequest,
    responseLimit: renderJobResponseLimit,
    validate: (operation, request, raw) => validateRenderJobResponse(operation, request as never, raw),
  });
  return {
    async request(operation, request, requestOptions) {
      const key = "idempotencyKey" in requestOptions ? (requestOptions as { readonly idempotencyKey: string }).idempotencyKey : undefined;
      return (await transport.send(operation, request, requestOptions.signal, key)) as never;
    },
    dispose: () => transport.dispose(),
  };
}

/** Kept as a source-compatible name for consumers that specifically create the browser client. */
export type BrowserRenderJobClient = RenderJobClient;
