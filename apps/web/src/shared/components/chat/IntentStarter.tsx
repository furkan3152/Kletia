import { ArrowUpRight, Route, ShieldCheck } from "lucide-react";
import type { Address } from "viem";

import {
  ACTIVE_WALLET_ADDRESS,
  materializeIntentExample,
  requiresActiveWalletAddress,
} from "../../config/intentExamples";
import type { NetworkMode } from "../../config/networks";

interface IntentStarterProps {
  networkMode: NetworkMode;
  walletAddress?: Address;
  onSelect: (prompt: string) => void;
}

const STARTERS = {
  base: [
    {
      label: "Find the best route",
      detail: "Compare Base liquidity before preparing a swap.",
      prompt:
        "Swap 100 USDC to ETH on Base using the most efficient available route and show the expected output before execution",
    },
    {
      label: "Compare live yield",
      detail: "Rank eligible Base opportunities without moving funds.",
      prompt:
        "Compare best yield for USDC among Aave, Moonwell, and Compound on Base Mainnet without preparing a transaction",
    },
    {
      label: "Discover x402",
      detail: "Inspect a real Base payment challenge before approval.",
      prompt:
        "Find a Coinbase-curated wallet security x402 service on Base, cap one call at 0.01 USDC, and prepare its live payment challenge for wallet review; payment remains pending for my explicit wallet approval",
    },
  ],
  arc: [
    {
      label: "Map my Arc routes",
      detail: "Read balances and available money routes first.",
      prompt:
        "Show my Arc portfolio and explain which Arc money routes are available without sending a transaction",
    },
    {
      label: "Review positions",
      detail: "Read staking, vault and lending state onchain.",
      prompt:
        "Show my Arc staking, vault and lending positions using live onchain data",
    },
    {
      label: "Prepare atomic payment",
      detail: "Compose a fail-together Arc Testnet payment plan.",
      prompt:
        `Atomically pay 0.1 native USDC to ${ACTIVE_WALLET_ADDRESS} on Arc Testnet through the official Multicall3From route; fail the whole batch if any payment fails and simulate it before wallet approval`,
    },
  ],
  arbitrum: [
    {
      label: "Route an Arbitrum swap",
      detail: "Compare live Uniswap V3 fee tiers before approval.",
      prompt:
        "Swap 10 USDC to WETH on Arbitrum One through the best live Uniswap V3 fee tier and show the exact quote before approval",
    },
    {
      label: "Review Aave rates",
      detail: "Read the live reserve without moving funds.",
      prompt:
        "Show the live USDC supply and variable borrow rates from Aave V3 on Arbitrum without preparing a transaction",
    },
    {
      label: "Create a planning policy",
      detail: "Sign a bounded policy that cannot move funds.",
      prompt:
        "Create a planning-only policy agent named Arbitrum Yield Scout that may compare USDC opportunities on Arbitrum through Aave V3, may plan at most 25 USDC, uses balanced risk, and expires in 24 hours; it must never move funds without a separate wallet approval",
    },
  ],
} as const;

export function IntentStarter({
  networkMode,
  walletAddress,
  onSelect,
}: IntentStarterProps) {
  const isArc = networkMode === "arc";
  const isArbitrum = networkMode === "arbitrum";
  const items = STARTERS[networkMode];

  return (
    <section className="mx-auto flex w-full max-w-4xl items-start py-2 sm:py-6 md:min-h-full md:items-center md:py-10">
      <div className="w-full border-[3px] border-[#1A1A1A] bg-white p-3 text-[#1A1A1A] shadow-[5px_5px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:text-white dark:shadow-[5px_5px_0_#475569] sm:p-6 md:p-8">
        <div className="flex items-start gap-3 border-b-[3px] border-[#1A1A1A] pb-3 dark:border-[#4B5563] sm:pb-4">
          <div
            className={`flex h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] text-white shadow-[2px_2px_0_#1A1A1A] ${isArc ? "bg-[#8B5CF6]" : isArbitrum ? "bg-[#28A0F0]" : "bg-[#0052FF]"}`}
          >
            <Route className="h-5 w-5" strokeWidth={3} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-600 dark:text-slate-300">
              {isArc
                ? "Arc Testnet workspace"
                : isArbitrum
                  ? "Arbitrum One public beta"
                  : "Base Mainnet workspace"}
            </p>
            <h2 className="mt-1 text-lg font-black uppercase leading-tight tracking-tight sm:text-2xl">
              One instruction. A verified route.
            </h2>
            <p className="mt-1.5 max-w-2xl text-xs font-bold leading-4 text-gray-700 dark:text-slate-200 sm:mt-2 sm:text-sm sm:leading-5">
              Describe the outcome. Kletia resolves the network, assets, route
              evidence and approval boundary before execution.
            </p>
          </div>
        </div>

        <div className="mt-3 grid gap-2.5 sm:mt-4 sm:gap-3 md:grid-cols-3">
          {items.map((item, index) => {
            const prompt = materializeIntentExample(item.prompt, walletAddress);
            const needsWallet = requiresActiveWalletAddress(item.prompt);
            return (
              <button
                key={item.label}
                type="button"
                onClick={() => onSelect(prompt)}
                title={
                  needsWallet && !walletAddress
                    ? "Opens an editable example. Replace the recipient before sending, or connect a wallet to insert its address."
                    : undefined
                }
                className="group flex min-h-[72px] items-start gap-2.5 border-[3px] border-[#1A1A1A] bg-[#F8FAFC] p-2.5 text-left shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 ease-out hover:-translate-y-0.5 hover:bg-[#EAF0FF] hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:bg-[#1A2841] dark:shadow-[3px_3px_0_#475569] dark:hover:bg-[#233554] sm:min-h-24 sm:gap-3 sm:p-3"
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center border-[2px] border-[#1A1A1A] font-mono text-xs font-black text-white sm:h-10 sm:w-10 sm:text-sm ${isArc ? "bg-[#8B5CF6]" : isArbitrum ? "bg-[#28A0F0]" : "bg-[#0052FF]"}`}
                >
                  0{index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2 text-[13px] font-black uppercase sm:text-sm">
                    {item.label}
                    <ArrowUpRight
                      className="h-4 w-4 shrink-0 transition-transform duration-100 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="mt-0.5 block text-[11px] font-bold leading-4 text-gray-600 dark:text-slate-300 sm:mt-1 sm:text-xs">
                    {item.detail}
                  </span>
                  {needsWallet && !walletAddress ? (
                    <span className="mt-1.5 inline-block border-2 border-[#1A1A1A] bg-[#FFF36D] px-1.5 py-0.5 text-[9px] font-black uppercase text-[#1A1A1A]">
                      Editable recipient
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex items-start gap-2 border-[2px] border-[#1A1A1A] bg-[#FFF36D] p-2.5 text-[11px] font-bold leading-4 text-[#1A1A1A] sm:mt-4 sm:p-3 sm:text-xs">
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          Templates only fill the composer. Nothing executes until the route is
          reviewed and approved in your wallet.
        </div>
      </div>
    </section>
  );
}
