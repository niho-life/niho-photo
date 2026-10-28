// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCloudMockClient, type CloudResourceRef } from "../cloud-sharing-contract";
import { createPhotoCloudSharingPreviewClient } from "../cloud-sharing-preview-mock";

vi.mock("niho-ui/components/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <>{children}</> : null,
  DialogContent: ({
    children,
    hideClose,
    className,
  }: {
    children: ReactNode;
    hideClose?: boolean;
    className?: string;
  }) => (
    <div role="dialog" className={className}>
      {!hideClose ? <button type="button" aria-label="Close">close</button> : null}
      {children}
    </div>
  ),
  DialogDescription: ({ children, className }: { children: ReactNode; className?: string }) => <p className={className}>{children}</p>,
  DialogHeader: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  DialogTitle: ({ children, className }: { children: ReactNode; className?: string }) => <h2 className={className}>{children}</h2>,
}));

import { BrowserPhotoCloudShareSheet, type BrowserPhotoCloudSharingBinding } from "./browser-photo-cloud-share-sheet";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET: CloudResourceRef = {
  resourceType: "photo",
  resourceId: "preview-photo",
  ownerType: "user",
  ownerId: "preview-owner",
  tenantId: "preview-tenant",
  workspaceId: null,
};

function binding(overrides: Partial<BrowserPhotoCloudSharingBinding> = {}): BrowserPhotoCloudSharingBinding {
  return {
    client: createPhotoCloudSharingPreviewClient(),
    access: "available",
    selectResource: () => TARGET,
    ...overrides,
  };
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find((element) => element.textContent?.includes(label));
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
  });
}

describe("BrowserPhotoCloudShareSheet", () => {
  let container: HTMLDivElement;
  let root: Root;
  const clipboardWrite = vi.fn(async () => undefined);

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    clipboardWrite.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  async function render(cloudBinding: BrowserPhotoCloudSharingBinding) {
    await act(async () => {
      root.render(<BrowserPhotoCloudShareSheet binding={cloudBinding} photoId="local-photo-selector" onClose={() => undefined} />);
    });
  }

  it("confirms the target, creates and copies a volatile link, then confirms revoke", async () => {
    await render(binding());
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("共有する写真を確認");
    expect(document.querySelector("label[for='photo-cloud-share-expiry']")?.textContent).toContain("有効期限");

    await act(async () => {
      button("共有リンクを作る").click();
      button("共有リンクを作る").click();
    });
    await settle();

    const link = document.querySelector<HTMLInputElement>("#photo-cloud-share-url");
    expect(link?.readOnly).toBe(true);
    expect(link?.value.length).toBeGreaterThan(0);
    await act(async () => button("リンクをコピー").click());
    await settle();
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    expect(clipboardWrite).toHaveBeenCalledWith(expect.any(String));
    expect(Array.from(document.querySelectorAll("[role='status']")).some((element) => element.textContent?.includes("コピーしました"))).toBe(true);

    await act(async () => button("共有を停止").click());
    expect(document.querySelector("[role='group'][aria-label='共有停止の確認']")?.textContent).toContain("使えなくなります");
    await act(async () => button("停止する").click());
    await settle();
    expect(document.querySelector("#photo-cloud-share-url")).toBeNull();
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("停止済み");
  });

  it.each([
    ["offline", "オフラインです"],
    ["signed-out", "ログインが必要です"],
    ["unavailable", "この環境ではクラウド共有を利用できません"],
  ] as const)("shows the %s recovery state without an enabled create action", async (access, copy) => {
    await render(binding({ access }));
    expect(document.querySelector("[role='alert']")?.textContent).toContain(copy);
    expect(Array.from(document.querySelectorAll("button")).some((element) => element.textContent?.includes("共有リンクを作る"))).toBe(false);
  });

  it("shows fixed quota and permission copy without raw server fields", async () => {
    const quotaClient = createCloudMockClient({
      "share.create": async () => ({
        ok: false,
        error: { code: "quota_exceeded", requestId: "private-request-id", retryable: false },
      }),
    });
    await render(binding({ client: quotaClient }));
    await act(async () => button("共有リンクを作る").click());
    await settle();
    const text = document.querySelector("[role='dialog']")?.textContent ?? "";
    expect(text).toContain("共有できる上限に達しました");
    expect(text).not.toContain("private-request-id");
    expect(document.querySelector("#photo-cloud-share-url")).toBeNull();

    await act(async () => {
      root.render(
        <BrowserPhotoCloudShareSheet
          binding={binding({ selectResource: () => null })}
          photoId="unavailable-photo"
          onClose={() => undefined}
        />,
      );
    });
    expect(document.querySelector("[role='alert']")?.textContent).toContain("クラウド共有の対象として確認できません");
  });

  it("offers more pages before later active links can be revoked", async () => {
    const first = { shareId: "expired-first", resource: TARGET, permission: "read" as const, expiresAt: "2020-01-01T00:00:00.000Z", revokedAt: null };
    const later = { shareId: "active-later", resource: TARGET, permission: "read" as const, expiresAt: "2099-01-01T00:00:00.000Z", revokedAt: null };
    const list = vi.fn(async (request: { cursor?: string }) => ({
      ok: true as const,
      value: request.cursor === "next-page"
        ? { items: [later], nextCursor: null }
        : { items: [first], nextCursor: "next-page" },
    }));
    await render(binding({ client: createCloudMockClient({ "share.list": list }) }));
    await act(async () => button("更新").click());
    await settle();
    expect(button("さらに表示").disabled).toBe(false);
    expect(Array.from(document.querySelectorAll("button")).some((element) => element.textContent?.includes("共有を停止"))).toBe(false);

    await act(async () => button("さらに表示").click());
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(button("共有を停止").disabled).toBe(false);
  });

  it("reopens an uncertain share with its original idempotency key", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: "temporarily_unavailable", requestId: "hidden", retryable: true } })
      .mockImplementationOnce(async (request) => ({
        ok: true,
        value: {
          share: { shareId: "resumed-share", resource: TARGET, permission: "read", expiresAt: request.expiresAt, revokedAt: null },
          shareUrl: "https://share.invalid/replayed",
          replayed: true,
        },
      }));
    const cloudBinding = binding({ client: createCloudMockClient({ "share.create": create }) });
    await render(cloudBinding);
    await act(async () => button("共有リンクを作る").click());
    await settle();
    expect(document.querySelector("[role='alert']")?.textContent).toContain("接続できませんでした");

    await act(async () => button("閉じる").click());
    await act(async () => root.render(<></>));
    await render(cloudBinding);
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("前の共有操作が完了している場合があります");
    expect(Array.from(document.querySelectorAll("button")).some((element) => element.textContent?.includes("共有リンクを作る"))).toBe(false);

    await act(async () => button("処理を再開").click());
    await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toBe(create.mock.calls[0]?.[0]);
    expect(create.mock.calls[1]?.[1]).toBe(create.mock.calls[0]?.[1]);
    expect(document.querySelector<HTMLInputElement>("#photo-cloud-share-url")?.value).toBe("https://share.invalid/replayed");
  });
});
