import { ArrowRight, Bot, Gamepad2, Landmark, Wallet, WalletCards } from "lucide-react";
import React, { useState } from "react";

import { Link } from "../../routes/Link";
import { Reveal } from "../../site/motion/Reveal";
import { Typewriter } from "../../site/motion/Typewriter";
import { prefersReducedMotion } from "../../site/motion/useReducedMotion";
import { useSpotlight } from "../../site/motion/useSpotlight";
import { Section } from "../../site/ui/Section";
import { cx, FOCUS_RING, INK_BORDER, LIFT, SHADOW_HARD, SPOTLIGHT, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { studioHref } from "../protocols/protocolExamples";

interface UseCase {
  readonly title: string;
  readonly body: string;
  readonly example: string;
  readonly icon: React.ReactNode;
  readonly accent: string;
}

const USE_CASES: readonly UseCase[] = [
  {
    title: "Wallets",
    body: "Offer swaps, bridges and staking across EVM and Solana without integrating every venue yourself.",
    example: "move 0.01 ETH from arbitrum to solana as SOL",
    icon: <Wallet className="h-6 w-6" aria-hidden="true" />,
    accent: "#0052FF",
  },
  {
    title: "Payment & neobank apps",
    body: "Accept USDC on one network and settle it where your treasury lives, with signed webhooks for reconciliation.",
    example: "bridge 25 USDC from base to solana",
    icon: <WalletCards className="h-6 w-6" aria-hidden="true" />,
    accent: "#FFD60A",
  },
  {
    title: "AI agents",
    body: "Let agents propose deterministic, reviewable plans that a human-controlled wallet signs, and pay per call with x402.",
    example: "swap 1 SOL to USDC",
    icon: <Bot className="h-6 w-6" aria-hidden="true" />,
    accent: "#9945FF",
  },
  {
    title: "Treasuries & DAOs",
    body: "Rebalance stablecoins between networks and deposit idle USDC into lending markets with evidence for every step.",
    example: "bridge 20 USDC from solana to base and deposit it into aave",
    icon: <Landmark className="h-6 w-6" aria-hidden="true" />,
    accent: "#14F195",
  },
  {
    title: "Games",
    body: "Top up in-game balances from whatever network a player holds funds on, without leaving the game.",
    example: "bridge 50 USDC from base to solana then swap half to JitoSOL",
    icon: <Gamepad2 className="h-6 w-6" aria-hidden="true" />,
    accent: "#FF5A5F",
  },
];

const DARK_ICON = new Set(["#FFD60A", "#14F195"]);

function UseCaseCard({ useCase, wide }: { readonly useCase: UseCase; readonly wide: boolean }) {
  const { ref, handlers, style } = useSpotlight<HTMLLIElement>({ tilt: 3, color: useCase.accent });
  // Each hover or focus re-types the example prompt (never with reduced motion).
  const [replay, setReplay] = useState(0);
  const retype = () => {
    if (!prefersReducedMotion()) setReplay((value) => value + 1);
  };

  return (
    <li
      ref={ref}
      {...handlers}
      onPointerEnter={(event) => {
        handlers.onPointerEnter(event);
        if (event.pointerType === "mouse") retype();
      }}
      onFocus={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) retype();
      }}
      data-reveal-item
      style={style}
      className={cx("group relative flex flex-col p-6", INK_BORDER, SHADOW_HARD, SURFACE, LIFT, SPOTLIGHT, wide ? "lg:col-span-3" : "lg:col-span-2")}
    >
      <div className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] shadow-hard-sm transition-transform duration-240 ease-kl-snap group-hover:-rotate-6 motion-reduce:transition-none motion-reduce:group-hover:rotate-0 dark:border-[#4B5563]"
          style={{ backgroundColor: useCase.accent, color: DARK_ICON.has(useCase.accent) ? "#1A1A1A" : "#FFFFFF" }}
        >
          {useCase.icon}
        </span>
        <h3 className="font-display text-xl font-bold tracking-[-0.01em]">{useCase.title}</h3>
      </div>
      <p className={cx("mt-4 flex-1 text-[15px] leading-relaxed", TEXT_MUTED)}>{useCase.body}</p>
      <p className="mt-5 min-h-[2.75rem] border-2 border-dashed border-[#1A1A1A]/40 bg-[#F4F1EA] px-3 py-2 font-code text-xs leading-relaxed text-[#1A1A1A] [overflow-wrap:anywhere] dark:border-white/20 dark:bg-[#0B1120] dark:text-[#E2E8F0]">
        <span className="text-[#0052FF] dark:text-[#7EA6FF]" aria-hidden="true">
          &gt;{" "}
        </span>
        {replay > 0 ? <Typewriter key={replay} text={useCase.example} speed={18} /> : useCase.example}
      </p>
      <Link
        to={studioHref(useCase.example)}
        className={cx(
          "group/try mt-4 inline-flex min-h-9 items-center gap-1.5 self-start text-xs font-black uppercase tracking-[0.12em] text-[#0052FF] underline decoration-2 underline-offset-4 dark:text-[#7EA6FF]",
          FOCUS_RING,
        )}
      >
        Try in Studio
        <ArrowRight
          className="h-3.5 w-3.5 transition-transform duration-150 group-hover/try:translate-x-1 group-hover:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0 motion-reduce:group-hover/try:translate-x-0"
          aria-hidden="true"
        />
        <span className="sr-only">: {useCase.example}</span>
      </Link>
    </li>
  );
}

export function UseCases() {
  return (
    <Section
      id="use-cases"
      reveal
      eyebrow="Use cases"
      title="Wherever money needs to move, intents fit."
      intro="Each example below is a real prompt the v1 grammar accepts. Open any of them in Intent Studio to see the plan."
    >
      <Reveal as="ul" stagger className="grid gap-5 md:grid-cols-2 lg:grid-cols-6">
        {USE_CASES.map((useCase, index) => (
          <UseCaseCard key={useCase.title} useCase={useCase} wide={index < 2} />
        ))}
      </Reveal>
    </Section>
  );
}
