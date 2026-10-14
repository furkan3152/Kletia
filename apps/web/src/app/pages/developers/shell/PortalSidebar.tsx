import { ArrowUpRight, Lock } from "lucide-react";

import { PLATFORM_ORIGIN } from "../../../../shared/platform/kletiaClient";
import { Link } from "../../../routes/Link";
import { Icon } from "../../../site/art/Icon";
import { API_DOC_URL, GITHUB_URL } from "../../../site/siteLinks";
import { cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { PORTAL_GROUPS, PORTAL_PAGES, type PortalGroup, type PortalPageDef, type PortalPageId } from "./portalRoutes";

const CHANGELOG_URL = `${GITHUB_URL}/blob/main/CHANGELOG.md`;

const FOOTER_LINKS: readonly { readonly label: string; readonly to: string; readonly external: boolean }[] = [
  { label: "Network status", to: "/networks", external: false },
  { label: "OpenAPI JSON", to: `${PLATFORM_ORIGIN}/v1/openapi.json`, external: true },
  { label: "Reference (Markdown)", to: API_DOC_URL, external: true },
  { label: "Changelog", to: CHANGELOG_URL, external: true },
];

/** Warms a page's chunk on hover or focus, so the click renders at once. */
function warm(page: PortalPageDef) {
  page.load().catch(() => undefined);
}

export interface PortalSidebarProps {
  readonly current: PortalPageId;
  /** Drawer: links are larger touch targets (48 px). */
  readonly variant?: "column" | "drawer";
  readonly className?: string;
}

/**
 * The portal's one navigation: grouped page links with the current page
 * marked by a 3 px rule, a lock on "Your project" pages while no key is
 * loaded (they still open and explain themselves), and the reference
 * links that leave the portal.
 */
export function PortalSidebar({ current, variant = "column", className }: PortalSidebarProps) {
  const { key } = useSessionKey();
  const keyed = portalKeyKind(key) !== null;
  const item = variant === "drawer" ? "min-h-12" : "min-h-10";
  return (
    <nav aria-label="Portal sections" className={cx("flex min-w-0 flex-col gap-5 py-6", className)}>
      {PORTAL_GROUPS.map((group) => {
        const pages = PORTAL_PAGES.filter((page) => page.group === group.id);
        const labelId = `portal-group-${variant}-${group.id}`;
        return (
          <div key={group.id} className="flex min-w-0 flex-col gap-1.5" data-portal-group={group.id}>
            <p id={labelId} className={cx(LABEL, "px-4", TEXT_MUTED)}>
              {group.label}
            </p>
            <ul aria-labelledby={labelId} className="flex flex-col gap-1">
              {pages.map((page) => {
                const active = page.id === current;
                return (
                  <li key={page.id}>
                    <Link
                      to={page.path}
                      aria-current={active ? "page" : undefined}
                      onMouseEnter={() => warm(page)}
                      onFocus={() => warm(page)}
                      className={cx(
                        "-ml-[3px] flex items-center justify-between gap-2 border-l-[3px] px-4 text-[15px] font-bold transition-colors",
                        item,
                        active
                          ? "border-[#0052FF] bg-surface text-accent-text dark:border-[#FFD60A] dark:text-[#FFD60A]"
                          : "border-transparent text-fg hover:border-control hover:bg-surface",
                        FOCUS_RING,
                        "focus-visible:-outline-offset-2",
                      )}
                    >
                      <span className="min-w-0 truncate">{page.label}</span>
                      {page.needsKey && !keyed ? (
                        <Lock className={cx("h-3.5 w-3.5 shrink-0", TEXT_MUTED)} aria-label="needs a key" role="img" />
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <ul className="mx-4 flex flex-col gap-1 border-t-2 border-dashed border-[#1A1A1A]/25 pt-4 dark:border-white/15">
        {FOOTER_LINKS.map((link) => (
          <li key={link.label}>
            {link.external ? (
              <a
                href={link.to}
                target="_blank"
                rel="noopener noreferrer"
                className={cx("inline-flex items-center gap-1 text-sm font-semibold underline-offset-4 hover:underline", item, TEXT_MUTED, FOCUS_RING)}
              >
                {link.label}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <Link to={link.to} className={cx("inline-flex items-center text-sm font-semibold underline-offset-4 hover:underline", item, TEXT_MUTED, FOCUS_RING)}>
                {link.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * 768-1279 px: a 56 px rail of group pictograms. Each opens the full sidebar
 * as a drawer at its group; the group holding the current page is marked.
 */
export function PortalRail({ current, onOpenGroup }: { readonly current: PortalPageId; readonly onOpenGroup: (group: PortalGroup) => void }) {
  const currentGroup = PORTAL_PAGES.find((page) => page.id === current)?.group ?? null;
  return (
    <div className="flex flex-col items-center gap-2 py-6">
      {PORTAL_GROUPS.map((group) => {
        const active = group.id === currentGroup;
        return (
          <button
            key={group.id}
            type="button"
            onClick={() => onOpenGroup(group.id)}
            title={group.label}
            aria-label={`${group.label}: open the portal sections`}
            aria-current={active ? "true" : undefined}
            className={cx(
              "relative flex h-11 w-11 items-center justify-center border-[3px] transition-colors",
              active ? "border-control bg-[#FFD60A] text-[#1A1A1A]" : "border-transparent text-fg hover:border-control",
              FOCUS_RING,
            )}
          >
            <Icon name={group.icon} size={24} plate={!active} />
          </button>
        );
      })}
    </div>
  );
}
