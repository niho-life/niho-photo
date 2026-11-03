/**
 * Installs the manifest-bounded NIHO photo static service-worker runtime.
 *
 * Keep every dependency inside this function: the build generator embeds its
 * source in a classic worker together with a verified manifest.
 */
export function installPhotoStaticWorker(scope, manifest) {
  "use strict";

  const CACHE_PREFIX = "niho-photo-web-static-";
  const MAX_ASSET_BYTES = 8 * 1024 * 1024;
  const MAX_OFFLINE_BYTES = 256 * 1024;
  const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
  const MAX_ENTRIES = 128;
  const MAX_BODY_READS = 2;
  const MAX_BODY_WAITERS = 128;
  const STATIC_DEADLINE_MS = 15_000;
  const CACHE_DEADLINE_MS = 1_000;
  const UPDATE_DEADLINE_MS = 20_000;
  const SHA256 = /^[a-f0-9]{64}$/;
  const NONCE = /^[a-f0-9]{64}$/;
  const origin = new URL(scope.location.href).origin;

  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const exactKeys = (value, expected) => {
    if (!isRecord(value)) return false;
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  };
  const normalizeContentType = (value) => value.split(";", 1)[0].trim().toLowerCase();
  const allowedTypes = Object.freeze({
    script: new Set(["application/ecmascript", "application/javascript", "text/javascript"]),
    style: new Set(["text/css"]),
    font: new Set(["application/font-woff", "application/vnd.ms-fontobject", "font/otf", "font/ttf", "font/woff", "font/woff2"]),
    icon: new Set(["image/avif", "image/png", "image/svg+xml", "image/webp", "image/x-icon"]),
    engine: new Set(["application/javascript", "application/json", "application/octet-stream", "application/wasm", "text/javascript"]),
    offline: new Set(["text/html"]),
  });

  const validatePath = (path) => {
    if (typeof path !== "string" || path.length < 2 || path.length > 1024) throw new TypeError("Invalid static manifest");
    if (!/^\/[\x21-\x7e]+$/.test(path) || path.includes("?") || path.includes("#") || path.includes("\\")) {
      throw new TypeError("Invalid static manifest");
    }
    if (/%(?:2f|5c)/i.test(path) || /(?:^|\/)(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(path)) {
      throw new TypeError("Invalid static manifest");
    }
    const parsed = new URL(path, origin);
    if (parsed.origin !== origin || parsed.pathname !== path || parsed.search || parsed.hash) throw new TypeError("Invalid static manifest");
  };

  if (!exactKeys(manifest, ["schemaVersion", "buildId", "assets", "offlinePath"]) || manifest.schemaVersion !== 1) {
    throw new TypeError("Invalid static manifest");
  }
  if (typeof manifest.buildId !== "string" || !SHA256.test(manifest.buildId)) throw new TypeError("Invalid static manifest");
  validatePath(manifest.offlinePath);
  if (/^\/(?:api|auth|photo-content)(?:\/|$)/i.test(manifest.offlinePath)) throw new TypeError("Invalid static manifest");
  if (!Array.isArray(manifest.assets) || manifest.assets.length < 1 || manifest.assets.length > MAX_ENTRIES) {
    throw new TypeError("Invalid static manifest");
  }
  const buildId = manifest.buildId;
  const offlinePath = manifest.offlinePath;

  const descriptors = new Map();
  let totalBytes = 0;
  let offlineCount = 0;
  for (const asset of manifest.assets) {
    if (!exactKeys(asset, ["path", "sha256", "sizeBytes", "contentType", "kind"])) throw new TypeError("Invalid static manifest");
    validatePath(asset.path);
    if (descriptors.has(asset.path) || typeof asset.sha256 !== "string" || !SHA256.test(asset.sha256)) {
      throw new TypeError("Invalid static manifest");
    }
    if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 || asset.sizeBytes > MAX_ASSET_BYTES) {
      throw new TypeError("Invalid static manifest");
    }
    if (typeof asset.contentType !== "string" || asset.contentType !== normalizeContentType(asset.contentType)) {
      throw new TypeError("Invalid static manifest");
    }
    const kindTypes = allowedTypes[asset.kind];
    if (!kindTypes || !kindTypes.has(asset.contentType)) throw new TypeError("Invalid static manifest");

    const isOffline = asset.path === offlinePath;
    if (isOffline !== (asset.kind === "offline")) throw new TypeError("Invalid static manifest");
    if (isOffline && asset.sizeBytes > MAX_OFFLINE_BYTES) throw new TypeError("Invalid static manifest");
    if (asset.contentType === "text/html" && !isOffline) throw new TypeError("Invalid static manifest");
    if (!isOffline) {
      const namespaceKind = asset.path.startsWith("/icons/")
        ? "icon"
        : asset.path.startsWith("/develop-engine/")
          ? "engine"
          : asset.path.startsWith("/assets/")
            ? "asset"
            : null;
      if (namespaceKind === null || (namespaceKind === "icon" && asset.kind !== "icon") || (namespaceKind === "engine" && asset.kind !== "engine")) {
        throw new TypeError("Invalid static manifest");
      }
      if (namespaceKind === "asset" && !new Set(["script", "style", "font", "icon"]).has(asset.kind)) {
        throw new TypeError("Invalid static manifest");
      }
    } else {
      offlineCount += 1;
    }
    totalBytes += asset.sizeBytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new TypeError("Invalid static manifest");
    descriptors.set(asset.path, Object.freeze({ ...asset }));
  }
  if (offlineCount !== 1 || !descriptors.has(offlinePath)) throw new TypeError("Invalid static manifest");

  const cacheName = `${CACHE_PREFIX}${buildId}`;
  const offlineDescriptor = descriptors.get(offlinePath);
  let activeBodyReads = 0;
  let retainedVerifications = 0;
  let pendingFetches = 0;
  let abandonedVerifications = 0;
  let abandonedFetches = 0;
  const bodyWaiters = [];
  let cacheMutationActive = false;
  let cacheDisabled = false;
  let updateInFlight = false;

  const timeoutRace = (promise, milliseconds, onTimeout) => {
    let timer;
    let finished = false;
    const task = Promise.resolve(promise);
    task.catch(() => undefined);
    const timeout = new Promise((_, reject) => {
      timer = scope.setTimeout(() => {
        if (finished) return;
        try {
          onTimeout?.();
        } finally {
          const error = new Error("Operation timed out");
          error.name = "PhotoStaticTimeoutError";
          reject(error);
        }
      }, Math.max(0, milliseconds));
    });
    return Promise.race([task, timeout]).finally(() => {
      finished = true;
      scope.clearTimeout(timer);
    });
  };

  const availableBodySlots = () => Math.max(0, MAX_BODY_READS - abandonedVerifications - abandonedFetches);
  const wakeBodyWaiters = () => {
    const available = availableBodySlots();
    if (available === 0) {
      while (bodyWaiters.length) bodyWaiters.shift().fail();
      return;
    }
    while (bodyWaiters.length && activeBodyReads < available) bodyWaiters.shift().run();
  };

  const acquireBodySlot = (deadlineAt) => {
    const available = availableBodySlots();
    if (available === 0) {
      return Promise.reject(new Error("Unsettled static operations exhausted the budget"));
    }
    if (activeBodyReads < available) {
      activeBodyReads += 1;
      return Promise.resolve();
    }
    if (bodyWaiters.length >= MAX_BODY_WAITERS) return Promise.reject(new Error("Static verification is busy"));
    return new Promise((resolve, reject) => {
      const waiter = {
        timer: undefined,
        run: () => {
          scope.clearTimeout(waiter.timer);
          activeBodyReads += 1;
          resolve();
        },
        fail: () => {
          scope.clearTimeout(waiter.timer);
          reject(new Error("Unsettled static operations exhausted the budget"));
        },
      };
      waiter.timer = scope.setTimeout(() => {
        const index = bodyWaiters.indexOf(waiter);
        if (index >= 0) bodyWaiters.splice(index, 1);
        reject(new Error("Static verification timed out"));
      }, Math.max(0, deadlineAt - Date.now()));
      bodyWaiters.push(waiter);
    });
  };

  const releaseBodySlot = () => {
    activeBodyReads -= 1;
    wakeBodyWaiters();
  };

  const safeHeaders = (response, descriptor, network) => {
    if (response.status !== 200 || response.redirected) return false;
    if (network && response.type !== "basic") return false;
    if (response.headers.has("content-range") || response.headers.has("set-cookie")) return false;
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^(0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) !== descriptor.sizeBytes)) return false;
    if (normalizeContentType(response.headers.get("content-type") || "") !== descriptor.contentType) return false;
    const directives = (response.headers.get("cache-control") || "")
      .toLowerCase()
      .split(",")
      .map((part) => part.trim().split("=", 1)[0]);
    if (!directives.includes("public") || !directives.includes("immutable") || directives.includes("private") || directives.includes("no-store")) return false;
    const vary = (response.headers.get("vary") || "")
      .toLowerCase()
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    return !vary.some((name) => name === "*" || name === "cookie" || name === "authorization");
  };

  const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

  const verifyResponse = async (response, descriptor, deadlineAt, network, abortController) => {
    if (retainedVerifications >= MAX_BODY_READS || !safeHeaders(response, descriptor, network) || !response.body) {
      try {
        abortController?.abort();
      } catch {
        // Abort is best effort.
      }
      try {
        Promise.resolve(response.body?.cancel()).catch(() => undefined);
      } catch {
        // A rejected response body does not need to settle before failing closed.
      }
      throw new Error("Static response rejected");
    }
    let reader;
    let stopped = false;
    let verificationSettled = false;
    let abandonedVerification = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        abortController?.abort();
      } catch {
        // Abort is best effort.
      }
      try {
        Promise.resolve(reader?.cancel()).catch(() => undefined);
      } catch {
        // A hostile stream may reject or hang during cancellation.
      }
    };
    try {
      reader = response.body.getReader();
      retainedVerifications += 1;
      const readAndDigest = async () => {
        try {
          const bytes = new Uint8Array(descriptor.sizeBytes);
          let offset = 0;
          while (true) {
            const part = await reader.read();
            if (stopped) throw new Error("Static verification stopped");
            if (part.done) break;
            if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0) throw new Error("Invalid static body chunk");
            if (offset + part.value.byteLength > bytes.byteLength) throw new Error("Static body too large");
            bytes.set(part.value, offset);
            offset += part.value.byteLength;
          }
          if (offset !== bytes.byteLength) throw new Error("Static body size mismatch");
          const digest = await scope.crypto.subtle.digest("SHA-256", bytes);
          if (stopped || hex(digest) !== descriptor.sha256) throw new Error("Static body hash mismatch");
          return bytes;
        } finally {
          // Count the actual task, even if a deadline won its public race.
          verificationSettled = true;
          retainedVerifications -= 1;
          if (abandonedVerification) {
            abandonedVerification = false;
            abandonedVerifications -= 1;
            wakeBodyWaiters();
          }
        }
      };
      return await timeoutRace(readAndDigest(), deadlineAt - Date.now(), () => {
        if (!verificationSettled && !abandonedVerification) {
          abandonedVerification = true;
          abandonedVerifications += 1;
          wakeBodyWaiters();
        }
        stop();
      });
    } finally {
      stop();
      try {
        reader?.releaseLock();
      } catch {
        // Some stream implementations keep a pending read locked after cancel.
      }
    }
  };

  const verifiedResponse = (bytes, response) => new Response(bytes, {
    status: 200,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });

  const disableCache = () => {
    cacheDisabled = true;
  };

  const cacheOperation = async (operation) => {
    if (cacheDisabled) throw new Error("Static cache disabled");
    try {
      return await timeoutRace(operation(), CACHE_DEADLINE_MS, disableCache);
    } catch (error) {
      cacheDisabled = true;
      throw error;
    }
  };

  const openCache = () => cacheOperation(() => scope.caches.open(cacheName));

  const deleteCacheEntry = (cache, absoluteUrl) => {
    if (cacheDisabled || cacheMutationActive) return;
    cacheMutationActive = true;
    cacheOperation(() => cache.delete(absoluteUrl))
      .catch(() => undefined)
      .finally(() => {
        cacheMutationActive = false;
      });
  };

  const readCached = async (descriptor, deadlineAt) => {
    if (cacheDisabled) return null;
    let cache;
    let cached;
    const absoluteUrl = new URL(descriptor.path, origin).href;
    try {
      cache = await openCache();
      cached = await cacheOperation(() => cache.match(absoluteUrl));
    } catch {
      return null;
    }
    if (!cached) return null;
    try {
      const bytes = await verifyResponse(cached, descriptor, deadlineAt, false);
      return { bytes, response: verifiedResponse(bytes, cached), cache };
    } catch (error) {
      deleteCacheEntry(cache, absoluteUrl);
      // A timed-out cached body must release its public slot, not start another read beside it.
      if (error?.name === "PhotoStaticTimeoutError") throw error;
      return null;
    }
  };

  const storeWithinBudget = async (cache, descriptor, bytes, headers) => {
    const absoluteUrl = new URL(descriptor.path, origin).href;
    const keys = await cache.keys();
    const retained = [];
    let retainedBytes = 0;
    for (const key of keys) {
      const keyUrl = typeof key === "string" ? key : key.url;
      const parsed = new URL(keyUrl);
      const known = parsed.origin === origin ? descriptors.get(parsed.pathname) : undefined;
      if (!known || parsed.search || parsed.hash) {
        await cache.delete(key);
        continue;
      }
      retained.push({ key, bytes: known.sizeBytes, url: keyUrl });
      retainedBytes += known.sizeBytes;
    }
    if (retained.some((entry) => entry.url === absoluteUrl)) return;
    while (retained.length + 1 > MAX_ENTRIES || retainedBytes + descriptor.sizeBytes > MAX_TOTAL_BYTES) {
      const oldest = retained.shift();
      if (!oldest) return;
      await cache.delete(oldest.key);
      retainedBytes -= oldest.bytes;
    }
    await cache.put(absoluteUrl, new Response(bytes, { status: 200, headers }));
  };

  const scheduleStore = (cache, descriptor, bytes, headers) => {
    if (!cache || cacheDisabled || cacheMutationActive) return Promise.resolve();
    cacheMutationActive = true;
    const immutableHeaders = new Headers(headers);
    const work = cacheOperation(() => storeWithinBudget(cache, descriptor, bytes, immutableHeaders))
      .catch(() => undefined)
      .finally(() => {
        cacheMutationActive = false;
      });
    return work;
  };

  const fetchVerified = async (descriptor, deadlineAt) => {
    const abortController = new AbortController();
    const absoluteUrl = new URL(descriptor.path, origin).href;
    const request = new Request(absoluteUrl, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: abortController.signal,
    });
    if (pendingFetches >= MAX_BODY_READS) throw new Error("Static fetch budget exhausted");
    pendingFetches += 1;
    let expired = false;
    let fetchSettled = false;
    let abandonedFetch = false;
    const attempt = Promise.resolve().then(() => scope.fetch(request)).then((response) => {
      if (expired) {
        try { Promise.resolve(response.body?.cancel()).catch(() => undefined); } catch { /* Best effort. */ }
        throw new Error("Static fetch expired");
      }
      return response;
    }).finally(() => {
      fetchSettled = true;
      pendingFetches -= 1;
      if (abandonedFetch) {
        abandonedFetch = false;
        abandonedFetches -= 1;
        wakeBodyWaiters();
      }
    });
    let response;
    try {
      response = await timeoutRace(attempt, deadlineAt - Date.now(), () => {
        expired = true;
        if (!fetchSettled && !abandonedFetch) {
          abandonedFetch = true;
          abandonedFetches += 1;
          wakeBodyWaiters();
        }
        abortController.abort();
      });
    } catch (error) {
      expired = true;
      abortController.abort();
      throw error;
    }
    const bytes = await verifyResponse(response, descriptor, deadlineAt, true, abortController);
    return { bytes, response: verifiedResponse(bytes, response) };
  };

  const staticAsset = async (descriptor) => {
    const deadlineAt = Date.now() + STATIC_DEADLINE_MS;
    await acquireBodySlot(deadlineAt);
    try {
      const cached = await readCached(descriptor, deadlineAt);
      if (cached) return { response: cached.response, cacheWork: Promise.resolve() };
      const fetched = await fetchVerified(descriptor, deadlineAt);
      let cache = null;
      if (!cacheDisabled) {
        try {
          cache = await openCache();
        } catch {
          // A verified network response remains safe when CacheStorage is absent.
        }
      }
      return {
        response: fetched.response,
        cacheWork: scheduleStore(cache, descriptor, fetched.bytes, fetched.response.headers),
      };
    } finally {
      releaseBodySlot();
    }
  };

  const requestDescriptor = (request) => {
    if (request.method !== "GET" || request.mode === "navigate") return null;
    if (request.headers.has("authorization") || request.headers.has("range")) return null;
    const url = new URL(request.url);
    if (url.origin !== origin || url.search || url.hash) return null;
    return descriptors.get(url.pathname) || null;
  };

  const isExactRootNavigation = (request) => {
    if (request.method !== "GET" || request.mode !== "navigate") return false;
    if (request.headers.has("authorization") || request.headers.has("range")) return false;
    const url = new URL(request.url);
    return url.origin === origin && url.pathname === "/" && !url.search && !url.hash;
  };

  const rootNavigation = async (request) => {
    try {
      return await scope.fetch(request);
    } catch (networkError) {
      const deadlineAt = Date.now() + STATIC_DEADLINE_MS;
      await acquireBodySlot(deadlineAt);
      try {
        const cached = await readCached(offlineDescriptor, deadlineAt);
        if (cached) return cached.response;
        throw networkError;
      } finally {
        releaseBodySlot();
      }
    }
  };

  const clientInScope = (client) => {
    if (!client || client.type !== "window" || typeof client.url !== "string") return false;
    try {
      const clientUrl = new URL(client.url);
      const registrationUrl = new URL(scope.registration.scope);
      return clientUrl.origin === origin && registrationUrl.origin === origin && clientUrl.href.startsWith(registrationUrl.href);
    } catch {
      return false;
    }
  };

  const postResult = (client, type, nonce) => {
    try {
      client.postMessage(Object.freeze({ type, nonce, buildId }));
    } catch {
      // A disconnected initiating client needs no further notification.
    }
  };

  const collectUpdateConsent = async (clients, nonce, deadlineAt) => {
    const channels = [];
    let timer;
    return new Promise((resolve) => {
      let settled = false;
      let remaining = clients.length;
      const finish = (allowed) => {
        if (settled) return;
        settled = true;
        scope.clearTimeout(timer);
        for (const channel of channels) {
          channel.port1.onmessage = null;
          channel.port1.onmessageerror = null;
          try {
            channel.port1.close();
          } catch {
            // Closing a detached port is best effort.
          }
        }
        resolve(allowed);
      };

      const remainingTime = deadlineAt - Date.now();
      if (remainingTime <= 0) {
        finish(false);
        return;
      }
      timer = scope.setTimeout(() => finish(false), remainingTime);
      for (const client of clients) {
        const channel = new MessageChannel();
        let answered = false;
        channels.push(channel);
        channel.port1.onmessageerror = () => finish(false);
        channel.port1.onmessage = (messageEvent) => {
          if (answered) return;
          answered = true;
          if (Date.now() >= deadlineAt) {
            finish(false);
            return;
          }
          const reply = messageEvent.data;
          if (!exactKeys(reply, ["nonce", "buildId", "allow"]) || reply.nonce !== nonce || reply.buildId !== buildId || reply.allow !== true) {
            finish(false);
            return;
          }
          channel.port1.onmessage = null;
          channel.port1.onmessageerror = null;
          try {
            channel.port1.close();
          } catch {
            // This client has already supplied its one allowed acknowledgement.
          }
          remaining -= 1;
          if (remaining === 0) finish(true);
        };
        try {
          client.postMessage(Object.freeze({ type: "PHOTO_UPDATE_CHECK", nonce, buildId }), [channel.port2]);
        } catch {
          finish(false);
          return;
        }
      }
    });
  };

  const handleUpdateRequest = async (event) => {
    const data = event.data;
    const source = event.source;
    if (!exactKeys(data, ["type", "nonce"]) || data.type !== "PHOTO_REQUEST_UPDATE" || typeof data.nonce !== "string" || !NONCE.test(data.nonce)) return;
    if (!clientInScope(source)) return;
    if (updateInFlight) {
      postResult(source, "PHOTO_UPDATE_BLOCKED", data.nonce);
      return;
    }
    updateInFlight = true;
    const deadlineAt = Date.now() + UPDATE_DEADLINE_MS;
    try {
      let clients;
      try {
        clients = (await timeoutRace(
          scope.clients.matchAll({ type: "window", includeUncontrolled: true }),
          deadlineAt - Date.now(),
          () => undefined,
        )).filter(clientInScope);
      } catch {
        postResult(source, "PHOTO_UPDATE_BLOCKED", data.nonce);
        return;
      }
      if (Date.now() >= deadlineAt) {
        postResult(source, "PHOTO_UPDATE_BLOCKED", data.nonce);
        return;
      }
      const requesterPresent = clients.some((client) => client === source || (client.id && source.id && client.id === source.id));
      if (!requesterPresent || clients.length === 0) {
        postResult(source, "PHOTO_UPDATE_BLOCKED", data.nonce);
        return;
      }
      const allowed = await collectUpdateConsent(clients, data.nonce, deadlineAt);
      if (!allowed || Date.now() >= deadlineAt) {
        postResult(source, "PHOTO_UPDATE_BLOCKED", data.nonce);
        return;
      }
      postResult(source, "PHOTO_UPDATE_APPROVED", data.nonce);
      await scope.skipWaiting();
    } catch {
      postResult(source, "PHOTO_UPDATE_BLOCKED", data.nonce);
    } finally {
      updateInFlight = false;
    }
  };

  scope.addEventListener("install", (event) => {
    const work = staticAsset(offlineDescriptor)
      .then(({ cacheWork }) => cacheWork)
      .catch(() => undefined);
    event.waitUntil(work);
  });

  scope.addEventListener("activate", (event) => {
    const cleanup = (async () => {
      let names;
      let cleanupStopped = false;
      const stopCleanup = () => {
        cleanupStopped = true;
        disableCache();
      };
      try {
        names = await timeoutRace(scope.caches.keys(), CACHE_DEADLINE_MS, stopCleanup);
      } catch {
        return;
      }
      const own = names.filter((name) => name.startsWith(CACHE_PREFIX));
      const previous = own.filter((name) => name !== cacheName && SHA256.test(name.slice(CACHE_PREFIX.length))).at(-1);
      const retained = new Set([cacheName, previous].filter(Boolean));
      for (const name of own) {
        if (retained.has(name) || cleanupStopped) continue;
        await timeoutRace(scope.caches.delete(name), CACHE_DEADLINE_MS, stopCleanup).catch(() => false);
      }
    })();
    event.waitUntil(cleanup);
  });

  scope.addEventListener("fetch", (event) => {
    if (isExactRootNavigation(event.request)) {
      event.respondWith(rootNavigation(event.request));
      return;
    }
    const descriptor = requestDescriptor(event.request);
    if (!descriptor) return;
    const work = staticAsset(descriptor);
    event.respondWith(work.then(({ response }) => response));
    event.waitUntil(work.then(({ cacheWork }) => cacheWork).catch(() => undefined));
  });

  scope.addEventListener("message", (event) => {
    const work = handleUpdateRequest(event);
    if (typeof event.waitUntil === "function") event.waitUntil(work);
  });
}
