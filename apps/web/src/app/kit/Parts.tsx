/**
 * Small machine parts: LED, engraved label, vents, module (raised panel), well, LCD status
 * display, odometer number, hardware toggle, nameplates.
 */
import "./kit.css";

import { useEffect, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

import { Link } from "../routes/Link";
import { KletiaGlyph } from "./icons";
import { animate, EASE } from "./motion";
import { playSound } from "./sound";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/* ---------- LED ---------- */
export type LedTone = "off" | "on" | "magenta" | "blue";

/** A status lamp. Colour is never the only cue: pair it with a word. */
export function Led({ tone = "off", blink = false, className }: { readonly tone?: LedTone; readonly blink?: boolean; readonly className?: string }) {
  return <i aria-hidden="true" className={cx("k-ledot", className)} data-tone={tone} data-blink={blink ? "" : undefined} />;
}

/* ---------- engraved label + vents ---------- */
/** The engraved silkscreen label of a module ("Machine", "Balances", "Binder"). */
export function Eng({ as: Tag = "p", className, children, ...rest }: { readonly as?: "p" | "span" | "h2" | "h3"; readonly children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={cx("k-eng", className)} {...rest}>
      {children}
    </Tag>
  );
}

/** Decorative vent slots that fade out to the right. */
export function Vents({ className }: { readonly className?: string }) {
  return <span aria-hidden="true" className={cx("k-vents", className)} />;
}

/* ---------- module ---------- */
export interface ModuleProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** The engraved label; rendered as a heading (h2 by default) so the module is a named region. */
  readonly label?: ReactNode;
  readonly headingLevel?: 2 | 3;
  /** Muted text on the right of the label row ("9 networks"). */
  readonly aside?: ReactNode;
  readonly children?: ReactNode;
}

/** A raised module on the machine (radius 16, hairline, object shadow). */
export function Module({ label, headingLevel = 2, aside, className, children, ...rest }: ModuleProps) {
  const H = headingLevel === 3 ? "h3" : "h2";
  return (
    <section className={cx("k-mod", className)} {...rest}>
      {label || aside ? (
        <div className="k-mod-h">
          {label ? <Eng as={H}>{label}</Eng> : <span />}
          {aside ? <span className="k-muted">{aside}</span> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** A recessed, grained well (binder stack, card tray floor). */
export function Well({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("k-well", className)} {...rest}>
      {children}
    </div>
  );
}

/* ---------- status display (LCD) ---------- */
export interface StatusRow {
  readonly label: string;
  /** null/undefined renders "—": never a made-up number. */
  readonly value: string | null | undefined;
  /** Spoken name when the LCD abbreviation is cryptic ("Base block height"). */
  readonly spoken?: string;
}

/** The green LCD: Doto rows, label left, value right. A description list for screen readers. */
export function StatusDisplay({ rows, label = "Machine status", className }: { readonly rows: readonly StatusRow[]; readonly label?: string; readonly className?: string }) {
  return (
    <dl className={cx("k-lcd", className)} aria-label={label}>
      {rows.map((row) => (
        <div className="k-lcd-row" key={row.label}>
          <dt>
            <span aria-hidden={row.spoken ? true : undefined}>{row.label}</span>
            {row.spoken ? <span className="sr-only">{row.spoken}</span> : null}
          </dt>
          <dd>{row.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------- odometer ---------- */
/**
 * A number whose changed digits roll up like a mechanical counter (550 ms back.out(1.6), 30 ms
 * per position from the right) with a soft tick. The full value is the accessible text.
 */
export function Odometer({ value, className, sound = true }: { readonly value: string; readonly className?: string; readonly sound?: boolean }) {
  const previous = useRef(value);
  const root = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = value;
    if (old === value || !root.current) return;
    const cells = root.current.querySelectorAll<HTMLElement>(".k-odo-cell > span");
    let rolled = 0;
    cells.forEach((cell, index) => {
      const ch = value[index] ?? "";
      if (old[index] !== ch && /\d/u.test(ch)) {
        rolled += 1;
        animate(cell, [{ transform: "translateY(100%)" }, { transform: "none" }], { duration: 550, delay: (value.length - index) * 30, easing: EASE.back(1.6) });
      }
    });
    if (rolled && sound) playSound("tick", 0.6);
  }, [sound, value]);
  return (
    <span className={cx("k-odo k-num", className)}>
      <span className="sr-only">{value}</span>
      <span ref={root} aria-hidden="true">
        {[...value].map((ch, index) => (
          <span className="k-odo-cell" key={index}>
            <span>{ch}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/* ---------- toggle ---------- */
export interface ToggleProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  /** Accessible name ("Sound", "Night mode"). */
  readonly label: string;
  /** Icon or short text beside the track. */
  readonly children?: ReactNode;
  readonly className?: string;
}

/** A hardware slide switch (role="switch"), with the `toggle` click. */
export function Toggle({ checked, onChange, label, children, className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx("k-switch", className)}
      onClick={() => {
        onChange(!checked);
        playSound("toggle");
      }}
    >
      <span className="k-switch-lbl">{children}</span>
      <span className="k-switch-track" aria-hidden="true">
        <i />
      </span>
    </button>
  );
}

/* ---------- nameplates ---------- */
export interface NameplateProps {
  /** Model line, left ("K-01 intent machine"). */
  readonly model?: string;
  /** Model line, right ("SN 7A3F"). */
  readonly serial?: string;
  readonly to?: string;
  readonly label?: string;
  /** Plays the light sweep once (boot). */
  readonly sweep?: boolean;
  readonly className?: string;
}

/** The brushed KLETIA nameplate with engraved word, model/serial line and two screws. */
export function Nameplate({ model = "K-01 intent machine", serial, to = "/", label = "Kletia home", sweep = false, className }: NameplateProps) {
  const shine = useRef<HTMLSpanElement>(null);
  const swept = useRef(false);
  useEffect(() => {
    if (!sweep || swept.current) return;
    swept.current = true;
    animate(shine.current, [{ transform: "translateX(-120%)" }, { transform: "translateX(120%)" }], { duration: 1100, delay: 50, easing: EASE.inOut(2) });
  }, [sweep]);
  return (
    <Link to={to} className={cx("k-plate", className)} aria-label={label}>
      <span className="k-plate-face">
        <KletiaGlyph className="k-plate-mark" />
        <span className="k-plate-word" aria-hidden="true">
          KLETIA
        </span>
      </span>
      <span className="k-plate-model" aria-hidden="true">
        <span>{model}</span>
        {serial ? <span>{serial}</span> : null}
      </span>
      <span ref={shine} className="k-plate-shine" aria-hidden="true" />
    </Link>
  );
}

/** The mini plate of the phone top bar. */
export function MiniPlate({ to = "/", label = "Kletia home", className }: { readonly to?: string; readonly label?: string; readonly className?: string }) {
  return (
    <Link to={to} className={cx("k-miniplate", className)} aria-label={label}>
      <KletiaGlyph size={16} />
      <b aria-hidden="true">KLETIA</b>
    </Link>
  );
}
