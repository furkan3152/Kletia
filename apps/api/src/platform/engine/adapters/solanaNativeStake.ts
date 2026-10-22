/**
 * Native SOL staking to a validator from a seed-derived stake account,
 * on Solana mainnet and Solana Devnet.
 *
 * One transaction, signed only by the wallet:
 *   1. System `createAccountWithSeed(base = wallet, seed, lamports = amount +
 *      rent reserve, space = 200, owner = Stake program)`;
 *   2. Stake `initialize(staker = withdrawer = wallet, no lockup)`;
 *   3. Stake `delegateStake(vote account)`.
 * The stake account is fully the wallet's: it is derived from the wallet and a
 * per-step seed (`kletia:<16 hex>`, fixed at plan), so a second payload of the
 * same step can never create a second stake account (the address is taken).
 *
 * - Vote account: the one the request names (`AdapterAction.provider`, a
 *   base58 vote address), else the first active one of the pinned per-network
 *   list (VENUE_CONTRACTS role `vote-account`). It must be in
 *   `getVoteAccounts().current` (not delinquent) at plan and at prepare.
 * - Minimum: 1 SOL on mainnet, 0.01 SOL on devnet, delegated in full; the
 *   rent reserve is paid on top and reported as an extra cost.
 * - The output is the delegated SOL (`floor: "onchain"`: the transaction moves
 *   exactly that). Named-only (`explicitOnly`): route search never picks it.
 * - Verification binds the landed transaction by its three instructions
 *   (seed address, lamports, authorities, vote account) and the lamports the
 *   stake account received.
 */
import { randomBytes } from "node:crypto";
import { formatAmount, fromBaseUnits, isSolanaAddress, venueContracts, type AssetAmount } from "@kletia/core";
import { address as toAddress, createAddressWithSeed, createNoopSigner, getAddressEncoder, type Instruction } from "@solana/kit";
import { getCreateAccountWithSeedInstruction } from "@solana-program/system";
import { isSolanaNetworkKey, solanaRpc, type SolanaNetworkKey } from "../../../networks/solana/index.js";
import { rpcAbortSignal } from "../../../networks/solana/rpc.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef } from "../assets.js";
import type { SolanaTransactionObservation } from "../chains/solana.js";
import { nativeUsdPrice } from "../prices.js";
import { decodeStepRef } from "../stepRef.js";
import {
  buildStakeTransaction,
  concatBytes,
  instruction,
  meta,
  pinnedSolana,
  readPubkey,
  readU64Le,
  stakeFeeUsd,
  stakePayload,
  STAKE_SYSVARS,
  u32Le,
} from "./solanaStakeCommon.js";
import type { AdapterAction, PlannedStep, PrepareContext, ProtocolAdapter, VerificationResult } from "./types.js";
import { stepOwner, verifySolanaReferences } from "./verification.js";

const LABEL = "Native staking";
/** StakeStateV2 account size. */
export const STAKE_ACCOUNT_SPACE = 200n;
/** Smallest delegation Kletia plans, per network (lamports). */
export const NATIVE_STAKE_MINIMUM: Readonly<Record<SolanaNetworkKey, bigint>> = Object.freeze({
  solana: 1_000_000_000n,
  "solana-devnet": 10_000_000n,
});
/** Stake instruction tags (StakeInstruction enum order). */
export const STAKE_INSTRUCTION = Object.freeze({ initialize: 0, delegateStake: 2 });
/** System instruction tag of CreateAccountWithSeed. */
const SYSTEM_CREATE_WITH_SEED = 3;
const COMPUTE_UNITS = 100_000;
/** Quote handle: `native:<vote account>:<16 hex seed suffix>`. */
const QUOTE_PATTERN = /^native:([1-9A-HJ-NP-Za-km-z]{32,44}):([0-9a-f]{16})$/u;
const WARNING = "The stake activates at the next epoch boundary (about 2 days at most) and earns from then on; unstaking also takes one epoch, and Kletia does not unstake: deactivate and withdraw from the stake account in your wallet.";

export interface NativeStakeQuote {
  readonly vote: string;
  /** Full seed (`kletia:<16 hex>`). */
  readonly seed: string;
}

export function encodeNativeStakeQuote(quote: NativeStakeQuote): string {
  return `native:${quote.vote}:${quote.seed.slice("kletia:".length)}`;
}

export function decodeNativeStakeQuote(value: string | undefined): NativeStakeQuote | null {
  const match = value ? QUOTE_PATTERN.exec(value) : null;
  if (!match || !isSolanaAddress(match[1])) return null;
  return { vote: match[1] as string, seed: `kletia:${match[2] as string}` };
}

/** The stake account `createAccountWithSeed(owner, seed, Stake program)` creates. */
export async function nativeStakeAddress(network: SolanaNetworkKey, owner: string, seed: string): Promise<string> {
  return String(await createAddressWithSeed({ baseAddress: toAddress(owner), programAddress: toAddress(stakeProgram(network)), seed }));
}

export function stakeProgram(network: SolanaNetworkKey): string {
  return pinnedSolana("solana-stake", network, "program");
}

function zeroKey(): Uint8Array {
  return new Uint8Array(32);
}

/** `Initialize(Authorized { staker, withdrawer }, Lockup::default())` (bincode). */
export function stakeInitializeData(owner: string): Uint8Array {
  const key = getAddressEncoder().encode(toAddress(owner));
  return concatBytes(u32Le(STAKE_INSTRUCTION.initialize), Uint8Array.from(key), Uint8Array.from(key), new Uint8Array(16), zeroKey());
}

export function stakeDelegateData(): Uint8Array {
  return u32Le(STAKE_INSTRUCTION.delegateStake);
}

export function nativeStakeInstructions(network: SolanaNetworkKey, owner: string, stake: string, seed: string, vote: string, lamports: bigint): Instruction[] {
  const program = stakeProgram(network);
  const signer = createNoopSigner(toAddress(owner));
  return [
    getCreateAccountWithSeedInstruction({
      payer: signer,
      newAccount: toAddress(stake),
      baseAccount: signer,
      base: toAddress(owner),
      seed,
      amount: lamports,
      space: STAKE_ACCOUNT_SPACE,
      programAddress: toAddress(program),
    }),
    instruction(program, [meta(stake, "w"), meta(STAKE_SYSVARS.rent, "r")], stakeInitializeData(owner)),
    instruction(program, [
      meta(stake, "w"),
      meta(vote, "r"),
      meta(STAKE_SYSVARS.clock, "r"),
      meta(STAKE_SYSVARS.stakeHistory, "r"),
      meta(STAKE_SYSVARS.stakeConfig, "r"),
      meta(owner, "rs"),
    ], stakeDelegateData()),
  ];
}

export async function stakeRentReserve(network: SolanaNetworkKey): Promise<bigint> {
  try {
    // The account size goes over the wire as a JSON number. The HTTP app installs BigInt.prototype.toJSON
    // (http/app.ts), which makes the RPC client send a bigint parameter as the string "200"; the RPC then
    // refuses it ("expected usize") and native staking could never plan on a running API.
    const space = Number(STAKE_ACCOUNT_SPACE) as unknown as bigint;
    const value = await solanaRpc(network).getMinimumBalanceForRentExemption(space, { commitment: "confirmed" }).send({ abortSignal: rpcAbortSignal() });
    return BigInt(value);
  } catch {
    throw new PlatformError("SOLANA_RPC_UNAVAILABLE", "The Solana RPC could not report the stake account rent. Try again shortly.", 502);
  }
}

export interface VoteAccountStatus {
  readonly vote: string;
  readonly commission: number;
}

/** The vote account's status: active (`current`), or null when delinquent or unknown. */
export async function activeVoteAccount(network: SolanaNetworkKey, vote: string): Promise<VoteAccountStatus | null> {
  let result;
  try {
    result = await solanaRpc(network).getVoteAccounts({ votePubkey: toAddress(vote), commitment: "confirmed" }).send({ abortSignal: rpcAbortSignal() });
  } catch {
    throw new PlatformError("SOLANA_RPC_UNAVAILABLE", "The Solana RPC could not list vote accounts. Try again shortly.", 502);
  }
  const current = result.current.find((entry) => String(entry.votePubkey) === vote);
  return current ? { vote, commission: Number(current.commission) } : null;
}

/** The named vote account if active, else the first active pinned default. */
export async function chooseVoteAccount(network: SolanaNetworkKey, named: string | undefined): Promise<VoteAccountStatus> {
  if (named !== undefined) {
    if (!isSolanaAddress(named)) throw new PlatformError("VENUE_UNKNOWN", "The validator must be named by its vote account address.", 422);
    const status = await activeVoteAccount(network, named);
    if (!status) throw new PlatformError("VENUE_UNSUPPORTED", `Vote account ${named} is not an active (voting) validator on ${network}.`, 422);
    return status;
  }
  for (const vote of venueContracts("solana-stake", network, "vote-account")) {
    const status = await activeVoteAccount(network, vote);
    if (status) return status;
  }
  throw new PlatformError("RESERVE_UNAVAILABLE", `None of Kletia's default validators on ${network} is voting right now; name an active vote account.`, 422);
}

function networkOf(action: Pick<AdapterAction, "network">): SolanaNetworkKey {
  if (!isSolanaNetworkKey(action.network)) throw new PlatformError("NETWORK_UNSUPPORTED", "Native staking runs on solana or solana-devnet.", 422);
  return action.network;
}

/**
 * A delegation below the network's minimum: on Solana the liquid staking
 * route (no minimum) is offered as example sentences; Solana Devnet has no
 * liquid staking, so the minimum is stated plainly.
 */
export function belowNativeMinimum(network: SolanaNetworkKey, amount: bigint, minimum: bigint): PlatformError {
  const asked = formatAmount(fromBaseUnits(amount, 9));
  const floor = formatAmount(fromBaseUnits(minimum, 9));
  const issues = [{ path: "amount", message: `At least ${floor} SOL for native staking.` }];
  if (network === "solana") {
    return new PlatformError(
      "AMOUNT_TOO_SMALL",
      `Native staking delegates at least ${floor} SOL on Solana, so ${asked} SOL is too little. Liquid staking has no such minimum: stake ${asked} SOL with Jito, Marinade or Jupiter instead.`,
      422,
      issues,
      [`stake ${asked} SOL with jito`, `stake ${asked} SOL with marinade`, `stake ${asked} SOL with jupiter`],
    );
  }
  return new PlatformError(
    "AMOUNT_TOO_SMALL",
    `Native staking delegates at least ${floor} SOL on Solana Devnet, so ${asked} SOL is too little. Liquid staking is not available on devnet; stake ${floor} SOL or more.`,
    422,
    issues,
    [`stake ${floor} SOL on solana devnet`],
  );
}

function assertAction(action: AdapterAction): { network: SolanaNetworkKey; amount: bigint } {
  const network = networkOf(action);
  if (action.kind !== "stake" || action.destinationNetwork !== network || !action.input.isNative || !action.output.isNative) {
    throw new PlatformError("INTENT_UNSUPPORTED", "Native staking delegates native SOL on one Solana network.", 422);
  }
  if (action.recipient.address !== action.account.address) {
    throw new PlatformError("INTENT_UNSUPPORTED", "Native staking creates a stake account owned by the staking wallet itself.", 422);
  }
  const amount = /^\d+$/u.test(action.amount) ? BigInt(action.amount) : 0n;
  const minimum = NATIVE_STAKE_MINIMUM[network];
  if (amount < minimum) throw belowNativeMinimum(network, amount, minimum);
  return { network, amount };
}

function nativeTitle(amount: bigint, network: SolanaNetworkKey, vote: string): string {
  return `Stake ${formatAmount(fromBaseUnits(amount, 9))} SOL natively with validator ${vote.slice(0, 4)}…${vote.slice(-4)} on ${network === "solana" ? "Solana" : "Solana Devnet"}`;
}

/** Named vote account carried in `provider` (a base58 address), if any. */
function namedVote(action: Pick<AdapterAction, "provider">): string | undefined {
  return action.provider !== undefined && isSolanaAddress(action.provider) ? action.provider : undefined;
}

async function amounts(action: AdapterAction, network: SolanaNetworkKey, amount: bigint, rent: bigint) {
  const sol = network === "solana" ? await nativeUsdPrice(network) : null;
  const usd = (lamports: bigint) => (sol === null ? undefined : (Number(lamports) / 1e9) * sol);
  const staked = assetAmount(action.input, amount.toString(), usd(amount));
  const reserve = assetAmount(action.input, rent.toString(), usd(rent));
  return { input: staked, expectedOutput: staked, minimumOutput: staked, extraCosts: [reserve] as AssetAmount[] };
}

function warnings(status: VoteAccountStatus, rent: bigint): string[] {
  const out = [WARNING, `The stake account also holds its rent reserve (${Number(rent) / 1e9} SOL), returned when you withdraw it.`];
  if (status.commission > 10) out.push(`Validator ${status.vote} charges ${status.commission}% commission on rewards.`);
  return out;
}

/** The plan's quote of a prepared step (vote account and seed); refuses a step without one. */
function plannedQuote(context: Pick<PrepareContext, "step">): NativeStakeQuote {
  const quote = decodeNativeStakeQuote(decodeStepRef(context.step.quoteRef)?.quote);
  if (!quote) throw new PlatformError("STEP_INVALID", "The native staking step has no planned validator and stake account seed. Plan it again.", 500);
  return quote;
}

/** Landed-transaction binding: the three instructions of the planned stake. Returns why it does not bind, or null. */
export function nativeStakeBindingFailure(
  observations: readonly SolanaTransactionObservation[],
  expected: { program: string; owner: string; stake: string; seed: string; vote: string; amount: bigint },
): string | null {
  const instructions = observations.flatMap((observation) => observation.instructions ?? []);
  const create = instructions.find((entry) =>
    entry.program === "11111111111111111111111111111111" &&
    entry.data.length >= 4 && new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength).getUint32(0, true) === SYSTEM_CREATE_WITH_SEED &&
    entry.accounts[0] === expected.owner && entry.accounts[1] === expected.stake);
  if (!create) return "No landed transaction created the planned stake account.";
  // CreateAccountWithSeed: tag u32 | base | seed (u64 length + bytes) | lamports u64 | space u64 | owner.
  const seedLength = readU64Le(create.data, 36);
  const seedEnd = 44 + Number(seedLength ?? 0n);
  const seed = Buffer.from(create.data.subarray(44, seedEnd)).toString("utf8");
  const lamports = readU64Le(create.data, seedEnd);
  if (readPubkey(create.data, 4) !== expected.owner || seed !== expected.seed || readPubkey(create.data, seedEnd + 16) !== expected.program) {
    return "The landed stake account is not the planned one.";
  }
  if (lamports === null || lamports < expected.amount) return "The landed stake account holds less than the planned amount.";
  const initialized = instructions.some((entry) =>
    entry.program === expected.program && entry.accounts[0] === expected.stake && entry.data.length === stakeInitializeData(expected.owner).length &&
    stakeInitializeData(expected.owner).every((value, index) => entry.data[index] === value));
  if (!initialized) return "The landed stake account was not initialised with the wallet as staker and withdrawer.";
  const delegated = instructions.some((entry) =>
    entry.program === expected.program && entry.accounts[0] === expected.stake && entry.accounts[1] === expected.vote &&
    entry.data.length === 4 && entry.data[0] === STAKE_INSTRUCTION.delegateStake);
  if (!delegated) return "The landed stake account was not delegated to the planned validator.";
  const credited = observations.reduce((total, observation) => total + (observation.lamportDeltas.get(expected.stake) ?? 0n), 0n);
  if (credited < expected.amount) return "The stake account did not receive the planned amount.";
  return null;
}

export const solanaNativeStakeAdapter: ProtocolAdapter | null = {
  id: "solana-stake",
  protocols: ["solana-stake"],
  label: LABEL,
  explicitOnly: true,

  supports(route) {
    return (
      route.kind === "stake" &&
      isSolanaNetworkKey(route.network) &&
      route.destinationNetwork === route.network &&
      route.input.isNative &&
      route.output.isNative
    );
  },

  async plan(action): Promise<PlannedStep> {
    const { network, amount } = assertAction(action);
    const [status, rent] = await Promise.all([chooseVoteAccount(network, namedVote(action)), stakeRentReserve(network)]);
    const seed = `kletia:${randomBytes(8).toString("hex")}`;
    const fees = await stakeFeeUsd(network);
    return {
      protocol: "solana-stake",
      title: nativeTitle(amount, network, status.vote),
      mode: "wallet",
      ...(await amounts(action, network, amount, rent)),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      estimatedSeconds: 15,
      settlement: { kind: "same-network" },
      warnings: warnings(status, rent),
      quoteId: encodeNativeStakeQuote({ vote: status.vote, seed }),
      transactionCount: 1,
      slippageBps: 1,
      floor: "onchain",
    };
  },

  async prepare(context) {
    const { action } = context;
    const { network, amount } = assertAction(action);
    const quote = plannedQuote(context);
    const [status, rent] = await Promise.all([activeVoteAccount(network, quote.vote), stakeRentReserve(network)]);
    if (!status) throw new PlatformError("RESERVE_UNAVAILABLE", `Vote account ${quote.vote} stopped voting since the plan; plan the stake again.`, 422);
    const owner = action.account.address;
    const stake = await nativeStakeAddress(network, owner, quote.seed);
    const built = await buildStakeTransaction(network, owner, nativeStakeInstructions(network, owner, stake, quote.seed, quote.vote, amount + rent), COMPUTE_UNITS, "stake delegation");
    const fees = await stakeFeeUsd(network);
    const { extraCosts, ...rest } = await amounts(action, network, amount, rent);
    return stakePayload(network, owner, stakeProgram(network), built, `${nativeTitle(amount, network, quote.vote)} from stake account ${stake}`, rest, {
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      quoteId: encodeNativeStakeQuote(quote),
      extraCosts,
      warnings: warnings(status, rent),
    });
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    const quote = decodeNativeStakeQuote(decodeStepRef(step.quoteRef)?.quote);
    const input = step.input ? assetFromRef(step.input) : null;
    if (step.kind !== "stake" || step.protocol !== "solana-stake" || !isSolanaNetworkKey(step.network) || !quote || !input?.isNative || !step.input) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The step is not a native SOL stake." } };
    }
    const network = step.network;
    const owner = stepOwner(step);
    const stake = await nativeStakeAddress(network, owner, quote.seed);
    const amount = BigInt(step.input.amount);
    const { result } = await verifySolanaReferences(context, (observations) => {
      const failure = nativeStakeBindingFailure(observations, { program: stakeProgram(network), owner, stake, seed: quote.seed, vote: quote.vote, amount });
      return failure ? { failure: { code: "REFERENCE_MISMATCH", message: failure } } : undefined;
    });
    return result.status === "confirmed" ? { ...result, actualOutput: step.input } : result;
  },
};
