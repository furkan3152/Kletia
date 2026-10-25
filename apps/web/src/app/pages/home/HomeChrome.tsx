/**
 * The home page's chrome: skip link, the live tape (GET /v1/health) and the header (mini
 * nameplate, primary navigation, sound key, theme key, "Open the desk"). SiteLayout leaves its
 * own header out on this route (site/siteChrome.ts).
 */
import { useEffect, useId, useRef, useState } from "react";

import { keyClass } from "../../kit/keyClass";
import { playSound, useSoundEnabled } from "../../kit/sound";
import { Link } from "../../routes/Link";
import { useRoute } from "../../routes/useRoute";
import { useSiteThemeState } from "../../site/siteChrome";
import { PRIMARY_NAV } from "../../site/siteLinks";
import { Ico } from "./Ico";
import type { TapeItem } from "./homeLive";

export function SkipLink() {
  return (
    <a
      className="hm-skip"
      href="#main-content"
      onClick={(event) => {
        event.preventDefault();
        const main = document.getElementById("main-content");
        main?.focus({ preventScroll: true });
        main?.scrollIntoView();
      }}
    >
      Skip to content
    </a>
  );
}

/** The ticker: live readouts only (or an honest "checking" / "status unavailable"). */
export function Tape({ items, label }: { readonly items: readonly TapeItem[]; readonly label: string }) {
  const row = (copy: boolean) =>
    items.map((item) => (
      <span className="tape-item" key={`${copy ? "b" : "a"}-${item.key}`}>
        <span className="ledot" data-lamp={item.lamp} />
        <b>{item.label}</b> {item.value}
      </span>
    ));
  return (
    <div className="tape" role="region" aria-label={label}>
      <div className="tape-track" data-short={items.length < 4 ? "" : undefined}>
        <span className="tape-set">{row(false)}</span>
        <span className="tape-set" aria-hidden="true">
          {row(true)}
        </span>
      </div>
    </div>
  );
}

function SoundKey() {
  const [on, setOn] = useSoundEnabled();
  return (
    <button
      type="button"
      className={keyClass({ size: "sm", square: true })}
      aria-pressed={on}
      aria-label="Sound"
      title={on ? "Sound on" : "Sound off"}
      onClick={() => {
        setOn(!on);
        if (!on) window.setTimeout(() => playSound("toggle"), 0);
      }}
    >
      <Ico name={on ? "snd" : "mute"} />
    </button>
  );
}

function ThemeKey() {
  const { theme, toggle } = useSiteThemeState();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      className={keyClass({ size: "sm", square: true })}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={(event) => {
        playSound("swap");
        const rect = event.currentTarget.getBoundingClientRect();
        toggle({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
    >
      <Ico name={dark ? "sun" : "moon"} />
    </button>
  );
}

function NavLink({ to, label, external, onNavigate }: { readonly to: string; readonly label: string; readonly external?: boolean; readonly onNavigate?: () => void }) {
  if (external) {
    return (
      <a href={to} target="_blank" rel="noopener noreferrer">
        {label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <Link to={to} onClick={onNavigate}>
      {label}
    </Link>
  );
}

export function HomeNav() {
  const { location } = useRoute();
  const [openAt, setOpenAt] = useState<number | null>(null);
  const open = openAt !== null && openAt === location.key;
  const setOpen = (next: boolean | ((value: boolean) => boolean)) => setOpenAt((typeof next === "function" ? next(open) : next) ? location.key : null);
  const [stuck, setStuck] = useState(false);
  const menuId = useId();
  const menuKey = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenAt(null);
      menuKey.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="nav" data-stuck={stuck ? "" : undefined}>
      <div className="wrap nav-in">
        <Link to="/" className="miniplate" aria-label="Kletia home">
          <i aria-hidden="true" />
          <b aria-hidden="true">KLETIA</b>
        </Link>
        <nav className="nav-links" aria-label="Primary">
          {PRIMARY_NAV.map((item) => (
            <NavLink key={item.label} to={item.to} label={item.label} external={item.external} />
          ))}
        </nav>
        <span className="sp" />
        <div className="nav-keys">
          <SoundKey />
          <ThemeKey />
          <span className="mag hide-m">
            <Link to="/app" className={keyClass({ tone: "lime", size: "sm" })}>
              Open the desk
            </Link>
          </span>
          <button
            ref={menuKey}
            type="button"
            className={keyClass({ size: "sm", square: true }, "menu-key")}
            aria-expanded={open}
            aria-controls={menuId}
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((value) => !value)}
          >
            <Ico name={open ? "close" : "menu"} />
          </button>
        </div>
      </div>
      <div id={menuId} className="nav-menu" hidden={!open}>
        <nav className="wrap" aria-label="Mobile">
          {PRIMARY_NAV.map((item) => (
            <NavLink key={item.label} to={item.to} label={item.label} external={item.external} onNavigate={() => setOpen(false)} />
          ))}
          <Link to="/app" className={keyClass({ tone: "lime" }, "nav-menu-cta")} onClick={() => setOpen(false)}>
            Open the desk
          </Link>
        </nav>
      </div>
    </header>
  );
}
