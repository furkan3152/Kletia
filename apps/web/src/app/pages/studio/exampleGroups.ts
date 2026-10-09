/**
 * Intent Studio example prompts, grouped by what they show. Every prompt is
 * phrased in the deterministic grammar and was planned with the preview
 * accounts against a local API (`POST /v1/intents?dryRun=true`). Solana
 * swaps, stakes and the bridge-then-swap depend on Jupiter quotes. Moonwell's
 * USDC market on Base was fully borrowed when this list was checked (422
 * VENUE_ILLIQUID), so the Moonwell example uses OP Mainnet.
 */
export type StudioExampleGroupId = "lend" | "bridge" | "pay" | "swap";

export interface StudioExampleGroup {
  readonly id: StudioExampleGroupId;
  /** Short tab label (four tabs share one row at 390 px). */
  readonly label: string;
  /** One line under the chips: which venues and rules the group exercises. */
  readonly note: string;
  readonly examples: readonly string[];
}

export const STUDIO_EXAMPLE_GROUPS: readonly StudioExampleGroup[] = [
  {
    id: "lend",
    label: "Lend",
    note: "Aave, Compound, Morpho and Moonwell on EVM networks; Jupiter Lend and Kamino on Solana. “withdraw all” closes the whole position.",
    examples: [
      "deposit 100 USDC into morpho on base",
      "deposit 100 USDC into compound on optimism",
      "deposit 100 USDC into moonwell on optimism",
      "withdraw all USDC from aave on base",
      "deposit 10 USDC into jupiter lend",
    ],
  },
  {
    id: "bridge",
    label: "Bridge",
    note: "Relay, LI.FI and deBridge quote every bridge and the best guaranteed output wins. Add “via lifi” to pick the venue yourself.",
    examples: [
      "bridge 100 USDC from ethereum to base",
      "bridge 25 USDC from base to arbitrum via lifi",
      "bridge 50 USDC from base to solana then swap half to JitoSOL",
      "bridge 20 USDC from solana to base and deposit it into aave",
    ],
  },
  {
    id: "pay",
    label: "Pay",
    note: "Pay an ENS name or a Basename. Kletia resolves it on-chain, shows the address in the plan and checks it again before you sign.",
    examples: ["send 5 USDC to jesse.base.eth on base", "send 5 USDC to vitalik.eth on optimism"],
  },
  {
    id: "swap",
    label: "Swap",
    note: "Jupiter routes on Solana and Relay on Base and Arbitrum, plus liquid staking into JitoSOL, mSOL or JupSOL.",
    examples: [
      "swap 1 SOL to USDC",
      "swap 0.01 ETH for USDC on base",
      "stake 1.5 SOL with marinade",
      "move 0.01 ETH from arbitrum to solana as SOL",
    ],
  },
];

export const STUDIO_EXAMPLES: readonly string[] = STUDIO_EXAMPLE_GROUPS.flatMap((group) => group.examples);

/** Prompt in the composer before the user types (a two-network, two-step plan). */
export const STUDIO_DEFAULT_PROMPT = "bridge 50 USDC from base to solana then swap half to JitoSOL";

/** First example of each group: a short, varied list for the "try a supported phrasing" fallback. */
export const STUDIO_FALLBACK_EXAMPLES: readonly string[] = STUDIO_EXAMPLE_GROUPS.map((group) => group.examples[0]!);

export function exampleGroupOf(text: string): StudioExampleGroupId | null {
  return STUDIO_EXAMPLE_GROUPS.find((group) => group.examples.includes(text))?.id ?? null;
}
