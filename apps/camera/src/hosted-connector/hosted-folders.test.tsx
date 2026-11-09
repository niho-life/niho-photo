import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PHOTO_EDITING_ADD_FOLDER_FAILED_TEXT,
  PHOTO_EDITING_ADD_FOLDER_LABEL,
  PHOTO_EDITING_FORGET_FOLDER_CONFIRM_LABEL,
  PHOTO_EDITING_FORGET_FOLDER_LABEL,
  PHOTO_EDITING_FORGET_FOLDER_TITLE,
  PHOTO_EDITING_LOCAL_PLACE_LABEL,
  photoEditingForgetFolderDescription,
} from "niho-photo-editing/photo-editing-copy";

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock("niho-ui/app-dialog", () => ({ appDialog: { confirm } }));

import type { Invoke } from "../camera-bridge";
import { HostedFolderList, createHostedFolderCommands, type HostedFolder, type HostedFolderCommands } from "./hosted-folders";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  confirm.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function fakeCommands(initial: HostedFolder[]) {
  const folders = [...initial];
  const commands: HostedFolderCommands & { failAdd: boolean } = {
    failAdd: false,
    list: vi.fn(async () => [...folders]),
    add: vi.fn(async () => {
      if (commands.failAdd) throw new Error("picker failed");
      const folder = { id: `root-${folders.length + 1}`, name: "Trip 2026", available: true };
      folders.push(folder);
      return folder;
    }),
    remove: vi.fn(async (id: string) => {
      const index = folders.findIndex((folder) => folder.id === id);
      if (index >= 0) folders.splice(index, 1);
    }),
  };
  return commands;
}

async function render(commands: HostedFolderCommands) {
  await act(async () => root.render(<HostedFolderList commands={commands} />));
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(name));
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

describe("HostedFolderList", () => {
  it("lists registered folders by name and adds one with the native picker", async () => {
    const commands = fakeCommands([{ id: "root-1", name: "Photos", available: true }]);
    await render(commands);
    expect(container.querySelector("h2")?.textContent).toBe(PHOTO_EDITING_LOCAL_PLACE_LABEL);
    expect([...container.querySelectorAll("li")].map((item) => item.textContent)).toEqual([`Photos${PHOTO_EDITING_FORGET_FOLDER_LABEL}`]);
    await act(async () => button(PHOTO_EDITING_ADD_FOLDER_LABEL).click());
    expect(commands.add).toHaveBeenCalledTimes(1);
    expect([...container.querySelectorAll("li")].map((item) => item.textContent?.replace(PHOTO_EDITING_FORGET_FOLDER_LABEL, ""))).toEqual(["Photos", "Trip 2026"]);
  });

  it("asks before removing and removes only the registration", async () => {
    const commands = fakeCommands([{ id: "root-1", name: "Photos", available: true }]);
    await render(commands);
    await act(async () => button(PHOTO_EDITING_FORGET_FOLDER_LABEL).click());
    expect(confirm).toHaveBeenCalledWith({
      title: PHOTO_EDITING_FORGET_FOLDER_TITLE,
      description: photoEditingForgetFolderDescription("Photos"),
      confirmLabel: PHOTO_EDITING_FORGET_FOLDER_CONFIRM_LABEL,
    });
    expect(commands.remove).toHaveBeenCalledWith("root-1");
    expect(container.querySelectorAll("li")).toHaveLength(0);

    confirm.mockResolvedValueOnce(false);
    const kept = fakeCommands([{ id: "root-2", name: "Archive", available: false }]);
    await render(kept);
    await act(async () => button(PHOTO_EDITING_FORGET_FOLDER_LABEL).click());
    expect(kept.remove).not.toHaveBeenCalled();
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });

  it("shows the existing failure line and no other text", async () => {
    const commands = fakeCommands([]);
    commands.failAdd = true;
    await render(commands);
    await act(async () => button(PHOTO_EDITING_ADD_FOLDER_LABEL).click());
    expect(container.querySelector("[role=alert]")?.textContent).toBe(PHOTO_EDITING_ADD_FOLDER_FAILED_TEXT);
    // 説明文を足さない: 見出し・追加・失敗の 1 行だけ
    expect(container.textContent).toBe(`${PHOTO_EDITING_LOCAL_PLACE_LABEL}${PHOTO_EDITING_ADD_FOLDER_LABEL}${PHOTO_EDITING_ADD_FOLDER_FAILED_TEXT}`);
  });
});

describe("createHostedFolderCommands", () => {
  it("passes only the folder ID and drops malformed answers", async () => {
    const calls: Array<[string, unknown]> = [];
    const invoke = (async (command: string, args?: unknown) => {
      calls.push([command, args]);
      if (command === "camera_hosted_folders_list") return [{ id: "root-1", name: "Photos", available: true }, { id: 1 }];
      if (command === "camera_hosted_folders_add") return null;
      return undefined;
    }) as Invoke;
    const commands = createHostedFolderCommands(invoke);
    expect(await commands.list()).toEqual([{ id: "root-1", name: "Photos", available: true }]);
    expect(await commands.add()).toBeNull();
    await commands.remove("root-1");
    expect(calls).toEqual([
      ["camera_hosted_folders_list", undefined],
      ["camera_hosted_folders_add", undefined],
      ["camera_hosted_folders_remove", { request: { id: "root-1" } }],
    ]);
  });
});
