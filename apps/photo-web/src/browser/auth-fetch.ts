import { PHOTO_CLOUD_PATH_PREFIX } from "../../../../packages/photo-cloud-library/src/wire.ts";

/** Use for the fixed Photo BFF client only; provider uploads keep their own transport. */
export function createPhotoWebCloudFetch(options: {
  readonly origin: string;
  readonly scopeSignal: AbortSignal;
  readonly onAuthenticationRejected: () => void;
  readonly fetch?: typeof fetch;
}): typeof fetch {
  const { origin, scopeSignal, onAuthenticationRejected } = options;
  const fetchPort = options.fetch ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    let cloudRequest = false;
    try {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, origin);
      cloudRequest = url.origin === origin && url.username === "" && url.password === ""
        && url.pathname.startsWith(`${PHOTO_CLOUD_PATH_PREFIX}/`);
    } catch {
      // The actual transport still validates its input; malformed URLs confer no notification authority.
    }
    const inputSignal = typeof input !== "string" && "signal" in input ? input.signal : null;
    const signal = init?.signal === undefined ? inputSignal : init.signal;
    const response = await fetchPort(input, init);
    if (cloudRequest && response.status === 401 && !scopeSignal.aborted && !signal?.aborted) {
      try { onAuthenticationRejected(); } catch { /* Preserve the original C02 response/error path. */ }
    }
    return response;
  };
}
