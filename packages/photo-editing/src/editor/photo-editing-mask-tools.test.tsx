// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopLinearMask, DevelopMask, DevelopRadialMask } from "../develop-engine/develop-masks";

import { neutralDevelopSettings } from "../develop-engine/develop-settings";

import { BrowserPhotoEditingAdjustments } from "./browser-photo-editing-adjustments";
import { PhotoEditingMaskTools, type PhotoEditingMaskToolsProps } from "./photo-editing-mask-tools";

/**
 * 右パネルのマスクの面（M3 #67）: 足すボタン（押せない理由）・一覧の行の操作・範囲の重ね表示・選んだマスクの局所のスライダー
 * （drag / commit・ダブルクリック・相対の白の出し分け・円形のぼかし）。
 */

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

let container: HTMLDivElement;
let root: Root;
let props: PhotoEditingMaskToolsProps;

function baseProps(overrides: Partial<PhotoEditingMaskToolsProps> = {}): PhotoEditingMaskToolsProps {
  return {
    masks: [LINEAR, RADIAL],
    selected: LINEAR,
    select: vi.fn(),
    kinds: ["linear", "radial"],
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
    disabled: false,
    ...overrides,
  } as PhotoEditingMaskToolsProps;
}

async function render(overrides: Partial<PhotoEditingMaskToolsProps> = {}) {
  props = baseProps(overrides);
  await act(async () => {
    root.render(<PhotoEditingMaskTools {...props} />);
  });
}

function button(label: string): HTMLButtonElement {
  const found =
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function slider(label: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`);
  if (!found) throw new Error(`slider not found: ${label}`);
  return found;
}

function sliderLabels(): string[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]')).map(
    (input) => input.getAttribute("aria-label") ?? "",
  );
}

function setRangeValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PhotoEditingMaskTools", () => {
  it("描ける種類の足すボタンを出し、押すとその種類を足す", async () => {
    await render({ kinds: ["linear", "radial"] });
    expect(container.textContent).toContain("マスクを追加");
    await click(button("円形グラデーション"));
    expect(props.add).toHaveBeenCalledWith("radial");
    await render({ kinds: ["linear"] });
    expect(() => button("円形グラデーション")).toThrow();
  });

  it("写真から作れる出どころでは「被写体」を出し、探している間は 1 行と取り消しを出す（niho-photo#135）", async () => {
    await render({ kinds: ["linear", "radial", "subject"] });
    await click(button("被写体"));
    expect(props.add).toHaveBeenCalledWith("subject");
    expect(container.querySelector('[data-testid="photo-mask-detecting"]')).toBeNull();

    const cancelDetect = vi.fn();
    await render({ kinds: ["linear", "radial", "subject"], canAdd: false, detecting: "subject", cancelDetect });
    const status = container.querySelector('[data-testid="photo-mask-detecting"]');
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toContain("被写体を探しています…");
    expect(button("被写体").disabled).toBe(true);
    await click(button("キャンセル"));
    expect(cancelDetect).toHaveBeenCalledTimes(1);
  });

  it("足せない間はボタンを押せず、理由を見える文で出す（読み上げはボタンの説明に結ぶ）", async () => {
    const reason = "マスクは 8 枚までです。使わないマスクを削除すると追加できます。";
    await render({ canAdd: false, addBlockedReason: reason });
    const add = button("線形グラデーション");
    expect(add.disabled).toBe(true);
    expect(container.textContent).toContain(reason);
    const describedBy = add.getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(reason);
    // 複製も押せない
    expect(button("線形 1 を複製").disabled).toBe(true);
  });

  it("一覧の行: 名前（種類と番号）・選択・目・反転・複製・削除（読み上げ名・押されている状態・押せる範囲 24px）", async () => {
    await render();
    expect(Array.from(container.querySelectorAll("[data-mask-row]")).map((row) => row.textContent)).toEqual(["線形 1", "円形 2"]);
    expect(button("線形 1 を選ぶ").getAttribute("aria-pressed")).toBe("true");
    expect(button("円形 2 を選ぶ").getAttribute("aria-pressed")).toBe("false");
    expect(button("円形 2 を当てる").getAttribute("aria-pressed")).toBe("false");
    expect(button("円形 2 を反転").getAttribute("aria-pressed")).toBe("true");
    expect(button("円形 2 を削除").className).toContain("h-6 w-6");
    await click(button("円形 2 を選ぶ"));
    expect(props.select).toHaveBeenLastCalledWith("mask-b");
    // 選んでいる行をもう一度押すと選択を外す
    await click(button("線形 1 を選ぶ"));
    expect(props.select).toHaveBeenLastCalledWith(null);
    await click(button("円形 2 を当てる"));
    expect(props.toggleEnabled).toHaveBeenCalledWith("mask-b");
    await click(button("線形 1 を反転"));
    expect(props.toggleInvert).toHaveBeenCalledWith("mask-a");
    await click(button("線形 1 を複製"));
    expect(props.duplicate).toHaveBeenCalledWith("mask-a");
    await click(button("円形 2 を削除"));
    expect(props.remove).toHaveBeenCalledWith("mask-b");
  });

  it("マスクが無いときは、何ができるかを 1 行で出す", async () => {
    await render({ masks: [], selected: null });
    expect(container.textContent).toContain("まだマスクはありません");
    expect(container.querySelector('[data-testid="photo-mask-adjust"]')).toBeNull();
  });

  it("範囲の重ね表示はスイッチ（O）で切り替える", async () => {
    await render({ overlayVisible: false });
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.textContent).toContain("マスクの範囲を表示");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("aria-keyshortcuts")).toBe("O");
    await click(toggle);
    expect(props.setOverlayVisible).toHaveBeenCalledWith(true);
  });

  it("選んだマスクの局所のスライダーは全体と同じ ライト／カラー／効果（値は差分。HSL は無い）", async () => {
    await render();
    expect(container.textContent).toContain("線形 1 の補正");
    expect(sliderLabels()).toEqual([
      "露光量",
      "コントラスト",
      "ハイライト",
      "シャドウ",
      "白レベル",
      "黒レベル",
      "色温度",
      "色かぶり補正",
      "自然な彩度",
      "彩度",
      "テクスチャ",
      "明瞭度",
      "かすみの除去",
    ]);
    expect(slider("露光量").value).toBe("-0.5");
    expect(slider("露光量").getAttribute("aria-valuetext")).toBe("-0.50");
    expect(slider("コントラスト").value).toBe("0");
  });

  it("全体の白が absolute の間は、相対の色温度・色かぶり補正を出さない", async () => {
    await render({ whiteBalanceAbsolute: true });
    expect(sliderLabels()).not.toContain("色温度");
    expect(sliderLabels()).not.toContain("色かぶり補正");
    expect(sliderLabels()).toContain("自然な彩度");
  });

  it("ドラッグは drag（履歴に積まない）→ 離して commit 1 回、ダブルクリックは 0 に戻す commit", async () => {
    // 値を持つ面（設定が変わるとスライダーの値も変わる）
    const changeAdjust = vi.fn();
    function Stateful() {
      const [mask, setMask] = useState<DevelopMask>(LINEAR);
      return (
        <PhotoEditingMaskTools
          {...baseProps({
            masks: [mask],
            selected: mask,
            changeAdjust: (id, key, value, phase) => {
              changeAdjust(id, key, value, phase);
              setMask((current) => ({ ...current, adjust: { ...current.adjust, [key]: value } }));
            },
          })}
        />
      );
    }
    await act(async () => {
      root.render(<Stateful />);
    });
    props = { ...baseProps(), changeAdjust };
    const contrast = slider("コントラスト");
    await act(async () => {
      contrast.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      setRangeValue(contrast, "10");
      setRangeValue(contrast, "20");
    });
    await act(async () => {
      window.dispatchEvent(new Event("pointerup"));
      contrast.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const calls = vi.mocked(props.changeAdjust).mock.calls;
    expect(calls.map((call) => call[3])).toEqual(["drag", "drag", "commit"]);
    expect(calls.at(-1)).toEqual(["mask-a", "contrast", 20, "commit"]);
    await act(async () => {
      slider("露光量").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(calls.at(-1)).toEqual(["mask-a", "exposure", 0, "commit"]);
  });

  it("円形はぼかし（0〜100。ダブルクリックで 50）も出す。線形には無い", async () => {
    await render({ selected: RADIAL as DevelopMask });
    expect(sliderLabels()).toContain("ぼかし");
    await act(async () => {
      slider("ぼかし").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(props.changeFeather).toHaveBeenLastCalledWith("mask-b", 50, "commit");
    await render({ selected: LINEAR });
    expect(sliderLabels()).not.toContain("ぼかし");
  });

  it("押せない間（閲覧のみ・操作の途中）はスライダーと行の操作を押せない", async () => {
    await render({ disabled: true, canAdd: false });
    expect(slider("露光量").disabled).toBe(true);
    expect(button("線形 1 を削除").disabled).toBe(true);
    expect(button("線形グラデーション").disabled).toBe(true);
    // 選ぶのは見るだけなのでできる
    expect(button("円形 2 を選ぶ").disabled).toBe(false);
  });

  it("右パネルは「マスク」の道具の間、見出しを「マスク」にしてプリセットと全体の群の代わりにマスクの面を出す", async () => {
    await act(async () => {
      root.render(
        <BrowserPhotoEditingAdjustments
          canEdit
          canReset
          resetDone={false}
          canUndo={false}
          canRedo={false}
          controlsDisabled={false}
          busy={false}
          work={null}
          raw={false}
          settings={neutralDevelopSettings()}
          tool="mask"
          maskTools={<PhotoEditingMaskTools {...baseProps()} />}
          presets={() => <p>プリセットの行</p>}
          onReset={vi.fn()}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
          onRetryWork={vi.fn()}
          onSettingsChange={vi.fn()}
        />,
      );
    });
    expect(container.querySelector('aside[aria-label="補正"] h2')?.textContent).toBe("マスク");
    expect(container.querySelector('[data-testid="photo-mask-tools"]')).not.toBeNull();
    expect(container.textContent).not.toContain("プリセットの行");
    // 全体の露光量は 1 本だけ（マスクの局所の分）
    expect(sliderLabels().filter((label) => label === "露光量")).toHaveLength(1);
    expect(button("初期化")).not.toBeNull();
  });
});

describe("PhotoEditingMaskTools の局所のカラーミキサー（niho-photo#93）", () => {
  afterEach(() => window.localStorage.clear());

  function sectionToggle(): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>('[data-testid="photo-mask-hsl"] h4 button');
    if (!found) throw new Error("mask hsl toggle not found");
    return found;
  }

  it("カラーの群の後ろ・効果の前に既定で閉じた節を置き、開くと全体と同じ 3 択と 8 本のスライダー", async () => {
    await render({ changeHsl: vi.fn(), resetHsl: vi.fn() });
    const section = container.querySelector<HTMLElement>('[data-testid="photo-mask-hsl"]')!;
    expect(section.previousElementSibling?.querySelector("h4")?.textContent).toBe("カラー");
    expect(section.nextElementSibling?.querySelector("h4")?.textContent).toBe("効果");
    expect(sectionToggle().textContent).toBe("カラーミキサー");
    expect(sectionToggle().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="photo-hsl-mixer"]')).toBeNull();
    await click(sectionToggle());
    expect(section.querySelector('[role="group"][aria-label="調整"]')).not.toBeNull();
    expect(Array.from(section.querySelectorAll<HTMLInputElement>('input[type="range"]')).map((input) => input.getAttribute("aria-label"))).toEqual([
      "赤",
      "橙",
      "黄",
      "緑",
      "水色",
      "青",
      "紫",
      "マゼンタ",
    ]);
    // 渡さない面（古い呼び出し）には出さない
    await render();
    expect(container.querySelector('[data-testid="photo-mask-hsl"]')).toBeNull();
  });

  it("スライダーはマスクの id・色・軸・値・drag / commit を渡し、ダブルクリックで 0 に戻す。初期化はこのマスクの値だけ", async () => {
    const changeHsl = vi.fn();
    const resetHsl = vi.fn();
    await render({ changeHsl, resetHsl });
    await click(sectionToggle());
    const reset = button("このマスクのカラーミキサーを初期化");
    expect(reset.disabled).toBe(true);
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="調整"] button'))[1]!);
    const blue = slider("青");
    await act(async () => {
      blue.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      setRangeValue(blue, "-40");
    });
    await act(async () => {
      window.dispatchEvent(new Event("pointerup"));
      blue.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // 値を持たない面なので、離したときの値は持ち主の値（ここでは 0 のまま）。drag の値と順だけを見る
    expect(changeHsl.mock.calls.map((call) => call[4])).toEqual(["drag", "commit"]);
    expect(changeHsl.mock.calls[0]).toEqual(["mask-a", "blue", "saturation", -40, "drag"]);
    await act(async () => {
      blue.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(changeHsl.mock.calls.at(-1)).toEqual(["mask-a", "blue", "saturation", 0, "commit"]);

    const edited: DevelopMask = { ...LINEAR, adjust: { ...LINEAR.adjust, hsl: { blue: { hue: 0, saturation: -40, luminance: 0 } } } };
    await render({ changeHsl, resetHsl, masks: [edited, RADIAL], selected: edited });
    expect(slider("青").value).toBe("-40");
    expect(button("このマスクのカラーミキサーを初期化").disabled).toBe(false);
    await click(button("このマスクのカラーミキサーを初期化"));
    expect(resetHsl).toHaveBeenCalledWith("mask-a");
    // 全体が白黒・押せない間は押せない
    await render({ changeHsl, resetHsl, masks: [edited, RADIAL], selected: edited, grayscale: true });
    expect(slider("青").disabled).toBe(true);
    expect(button("このマスクのカラーミキサーを初期化").disabled).toBe(true);
    await render({ changeHsl, resetHsl, masks: [edited, RADIAL], selected: edited, disabled: true });
    expect(slider("青").disabled).toBe(true);
  });
});
