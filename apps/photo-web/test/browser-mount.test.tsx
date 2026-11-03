import { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CreatePhotoWebRuntimeOptions,
  PhotoWebRuntime,
  PhotoWebRuntimeSnapshot,
} from "../src/runtime/types.ts";
import type { PhotoWebViewCopy, PhotoWebViewProps } from "../src/view/types.ts";

const mockState = vi.hoisted(() => ({
  runtimeQueue: [] as unknown[],
  viewProps: [] as unknown[],
  viewUnmounts: 0,
}));

vi.mock("../src/runtime/runtime.ts", () => ({
  createPhotoWebRuntime: vi.fn(() => {
    const runtime = mockState.runtimeQueue.shift();
    if (runtime === undefined) throw new Error("missing controlled runtime");
    return runtime;
  }),
}));

vi.mock("../src/view/PhotoWebView.tsx", () => ({
  PhotoWebView: (props: PhotoWebViewProps) => {
    mockState.viewProps.push(props);
    useEffect(() => () => {
      mockState.viewUnmounts += 1;
    }, []);
    if (props.dialogScopeKey === "throw-render") throw new Error("render failed");
    return (
      <div data-testid="photo-web-view">
        {props.session.phase}|{props.online ? "online" : "offline"}|{props.dialogScopeKey}
      </div>
    );
  },
}));

import { createPhotoWebRuntime } from "../src/runtime/runtime.ts";
import { mountPhotoWeb, type MountedPhotoWeb } from "../src/browser/mount.tsx";

const copy: PhotoWebViewCopy = {
  brand: "写真ブランド",
  title: "写真を整える",
  subtitle: "自分の写真を表示します",
  login: "ログイン",
  verifying: "確認中",
  unavailable: "利用できません",
  retry: "再試行",
  logout: "ログアウト",
  cloud: "クラウド",
  toggleTree: "左パネル",
  offline: "オフライン",
  failed: "操作に失敗しました",
  version: "版 合成",
  pwaAvailable: "更新があります",
  pwaPreparing: "更新を準備中",
  pwaBlocked: "更新を保留しました",
  pwaFailed: "更新に失敗しました",
  pwaApply: "更新する",
  usage: (usage) => `使用量 ${usage.usedBytes}`,
};

const runtimeOptions = {} as CreatePhotoWebRuntimeOptions;

function snapshot(overrides: Partial<PhotoWebRuntimeSnapshot> = {}): PhotoWebRuntimeSnapshot {
  return {
    session: {
      phase: "signed-out",
      identity: null,
      cloudOperationsAvailable: false,
      localEditingAvailable: true,
      error: null,
    },
    binding: null,
    dialogScopeKey: "anonymous:0",
    online: true,
    pwa: null,
    queryClient: new QueryClient(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

interface ControlledRuntimeOptions {
  readonly initial?: PhotoWebRuntimeSnapshot;
  readonly start?: () => Promise<void>;
  readonly notifyDuringSubscribe?: PhotoWebRuntimeSnapshot;
  readonly subscribeError?: Error;
  readonly unsubscribeError?: Error;
  readonly disposeError?: Error;
}

function controlledRuntime(options: ControlledRuntimeOptions = {}) {
  const calls: string[] = [];
  let current = options.initial ?? snapshot();
  let activeListener: ((next: PhotoWebRuntimeSnapshot) => void) | null = null;
  let lastListener: ((next: PhotoWebRuntimeSnapshot) => void) | null = null;
  let routeGuard = vi.fn() as PhotoWebViewProps["registerRouteLeaveGuard"];

  const runtime = {
    getSnapshot(): PhotoWebRuntimeSnapshot {
      calls.push("getSnapshot");
      return current;
    },
    subscribe(listener: (next: PhotoWebRuntimeSnapshot) => void): () => void {
      calls.push("subscribe");
      if (options.subscribeError) throw options.subscribeError;
      activeListener = listener;
      lastListener = listener;
      if (options.notifyDuringSubscribe) {
        listener(options.notifyDuringSubscribe);
      }
      return () => {
        calls.push("unsubscribe");
        activeListener = null;
        if (options.unsubscribeError) throw options.unsubscribeError;
      };
    },
    start: vi.fn(() => {
      calls.push("start");
      return options.start?.() ?? Promise.resolve();
    }),
    retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    canLeave: vi.fn(async () => true),
    get registerRouteLeaveGuard() {
      return routeGuard;
    },
    dispose: vi.fn(() => {
      calls.push("runtime.dispose");
      if (options.disposeError) throw options.disposeError;
    }),
  } satisfies PhotoWebRuntime;

  return {
    runtime,
    calls,
    setRouteGuard(next: PhotoWebViewProps["registerRouteLeaveGuard"]) {
      routeGuard = next;
    },
    notify(next: PhotoWebRuntimeSnapshot) {
      current = next;
      activeListener?.(next);
    },
    notifyLate(next: PhotoWebRuntimeSnapshot) {
      current = next;
      lastListener?.(next);
    },
  };
}

function rootElement(): HTMLDivElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

function mount(root: HTMLElement): MountedPhotoWeb {
  return mountPhotoWeb({ rootElement: root, runtimeOptions, copy, iconUrl: "/owned-icon.png" });
}

function latestViewProps(): PhotoWebViewProps {
  const props = mockState.viewProps.at(-1);
  if (props === undefined) throw new Error("missing PhotoWebView props");
  return props as PhotoWebViewProps;
}

describe("mountPhotoWeb", () => {
  beforeEach(() => {
    mockState.runtimeQueue.length = 0;
    mockState.viewProps.length = 0;
    mockState.viewUnmounts = 0;
    vi.mocked(createPhotoWebRuntime).mockClear();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("subscribe後の最新snapshotを同期描画してruntimeを1回だけ開始する", async () => {
    const duringSubscribe = snapshot({ dialogScopeKey: "during-subscribe", online: false });
    const controlled = controlledRuntime({ notifyDuringSubscribe: duringSubscribe });
    mockState.runtimeQueue.push(controlled.runtime);
    const root = rootElement();

    const mounted = mount(root);

    expect(root.textContent).toBe("signed-out|online|anonymous:0");
    expect(controlled.calls).toEqual(["subscribe", "getSnapshot", "start"]);
    expect(createPhotoWebRuntime).toHaveBeenCalledOnce();
    expect(createPhotoWebRuntime).toHaveBeenCalledWith(runtimeOptions);
    expect(mounted.runtime).toBe(controlled.runtime);
    expect(Object.isFrozen(mounted)).toBe(true);
    await expect(mounted.ready).resolves.toBeUndefined();

    await latestViewProps().onRetry();
    await latestViewProps().onLogout();
    expect(controlled.runtime.retry).toHaveBeenCalledOnce();
    expect(controlled.runtime.logout).toHaveBeenCalledOnce();
    mounted.dispose();
  });

  it("通知を同期DOM反映し、その時点のroute guard registrarを渡す", () => {
    const controlled = controlledRuntime();
    mockState.runtimeQueue.push(controlled.runtime);
    const root = rootElement();
    const mounted = mount(root);
    const firstRegistrar = latestViewProps().registerRouteLeaveGuard;
    const nextRegistrar = vi.fn() as PhotoWebViewProps["registerRouteLeaveGuard"];
    controlled.setRouteGuard(nextRegistrar);

    controlled.notify(snapshot({ dialogScopeKey: "authority:1", online: false }));

    expect(root.textContent).toBe("signed-out|offline|authority:1");
    expect(latestViewProps().registerRouteLeaveGuard).toBe(nextRegistrar);
    expect(latestViewProps().registerRouteLeaveGuard).not.toBe(firstRegistrar);
    mounted.dispose();
  });

  it("同じrootの二重mountを拒否し、例外を隔離したdispose後は再mountできる", () => {
    const first = controlledRuntime({
      unsubscribeError: new Error("unsubscribe failed"),
      disposeError: new Error("runtime dispose failed"),
    });
    const second = controlledRuntime();
    mockState.runtimeQueue.push(first.runtime, second.runtime);
    const root = rootElement();
    const mounted = mount(root);

    expect(() => mount(root)).toThrow("already mounted");
    expect(createPhotoWebRuntime).toHaveBeenCalledOnce();
    expect(() => mounted.dispose()).not.toThrow();
    expect(root.replaceChildren).not.toBeUndefined();
    expect(root.childElementCount).toBe(0);
    expect(first.calls.slice(-2)).toEqual(["unsubscribe", "runtime.dispose"]);
    expect(mockState.viewUnmounts).toBe(1);

    mounted.dispose();
    expect(first.runtime.dispose).toHaveBeenCalledOnce();
    const remounted = mount(root);
    expect(createPhotoWebRuntime).toHaveBeenCalledTimes(2);
    remounted.dispose();
  });

  it("subscribe失敗時もruntimeを片付けてroot所有を解放する", () => {
    const failed = controlledRuntime({ subscribeError: new Error("subscribe failed") });
    const recovered = controlledRuntime();
    mockState.runtimeQueue.push(failed.runtime, recovered.runtime);
    const root = rootElement();

    expect(() => mount(root)).toThrow("subscribe failed");
    expect(failed.runtime.dispose).toHaveBeenCalledOnce();
    expect(root.childElementCount).toBe(0);

    const mounted = mount(root);
    mounted.dispose();
  });

  it("初回render失敗時もsubscription/runtime/rootを片付ける", () => {
    const controlled = controlledRuntime({ initial: snapshot({ dialogScopeKey: "throw-render" }) });
    mockState.runtimeQueue.push(controlled.runtime);
    const root = rootElement();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const preventExpectedError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", preventExpectedError);

    expect(() => mount(root)).toThrow("render failed");
    expect(controlled.calls).toContain("unsubscribe");
    expect(controlled.runtime.dispose).toHaveBeenCalledOnce();
    expect(root.childElementCount).toBe(0);
    window.removeEventListener("error", preventExpectedError);
    consoleError.mockRestore();
  });

  it("startの同期throwと非同期rejectをreadyだけで公開し、生の失敗をDOMへ出さない", async () => {
    const syncFailure = new Error("raw synchronous start failure");
    const asyncFailure = new Error("raw asynchronous start failure");
    const sync = controlledRuntime({ start: () => { throw syncFailure; } });
    const asynchronous = controlledRuntime({ start: () => Promise.reject(asyncFailure) });
    mockState.runtimeQueue.push(sync.runtime, asynchronous.runtime);

    const syncRoot = rootElement();
    const syncMounted = mount(syncRoot);
    await expect(syncMounted.ready).rejects.toBe(syncFailure);
    expect(syncRoot.textContent).not.toContain(syncFailure.message);
    expect(sync.runtime.dispose).toHaveBeenCalledOnce();
    expect(syncRoot.childElementCount).toBe(0);
    syncMounted.dispose();

    const asyncRoot = rootElement();
    const asyncMounted = mount(asyncRoot);
    await expect(asyncMounted.ready).rejects.toBe(asyncFailure);
    expect(asyncRoot.textContent).not.toContain(asyncFailure.message);
    expect(asynchronous.runtime.dispose).toHaveBeenCalledOnce();
    expect(asyncRoot.childElementCount).toBe(0);
    asyncMounted.dispose();
  });

  it("dispose後の遅着通知とstart完了を無視する", async () => {
    const start = deferred<void>();
    const controlled = controlledRuntime({ start: () => start.promise });
    mockState.runtimeQueue.push(controlled.runtime);
    const root = rootElement();
    const mounted = mount(root);

    mounted.dispose();
    controlled.notifyLate(snapshot({ dialogScopeKey: "late-authority", online: false }));
    start.resolve();

    await expect(mounted.ready).resolves.toBeUndefined();
    expect(root.childElementCount).toBe(0);
    expect(root.textContent).toBe("");
  });

  it("detachedまたは別document型ではないrootをruntime生成前に拒否する", () => {
    const detached = document.createElement("div");

    expect(() => mount(detached)).toThrow("attached to its current document");
    expect(createPhotoWebRuntime).not.toHaveBeenCalled();
  });
  it("defaultのruntime環境と異なるiframe documentのrootを拒否する", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const otherDocument = frame.contentDocument!;
    const root = otherDocument.createElement("div");
    otherDocument.body.append(root);
    const controlled = controlledRuntime();
    mockState.runtimeQueue.push(controlled.runtime);
    expect(() => mount(root)).toThrow("attached to its current document");
    expect(createPhotoWebRuntime).not.toHaveBeenCalled();
  });

});
