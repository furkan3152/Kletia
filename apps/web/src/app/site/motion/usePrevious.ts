import { useState } from "react";

/**
 * The value before the most recent change (undefined until `value` first
 * changes). Implemented with state instead of a ref read during render, so it
 * is safe under concurrent rendering and the React Compiler lint rules.
 */
export function usePrevious<T>(value: T): T | undefined {
  const [record, setRecord] = useState<{ readonly current: T; readonly previous: T | undefined }>(() => ({
    current: value,
    previous: undefined,
  }));
  if (!Object.is(record.current, value)) {
    // Adjusting state while rendering (React's "storing information from previous renders" pattern).
    setRecord({ current: value, previous: record.current });
    return record.current;
  }
  return record.previous;
}
