import { useEffect, useRef, useState, type ReactNode } from "react";

import { playSound } from "../../kit/sound";
import { observeIntersection } from "../../site/motion/useInView";
import { prefersReducedMotion } from "../../site/motion/useReducedMotion";

export type PrintPhase = "waiting" | "printing" | "printed" | "stamped";

/** Printing takes this long; the stamp lands this long after the ticket clears the slot. */
export const PRINT_MS = 1500;
export const STAMP_DELAY_MS = 280;

export interface TicketPrinterProps {
  /** Engraved label of the printer ("Summit Line"). */
  readonly label: string;
  /** The line's colour: the printer's lamp and the stamp ink. */
  readonly color: string;
  /** Stamp text ("Issued"). */
  readonly stamp: string;
  /** Small print under the stamp word ("Interchange"). */
  readonly stampDetail?: string;
  /**
   * Renders the ticket; `ready` turns true when it has left the slot. The
   * ticket places `stamp` itself, somewhere its mascot never walks.
   */
  readonly children: (ready: boolean, stamp: ReactNode) => ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}

/**
 * Kletia's ticket printer: a slot on the machine, the ticket feeding out of
 * it when the printer scrolls into view, then Kletia's stamp. It says the
 * relationship in one gesture: the line is issued by the Interchange, and
 * keeps its own design. Reduced motion shows the stamped ticket at once.
 */
export function TicketPrinter({ label, color, stamp, stampDetail, children, footer, className }: TicketPrinterProps) {
  const root = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<PrintPhase>(() => (prefersReducedMotion() ? "stamped" : "waiting"));

  useEffect(() => {
    const element = root.current;
    if (!element || prefersReducedMotion()) return undefined;
    const timers: number[] = [];
    const print = () => {
      setPhase("printing");
      playSound("motor", 0.5);
      timers.push(window.setTimeout(() => setPhase("printed"), PRINT_MS));
      timers.push(
        window.setTimeout(() => {
          setPhase("stamped");
          playSound("latch", 0.6);
        }, PRINT_MS + STAMP_DELAY_MS),
      );
    };
    if (typeof IntersectionObserver !== "function") {
      timers.push(window.setTimeout(() => setPhase("stamped"), 0));
      return () => timers.forEach((timer) => window.clearTimeout(timer));
    }
    const stop = observeIntersection(
      element,
      (entry) => {
        if (!entry.isIntersecting) return;
        stop();
        if (prefersReducedMotion()) setPhase("stamped");
        else print();
      },
      { threshold: 0.35 },
    );
    return () => {
      stop();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const ready = phase === "printed" || phase === "stamped";
  return (
    <div ref={root} className={className ? `ktp ${className}` : "ktp"} data-phase={phase} style={{ ["--ktp-line" as string]: color }}>
      <div className="ktp-head">
        <span className="ktp-lamp" aria-hidden="true" />
        <span className="ktp-label">{label}</span>
        <span className="ktp-state" aria-hidden="true">
          {phase === "printing" ? "Printing" : ready ? "Issued" : "Ready"}
        </span>
      </div>
      <div className="ktp-slot" aria-hidden="true" />
      <div className="ktp-feed">
        <div className="ktp-paper">
          {children(
            ready,
            <div className="ktp-stamp" aria-hidden="true">
              <b>{stamp}</b>
              {stampDetail ? <small>{stampDetail}</small> : null}
            </div>,
          )}
        </div>
      </div>
      {footer ? <div className="ktp-foot">{footer}</div> : null}
    </div>
  );
}
