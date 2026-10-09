import { useState } from "react";

/**
 * A counter that increments every time `value` changes after mount; it is 0
 * on the first render and never increments for the initial value.
 *
 * Key one-shot animations to real transitions so resumed or already-settled
 * state does not replay them:
 *
 *   const settledKey = useChangeKey(phase === "settled");
 *   <span key={settledKey} className={settledKey > 0 && phase === "settled" ? "kl-stamp" : undefined}>✓</span>
 */
export function useChangeKey(value: unknown): number {
  const [record, setRecord] = useState<{ readonly value: unknown; readonly key: number }>(() => ({ value, key: 0 }));
  if (!Object.is(record.value, value)) {
    const next = { value, key: record.key + 1 };
    setRecord(next);
    return next.key;
  }
  return record.key;
}
