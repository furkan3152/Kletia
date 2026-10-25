import { KeyRound, Search } from "lucide-react";
import { useDeferredValue, useId, useMemo, useState } from "react";

import { navigate } from "../../../routes/history";
import { Link } from "../../../routes/Link";
import { CONTROL_BORDER, cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { MethodBadge } from "../components/MethodBadge";
import { filterOperations, operationHref } from "./explorerRoute";
import { groupOperations, type ExplorerOperation } from "./operations";

/** `/v1/intents/{id}/steps/{stepId}/prepare` → `/intents/{id}/…/prepare` (the full path is the link's title). */
function shortPath(path: string): string {
  const bare = path.replace(/^\/v1/u, "");
  if (bare.length <= 26) return bare;
  const segments = bare.split("/").filter(Boolean);
  return segments.length > 3 ? `/${segments.slice(0, 2).join("/")}/…/${segments[segments.length - 1]}` : bare;
}

export interface OperationTreeProps {
  readonly operations: readonly ExplorerOperation[];
  readonly selectedId: string;
  /** "Live · 97" or "Bundled reference · 31": what the list is. */
  readonly caption: string;
}

/**
 * The explorer's operations: grouped by tag with a filter on wide screens,
 * one select on phones. Every item is a link to its own URL, so the path
 * always names the operation on screen.
 */
export function OperationTree({ operations, selectedId, caption }: OperationTreeProps) {
  const filterId = useId();
  const selectId = useId();
  const [filter, setFilter] = useState("");
  const deferred = useDeferredValue(filter);
  const groups = useMemo(() => groupOperations(filterOperations(operations, deferred)), [operations, deferred]);
  const allGroups = useMemo(() => groupOperations(operations), [operations]);
  const shown = groups.reduce((total, group) => total + group.operations.length, 0);

  return (
    <>
      <div className="flex flex-col gap-1.5 lg:hidden">
        <label htmlFor={selectId} className={LABEL}>
          Operation <span className={cx("normal-case tracking-normal", TEXT_MUTED)}>({caption})</span>
        </label>
        <select
          id={selectId}
          value={selectedId}
          onChange={(event) => navigate(operationHref(event.target.value))}
          className={cx("min-h-11 w-full min-w-0 cursor-pointer bg-surface px-3 py-2 font-code text-code font-semibold text-fg", CONTROL_BORDER, FOCUS_RING)}
        >
          {allGroups.map((group) => (
            <optgroup key={group.tag} label={group.tag}>
              {group.operations.map((operation) => (
                <option key={operation.id} value={operation.id}>
                  {operation.method} {operation.path.replace(/^\/v1/u, "")}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <nav aria-label="Operations" className="hidden min-w-0 flex-col gap-3 lg:flex">
        <p className={cx(LABEL, TEXT_MUTED)}>{caption}</p>
        <div className="relative">
          <label htmlFor={filterId} className="sr-only">
            Filter operations
          </label>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            id={filterId}
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter operations"
            autoComplete="off"
            spellCheck={false}
            className={cx("min-h-11 w-full min-w-0 bg-surface py-2 pl-8 pr-2 text-sm text-fg placeholder:text-placeholder", CONTROL_BORDER, FOCUS_RING)}
          />
        </div>
        <p className={cx("text-xs", TEXT_MUTED)} role="status" aria-live="polite">
          {deferred.trim() ? `${shown} of ${operations.length} operations` : ""}
        </p>
        <div className="flex min-w-0 flex-col">
          {groups.map((group) => (
            <div key={group.tag} className="border-b-2 border-line pb-2 last:border-b-0">
              <h2 className={cx(LABEL, "px-2 pb-1 pt-3", TEXT_MUTED)}>{group.tag}</h2>
              <ul>
                {group.operations.map((operation) => {
                  const selected = operation.id === selectedId;
                  return (
                    <li key={operation.id}>
                      <Link
                        to={operationHref(operation.id)}
                        aria-current={selected ? "page" : undefined}
                        title={`${operation.method} ${operation.path}: ${operation.summary}`}
                        className={cx(
                          "flex min-h-10 w-full min-w-0 items-center gap-2 border-l-[4px] px-2 py-1.5 text-left font-code text-code-s transition-colors",
                          selected ? "border-[#2F5BFF] bg-surface-2 font-bold dark:border-[#C6FF3A]" : "border-transparent hover:bg-surface-2",
                          FOCUS_RING,
                          "focus-visible:-outline-offset-2",
                        )}
                      >
                        <MethodBadge method={operation.method} className="min-w-[3.25rem] !text-code-s" />
                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{shortPath(operation.path)}</span>
                        {operation.auth === "key" ? <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="Needs an API key" /> : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {groups.length === 0 ? <p className={cx("px-2 py-4 text-sm", TEXT_MUTED)}>No operation matches “{deferred.trim()}”.</p> : null}
        </div>
      </nav>
    </>
  );
}
