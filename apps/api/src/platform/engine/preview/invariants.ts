/**
 * Prepare-time invariants of the asset-change preview (asset-preview design
 * §5.8). For every step whose payload was just prepared on a built-in venue,
 * the simulated effect must match the step before the payload leaves Kletia:
 *
 *   I1  every transaction succeeds                                  SIMULATION_FAILED (422)
 *   I2  the input debit is exactly the step input (native: the
 *       transactions' value total, deBridge's fixed fee on top)     SIMULATION_ASSET_CHANGE_REFUSED (422)
 *   I3  no other token, NFT or native value leaves the user         SIMULATION_ASSET_CHANGE_REFUSED
 *   I4  approvals only on the input token, to the pinned spender,
 *       for at most the step amount                                 SIMULATION_ASSET_CHANGE_REFUSED
 *   I5  same-network output to the user ≥ the guaranteed minimum    QUOTE_MOVED (409)
 *   I6  a ready step's input balance covers the input               INSUFFICIENT_BALANCE (422)
 *   I7  Solana: the user's token accounts keep their owner and
 *       gain no delegate                                            SIMULATION_ASSET_CHANGE_REFUSED
 *
 * Independent of the adapters' own decoding (threat S1). Plan reports the
 * same findings as warnings. Call / action steps keep BYOC's stricter rules
 * (I1 and availability only here).
 */
import {
  CHAINS,
  findAssetBySymbol,
  getProtocol,
  getYieldVenue,
  parseAssetId,
  VENUE_CONTRACTS,
  type IntentStep,
  type NetworkKey,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";

export type InvariantRule = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7";

export interface InvariantViolation {
  readonly rule: InvariantRule;
  readonly message: string;
}

/** Most-specific refusal first: an empty wallet explains a revert better than the revert does. */
const ORDER: readonly InvariantRule[] = ["I6", "I1", "I2", "I3", "I4", "I7", "I5"];

/** The error-catalog code a violation is reported with (plan: as a warning issue). */
export function violationCode(rule: InvariantRule): string {
  switch (rule) {
    case "I1":
      return "SIMULATION_FAILED";
    case "I5":
      return "QUOTE_MOVED";
    case "I6":
      return "INSUFFICIENT_BALANCE";
    default:
      return "SIMULATION_ASSET_CHANGE_REFUSED";
  }
}

/** Throws the refusal of the first violation (prepare stage). */
export function assertInvariants(violations: readonly InvariantViolation[], stepId: string): void {
  const first = [...violations].sort((a, b) => ORDER.indexOf(a.rule) - ORDER.indexOf(b.rule))[0];
  if (!first) return;
  const message = `Step ${stepId}: ${first.message}`.slice(0, 400);
  switch (first.rule) {
    case "I6":
      throw new PlatformError("INSUFFICIENT_BALANCE", message, 422);
    case "I1":
      throw new PlatformError("SIMULATION_FAILED", message, 422);
    case "I5":
      throw new PlatformError("QUOTE_MOVED", `${message} Create a new intent to re-quote.`, 409);
    default:
      throw new PlatformError("SIMULATION_ASSET_CHANGE_REFUSED", message, 422);
  }
}

/** Contract steps (bring your own contract) keep BYOC's own, stricter asset rules. */
export function isContractStep(step: Pick<IntentStep, "kind">): boolean {
  return step.kind === "call" || step.kind === "action";
}

function lower(address: string): string {
  return address.startsWith("0x") ? address.toLowerCase() : address;
}

/** Spenders a built-in step may approve: the venue's pinned contracts, its registry venue, the call's pinned spender, the adapter's own. */
export function pinnedSpenders(step: IntentStep, adapterSpender?: string): Map<string, string> {
  const out = new Map<string, string>();
  const protocolName = getProtocol(step.protocol)?.name ?? step.protocol;
  for (const entry of VENUE_CONTRACTS) {
    if (entry.protocol === step.protocol && entry.network === step.network) out.set(lower(entry.address), `${protocolName} ${entry.role.replace(/-/gu, " ")}`);
  }
  const venue = step.venue ? getYieldVenue(step.venue) : null;
  if (venue && "spender" in venue) {
    out.set(lower(venue.spender), venue.name);
    out.set(lower(venue.target), venue.name);
  }
  if (step.call?.approvalSpender) out.set(lower(step.call.approvalSpender), `${step.call.integrator.name} (custom contract)`);
  if (adapterSpender && !out.has(lower(adapterSpender))) out.set(lower(adapterSpender), `${protocolName} spender`);
  return out;
}

/** Label of a spender: the registry's name for it, never a guess. */
export function spenderLabel(step: IntentStep, spender: string, adapterSpender?: string): string {
  return pinnedSpenders(step, adapterSpender).get(lower(spender)) ?? "Unrecognised spender";
}

/** Tokens a step may legitimately see leave the user beyond its input: a withdraw's position token. */
export function positionToken(step: IntentStep): string | null {
  if (step.kind !== "withdraw" || !step.venue) return null;
  const venue = getYieldVenue(step.venue);
  return venue && "receipt" in venue ? lower(venue.receipt.address) : null;
}

/** The network's wrapped native token (WETH), which a native-input lending step wraps and approves. */
export function wrappedNative(network: NetworkKey): string | null {
  const symbol = CHAINS[network].nativeAsset.symbol === "ETH" ? "WETH" : `W${CHAINS[network].nativeAsset.symbol}`;
  const asset = findAssetBySymbol(network, symbol);
  return asset?.address ? lower(asset.address) : null;
}

export interface EvmEffect {
  /** First reverted transaction's reason, or null. */
  readonly reverted: string | null;
  /** Gross ERC-20 debits / credits of the user by lower-case token. */
  readonly debits: ReadonlyMap<string, bigint>;
  readonly credits: ReadonlyMap<string, bigint>;
  /** Net ERC-20 change by token (balance reads where available, else logs). */
  readonly net: ReadonlyMap<string, bigint>;
  readonly nativeOut: bigint;
  readonly nativeIn: bigint;
  readonly nftOut: readonly string[];
  readonly approvals: readonly { readonly token: string; readonly spender: string; readonly value: bigint | null }[];
  readonly approvalsForAll: readonly { readonly token: string }[];
  /** Σ `value` of the step's transactions. */
  readonly valueTotal: bigint;
  /** Input balance before the step (null: not read). */
  readonly balanceBefore: bigint | null;
}

export interface EvmRules {
  readonly step: IntentStep;
  /** The step's input amount this payload executes (prepared input). */
  readonly input: { readonly token: string | null; readonly amount: bigint } | null;
  /** Declared native costs on top of the input (deBridge fixed fee). */
  readonly extraNative: bigint;
  /** Minimum same-network output to the user (null: not checked). */
  readonly minimumOutput: { readonly token: string | null; readonly amount: bigint } | null;
  /** Adapter-pinned approval spender (plan-time source), if any. */
  readonly adapterSpender?: string;
  /** I6 applies (ready steps simulated against the real wallet). */
  readonly ready: boolean;
}

/** I1-I6 findings of one simulated EVM step (empty: the payload is what the step claims). */
export function evmViolations(effect: EvmEffect, rules: EvmRules): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const { step, input } = rules;
  if (rules.ready && input && effect.balanceBefore !== null && effect.balanceBefore < input.amount) {
    out.push({ rule: "I6", message: `The account holds ${effect.balanceBefore} base units of the input; ${input.amount} is needed.` });
  }
  if (effect.reverted !== null) {
    out.push({ rule: "I1", message: `The transaction would fail on-chain (${effect.reverted.slice(0, 200)}).` });
    return out;
  }
  if (isContractStep(step)) return out;
  const withdraw = step.kind === "withdraw";
  const position = positionToken(step);
  const wrapped = input && input.token === null ? wrappedNative(step.network) : null;
  if (input && !withdraw) {
    if (input.token !== null) {
      const debit = effect.debits.get(input.token) ?? 0n;
      if (debit !== input.amount) out.push({ rule: "I2", message: `The simulated input debit is ${debit} base units, not exactly the step amount ${input.amount}.` });
    } else if (effect.valueTotal !== input.amount + rules.extraNative) {
      out.push({ rule: "I2", message: `The transactions send ${effect.valueTotal} wei, not the step amount ${input.amount} plus declared costs ${rules.extraNative}.` });
    }
  }
  for (const [token, delta] of effect.net) {
    if (delta >= 0n || token === input?.token || token === position) continue;
    out.push({ rule: "I3", message: `The payload also takes ${-delta} base units of another token (${token}) from the user.` });
  }
  if (effect.nftOut.length > 0) out.push({ rule: "I3", message: `The payload moves an NFT or multi-token out of the user (${effect.nftOut[0]}).` });
  if (effect.nativeOut > effect.valueTotal) out.push({ rule: "I3", message: `The user sends ${effect.nativeOut} wei of native value, more than the transactions' ${effect.valueTotal}.` });
  const spenders = pinnedSpenders(step, rules.adapterSpender);
  const approvable = new Set([input?.token, wrapped].filter((token): token is string => typeof token === "string"));
  for (const approval of effect.approvals) {
    if (!approvable.has(approval.token)) {
      out.push({ rule: "I4", message: `The payload approves ${approval.spender} on ${approval.token}, which is not the step's input token.` });
    } else if (!spenders.has(approval.spender)) {
      out.push({ rule: "I4", message: `The payload approves ${approval.spender}, which is not the pinned spender of ${getProtocol(step.protocol)?.name ?? step.protocol}.` });
    } else if (approval.value === null || !input || approval.value > input.amount) {
      out.push({ rule: "I4", message: `The payload approves ${approval.value ?? "an unreadable amount"} base units, more than the step amount.` });
    }
  }
  if (effect.approvalsForAll.length > 0) out.push({ rule: "I4", message: `The payload grants an operator approval for all tokens of ${effect.approvalsForAll[0]?.token}.` });
  const minimum = rules.minimumOutput;
  if (minimum) {
    const credited = minimum.token === null ? effect.nativeIn : effect.net.get(minimum.token) ?? 0n;
    if (credited < minimum.amount) {
      out.push({ rule: "I5", message: `The simulated output is ${credited} base units, below the guaranteed minimum ${minimum.amount}.` });
    }
  }
  return out;
}

export interface SolanaEffect {
  readonly error: string | null;
  /** User token deltas by mint (wrapped SOL excluded). */
  readonly tokenDeltas: ReadonlyMap<string, bigint>;
  /** User lamport change, fee and rent excluded. */
  readonly solSpent: bigint;
  /** Input balance before the step (null: not read). */
  readonly balanceBefore: bigint | null;
  /** Post states of the user's token accounts (owner / delegate), when requested. */
  readonly tokenAccounts: readonly { readonly account: string; readonly owner: string; readonly delegate: string | null }[];
  readonly user: string;
}

export interface SolanaRules {
  readonly step: IntentStep;
  readonly input: { readonly mint: string | null; readonly amount: bigint } | null;
  readonly extraLamports: bigint;
  readonly minimumOutput: { readonly mint: string | null; readonly amount: bigint } | null;
  readonly ready: boolean;
}

/** Lamports a Solana step may move beyond its declared amounts (account rent, rounding). */
export const SOL_TOLERANCE_LAMPORTS = 2_100_000n;

/** I1-I7 findings of one simulated Solana step. */
export function solanaViolations(effect: SolanaEffect, rules: SolanaRules): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const { step, input } = rules;
  if (rules.ready && input && effect.balanceBefore !== null && effect.balanceBefore < input.amount) {
    out.push({ rule: "I6", message: `The account holds ${effect.balanceBefore} base units of the input; ${input.amount} is needed.` });
  }
  if (effect.error !== null) {
    out.push({ rule: "I1", message: `The transaction would fail on-chain (${effect.error.slice(0, 200)}).` });
    return out;
  }
  if (isContractStep(step)) return out;
  const withdraw = step.kind === "withdraw";
  if (input && !withdraw) {
    if (input.mint !== null) {
      const delta = effect.tokenDeltas.get(input.mint) ?? 0n;
      if (delta !== -input.amount) out.push({ rule: "I2", message: `The simulated input change is ${delta} base units, not exactly -${input.amount}.` });
    } else {
      const expected = input.amount + rules.extraLamports;
      if (effect.solSpent > expected + SOL_TOLERANCE_LAMPORTS || effect.solSpent < expected - SOL_TOLERANCE_LAMPORTS) {
        out.push({ rule: "I2", message: `The transaction spends ${effect.solSpent} lamports, not the step amount ${input.amount} plus declared costs.` });
      }
    }
  } else if (effect.solSpent > rules.extraLamports + SOL_TOLERANCE_LAMPORTS) {
    out.push({ rule: "I3", message: `The transaction takes ${effect.solSpent} lamports beyond the fee and account rent.` });
  }
  if (input && input.mint !== null && !withdraw && effect.solSpent > rules.extraLamports + SOL_TOLERANCE_LAMPORTS) {
    out.push({ rule: "I3", message: `The transaction takes ${effect.solSpent} lamports of SOL beyond the fee and account rent.` });
  }
  const position = step.kind === "withdraw" && step.venue ? (getYieldVenue(step.venue) as { receipt?: { address: string } } | null)?.receipt?.address ?? null : null;
  for (const [mint, delta] of effect.tokenDeltas) {
    if (delta >= 0n || mint === input?.mint || mint === position) continue;
    out.push({ rule: "I3", message: `The transaction also debits another token from the user (${mint}).` });
  }
  for (const account of effect.tokenAccounts) {
    if (account.owner !== effect.user) out.push({ rule: "I7", message: `The user's token account ${account.account} would change owner.` });
    else if (account.delegate !== null) out.push({ rule: "I7", message: `The user's token account ${account.account} would gain a delegate (${account.delegate}).` });
  }
  const minimum = rules.minimumOutput;
  if (minimum && minimum.mint !== null) {
    const credited = effect.tokenDeltas.get(minimum.mint) ?? 0n;
    if (credited < minimum.amount) out.push({ rule: "I5", message: `The simulated output is ${credited} base units, below the guaranteed minimum ${minimum.amount}.` });
  }
  return out;
}

/** True when the asset id is an ERC-20 / SPL token of `network` (not the native asset). */
export function tokenOf(asset: string | undefined, network: NetworkKey): string | null {
  const parsed = asset ? parseAssetId(asset) : null;
  if (!parsed || parsed.isNative || parsed.chain.key !== network) return null;
  return lower(parsed.reference);
}
