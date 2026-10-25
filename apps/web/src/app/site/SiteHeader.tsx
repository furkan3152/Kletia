import { ArrowUpRight, GitFork, Menu, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { MiniPlate } from "../kit";
import { Link } from "../routes/Link";
import { useRoute } from "../routes/useRoute";
import { DURATION, EASE } from "./motion/tokens";
import { observeIntersection } from "./motion/useInView";
import { prefersReducedMotion } from "./motion/useReducedMotion";
import { PRIMARY_NAV } from "./siteLinks";
import type { SiteTheme } from "./theme";
import { ThemeToggle } from "./ThemeToggle";
import { ButtonLink } from "./ui/Button";
import { CONTAINER, cx } from "./ui/styles";

export interface SiteHeaderProps {
  readonly theme: SiteTheme;
  readonly onToggleTheme: (origin?: { x: number; y: number }) => void;
}

// Card machine chrome: sentence-case links in Funnel Sans; the current page carries a
// lime bar under ink (chrome.css). The classes live in chrome.css, loaded with the site layout.
const NAV_LINK = "ks-nav-link";
const MOBILE_LINK = "ks-mlink";

/** Sticky site header with primary navigation, theme toggle and a mobile menu. */
export function SiteHeader({ theme, onToggleTheme }: SiteHeaderProps) {
  const { location } = useRoute();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(location.key);
  const [scrolled, setScrolled] = useState(false);
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close the mobile menu after any navigation.
  const menuOpen = open && openedAt === location.key;

  // A 1px sentinel at the top of the page: once it leaves the viewport the header gets its scrolled shadow.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return undefined;
    return observeIntersection(sentinel, (entry) => setScrolled(!entry.isIntersecting));
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  // Opening the menu: the panel drops 8px into place and the links follow 40ms apart. Closing stays instant.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!menuOpen || !panel || prefersReducedMotion() || typeof panel.animate !== "function") return undefined;
    const animations: Animation[] = [
      panel.animate([{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }], {
        duration: 180,
        easing: EASE.out,
      }),
    ];
    panel.querySelectorAll<HTMLElement>("[data-menu-item]").forEach((item, index) => {
      animations.push(
        item.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], {
          duration: DURATION.base,
          delay: 60 + index * 40,
          easing: EASE.out,
          fill: "backwards",
        }),
      );
    });
    return () => animations.forEach((animation) => animation.cancel());
  }, [menuOpen]);

  return (
    <>
      <span ref={sentinelRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-px w-px" />
      <header data-scrolled={scrolled ? "" : undefined} data-kl-vt-stable="" className="kl-site-header ks-header">
        <div className={cx(CONTAINER, "ks-bar")}>
          <MiniPlate className="ks-plate" />

          <nav aria-label="Primary" className="ks-nav">
            <ul>
              {PRIMARY_NAV.map((item) => (
                <li key={item.label}>
                  {item.external ? (
                    <a href={item.to} target="_blank" rel="noopener noreferrer" title={item.compact ? item.label : undefined} className={NAV_LINK}>
                      {item.compact ? <GitFork className="ks-compact-ic" aria-hidden="true" /> : null}
                      <span className={item.compact ? "ks-compact-l" : undefined}>{item.label}</span>
                      <ArrowUpRight className="ks-ext" aria-hidden="true" />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    <Link to={item.to} className={NAV_LINK}>
                      {item.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>

          <div className="ks-right">
            <ThemeToggle theme={theme} onToggle={onToggleTheme} className="ks-theme" />
            <ButtonLink to="/app" size="md" className="ks-cta">
              Open the console
            </ButtonLink>
            <button
              ref={toggleRef}
              type="button"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              onClick={() => {
                setOpen(!menuOpen);
                setOpenedAt(location.key);
              }}
              className="k-key k-key--sq ks-menu"
            >
              {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
            </button>
          </div>
        </div>

        <div ref={panelRef} id={menuId} hidden={!menuOpen} className="ks-mpanel">
          <nav aria-label="Mobile" className={CONTAINER}>
            <ul>
              {PRIMARY_NAV.map((item) => (
                <li key={item.label} data-menu-item>
                  {item.external ? (
                    <a href={item.to} target="_blank" rel="noopener noreferrer" className={MOBILE_LINK}>
                      {item.label}
                      <ArrowUpRight aria-hidden="true" />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    <Link to={item.to} onClick={() => setOpen(false)} className={MOBILE_LINK} activeClassName="ks-mlink--on">
                      {item.label}
                      <span aria-hidden="true">→</span>
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            <div data-menu-item>
              <ButtonLink to="/app" size="lg" className="ks-mcta" onClick={() => setOpen(false)}>
                Open the console
              </ButtonLink>
            </div>
          </nav>
        </div>
      </header>
    </>
  );
}
