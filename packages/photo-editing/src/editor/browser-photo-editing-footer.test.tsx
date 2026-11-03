// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserPhotoEditingFooter } from "./browser-photo-editing-footer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const exportButtonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <BrowserPhotoEditingFooter
      viewMode="grid"
      canOpenLoupe
      onShowGrid={() => undefined}
      onShowLoupe={() => undefined}
      statusLine={<button type="button">元に戻す</button>}
      showCompare={false}
      compareDisabled={false}
      compareOriginal={false}
      onCompareOriginalChange={() => undefined}
      exportButtonRef={exportButtonRef}
      exportSheetOpen={false}
      canExport
      exportChoices={null}
      onToggleExportSheet={() => undefined}
      onExport={() => undefined}
      onCloseExportSheet={() => undefined}
    />
  );
}

describe("BrowserPhotoEditingFooter keyboard order", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the narrow-screen visual order aligned with DOM and focus order", () => {
    const status = container.querySelector<HTMLElement>("footer > div.flex.min-w-0.flex-1");
    const footer = container.querySelector<HTMLElement>("footer");
    const viewGroup = container.querySelector<HTMLElement>('[role="group"][aria-label="表示"]');
    const viewSwitches = Array.from(viewGroup?.querySelectorAll("button") ?? []);
    const undoButton = status?.querySelector("button") ?? null;
    const exportButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "書き出す");
    const lastViewSwitch = viewSwitches.at(-1);

    expect(status?.className).toContain("max-[479px]:w-full");
    expect(status?.className).not.toContain("order-first");
    expect(footer?.className).toContain("lg:max-xl:flex-wrap");
    expect(footer?.className).toContain("lg:max-xl:gap-y-1");
    if (!lastViewSwitch || !undoButton || !exportButton) {
      throw new Error("表示切替・元に戻す・書き出すのボタンが見つかりません");
    }
    expect(lastViewSwitch.compareDocumentPosition(undoButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(undoButton.compareDocumentPosition(exportButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll("footer [aria-label='表示'] + div button")).toHaveLength(1);
  });
});

describe("BrowserPhotoEditingStatusLine recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("競合と残数を示し、PC/mobile共通の復元・破棄操作を出す", async () => {
    const { BrowserPhotoEditingStatusLine } = await import("./browser-photo-editing-footer");
    const onRestore = vi.fn();
    const onDiscard = vi.fn();
    act(() => root.render(
      <BrowserPhotoEditingStatusLine
        progressText={null}
        saveState="idle"
        onRetrySave={() => undefined}
        status={null}
        canAdd
        onRetryAdd={() => undefined}
        canStopAdd={false}
        onStopAdd={() => undefined}
        gridSourceError={null}
        pendingWorkText={null}
        showWideOnlyNote={false}
        recovery={{ count: 3, conflict: true, busy: false, onRestore, onDiscard }}
      />,
    ));
    expect(container.textContent).toContain("別の端末の編集後に、未保存の補正があります（ほか2件）");
    const buttons = Array.from(container.querySelectorAll("button"));
    act(() => buttons.find((button) => button.textContent === "復元")?.click());
    act(() => buttons.find((button) => button.textContent === "破棄")?.click());
    expect(onRestore).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it("durable競合の比較入口をPC/mobile共通の状態欄に出す", async () => {
    const { BrowserPhotoEditingStatusLine } = await import("./browser-photo-editing-footer");
    const compare = vi.fn();
    act(() => root.render(
      <BrowserPhotoEditingStatusLine
        progressText={null}
        saveState="failed"
        onRetrySave={() => undefined}
        status={null}
        canAdd
        onRetryAdd={() => undefined}
        canStopAdd={false}
        onStopAdd={() => undefined}
        gridSourceError={null}
        pendingWorkText={null}
        showWideOnlyNote={false}
        recovery={{
          count: 1,
          conflict: true,
          busy: false,
          message: "別の端末の補正と競合しています",
          onRestore: () => undefined,
          onDiscard: () => undefined,
          actions: [{ label: "比較する", onClick: compare }],
        }}
      />,
    ));
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["比較する"]);
    act(() => buttons[0]?.click());
    expect(compare).toHaveBeenCalledOnce();
  });
});

describe("BrowserPhotoEditingFooter flags (niho-photo#47)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function FlagHarness(props: { flag?: boolean }) {
    const exportButtonRef = useRef<HTMLButtonElement | null>(null);
    return (
      <BrowserPhotoEditingFooter
        viewMode="loupe"
        canOpenLoupe
        onShowGrid={() => undefined}
        onShowLoupe={() => undefined}
        statusLine={null}
        favorite={{ photoId: "p1", favorite: false, busy: false, disabled: false, onToggle: () => undefined }}
        flag={
          props.flag
            ? { flag: "pick", available: true, busy: false, disabled: false, onSet: () => undefined }
            : undefined
        }
        showCompare={false}
        compareDisabled={false}
        compareOriginal={false}
        onCompareOriginalChange={() => undefined}
        exportButtonRef={exportButtonRef}
        exportSheetOpen={false}
        canExport
        exportChoices={null}
        onToggleExportSheet={() => undefined}
        onExport={() => undefined}
        onCloseExportSheet={() => undefined}
      />
    );
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("選別の 3 つのボタンを ♥ の隣（PC だけ）に出し、渡さなければ出さない", () => {
    act(() => root.render(<FlagHarness flag />));
    const heart = container.querySelector('button[aria-label="お気に入り"]');
    const group = container.querySelector<HTMLElement>('[role="group"][aria-label="選別"]');
    expect(group).not.toBeNull();
    expect(heart?.nextElementSibling).toBe(group);
    expect(group?.className).toContain("hidden");
    expect(group?.className).toContain("lg:flex");
    expect(group?.querySelector('button[aria-label="採用"]')?.getAttribute("aria-pressed")).toBe("true");

    act(() => root.render(<FlagHarness />));
    expect(container.querySelector('[role="group"][aria-label="選別"]')).toBeNull();
  });
});
