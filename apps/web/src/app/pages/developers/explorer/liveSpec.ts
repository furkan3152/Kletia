/**
 * The operations of the OpenAPI document the API served, kept for the tab
 * once the explorer has read it, so the search palette can list them without
 * a request of its own. Until then the bundled reference stands in.
 */
import type { ExplorerOperation } from "./operations.ts";
import { STATIC_OPERATIONS } from "./staticOperations.ts";

let live: readonly ExplorerOperation[] = [];

export function rememberLiveOperations(operations: readonly ExplorerOperation[]): void {
  if (operations.length > 0) live = operations;
}

/** The live operations when the explorer loaded them, else the bundled reference. */
export function knownOperations(): readonly ExplorerOperation[] {
  return live.length > 0 ? live : STATIC_OPERATIONS;
}
