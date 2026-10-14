/**
 * The errors page's groups (portal design 4.4.10, P-15): one group per
 * catalog category in catalog order, and a heading whose accessible name
 * reads "Request, 27 codes" (never "Request27"), with the count computed from
 * the rows shown. Pure: the node tests load it directly.
 */
import { ERROR_CATEGORIES, type KletiaErrorCategory } from "@kletia/core";

const CATEGORY_LABEL: Readonly<Record<KletiaErrorCategory, string>> = {
  request: "Request",
  authentication: "Authentication",
  permission: "Permission",
  not_found: "Not found",
  conflict: "Conflict",
  expired: "Expired",
  intent: "Intent",
  verification: "Verification",
  settlement: "Settlement",
  rate_limit: "Rate limit",
  upstream: "Upstream",
  unavailable: "Unavailable",
  internal: "Internal",
};

/** "not_found" → "Not found"; a category the bundled catalog does not know keeps its own name. */
export function categoryLabel(category: string): string {
  return (CATEGORY_LABEL as Readonly<Record<string, string>>)[category] ?? category;
}

/** "1 code", "27 codes". */
export function codeCount(count: number): string {
  return `${count} ${count === 1 ? "code" : "codes"}`;
}

/** The heading's full accessible name: "Request, 27 codes". */
export function groupHeading(category: string, count: number): string {
  return `${categoryLabel(category)}, ${codeCount(count)}`;
}

export interface ErrorGroup<Row> {
  readonly category: string;
  readonly label: string;
  readonly heading: string;
  readonly rows: readonly Row[];
}

/** Rows by category: catalog categories first in their order, then any the catalog does not list; empty groups drop out. */
export function groupErrors<Row extends { readonly category: string }>(rows: readonly Row[]): readonly ErrorGroup<Row>[] {
  const seen = [...new Set(rows.map((row) => row.category))];
  const order = [
    ...ERROR_CATEGORIES.filter((category) => seen.includes(category)),
    ...seen.filter((category) => !(ERROR_CATEGORIES as readonly string[]).includes(category)),
  ];
  return order
    .map((category) => {
      const inGroup = rows.filter((row) => row.category === category);
      return { category, label: categoryLabel(category), heading: groupHeading(category, inGroup.length), rows: inGroup };
    })
    .filter((group) => group.rows.length > 0);
}
