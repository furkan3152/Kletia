import { BadgeCheck, MessageSquareText, PenLine, Workflow } from "lucide-react";
import React from "react";

import { Section } from "../../site/ui/Section";
import { cx, HARD_SHADOW, INK_BORDER, SURFACE, TEXT_MUTED } from "../../site/ui/styles";

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

export function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      eyebrow="How it works"
      title={
        <>
          From one sentence to <span className="bg-[#0052FF] px-2 text-white">verified</span> settlement.
        </>
      }
      intro="Intents are compiled, not guessed. No model sits in the execution path: the same request always produces the same graph for the same quotes."
    >
      <ol className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        {STEPS.map((step, index) => (
          <li key={step.verb} className={cx("relative flex flex-col", INK_BORDER, HARD_SHADOW, SURFACE)}>
            <div
              className="flex items-center justify-between border-b-[3px] border-[#1A1A1A] px-5 py-4 dark:border-[#4B5563]"
              style={{ backgroundColor: step.accent, color: step.ink }}
            >
              <span className="font-display text-5xl font-bold leading-none tracking-[-0.06em]">
                {String(index + 1).padStart(2, "0")}
              </span>
              {step.icon}
            </div>
            <div className="flex flex-1 flex-col gap-3 p-5">
              <h3 className="font-display text-2xl font-bold tracking-[-0.02em]">{step.verb}</h3>
              <p className={cx("flex-1 text-[15px] leading-relaxed", TEXT_MUTED)}>{step.body}</p>
              <p className="min-h-[3.25rem] break-words border-t-2 border-dashed border-[#1A1A1A]/20 pt-3 font-code text-[11px] text-[#0052FF] dark:border-white/10 dark:text-[#7EA6FF]">
                → {step.artifact}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
