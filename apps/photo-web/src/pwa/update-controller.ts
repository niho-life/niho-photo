import type {
  PhotoPwaUpdateController,
  PhotoPwaUpdateOptions,
  PhotoPwaUpdateSnapshot,
} from "./types.js";

const BUILD_ID = /^[a-f0-9]{64}$/;
const GUARD_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface PendingUpdate {
  readonly nonce: string;
  readonly worker: ServiceWorker;
  readonly promise: Promise<"applied" | "blocked" | "failed">;
  readonly resolve: (result: "applied" | "blocked" | "failed") => void;
  readonly token: object;
  timer: ReturnType<typeof setTimeout> | null;
  buildId: string | null;
  approved: boolean;
  controllerChanged: boolean;
  completed: boolean;
  reloaded: boolean;
  checkStarted: boolean;
}

interface PassiveGuard {
  readonly worker: ServiceWorker;
  readonly nonce: string;
  readonly buildId: string;
  readonly token: object;
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createPhotoPwaUpdateController(options: PhotoPwaUpdateOptions): PhotoPwaUpdateController {
  if (options === null || typeof options !== "object") throw new TypeError("Invalid PWA update configuration");
  const { registration, serviceWorker, canLeave, reload } = options;
  if (
    !registration
    || !serviceWorker
    || typeof canLeave !== "function"
    || typeof reload !== "function"
    || typeof serviceWorker.addEventListener !== "function"
    || typeof serviceWorker.removeEventListener !== "function"
    || typeof registration.addEventListener !== "function"
    || typeof registration.removeEventListener !== "function"
    || typeof registration.scope !== "string"
  ) {
    throw new TypeError("Invalid PWA update configuration");
  }

  let pageOrigin: string;
  try {
    const parsedOrigin = new URL(options.origin);
    if (parsedOrigin.origin !== options.origin || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) {
      throw new TypeError("Invalid PWA update configuration");
    }
    const scopeUrl = new URL(registration.scope);
    if (scopeUrl.origin !== parsedOrigin.origin) throw new TypeError("Invalid PWA update configuration");
    pageOrigin = parsedOrigin.origin;
  } catch {
    throw new TypeError("Invalid PWA update configuration");
  }

  const configuration = Object.freeze({ registration, serviceWorker, canLeave, reload, origin: pageOrigin });
  const listeners = new Set<(snapshot: PhotoPwaUpdateSnapshot) => void>();
  const guardPorts = new Map<MessagePort, object>();
  const guardCancellations = new Map<object, () => void>();
  const installingWorkers = new Map<ServiceWorker, () => void>();
  let guardInFlight = false;
  let disposed = false;
  let pending: PendingUpdate | null = null;
  let passiveGuard: PassiveGuard | null = null;
  let lastCheck: { readonly worker: ServiceWorker; readonly nonce: string; readonly buildId: string } | null = null;
  let snapshot: PhotoPwaUpdateSnapshot = Object.freeze({
    phase: registration.waiting ? "available" : "up-to-date",
  });

  const publish = (phase: PhotoPwaUpdateSnapshot["phase"]): void => {
    if (snapshot.phase === phase) return;
    snapshot = Object.freeze({ phase });
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A subscriber cannot break update safety or other subscribers.
      }
    }
  };

  const workerIsSameOrigin = (worker: ServiceWorker): boolean => {
    try {
      return new URL(worker.scriptURL).origin === configuration.origin;
    } catch {
      return false;
    }
  };

  const closeGuardPort = (port: MessagePort): void => {
    guardPorts.delete(port);
    try {
      port.close();
    } catch {
      // Detached ports are already inert.
    }
  };

  const finish = (target: PendingUpdate, result: "applied" | "blocked" | "failed"): void => {
    if (target.completed) return;
    target.completed = true;
    if (target.timer !== null) clearTimeout(target.timer);
    target.timer = null;
    if (pending === target) pending = null;
    guardCancellations.get(target.token)?.();
    for (const [port, token] of [...guardPorts]) {
      if (token === target.token) closeGuardPort(port);
    }
    if (!disposed) {
      if (result === "blocked") publish("blocked");
      else if (result === "failed") publish("failed");
    }
    target.resolve(result);
  };

  const runGuard = async (token: object): Promise<boolean> => {
    // A timed-out host promise may remain alive. Retain at most one such call.
    if (guardInFlight || disposed) return false;
    guardInFlight = true;
    const decision = Promise.resolve().then(configuration.canLeave)
      .then((allowed) => allowed === true, () => false)
      .finally(() => { guardInFlight = false; });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancel: () => void = () => undefined;
    const timeoutOrCancellation = new Promise<false>((resolve) => {
      cancel = () => resolve(false);
      timer = setTimeout(cancel, GUARD_TIMEOUT_MS);
    });
    guardCancellations.set(token, cancel);
    try {
      return await Promise.race([
        decision,
        timeoutOrCancellation,
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (guardCancellations.get(token) === cancel) guardCancellations.delete(token);
    }
  };

  const maybeApply = (target: PendingUpdate): void => {
    if (
      disposed
      || target.completed
      || target.reloaded
      || !target.approved
      || !target.controllerChanged
      || configuration.serviceWorker.controller !== target.worker
      || pending !== target
    ) {
      return;
    }
    target.reloaded = true;
    try {
      configuration.reload();
      finish(target, "applied");
    } catch {
      finish(target, "failed");
    }
  };

  const replyToCheck = async (
    target: PendingUpdate,
    port: MessagePort,
    buildId: string,
  ): Promise<void> => {
    guardPorts.set(port, target.token);
    const allow = await runGuard(target.token);
    const isStillCurrent = !disposed
      && pending === target
      && !target.completed
      && configuration.registration.waiting === target.worker
      && target.token === pending.token;
    try {
      port.postMessage(Object.freeze({ nonce: target.nonce, buildId, allow: isStillCurrent && allow === true }));
    } catch {
      // The waiting worker treats a disconnected client as a denial.
    } finally {
      closeGuardPort(port);
    }
    if (isStillCurrent && allow !== true) finish(target, "blocked");
    else if (!disposed && pending === target && configuration.registration.waiting !== target.worker) finish(target, "failed");
  };

  const replyToPassiveCheck = async (
    guard: PassiveGuard,
    port: MessagePort,
  ): Promise<void> => {
    guardPorts.set(port, guard.token);
    const allow = await runGuard(guard.token);
    const isStillCurrent = !disposed
      && passiveGuard === guard
      && configuration.registration.waiting === guard.worker;
    try {
      port.postMessage(Object.freeze({
        nonce: guard.nonce,
        buildId: guard.buildId,
        allow: isStillCurrent && allow === true,
      }));
    } catch {
      // The waiting worker treats a disconnected client as a denial.
    } finally {
      closeGuardPort(port);
      if (passiveGuard === guard) passiveGuard = null;
    }
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    const target = pending;
    if (disposed) return;
    const data = event.data;

    if (exactKeys(data, ["type", "nonce", "buildId"]) && data.type === "PHOTO_UPDATE_CHECK") {
      const source = configuration.registration.waiting;
      if (
        !source
        || event.source !== source
        || !workerIsSameOrigin(source)
        || typeof data.nonce !== "string"
        || !BUILD_ID.test(data.nonce)
        || typeof data.buildId !== "string"
        || !BUILD_ID.test(data.buildId)
        || event.ports.length !== 1
      ) {
        for (const port of event.ports) closeGuardPort(port);
        if (target && event.source === target.worker && source !== target.worker) finish(target, "failed");
        return;
      }
      const port = event.ports[0];
      if (!port) return;
      if (lastCheck?.worker === source && lastCheck.nonce === data.nonce && lastCheck.buildId === data.buildId) {
        closeGuardPort(port);
        return;
      }
      lastCheck = { worker: source, nonce: data.nonce, buildId: data.buildId };

      if (target && !target.completed && source === target.worker && data.nonce === target.nonce) {
        if (target.checkStarted) {
          closeGuardPort(port);
          finish(target, "failed");
          return;
        }
        target.checkStarted = true;
        if (target.buildId !== null && target.buildId !== data.buildId) {
          closeGuardPort(port);
          finish(target, "failed");
          return;
        }
        target.buildId = data.buildId;
        void replyToCheck(target, port, data.buildId);
        return;
      }

      if (passiveGuard) {
        closeGuardPort(port);
        return;
      }
      const guard: PassiveGuard = {
        worker: source,
        nonce: data.nonce,
        buildId: data.buildId,
        token: Object.freeze({}),
      };
      passiveGuard = guard;
      void replyToPassiveCheck(guard, port);
      return;
    }

    if (!target || target.completed || event.source !== target.worker || !workerIsSameOrigin(target.worker)) return;

    if (exactKeys(data, ["type", "nonce", "buildId"]) && data.type === "PHOTO_UPDATE_BLOCKED") {
      if (
        data.nonce === target.nonce
        && typeof data.buildId === "string"
        && BUILD_ID.test(data.buildId)
        && (target.buildId === null || data.buildId === target.buildId)
      ) {
        target.buildId = data.buildId;
        finish(target, "blocked");
      }
      return;
    }

    if (exactKeys(data, ["type", "nonce", "buildId"]) && data.type === "PHOTO_UPDATE_APPROVED") {
      if (
        data.nonce !== target.nonce
        || typeof data.buildId !== "string"
        || data.buildId !== target.buildId
      ) {
        return;
      }
      const currentWaiting = configuration.registration.waiting;
      const sourceCanHaveActivated = currentWaiting === null
        && (target.worker.state === "activating" || target.worker.state === "activated");
      if (currentWaiting !== target.worker && !sourceCanHaveActivated) {
        finish(target, "failed");
        return;
      }
      target.approved = true;
      publish("activating");
      maybeApply(target);
    }
  };

  const onControllerChange = (): void => {
    const target = pending;
    if (disposed) return;
    if (!target) {
      publish(configuration.registration.waiting ? "available" : "up-to-date");
      return;
    }
    if (target.completed || configuration.serviceWorker.controller !== target.worker) return;
    target.controllerChanged = true;
    maybeApply(target);
  };

  const watchInstalling = (worker: ServiceWorker): void => {
    if (installingWorkers.has(worker)) return;
    const onStateChange = (): void => {
      if (disposed) return;
      if (worker.state === "installed" && configuration.registration.waiting) {
        const target = pending;
        if (target && configuration.registration.waiting !== target.worker) finish(target, "failed");
        if (!pending) publish("available");
      }
      if (worker.state === "redundant") {
        const target = pending;
        if (target?.worker === worker && !target.approved) finish(target, "failed");
      }
    };
    worker.addEventListener("statechange", onStateChange);
    installingWorkers.set(worker, () => worker.removeEventListener("statechange", onStateChange));
  };

  const onUpdateFound = (): void => {
    const worker = configuration.registration.installing;
    if (worker) watchInstalling(worker);
    else if (!pending && configuration.registration.waiting) publish("available");
  };

  configuration.serviceWorker.addEventListener("message", onMessage);
  configuration.serviceWorker.addEventListener("controllerchange", onControllerChange);
  configuration.registration.addEventListener("updatefound", onUpdateFound);
  if (configuration.registration.installing) watchInstalling(configuration.registration.installing);

  const requestUpdate = (): Promise<"applied" | "blocked" | "failed"> => {
    if (disposed) return Promise.resolve("failed");
    if (pending) return pending.promise;
    const worker = configuration.registration.waiting;
    if (!worker) {
      publish("up-to-date");
      return Promise.resolve("failed");
    }
    if (!workerIsSameOrigin(worker)) {
      publish("failed");
      return Promise.resolve("failed");
    }

    let nonce: string;
    try {
      nonce = makeNonce();
    } catch {
      publish("failed");
      return Promise.resolve("failed");
    }

    let resolve!: PendingUpdate["resolve"];
    const promise = new Promise<"applied" | "blocked" | "failed">((settle) => {
      resolve = settle;
    });
    const target: PendingUpdate = {
      nonce,
      worker,
      promise,
      resolve,
      token: Object.freeze({}),
      timer: null,
      buildId: null,
      approved: false,
      controllerChanged: false,
      completed: false,
      reloaded: false,
      checkStarted: false,
    };
    target.timer = setTimeout(() => finish(target, "failed"), REQUEST_TIMEOUT_MS);
    pending = target;
    publish("preparing");
    try {
      worker.postMessage(Object.freeze({ type: "PHOTO_REQUEST_UPDATE", nonce }));
    } catch {
      finish(target, "failed");
    }
    return promise;
  };

  return Object.freeze({
    getSnapshot(): PhotoPwaUpdateSnapshot {
      return snapshot;
    },
    subscribe(listener: (next: PhotoPwaUpdateSnapshot) => void): () => void {
      if (typeof listener !== "function") throw new TypeError("Invalid PWA update listener");
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestUpdate,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      configuration.serviceWorker.removeEventListener("message", onMessage);
      configuration.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      configuration.registration.removeEventListener("updatefound", onUpdateFound);
      for (const remove of installingWorkers.values()) remove();
      installingWorkers.clear();
      for (const cancel of guardCancellations.values()) cancel();
      guardCancellations.clear();
      for (const port of [...guardPorts.keys()]) closeGuardPort(port);
      passiveGuard = null;
      if (pending) finish(pending, "failed");
      publish("disposed");
      listeners.clear();
    },
  });
}
