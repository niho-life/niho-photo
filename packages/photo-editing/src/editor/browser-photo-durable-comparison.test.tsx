// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ paintDevelopFrame: vi.fn() }));
vi.mock("../develop-engine/develop-frame", () => ({ paintDevelopFrame: mocks.paintDevelopFrame }));

import type { DevelopFrame } from "../develop-engine/develop-engine-client";
import { PHOTO_EDITING_DURABLE_DRAFT_COPY } from "../photo-editing-copy";
import { BrowserPhotoDurableComparisonDialog, type BrowserPhotoDurableComparisonModel } from "./browser-photo-durable-comparison";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const frame = (marker: number): DevelopFrame => ({ width: 1, height: 1, rgba: new Uint8ClampedArray([marker, 0, 0, 255]) });

describe("BrowserPhotoDurableComparisonDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.paintDevelopFrame.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.querySelectorAll('[role="dialog"]').forEach((element) => element.remove());
  });

  const render = async (overrides: Partial<BrowserPhotoDurableComparisonModel> = {}) => {
    const model: BrowserPhotoDurableComparisonModel = {
      photoName: "海辺.jpg",
      loading: false,
      candidateFrame: frame(1),
      currentFrame: frame(2),
      candidateReason: null,
      currentReason: null,
      canAdopt: true,
      busy: false,
      onAdopt: vi.fn(),
      onKeepCurrent: vi.fn(),
      onSaveData: vi.fn(),
      onClose: vi.fn(),
      ...overrides,
    };
    await act(async () => root.render(<BrowserPhotoDurableComparisonDialog model={model} />));
    return model;
  };

  it("写真名と端末側/currentの固定previewを別canvasで示し、同じ面から選択・保存できる", async () => {
    const model = await render();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("海辺.jpg");
    expect(dialog?.textContent).toContain(PHOTO_EDITING_DURABLE_DRAFT_COPY.devicePreview);
    expect(dialog?.textContent).toContain(PHOTO_EDITING_DURABLE_DRAFT_COPY.currentPreview);
    expect(dialog?.querySelectorAll("canvas")).toHaveLength(2);
    expect(mocks.paintDevelopFrame).toHaveBeenCalledTimes(2);
    const buttons = Array.from(dialog?.querySelectorAll("button") ?? []);
    act(() => buttons.find((button) => button.textContent === PHOTO_EDITING_DURABLE_DRAFT_COPY.useDevice)?.click());
    act(() => buttons.find((button) => button.textContent === PHOTO_EDITING_DURABLE_DRAFT_COPY.useCurrent)?.click());
    act(() => buttons.find((button) => button.textContent === PHOTO_EDITING_DURABLE_DRAFT_COPY.saveData)?.click());
    expect(model.onAdopt).toHaveBeenCalledOnce();
    expect(model.onKeepCurrent).toHaveBeenCalledOnce();
    expect(model.onSaveData).toHaveBeenCalledOnce();
  });

  it("candidateを描けない場合は偽の画像を置かず採用を隠し、現在維持と戻るを残す", async () => {
    const model = await render({
      candidateFrame: null,
      candidateReason: PHOTO_EDITING_DURABLE_DRAFT_COPY.unsupportedPreview,
      canAdopt: false,
    });
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain(PHOTO_EDITING_DURABLE_DRAFT_COPY.unsupportedPreview);
    expect(dialog?.querySelectorAll("canvas")).toHaveLength(1);
    expect(Array.from(dialog?.querySelectorAll("button") ?? []).some((button) =>
      button.textContent === PHOTO_EDITING_DURABLE_DRAFT_COPY.useDevice)).toBe(false);
    act(() => Array.from(dialog?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent === PHOTO_EDITING_DURABLE_DRAFT_COPY.useCurrent)?.click());
    expect(model.onKeepCurrent).toHaveBeenCalledOnce();
  });
});
