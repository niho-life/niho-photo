import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhotoEditingLeaveGuard } from "niho-photo-editing/editor/browser-photo-editing-model";

import { useGuardedCloudBinding } from "./use-guarded-cloud-binding";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Binding = { actorId: string; marker: string; scopeKey?: string };

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function setup(leaveGuard: PhotoEditingLeaveGuard) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const leaveGuardRef = { current: leaveGuard };
  const onOwnerChange = vi.fn();

  function Harness(props: { incoming: Binding | null }) {
    const state = useGuardedCloudBinding({ incoming: props.incoming, leaveGuardRef, onOwnerChange });
    return (
      <div>
        <output data-testid="owner">{state.binding?.actorId ?? "local"}</output>
        <output data-testid="marker">{state.binding?.marker ?? "none"}</output>
        <output data-testid="switching">{String(state.switching)}</output>
        <output data-testid="failed">{String(state.failed)}</output>
      </div>
    );
  }

  return { Harness, onOwnerChange };
}

describe("useGuardedCloudBinding", () => {
  it.each([
    ["false", vi.fn(async () => false)],
    ["reject", vi.fn(async () => { throw new Error("synthetic guard failure"); })],
    ["never", vi.fn(() => new Promise<boolean>(() => undefined))],
  ])("removes the old owner on the first security render when the leave guard is %s", async (_name, guard) => {
    const { Harness, onOwnerChange } = setup(guard);
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "old", scopeKey: "scope-a" }} />));
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-b", marker: "new", scopeKey: "scope-b" }} />));

    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("owner-b");
    expect(container.querySelector('[data-testid="marker"]')?.textContent).toBe("new");
    expect(container.querySelector('[data-testid="switching"]')?.textContent).toBe("false");
    expect(container.querySelector('[data-testid="failed"]')?.textContent).toBe("false");
    expect(guard).not.toHaveBeenCalled();
    expect(onOwnerChange).toHaveBeenCalledTimes(1);
  });

  it("removes a revoked binding on the first render without waiting for a guard", async () => {
    const guard = vi.fn(() => new Promise<boolean>(() => undefined));
    const { Harness, onOwnerChange } = setup(guard);
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "old", scopeKey: "scope-a" }} />));
    await act(async () => root.render(<Harness incoming={null} />));

    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("local");
    expect(container.querySelector('[data-testid="marker"]')?.textContent).toBe("none");
    expect(guard).not.toHaveBeenCalled();
    expect(onOwnerChange).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "session", "epoch", "transport"])("immediately fences a %s scope change", async (part) => {
    const guard = vi.fn(async () => false);
    const { Harness, onOwnerChange } = setup(guard);
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "old", scopeKey: "scope-before" }} />));
    await act(async () => root.render(<Harness incoming={{
      actorId: part === "owner" ? "owner-b" : "owner-a",
      marker: part,
      scopeKey: `scope-after-${part}`,
    }} />));

    expect(container.querySelector('[data-testid="marker"]')?.textContent).toBe(part);
    expect(guard).not.toHaveBeenCalled();
    expect(onOwnerChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the editor scope for a same-logical-scope expiry refresh", async () => {
    const guard = vi.fn(async () => false);
    const { Harness, onOwnerChange } = setup(guard);
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "expires-1", scopeKey: "same-five-tuple" }} />));
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "expires-2", scopeKey: "same-five-tuple" }} />));

    expect(container.querySelector('[data-testid="marker"]')?.textContent).toBe("expires-2");
    expect(guard).not.toHaveBeenCalled();
    expect(onOwnerChange).not.toHaveBeenCalled();
  });

  it("cannot be restored by a late result associated with the previous owner", async () => {
    let finish: (value: boolean) => void = () => undefined;
    const guard = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { Harness } = setup(guard);
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "old", scopeKey: "scope-a" }} />));
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-b", marker: "new", scopeKey: "scope-b" }} />));
    await act(async () => finish(true));

    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("owner-b");
    expect(container.querySelector('[data-testid="marker"]')?.textContent).toBe("new");
    expect(guard).not.toHaveBeenCalled();
  });
});
