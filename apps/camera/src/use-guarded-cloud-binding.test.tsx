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
        <button type="button" onClick={() => void state.retry()}>retry</button>
      </div>
    );
  }

  return { Harness, leaveGuardRef, onOwnerChange };
}

describe("useGuardedCloudBinding", () => {
  it("keeps the old owner until the edit guard accepts, and lets the owner retry after a save failure", async () => {
    let finishGuard: (canLeave: boolean) => void = () => undefined;
    const guard = vi.fn(() => new Promise<boolean>((resolve) => { finishGuard = resolve; }));
    const { Harness, leaveGuardRef, onOwnerChange } = setup(guard);

    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "old" }} />));
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-b", marker: "new" }} />));
    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("owner-a");
    expect(container.querySelector('[data-testid="switching"]')?.textContent).toBe("true");

    await act(async () => finishGuard?.(false));
    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("owner-a");
    expect(container.querySelector('[data-testid="failed"]')?.textContent).toBe("true");
    expect(onOwnerChange).not.toHaveBeenCalled();

    leaveGuardRef.current = vi.fn(async () => true);
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("owner-b");
    expect(container.querySelector('[data-testid="failed"]')?.textContent).toBe("false");
    expect(onOwnerChange).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledWith({ release: false });
  });

  it("refreshes a binding for the same owner without leaving the active edit session", async () => {
    const guard = vi.fn(async () => true);
    const { Harness } = setup(guard);
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "old" }} />));
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "refreshed" }} />));

    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("owner-a");
    expect(container.querySelector('[data-testid="marker"]')?.textContent).toBe("refreshed");
    expect(guard).not.toHaveBeenCalled();
  });

  it("guards a library scope change for the same actor before replacing the binding", async () => {
    const guard = vi.fn(async () => false);
    const { Harness, leaveGuardRef, onOwnerChange } = setup(guard);

    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "library-a", scopeKey: "personal:library-a:owner-a" }} />));
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "library-b", scopeKey: "personal:library-b:owner-a" }} />));

    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("owner-a");
    expect(container.querySelector('[data-testid="marker"]')?.textContent).toBe("library-a");
    expect(container.querySelector('[data-testid="failed"]')?.textContent).toBe("true");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(onOwnerChange).not.toHaveBeenCalled();

    leaveGuardRef.current = vi.fn(async () => true);
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="marker"]')?.textContent).toBe("library-b");
    expect(onOwnerChange).toHaveBeenCalledTimes(1);
  });

  it("does not report a failed transition if the incoming binding returns to the current owner", async () => {
    let finishGuard: (canLeave: boolean) => void = () => undefined;
    const guard = vi.fn(() => new Promise<boolean>((resolve) => { finishGuard = resolve; }));
    const { Harness, onOwnerChange } = setup(guard);
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "old" }} />));
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-b", marker: "pending" }} />));
    await act(async () => root.render(<Harness incoming={{ actorId: "owner-a", marker: "current" }} />));
    await act(async () => finishGuard(false));

    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("owner-a");
    expect(container.querySelector('[data-testid="marker"]')?.textContent).toBe("current");
    expect(container.querySelector('[data-testid="failed"]')?.textContent).toBe("false");
    expect(onOwnerChange).not.toHaveBeenCalled();
  });
});
