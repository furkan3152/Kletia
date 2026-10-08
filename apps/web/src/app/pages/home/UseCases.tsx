import { Bot, Gamepad2, Landmark, Wallet, WalletCards } from "lucide-react";
import React from "react";

import { Section } from "../../site/ui/Section";
import { cx, HARD_SHADOW, INK_BORDER, SURFACE, TEXT_MUTED } from "../../site/ui/styles";

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

export function UseCases() {
  return (
    <Section
      id="use-cases"
      eyebrow="Use cases"
      title="Wherever money needs to move, intents fit."
      intro="Each example below is a real prompt the v1 grammar accepts."
    >
      <ul className="grid gap-5 md:grid-cols-2 lg:grid-cols-6">
        {USE_CASES.map((useCase, index) => (
          <li
            key={useCase.title}
            className={cx(
              "flex flex-col p-6",
              INK_BORDER,
              HARD_SHADOW,
              SURFACE,
              index < 2 ? "lg:col-span-3" : "lg:col-span-2",
            )}
          >
            <div className="flex items-center gap-3">
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] dark:border-[#4B5563]"
                style={{ backgroundColor: useCase.accent, color: ["#FFD60A", "#14F195"].includes(useCase.accent) ? "#1A1A1A" : "#FFFFFF" }}
              >
                {useCase.icon}
              </span>
              <h3 className="font-display text-xl font-bold tracking-[-0.01em]">{useCase.title}</h3>
            </div>
            <p className={cx("mt-4 flex-1 text-[15px] leading-relaxed", TEXT_MUTED)}>{useCase.body}</p>
            <p className="mt-5 border-2 border-dashed border-[#1A1A1A]/40 bg-[#F4F1EA] px-3 py-2 font-code text-xs text-[#1A1A1A] dark:border-white/20 dark:bg-[#0B1120] dark:text-[#E2E8F0]">
              <span className="text-[#0052FF] dark:text-[#7EA6FF]">&gt;</span> {useCase.example}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
