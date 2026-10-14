/**
 * The API explorer's operation comes from the path
 * (`/developers/api/<operationId>`), never from component state or a hash:
 * the URL is the link to share. An id the document does not have falls back
 * to the default operation with a notice that says so. Pure.
 */
import type { ExplorerOperation } from "./operations.ts";

export const EXPLORER_PATH = "/developers/api";
export const DEFAULT_OPERATION_ID = "createIntent";

export interface ExplorerRoute {
  readonly operation: ExplorerOperation;
  /** Set when the path named an operation this document does not have. */
  readonly notice: string | null;
}

export function operationHref(id: string): string {
  return `${EXPLORER_PATH}/${id}`;
}

export function resolveExplorerOperation(operations: readonly ExplorerOperation[], param: string | null | undefined): ExplorerRoute {
  const fallback = operations.find((operation) => operation.id === DEFAULT_OPERATION_ID) ?? operations[0];
  if (!fallback) throw new Error("The explorer needs at least one operation.");
  if (!param) return { operation: fallback, notice: null };
  const named = operations.find((operation) => operation.id === param);
  if (named) return { operation: named, notice: null };
  return {
    operation: fallback,
    notice: `There is no operation named ${param} in this reference, so ${fallback.method} ${fallback.path} is shown instead.`,
  };
}

/**
 * Operations whose method, path, id, summary or tag contain every word of
 * the filter (case-insensitive), in their original order.
 */
export function filterOperations(operations: readonly ExplorerOperation[], filter: string): readonly ExplorerOperation[] {
  const words = filter.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return operations;
  return operations.filter((operation) => {
    const haystack = `${operation.method} ${operation.path} ${operation.id} ${operation.summary} ${operation.tag}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
