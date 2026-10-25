/**
 * The desk conversation's parts (Card machine):
 *
 * - UserTurn: the person's words as a dark keycap bubble with "You · 09:41" under it; a new one
 *   arrives from +28 px at 0.94 (back.out 1.8) and its key edge grows.
 * - KletiaTurn: the mark and the name, then Kletia's reply (16.5 px, 62ch); 28 px between turns.
 * - SystemNote: an icon, one line, a hairline to the edge ("Card #C21E updated · ...").
 * - ThinkingBlock: three steps on a rail, bound to the real planning request: the first ratchets
 *   with the real elapsed time while the API works; when the answer comes the others tick with
 *   what it actually returned (routes compared, the fare) and the block folds into one line
 *   ("Planned in 2.6 s · 9 routes compared"). Nothing ticks ahead of the API.
 *
 * Styles in conversation.css (a desk chunk stylesheet). Reduced motion: every arrival is a state
 * change, the ratchet stops, the block folds at once.
 */
import "./conversation.css";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Icon, KletiaGlyph, type IconName } from "../../kit";
import { animate, checkPop, EASE, popIn, reducedMotion } from "../../kit/motion";
import { playSound } from "../../kit/sound";
import { reveal } from "./reveal";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/** True for a turn made in the last few seconds (it arrives with motion; older ones just render). Call it in effects. */
function isFresh(at: number | null | undefined, windowMs = 4000): boolean {
  return typeof at === "number" && Date.now() - at < windowMs;
}

export function UserTurn({ text, meta, at, className }: { readonly text: ReactNode; readonly meta?: ReactNode; readonly at?: number; readonly className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!isFresh(at)) return;
    const bubble = ref.current?.querySelector(".kd-bubble");
    popIn(bubble, { y: 28, scale: 0.94, duration: 600, back: 1.8 });
    reveal(ref.current);
    animate(bubble, [{ boxShadow: "0 0 0 #000" }, {}], { duration: 300, delay: 350 });
    // `fresh` is read once: a turn animates when it first mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className={cx("kd-turn-u", className)}>
      <p className="kd-bubble">{text}</p>
      {meta ? <p className="kd-u-meta">{meta}</p> : null}
    </div>
  );
}

export function KletiaMark() {
  return (
    <span className="kd-mark" aria-hidden="true">
      <KletiaGlyph />
    </span>
  );
}

export interface KletiaTurnProps {
  readonly children: ReactNode;
  /** After the name ("Base engine"). */
  readonly badge?: ReactNode;
  /** Arrives with motion: true, or the time the turn was made (motion within 4 s of it). */
  readonly fresh?: boolean;
  readonly at?: number;
  readonly label?: string;
  readonly className?: string;
  /** The question sound when it arrives (a turn that asks). */
  readonly asks?: boolean;
}

export function KletiaTurn({ children, badge, fresh = false, at, label, className, asks = false }: KletiaTurnProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!fresh && !isFresh(at)) return;
    animate(ref.current, [{ transform: "translateY(14px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 450, easing: EASE.outPow(3) });
    if (asks) playSound("question");
    reveal(ref.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section ref={ref} className={cx("kd-turn-k", className)} aria-label={label}>
      <p className="kd-who">
        <KletiaMark />
        <span>Kletia</span>
        {badge ? <span className="kd-who-badge">{badge}</span> : null}
      </p>
      {children}
    </section>
  );
}

/** Kletia's words in a turn (16.5 px, 62ch). */
export function Say({ children, muted = false, className }: { readonly children: ReactNode; readonly muted?: boolean; readonly className?: string }) {
  return <p className={cx("kd-say", muted && "kd-say--muted", className)}>{children}</p>;
}

export function SystemNote({ icon = "flip", children, action, tone, role }: { readonly icon?: IconName; readonly children: ReactNode; readonly action?: ReactNode; readonly tone?: "warn"; readonly role?: "status" | "alert" }) {
  return (
    <p className="kd-note" data-tone={tone} role={role}>
      <Icon name={icon} />
      <span className="kd-note-t">{children}</span>
      {action ? <span className="kd-note-a">{action}</span> : null}
    </p>
  );
}

/* ---------- thinking ---------- */
export interface ThinkingResult {
  /** How long the request took (ms, measured by the browser). */
  readonly ms: number;
  readonly outcome: "planned" | "question" | "failed" | "other";
  /** What the second and third steps report (real values from the answer), e.g. "9 compared", "$0.02 fees". */
  readonly details: readonly [string | null, string | null];
  /** The folded line ("Planned in 2.6 s · 9 routes compared"). */
  readonly summary: string;
}

export interface ThinkingBlockProps {
  /** When the request went out (ms since epoch). */
  readonly startedAt: number;
  /** Null while the API works. */
  readonly result: ThinkingResult | null;
  /** The three step labels. */
  readonly steps?: readonly [string, string, string];
  /** Render folded at once (a card mounted again, a restored task). */
  readonly folded?: boolean;
  /** Called once the block has folded (what follows, the printed card, waits for it). */
  readonly onFolded?: () => void;
}

const STEPS: readonly [string, string, string] = ["Reading your request", "Comparing routes on 9 networks", "Pricing the fare"];

type RowState = "pending" | "active" | "done" | "failed";

/** Elapsed seconds while the request is out (the first step's live time). */
function useElapsed(startedAt: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running]);
  return Math.max(0, now - startedAt);
}

export function ThinkingBlock({ startedAt, result, steps = STEPS, folded: foldedAtMount = false, onFolded }: ThinkingBlockProps) {
  /** Rows after the first that ticked with the answer (0..2). */
  const [shown, setShown] = useState<number>(() => (result || foldedAtMount ? 2 : 0));
  const [folded, setFolded] = useState(foldedAtMount || (result !== null && reducedMotion()));
  const elapsed = useElapsed(startedAt, result === null);
  const block = useRef<HTMLDivElement>(null);
  const sawWork = useRef(result === null);

  // The answer arrived: the remaining rows tick in order with what the API returned, then the block folds.
  useEffect(() => {
    if (!result || folded) return undefined;
    if (!sawWork.current || reducedMotion()) {
      setShown(2);
      setFolded(true);
      return undefined;
    }
    const timers: number[] = [];
    const last = result.outcome === "planned" ? 2 : result.outcome === "failed" ? 0 : 1;
    if (result.outcome === "failed") playSound("error");
    for (let index = 1; index <= last; index += 1) {
      timers.push(
        window.setTimeout(() => {
          setShown(index);
          playSound("step", 0.9);
        }, (index - 1) * 260),
      );
    }
    timers.push(
      window.setTimeout(() => {
        const element = block.current;
        if (!element) return setFolded(true);
        const height = element.offsetHeight;
        void animate(element, [{ height: `${height}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 400, easing: EASE.mech, fill: "forwards" })
          ?.finished.catch(() => undefined)
          .finally(() => setFolded(true));
      }, last * 260 + (result.outcome === "failed" ? 1400 : 700)),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [folded, result]);

  const foldedOnce = useRef(false);
  useEffect(() => {
    if (!folded || !result || foldedOnce.current) return;
    foldedOnce.current = true;
    onFolded?.();
  }, [folded, onFolded, result]);

  const rows: RowState[] = [0, 1, 2].map((index) => {
    if (!result) return index === 0 ? "active" : "pending";
    if (index === 0) return "done";
    if (result.outcome === "failed") return index === 1 ? "failed" : "pending";
    return index <= shown ? "done" : "pending";
  });
  const times = [result ? `${(result.ms / 1000).toFixed(1)} s` : `${(elapsed / 1000).toFixed(1)} s`, result?.details[0] ?? null, result?.details[1] ?? null];

  if (folded && result) {
    return (
      <p className="kd-work-sum" data-outcome={result.outcome}>
        <Icon name={result.outcome === "failed" ? "warn" : "check"} />
        {result.summary}
      </p>
    );
  }
  return (
    <div ref={block} className="kd-work" role="status" aria-live="polite" aria-label={result ? result.summary : `${steps[0]}…`}>
      {steps.map((label, index) => (
        <WorkRow key={label} label={label} state={rows[index]!} time={rows[index] === "done" || index === 0 ? times[index] : null} />
      ))}
    </div>
  );
}

function WorkRow({ label, state, time }: { readonly label: string; readonly state: RowState; readonly time: string | null }) {
  const tick = useRef<HTMLSpanElement>(null);
  const previous = useRef(state);
  useEffect(() => {
    if (state === "done" && previous.current !== "done") checkPop(tick.current);
    previous.current = state;
  }, [state]);
  return (
    <div className="kd-work-row" data-state={state}>
      <span ref={tick} className="kd-tick" aria-hidden="true">
        {state === "done" ? <Icon name="check" /> : state === "failed" ? <Icon name="x" /> : state === "active" ? <span className="kd-gear" /> : null}
      </span>
      <span className="kd-wl">{label}</span>
      <span className="kd-wt">{time ?? ""}</span>
    </div>
  );
}
