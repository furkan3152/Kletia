/**
 * Instruments: the physical controls and printed objects of the Trade, Portfolio and Automate
 * screens.
 *
 *   <Fader label="Leverage" value={3} min={1} max={40} detents={[1, 5, 10, 20, 40]} format={(v) => `${v}x`} onChange={...} />
 *   <Cartridges label="Venue" value="best" onChange={...} options={[{ id: "best", label: "Best venue", detail: "GMX v2", icon: "star" }, ...]} />
 *   <MiniCard kind="Swap" serial="C21E" title="0.4 SOL to USDC" sub="Jupiter" route={["solana"]} date="Oct 23" tag="settled" />
 *   <ScheduleDial fraction={0.25} label="Next run in 6 h" />
 *   <Terminal title="curl" lines={...} />  (a code block as a terminal module)
 *
 * Styles in instruments.css (loaded with this file, never in the entry stylesheet).
 */
import "./kit.css";
import "./instruments.css";

import { useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { Icon } from "./icons";
import { networkIcon, type IconName } from "./iconPaths";
import { playSound } from "./sound";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/* ---------- fader (a slider with detents and a physical cap) ---------- */
export interface FaderProps {
  readonly label: ReactNode;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  /** Labelled detents under the track (values inside [min, max]); each one clicks as the cap passes. */
  readonly detents?: readonly number[];
  readonly onChange: (next: number) => void;
  /** How the value prints on the right of the label row and under the detents ("3.0x"). */
  readonly format?: (value: number) => string;
  /** Muted line under the fader ("Size 300.00 USDC"). */
  readonly hint?: ReactNode;
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * The leverage fader: a recessed track, the travelled part in ink, a
 * keycap with a grip line, detent ticks with labels. A native range input sits on top, so
 * keyboard, touch and screen readers work as they do on any slider.
 */
export function Fader({ label, value, min, max, step = 1, detents = [], onChange, format = String, hint, disabled, className }: FaderProps) {
  const id = useId();
  const span = Math.max(1e-9, max - min);
  const clamped = Math.min(max, Math.max(min, value));
  const at = (clamped - min) / span;
  const last = useRef(clamped);
  const marks = detents.filter((mark) => mark >= min && mark <= max);
  const change = (next: number) => {
    const before = last.current;
    last.current = next;
    if (marks.some((mark) => (before < mark && next >= mark) || (before > mark && next <= mark))) playSound("tick");
    onChange(next);
  };
  return (
    <div className={cx("k-fader", className)} data-disabled={disabled ? "" : undefined}>
      <div className="k-fader-l">
        <label htmlFor={id} className="k-field-label">
          {label}
        </label>
        <output htmlFor={id} className="k-fader-v k-num">
          {format(clamped)}
        </output>
      </div>
      <div className="k-fader-body" style={{ "--at": at } as CSSProperties}>
        <span className="k-fader-track" aria-hidden="true">
          <i />
        </span>
        <span className="k-fader-ticks" aria-hidden="true">
          {marks.map((mark) => (
            <span key={mark} style={{ left: `${((mark - min) / span) * 100}%` }}>
              <b>{format(mark)}</b>
            </span>
          ))}
        </span>
        <span className="k-fader-cap" aria-hidden="true" />
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={clamped}
          disabled={disabled}
          aria-valuetext={format(clamped)}
          onChange={(event) => change(Number(event.target.value))}
        />
      </div>
      {hint ? <p className="k-field-hint">{hint}</p> : null}
    </div>
  );
}

/* ---------- cartridges (a picker of seated cartridges) ---------- */
export interface CartridgeOption<T extends string> {
  readonly id: T;
  readonly label: string;
  /** A muted readout under the name ("max 40x", "fees $0.21"). */
  readonly detail?: ReactNode;
  readonly icon?: IconName;
  /** The coloured label stripe (a CSS colour); default the line colour. */
  readonly stripe?: string;
  readonly disabled?: boolean;
  /** Accessible description when the option is disabled (why). */
  readonly reason?: string;
}

export interface CartridgesProps<T extends string> {
  readonly label: string;
  readonly options: readonly CartridgeOption<T>[];
  readonly value: T;
  readonly onChange: (next: T) => void;
  /** Visible group label above the rack (the accessible name either way). */
  readonly showLabel?: boolean;
  readonly className?: string;
}

/**
 * Venues, networks or wallets as cartridges in a rack: the chosen one is
 * seated (ink edge, lime lamp). A radiogroup: arrows move, Home/End jump, disabled ones skip.
 */
export function Cartridges<T extends string>({ label, options, value, onChange, showLabel = true, className }: CartridgesProps<T>) {
  const labelId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0);
  const current = options.findIndex((option) => option.id === value);
  const move = (event: KeyboardEvent) => {
    const position = Math.max(0, enabled.indexOf(current));
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = enabled[(position + 1) % enabled.length];
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = enabled[(position - 1 + enabled.length) % enabled.length];
    else if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled[enabled.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.id);
    refs.current[next]?.focus();
  };
  return (
    <div className={cx("k-carts-wrap", className)}>
      {showLabel ? (
        <p id={labelId} className="k-field-label">
          {label}
        </p>
      ) : null}
      <div role="radiogroup" aria-label={showLabel ? undefined : label} aria-labelledby={showLabel ? labelId : undefined} className="k-carts" onKeyDown={move}>
        {options.map((option, index) => {
          const on = option.id === value;
          return (
            <button
              key={option.id}
              ref={(element) => {
                refs.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={option.disabled ? true : undefined}
              title={option.disabled ? option.reason : undefined}
              tabIndex={on || (current < 0 && index === enabled[0]) ? 0 : -1}
              className="k-cart"
              style={option.stripe ? ({ "--k-cart-stripe": option.stripe } as CSSProperties) : undefined}
              onClick={() => {
                if (option.disabled || on) return;
                playSound("key", 0.7);
                onChange(option.id);
              }}
            >
              {option.icon ? <Icon name={option.icon} className="k-cart-ic" /> : <span className="k-cart-ic" aria-hidden="true" />}
              <span className="k-cart-nm">{option.label}</span>
              <span className="k-cart-lamp" aria-hidden="true" />
              {option.detail ? <span className="k-cart-rd">{option.detail}</span> : null}
              {option.disabled && option.reason ? <span className="sr-only">{option.reason}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- mini card (a settled card in the binder) ---------- */
export type CardFoil = "holo" | "silver" | "gold" | null;

export interface MiniCardProps {
  /** Band label ("Swap"). */
  readonly kind: string;
  readonly serial: string;
  readonly title: string;
  readonly sub?: string | null;
  /** The networks the card touched, in order: drawn as cartridges on a rail in the art window. */
  readonly route?: readonly string[];
  /** Footer left (the date) and right (a tag: "cross-chain", "settled"). */
  readonly date?: string | null;
  readonly tag?: string | null;
  /** Foils are earned by facts (cross-chain = holo), never random. */
  readonly foil?: CardFoil;
  /** A failed or expired card: grey band. */
  readonly void?: boolean;
  /** Controls under the card (Share). */
  readonly children?: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/** The binder's card on the Portfolio screen: band + serial, the route art, title, mono sub, date and tag. */
export function MiniCard({ kind, serial, title, sub, route = [], date, tag, foil = null, void: isVoid = false, children, className, style }: MiniCardProps) {
  const stops = route.length > 0 ? route : [];
  return (
    <article className={cx("k-mini", className)} style={style} data-foil={foil ?? undefined} data-void={isVoid ? "" : undefined} aria-label={`${kind} card ${serial}: ${title}`}>
      <div className="k-mini-top">
        <span>{kind}</span>
        <span className="k-mini-serial">#{serial}</span>
      </div>
      <div className="k-mini-art" aria-hidden="true">
        {stops.length > 0 ? (
          <span className="k-mini-rail">
            {stops.map((stop, index) => (
              <span key={`${stop}-${index}`} className="k-mini-stop">
                {index > 0 ? <i className="k-mini-line" /> : null}
                <span className="k-mini-node">
                  <Icon name={networkIcon(stop)} />
                </span>
              </span>
            ))}
          </span>
        ) : (
          <span className="k-mini-node k-mini-node--blank">
            <Icon name="binder" />
          </span>
        )}
        <span className="k-mini-foil" />
      </div>
      <div className="k-mini-body">
        <b>{title}</b>
        {sub ? <small>{sub}</small> : null}
      </div>
      <div className="k-mini-foot">
        <span>{date ?? ""}</span>
        <span>{tag ?? ""}</span>
      </div>
      {children ? <div className="k-mini-act">{children}</div> : null}
    </article>
  );
}

/* ---------- schedule dial ---------- */
/**
 * A small engraved dial whose lime pointer shows how far the current period has run (0..1): the
 * automation's schedule. null parks the pointer and dims the face (no schedule, or unknown).
 */
export function ScheduleDial({ fraction, label, caption, className }: { readonly fraction: number | null; readonly label: string; readonly caption?: ReactNode; readonly className?: string }) {
  const angle = fraction === null ? -135 : -135 + Math.min(1, Math.max(0, fraction)) * 270;
  return (
    <span className={cx("k-sdial", className)} role="img" aria-label={label} data-idle={fraction === null ? "" : undefined}>
      <span className="k-sdial-face" aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => (
          <i key={index} style={{ transform: `rotate(${-135 + (index * 270) / 11}deg)` }} />
        ))}
        <span className="k-sdial-arc" style={{ "--to": `${fraction === null ? 0 : Math.min(1, Math.max(0, fraction)) * 270}deg` } as CSSProperties} />
        <span className="k-sdial-knob" style={{ transform: `rotate(${angle}deg)` }}>
          <b />
        </span>
      </span>
      {caption ? <span className="k-sdial-cap" aria-hidden="true">{caption}</span> : null}
    </span>
  );
}

/* ---------- terminal (a code block as a terminal module) ---------- */
export interface TerminalProps {
  /** The tab label ("curl", "server.ts"). */
  readonly title?: ReactNode;
  /** Right side of the title bar (a Copy key). */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** A terminal module: a dark screen in a bezel with a title bar (three lamps, a tab) and a slot for a Copy key. */
export function Terminal({ title, actions, children, className }: TerminalProps) {
  return (
    <div className={cx("k-term", className)}>
      <div className="k-term-bar">
        <span className="k-term-lamps" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {title ? <span className="k-term-title">{title}</span> : <span />}
        {actions ? <span className="k-term-act">{actions}</span> : null}
      </div>
      <div className="k-term-screen">{children}</div>
    </div>
  );
}
