/**
 * Ready-time invariants (intent design A.4) and the grounding ledger: before a
 * thread may be `ready`, every resolved action is checked against what the
 * person said. The decision layer's rules make these hold by construction;
 * this is the independent check that fails closed when one of them does not
 * (a refusal, never a plan): a missing invariant is an internal error.
 *
 *   1  grounding           every step has a kind and its values; a model-assisted reading was confirmed
 *   2  network continuity  a step that spends the previous output runs where that output lands
 *   3  recipient fidelity  every recipient said is paid, and only those
 *   4  verb fidelity       the verb said is compatible with the step kind
 *   5  venue fidelity      a named venue or provider is on its step
 *   8  address family      a raw address is paid only on a network of its family
 *   10 no round trip       funds never return to a network they left, unless the person answered
 *   13 third-party value   a payment to someone else has a stated, answered or confirmed amount and
 *                          a receiving network that was said, implied or answered (never a chip)
 *   16 closed-class words  every word of the clause's closed-class record was consumed by a rule
 *   17 model limits        a model-assisted reading never pays anyone, calls a contract or spends a
 *                          whole holding out of the wallet
 *
 * Invariants 6, 7, 9, 11, 12 and 14 are decided in the policy (questions), 15 by the confirm digest.
 * Pure: every function reads only its arguments.
 */
import { isEvmAddress, isSolanaAddress, CHAINS, type NetworkKey } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import type { ResolvedAction, WorkStep } from "../clarify/types.js";

/** What the policy knows about one resolved action. */
export interface ActionMeta {
  /** The expanded step it was resolved from (null: a crossing leg the decision layer inserted). */
  readonly step: number | null;
  /** The step is a goal step's expansion (the solver checked its own fidelity). */
  readonly goal?: boolean;
  /** For a goal step's expansion: the thread step (the Goal) it came from. */
  readonly goalStep?: number;
  /** A crossing leg inserted for a step on another network (C.1 rule 2). */
  readonly crossing?: true;
  /** A payment that became one bridge leg paying the recipient on its network (C.1 rule 4). */
  readonly crossingPayment?: true;
}

export interface InvariantInput {
  readonly actions: readonly ResolvedAction[];
  readonly meta: readonly ActionMeta[];
  /** The expanded steps (indices as in `meta.step`). */
  readonly steps: readonly WorkStep[];
  /** Recipients the person said (addresses and names), lower case for EVM and names. */
  readonly saidRecipients: readonly string[];
  /** True when the action pays someone other than the person. */
  readonly thirdParty: (action: ResolvedAction) => boolean;
  /** The person confirmed the solved plan (the confirm digest matched). */
  readonly confirmed: boolean;
}

export interface Violation {
  readonly invariant: number;
  readonly action: number;
  readonly message: string;
}

const recipientKey = (value: string): string => (/^0x|\.(?:eth|sns|sol)$/iu.test(value) ? value.toLowerCase() : value);

/** Where an action's output lands. */
export function destinationOf(action: ResolvedAction): NetworkKey {
  return action.kind === "bridge" && action.toNetwork ? action.toNetwork : action.network;
}

/** True for an action that spends the previous action's output (the canonical sentence's "it"). */
export function spendsPrevious(action: ResolvedAction, index: number): boolean {
  return index > 0 && action.amount === "max" && action.kind !== "withdraw";
}

const KIND_FITS: Readonly<Record<string, readonly string[]>> = {
  swap: ["swap"],
  bridge: ["bridge"],
  transfer: ["transfer", "bridge"],
  deposit: ["deposit"],
  withdraw: ["withdraw"],
  stake: ["stake"],
  call: ["call", "action", "deposit", "withdraw", "swap", "stake"],
  action: ["call", "action", "deposit", "withdraw", "swap", "stake", "transfer"],
};

function llmRead(step: WorkStep | undefined): boolean {
  return step?.modelRead === true || step?.goal?.confidence === "llm";
}

/** Every violated invariant (empty: the plan may be ready). */
export function readyViolations(input: InvariantInput): Violation[] {
  const { actions, meta, steps } = input;
  const out: Violation[] = [];
  const fail = (invariant: number, action: number, message: string) => out.push({ invariant, action, message });
  const paid = new Set<string>();
  // The networks the funds of the current dependent chain have visited, in order.
  let path: NetworkKey[] = [];
  actions.forEach((action, index) => {
    const info = meta[index] ?? { step: null };
    const step = info.step === null ? undefined : steps[info.step];
    // 1 grounding
    if (!action.kind || !action.network) fail(1, index, "a step has no kind or network");
    if (!action.contract && action.kind !== "call" && action.kind !== "action" && (!action.from || action.amount === "")) fail(1, index, "a step has no asset or amount");
    if (llmRead(step) && !input.confirmed) fail(1, index, "a model-assisted reading was not confirmed");
    // 2 network continuity
    const previous = actions[index - 1];
    if (previous && spendsPrevious(action, index) && destinationOf(previous) !== action.network) {
      fail(2, index, `step ${index + 1} spends the previous output on another network`);
    }
    // 10 no round trip (a crossing back to a network the same funds left)
    if (spendsPrevious(action, index)) {
      if (action.kind === "bridge" && action.toNetwork && path.slice(0, -1).includes(action.toNetwork) && step?.network?.by !== "answer" && step?.toNetwork?.by !== "answer") {
        fail(10, index, `the funds return to ${CHAINS[action.toNetwork].name}`);
      }
    } else path = [action.network];
    if (path[path.length - 1] !== destinationOf(action)) path.push(destinationOf(action));
    // 3 recipients paid
    if (action.recipient) paid.add(recipientKey(action.recipient));
    // 4 verb fidelity, 5 venue fidelity (strict steps; goal steps are the solver's)
    if (step && !info.goal && !info.crossing) {
      const said = step.kind?.v;
      if (said && step.kind?.by === "user" && !(KIND_FITS[said] ?? [said]).includes(action.kind)) fail(4, index, `"${said}" became a ${action.kind}`);
      if (step.protocol?.by === "user" && action.kind !== "stake" && action.protocol && step.protocol.v !== action.protocol && !step.protocol.v.includes(" ")) {
        fail(5, index, "a named venue is not on its step");
      }
      if (step.provider?.by === "user" && action.kind === "stake" && action.provider && step.provider.v !== action.provider) fail(5, index, "a named provider is not on its step");
    }
    // 8 address family
    const receiving = action.kind === "bridge" ? action.toNetwork : action.network;
    if (action.recipient && receiving) {
      const evm = CHAINS[receiving].vm === "evm";
      if ((isEvmAddress(action.recipient) && !evm) || (isSolanaAddress(action.recipient) && evm)) fail(8, index, "a raw address is paid on another network family");
    }
    // 13 third-party value
    if (input.thirdParty(action) && step && !info.goal) {
      const amount = step.amount;
      if (amount && amount.v.t === "balance" && amount.by !== "answer" && !input.confirmed) fail(13, index, "a whole holding is paid to someone else without a confirm");
      const net = action.kind === "bridge" ? step.toNetwork ?? step.network : step.network;
      if (net?.by === "assumed" && !info.crossingPayment) fail(13, index, "the receiving network of a payment was assumed");
    }
    // 16 closed-class words
    const record = step?.closedClass;
    if (record) {
      const rules = new Set<string>();
      for (const key of ["kind", "amount", "from", "to", "network", "toNetwork", "recipient", "protocol", "vault", "provider", "fundFrom"] as const) {
        const rule = (step[key] as { prov?: { rule?: string } } | undefined)?.prov?.rule;
        if (rule) rules.add(rule);
      }
      for (const entry of step.readAs ?? []) rules.add(entry.rule);
      for (const hit of record.hits) {
        if (hit.category === "question" && step.questionForm) continue;
        if (hit.category === "network" || !hit.rules.some((rule) => rules.has(rule))) fail(16, index, `"${hit.phrase}" was not consumed by a rule`);
      }
    }
    // 17 model limits
    if (llmRead(step)) {
      if (input.thirdParty(action)) fail(17, index, "a model-assisted reading pays someone else");
      if (action.contract || action.kind === "call" || action.kind === "action") fail(17, index, "a model-assisted reading calls a contract");
      const whole = step?.amount?.v.t === "balance" && step.amount.v.bps === 10_000;
      if (whole && (action.kind === "deposit" || action.kind === "transfer" || action.recipient)) fail(17, index, "a model-assisted reading spends a whole holding out of the wallet");
    }
  });
  // 3 recipient fidelity
  const said = new Set(input.saidRecipients.map(recipientKey));
  for (const recipient of said) if (!paid.has(recipient)) fail(3, -1, `${recipient} is said but not paid`);
  for (const recipient of paid) if (!said.has(recipient)) fail(3, -1, `${recipient} is paid but was not said`);
  return out;
}

/** The refusal for a violated invariant: fail closed, never a plan Kletia cannot trace to the person's words. */
export function invariantRefusal(violations: readonly Violation[]): PlatformError {
  const first = violations[0] as Violation;
  return new PlatformError(
    "INTENT_UNSUPPORTED",
    "Kletia could not match this plan to your words, so it plans nothing. Rewrite it with the asset, amount, network and any recipient, one step at a time.",
    422,
    violations.slice(0, 4).map((entry) => ({ path: entry.action >= 0 ? `actions[${entry.action}]` : "text", message: `Invariant ${entry.invariant}: ${entry.message}.` })),
    undefined,
    { invariants: [...new Set(violations.map((entry) => entry.invariant))] },
  );
}

/* ------------------------------------------------- 14: look-alike exactness */

/** What Kletia lists in place of an unlisted family member (the listed token is a different one). */
const LISTED_FOR: Readonly<Record<string, string>> = {
  STETH: "wstETH (wrapped stETH, about 1.2 stETH each)",
  EETH: "weETH (wrapped eETH, worth more than 1 eETH each)",
  FRXETH: "sfrxETH (staked frxETH, worth more than 1 frxETH each)",
  USDCE: "USDC (the native token, not bridged USDC.e)",
  BSOL: "JitoSOL, mSOL and JupSOL",
  STSOL: "JitoSOL, mSOL and JupSOL",
};

const plainSymbol = (value: string) => value.toUpperCase().replace(/[\s.-]/gu, "");

/**
 * A.4.14 over the text itself: typed words that name a member of a
 * look-alike family Kletia does not list (stETH, eETH, frxETH, stSOL,
 * USDC.e), in their usual spelling. Each must be asked (ASSET_LOOKALIKE) or
 * refused, never read as another member by any path (a provider word, a
 * typo, a model reading).
 */
export function unlistedLookalikes(text: string, families: readonly { readonly members: readonly string[] }[], isListed: (symbol: string) => boolean): { typed: string; listed: string }[] {
  const unlisted = new Map<string, string>();
  for (const family of families) {
    for (const member of family.members) if (!/\s/u.test(member) && !isListed(member)) unlisted.set(plainSymbol(member), member);
  }
  const out: { typed: string; listed: string }[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9.$-]+/u)) {
    const token = raw.replace(/^\$/u, "").replace(/[.-]+$/u, "");
    if (!token) continue;
    const member = unlisted.get(plainSymbol(token));
    if (member && !out.some((entry) => entry.typed === member)) out.push({ typed: member, listed: LISTED_FOR[plainSymbol(member)] ?? "the listed members of its family" });
  }
  return out;
}

/** The refusal when an unlisted look-alike was typed and nothing asked about it. */
export function lookalikeRefusal(found: { typed: string; listed: string }): PlatformError {
  return new PlatformError(
    "INTENT_UNSUPPORTED",
    `Kletia does not list ${found.typed}. It lists ${found.listed}, a different token. Say the token Kletia lists, and Kletia plans exactly that.`,
    422,
    [{ path: "text", message: `${found.typed} is not a token Kletia lists.` }],
    undefined,
    { lookalike: found.typed },
  );
}
