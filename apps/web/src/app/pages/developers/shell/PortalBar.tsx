import { Menu } from "lucide-react";

import { Link } from "../../../routes/Link";
import { cx, FOCUS_RING, TEXT_MUTED } from "../../../site/ui/styles";
import { ApiStatusPill } from "./ApiStatusPill";
import { KeyMenu } from "./KeyMenu";
import type { PortalMatch } from "./portalRoutes";
import type { PortalHealth } from "./usePortalHealth";

export interface PortalBarProps {
  readonly match: PortalMatch;
  readonly health: PortalHealth | null;
  readonly sectionsOpen: boolean;
  readonly onOpenSections: () => void;
  readonly keyMenuOpen: boolean;
  readonly onOpenKeyMenu: () => void;
  readonly onCloseKeyMenu: () => void;
}

/** The last breadcrumb of an object page: never the object's own title, at most a short id. */
function detailCrumb(match: PortalMatch): string | null {
  if (!match.param) return null;
  if (match.param === "new") return "New";
  if (match.page.id === "api" || match.page.id === "recipes") return match.param;
  return match.param.length > 12 ? `${match.param.slice(0, 10)}…` : match.param;
}

/**
 * The portal bar (portal design 4.3), sticky under the site header: the
 * sections button under 1280 px, breadcrumbs, the safety line, the API
 * status and the key chip.
 */
export function PortalBar({ match, health, sectionsOpen, onOpenSections, keyMenuOpen, onOpenKeyMenu, onCloseKeyMenu }: PortalBarProps) {
  const { page } = match;
  const detail = detailCrumb(match);
  const crumbs: { readonly label: string; readonly to: string | null }[] = [
    { label: "Developers", to: page.id === "overview" && !detail ? null : "/developers" },
    ...(page.id === "overview" ? [] : [{ label: page.label, to: detail ? page.path : null }]),
    ...(detail ? [{ label: detail, to: null }] : []),
  ];
  return (
    <nav
      aria-label="Developer portal"
      className="sticky top-[75px] z-40 border-b-[3px] border-[#1A1A1A] bg-[#F4F1EA]/95 backdrop-blur-sm dark:border-[#4B5563] dark:bg-[#0B1120]/95"
    >
      <div className="flex h-12 min-w-0 items-center gap-2 px-3 sm:px-6 md:h-[52px] lg:px-8">
        <button
          type="button"
          onClick={onOpenSections}
          aria-expanded={sectionsOpen}
          aria-haspopup="dialog"
          className={cx(
            "inline-flex min-h-11 shrink-0 items-center gap-2 border-[3px] border-control bg-surface px-2.5 text-xs font-black uppercase tracking-[0.08em] xl:hidden",
            FOCUS_RING,
          )}
        >
          <Menu className="h-4 w-4" aria-hidden="true" />
          Sections
        </button>
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1.5 text-sm">
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return (
                <li key={`${crumb.label}-${index}`} className={cx("flex min-w-0 items-center gap-1.5", !last && "max-md:hidden")}>
                  {crumb.to ? (
                    <Link to={crumb.to} className={cx("truncate font-semibold underline-offset-4 hover:underline", TEXT_MUTED, FOCUS_RING)}>
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current="page" className="truncate font-bold">
                      {crumb.label}
                    </span>
                  )}
                  {last ? null : (
                    <span aria-hidden="true" className={TEXT_MUTED}>
                      /
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <p className={cx("hidden shrink-0 text-xs font-semibold 2xl:block", TEXT_MUTED)}>Non-custodial: Kletia never signs</p>
        <ApiStatusPill health={health} className="hidden shrink-0 md:inline-flex" />
        <KeyMenu open={keyMenuOpen} onOpen={onOpenKeyMenu} onClose={onCloseKeyMenu} />
      </div>
    </nav>
  );
}
