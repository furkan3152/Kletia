/**
 * Lowering (intent engine v2 §3.4): a Goal that maps one-to-one onto verb
 * steps becomes clarify slots directly ("turn 1 SOL into USDC" is a swap,
 * "zap 20 USDC from arbitrum into morpho on base" is a bridge then a
 * deposit), so it never reaches the solver. Only what the person said fills
 * a slot (by "user"); every gap stays open for the existing policy to ask or
 * assume, exactly as for a strict sentence.
 *
 * A Goal that needs a choice only the solver can make (a source for "get me
 * 1 ETH", a venue kind for "earn on my ETH", a target amount to back-solve,
 * "all but 0.1", a whole-wallet sweep) is not lowered: null.
 */
import type { AmountSel, AssetSel, Goal } from "@kletia/core";
import { isUsdWord, providerFromWord, stakeProvider, USD_ORDER } from "../clarify/catalog.js";
import type { Kind, Slot, WorkStep } from "../clarify/types.js";
import { toThreadAmount } from "./amounts.js";
import { sameSel, type ReadGoal } from "./frames.js";

export interface LowerContext {
  /** A step comes before this goal (in this message or the thread). */
  readonly previousExists: boolean;
}

const slot = <T>(v: T, by: Slot<T>["by"] = "user"): Slot<T> => ({ v, by });

const symbolOf = (asset: AssetSel | undefined): string | undefined => (asset && "symbol" in asset ? asset.symbol : undefined);
const isStableClass = (asset: AssetSel | undefined): boolean => asset !== undefined && "class" in asset && asset.class === "usd-stable";
const NATIVE_STAKE = new Set(["SOL", "ETH"]);

/** Puts an amount on a step the way the strict reader does ("$25" of a token is a USD amount; "$25" alone pays in a stablecoin). */
function putAmount(step: WorkStep, sel: AmountSel | undefined, read: ReadGoal, ctx: LowerContext, share: "balance" | "previous" | "position"): boolean {
  if (!sel) return true;
  const amount = toThreadAmount(sel, { share, previousExists: ctx.previousExists, ...(read.notes.amountRaw ? { raw: read.notes.amountRaw } : {}) });
  if (!amount) return false;
  if (amount.t === "exact" && amount.usd) {
    const { usd: _usd, ...plain } = amount;
    if (step.from && !USD_ORDER.includes(step.from.v.toUpperCase()) && !isUsdWord(step.from.v)) step.amount = slot({ t: "usd", value: plain.value });
    else {
      step.amount = slot(plain);
      if (!step.from) step.usdFrom = true;
    }
    return true;
  }
  step.amount = slot(amount);
  return true;
}

/** What a portion or "all" of the spend side is of. */
function shareOf(read: ReadGoal): "balance" | "previous" {
  return read.notes.ofPrevious ? "previous" : "balance";
}

function setFrom(step: WorkStep, asset: AssetSel | undefined): boolean {
  if (!asset) return true;
  if (isStableClass(asset)) {
    step.usdFrom = true;
    return true;
  }
  const symbol = symbolOf(asset);
  if (!symbol) return false;
  step.from = slot(symbol);
  return true;
}

function setTo(step: WorkStep, asset: AssetSel | undefined): boolean {
  if (!asset) return true;
  if (isStableClass(asset)) {
    step.usdTo = true;
    return true;
  }
  const symbol = symbolOf(asset);
  if (!symbol) return false;
  step.to = slot(symbol);
  return true;
}

function typoFlag(step: WorkStep, read: ReadGoal): void {
  const typo = read.notes.typo;
  if (!typo) return;
  step.assetTypo = { field: typo.side === "spend" ? "from" : "to", raw: typo.raw, candidates: [...typo.candidates] };
}

/** The step after a move: all of the previous output (chained, as "then deposit it" reads). */
function chained(kind: Kind): WorkStep {
  return { kind: slot(kind), amount: slot({ t: "previous", bps: 10_000 }) };
}

function viaProtocol(goal: Goal, step: WorkStep): void {
  const via = goal.constraints.via?.[0];
  if (via) step.protocol = slot(via);
}

function lowerConvert(read: ReadGoal, ctx: LowerContext): WorkStep[] | null {
  const { goal, notes } = read;
  if (goal.want.amount && !(goal.want.amount.t === "usd" && !goal.spend.amount)) return null;
  if (goal.spend.asset && "class" in goal.spend.asset && !isStableClass(goal.spend.asset)) return null;
  if (goal.spend.asset && isStableClass(goal.spend.asset) && goal.spend.amount && goal.spend.amount.t !== "exact" && goal.spend.amount.t !== "usd") return null;
  if (!goal.spend.asset && !notes.buy && !goal.spend.amount) return null;
  if (goal.want.asset && "class" in goal.want.asset && !isStableClass(goal.want.asset)) return null;
  if (goal.spend.asset && goal.want.asset && sameSel(goal.spend.asset, goal.want.asset)) return null;
  const source = goal.spend.from?.network;
  const destination = goal.want.at?.network;
  const step: WorkStep = {};
  if (source && destination && source !== destination) {
    step.kind = slot("bridge");
    step.network = slot(source);
    step.toNetwork = slot(destination);
  } else {
    step.kind = slot("swap");
    const network = source ?? destination;
    if (network) step.network = slot(network);
  }
  if (!setFrom(step, goal.spend.asset) || !setTo(step, goal.want.asset)) return null;
  if (notes.buy) step.buy = true;
  if (!putAmount(step, goal.spend.amount ?? goal.want.amount, read, ctx, shareOf(read))) return null;
  viaProtocol(goal, step);
  typoFlag(step, read);
  return [step];
}

function lowerRelocate(read: ReadGoal, ctx: LowerContext): WorkStep[] | null {
  const { goal } = read;
  if (goal.holder.t !== "self") return null;
  const asset = goal.spend.asset ?? goal.want.asset;
  if (asset && "class" in asset && !isStableClass(asset)) return null;
  const sameAsset = !goal.spend.asset || !goal.want.asset || sameSel(goal.spend.asset, goal.want.asset);
  if (goal.spend.amount && goal.want.amount) return null;
  if (goal.want.amount && !sameAsset) return null;
  const source = goal.spend.from?.network;
  const destination = goal.want.at?.network;
  if (source && destination && source === destination) return null;
  if (!asset && !goal.spend.amount) return null;
  const step: WorkStep = { kind: slot("bridge") };
  if (source) step.network = slot(source);
  if (destination) step.toNetwork = slot(destination);
  if (!setFrom(step, asset)) return null;
  if (!sameAsset && !setTo(step, goal.want.asset)) return null;
  if (!putAmount(step, goal.spend.amount ?? goal.want.amount, read, ctx, shareOf(read))) return null;
  viaProtocol(goal, step);
  typoFlag(step, read);
  return [step];
}

function lowerDeliver(read: ReadGoal, ctx: LowerContext): WorkStep[] | null {
  const { goal } = read;
  if (goal.want.asset && goal.spend.asset && !sameSel(goal.want.asset, goal.spend.asset)) return null;
  if (goal.want.amount) return null;
  const step: WorkStep = {};
  const source = goal.spend.from?.network;
  const destination = goal.want.at?.network;
  if (source && destination && source !== destination) {
    step.kind = slot("bridge");
    step.network = slot(source);
    step.toNetwork = slot(destination);
  } else {
    step.kind = slot("transfer");
    const network = source ?? destination;
    if (network) step.network = slot(network);
  }
  switch (goal.holder.t) {
    case "address":
    case "name":
      step.recipient = slot(goal.holder.value);
      break;
    case "nickname":
      // The word itself is never kept: Kletia never looks up or completes a nickname.
      step.nickname = true;
      break;
    default:
      return null;
  }
  if (!setFrom(step, goal.spend.asset ?? goal.want.asset)) return null;
  if (!putAmount(step, goal.spend.amount, read, ctx, shareOf(read))) return null;
  typoFlag(step, read);
  return [step];
}

function lowerEarn(read: ReadGoal, ctx: LowerContext): WorkStep[] | null {
  const { goal, notes } = read;
  if (goal.holder.t !== "self" || goal.want.amount) return null;
  const spendSymbol = symbolOf(goal.spend.asset);
  if (!spendSymbol && !(goal.spend.amount?.t === "usd") && !goal.spend.amount) return null;
  if (goal.spend.asset && "class" in goal.spend.asset) return null;
  const venue = notes.wantVenue;
  const lstProvider = symbolOf(goal.want.asset) ? providerFromWord(symbolOf(goal.want.asset) as string) : undefined;
  if (goal.want.asset && !lstProvider) return null;
  const native = spendSymbol !== undefined && NATIVE_STAKE.has(spendSymbol.toUpperCase());
  let kind: "stake" | "deposit";
  if (goal.op === "stake" || (venue?.provider && !venue.lending) || lstProvider) kind = "stake";
  else if (goal.op === "deposit" || venue?.lending || venue?.best) kind = "deposit";
  else if (!native && spendSymbol) kind = "deposit";
  else return null;
  const source = goal.spend.from?.network;
  const destination = goal.want.at?.network;
  const steps: WorkStep[] = [];
  const step: WorkStep = { kind: slot(kind) };
  if (source && destination && source !== destination) {
    const move: WorkStep = { kind: slot("bridge"), network: slot(source), toNetwork: slot(destination) };
    if (!setFrom(move, goal.spend.asset) || !putAmount(move, goal.spend.amount, read, ctx, shareOf(read))) return null;
    steps.push(move);
    Object.assign(step, chained(kind));
    step.network = slot(destination);
  } else {
    const network = destination ?? source;
    if (network) step.network = slot(network);
    if (!putAmount(step, goal.spend.amount, read, ctx, shareOf(read))) return null;
  }
  if (kind === "stake") {
    const provider = (venue?.provider ? stakeProvider(venue.provider) : undefined) ?? lstProvider;
    const input = spendSymbol?.toUpperCase();
    step.from = spendSymbol ? slot(input === "ETH" || input === "SOL" ? input : spendSymbol) : slot(provider?.input ?? "SOL", "derived");
    if (provider) step.provider = slot(provider.id);
  } else {
    if (!setFrom(step, goal.spend.asset)) return null;
    if (venue?.lending) step.protocol = slot(venue.lending);
  }
  typoFlag(steps[0] ?? step, read);
  return [...steps, step];
}

function lowerExit(read: ReadGoal, ctx: LowerContext): WorkStep[] | null {
  const { goal, notes } = read;
  const venue = notes.fromVenue;
  if (!venue?.lending || goal.holder.t !== "self") return null;
  const network = goal.spend.from?.network;
  const step: WorkStep = { kind: slot("withdraw"), protocol: slot(venue.lending) };
  if (network) step.network = slot(network);
  if (!setFrom(step, goal.spend.asset)) return null;
  if (goal.spend.amount) {
    const sel = goal.spend.amount;
    if (sel.t === "previous" || sel.t === "allBut") return null;
    if (!putAmount(step, sel, read, ctx, "position")) return null;
  }
  const steps: WorkStep[] = [step];
  const destination = goal.want.at;
  if (destination) {
    if (destination.custody.kind === "venue") {
      const next = notes.wantVenue;
      if (!next?.lending && !next?.best) return null;
      if (destination.network && network && destination.network !== network) return null;
      const deposit: WorkStep = chained("deposit");
      if (destination.network ?? network) deposit.network = slot((destination.network ?? network) as NonNullable<typeof network>);
      if (goal.spend.asset && "symbol" in goal.spend.asset) deposit.from = slot(goal.spend.asset.symbol);
      if (next.lending) deposit.protocol = slot(next.lending);
      steps.push(deposit);
    } else if (destination.network && destination.network !== network) {
      const move: WorkStep = chained("bridge");
      move.toNetwork = slot(destination.network);
      steps.push(move);
    }
  }
  if (goal.want.asset) return null;
  typoFlag(step, read);
  return steps;
}

function lowerAcquire(read: ReadGoal): WorkStep[] | null {
  const { goal } = read;
  // "I want JitoSOL", "get me some JitoSOL": a buy with every other slot open (the strict "buy X" reading).
  if (goal.spend.asset || goal.spend.amount || goal.want.amount || goal.spend.from || goal.want.at || goal.holder.t !== "self") return null;
  const symbol = symbolOf(goal.want.asset);
  if (!symbol) return null;
  const step: WorkStep = { kind: slot("swap"), to: slot(symbol), buy: true };
  typoFlag(step, read);
  return [step];
}

/**
 * The clarify steps a read Goal lowers to, or null when only the solver can
 * place it. Every returned step carries `goalRead` (orderOnly for D12).
 */
export function lowerGoal(read: ReadGoal, ctx: LowerContext): WorkStep[] | null {
  let steps: WorkStep[] | null;
  switch (read.goal.kind) {
    case "convert":
      steps = lowerConvert(read, ctx);
      break;
    case "relocate":
      steps = lowerRelocate(read, ctx);
      break;
    case "deliver":
      steps = lowerDeliver(read, ctx);
      break;
    case "earn":
      steps = lowerEarn(read, ctx);
      break;
    case "exit":
      steps = lowerExit(read, ctx);
      break;
    case "acquire":
      steps = lowerAcquire(read);
      break;
    default:
      steps = null;
  }
  if (!steps) return null;
  for (const step of steps) {
    step.goalRead = { lowered: true, ...(read.notes.orderOnly ? { orderOnly: true as const } : {}), ...(read.notes.possessive ? { possessive: true as const } : {}) };
  }
  return steps;
}
