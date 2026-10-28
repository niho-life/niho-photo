// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopLinearMask, DevelopMask, DevelopRadialMask, DevelopSurfaceMask } from "../develop-engine/develop-masks";
import { PHOTO_EDITING_MASK_BRUSH_DEFAULT } from "../photo-editing-mask-brush";

import { PhotoEditingMaskMobileTools, type PhotoEditingMaskMobileToolsProps } from "./photo-editing-mask-mobile-tools";
import type { BrowserPhotoMaskBrush } from "./use-browser-photo-mask-brush";

/**
 * スマホの全体の編集の層の「マスク」の段（niho-photo#93）。足す（線形・円形・ブラシ。押せない理由）・範囲を表示・初期化、一覧のチップ、
 * 選んだマスクの操作（表示・反転・複製・削除）、補正の種類（ブラシ／ライト／カラー／カラーミキサー／効果／形）と、その項目のチップ・
 * 目盛り。押せる範囲はどれも 44px（見た目 32px のチップの上下を広げる）。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINEAR: DevelopLinearMask = {
  id: "mask-a",
  kind: "linear",
  enabled: true,
  invert: false,
  zero: { x: 0.5, y: 0.55 },
  full: { x: 0.5, y: 0.3 },
  adjust: { exposure: -0.5 },
};
const RADIAL: DevelopRadialMask = {
  id: "mask-b",
  kind: "radial",
  enabled: false,
  invert: true,
  center: { x: 0.5, y: 0.5 },
  radius: { x: 0.2, y: 0.25 },
  angle: 0,
  feather: 50,
  adjust: {},
};
const BRUSH: DevelopSurfaceMask = {
  id: "mask-c",
  kind: "brush",
  enabled: true,
  invert: false,
  surface: { id: "a".repeat(64), width: 1024, height: 683 },
  adjust: {},
};

let container: HTMLDivElement;
let root: Root;
let props: PhotoEditingMaskMobileToolsProps;

function fakeBrush(mask: DevelopSurfaceMask | null, overrides: Partial<BrowserPhotoMaskBrush> = {}): BrowserPhotoMaskBrush {
  return {
    available: true,
    mask,
    brush: { ...PHOTO_EDITING_MASK_BRUSH_DEFAULT },
    setSize: vi.fn(),
    stepSize: vi.fn(),
    setFeather: vi.fn(),
    setFlow: vi.fn(),
    setErase: vi.fn(),
    toggleErase: vi.fn(),
    paintMode: true,
    leavePaint: vi.fn(),
    resumePaint: vi.fn(),
    layerVisible: mask !== null,
    canPaint: mask !== null,
    status: mask ? "ready" : "idle",
    saving: false,
    notice: null,
    frame: null,
    startStroke: vi.fn(() => null),
    discardStroke: vi.fn(),
    clear: vi.fn(),
    fill: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  } as BrowserPhotoMaskBrush;
}

function baseProps(overrides: Partial<PhotoEditingMaskMobileToolsProps> = {}): PhotoEditingMaskMobileToolsProps {
  return {
    masks: [LINEAR, RADIAL],
    selected: LINEAR,
    select: vi.fn(),
    kinds: ["linear", "radial", "brush"],
    canAdd: true,
    addBlockedReason: null,
    whiteBalanceAbsolute: false,
    overlayVisible: false,
    setOverlayVisible: vi.fn(),
    add: vi.fn(),
    duplicate: vi.fn(),
    remove: vi.fn(),
    toggleEnabled: vi.fn(),
    toggleInvert: vi.fn(),
    changeAdjust: vi.fn(),
    changeFeather: vi.fn(),
    changeHsl: vi.fn(),
    resetHsl: vi.fn(),
    grayscale: false,
    brush: fakeBrush(null),
    disabled: false,
    canReset: true,
    onReset: vi.fn(),
    ...overrides,
  } as PhotoEditingMaskMobileToolsProps;
}

async function render(overrides: Partial<PhotoEditingMaskMobileToolsProps> = {}) {
  props = baseProps(overrides);
  await act(async () => {
    root.render(<PhotoEditingMaskMobileTools {...props} />);
  });
}

function toolbar(label: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[role="toolbar"][aria-label="${label}"]`);
  if (!found) throw new Error(`toolbar not found: ${label}`);
  return found;
}

function texts(element: HTMLElement): string[] {
  return Array.from(element.querySelectorAll("button")).map((button) => button.textContent ?? "");
}

function byLabel(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function byText(scope: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    (button.textContent ?? "").startsWith(text),
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found;
}

function ruler(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-testid="photo-editing-ruler"]');
  if (!found) throw new Error("ruler not found");
  return found;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function keyOn(element: Element, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
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

describe("PhotoEditingMaskMobileTools", () => {
  it("1 行目: 足す（見える名前は短く、読み上げは PC と同じ）・範囲を表示（スイッチ）・初期化。押せる範囲は 44px", async () => {
    await render();
    const add = toolbar("マスクを追加");
    expect(texts(add)).toEqual(["線形", "円形", "ブラシ", "範囲を表示", "初期化"]);
    const linear = byLabel("線形グラデーション");
    expect(linear.textContent).toBe("線形");
    // 見た目 32px（h-8）の上下を広げて 44px
    expect(linear.className).toContain("h-8");
    expect(linear.className).toContain("after:-inset-y-1.5");
    await click(byLabel("円形グラデーション"));
    expect(props.add).toHaveBeenCalledWith("radial");
    await click(byLabel("ブラシ"));
    expect(props.add).toHaveBeenCalledWith("brush");
    const overlay = byLabel("マスクの範囲を表示");
    expect(overlay.getAttribute("role")).toBe("switch");
    expect(overlay.getAttribute("aria-checked")).toBe("false");
    await click(overlay);
    expect(props.setOverlayVisible).toHaveBeenCalledWith(true);
    await click(byText(add, "初期化"));
    expect(props.onReset).toHaveBeenCalledTimes(1);
    // マスクが無い（戻すものが無い）ときは出さない。ブラシを足せない出どころには出さない
    await render({ canReset: false, kinds: ["linear", "radial"], masks: [], selected: null });
    expect(texts(toolbar("マスクを追加"))).toEqual(["線形", "円形", "範囲を表示"]);
    expect(container.textContent).toContain("まだマスクはありません");
  });

  it("写真から作れる出どころでは「被写体」を足せ、探している間は 1 行と取り消し（押せる範囲 44px）を出す（niho-photo#135）", async () => {
    await render({ kinds: ["linear", "radial", "brush", "subject"] });
    expect(texts(toolbar("マスクを追加"))).toEqual(["線形", "円形", "ブラシ", "被写体", "範囲を表示", "初期化"]);
    await click(byLabel("被写体"));
    expect(props.add).toHaveBeenCalledWith("subject");

    const cancelDetect = vi.fn();
    await render({ kinds: ["linear", "radial", "brush", "subject"], canAdd: false, detecting: "subject", cancelDetect });
    const status = container.querySelector<HTMLElement>('[data-testid="photo-mask-detecting"]')!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toContain("被写体を探しています…");
    const cancel = byText(status, "キャンセル");
    expect(cancel.className).toContain("min-h-11");
    await click(cancel);
    expect(cancelDetect).toHaveBeenCalledTimes(1);
    expect(byLabel("被写体").disabled).toBe(true);
  });

  it("足せない間はボタンを押せず、理由を 1 行出す（読み上げはボタンの説明に結ぶ）。複製も押せない", async () => {
    const reason = "マスクは 8 枚までです。使わないマスクを削除すると追加できます。";
    await render({ canAdd: false, addBlockedReason: reason });
    const add = byLabel("線形グラデーション");
    expect(add.disabled).toBe(true);
    expect(container.textContent).toContain(reason);
    const describedBy = add.getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(reason);
    expect(byLabel("線形 1 を複製").disabled).toBe(true);
  });

  it("一覧は種類の印と名前のチップ（選んだものは aria-pressed）。押すと選び、もう一度で外す", async () => {
    await render();
    const list = toolbar("マスクの一覧");
    expect(texts(list)).toEqual(["線形 1", "円形 2"]);
    expect(byLabel("線形 1 を選ぶ").getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("円形 2 を選ぶ").getAttribute("aria-pressed")).toBe("false");
    // 当てていないマスクは薄く
    expect(byLabel("円形 2 を選ぶ").className).toContain("opacity-50");
    await click(byLabel("円形 2 を選ぶ"));
    expect(props.select).toHaveBeenLastCalledWith("mask-b");
    await click(byLabel("線形 1 を選ぶ"));
    expect(props.select).toHaveBeenLastCalledWith(null);
  });

  it("選んだマスクの操作: 表示・反転（押されている状態）・複製・削除。押せない間は押せない", async () => {
    await render({ selected: RADIAL });
    const actions = toolbar("円形 2 の操作");
    expect(texts(actions)).toEqual(["表示", "反転", "複製", "削除"]);
    expect(byLabel("円形 2 を当てる").getAttribute("aria-pressed")).toBe("false");
    expect(byLabel("円形 2 を反転").getAttribute("aria-pressed")).toBe("true");
    await click(byLabel("円形 2 を当てる"));
    expect(props.toggleEnabled).toHaveBeenCalledWith("mask-b");
    await click(byLabel("円形 2 を反転"));
    expect(props.toggleInvert).toHaveBeenCalledWith("mask-b");
    await click(byLabel("円形 2 を複製"));
    expect(props.duplicate).toHaveBeenCalledWith("mask-b");
    await click(byLabel("円形 2 を削除"));
    expect(props.remove).toHaveBeenCalledWith("mask-b");
    await render({ selected: RADIAL, disabled: true });
    expect(byLabel("円形 2 を削除").disabled).toBe(true);
    expect(byLabel("線形グラデーション").disabled).toBe(true);
    // 選ぶのは見るだけなのでできる
    expect(byLabel("線形 1 を選ぶ").disabled).toBe(false);
  });

  it("補正の種類はライト → カラー → カラーミキサー → 効果（円形は形も）。項目のチップ（既定でない値を添える）と目盛り 1 本", async () => {
    await render();
    expect(container.textContent).toContain("写真の上の点をドラッグして");
    const tabs = toolbar("線形 1 の補正");
    expect(texts(tabs)).toEqual(["ライト", "カラー", "カラーミキサー", "効果"]);
    expect(byText(tabs, "ライト").getAttribute("aria-pressed")).toBe("true");
    const items = toolbar("ライトの項目");
    expect(texts(items)).toEqual(["露光量-0.50", "コントラスト", "ハイライト", "シャドウ", "白レベル", "黒レベル"]);
    expect(ruler().getAttribute("aria-valuenow")).toBe("-0.5");
    await keyOn(ruler(), "ArrowRight");
    expect(props.changeAdjust).toHaveBeenLastCalledWith("mask-a", "exposure", -0.49, "commit");
    await click(byText(items, "コントラスト"));
    expect(byText(toolbar("ライトの項目"), "コントラスト").getAttribute("aria-pressed")).toBe("true");
    await keyOn(ruler(), "ArrowLeft");
    expect(props.changeAdjust).toHaveBeenLastCalledWith("mask-a", "contrast", -1, "commit");

    await click(byText(tabs, "カラー"));
    expect(texts(toolbar("カラーの項目"))).toEqual(["色温度", "色かぶり補正", "自然な彩度", "彩度"]);
    // 全体の白が absolute の間は相対の白を出さない
    await render({ whiteBalanceAbsolute: true });
    await click(byText(toolbar("線形 1 の補正"), "カラー"));
    expect(texts(toolbar("カラーの項目"))).toEqual(["自然な彩度", "彩度"]);

    await render({ selected: RADIAL });
    const radialTabs = toolbar("円形 2 の補正");
    expect(texts(radialTabs)).toEqual(["ライト", "カラー", "カラーミキサー", "効果", "形"]);
    await click(byText(radialTabs, "形"));
    expect(texts(toolbar("形の項目"))).toEqual(["ぼかし"]);
    await keyOn(ruler(), "ArrowRight");
    expect(props.changeFeather).toHaveBeenLastCalledWith("mask-b", 51, "commit");
  });

  it("カラーミキサーは全体と同じ 3 択と 8 本のスライダー（マスクの差分）。初期化はこのマスクの値だけ", async () => {
    const edited: DevelopMask = { ...LINEAR, adjust: { hsl: { blue: { hue: 0, saturation: -40, luminance: 0 } } } };
    await render({ masks: [edited], selected: edited });
    await click(byText(toolbar("線形 1 の補正"), "カラーミキサー"));
    const hsl = container.querySelector<HTMLElement>('[data-testid="photo-mask-mobile-hsl"]')!;
    expect(hsl.querySelector('[role="group"][aria-label="調整"]')).not.toBeNull();
    expect(hsl.querySelectorAll('input[type="range"]')).toHaveLength(8);
    await click(Array.from(hsl.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="調整"] button'))[1]!);
    expect(hsl.querySelector<HTMLInputElement>('input[aria-label="青"]')?.value).toBe("-40");
    await act(async () => {
      hsl.querySelector('input[aria-label="青"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(props.changeHsl).toHaveBeenLastCalledWith("mask-a", "blue", "saturation", 0, "commit");
    await click(byLabel("このマスクのカラーミキサーを初期化"));
    expect(props.resetHsl).toHaveBeenCalledWith("mask-a");
  });

  it("ブラシのマスクはブラシの段から: 描く / 消しゴム・全体を塗る / 消す（44px のチップ）と、大きさ・ぼかし・流量の目盛り", async () => {
    const brush = fakeBrush(BRUSH);
    await render({ masks: [LINEAR, BRUSH], selected: BRUSH, brush });
    const tabs = toolbar("ブラシ 2 の補正");
    expect(texts(tabs)).toEqual(["ブラシ", "ライト", "カラー", "カラーミキサー", "効果"]);
    expect(byText(tabs, "ブラシ").getAttribute("aria-pressed")).toBe("true");
    const modes = toolbar("ブラシ");
    expect(texts(modes)).toEqual(["描く", "消しゴム", "全体を塗る", "全体を消す"]);
    expect(byText(modes, "描く").getAttribute("aria-pressed")).toBe("true");
    expect(byText(modes, "消しゴム").className).toContain("after:-inset-y-1.5");
    await click(byText(modes, "消しゴム"));
    expect(brush.setErase).toHaveBeenCalledWith(true);
    await click(byText(modes, "全体を塗る"));
    expect(brush.fill).toHaveBeenCalledTimes(1);
    await click(byText(modes, "全体を消す"));
    expect(brush.clear).toHaveBeenCalledTimes(1);
    expect(texts(toolbar("ブラシの項目"))).toEqual(["大きさ", "ぼかし", "流量"]);
    await keyOn(ruler(), "ArrowRight");
    expect(brush.setSize).toHaveBeenLastCalledWith(6.5);
    await click(byText(toolbar("ブラシの項目"), "流量"));
    await keyOn(ruler(), "ArrowLeft");
    expect(brush.setFlow).toHaveBeenLastCalledWith(49);
    expect(container.textContent).toContain("1 本の指で写真をなぞって塗ります");
    // 塗るのをやめた後は「写真に塗る」で戻る
    await render({ masks: [LINEAR, BRUSH], selected: BRUSH, brush: fakeBrush(BRUSH, { paintMode: false }) });
    await click(byText(toolbar("ブラシ"), "写真に塗る"));
    expect(props.brush?.resumePaint).toHaveBeenCalledTimes(1);
    // 面を読めない間は全体を塗れない
    await render({ masks: [LINEAR, BRUSH], selected: BRUSH, brush: fakeBrush(BRUSH, { status: "loading" }) });
    expect(byText(toolbar("ブラシ"), "全体を塗る").disabled).toBe(true);
    expect(container.textContent).toContain("マスクの面を読み込んでいます");
  });

  it("面を読めないときは理由と「もう一度読み込む」を出す", async () => {
    const retrySurfaces = vi.fn();
    await render({ notice: "マスクの面を読めません（ブラシ 2）。", canRetrySurfaces: true, retrySurfaces });
    expect(container.querySelector('[data-testid="photo-mask-notice"]')?.textContent).toContain("マスクの面を読めません");
    await click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "もう一度読み込む")!);
    expect(retrySurfaces).toHaveBeenCalledTimes(1);
  });
});
