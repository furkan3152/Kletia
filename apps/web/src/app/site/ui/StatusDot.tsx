import { cx } from "./styles";

export type HealthState = "ok" | "degraded" | "down" | "unknown" | "loading";

const STYLES: Record<HealthState, { color: string; label: string }> = {
  ok: { color: "#14F195", label: "Operational" },
  degraded: { color: "#FFD60A", label: "Degraded" },
  down: { color: "#FF5A5F", label: "Down" },
  unknown: { color: "#94A3B8", label: "Unknown" },
  loading: { color: "#94A3B8", label: "Checking" },
};

export interface StatusDotProps {
  readonly state: HealthState;
  /** Overrides the default text label. */
  readonly label?: string;
  readonly showLabel?: boolean;
  readonly className?: string;
}

/** Colour dot plus a text label (status is never conveyed by colour alone). */
export function StatusDot({ state, label, showLabel = true, className }: StatusDotProps) {
  const style = STYLES[state];
  const text = label ?? style.label;
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <span aria-hidden="true" className="relative inline-flex h-3 w-3 shrink-0">
        {state === "ok" ? (
          <span
            className="kl-ping absolute inline-flex h-full w-full rounded-full opacity-60"
            style={{ backgroundColor: style.color }}
          />
        ) : null}
        <span
          className={cx(
            "relative inline-flex h-3 w-3 rounded-full border-2 border-[#1A1A1A] dark:border-[#0B1120]",
            state === "loading" && "animate-pulse motion-reduce:animate-none",
          )}
          style={{ backgroundColor: style.color }}
        />
      </span>
      {showLabel ? (
        <span className="text-[11px] font-black uppercase tracking-[0.14em]">{text}</span>
      ) : (
        <span className="sr-only">{text}</span>
      )}
    </span>
  );
}
