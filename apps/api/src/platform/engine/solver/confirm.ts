/**
 * Confirm mechanics (I14): every confirm-class outcome is a question about the
 * solved, concrete plan of the whole message, and the thread keeps only the
 * digest of the end state the person accepted (`thread.confirmDigest`, no
 * words). A later turn whose plan has another end state (an asset, an amount, a
 * recipient, a network, a venue or any choice the person made on an earlier
 * acknowledgement) is asked again.
 *
 * One digest covers every acknowledgement of a message, in a fixed order
 * (`Ack[]`): a question settled with choice c1 stores digest(plan, [c1]); the
 * next one, settled with c2, stores digest(plan, [c1, c2]). `settledAcks`
 * finds the longest settled prefix by trying every combination of choices
 * (at most a few: each acknowledgement has one to three choices).
 *
 * Pure: every function reads only its arguments.
 */
import { createHash } from "node:crypto";
import { CHAINS, type NetworkKey } from "@kletia/core";
import { networkName, protocolLabel, stakeProvider } from "../clarify/catalog.js";
import { clip, short } from "../clarify/copy.js";
import type { ResolvedAction } from "../clarify/types.js";

/** One acknowledgement a plan needs before it is ready, with the choices that settle it (their ids enter the digest). */
export interface Ack {
  /** "delivery", "gas:base", "confirm", ... (stable within a plan). */
  readonly id: string;
  /** Choice ids, in option order. */
  readonly choices: readonly string[];
}

/** The end state of resolved actions, normalised (assets upper case, recipients lower case for names and EVM). */
function normalised(actions: readonly ResolvedAction[]): unknown[] {
  return actions.map((action) => [
    action.kind,
    action.network,
    action.toNetwork ?? "",
    action.from.toUpperCase(),
    (action.to ?? "").toUpperCase(),
    action.amount,
    action.portionBps ?? 10_000,
    action.recipient ? (/^0x|\.(?:eth|sns|sol)$/iu.test(action.recipient) ? action.recipient.toLowerCase() : action.recipient) : "",
    action.protocol ?? "",
    action.vault ?? "",
    action.provider ?? "",
    action.contract ?? "",
    action.entry ?? "",
    (action as { receiveExact?: true }).receiveExact === true ? 1 : 0,
  ]);
}

/**
 * "sha256:<hex>" of the plan's end state and the choices made on its
 * acknowledgements, plus the departure the caller set (it decides where the
 * money starts).
 */
export function endStateDigest(actions: readonly ResolvedAction[], choices: readonly string[], context: { readonly sourceNetwork?: string; readonly gasOnArrival?: Readonly<Record<string, string>> } = {}): string {
  const body = JSON.stringify({
    v: 1,
    actions: normalised(actions),
    choices,
    source: context.sourceNetwork ?? "",
    gas: Object.entries(context.gasOnArrival ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  });
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/** The choice ids of every settled acknowledgement (a prefix of `acks`), given the stored digest. */
export function settledAcks(stored: string | undefined, acks: readonly Ack[], digest: (choices: readonly string[]) => string): string[] {
  if (!stored || acks.length === 0) return [];
  // Longest prefix first: a later acknowledgement includes every earlier choice.
  for (let length = acks.length; length >= 1; length -= 1) {
    const found = search(acks.slice(0, length), [], (choices) => digest(choices) === stored);
    if (found) return found;
  }
  return [];
}

function search(acks: readonly Ack[], prefix: string[], hit: (choices: readonly string[]) => boolean): string[] | null {
  if (acks.length === 0) return hit(prefix) ? prefix : null;
  const [first, ...rest] = acks as [Ack, ...Ack[]];
  for (const choice of first.choices) {
    const found = search(rest, [...prefix, choice], hit);
    if (found) return found;
  }
  return null;
}

/* ---------------------------------------------------------------- copy */

const amountText = (action: ResolvedAction, index: number): string => {
  if (action.amount === "max") {
    if (index > 0 && action.kind !== "withdraw") return action.portionBps && action.portionBps !== 10_000 ? `${action.portionBps / 100}% of it` : "it";
    return `all ${action.from}`;
  }
  return action.amount ? `${action.amount} ${action.from}` : action.from;
};

/** One step in Kletia's words, with full recipients and both networks ("Bridge 100 USDC from Solana to Base"). */
export function describeAction(action: ResolvedAction, index: number): string {
  const what = amountText(action, index);
  const on = networkName(action.network);
  switch (action.kind) {
    case "swap":
      return `swap ${what} to ${action.to ?? "?"} on ${on}${action.protocol ? ` via ${protocolLabel(action.protocol)}` : ""}`;
    case "bridge":
      return `bridge ${what} from ${on} to ${networkName(action.toNetwork as NetworkKey)}${action.to && action.to.toUpperCase() !== action.from.toUpperCase() ? ` as ${action.to}` : ""}` +
        `${action.recipient ? ` and pay ${action.recipient} there` : ""}`;
    case "transfer":
      return `send ${what} to ${action.recipient ?? "?"} on ${on}`;
    case "stake": {
      const provider = stakeProvider(action.provider);
      return `stake ${what} with ${provider?.grammarProvider ?? action.provider ?? "a staking provider"}${provider ? ` for ${provider.symbol}` : ""}`;
    }
    case "deposit":
      return `deposit ${what} into ${action.protocol ? protocolLabel(action.protocol) : "a venue"} on ${on}`;
    case "withdraw":
      return `withdraw ${action.amount === "max" ? `all ${action.from}` : what} from ${action.protocol ? protocolLabel(action.protocol) : "the venue"} on ${on}`;
    default:
      return `${action.verb ?? action.kind} ${what} ${action.alias ? `with ${action.alias} ` : ""}on ${on}`.replace(/\s+/gu, " ").trim();
  }
}

/** The solved plan in one line ("Swap 1 SOL to USDC on Solana, then bridge it from Solana to Base, then ..."). */
export function planSummary(actions: readonly ResolvedAction[]): string {
  const text = actions.map((action, index) => describeAction(action, index)).join(", then ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A short form of a recipient for labels only (prompts carry the full one). */
export function recipientLabel(recipient: string): string {
  return /^0x[0-9a-fA-F]{40}$/u.test(recipient) || recipient.length > 32 ? short(recipient) : recipient;
}

/** The confirm prompt: the full plan when it fits, else a count with the plan in the option's sentence. */
export function confirmPrompt(actions: readonly ResolvedAction[], lead: string): string {
  const plan = planSummary(actions);
  const full = `${lead}${plan}.`;
  if (full.length <= 160) return full;
  return clip(`${lead}${actions.length} steps: ${plan}`, 160);
}

/** The native gas asset of a network ("ETH", "SOL", "POL"). */
export function gasSymbol(network: NetworkKey): string {
  return CHAINS[network].nativeAsset.symbol;
}
