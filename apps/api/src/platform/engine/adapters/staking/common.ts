/**
 * EVM liquid staking skeleton: native ETH in, one liquid-staking token
 * out, on Ethereum, in one wallet transaction.
 *
 * Each protocol (lido.ts, rocketPool.ts, etherfi.ts, stader.ts, mantle.ts,
 * frax.ts) supplies a `StakingVenue`: the token it mints, its pinned
 * contracts, a quote (provenance, pause and limit reads, the expected
 * output) and an outcome proof from receipt logs. The skeleton enforces the
 * shared rules:
 *
 * - only native ETH on Ethereum stakes, into the protocol's pinned token, for
 *   the acting account itself (the token is minted to the sender);
 * - the guaranteed output is the expected amount less STAKE_TOLERANCE_BPS;
 *   verification holds the minted amount to it and reports what arrived as
 *   the step's actual output. Most protocols take no on-chain minimum
 *   (`floor: "claimed"`); a venue whose call encodes exactly that minimum
 *   (Mantle's `stake(minMETHAmount)`) returns it as `onchainMinimum` and the
 *   step is `floor: "onchain"`;
 * - prepare re-reads everything, checks the balance and dry-runs the exact
 *   transaction from the account (a revert refuses the payload);
 * - every step warns that Kletia does not unstake and names the way out
 *   (a swap back to ETH).
 *
 * Wallet LST balances are reported as journey positions by `readStakingPositions`.
 */
import { erc20Abi, getAddress, parseAbi, type Address, type Hex } from "viem";
import {
  CHAINS,
  findAssetBySymbol,
  formatAmount,
  formatAssetId,
  fromBaseUnits,
  nativeAssetId,
  venueContracts,
  type IntentStep,
  type ParsedAccountId,
  type ProtocolId,
  type VenueContractRole,
  type VenuePosition,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { UNPRICED_SYMBOLS } from "../../policy/feeds.js";
import { assetAmount } from "../../assets.js";
import { estimateEvmFeeUsd, evmChainId, evmClient } from "../../chains/evm.js";
import { assertEvmBalance } from "../evmTransfer.js";
import {
  assertSimulation,
  bestEffort,
  callGas,
  eventEvidence,
  indexGrowthApy,
  lessBps,
  lowestFloor,
  observed,
  outcomeFailure,
  rate18,
  sameAddress,
  simulate,
  SIMULATION_UNAVAILABLE,
  tvlUsdOf,
  withTimeout,
  type Simulation,
} from "../lending/common.js";
import type { AdapterAction, AdapterRoute, PlannedStep, PreparedPayload, ProtocolAdapter } from "../types.js";
import { stepOwner, verifyEvmReceipts, type EvmOutcome, type LandedEvmReceipt } from "../verification.js";

/** EVM liquid staking runs on Ethereum only. */
export const STAKING_NETWORK = "ethereum" as const;
/** Rate drift (bps) tolerated between prepare and inclusion; the minted amount is held to it. */
export const STAKE_TOLERANCE_BPS = 5n;
const STAKE_GAS = 250_000n;
const PREVIEW_TTL_SECONDS = 10 * 60;

export interface StakeContext {
  /** The acting account: sender and the only recipient of the minted token. */
  readonly owner: Address;
  readonly amount: bigint;
  readonly stage: "plan" | "prepare";
}

export interface StakeQuote {
  /** The call the wallet sends (value = amount). */
  readonly to: Address;
  readonly data: Hex;
  /** Tokens the stake mints now, before the tolerance. */
  readonly expected: bigint;
  readonly warnings: readonly string[];
  /**
   * The minimum the call itself enforces (it reverts below it), when the
   * protocol takes one. It must equal `lessBps(expected, STAKE_TOLERANCE_BPS)`
   * (the skeleton refuses otherwise) and makes the step `floor: "onchain"`.
   */
  readonly onchainMinimum?: bigint;
}

/** One liquid-staking protocol on Ethereum. */
export interface StakingVenue {
  readonly protocol: Extract<ProtocolId, "lido" | "rocket-pool" | "etherfi" | "stader" | "mantle-lsp" | "frax-ether">;
  /** "Lido". */
  readonly label: string;
  /** The minted token's symbol in ASSETS ("wstETH"). */
  readonly symbol: string;
  /** VENUE_CONTRACTS role of the minted token's pin. */
  readonly tokenRole: VenueContractRole;
  /** How the token is valued in ETH: `function(uint256) view returns (uint256)` on the token (or on `rateRole`'s pin). */
  readonly rateFunction: string;
  /** VENUE_CONTRACTS role of the contract that answers `rateFunction` when it is not the token (Stader, Mantle: the staking contract). */
  readonly rateRole?: VenueContractRole;
  /** Provenance, pause and limit reads, and the expected output; throws to refuse. */
  quote(context: StakeContext): Promise<StakeQuote>;
  /** Extra prepare-time check of the dry run (ether.fi: the returned weETH). */
  checkSimulation?(simulation: Simulation, floor: bigint): void;
  /** Proves the outcome from the landed transaction's logs; returns the minted amount credited to the account. */
  prove(step: IntentStep, receipt: LandedEvmReceipt, account: string): { readonly minted: bigint; readonly detail: string } | { readonly failure: string };
}

/** The single pinned address of `protocol`'s `role` (fails closed when the registry has none or several). */
export function pinned(protocol: ProtocolId, role: VenueContractRole): Address {
  const addresses = venueContracts(protocol, STAKING_NETWORK, role);
  if (addresses.length !== 1) throw new PlatformError("VENUE_INVALID", `${protocol} has no single pinned ${role} on Ethereum.`, 500);
  return getAddress(addresses[0] as string);
}

export function tokenOf(venue: StakingVenue): Address {
  return pinned(venue.protocol, venue.tokenRole);
}

export function client() {
  return evmClient(STAKING_NETWORK);
}

/** The no-unstake warning every staking step carries, with the exit sentence. */
export function noUnstakeWarning(venue: Pick<StakingVenue, "label" | "symbol">): string {
  // A token with no price source cannot be swapped by Kletia (the oracle guard refuses it): never offer that exit.
  if ((UNPRICED_SYMBOLS[STAKING_NETWORK] ?? []).includes(venue.symbol)) {
    return `Kletia does not unstake ${venue.symbol}: ${venue.label} withdrawals go through its own queue, and Kletia cannot swap ${venue.symbol} back yet (no price feed for it). Exit through ${venue.label}'s own redemption.`;
  }
  return `Kletia does not unstake ${venue.symbol}: ${venue.label} withdrawals go through its own queue. To exit, swap it back (for example "swap 1 ${venue.symbol} to ETH on ethereum"); the swap rate can sit below the staking rate.`;
}

function routeMatches(venue: StakingVenue, route: AdapterRoute): boolean {
  return route.kind === "stake" &&
    route.network === STAKING_NETWORK &&
    route.destinationNetwork === STAKING_NETWORK &&
    route.input.isNative &&
    sameAddress(route.output.address, tokenOf(venue));
}

/** Refuses anything but native ETH on Ethereum into the venue's token, paid to the acting account. */
function stakeContext(venue: StakingVenue, action: AdapterAction, stage: "plan" | "prepare"): StakeContext {
  if (action.kind !== "stake" || action.network !== STAKING_NETWORK || action.destinationNetwork !== STAKING_NETWORK) {
    throw new PlatformError("NETWORK_UNSUPPORTED", `${venue.label} stakes ETH on Ethereum, not on ${CHAINS[action.network].name}.`, 422);
  }
  if (!action.input.isNative) {
    throw new PlatformError("INTENT_UNSUPPORTED", `${venue.label} stakes native ETH; ${action.input.symbol} cannot be staked. Unwrap or swap it to ETH first.`, 422);
  }
  if (!sameAddress(action.output.address, tokenOf(venue))) {
    throw new PlatformError("INTENT_UNSUPPORTED", `${venue.label} mints ${venue.symbol}, not ${action.output.symbol}.`, 422);
  }
  if (!sameAddress(action.recipient.address, action.account.address)) {
    throw new PlatformError("INTENT_UNSUPPORTED", `${venue.label} mints ${venue.symbol} to the staking account; send it on with a separate "send" step.`, 422);
  }
  const amount = BigInt(action.amount);
  if (amount <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to stake.", 422);
  return { owner: getAddress(action.account.address), amount, stage };
}

function title(venue: StakingVenue, amount: bigint): string {
  return `Stake ${formatAmount(fromBaseUnits(amount, 18))} ETH with ${venue.label} for ${venue.symbol} on Ethereum`;
}

interface Built {
  readonly transaction: ReturnType<typeof stakeTransaction>;
  readonly expected: bigint;
  readonly minimum: bigint;
  readonly gas: bigint;
  readonly warnings: string[];
  readonly floor: "onchain" | "claimed";
}

function stakeTransaction(venue: StakingVenue, context: StakeContext, quoted: StakeQuote, gas: bigint | string) {
  return {
    vm: "evm" as const,
    network: STAKING_NETWORK,
    chainId: evmChainId(STAKING_NETWORK),
    from: context.owner,
    to: quoted.to,
    data: quoted.data,
    value: context.amount.toString(),
    gas: gas.toString(),
    description: title(venue, context.amount),
  };
}

async function build(venue: StakingVenue, action: AdapterAction, stage: "plan" | "prepare"): Promise<Built> {
  const context = stakeContext(venue, action, stage);
  if (stage === "prepare") {
    await assertEvmBalance(STAKING_NETWORK, context.owner, null, context.amount, "ETH", 18);
  }
  const quoted = await venue.quote(context);
  if (quoted.expected <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `${formatAmount(fromBaseUnits(context.amount, 18))} ETH mints no ${venue.symbol}.`, 422);
  const minimum = lessBps(quoted.expected, STAKE_TOLERANCE_BPS);
  if (quoted.onchainMinimum !== undefined && quoted.onchainMinimum !== minimum) {
    throw new PlatformError("VENUE_INVALID", `The ${venue.label} call encodes a minimum other than the guaranteed ${venue.symbol} amount.`, 500);
  }
  const warnings = [...quoted.warnings];
  let gas: bigint | string = STAKE_GAS;
  if (stage === "prepare") {
    const request = { from: context.owner, to: quoted.to, data: quoted.data, value: context.amount.toString() };
    const simulation = await simulate(STAKING_NETWORK, request);
    assertSimulation(simulation, `stake with ${venue.label}`);
    if (simulation.status === "unavailable") warnings.push(SIMULATION_UNAVAILABLE);
    venue.checkSimulation?.(simulation, minimum);
    gas = await callGas(STAKING_NETWORK, request, STAKE_GAS);
  }
  warnings.push(noUnstakeWarning(venue));
  return {
    transaction: stakeTransaction(venue, context, quoted, gas),
    expected: quoted.expected,
    minimum,
    gas: STAKE_GAS,
    warnings,
    floor: quoted.onchainMinimum !== undefined ? "onchain" : "claimed",
  };
}

/** The adapter of one EVM liquid-staking protocol. */
export function createStakingAdapter(venue: StakingVenue): ProtocolAdapter {
  return {
    id: venue.protocol,
    protocols: [venue.protocol],
    label: venue.label,

    supports(route) {
      return routeMatches(venue, route);
    },

    async plan(action): Promise<PlannedStep> {
      const built = await build(venue, action, "plan");
      const fees = await estimateEvmFeeUsd(STAKING_NETWORK, built.gas);
      return {
        protocol: venue.protocol,
        title: title(venue, BigInt(action.amount)),
        mode: "wallet",
        input: assetAmount(action.input, action.amount),
        expectedOutput: assetAmount(action.output, built.expected.toString()),
        minimumOutput: assetAmount(action.output, built.minimum.toString()),
        ...(fees !== undefined ? { feesUsd: fees } : {}),
        estimatedSeconds: 15,
        settlement: { kind: "same-network" },
        warnings: built.warnings,
        transactionCount: 1,
        slippageBps: Number(STAKE_TOLERANCE_BPS),
        // "claimed": the minimum is held by Kletia's proof only; "onchain": the call also reverts below it.
        floor: built.floor,
        preview: { transactions: [built.transaction], expiresAt: Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS },
      };
    },

    async prepare({ action }): Promise<PreparedPayload> {
      const built = await build(venue, action, "prepare");
      const fees = await estimateEvmFeeUsd(STAKING_NETWORK, built.gas);
      return {
        transactions: [built.transaction],
        records: [{ vm: "evm", network: STAKING_NETWORK, to: built.transaction.to, description: built.transaction.description }],
        input: assetAmount(action.input, action.amount),
        expectedOutput: assetAmount(action.output, built.expected.toString()),
        minimumOutput: assetAmount(action.output, built.minimum.toString()),
        ...(fees !== undefined ? { feesUsd: fees } : {}),
        warnings: built.warnings,
      };
    },

    async verify(context) {
      const step = context.step;
      const output = step.minimumOutput;
      if (step.kind !== "stake" || step.network !== STAKING_NETWORK || step.protocol !== venue.protocol || !output || output.asset.toLowerCase() !== formatAssetId(STAKING_NETWORK, "erc20", tokenOf(venue)).toLowerCase()) {
        return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: `The step is not a ${venue.label} stake into ${venue.symbol}.` } };
      }
      const observedAt = new Date(context.now).toISOString();
      const { result } = await verifyEvmReceipts(context, (receipts): EvmOutcome => {
        const account = stepOwner(step);
        const target = pinned(venue.protocol, "deposit-target");
        const call = receipts.find((receipt) => sameAddress(receipt.to, target));
        if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `No landed transaction called the ${venue.label} contract.` });
        if (step.input && call.value.toString() !== step.input.amount) {
          return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The ${venue.label} call staked ${call.value} wei, not the step's ${step.input.amount}.` });
        }
        const proof = venue.prove(step, call, account);
        if ("failure" in proof) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: proof.failure });
        const floor = lowestFloor(step) ?? 1n;
        if (proof.minted < floor) {
          return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `${venue.label} credited ${proof.minted} ${venue.symbol} base units; the plan guaranteed at least ${floor}.` });
        }
        return { actualOutput: observed(output, proof.minted), evidence: [eventEvidence(step, call, observedAt, proof.detail)] };
      });
      return result;
    },
  };
}

/* ------------------------------------------------------------ positions */

/**
 * Liquid-staking tokens the owner holds on Ethereum, as journey positions
 * (`<network>:<protocol>:<symbol>`): the token balance, its value in ETH at
 * the protocol's own rate, and no withdrawable amount (Kletia does not
 * unstake; a swap is the exit). Throws on a failed read (unknown is never zero).
 */
export async function readStakingPositions(venues: readonly StakingVenue[], owner: ParsedAccountId): Promise<VenuePosition[]> {
  if (owner.chain.key !== STAKING_NETWORK) return [];
  const account = getAddress(owner.address);
  const rows = await Promise.all(venues.map(async (venue) => {
    const token = tokenOf(venue);
    const asset = findAssetBySymbol(STAKING_NETWORK, venue.symbol);
    if (!asset?.address || !sameAddress(asset.address, token)) {
      throw new PlatformError("VENUE_INVALID", `${venue.symbol} in ASSETS does not match the ${venue.label} pin.`, 500);
    }
    const balance = await withTimeout(client().readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }));
    if (balance === 0n) return null;
    const rateAbi = parseAbi([`function ${venue.rateFunction}(uint256) view returns (uint256)`]);
    const rateSource = venue.rateRole ? pinned(venue.protocol, venue.rateRole) : token;
    const read = (units: bigint) => withTimeout(client().readContract({ address: rateSource, abi: rateAbi, functionName: venue.rateFunction, args: [units] } as never)) as Promise<bigint>;
    const [value, perToken] = await Promise.all([read(balance), read(10n ** 18n)]);
    const position: VenuePosition = {
      venue: `${STAKING_NETWORK}:${venue.protocol}:${venue.symbol}`,
      network: STAKING_NETWORK,
      protocol: venue.protocol,
      name: `${venue.label} ${venue.symbol}`,
      receipt: observed({ asset: asset.id, symbol: asset.symbol, decimals: asset.decimals }, balance),
      underlying: observed({ asset: nativeAssetId(STAKING_NETWORK), symbol: "ETH", decimals: 18 }, value),
      rate: rate18(perToken, 18),
      usd: null,
      apy: null,
      withdrawableNow: null,
      observedAt: new Date().toISOString(),
    };
    return position;
  }));
  return rows.filter((row): row is VenuePosition => row !== null);
}

/* -------------------------------------------------------------- metrics */

/**
 * Rate and size of one liquid-staking token: the smoothed APY is the growth of
 * the token's own ETH rate (`rateFunction`) over about 7 days, so it is net of
 * the protocol's fee and cannot be lifted for an hour; `tvlUsd` is the token
 * supply valued at that rate. Both are null when unreadable (never ranked as
 * zero). Advisory: no plan or prepare decision depends on them.
 */
export interface StakingMetrics {
  readonly provider: StakingVenue["protocol"];
  readonly network: typeof STAKING_NETWORK;
  readonly lst: string;
  readonly smoothedApy: number | null;
  readonly apyWindowSeconds: number | null;
  readonly tvlUsd: number | null;
  readonly observedAt: string;
}

export async function readStakingMetrics(venue: StakingVenue): Promise<StakingMetrics> {
  const token = tokenOf(venue);
  const rateAbi = parseAbi([`function ${venue.rateFunction}(uint256) view returns (uint256)`]);
  const rateSource = venue.rateRole ? pinned(venue.protocol, venue.rateRole) : token;
  const rateAt = (blockNumber?: bigint) => withTimeout(client().readContract({
    address: rateSource,
    abi: rateAbi,
    functionName: venue.rateFunction,
    args: [10n ** 18n],
    ...(blockNumber !== undefined ? { blockNumber } : {}),
  } as never)) as Promise<bigint>;
  const [smoothed, supply, perToken] = await Promise.all([
    bestEffort(() => indexGrowthApy(STAKING_NETWORK, (blockNumber) => rateAt(blockNumber)), 8_000),
    bestEffort(() => withTimeout(client().readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }))),
    bestEffort(() => rateAt()),
  ]);
  const eth = { asset: nativeAssetId(STAKING_NETWORK), symbol: "ETH", decimals: 18 };
  const tvlUsd = supply === null || perToken === null ? null : await tvlUsdOf(observed(eth, (supply * perToken) / 10n ** 18n));
  return {
    provider: venue.protocol,
    network: STAKING_NETWORK,
    lst: venue.symbol,
    smoothedApy: smoothed?.apy ?? null,
    apyWindowSeconds: smoothed?.window ?? null,
    tvlUsd,
    observedAt: new Date().toISOString(),
  };
}
