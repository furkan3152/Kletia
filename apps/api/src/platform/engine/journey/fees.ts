/**
 * Network fee estimates, shared by the planner's gas reserve, the
 * preview's quoted steps, the journey and clarify's "All" option. Every
 * figure is an upper bound labelled `estimated`: an estimate that is too
 * high asks for a few cents too much gas, one that is too low leaves the
 * user stuck.
 *
 * - EVM: Σ gas of the step's expected transactions × `eth_gasPrice`. Gas is
 *   the quote's own hint × 1.5 when present, else the adapters' own gas
 *   limits (they already carry headroom, used as they are), else a typical
 *   value × 1.5. OP-stack networks × 1.2 and Arbitrum + 1,000 gas per
 *   transaction for the L1 data part.
 * - Solana: 5,000 lamports per signature + the adapter's priority estimate +
 *   rent for every token account the step creates that does not exist yet
 *   (unknown counts as missing) + the wallet's rent-exempt minimum when its
 *   balance is 0 (a fee payer may not be left between 0 and that minimum).
 *
 * Pure functions over facts; the facts come from `holdings.readFacts`.
 */
import { CHAINS, fromBaseUnits, type IntentActionKind, type IntentStep, type NetworkKey, type ProtocolId } from "@kletia/core";
import { readFacts, type WalletFacts } from "../holdings.js";

/** One kind of EVM transaction a step sends. */
export type EvmFeeOperation =
  | "approve"
  | "wrap"
  | "native-transfer"
  | "erc20-transfer"
  | "aave-supply"
  | "aave-withdraw"
  | "comet"
  | "erc4626-deposit"
  | "erc4626-withdraw"
  | "moonwell-mint"
  | "moonwell-router"
  | "relay-deposit"
  | "lifi"
  | "dln-create"
  | "bridge-deposit"
  | "dex-swap"
  | "stake";

/**
 * Gas per operation. `limit`: an adapter's own gas limit (already has
 * headroom; used as is). `typical`: a typical value, multiplied by 1.5.
 */
export const EVM_GAS: Readonly<Record<EvmFeeOperation, { readonly gas: bigint; readonly source: "limit" | "typical" }>> = Object.freeze({
  approve: { gas: 60_000n, source: "limit" },
  wrap: { gas: 60_000n, source: "limit" },
  "aave-supply": { gas: 260_000n, source: "limit" },
  "aave-withdraw": { gas: 300_000n, source: "limit" },
  comet: { gas: 160_000n, source: "limit" },
  "erc4626-deposit": { gas: 700_000n, source: "limit" },
  "erc4626-withdraw": { gas: 900_000n, source: "limit" },
  "moonwell-mint": { gas: 350_000n, source: "limit" },
  "moonwell-router": { gas: 450_000n, source: "limit" },
  "native-transfer": { gas: 21_000n, source: "typical" },
  "erc20-transfer": { gas: 65_000n, source: "typical" },
  "relay-deposit": { gas: 80_000n, source: "typical" },
  lifi: { gas: 250_000n, source: "typical" },
  "dln-create": { gas: 300_000n, source: "typical" },
  // Not in the journey table: an approve plus a deposit of the other bridges and a single-pool swap or stake.
  "bridge-deposit": { gas: 150_000n, source: "typical" },
  "dex-swap": { gas: 200_000n, source: "typical" },
  stake: { gas: 150_000n, source: "typical" },
});

/** Headroom on typical values and on gas hints from a quote: × 3 / 2. */
const HEADROOM_NUM = 3n;
const HEADROOM_DEN = 2n;
/** OP-stack networks (L1 data fee): × 6 / 5. */
const OP_STACK: ReadonlySet<NetworkKey> = new Set(["base", "optimism"]);
/** Arbitrum (L1 data part): + 1,000 gas per transaction. */
const ARBITRUM_L1_GAS = 1_000n;
const ARBITRUM: ReadonlySet<NetworkKey> = new Set(["arbitrum", "arbitrum-sepolia"]);

export const SOLANA_SIGNATURE_LAMPORTS = 5_000n;
/** Jupiter's priority-fee estimate (adapters/jupiter.ts). */
export const SOLANA_PRIORITY_LAMPORTS = 100_000n;
/** Rent fallbacks when the live values cannot be read (historic, higher than today's values: upper bounds). */
export const SOLANA_WALLET_RENT_FALLBACK = 890_880n;
export const SOLANA_TOKEN_ACCOUNT_RENT_FALLBACK = 2_039_280n;

export interface EvmFeeInput {
  readonly network: NetworkKey;
  /** Wei per gas (`eth_gasPrice`); null when unknown. */
  readonly gasPriceWei: bigint | null;
  /** Transactions the step sends, by kind (ignored when `quotedGas` is given). */
  readonly operations?: readonly EvmFeeOperation[];
  /** Gas of each transaction as the plan-time quote states it (Relay calls carry `gas`). */
  readonly quotedGas?: readonly bigint[];
}

export interface FeeEstimate {
  readonly network: NetworkKey;
  readonly vm: "evm" | "svm";
  readonly certainty: "estimated";
  /** Gas units (EVM) or lamports' worth of signatures and priority (Solana). */
  readonly units: string;
  /** The fee in the network's gas asset, base units; null when the gas price is unknown. */
  readonly amount: string | null;
  readonly formatted: string | null;
  readonly symbol: string;
  readonly decimals: number;
  /** Plain-English breakdown ("2 transactions, 320,000 gas incl. headroom"). */
  readonly detail: string;
}

function withHeadroom(gas: bigint): bigint {
  return (gas * HEADROOM_NUM + HEADROOM_DEN - 1n) / HEADROOM_DEN;
}

/** Gas units of the step's transactions, L2 parts included. */
export function evmGasUnits(network: NetworkKey, input: Pick<EvmFeeInput, "operations" | "quotedGas">): { gas: bigint; transactions: number } {
  const quoted = input.quotedGas?.filter((gas) => gas > 0n) ?? [];
  const perTransaction = quoted.length > 0
    ? quoted.map(withHeadroom)
    : (input.operations ?? []).map((operation) => {
        const entry = EVM_GAS[operation];
        return entry.source === "limit" ? entry.gas : withHeadroom(entry.gas);
      });
  let gas = perTransaction.reduce((total, value) => total + value, 0n);
  if (ARBITRUM.has(network)) gas += ARBITRUM_L1_GAS * BigInt(perTransaction.length);
  if (OP_STACK.has(network)) gas = (gas * 6n + 4n) / 5n;
  return { gas, transactions: perTransaction.length };
}

export function estimateEvmFee(input: EvmFeeInput): FeeEstimate {
  const chain = CHAINS[input.network];
  const { gas, transactions } = evmGasUnits(input.network, input);
  const amount = input.gasPriceWei === null ? null : gas * input.gasPriceWei;
  return {
    network: input.network,
    vm: "evm",
    certainty: "estimated",
    units: gas.toString(),
    amount: amount === null ? null : amount.toString(),
    formatted: amount === null ? null : fromBaseUnits(amount, chain.nativeAsset.decimals),
    symbol: chain.nativeAsset.symbol,
    decimals: chain.nativeAsset.decimals,
    detail: `${transactions} transaction(s), ${gas.toString()} gas incl. headroom${amount === null ? "; gas price unknown" : ""}`,
  };
}

export interface SolanaFeeInput {
  readonly network: NetworkKey;
  readonly signatures?: number;
  /** Priority fee in lamports (default: none; Jupiter routes use SOLANA_PRIORITY_LAMPORTS). */
  readonly priorityLamports?: bigint;
  /** Token accounts the step would create for the user: `true` exists, `false` missing, `null` unknown (counted as missing). */
  readonly tokenAccounts?: readonly (boolean | null)[];
  /** Rent-exempt minimum of a token account (null: unknown, the fallback is used). */
  readonly tokenAccountRentLamports?: bigint | null;
  /** Rent-exempt minimum of an empty account (null: unknown, the fallback is used). */
  readonly walletRentLamports?: bigint | null;
  /** The fee payer's lamports (null: unknown, not charged; 0: the wallet minimum is added). */
  readonly walletLamports?: bigint | null;
}

export function estimateSolanaFee(input: SolanaFeeInput): FeeEstimate {
  const signatures = BigInt(Math.max(1, Math.floor(input.signatures ?? 1)));
  const priority = input.priorityLamports ?? 0n;
  const missing = (input.tokenAccounts ?? []).filter((exists) => exists !== true).length;
  const tokenRent = input.tokenAccountRentLamports ?? SOLANA_TOKEN_ACCOUNT_RENT_FALLBACK;
  const walletRent = input.walletLamports === 0n ? input.walletRentLamports ?? SOLANA_WALLET_RENT_FALLBACK : 0n;
  const base = signatures * SOLANA_SIGNATURE_LAMPORTS + priority;
  const amount = base + BigInt(missing) * tokenRent + walletRent;
  const parts = [
    `${signatures.toString()} signature(s)`,
    ...(priority > 0n ? [`priority ${priority.toString()} lamports`] : []),
    ...(missing > 0 ? [`rent for ${missing} new token account(s)`] : []),
    ...(walletRent > 0n ? ["the wallet's rent-exempt minimum"] : []),
  ];
  return {
    network: input.network,
    vm: "svm",
    certainty: "estimated",
    units: base.toString(),
    amount: amount.toString(),
    formatted: fromBaseUnits(amount, 9),
    symbol: CHAINS[input.network].nativeAsset.symbol,
    decimals: 9,
    detail: parts.join(", "),
  };
}

const ERC4626_FAMILY: ReadonlySet<ProtocolId> = new Set(["morpho", "spark-savings", "fluid", "yearn-v3"]);
const AAVE_FAMILY: ReadonlySet<ProtocolId> = new Set(["aave-v3", "sparklend"]);

/** The EVM transactions a step of `kind` under `protocol` sends (approvals included when the input is a token). */
export function evmOperationsFor(kind: IntentActionKind, protocol: ProtocolId, options: { readonly nativeInput?: boolean } = {}): EvmFeeOperation[] {
  const native = options.nativeInput === true;
  const approve: EvmFeeOperation[] = native ? [] : ["approve"];
  switch (kind) {
    case "transfer":
      return [native ? "native-transfer" : "erc20-transfer"];
    case "bridge":
      if (protocol === "relay") return [...approve, "relay-deposit"];
      if (protocol === "lifi") return [...approve, "lifi"];
      if (protocol === "debridge-dln") return [...approve, "dln-create"];
      return [...approve, "bridge-deposit"];
    case "swap":
      return protocol === "relay" ? [...approve, "relay-deposit"] : [...approve, "dex-swap"];
    case "stake":
      return ["stake"];
    case "deposit":
      if (AAVE_FAMILY.has(protocol)) return [...(native ? ["wrap" as const] : []), "approve", "aave-supply"];
      if (protocol === "compound-v3") return [...(native ? ["wrap" as const] : []), "approve", "comet"];
      if (protocol === "moonwell") return native ? ["moonwell-router"] : ["approve", "moonwell-mint"];
      if (ERC4626_FAMILY.has(protocol)) return [...(native ? ["wrap" as const] : []), "approve", "erc4626-deposit"];
      return ["approve", "erc4626-deposit"];
    case "withdraw":
      if (AAVE_FAMILY.has(protocol)) return ["aave-withdraw"];
      if (protocol === "compound-v3") return ["comet"];
      if (protocol === "moonwell") return ["moonwell-mint"];
      return ["erc4626-withdraw"];
    default:
      // call / action steps: the integrator's entry; an approve plus the vault-sized limit.
      return [...approve, "erc4626-deposit"];
  }
}

export interface StepFeeFacts {
  readonly gasPriceWei?: bigint | null;
  readonly tokenAccountRentLamports?: bigint | null;
  readonly walletRentLamports?: bigint | null;
  readonly walletLamports?: bigint | null;
  /** Existence of the token accounts the step creates for the user (Solana). */
  readonly tokenAccounts?: readonly (boolean | null)[];
  /** Gas hints of the plan-time quote (EVM). */
  readonly quotedGas?: readonly bigint[];
}

/** Estimated network fee of one planned step on its own network. */
export function estimateStepFee(
  step: Pick<IntentStep, "kind" | "network" | "protocol"> & { readonly input?: { readonly asset: string } },
  facts: StepFeeFacts = {},
): FeeEstimate {
  const chain = CHAINS[step.network];
  if (chain.vm === "svm") {
    const priority = step.kind === "transfer" ? 0n : SOLANA_PRIORITY_LAMPORTS;
    return estimateSolanaFee({
      network: step.network,
      signatures: 1,
      priorityLamports: priority,
      ...(facts.tokenAccounts ? { tokenAccounts: facts.tokenAccounts } : {}),
      ...(facts.tokenAccountRentLamports !== undefined ? { tokenAccountRentLamports: facts.tokenAccountRentLamports } : {}),
      ...(facts.walletRentLamports !== undefined ? { walletRentLamports: facts.walletRentLamports } : {}),
      ...(facts.walletLamports !== undefined ? { walletLamports: facts.walletLamports } : {}),
    });
  }
  const nativeInput = step.input !== undefined && /\/slip44:\d+$/u.test(step.input.asset);
  return estimateEvmFee({
    network: step.network,
    gasPriceWei: facts.gasPriceWei ?? null,
    operations: evmOperationsFor(step.kind, step.protocol, { nativeInput }),
    ...(facts.quotedGas ? { quotedGas: facts.quotedGas } : {}),
  });
}

/** The live facts fee estimates need for `networks` (gas prices, Solana rent), read through holdings. */
export async function readFeeFacts(networks: readonly NetworkKey[], options: { readonly deadlineMs?: number } = {}): Promise<WalletFacts> {
  const unique = [...new Set(networks)];
  return readFacts([], unique.map((network) => CHAINS[network].vm === "evm"
    ? { kind: "gasPrice" as const, network }
    : { kind: "solanaRent" as const, network }), options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {});
}

/** The gas price of `network` in `facts`, or null when unknown. */
export function gasPriceFrom(facts: Pick<WalletFacts, "gasPrices">, network: NetworkKey): bigint | null {
  const fact = facts.gasPrices.find((entry) => entry.network === network);
  return fact?.status === "known" && fact.weiPerGas !== undefined ? BigInt(fact.weiPerGas) : null;
}

/** Solana rent figures of `network` in `facts` (nulls when unknown). */
export function rentFrom(facts: Pick<WalletFacts, "rent">, network: NetworkKey): { wallet: bigint | null; tokenAccount: bigint | null } {
  const fact = facts.rent.find((entry) => entry.network === network);
  if (fact?.status !== "known") return { wallet: null, tokenAccount: null };
  return {
    wallet: fact.walletLamports !== undefined ? BigInt(fact.walletLamports) : null,
    tokenAccount: fact.tokenAccountLamports !== undefined ? BigInt(fact.tokenAccountLamports) : null,
  };
}
