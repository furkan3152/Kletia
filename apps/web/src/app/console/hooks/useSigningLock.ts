/**
 * The desk's signing lock for one task: one task signs at a time. The
 * execution hook takes the lock before it prepares anything and gives it
 * back when the run ends; the task card disables its signing controls
 * while another task holds it.
 */
import { useCallback, useMemo } from "react";

import { getDeskStore, useDeskStore } from "../state/deskStore";

export interface SigningLock {
  /** Another task holds the lock. */
  readonly lockedByOther: boolean;
  /** This task holds the lock. */
  readonly held: boolean;
  acquire(): boolean;
  release(): void;
}

export function useSigningLock(taskId: string): SigningLock {
  const signingTaskId = useDeskStore((state) => state.signingTaskId);
  const acquire = useCallback(() => getDeskStore().getState().acquireSigning(taskId), [taskId]);
  const release = useCallback(() => getDeskStore().getState().releaseSigning(taskId), [taskId]);
  return useMemo(
    () => ({
      lockedByOther: signingTaskId !== null && signingTaskId !== taskId,
      held: signingTaskId === taskId,
      acquire,
      release,
    }),
    [acquire, release, signingTaskId, taskId],
  );
}
