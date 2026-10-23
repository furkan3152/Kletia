/**
 * Hand-off decisions (round 9): the state readHandoff started (or a thread
 * kept) checked with each surface's own rules, the missing values asked, the
 * defaults shown as chips, and the typed input of the surface returned.
 *
 * - perps: `validatePerpsRequest` plus the venue and rule-book guards that
 *   need no market read (a disabled venue, perps off for the key, leverage
 *   above the rule book's cap). Missing side, collateral or leverage is asked.
 * - orders: `planNativeOrder` (pure) picks the protocol and network; a pair on
 *   several networks asks the network. Order ids are checked by parseOrderId.
 * - automations: the run's sentence is read by the intent reader (its
 *   questions are asked here, its chips shown), must read again at run time
 *   without questions, and the draft is `planAutomationFromGoal`'s. A
 *   swap-like schedule with an end, or a take-profit sell of an exact amount,
 *   becomes the native order that runs without the person.
 *
 * Nothing here quotes, prepares or stores: the surface does that after the
 * person confirms. Refusals throw PlatformError.
 */
import {
  CHAINS,
  findAssetBySymbol,
  formatAccountId,
  getPerpsVenue,
  parseAccountId,
  planAutomationFromGoal,
  validatePerpsRequest,
  YIELD_VENUES,
  venueExecutes,
  type AccountId,
  type AutomationGoalTrigger,
  type IntentHandoff,
  type NetworkKey,
  type PerpsPolicyView,
  type ThreadHandoff,
} from "@kletia/core";
import { PlatformError, isPlatformError } from "../../errors.js";
import { planNativeOrder, type NativeOrderInput } from "../../orders/plan.js";
import { assumption, clip, question } from "../clarify/copy.js";
import { networkName } from "../clarify/catalog.js";
import type { TurnFacts } from "../clarify/facts.js";
import type { Assumption, Question } from "../clarify/types.js";
import { decimalOf, swapOfText } from "./read.js";

/** What the intent reader made of a run's sentence (decideTurn, replayed with the answers given). */
export type InnerReading =
  | {
    readonly status: "ready";
    readonly sentence: string;
    readonly network: NetworkKey;
    /** The amount is a share of a holding ("half of my SOL"): the run keeps the words, not today's number. */
    readonly relative: boolean;
    readonly assumptions: readonly Assumption[];
    /** One step that swaps an exact amount: a native order can run it. */
    readonly swap: { readonly sell: string; readonly buy: string; readonly amount: string } | null;
    /** One swap step: the token it receives (said or chosen), written into a run's sentence that keeps its words. */
    readonly receives?: string;
  }
  | { readonly status: "needs_input"; readonly questions: readonly Question[]; readonly assumptions: readonly Assumption[] };

export interface HandoffEnv {
  readonly accounts: readonly string[];
  readonly facts: TurnFacts;
  readonly now: number;
  readonly perps: PerpsPolicyView;
  /** Reads a run's sentence with the answers given so far. */
  readonly inner: (text: string, answers: NonNullable<ThreadHandoff["inner"]>["answers"]) => Promise<InnerReading>;
  /** Null when `text` reads again without questions at run time (exact reading), else why not. */
  readonly runReadable: (text: string) => Promise<string | null>;
}

export type HandoffOutcome =
  | { readonly status: "handoff"; readonly handoff: IntentHandoff; readonly assumptions: readonly Assumption[]; readonly state: ThreadHandoff }
  | { readonly status: "needs_input"; readonly questions: readonly Question[]; readonly assumptions: readonly Assumption[]; readonly state: ThreadHandoff };

type Input = Record<string, unknown>;

const issues = (message: string) => [{ path: "text", message: clip(message, 160) }];
const unsupported = (message: string) => new PlatformError("INTENT_UNSUPPORTED", clip(message, 300), 422, issues(message));
const leverageTooHigh = (message: string) => new PlatformError("PERPS_LEVERAGE_TOO_HIGH", clip(message, 300), 422, issues(message));
const ask = (state: ThreadHandoff, questions: Question[], assumptions: Assumption[]): HandoffOutcome => ({ status: "needs_input", questions, assumptions, state });
const chip = (field: string, label: string, reason: string, material = false, source: Assumption["source"] = "default") =>
  assumption(`handoff.${field}`, label, {}, source, reason, [], material);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const upper = (value: unknown) => (typeof value === "string" ? value.toUpperCase() : "");
const usd = (value: number) => (Math.ceil(value * 100 - 1e-9) / 100).toFixed(2).replace(/\.00$/u, "");
const times = (value: number) => `${Number(value.toFixed(2))}x`;

/* ------------------------------------------------------------------- perps */

const LEVERAGE_OPTIONS = [2, 3, 5, 10];

function perpsQuestions(input: Input, cap: number): Question | null {
  const market = upper(input.market);
  if (!input.side) {
    return question("handoff.side", "choice", "SIDE_MISSING", `Close your ${market} long or your ${market} short?`, "A market can hold a long and a short; only you know which one.",
      [{ id: "long", label: "Long", value: {} }, { id: "short", label: "Short", value: {} }], false);
  }
  const side = String(input.side);
  if (input.action === "decrease" && input.sizeUsd === undefined) {
    return question("handoff.sizeUsd", "amount", "AMOUNT_MISSING", `How many dollars of your ${market} ${side} should come off?`, "Reducing takes off part of the position's size; closing takes all of it.", [], true, "Amount in USD");
  }
  if (input.action !== "open") return null;
  if (input.collateral === undefined && input.sizeUsd === undefined) {
    return question("handoff.collateral", "amount", "AMOUNT_MISSING", `How much USDC goes in as collateral for the ${market} ${side}?`, "Collateral is what you can lose; size is collateral times leverage.", [], true, "Amount in USDC");
  }
  if (input.leverage === undefined && (input.collateral === undefined || input.sizeUsd === undefined)) {
    const options = LEVERAGE_OPTIONS.filter((value) => value <= cap).map((value) => ({ id: String(value), label: `${value}x`, value: {} }));
    return question("handoff.leverage", "choice", "LEVERAGE_MISSING", `What leverage for the ${market} ${side}?`, `Leverage multiplies gains and losses; the rule book allows up to ${cap}x.`, options, true, "Leverage, e.g. 3x");
  }
  return null;
}

function decidePerps(state: ThreadHandoff, env: HandoffEnv): HandoffOutcome {
  const input = state.input as Input;
  const venueId = str(input.venue);
  const venue = venueId ? getPerpsVenue(venueId) : null;
  if (venue && !venue.enabled) {
    const message = `${venue.name} is disabled: ${venue.disabledReason ?? "Kletia prepares nothing there."}`;
    throw new PlatformError("PERPS_VENUE_DISABLED", clip(message, 300), 422, issues(message));
  }
  if (!env.perps.enabled) throw new PlatformError("PERPS_POLICY_DENIED", env.perps.reason ?? "This key's rule book does not allow perps.", 403);
  if (venue && !env.perps.venues.includes(venue.id)) throw new PlatformError("PERPS_POLICY_DENIED", `This key's rule book does not allow ${venue.name}.`, 403);
  const cap = Math.min(env.perps.maxLeverage, venue?.maxLeverage ?? Number.POSITIVE_INFINITY);
  const said = num(input.leverage);
  if (said !== undefined && said > cap) {
    throw leverageTooHigh(`${times(said)} is above the ${venue && venue.maxLeverage < env.perps.maxLeverage ? `${venue.name}` : "rule book's"} ${cap}x cap. Say ${cap}x or less.`);
  }
  const open = perpsQuestions(input, cap);
  const assumptions: Assumption[] = [];
  if (open) return ask(state, [open], assumptions);
  const market = upper(input.market);
  const side = String(input.side) as "long" | "short";
  const action = String(input.action) as "open" | "decrease" | "close";
  let collateral = str(input.collateral);
  let leverage = num(input.leverage);
  const sizeUsd = str(input.sizeUsd);
  if (action === "open") {
    if (collateral === undefined && sizeUsd !== undefined && leverage !== undefined) {
      collateral = usd(Number(sizeUsd) / leverage);
      assumptions.push(chip("collateral", `Collateral ${collateral} USDC`, `Size ${sizeUsd} USD at ${times(leverage)}: the collateral is size divided by leverage.`, true));
    } else if (leverage === undefined && sizeUsd !== undefined && collateral !== undefined) {
      leverage = Number(sizeUsd) / Number(collateral);
      if (leverage > cap) throw leverageTooHigh(`${sizeUsd} USD on ${collateral} USDC is ${times(leverage)}, above the ${cap}x cap. Add collateral or lower the size.`);
      assumptions.push(chip("leverage", `Leverage ${times(leverage)}`, `Size ${sizeUsd} USD on ${collateral} USDC of collateral.`, true));
    } else if (sizeUsd !== undefined && collateral !== undefined && leverage !== undefined && Math.abs(Number(collateral) * leverage - Number(sizeUsd)) > Number(sizeUsd) * 0.01) {
      throw unsupported(`${collateral} USDC at ${times(leverage)} is ${usd(Number(collateral) * leverage)} USD, not ${sizeUsd} USD. Say two of size, collateral and leverage.`);
    }
    if (leverage !== undefined && leverage < 1) throw leverageTooHigh("Leverage is 1x or more: the size cannot be smaller than the collateral.");
    if (input.collateralAsset !== "USDC") assumptions.push(chip("collateralAsset", "Collateral in USDC", "Every venue Kletia builds for takes USDC collateral."));
  }
  if (!venue && action === "open") assumptions.push(chip("venue", "Venue: cheapest at quote time", "The Perps ticket compares the venues your rule book allows (fees, funding, price impact) and picks the cheapest eligible one."));
  if (!venue && action !== "open") assumptions.push(chip("venue", "Venue: where the position is", "The Perps ticket reads your positions on every venue and acts on the one that holds this market and side."));
  const request = {
    action, symbol: market, side, ...(venue ? { venue: venue.id } : {}), ...(sizeUsd !== undefined && action !== "close" ? { sizeUsd } : {}),
    ...(collateral !== undefined && action === "open" ? { collateral: { asset: "USDC", amount: collateral } } : {}),
    ...(leverage !== undefined && action === "open" ? { leverage: Number(leverage.toFixed(4)) } : {}),
  };
  const checked = validatePerpsRequest(request);
  if (!checked.ok) throw new PlatformError("INVALID_REQUEST", "The perps trade is invalid.", 400, checked.issues);
  const out = {
    market, side, action, ...(request.sizeUsd ? { sizeUsd: request.sizeUsd } : {}), ...(collateral && action === "open" ? { collateral } : {}),
    ...(request.leverage !== undefined ? { leverage: request.leverage } : {}), ...(venue ? { venue: venue.id } : {}), ...(str(input.network) ? { network: input.network as NetworkKey } : {}),
  };
  const where = venue ? ` on ${venue.name}` : "";
  const summary = action === "close" ? `Close the ${market} ${side}${where}`
    : action === "decrease" ? `Reduce the ${market} ${side} by ${sizeUsd} USD${where}`
    : `${side === "long" ? "Long" : "Short"} ${market} ${times(out.leverage ?? 1)} with ${collateral} USDC${out.sizeUsd ? ` (${out.sizeUsd} USD size)` : ""}${where}`;
  return { status: "handoff", handoff: { surface: "perps", input: out, summary, execution: "signature" }, assumptions, state };
}

function answerPerps(input: Input, field: string, option: string | undefined, text: string | undefined): Input {
  const value = (option ?? text ?? "").trim().toLowerCase();
  switch (field) {
    case "side":
      if (value !== "long" && value !== "short") throw answerInvalid("Say long or short.");
      return { ...input, side: value };
    case "leverage": {
      const match = /^(\d+(?:\.\d+)?)\s*x?$/u.exec(value);
      if (!match) throw answerInvalid("Say a leverage such as 3x.");
      return { ...input, leverage: Number(decimalOf(match[1] as string)) };
    }
    case "collateral":
    case "sizeUsd": {
      const match = /^\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:usdc|usd|dollars)?$/u.exec(value);
      if (!match) throw answerInvalid("Say an amount in dollars, e.g. 100.");
      return { ...input, [field]: decimalOf(match[1] as string) };
    }
    default:
      throw answerInvalid("That question is not open.");
  }
}

/* ------------------------------------------------------------------ orders */

/** The listed spelling of a symbol on a network ("weth" -> "WETH", "jitosol" -> "JitoSOL"); addresses as given. */
function listedSymbol(network: NetworkKey, symbol: string): string {
  if (symbol.length > 16) return symbol;
  const native = CHAINS[network].nativeAsset.symbol;
  return native.toUpperCase() === symbol.toUpperCase() ? native : findAssetBySymbol(network, symbol)?.symbol ?? symbol.toUpperCase();
}

const PERIOD_WORD: Readonly<Record<string, string>> = { minute: "minute", hour: "hour", day: "day", week: "week", month: "month" };

async function decideOrders(state: ThreadHandoff, env: HandoffEnv, extra: Assumption[] = []): Promise<HandoffOutcome> {
  const input = state.input as Input;
  const assumptions = [...extra];
  if (input.action === "cancel") {
    const { parseOrderId } = await import("../../orders/registry.js");
    const ref = parseOrderId(String(input.orderId));
    return {
      status: "handoff", assumptions, state,
      handoff: { surface: "orders", input: { action: "cancel", orderId: String(input.orderId) }, summary: `Cancel ${ref.protocol} order ${clip(ref.nativeId, 24)} on ${networkName(ref.network)}`, execution: "signature" },
    };
  }
  const kind: "limit" | "dca" = input.kind === "dca" ? "dca" : "limit";
  let sell = str(input.sell);
  let buy = str(input.buy);
  if (!sell || !buy) {
    if (kind === "dca" && !sell && !input.usd) {
      return ask(state, [question("handoff.sell", "choice", "INPUT_ASSET_MISSING", `Pay for the ${upper(buy)} with which token?`, "A DCA order sells one token in equal parts.",
        ["USDC", "USDT"].map((symbol) => ({ id: symbol, label: symbol, value: {} })), true, "Token symbol")], assumptions);
    }
    if (!sell) sell = "USDC";
    else buy = "USDC";
    assumptions.push(chip("counter", input.usd ? "Pays in USDC" : `Priced in USDC`, input.usd ? "A dollar amount is paid in USDC." : "The price was given without a token: it is read in USDC."));
  }
  const network = str(input.network);
  const order: NativeOrderInput = {
    kind, sell: sell as string, buy: buy as string, amount: String(input.amount),
    ...(input.amountIn === "buy" ? { amountIn: "buy" as const } : {}),
    ...(str(input.price) ? { price: String(input.price) } : {}),
    ...(kind === "dca" ? { period: input.period as NativeOrderInput["period"], count: num(input.count) as number } : {}),
    ...(network ? { network } : {}),
    ...(num(Number(input.expiresIn)) ? { expiresAt: new Date(env.now + Number(input.expiresIn) * 1000).toISOString() } : {}),
  };
  let plan;
  try {
    plan = planNativeOrder(order, Math.floor(env.now / 1000));
  } catch (error) {
    const candidates = isPlatformError(error) && error.code === "ORDER_NETWORK_REQUIRED" ? ((error.details as { candidates?: NetworkKey[] } | undefined)?.candidates ?? []) : [];
    if (candidates.length > 0) {
      return ask(state, [question("handoff.network", "choice", "NETWORK_AMBIGUOUS", `Which network should the ${kind === "dca" ? "DCA" : "limit"} order run on?`,
        `${sell} and ${buy} are on ${candidates.map(networkName).join(", ")}; the order runs where the tokens are.`,
        candidates.map((entry) => ({ id: entry, label: networkName(entry), value: { network: entry } })), false)], assumptions);
    }
    throw error;
  }
  const evm = CHAINS[plan.network].vm === "evm";
  plan = { ...plan, sell: listedSymbol(plan.network, plan.sell), buy: listedSymbol(plan.network, plan.buy) };
  if (kind === "limit") {
    if (!order.expiresAt) assumptions.push(chip("expiresAt", evm ? "Expires in 30 days" : "No expiry", evm ? "CoW Protocol orders expire after 30 days unless you set a time." : "Jupiter limit orders stay open until they fill or you cancel them."));
  } else {
    const parts = plan.count as number;
    const each = usd(Number(plan.amount) / parts);
    assumptions.push(chip("schedule", `${each} ${plan.sell} every ${PERIOD_WORD[String(input.period)] ?? "period"}, ${parts} parts`, `${plan.amount} ${plan.sell} in total, sold in equal parts.`, true));
    if (evm) assumptions.push(chip("safe", "Needs a Safe account", "CoW TWAP orders run from a Safe with CoW's fallback handler; a plain wallet is refused when the order is prepared.", true));
  }
  const protocol = plan.protocol === "cow-protocol" ? "CoW Protocol" : plan.protocol === "jupiter-trigger" ? "Jupiter Trigger" : "Jupiter Recurring";
  const summary = kind === "limit"
    ? `Limit ${plan.amountIn === "buy" ? `buy ${plan.amount} ${plan.buy}` : `sell ${plan.amount} ${plan.sell}`} at ${plan.price} ${plan.amountIn === "buy" ? plan.sell : plan.buy} on ${networkName(plan.network)} (${protocol})`
    : `DCA ${plan.amount} ${plan.sell} into ${plan.buy} over ${plan.count} ${String(input.period)}s on ${networkName(plan.network)} (${protocol})`;
  const handoffOrder = {
    kind, sell: plan.sell, buy: plan.buy, amount: plan.amount, ...(plan.amountIn === "buy" ? { amountIn: "buy" as const } : {}), ...(plan.price ? { price: plan.price } : {}),
    ...(kind === "dca" ? { period: input.period as "day", count: plan.count as number } : {}), network: plan.network,
    ...(order.expiresAt ? { expiresAt: String(order.expiresAt) } : {}),
  };
  return {
    status: "handoff", assumptions, state,
    handoff: { surface: "orders", input: { action: "create", order: handoffOrder, protocol: plan.protocol, network: plan.network }, summary: clip(summary, 160), execution: "native" },
  };
}

function answerOrders(input: Input, field: string, option: string | undefined, text: string | undefined): Input {
  const value = (option ?? text ?? "").trim();
  if (field === "network" && value && Object.hasOwn(CHAINS, value)) return { ...input, network: value };
  if (field === "sell" && /^[A-Za-z][A-Za-z0-9.]{0,15}$/u.test(value)) return { ...input, sell: value.toUpperCase() };
  throw answerInvalid("Choose one of the options.");
}

/* ------------------------------------------------------------- automations */

const UNIT_SECONDS: Readonly<Record<string, number>> = { minute: 60, hour: 3_600, day: 86_400, week: 604_800, month: 2_592_000 };

/** Runs of a schedule from "for 10 weeks" / "5 times" (only whole periods), or undefined. */
function runsOf(trigger: Input): number | undefined {
  if (num(trigger.maxRuns) !== undefined) return trigger.maxRuns as number;
  const forN = num(trigger.forN);
  if (forN === undefined) return undefined;
  if (trigger.forU === "time") return forN;
  const period = UNIT_SECONDS[String(trigger.unit)]! * (num(trigger.count) ?? 1);
  const total = UNIT_SECONDS[String(trigger.forU)]! * forN;
  if (total % period !== 0) throw unsupported(`"for ${forN} ${String(trigger.forU)}s" is not a whole number of runs every ${String(trigger.unit)}; say how many times.`);
  return total / period;
}

/** An account of the person's on `network` (EVM addresses work on every EVM network). */
function accountOn(accounts: readonly string[], network: NetworkKey): AccountId | null {
  const parsed = accounts.map((account) => parseAccountId(account)).filter((entry) => entry !== null);
  const exact = parsed.find((entry) => entry.chain.key === network);
  if (exact) return formatAccountId(network, exact.address);
  const family = parsed.find((entry) => entry.chain.vm === CHAINS[network].vm && CHAINS[network].vm === "evm");
  return family ? formatAccountId(network, family.address) : null;
}

function answerInvalid(message: string): PlatformError {
  return new PlatformError("ANSWER_INVALID", message, 422, [{ path: "answer", message }]);
}

/** EVM networks where the person has an account and a venue takes `asset` (the apy trigger compares EVM lending venues). */
function yieldNetworks(asset: string, accounts: readonly string[]): NetworkKey[] {
  const networks = YIELD_VENUES.filter((venue) => CHAINS[venue.network].vm === "evm" && CHAINS[venue.network].environment === "mainnet" &&
    venue.asset.toUpperCase() === asset && venueExecutes(venue, "deposit")).map((venue) => venue.network);
  return [...new Set(networks)].filter((network) => accountOn(accounts, network) !== null);
}

async function directionOf(trigger: Input, network: NetworkKey, facts: TurnFacts): Promise<"above" | "below" | null> {
  const asset = String(trigger.asset);
  let price = facts.usdPrice(network, asset);
  if (price === undefined && facts.pending) {
    await facts.read();
    price = facts.usdPrice(network, asset);
  }
  if (!price) return null;
  const line = Number(trigger.priceUsd);
  return line === price.usd ? null : line > price.usd ? "above" : "below";
}

async function decideAutomation(state: ThreadHandoff, env: HandoffEnv): Promise<HandoffOutcome> {
  const input = state.input as Input;
  const trigger = (input.trigger ?? {}) as Input;
  const assumptions: Assumption[] = [];
  if (trigger.kind === "best-yield") return decideBestYield(state, env, trigger);
  const inner = state.inner;
  if (!inner) throw unsupported("Say what each run should do.");
  // Native first (the protocol runs it without the person): a swap of an exact amount on a schedule with an end and
  // no weekday or time anchor is a DCA order; a take-profit sell of an exact amount is a limit order.
  const native = await nativeFirst(state, trigger, inner.text, env);
  if (native) return native;
  const reading = await env.inner(inner.text, inner.answers);
  if (reading.status === "needs_input") return ask(state, reading.questions.map(innerQuestion), [...reading.assumptions.map(innerChip)]);
  // A share of a holding is taken at each run: today's balance is not what a run spends.
  assumptions.push(...reading.assumptions.filter((entry) => !reading.relative || (entry.source !== "balance" && entry.source !== "position")).map(innerChip));
  if (reading.relative) assumptions.push(chip("share", "The share is of your balance at each run", "A run reads your balance when it fires and spends that share of it.", true));
  let direction = str(trigger.direction);
  if (trigger.kind === "price" && !direction) {
    if (input.direction) direction = String(input.direction);
    else {
      const derived = await directionOf(trigger, reading.network, env.facts);
      if (!derived) {
        return ask(state, [question("handoff.direction", "choice", "DIRECTION_MISSING", `When ${String(trigger.asset)} crosses ${String(trigger.priceUsd)} going up, or going down?`, "Kletia could not read the current price to tell.",
          [{ id: "above", label: `Rises above ${String(trigger.priceUsd)}`, value: {} }, { id: "below", label: `Drops below ${String(trigger.priceUsd)}`, value: {} }], false)], assumptions);
      }
      direction = derived;
      assumptions.push(chip("direction", `${derived === "above" ? "Rises above" : "Drops below"} ${String(trigger.priceUsd)}`, `${String(trigger.asset)} is ${derived === "above" ? "below" : "above"} ${String(trigger.priceUsd)} now, so it fires on the way ${derived === "above" ? "up" : "down"}.`, true, "price"));
    }
  }
  const text = reading.relative ? relativeText(inner.text, reading) : reading.sentence;
  if (input.wholeBalance && !input.confirmed) {
    return ask(state, [question("handoff.confirm", "confirm", "INTERPRETATION_CONFIRM", clip(`Each time ${String(trigger.asset)} arrives, plan "${text}"?`, 160),
      `A run cannot see how much arrived: it uses your whole ${String(trigger.asset)} balance on ${networkName(reading.network)}.`,
      [{ id: "confirm", label: "Yes, the whole balance", value: {} }, { id: "cancel", label: "No", value: {} }], false)], assumptions);
  }
  const problem = await env.runReadable(text);
  if (problem) throw unsupported(`Each run plans "${clip(text, 80)}" again without you, but ${problem}. Say it with an exact amount and network.`);
  const goal = goalTrigger(trigger, direction, reading.network, env);
  const planned = planAutomationFromGoal({ trigger: goal, action: { kind: "intent", text } }, { now: env.now, accounts: env.accounts as AccountId[] });
  if (!planned.ok) throw new PlatformError("AUTOMATION_DRAFT_INVALID", "The automation is invalid.", 400, planned.issues);
  assumptions.push(...triggerChips(trigger, planned.value.trigger, reading));
  assumptions.push(chip("execution", "Each run waits for your signature", "A run plans the sentence and puts it in your inbox; nothing moves until you sign."));
  return { status: "handoff", assumptions, state, handoff: { surface: "automations", input: { draft: planned.value }, summary: clip(automationSummary(trigger, direction, text), 160), execution: "signature" } };
}

/**
 * The native order a schedule or a take-profit stands for, or null (the automation stays): a swap of an exact
 * amount every period with an end and no anchor (DCA), or "if X rises above P sell N X" (a limit sell at P).
 */
async function nativeFirst(state: ThreadHandoff, trigger: Input, text: string, env: HandoffEnv): Promise<HandoffOutcome | null> {
  const swap = swapOfText(text);
  if (!swap) return null;
  const counter = swap.sell === undefined || swap.buy === undefined ? [chip("counter", swap.usd ? "Pays in USDC" : "Received in USDC", swap.usd ? "A dollar amount is paid in USDC." : "No token was named to receive: USDC.")] : [];
  const pair = { sell: swap.sell ?? "USDC", buy: swap.buy ?? "USDC", ...(swap.network ? { network: swap.network } : {}) };
  if (trigger.kind === "every") {
    const runs = runsOf(trigger);
    const anchored = trigger.weekday !== undefined || trigger.dayOfMonth !== undefined || trigger.at !== undefined;
    if (runs === undefined || runs < 2 || anchored || (num(trigger.count) ?? 1) !== 1) return null;
    return nativeOrNull({ surface: "orders", input: { action: "create", kind: "dca", ...pair, amount: usd(Number(swap.amount) * runs), period: trigger.unit, count: runs } }, env,
      [chip("native", "A native DCA order", `${swap.amount} ${pair.sell} each ${String(trigger.unit)} for ${runs} ${String(trigger.unit)}s: it runs without you after one signature.`, true), ...counter]);
  }
  if (trigger.kind === "price" && trigger.direction === "above" && !swap.usd && upper(pair.sell) === upper(trigger.asset) && ["USDC", "USD"].includes(upper(pair.buy))) {
    return nativeOrNull({ surface: "orders", input: { action: "create", kind: "limit", ...pair, buy: "USDC", amount: swap.amount, price: String(trigger.priceUsd) } }, env,
      [chip("native", "A native limit order", `It sells at ${String(trigger.priceUsd)} USDC or better without you, after one signature.`, true), ...counter]);
  }
  return null;
}

/** The native order for a run, or null when no order protocol serves the pair there (the automation stays). */
async function nativeOrNull(state: ThreadHandoff, env: HandoffEnv, chips: Assumption[]): Promise<HandoffOutcome | null> {
  try {
    return await decideOrders(state, env, chips);
  } catch (error) {
    if (isPlatformError(error) && (error.code === "ORDER_UNSUPPORTED" || error.code === "ORDER_INVALID")) return null;
    throw error;
  }
}

/**
 * "sell half of my SOL" keeps its words (a share of the balance at run time), with the token it receives and the
 * network the reading chose written out, so every run reads it exactly.
 */
function relativeText(text: string, reading: Extract<InnerReading, { status: "ready" }>): string {
  const receives = reading.receives && /^(?:sell|swap|convert|trade|dump)\s/iu.test(text) && !/\s(?:for|to|into)\s/iu.test(` ${text} `) ? ` for ${reading.receives}` : "";
  const named = new RegExp(`\\s(?:on|in)\\s+(?:${Object.keys(CHAINS).join("|")})\\b`, "iu").test(` ${text}`);
  return `${text}${receives}${named ? "" : ` on ${reading.network}`}`;
}

function goalTrigger(trigger: Input, direction: string | undefined, network: NetworkKey, env: HandoffEnv): AutomationGoalTrigger {
  const where = str(trigger.network) as NetworkKey | undefined ?? network;
  switch (trigger.kind) {
    case "every": {
      const runs = runsOf(trigger);
      return {
        kind: "every", unit: trigger.unit as "day", ...(num(trigger.count) ? { count: trigger.count as number } : {}), ...(trigger.weekday ? { weekday: trigger.weekday as "mon" } : {}),
        ...(num(trigger.dayOfMonth) ? { dayOfMonth: trigger.dayOfMonth as number } : {}), ...(str(trigger.at) ? { at: String(trigger.at) } : {}), ...(runs !== undefined ? { maxRuns: runs } : {}),
      };
    }
    case "price":
      return { kind: "price", asset: String(trigger.asset), network: where, direction: direction as "above", priceUsd: String(trigger.priceUsd) };
    case "balance":
    case "incoming": {
      const account = accountOn(env.accounts, where);
      if (!account) throw unsupported(`Kletia has no account of yours on ${networkName(where)} to watch.`);
      return trigger.kind === "balance"
        ? { kind: "balance", asset: String(trigger.asset), account, direction: trigger.direction as "above", amount: String(trigger.amount) }
        : { kind: "incoming", asset: String(trigger.asset), account };
    }
    default:
      throw unsupported("Kletia could not read when this should run.");
  }
}

function triggerChips(trigger: Input, planned: unknown, reading: Extract<InnerReading, { status: "ready" }>): Assumption[] {
  const out: Assumption[] = [];
  const schedule = planned as { kind: string; startAt?: string; maxRuns?: number };
  if (schedule.kind === "schedule" && schedule.startAt) {
    const start = schedule.startAt.replace("T", " ").slice(0, 16);
    out.push(chip("startAt", `First run ${start} UTC`, trigger.at ? "At the time you said, in UTC." : "Runs start at 09:00 UTC unless you say a time."));
    if (schedule.maxRuns === undefined && reading.swap && !reading.relative && CHAINS[reading.network].vm === "svm") {
      out.push(chip("native", "Runs as an automation", `Each run needs your signature. Add "for N ${String(trigger.unit)}s" to make it a Jupiter DCA order that runs without you.`));
    }
  }
  if (trigger.kind === "price") out.push(chip("oracle", `Price from the oracles on ${networkName(reading.network)}`, "Chainlink, Pyth or Jupiter readings the Rule Book trusts; a stale reading never fires.", false, "price"));
  if (trigger.kind === "price" && trigger.direction === "below") {
    out.push(chip("stop", "No native stop order", "Jupiter and CoW limit orders fill at or above their price, so a stop below the market runs as an automation you sign."));
  }
  if ((trigger.kind === "balance" || trigger.kind === "incoming") && !trigger.network) {
    out.push(chip("account", `Watches your ${networkName(reading.network)} account`, "Where the run's sentence spends from.", true));
  }
  return out;
}

const WEEKDAY_NAMES: Readonly<Record<string, string>> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

function automationSummary(trigger: Input, direction: string | undefined, text: string): string {
  switch (trigger.kind) {
    case "every": {
      const unit = trigger.weekday ? WEEKDAY_NAMES[String(trigger.weekday)] ?? String(trigger.weekday) : `${num(trigger.count) && trigger.count !== 1 ? `${String(trigger.count)} ` : ""}${String(trigger.unit)}${num(trigger.count) && trigger.count !== 1 ? "s" : ""}`;
      return `Every ${unit}: ${text}`;
    }
    case "price":
      return `When ${String(trigger.asset)} ${direction === "above" ? "rises above" : "drops below"} ${String(trigger.priceUsd)}: ${text}`;
    case "balance":
      return `When your ${String(trigger.asset)} balance goes ${String(trigger.direction)} ${String(trigger.amount)}: ${text}`;
    default:
      return `When ${String(trigger.asset)} arrives: ${text}`;
  }
}

function decideBestYield(state: ThreadHandoff, env: HandoffEnv, trigger: Input): HandoffOutcome {
  const asset = String(trigger.asset);
  const said = Array.isArray(trigger.networks) ? (trigger.networks as NetworkKey[]).filter(Boolean) : [];
  const networks = said.length > 0 ? said : yieldNetworks(asset, env.accounts);
  if (networks.length === 0) throw unsupported(`No EVM lending venue Kletia runs takes ${asset} on a network you have an account on.`);
  const input = state.input as Input;
  if (input.amount === undefined) {
    return ask(state, [question("handoff.amount", "amount", "AMOUNT_MISSING", `How much ${asset} should go in first, if none is deposited yet?`, "Later runs move whatever is deposited to the best venue.",
      [{ id: "none", label: "Only what is already deposited", value: {} }], true, `Amount in ${asset}`)], []);
  }
  const amount = input.amount === "none" ? undefined : String(input.amount);
  const planned = planAutomationFromGoal({ trigger: { kind: "best-yield", asset, networks }, action: { kind: "rebalance", ...(amount ? { amount } : {}) } }, { now: env.now, accounts: env.accounts as AccountId[] });
  if (!planned.ok) throw new PlatformError("AUTOMATION_DRAFT_INVALID", "The automation is invalid.", 400, planned.issues);
  const assumptions = [
    ...(said.length === 0 ? [chip("networks", `Compares ${networks.map(networkName).join(", ")}`, `Networks where you have an account and a lending venue takes ${asset}.`, true)] : []),
    chip("minDelta", "Moves at 0.5% better", "A run fires when the best venue pays at least 0.50% a year more than the current one."),
    chip("execution", "Each move waits for your signature", "A run plans the withdrawal, any bridge and the deposit, then waits in your inbox."),
  ];
  return {
    status: "handoff", assumptions, state,
    handoff: { surface: "automations", input: { draft: planned.value }, summary: `Keep ${asset} in the best yield on ${networks.map(networkName).join(", ")}`, execution: "signature" },
  };
}

/** The intent reader's question, asked here (its id and field carry the hand-off prefix). */
function innerQuestion(q: Question): Question {
  return { ...q, id: `q.handoff.${q.id.slice(2)}`.slice(0, 96), field: `handoff.action` };
}

function innerChip(a: Assumption): Assumption {
  return { ...a, id: `a.handoff.${a.id.slice(2)}`.slice(0, 96), field: "handoff.action", alternatives: [] };
}

/* ------------------------------------------------------------------- entry */

/** Decides a hand-off state (a new reading or a thread's). */
export async function decideHandoff(state: ThreadHandoff, env: HandoffEnv): Promise<HandoffOutcome> {
  switch (state.surface) {
    case "perps":
      return decidePerps(state, env);
    case "orders":
      return decideOrders(state, env);
    default:
      return decideAutomation(state, env);
  }
}

/**
 * Applies an answer to an open hand-off question: a field of the input, or a
 * question of the run's sentence (kept with the answers replayed every turn).
 */
export function answerHandoff(state: ThreadHandoff, answer: { readonly question: string; readonly option?: string; readonly text?: string }): ThreadHandoff {
  const id = answer.question;
  if (id.startsWith("q.handoff.") && !/^q\.handoff\.[a-zA-Z]+$/u.test(id)) {
    const inner = state.inner;
    if (!inner || inner.answers.length >= 4) throw answerInvalid("That question is not open.");
    const original = `q.${id.slice("q.handoff.".length)}`;
    return { ...state, inner: { ...inner, answers: [...inner.answers, { question: original, ...(answer.option ? { option: answer.option } : {}), ...(answer.text ? { text: answer.text.slice(0, 200) } : {}) }] } };
  }
  const field = id.replace(/^q\.handoff\./u, "");
  const input = state.input as Input;
  if (field === "confirm") {
    if (answer.option !== "confirm") throw new PlatformError("INTENT_UNSUPPORTED", "Not set up. Say what each run should do with an exact amount instead.", 422);
    return { ...state, input: { ...input, confirmed: true } };
  }
  if (field === "direction") {
    if (answer.option !== "above" && answer.option !== "below") throw answerInvalid("Choose above or below.");
    return { ...state, input: { ...input, direction: answer.option } };
  }
  if (field === "amount") {
    if (answer.option === "none") return { ...state, input: { ...input, amount: "none" } };
    const match = /^\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s+[a-z]+)?$/iu.exec((answer.text ?? "").trim());
    if (!match) throw answerInvalid("Say an amount, e.g. 100.");
    return { ...state, input: { ...input, amount: decimalOf(match[1] as string) } };
  }
  return { ...state, input: state.surface === "perps" ? answerPerps(input, field, answer.option, answer.text) : answerOrders(input, field, answer.option, answer.text) };
}
