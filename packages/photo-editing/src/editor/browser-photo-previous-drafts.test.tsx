// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PHOTO_EDITING_DURABLE_DRAFT_COPY } from "../photo-editing-copy";
import {
  BrowserPhotoPreviousDraftsDialog,
  type BrowserPhotoPreviousDraftsModel,
} from "./browser-photo-previous-drafts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BrowserPhotoPreviousDraftsDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.querySelectorAll('[role="dialog"]').forEach((element) => element.remove());
  });

  const render = async (overrides: Partial<BrowserPhotoPreviousDraftsModel> = {}) => {
    const model: BrowserPhotoPreviousDraftsModel = {
      busy: false,
      message: null,
      items: [{
        photoName: "とても長い以前の写真名_折り返して表示するための確認用ファイル名_2026年11月.jpg",
        onOpen: vi.fn(),
      }],
      selected: null,
      hasNext: true,
      isFirst: true,
      onNext: vi.fn(),
      onFirst: vi.fn(),
      onBack: vi.fn(),
      onClose: vi.fn(),
      ...overrides,
    };
    await act(async () => root.render(<BrowserPhotoPreviousDraftsDialog model={model} />));
    return model;
  };

  it("明示一覧だけを表示し、長い写真名を折り返せる行とページ操作を持つ", async () => {
    const model = await render();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain(PHOTO_EDITING_DURABLE_DRAFT_COPY.previousDescription);
    expect(dialog?.textContent).toContain(model.items[0]?.photoName);
    expect(dialog?.querySelector("[data-radix-dialog-close]")).toBeNull();
    const fileName = Array.from(dialog?.querySelectorAll("span") ?? []).find((node) => node.textContent === model.items[0]?.photoName);
    expect(fileName?.className).toContain("break-words");
    const buttons = Array.from(dialog?.querySelectorAll("button") ?? []);
    act(() => buttons.find((button) => button.textContent?.includes(PHOTO_EDITING_DURABLE_DRAFT_COPY.previousOpen))?.click());
    act(() => buttons.find((button) => button.textContent === PHOTO_EDITING_DURABLE_DRAFT_COPY.previousNext)?.click());
    expect(model.items[0]?.onOpen).toHaveBeenCalledOnce();
    expect(model.onNext).toHaveBeenCalledOnce();
  });

  it("busy中は閉じず、選択後は一覧に戻る・編集に戻る・明示操作だけを出す", async () => {
    const action = vi.fn();
    const model = await render({
      busy: true,
      message: PHOTO_EDITING_DURABLE_DRAFT_COPY.unknown,
      selected: {
        photoName: "写真.jpg",
        actions: [{ label: PHOTO_EDITING_DURABLE_DRAFT_COPY.previousSave, onClick: action }],
      },
    });
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const buttons = Array.from(dialog?.querySelectorAll("button") ?? []);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(dialog?.textContent).not.toContain(PHOTO_EDITING_DURABLE_DRAFT_COPY.discard);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(model.onClose).not.toHaveBeenCalled();
  });
});
