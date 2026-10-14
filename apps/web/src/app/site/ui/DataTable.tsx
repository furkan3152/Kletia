import { ChevronRight } from "lucide-react";
import React from "react";

import { Link } from "../../routes/Link";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "./styles";

export interface DataTableColumn<Row> {
  readonly key: string;
  readonly header: string;
  readonly cell: (row: Row) => React.ReactNode;
  /**
   * Below 640 px every row becomes two lines: "primary" cells make the first
   * line (status and title), "secondary" cells the second (facts), "hidden"
   * cells are left out. Default "secondary".
   */
  readonly phone?: "primary" | "secondary" | "hidden";
  readonly align?: "start" | "end";
  readonly className?: string;
}

export interface DataTableProps<Row> {
  /** The table's caption (read by screen readers; shown when `showCaption`). */
  readonly caption: string;
  readonly showCaption?: boolean;
  readonly columns: readonly DataTableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  /** Each row's detail page: a chevron link at the end of the row. */
  readonly rowHref?: (row: Row) => string | null;
  /** Accessible name of the row's detail link ("Open webhook https://…"). */
  readonly rowLabel?: (row: Row) => string;
  /** Shown instead of the table when there are no rows. */
  readonly empty?: React.ReactNode;
  readonly className?: string;
}

const CELL = "px-3 py-3 align-middle sm:px-4";

/**
 * A plain table: 12 px label headers on the second surface, 2 px
 * dividers, 48 px rows, a chevron link per row when rows have detail
 * pages, and two-line rows under 640 px. No virtualisation: portal lists
 * are short.
 */
export function DataTable<Row>({
  caption,
  showCaption = false,
  columns,
  rows,
  rowKey,
  rowHref,
  rowLabel,
  empty,
  className,
}: DataTableProps<Row>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const linked = Boolean(rowHref);
  const primary = columns.filter((column) => column.phone === "primary");
  const secondary = columns.filter((column) => (column.phone ?? "secondary") === "secondary");

  return (
    <div className={cx("min-w-0", INK_BORDER, SURFACE, className)}>
      <table className="hidden w-full border-collapse text-left text-body-s sm:table">
        <caption className={showCaption ? cx(LABEL, "px-4 py-3 text-left", TEXT_MUTED) : "sr-only"}>{caption}</caption>
        <thead className="bg-surface-2">
          <tr className="border-b-2 border-[#1A1A1A]/10 dark:border-white/10">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(LABEL, CELL, "py-2.5 font-extrabold", column.align === "end" && "text-right", TEXT_MUTED)}
              >
                {column.header}
              </th>
            ))}
            {linked ? (
              <th scope="col" className={cx(CELL, "w-12 py-2.5")}>
                <span className="sr-only">Details</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y-2 divide-[#1A1A1A]/10 dark:divide-white/10">
          {rows.map((row) => {
            const href = rowHref?.(row) ?? null;
            return (
              <tr key={rowKey(row)} className="h-12">
                {columns.map((column) => (
                  <td key={column.key} className={cx(CELL, column.align === "end" && "text-right", column.className)}>
                    {column.cell(row)}
                  </td>
                ))}
                {linked ? (
                  <td className={cx(CELL, "w-12 text-right")}>
                    {href ? (
                      <Link
                        to={href}
                        aria-label={rowLabel?.(row) ?? "Open"}
                        className={cx("inline-flex h-10 w-10 items-center justify-center", FOCUS_RING)}
                      >
                        <ChevronRight className="h-5 w-5" aria-hidden="true" />
                      </Link>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Phones: the same rows as two-line items; the table above is not rendered at this width. */}
      <ul className="divide-y-2 divide-[#1A1A1A]/10 sm:hidden dark:divide-white/10" aria-label={caption}>
        {rows.map((row) => {
          const href = rowHref?.(row) ?? null;
          return (
            <li key={rowKey(row)} className="flex min-h-14 min-w-0 items-center gap-2 px-3 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2 font-bold">
                  {primary.map((column) => (
                    <span key={column.key} className="min-w-0">
                      {column.cell(row)}
                    </span>
                  ))}
                </div>
                {secondary.length > 0 ? (
                  <dl className={cx("flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-body-s", TEXT_MUTED)}>
                    {secondary.map((column) => (
                      <div key={column.key} className="flex min-w-0 gap-1">
                        <dt className="sr-only">{column.header}</dt>
                        <dd className="min-w-0 break-words">{column.cell(row)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
              {href ? (
                <Link
                  to={href}
                  aria-label={rowLabel?.(row) ?? "Open"}
                  className={cx("inline-flex h-11 w-11 shrink-0 items-center justify-center", FOCUS_RING)}
                >
                  <ChevronRight className="h-5 w-5" aria-hidden="true" />
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
