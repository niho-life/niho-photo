import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import type { PhotoEditingLeaveGuard } from "niho-photo-editing/editor/browser-photo-editing-model";

type CloudBindingOwner = { actorId: string; scopeKey?: string } | null;

function sameCloudOwner(left: CloudBindingOwner, right: CloudBindingOwner): boolean {
  return left?.actorId === right?.actorId && left?.scopeKey === right?.scopeKey;
}

/**
 * cloudBinding の所有者が替わる場合は、開いている編集を保存してから公開先を切り替える。
 * 保存に失敗した場合は旧 binding を維持し、再試行できるようにする。
 */
export function useGuardedCloudBinding<T extends CloudBindingOwner>(params: {
  incoming: T;
  leaveGuardRef: MutableRefObject<PhotoEditingLeaveGuard | null>;
  onOwnerChange: () => void;
}) {
  const { incoming, leaveGuardRef, onOwnerChange } = params;
  const incomingRef = useRef(incoming);
  incomingRef.current = incoming;
  const [binding, setBinding] = useState<T>(incoming);
  const bindingRef = useRef(binding);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  const switchingRef = useRef(false);

  const reconcile = useCallback(async () => {
    const current = bindingRef.current;
    const target = incomingRef.current;
    if (sameCloudOwner(current, target)) {
      if (current !== target) {
        bindingRef.current = target;
        setBinding(target);
      }
      setFailed(false);
      return;
    }
    if (switchingRef.current) return;

    switchingRef.current = true;
    setSwitching(true);
    try {
      let canLeave = true;
      try {
        if (leaveGuardRef.current) canLeave = await leaveGuardRef.current({ release: false });
      } catch {
        canLeave = false;
      }
      if (!canLeave) {
        setFailed(!sameCloudOwner(bindingRef.current, incomingRef.current));
        return;
      }

      const latest = incomingRef.current;
      if (sameCloudOwner(bindingRef.current, latest)) {
        if (bindingRef.current !== latest) {
          bindingRef.current = latest;
          setBinding(latest);
        }
        setFailed(false);
        return;
      }
      bindingRef.current = latest;
      setBinding(latest);
      onOwnerChange();
      setFailed(false);
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }, [leaveGuardRef, onOwnerChange]);

  useEffect(() => {
    void reconcile();
  }, [incoming, reconcile]);

  return { binding, switching, failed, retry: reconcile };
}
