import { Check } from "lucide-react";
import React, { useEffect, useState } from "react";

import { FlowLine } from "../../site/motion/FlowLine";
import { useInView } from "../../site/motion/useInView";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { cx } from "../../site/ui/styles";
import { ScrambleText } from "./ScrambleText";

interface Block {
  readonly label: string;
  readonly detail: React.ReactNode | ((play: boolean) => React.ReactNode);
  readonly color: string;
  readonly ink: string;
}

const BLOCKS: readonly Block[] = [
  { label: "Unsigned tx", detail: "POST /v1/intents", color: "#CBD5E1", ink: "#0B1120" },
  { label: "Wallet signature", detail: "your keys, your wallet", color: "#FFD60A", ink: "#1A1A1A" },
  {
    label: "Observed on-chain",
    detail: (play) => <ScrambleText text="0x9c2e…41b7" play={play} />,
    color: "#9945FF",
    ink: "#FFFFFF",
  },
  { label: "Settled", detail: "StepEvidence", color: "#14F195", ink: "#0B1120" },
];

const STEP_MS = 450;

function Connector({ lit, animate, color }: { lit: boolean; animate: boolean; color: string }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center justify-center self-center">
      <svg viewBox="0 0 48 20" className="hidden h-5 w-12 md:block">
        <FlowLine key={lit ? "lit" : "idle"} d="M2 10 H46" color={color} draw={lit && animate} glow={lit} packets={0} inkClassName="stroke-white/80" />
      </svg>
      <svg viewBox="0 0 20 28" className="h-7 w-5 md:hidden">
        <FlowLine key={lit ? "lit" : "idle"} d="M10 2 V26" color={color} draw={lit && animate} glow={lit} packets={0} inkClassName="stroke-white/80" />
      </svg>
    </span>
  );
}

/**
 * The evidence chain above the security controls: unsigned transaction →
 * wallet signature → observed on-chain → settled, then a shield that locks.
 * Lights up once when scrolled into view; reduced motion shows the final
 * state. Decorative: an sr-only sentence states the same chain.
 */
export function EvidenceChain() {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>({ once: true, threshold: 0.4 });
  const [count, setCount] = useState(0);
  const lit = reduced ? BLOCKS.length + 1 : count;
  const animate = !reduced;

  useEffect(() => {
    if (reduced || !inView || count > BLOCKS.length) return undefined;
    const timer = window.setTimeout(() => setCount((value) => value + 1), count === 0 ? 150 : STEP_MS);
    return () => window.clearTimeout(timer);
  }, [reduced, inView, count]);

  const locked = lit > BLOCKS.length;

  return (
    <div ref={ref} className="mb-10">
      <p className="sr-only">
        Evidence chain: the API returns an unsigned transaction, your wallet signs it, Kletia observes it on-chain from the
        bound account, and only then is the step settled.
      </p>
      <ol aria-hidden="true" className="flex flex-col items-stretch md:flex-row md:items-center">
        {BLOCKS.map((block, index) => {
          const on = lit > index;
          return (
            <React.Fragment key={block.label}>
              {index > 0 ? <Connector lit={on} animate={animate} color={block.color} /> : null}
              <li
                className={cx(
                  "relative flex min-w-0 flex-1 items-center justify-between gap-3 border-[3px] px-4 py-3 transition-[background-color,color,border-color,box-shadow] duration-240 ease-kl-standard motion-reduce:transition-none",
                  on ? "border-[#1A1A1A] shadow-[4px_4px_0_#FFFFFF]" : "border-white/40 bg-transparent text-white",
                )}
                style={on ? { backgroundColor: block.color, color: block.ink } : undefined}
              >
                <span className="min-w-0">
                  <span className="block font-code text-[10px] font-bold uppercase tracking-[0.16em] opacity-80">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="block font-display text-base font-bold leading-tight">{block.label}</span>
                  <span className="block truncate font-code text-[11px] opacity-85">
                    {typeof block.detail === "function" ? block.detail(on && animate) : block.detail}
                  </span>
                </span>
                <span
                  className={cx(
                    "flex h-7 w-7 shrink-0 items-center justify-center border-2",
                    on ? "border-current" : "border-white/30",
                  )}
                >
                  {on ? <Check key="check" className={cx("h-4 w-4", animate && "kl-stamp")} style={animate ? { animationDelay: "120ms" } : undefined} /> : null}
                </span>
              </li>
            </React.Fragment>
          );
        })}
        <Connector lit={locked} animate={animate} color="#14F195" />
        <li className="flex shrink-0 items-center justify-center self-center">
          <svg viewBox="0 0 48 52" className="h-14 w-14" fill="none">
            {locked ? (
              <path
                d="M24 4 L42 10 V24 C42 35 34 44 24 48 C14 44 6 35 6 24 V10 Z"
                fill="#14F195"
                className={cx("origin-center [transform-box:fill-box]", animate && "kl-stamp")}
                style={animate ? { animationDelay: "380ms" } : undefined}
              />
            ) : null}
            <path
              key={locked ? "locked" : "open"}
              d="M24 4 L42 10 V24 C42 35 34 44 24 48 C14 44 6 35 6 24 V10 Z"
              pathLength={1}
              strokeWidth={3.5}
              strokeLinejoin="round"
              className={cx(locked ? "stroke-[#FFFFFF]" : "stroke-white/35", locked && animate && "kl-draw")}
            />
            {locked ? (
              <path
                d="M15 26 L22 33 L34 19"
                pathLength={1}
                strokeWidth={4.5}
                strokeLinecap="square"
                className={cx("stroke-[#0B1120]", animate && "kl-draw")}
                style={animate ? { animationDelay: "520ms" } : undefined}
              />
            ) : null}
          </svg>
        </li>
      </ol>
    </div>
  );
}
