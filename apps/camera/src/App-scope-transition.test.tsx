import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { PhotoEditingLeaveGuard } from "niho-photo-editing/editor/browser-photo-editing-model";

import { App, type PersonalCloudPhotoBinding } from "./App";
import { createCameraCommands } from "./local-library/commands";
import { createLocalPhotoLibrary } from "./local-library/local-photo-library";
import { createLocalPhotoEditingHost } from "./local-library/local-photo-editing-host";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const controls = vi.hoisted(() => ({ guard: (() => Promise.resolve(true)) as PhotoEditingLeaveGuard, mounts: 0 }));
vi.mock("./camera-account", () => ({ CameraAccount: () => null }));
vi.mock("niho-photo-editing/editor/browser-photo-editing-workbench", async () => {
  const { createElement, useEffect } = await import("react");
  return { BrowserPhotoEditingWorkbench(props: {
    actorId: string; spotId: string; registerRouteLeaveGuard: (guard: PhotoEditingLeaveGuard | null) => void;
  }) {
    const register = props.registerRouteLeaveGuard;
    useEffect(() => { controls.mounts++; }, []);
    useEffect(() => {
      register((options) => controls.guard(options));
      return () => register(null);
    }, [register]);
    return createElement("output", { "data-testid": "editor-owner", "data-library": props.spotId }, props.actorId);
  } };
});

it("keeps the local editor mounted when a cloud destination connects or changes owner", async () => {
  const commands = createCameraCommands(async <T,>(command: string) => {
    if (command === "camera_photo_bench_edits") return { found: false } as T;
    throw new Error("unexpected native command");
  });
  const local = createLocalPhotoLibrary(commands);
  const cloud: PersonalCloudPhotoBinding["library"] = {
    ...local, place: "cloud", initialCapabilities: { ...local.initialCapabilities, place: "cloud" },
  };
  const host = createLocalPhotoEditingHost(commands);
  const binding = (actorId: string): PersonalCloudPhotoBinding => ({ actorId,
    scopeKey: JSON.stringify([actorId, "library", "session", "epoch", "mac-bearer"]),
    library: cloud, host, copyLocalPhoto: async () => ({ cloudPhotoId: "synthetic-photo" }),
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const loadAppInfo = async () => null;
  const watchUpdate = async () => () => undefined;
  const render = async (cloudBinding?: PersonalCloudPhotoBinding) => {
    await act(async () => root.render(<App commands={commands} loadAppInfo={loadAppInfo}
      watchUpdate={watchUpdate} cloudBinding={cloudBinding} />));
  };
  controls.mounts = 0;
  try {
    await render();
    expect(controls.mounts).toBe(1);
    await render(binding("synthetic-owner-a"));
    expect(controls.mounts).toBe(1);
    await render(binding("synthetic-owner-b"));
    expect(controls.mounts).toBe(1);
    expect(container.querySelector('[data-testid="editor-owner"]')?.textContent).toBe("local");
    expect(container.querySelector('[data-testid="editor-owner"]')?.getAttribute("data-library")).toBe("local");
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});

it.each(["never", "late"])("unlocks the new owner's tabs and fences the %s previous guard", async (previous) => {
  const commands = createCameraCommands(async <T,>(command: string) => {
    if (command === "camera_photo_bench_edits") return { found: false } as T;
    throw new Error("unexpected native command");
  });
  const local = createLocalPhotoLibrary(commands);
  const cloud: PersonalCloudPhotoBinding["library"] = {
    ...local, place: "cloud", initialCapabilities: { ...local.initialCapabilities, place: "cloud" },
  };
  const host = createLocalPhotoEditingHost(commands);
  const makeBinding = (actorId: string): PersonalCloudPhotoBinding => ({
    actorId, scopeKey: JSON.stringify([actorId, "library", "session", "epoch", "mac-bearer"]),
    library: cloud, host, copyLocalPhoto: async () => ({ cloudPhotoId: "synthetic-photo" }),
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const loadAppInfo = async () => null;
  const watchUpdate = async () => () => undefined;
  const render = async (binding: PersonalCloudPhotoBinding) => {
    await act(async () => { root.render(<App commands={commands} loadAppInfo={loadAppInfo} watchUpdate={watchUpdate} cloudBinding={binding} />); });
  };
  const cloudTab = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "クラウド")!;
  try {
    let finishOld: (value: boolean) => void = () => undefined;
    controls.guard = () => new Promise<boolean>(resolve => { finishOld = resolve; });
    await render(makeBinding("synthetic-owner-a"));
    await act(async () => cloudTab().click());
    expect(cloudTab().disabled).toBe(true);
    controls.guard = async () => true;
    await render(makeBinding("synthetic-owner-b"));
    expect(container.querySelector('[data-testid="editor-owner"]')?.textContent).toBe("local");
    expect(cloudTab().disabled).toBe(false);
    let finishNew: (value: boolean) => void = () => undefined;
    controls.guard = () => new Promise<boolean>(resolve => { finishNew = resolve; });
    await act(async () => cloudTab().click());
    expect(cloudTab().disabled).toBe(true);
    if (previous === "late") await act(async () => finishOld(true));
    expect(cloudTab().disabled).toBe(true);
    await act(async () => finishNew(true));
    expect(cloudTab().getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-testid="editor-owner"]')?.textContent).toBe("synthetic-owner-b");
  } finally {
    await act(async () => root.unmount()); container.remove();
    controls.guard = async () => true;
  }
});
