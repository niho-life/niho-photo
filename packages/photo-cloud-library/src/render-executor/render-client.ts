/**
 * Same-origin client for render jobs on the signed-in user's own device (B07 #248), on the shared-album HTTP core: the
 * verified-session scope fence, capture headers, header deadline and bounded JSON. It never retries by itself; the
 * executor replays lost answers with the same key.
 */
import { createSharingHttpClient, type CreateSharingHttpClientOptions } from "../sharing/sharing-http";

import type { RenderExecutorOperation } from "./contract";
import type { RenderExecutorTransport } from "./render-executor";
import { encodeRenderJobRequest, isRenderJobOperation, renderJobResponseLimit, validateRenderJobResponse } from "./render-wire";

export interface BrowserRenderJobClient extends RenderExecutorTransport {
  dispose(): void;
}

export function createBrowserRenderJobClient(options: CreateSharingHttpClientOptions): BrowserRenderJobClient {
  const core = createSharingHttpClient<RenderExecutorOperation>(options, {
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
