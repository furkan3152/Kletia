/**
 * Selectors: the rotary mode Dial, the Segmented bar with a sliding key, option keys (the
 * answers to a question), chips (suggestions) and the Field (a recessed screen with a unit).
 */
import "./kit.css";

import { useEffect, useId, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";

import { animate, EASE, reducedMotion } from "./motion";
import { playSound, playSoundAt } from "./sound";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/* ---------- rotary dial ---------- */
export interface DialOption<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Muted count or hint beside the label ("3"). */
  readonly meta?: string;
}

export interface DialProps<T extends string> {
  readonly options: readonly DialOption<T>[];
  /** The current detent; null parks the knob on no label (a view outside the dial). */
  readonly value: T | null;
  readonly onChange: (next: T) => void;
  readonly label: string;
  /** Detent angles in degrees, one per option (default: -66/-22/22/66 for four). */
  readonly angles?: readonly number[];
  /** Spin in from -150 deg once (the boot). */
  readonly boot?: boolean;
  readonly className?: string;
}

function detents(count: number): number[] {
  if (count === 4) return [-66, -22, 22, 66];
  const span = 132;
  return Array.from({ length: count }, (_, index) => (count === 1 ? 0 : -span / 2 + (span * index) / (count - 1)));
}

/**
 * The rotary mode selector: a knob with a lime pointer and detent
 * ticks, the options listed beside it. A radiogroup: arrow keys move one detent (with the
 * detent clicks), Home/End jump; clicking the knob advances one detent.
 */
export function Dial<T extends string>({ options, value, onChange, label, angles, boot = false, className }: DialProps<T>) {
  const stops = angles ?? detents(options.length);
  const index = value === null ? -1 : options.findIndex((option) => option.id === value);
  const angle = index < 0 ? stops[0]! - 24 : stops[index]!;
  const knob = useRef<HTMLSpanElement>(null);
  const last = useRef<number | null>(null);
  const booted = useRef(false);
  const labelId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  useLayoutEffect(() => {
    const element = knob.current;
    if (!element) return;
    const from = last.current;
    last.current = angle;
    element.style.transform = `rotate(${angle}deg)`;
    if (boot && !booted.current) {
      booted.current = true;
      animate(element, [{ transform: "rotate(-150deg)" }, { transform: `rotate(${angle}deg)` }], { duration: 900, delay: 150, easing: EASE.back(2.2) });
      return;
    }
    if (from === null || from === angle) return;
    animate(element, [{ transform: `rotate(${from}deg)` }, { transform: `rotate(${angle}deg)` }], { duration: 500, easing: EASE.back(2.6) });
    if (!reducedMotion()) {
      playSound("tick");
      playSoundAt("tick", 90, 0.7);
    }
  }, [angle, boot]);

  const choose = (next: number, focus = false) => {
    const option = options[(next + options.length) % options.length];
    if (!option) return;
    onChange(option.id);
    if (focus) buttons.current[(next + options.length) % options.length]?.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    const at = Math.max(0, index);
    if (event.key === "ArrowDown" || event.key === "ArrowRight") choose(at + 1, true);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") choose(at - 1, true);
    else if (event.key === "Home") choose(0, true);
    else if (event.key === "End") choose(options.length - 1, true);
    else return;
    event.preventDefault();
  };

  return (
    <div className={cx("k-dial", className)}>
      <span className="k-dial-knobwell" aria-hidden="true">
        {stops.map((stop) => (
          <i key={stop} className="k-dial-tick" style={{ transform: `rotate(${stop}deg)` }} />
        ))}
        <span ref={knob} className="k-dial-knob" onClick={() => choose(index + 1)}>
          <i />
        </span>
      </span>
      <div role="radiogroup" aria-label={label} id={labelId} className="k-dial-opts" onKeyDown={onKey}>
        {options.map((option, at) => {
          const on = at === index;
          return (
            <button
              key={option.id}
              ref={(element) => {
                buttons.current[at] = element;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on || (index < 0 && at === 0) ? 0 : -1}
              className="k-dial-opt"
              onClick={() => onChange(option.id)}
            >
              <span className="k-dial-dot" aria-hidden="true" />
              <span>{option.label}</span>
              {option.meta ? <small>{option.meta}</small> : <span />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- segmented (sliding key) ---------- */
export interface SegmentedOption<T extends string> {
  readonly id: T;
  readonly label: ReactNode;
  /** Accessible name when the label is an icon or abbreviated. */
  readonly ariaLabel?: string;
}

export interface SegmentedProps<T extends string> {
  readonly options: readonly SegmentedOption<T>[];
  readonly value: T | null;
  readonly onChange: (next: T) => void;
  /** "pressed": a toggle group (aria-pressed); "page": navigation (aria-current="page"). */
  readonly mode?: "pressed" | "page";
  /** Stretch to the container width, equal columns. */
  readonly fill?: boolean;
  readonly tall?: boolean;
  readonly className?: string;
  readonly ariaLabel?: string;
}

/**
 * Segmented keys in a recessed well; the chosen key is a raised cap that slides between
 * positions on a spring (500 ms elastic.out(1, .7)) with a tick.
 */
export function Segmented<T extends string>({ options, value, onChange, mode = "pressed", fill = false, tall = false, className, ariaLabel }: SegmentedProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  const index = options.findIndex((option) => option.id === value);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const place = () => {
      const button = element.querySelectorAll<HTMLButtonElement>(".k-seg-btn")[index];
      if (!button) return setPill(null);
      setPill({ x: button.offsetLeft, w: button.offsetWidth });
    };
    place();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [index, options.length]);

  const Wrapper = mode === "page" ? "nav" : "div";
  return (
    <Wrapper className={cx("k-seg", fill && "k-seg--fill", tall && "k-seg--tall", className)} aria-label={ariaLabel} {...(mode === "pressed" ? { role: "group" } : {})}>
      <div ref={root} style={{ display: "contents" }}>
        {pill ? (
          <span
            aria-hidden="true"
            className="k-seg-pill"
            style={{ width: pill.w, transform: `translateX(${pill.x}px)`, transition: reducedMotion() ? "none" : `transform 500ms ${EASE.elastic(1, 0.7)}, width 500ms ${EASE.elastic(1, 0.7)}` }}
          />
        ) : null}
        {options.map((option) => {
          const on = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              className="k-seg-btn"
              aria-label={option.ariaLabel}
              {...(mode === "page" ? { "aria-current": on ? "page" : undefined } : { "aria-pressed": on })}
              onClick={() => {
                if (!on) playSound("tick");
                onChange(option.id);
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </Wrapper>
  );
}

/* ---------- option keys + chips ---------- */
export interface OptionKeyProps {
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  /** Chosen (lime, pressed in). */
  readonly selected?: boolean;
  /** Dimmed (another option was chosen). */
  readonly dim?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
  readonly className?: string;
}

/**
 * An answer key (2-3 per question): title + detail, chosen = lime and pressed, the rest dim.
 * Press pops 1.06 back to 1 with the `chip` sound. Group them in <OptionKeys>.
 */
export function OptionKey({ title, detail, selected = false, dim = false, disabled, onSelect, className }: OptionKeyProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const wasSelected = useRef(selected);
  useEffect(() => {
    if (selected && !wasSelected.current) animate(ref.current, [{ transform: "translateY(2px) scale(1.06)" }, { transform: "translateY(2px)" }], { duration: 320, easing: EASE.back(2) });
    wasSelected.current = selected;
  }, [selected]);
  return (
    <button
      ref={ref}
      type="button"
      className={cx("k-opt", className)}
      aria-pressed={selected}
      data-dim={dim && !selected ? "" : undefined}
      disabled={disabled}
      onPointerDown={() => playSound("chip")}
      onClick={onSelect}
    >
      <b>{title}</b>
      {detail ? <span>{detail}</span> : null}
    </button>
  );
}

/** A row of option keys; staggers them in (80 ms) when it mounts. */
export function OptionKeys({ children, label, className }: { readonly children: ReactNode; readonly label?: string; readonly className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelectorAll(".k-opt").forEach((element, index) => animate(element, [{ transform: "translateY(10px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 360, delay: index * 80, easing: EASE.back(1.8) }));
  }, []);
  return (
    <div ref={ref} role="group" aria-label={label} className={cx("k-opts", className)}>
      {children}
    </div>
  );
}

/** A rounded suggestion chip (icon + text). */
export function Chip({ icon, children, onClick, className }: { readonly icon?: ReactNode; readonly children: ReactNode; readonly onClick?: () => void; readonly className?: string }) {
  return (
    <button type="button" className={cx("k-chip", className)} onClick={onClick} onPointerDown={() => playSound("key", 0.6)}>
      {icon}
      {children}
    </button>
  );
}

/* ---------- field ---------- */
export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  readonly label: ReactNode;
  readonly unit?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
}

/** A labelled numeric/text field on a recessed screen (Geist Mono 20 px), lime focus halo. */
export function Field({ label, unit, hint, error, id, className, ...input }: FieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = `${inputId}-hint`;
  return (
    <div className={cx("k-field", className)} data-invalid={error ? "" : undefined}>
      <label className="k-field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="k-field-screen">
        <input id={inputId} aria-invalid={error ? true : undefined} aria-describedby={hint || error ? hintId : undefined} {...input} />
        {unit ? <span className="k-field-unit">{unit}</span> : null}
      </div>
      {error || hint ? (
        <p id={hintId} className="k-field-hint" style={error ? { color: "var(--k-down)" } : undefined}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}
