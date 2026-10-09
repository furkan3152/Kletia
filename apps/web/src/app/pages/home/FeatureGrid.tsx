import {
  BadgeCheck,
  Braces,
  Code,
  GitFork,
  KeyRound,
  Network,
  ShieldCheck,
  Webhook,
} from "lucide-react";
import React from "react";

import { Reveal } from "../../site/motion/Reveal";
import { Section } from "../../site/ui/Section";
import { cx, INK_BORDER, LIFT, SHADOW_HARD, SURFACE, TEXT_MUTED } from "../../site/ui/styles";

interface Feature {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly icon: React.ReactNode;
  readonly color: string;
  /** Tile classes when the brand colour would vanish on a dark card. */
  readonly tileClassName?: string;
}

const FEATURES: readonly Feature[] = [
  {
    title: "Chain-agnostic spec",
    body: "Networks, accounts and assets cross every boundary as CAIP-2, CAIP-10 and CAIP-19 ids. Symbols never resolve across networks by name.",
    tag: "@kletia/core",
    icon: <Braces className="h-6 w-6" aria-hidden="true" />,
    color: "#0052FF",
  },
  {
    title: "Non-custodial",
    body: "The API returns unsigned transactions. The user's wallet signs every value-moving step; Kletia never holds keys or funds.",
    tag: "unsigned payloads",
    icon: <KeyRound className="h-6 w-6" aria-hidden="true" />,
    color: "#FFD60A",
  },
  {
    title: "Evidence-verified settlement",
    body: "A submitted hash or signature only moves a step after it is observed on-chain from the bound account; cross-network steps wait for the settlement network.",
    tag: "StepEvidence",
    icon: <BadgeCheck className="h-6 w-6" aria-hidden="true" />,
    color: "#14F195",
  },
  {
    title: "Intent graph DAG",
    body: "Steps form a dependency graph with funds and ordering edges. The planner merges steps when one venue can do both, such as bridge-and-swap through Relay.",
    tag: "route optimisation",
    icon: <Network className="h-6 w-6" aria-hidden="true" />,
    color: "#9945FF",
  },
  {
    title: "SSE + signed webhooks",
    body: "Stream intent events over Server-Sent Events or receive HMAC-SHA256 signed webhooks with timestamp tolerance and retries.",
    tag: "Kletia-Signature",
    icon: <Webhook className="h-6 w-6" aria-hidden="true" />,
    color: "#28A0F0",
  },
  {
    title: "Deterministic compiler",
    body: "Natural language is compiled by a grammar, not a model. Unsupported wording returns 422 with examples instead of a guess.",
    tag: "no model in the execution path",
    icon: <Code className="h-6 w-6" aria-hidden="true" />,
    color: "#FF5A5F",
  },
  {
    title: "Fail-closed safety",
    body: "Solana transactions are simulated before they are returned, Base swaps run through an identity-pinned router, and mainnet and testnet capital never mix.",
    tag: "simulation · pinning · lanes",
    icon: <ShieldCheck className="h-6 w-6" aria-hidden="true" />,
    color: "#7C3AED",
  },
  {
    title: "Open source",
    body: "The engine, the spec, the SDK and this site are MIT licensed. Read the code that plans your users' transactions.",
    tag: "MIT",
    icon: <GitFork className="h-6 w-6" aria-hidden="true" />,
    color: "#1A1A1A",
    tileClassName: "dark:!bg-white dark:!text-[#0B1120]",
  },
];

const DARK_ICON = new Set(["#FFD60A", "#14F195", "#28A0F0"]);

export function FeatureGrid() {
  return (
    <Section
      id="infrastructure"
      reveal
      eyebrow="Infrastructure"
      title="Built like infrastructure, not a demo."
      intro="Everything Kletia does is described by a public spec, enforced by the API, and verifiable on-chain."
    >
      <Reveal as="ul" stagger className="grid gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        {FEATURES.map((feature) => (
          <li
            key={feature.title}
            data-reveal-item
            className={cx(
              "group grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 p-4 sm:flex sm:flex-col sm:p-5",
              INK_BORDER,
              SHADOW_HARD,
              SURFACE,
              LIFT,
            )}
          >
            <span
              className={cx(
                "row-span-3 flex h-11 w-11 items-center justify-center border-[3px] border-[#1A1A1A] shadow-hard-sm transition-transform duration-240 ease-kl-snap group-hover:-translate-y-0.5 group-hover:-rotate-6 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 motion-reduce:group-hover:rotate-0 dark:border-[#4B5563] sm:h-12 sm:w-12",
                feature.tileClassName,
              )}
              style={{ backgroundColor: feature.color, color: DARK_ICON.has(feature.color) ? "#1A1A1A" : "#FFFFFF" }}
            >
              {feature.icon}
            </span>
            <h3 className="font-display text-lg font-bold leading-tight tracking-[-0.01em] sm:mt-5 sm:text-xl">{feature.title}</h3>
            <p className={cx("mt-1.5 text-sm leading-relaxed sm:mt-2 sm:flex-1", TEXT_MUTED)}>{feature.body}</p>
            <p className="mt-2 font-code text-[11px] text-[#0052FF] dark:text-[#7EA6FF] sm:mt-4">{feature.tag}</p>
          </li>
        ))}
      </Reveal>
    </Section>
  );
}
