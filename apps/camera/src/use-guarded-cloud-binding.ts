import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

import type { PhotoEditingLeaveGuard } from "niho-photo-editing/editor/browser-photo-editing-model";

type CloudBindingOwner = { actorId: string; scopeKey?: string } | null;

function sameCloudOwner(left: CloudBindingOwner, right: CloudBindingOwner): boolean {
  return left?.actorId === right?.actorId && left?.scopeKey === right?.scopeKey;
}

/** Security owner/scope changes revoke the previous binding during render; source changes remain guarded by App.selectSource. */
export function useGuardedCloudBinding<T extends CloudBindingOwner>(params: {
  incoming: T;
  leaveGuardRef: MutableRefObject<PhotoEditingLeaveGuard | null>;
  onOwnerChange: () => void;
}) {
  const { incoming, onOwnerChange } = params;
  const previous = useRef<T>(incoming);

  useEffect(() => {
    if (!sameCloudOwner(previous.current, incoming)) onOwnerChange();
    previous.current = incoming;
  }, [incoming, onOwnerChange]);

  // Keep the historical shape for App while security transitions no longer have a retryable guard failure.
  const retry = useCallback(async () => undefined, []);

  return { binding: incoming, switching: false, failed: false, retry };
}
