// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserPhotoEditingLoupe } from "./browser-photo-editing-loupe";
import { PhotoEditingImageCorsProvider } from "./photo-editing-image-cors";

/**
 * 1 枚の面の写真のまわりの余白（niho-photo#49）。PC の幅では画の最大の大きさを面より 2rem 小さくし、縦位置の写真を上の線と
 * フィルムストリップに付けない。背景除去の層（`absolute inset-0`）の中に置いた canvas でも同じ class を持つ（面の padding では
 * 層の中に効かない）。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIT_HEIGHT = "lg:max-h-[calc(100%-2rem)]";
const FIT_WIDTH = "lg:max-w-[calc(100%-2rem)]";

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

function Harness(props: { cutout: boolean; viewUrl?: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  return (
    <BrowserPhotoEditingLoupe
      opened={{
        key: "photo-1",
        fileName: "photo.jpg",
        decoded: null,
        viewUrl: props.viewUrl ?? null,
        lockedReason: null,
        loadedForEditing: true,
        mode: props.viewUrl ? "canvas" : "wasm",
        input: null,
        work: null,
        photo: null,
      }}
      opening={false}
      openedVisible
      compareOriginal={false}
      presetPreviewName={null}
      canvasRef={canvasRef}
      cutout={
        props.cutout
          ? { brushing: false, transparent: false, radius: 0.05, disabled: false, onLiveStroke: vi.fn(), onCommitStroke: vi.fn() }
          : null
      }
      lockedReason={null}
      sourceError={null}
      onReload={null}
    />
  );
}

describe("1 枚の面の写真のまわりの余白（niho-photo#49）", () => {
  it("canvas は PC の幅で面より 2rem 小さい（狭い幅は面いっぱい）", () => {
    act(() => root.render(<Harness cutout={false} />));
    const canvas = container.querySelector("canvas");
    expect(canvas?.className).toContain("max-h-full");
    expect(canvas?.className).toContain(FIT_HEIGHT);
    expect(canvas?.className).toContain(FIT_WIDTH);
  });

  it("背景除去の層の中に置いた canvas も同じ余白を持つ", () => {
    act(() => root.render(<Harness cutout />));
    const layer = container.querySelector('[data-testid="photo-cutout-brush-area"]');
    const canvas = layer?.querySelector("canvas");
    expect(layer?.className).toContain("absolute inset-0");
    expect(canvas?.className).toContain(FIT_HEIGHT);
    expect(canvas?.className).toContain(FIT_WIDTH);
    // 余白は画の側で決める（面に padding を足さない。層の中に効かないため）
    expect(container.querySelector('section[aria-label="写真プレビュー"]')?.className).not.toMatch(/\blg:p-/);
  });

  it("閲覧用の img も同じ余白を持つ", () => {
    act(() => root.render(<Harness cutout={false} viewUrl="blob:preview" />));
    const image = container.querySelector("img");
    expect(image?.className).toContain(FIT_HEIGHT);
    expect(image?.className).toContain(FIT_WIDTH);
    expect(image?.hasAttribute("crossorigin")).toBe(false);
  });

  it("分離文書では閲覧用の img を CORS で読む", () => {
    act(() =>
      root.render(
        <PhotoEditingImageCorsProvider enabled>
          <Harness cutout={false} viewUrl="https://example.test/signed.jpg?token=fixture" />
        </PhotoEditingImageCorsProvider>,
      ),
    );
    expect(container.querySelector("img")?.getAttribute("crossorigin")).toBe("anonymous");
  });
});
