/**
 * The machine itself as illustration and states: the printer window (idle / working / jam), the
 * empty state built on it, the paper-jam error and the toast plate.
 */
import "./kit.css";

import { useEffect, useRef, type ReactNode } from "react";

import { Icon, type IconName } from "./icons";
import { Key } from "./Key";
import { jamShake } from "./motion";
import { playSound } from "./sound";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export type MachineState = "idle" | "working" | "jam";

export interface MachineWindowProps {
  /** idle: the head is parked and bobs, the LED blinks every 2.4 s; working: rollers spin, the gear steps, paper feeds, the head sweeps; jam: the head tilts, the LED blinks magenta. */
  readonly state: MachineState;
  /** The caption under the window ("Idle · print head parked"). */
  readonly caption?: ReactNode;
  readonly className?: string;
}

/** The printer window: an SVG that works. Decorative; the caption carries the state. */
export function MachineWindow({ state, caption, className }: MachineWindowProps) {
  return (
    <div className={cx("k-mwin", className)} data-state={state}>
      <svg viewBox="0 0 300 96" aria-hidden="true" focusable="false">
        <rect x="18" y="56" width="264" height="24" rx="6" fill="var(--k-panel-2)" stroke="var(--k-line-2)" />
        <path className="k-mw-paper" d="M30 68 H270" stroke="var(--k-ink-3)" strokeWidth="2" strokeLinecap="round" />
        <g className="k-mw-rl">
          <circle cx="46" cy="68" r="14" fill="var(--k-key)" stroke="var(--k-ink)" strokeWidth="2" />
          <path d="M46 56 V80 M34 68 H58" stroke="var(--k-ink)" strokeWidth="2" />
        </g>
        <g className="k-mw-rl">
          <circle cx="254" cy="68" r="14" fill="var(--k-key)" stroke="var(--k-ink)" strokeWidth="2" />
          <path d="M254 56 V80 M242 68 H266" stroke="var(--k-ink)" strokeWidth="2" />
        </g>
        <g className="k-mw-gear">
          <circle cx="150" cy="30" r="13" fill="none" stroke="var(--k-ink-3)" strokeWidth="5" strokeDasharray="4 3.2" />
          <circle cx="150" cy="30" r="6" fill="var(--k-panel-2)" stroke="var(--k-ink)" strokeWidth="2" />
        </g>
        <rect x="20" y="16" width="260" height="4" rx="2" fill="var(--k-line-2)" />
        <g className="k-mw-head">
          <rect x="138" y="12" width="24" height="40" rx="5" fill="var(--k-ink)" />
          <rect x="143" y="48" width="14" height="8" rx="2" fill="var(--k-ink-2)" />
          <circle className="k-mw-bulb" cx="150" cy="22" r="3" fill="var(--k-lime)" />
        </g>
      </svg>
      {caption ? <span className="k-mw-l">{caption}</span> : null}
    </div>
  );
}

export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly children?: ReactNode;
  /** An action key or link under the text. */
  readonly action?: ReactNode;
  /** The idle machine caption. */
  readonly caption?: ReactNode;
  readonly className?: string;
}

/** An empty view: the idle machine, a title, one sentence, one action. */
export function EmptyState({ title, children, action, caption = "Idle · print head parked", className }: EmptyStateProps) {
  return (
    <div className={cx("k-empty", className)}>
      <MachineWindow state="idle" caption={caption} />
      <p className="k-empty-t">{title}</p>
      {children ? <p className="k-empty-p">{children}</p> : null}
      {action}
    </div>
  );
}

export interface PaperJamProps {
  /** Bold lead ("Paper jam."). */
  readonly title?: ReactNode;
  /** What happened, plainly; always say what was (not) sent. */
  readonly children: ReactNode;
  /** The retry key ("Reprint"); omit when there is nothing to retry. */
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  /** Shake + `jam` sound when it appears (default true). */
  readonly announce?: boolean;
  readonly className?: string;
}

/** The paper-jam error: magenta-tinted plate, warning icon, plain message, Reprint key. role="alert". */
export function PaperJam({ title = "Paper jam.", children, actionLabel, onAction, announce = true, className }: PaperJamProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!announce) return;
    jamShake(ref.current);
    playSound("jam");
  }, [announce]);
  return (
    <div ref={ref} className={cx("k-jam", className)} role="alert">
      <Icon name="warn" />
      <span>
        <b>{title}</b> {children}
      </span>
      {actionLabel && onAction ? (
        <Key tone="lime" size="sm" onClick={onAction}>
          {actionLabel}
        </Key>
      ) : null}
    </div>
  );
}

export interface ToastPlateProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly tone?: "ok" | "error";
  readonly icon?: IconName;
  readonly children?: ReactNode;
  readonly className?: string;
}

/**
 * The toast plate (dark slot, lime or magenta icon tile). Presentational: the site's toast queue
 * (site/ui/toast.ts + Toaster) renders the same look; use `toast()` from there to show one.
 */
export function ToastPlate({ title, description, tone = "ok", icon, children, className }: ToastPlateProps) {
  return (
    <div className={cx("k-toast", className)} data-tone={tone === "error" ? "error" : undefined}>
      <span className="k-toast-ic" aria-hidden="true">
        <Icon name={icon ?? (tone === "error" ? "warn" : "check")} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <b>{title}</b>
        {description ? <small>{description}</small> : null}
        {children}
      </div>
    </div>
  );
}
