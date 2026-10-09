import { BadgeCheck, Check, MessageSquareText, PenLine, Workflow } from "lucide-react";
import React, { useEffect, useState } from "react";

import { FlowLine } from "../../site/motion/FlowLine";
import { cssVars } from "../../site/motion/tokens";
import { Typewriter } from "../../site/motion/Typewriter";
import { useInView } from "../../site/motion/useInView";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { Section } from "../../site/ui/Section";
import { cx, INK_BORDER, SHADOW_HARD, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { ScrambleText } from "./ScrambleText";

interface StepCard {
  readonly verb: string;
  readonly body: string;
  readonly artifact: string;
  readonly icon: React.ReactNode;
  readonly accent: string;
  readonly ink: string;
}

const STEPS: readonly StepCard[] = [
  {
    verb: "Express",
    body: "Describe the outcome in natural language or submit structured actions. Accounts are CAIP-10 ids, one per virtual machine.",
    artifact: "IntentRequest",
    icon: <MessageSquareText className="h-6 w-6" aria-hidden="true" />,
    accent: "#FFD60A",
    ink: "#1A1A1A",
  },
  {
    verb: "Plan",
    body: "A deterministic compiler builds a DAG of network-bound steps, each bound to one account and one protocol, with live quotes and output floors.",
    artifact: "IntentGraph",
    icon: <Workflow className="h-6 w-6" aria-hidden="true" />,
    accent: "#0052FF",
    ink: "#FFFFFF",
  },
  {
    verb: "Sign",
    body: "Every value-moving step is signed in the user's own wallet: EVM through EIP-1193, Solana through Wallet Standard. Kletia never holds keys.",
    artifact: "eth_sendTransaction · solana:signAndSendTransaction",
    icon: <PenLine className="h-6 w-6" aria-hidden="true" />,
    accent: "#9945FF",
    ink: "#FFFFFF",
  },
  {
    verb: "Prove",
    body: "A step advances only on on-chain or settlement-network evidence observed from the bound account. Dependent steps unlock after settlement.",
    artifact: "StepEvidence",
    icon: <BadgeCheck className="h-6 w-6" aria-hidden="true" />,
    accent: "#14F195",
    ink: "#0B1120",
  },
];

/** Time between two cards becoming active; each rail segment fills in the last 600 ms of it. */
const STEP_MS = 900;
const SEGMENT_MS = 600;
const EXPRESS_PROMPT = "bridge 25 USDC from base to solana";
const EVIDENCE_HASH = "0x7f3a…c21e";

const ARTIFACT_BOX =
  "relative flex h-[72px] items-center overflow-hidden border-2 border-dashed border-[#1A1A1A]/30 bg-[#F4F1EA] px-3 dark:border-white/15 dark:bg-[#0B1120]";

function ExpressArtifact({ active, animate }: { active: boolean; animate: boolean }) {
  // The caret blinks only while typing; the finished state is still.
  const [typed, setTyped] = useState(false);
  return (
    <div className={cx(ARTIFACT_BOX, "font-code text-[12px] text-[#1A1A1A] dark:text-[#E2E8F0]")}>
      <span className="mr-1.5 font-bold text-[#0052FF] dark:text-[#7EA6FF]">&gt;</span>
      {active && animate ? (
        <Typewriter
          text={EXPRESS_PROMPT}
          speed={30}
          startDelay={150}
          onDone={() => setTyped(true)}
          caret={!typed}
          caretClassName="kl-caret kl-loop ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-[#0052FF] dark:bg-[#FFD60A]"
        />
      ) : (
        <span>{EXPRESS_PROMPT}</span>
      )}
    </div>
  );
}

const PLAN_EDGES = ["M22 36 C 46 36, 46 14, 70 14", "M22 36 C 46 36, 46 58, 70 58", "M94 14 C 112 14, 112 36, 128 36"];
const PLAN_NODES: readonly { x: number; y: number; color: string }[] = [
  { x: 10, y: 24, color: "#0052FF" },
  { x: 70, y: 2, color: "#9945FF" },
  { x: 70, y: 46, color: "#14F195" },
  { x: 128, y: 24, color: "#FFD60A" },
];

function PlanArtifact({ active, animate }: { active: boolean; animate: boolean }) {
  return (
    <div className={ARTIFACT_BOX}>
      <svg viewBox="0 0 156 72" className="h-[64px] w-auto" aria-hidden="true">
        {PLAN_EDGES.map((d, index) => (
          <FlowLine
            key={`${index}-${active && animate ? "draw" : "rest"}`}
            d={d}
            color={PLAN_NODES[index + 1]!.color}
            draw={active && animate}
            drawDelay={120 + index * 160}
            glow={active}
          />
        ))}
        {PLAN_NODES.map((node, index) => (
          <g key={index} transform={`translate(${node.x} ${node.y})`}>
            <rect x={2} y={2} width={22} height={22} className="fill-[#1A1A1A] dark:fill-[#475569]" />
            <rect
              x={0}
              y={0}
              width={22}
              height={22}
              strokeWidth={2.5}
              fill={active ? node.color : "transparent"}
              className="stroke-[#1A1A1A] transition-[fill] duration-240 dark:stroke-[#CBD5E1] motion-reduce:transition-none"
              style={{ transitionDelay: active && animate ? `${index * 140}ms` : undefined }}
            />
          </g>
        ))}
      </svg>
      <span className="ml-auto font-code text-[11px] font-bold text-[#45464B] dark:text-[#A9B6C8]">3 steps</span>
    </div>
  );
}

function SignArtifact({ active, animate }: { active: boolean; animate: boolean }) {
  return (
    <div className={ARTIFACT_BOX}>
      <span
        className={cx(
          "relative inline-flex items-center gap-2 border-[3px] border-[#1A1A1A] bg-white px-2.5 py-1.5 text-[12px] font-black uppercase tracking-[0.1em] text-[#1A1A1A] shadow-hard-sm dark:border-[#4B5563] dark:bg-[#131E32] dark:text-white",
          active && animate && "kl-attn-ring kl-attn-ring--once",
        )}
      >
        <PenLine className="h-4 w-4" aria-hidden="true" />
        Sign · Phantom
        {active ? (
          <span
            className={cx(
              "absolute inset-0 flex items-center justify-center gap-1.5 bg-[#14F195] text-[#0B1120]",
              animate && "kl-stamp",
            )}
            style={animate ? { animationDelay: "900ms" } : undefined}
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            Signed
          </span>
        ) : null}
      </span>
    </div>
  );
}

function ProveArtifact({ active, animate }: { active: boolean; animate: boolean }) {
  return (
    <div className={cx(ARTIFACT_BOX, "justify-between gap-2")}>
      <ScrambleText text={EVIDENCE_HASH} play={active && animate} className="font-code text-[12px] font-bold text-[#1A1A1A] dark:text-[#E2E8F0]" />
      {active ? (
        <span
          className={cx(
            "inline-flex items-center gap-1 border-2 border-[#1A1A1A] bg-[#14F195] px-1.5 py-0.5 font-code text-[10px] font-bold text-[#0B1120] dark:border-[#4B5563]",
            animate && "kl-stamp",
          )}
          style={animate ? { animationDelay: "450ms" } : undefined}
        >
          StepEvidence <Check className="h-3 w-3" aria-hidden="true" />
        </span>
      ) : (
        <span className="border-2 border-dashed border-[#1A1A1A]/30 px-1.5 py-0.5 font-code text-[10px] text-[#45464B] dark:border-white/20 dark:text-[#A9B6C8]">
          observing…
        </span>
      )}
    </div>
  );
}

const ARTIFACTS = [ExpressArtifact, PlanArtifact, SignArtifact, ProveArtifact];

/** Column centre on the 4-column grid (gap 1.5rem). */
function columnCenter(index: number): string {
  return `calc((100% - 4.5rem) / 4 * ${index + 0.5} + 1.5rem * ${index})`;
}

export function HowItWorks() {
  const reduced = useReducedMotion();
  // Starts once the top of the cards passes 65% of the viewport height (any card count, any screen).
  const [ref, inView] = useInView<HTMLOListElement>({ once: true, rootMargin: "0px 0px -35% 0px" });
  const [count, setCount] = useState(0);
  const activeCount = reduced ? STEPS.length : count;
  const animate = !reduced;

  useEffect(() => {
    if (reduced || !inView || count >= STEPS.length) return undefined;
    const timer = window.setTimeout(() => setCount((value) => Math.min(STEPS.length, value + 1)), count === 0 ? 200 : STEP_MS);
    return () => window.clearTimeout(timer);
  }, [reduced, inView, count]);

  return (
    <Section
      id="how-it-works"
      reveal
      eyebrow="How it works"
      title={
        <>
          From one sentence to <span className="bg-[#0052FF] px-2 text-white">verified</span> settlement.
        </>
      }
      intro="Intents are compiled, not guessed. No model sits in the execution path: the same request always produces the same graph for the same quotes."
    >
      {/* Desktop rail: four nodes over the four cards, filled step by step. */}
      <div aria-hidden="true" className="relative mb-8 hidden h-6 xl:block">
        <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 bg-[#1A1A1A]/15 dark:bg-white/15" />
        {STEPS.slice(0, -1).map((step, index) => (
          <span
            key={step.verb}
            className="absolute top-1/2 h-[3px] -translate-y-1/2 overflow-hidden"
            style={{ left: columnCenter(index), width: "calc((100% - 4.5rem) / 4 + 1.5rem)" }}
          >
            {activeCount > index ? (
              <span
                className={cx("absolute inset-0 bg-[#1A1A1A] dark:bg-[#CBD5E1]", animate && "kl-fill-x")}
                style={animate ? { ...cssVars({ "--kl-delay": `${STEP_MS - SEGMENT_MS}ms` }), animationDuration: `${SEGMENT_MS}ms` } : undefined}
              />
            ) : null}
          </span>
        ))}
        {STEPS.map((step, index) => {
          const on = activeCount > index;
          return (
            <span
              key={step.verb}
              className={cx(
                "absolute top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 border-[3px] border-[#1A1A1A] transition-colors duration-150 dark:border-[#CBD5E1]",
                on ? "" : "bg-[#F4F1EA] dark:bg-[#0B1120]",
              )}
              style={{ left: columnCenter(index), backgroundColor: on ? step.accent : undefined }}
            >
              {on && animate ? <span key="stamp" className="kl-stamp absolute inset-0" style={{ backgroundColor: step.accent }} /> : null}
            </span>
          );
        })}
      </div>

      <ol ref={ref} className="relative grid gap-6 pl-10 md:grid-cols-2 md:pl-0 xl:grid-cols-4">
        {/* Phone rail (left). */}
        <span aria-hidden="true" className="absolute bottom-6 left-[13px] top-6 w-[3px] bg-[#1A1A1A]/15 dark:bg-white/15 md:hidden" />
        <span
          aria-hidden="true"
          className="absolute bottom-6 left-[13px] top-6 w-[3px] origin-top bg-[#1A1A1A] transition-transform duration-700 ease-kl-out dark:bg-[#CBD5E1] motion-reduce:transition-none md:hidden"
          style={{ transform: `scaleY(${Math.max(0, activeCount - 1) / (STEPS.length - 1)})` }}
        />
        {STEPS.map((step, index) => {
          const active = activeCount > index;
          const Artifact = ARTIFACTS[index]!;
          return (
            <li key={step.verb} className={cx("relative flex flex-col", INK_BORDER, SHADOW_HARD, SURFACE)}>
              <span
                aria-hidden="true"
                className="absolute -left-[37px] top-5 h-6 w-6 border-[3px] border-[#1A1A1A] bg-[#F4F1EA] transition-colors duration-150 dark:border-[#CBD5E1] dark:bg-[#0B1120] md:hidden"
                style={active ? { backgroundColor: step.accent } : undefined}
              />
              <div
                className="relative flex items-center justify-between overflow-hidden border-b-[3px] border-[#1A1A1A] bg-[#EDE9DF] px-5 py-4 transition-colors delay-200 duration-150 dark:border-[#4B5563] dark:bg-[#1A2841] motion-reduce:transition-none motion-reduce:delay-0"
                style={{ color: active ? step.ink : undefined }}
              >
                {active ? (
                  <span
                    aria-hidden="true"
                    className={cx("absolute inset-0", animate && "kl-fill-x")}
                    style={{ backgroundColor: step.accent }}
                  />
                ) : null}
                <span
                  key={active ? "on" : "off"}
                  className={cx(
                    "relative font-display text-5xl font-bold leading-none tracking-[-0.06em]",
                    active && animate && "kl-stamp",
                  )}
                  style={active && animate ? { animationDelay: "200ms" } : undefined}
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="relative">{step.icon}</span>
              </div>
              <div className="flex flex-1 flex-col gap-3 p-5">
                <h3 className="font-display text-2xl font-bold tracking-[-0.02em]">{step.verb}</h3>
                <p className={cx("flex-1 text-[15px] leading-relaxed", TEXT_MUTED)}>{step.body}</p>
                <div aria-hidden="true">
                  <Artifact active={active} animate={animate} />
                </div>
                <p className="min-h-[2.25rem] break-words border-t-2 border-dashed border-[#1A1A1A]/20 pt-3 font-code text-[11px] text-[#0052FF] dark:border-white/10 dark:text-[#7EA6FF]">
                  → {step.artifact}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
