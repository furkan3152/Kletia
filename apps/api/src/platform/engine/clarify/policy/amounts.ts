/**
 * Amount and recipient questions.
 */
import {
  CHAINS,
  evmChecksumState,
  findAssetBySymbol,
  NATIVE_FEE_RESERVE,
  type NetworkKey,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import {
  decimalsOf,
  EVM_NETWORKS,
  family,
  isName,
  lane,
  networkName,
  recipientFamily,
  USD_ORDER,
} from "../catalog.js";
import { assumption, clip, placeholderFor, question, short } from "../copy.js";
import { priceAmount } from "../../solver/decide.js";
import {
  cmp,
  formatDecimal,
  isDecimal,
  isPositive,
  parseDecimal,
  portion,
  tidy,
} from "../decimal.js";
import { field } from "../edits.js";
import type { Assumption, Option, Question, WorkStep } from "../types.js";
import {
  amountPhrase,
  type Env,
  held,
  keptHere,
  networkOption,
  spendable,
  swapCandidates,
  symbolOnNetwork,
} from "./env.js";

/* ------------------------------------------------------------- amounts */

/** R6: how much, with balance shortcuts when known. */
export function amountQuestion(env: Env, index: number, step: WorkStep, network: NetworkKey, from: string): Question {
  const path = field(index, "amount");
  const decimals = decimalsOf(network, from);
  const options: Option[] = [];
  if (step.kind?.v === "withdraw") {
    const position = env.facts.position(network, step.protocol?.v ?? "", from);
    options.push({ id: "all", label: position && isPositive(position) ? `All · ${tidy(position, decimals)} ${from}` : "All", detail: "Closes the position", value: { amount: { t: "position", bps: 10_000 } } });
    if (position !== undefined && isPositive(position)) {
      options.push({ id: "half", label: `Half · ${formatDecimal(portion(position, 5_000), decimals)} ${from}`, value: { amount: { t: "position", bps: 5_000 } } });
    } else {
      options.push({ id: "half", label: "Half", detail: "Half of the position", value: { amount: { t: "position", bps: 5_000 } } });
    }
    return question(path, "amount", "AMOUNT_MISSING", `How much ${from} should come out?`, position !== undefined ? `Your position is ${tidy(position, decimals)} ${from}.` : "Say an amount, or all.", options, true, placeholderFor("amount", from));
  }
  const all = spendable(env, network, from, 10_000);
  if (all !== undefined && all > 0n) {
    const native = CHAINS[network].nativeAsset.symbol === from;
    options.push({ id: "all", label: `All · ${formatDecimal(all, decimals)} ${from}`, ...(native ? { detail: `Keeps ${NATIVE_FEE_RESERVE[network]} ${from} for network fees` } : {}), value: { amount: { t: "balance", bps: 10_000 } } });
    options.push({ id: "half", label: `Half · ${formatDecimal(spendable(env, network, from, 5_000) as bigint, decimals)} ${from}`, value: { amount: { t: "balance", bps: 5_000 } } });
  }
  const shown = held(env, network, from);
  return question(path, "amount", "AMOUNT_MISSING", `How much ${from}?`, shown !== undefined ? `You hold ${shown} ${from} on ${networkName(network)}.` : "Say an amount, or all / half of your balance.", options, true, placeholderFor("amount", from));
}

/** R12: a second question only when it cannot change the first one's options. */
export function withIndependent(env: Env, index: number, step: WorkStep, first: Question): Question[] {
  if (step.amount || (!step.from && !step.usdFrom) || step.contract) return [first];
  let network: NetworkKey | undefined;
  if (first.reason === "RECIPIENT_MISSING" && step.network && step.network.by !== "assumed") network = step.network.v;
  if (first.reason === "DESTINATION_MISSING" && step.network) network = step.network.v;
  if (first.reason === "OUTPUT_ASSET_MISSING") {
    const networks = step.network ? [step.network.v] : swapCandidates(env, step, step.from?.v, undefined);
    if (networks.length === 1) network = networks[0];
  }
  if (!network) return [first];
  const from = symbolOnNetwork(env, network, step.from?.v, step.usdFrom);
  if (!from) return [first];
  return [first, amountQuestion(env, index, step, network, from)];
}

export interface AmountChoice {
  amount?: string;
  portionBps?: number;
  question?: Question;
  assumption?: Assumption;
}

/** R6: amounts. */
export function resolveAmount(env: Env, index: number, step: WorkStep, network: NetworkKey, from: string): AmountChoice {
  const path = field(index, "amount");
  const amount = step.amount?.v;
  const decimals = decimalsOf(network, from);
  if (!amount) return { question: amountQuestion(env, index, step, network, from) };
  const keep = step.keep && step.keep.length > 0 ? keptHere(step, network, from) : "0";
  if (keep === null) {
    return { question: question(path, "amount", "AMOUNT_MISSING", `How much ${from} should this use?`, "Kletia could not apply what you keep back to this step; say the exact amount to use.", [], true, placeholderFor("amount", from)) };
  }
  if (amount.t === "exact" && isPositive(keep) && step.amount?.by === "user") {
    // An exact amount plus what is kept back must fit the balance: otherwise the person chooses.
    const balance = env.facts.balance(network, from);
    if (balance !== undefined && isDecimal(amount.value) && parseDecimal(balance) < parseDecimal(amount.value) + parseDecimal(keep)) {
      const left = spendable(env, network, from, 10_000, keep) ?? 0n;
      const options: Option[] = left > 0n ? [{ id: "rest", label: clip(`All but ${tidy(keep)} · ${formatDecimal(left, decimals)} ${from}`, 48), value: { amount: { t: "exact", value: formatDecimal(left, decimals) } } }] : [];
      options.push({ id: "cancel", label: "Neither, cancel", value: { target: "cancel" } });
      return {
        question: question(path, "choice", "AMOUNT_EXCEEDS_BALANCE", `${amount.value} ${from} and the ${tidy(keep)} ${from} you keep are more than you hold on ${networkName(network)}. How much should this use?`,
          `You hold ${held(env, network, from) ?? tidy(balance)} ${from} there.`, options, true, placeholderFor("amount", from)),
      };
    }
  }
  if (amount.t === "exact") {
    if (step.usdFrom && !USD_ORDER.includes(from.toUpperCase())) {
      return { question: question(path, "amount", "AMOUNT_MISSING", `How much ${from}?`, "A $ amount is paid in a USD stablecoin; say the amount in the token instead.", [], true, placeholderFor("amount", from)) };
    }
    // "1.000" or "2.500" as typed has two readings (a decimal point, or a thousands separator): always asked,
    // never read as one of them, the person's own funds or a payment alike. The answer is the person's.
    const dotted = (amount.raw ?? amount.value).trim();
    if (step.amount?.by === "user" && /^[1-9]\d{0,2}(?:\.\d{3})+$/u.test(dotted)) {
      const decimal = /^\d+\.\d{3}$/u.test(dotted) ? dotted.replace(/\.?0+$/u, "") : null;
      const whole = dotted.replace(/\./gu, "");
      const grouped = whole.replace(/\B(?=(\d{3})+$)/gu, ",");
      return {
        question: question(path, "choice", "AMOUNT_FORMAT_AMBIGUOUS", `Did you mean ${decimal ? `${decimal} ${from} or ` : ""}${grouped} ${from}?`,
          "The dot can be a decimal point or a thousands separator. Kletia never guesses an amount.", [
            ...(decimal ? [{ id: "decimal", label: `${decimal} ${from}`, detail: "The dot as a decimal point", value: { amount: { t: "exact" as const, value: decimal } } }] : []),
            { id: "thousands", label: `${grouped} ${from}`, detail: "The dot as a thousands separator", value: { amount: { t: "exact" as const, value: whole } } },
            { id: "cancel", label: "Neither, cancel", value: { target: "cancel" } },
          ], true, placeholderFor("amount", from)),
      };
    }
    if (amount.raw && /^\d{1,3},\d{3}$/u.test(amount.raw) && step.amount?.by === "user") {
      const decimal = formatDecimal(parseDecimal(amount.raw.replace(",", ".")), decimals);
      const balance = env.facts.balance(network, from);
      if (balance !== undefined && cmp(balance, amount.value) < 0 && cmp(balance, decimal) >= 0) {
        return {
          question: question(path, "choice", "AMOUNT_FORMAT_AMBIGUOUS", `Did you mean ${decimal} ${from} or ${amount.raw} ${from}?`, `You hold ${tidy(balance)} ${from}, which covers only ${decimal}.`, [
            { id: "decimal", label: `${decimal} ${from}`, detail: "The comma as a decimal point", value: { amount: { t: "exact", value: decimal } }, recommended: true },
            { id: "thousands", label: `${amount.raw} ${from}`, detail: "The comma as a thousands separator", value: { amount: { t: "exact", value: amount.value } } },
          ], false),
        };
      }
    }
    return { amount: amount.value };
  }
  if (amount.t === "previous") {
    if (index === 0) return { question: question(path, "amount", "AMOUNT_MISSING", `How much ${from}?`, "\"it\" refers to a previous step.", [], true, placeholderFor("amount", from)) };
    return { amount: "max", ...(amount.bps !== 10_000 ? { portionBps: amount.bps } : {}) };
  }
  if (amount.t === "position") {
    if (amount.bps === 10_000) return { amount: "max" };
    const position = env.facts.position(network, step.protocol?.v ?? "", from);
    if (position === undefined) return { question: question(path, "amount", "AMOUNT_BALANCE_UNKNOWN", `How much ${from} should come out?`, "Kletia could not read your position; say an exact amount.", [], true, placeholderFor("amount", from)) };
    const value = formatDecimal(portion(position, amount.bps), decimals);
    return { amount: value, assumption: assumption(path, `${amount.bps / 100}% of your position: ${value} ${from}`, { amount }, "position", `Your position is ${tidy(position)} ${from}.`, [], true) };
  }
  if (amount.t === "usd") {
    // D11: a stablecoin counts at par; another token is priced (chip with the price), or asked without a usable price.
    if (USD_ORDER.includes(from.toUpperCase()) || findAssetBySymbol(network, from)?.category === "stablecoin") return { amount: amount.value };
    const price = env.facts.usdPrice?.(network, from);
    const asset = findAssetBySymbol(network, from);
    const priced = price && asset
      ? priceAmount({ index, usd: amount.value, symbol: from, decimals, price: { asset: asset.id, usd: price.usd, source: price.source as never, at: price.at, readAt: price.at, stale: false } })
      : null;
    if (!priced) {
      return { question: question(path, "amount", "AMOUNT_MISSING", `How much ${from}?`, `Kletia could not price ${from} right now; say the amount in ${from}.`, [], true, placeholderFor("amount", from)) };
    }
    return { amount: priced.value, assumption: { ...priced.assumption, source: "price" } };
  }
  const value = spendable(env, network, from, amount.bps, keep);
  if (value === undefined) return { question: question(path, "amount", "AMOUNT_BALANCE_UNKNOWN", `How much ${from}?`, "Kletia cannot read your balance; say an exact amount.", [], true, placeholderFor("amount", from)) };
  if (value <= 0n) {
    throw new PlatformError("AMOUNT_TOO_SMALL", isPositive(keep)
      ? `After the ${tidy(keep)} ${from} you keep, your ${from} on ${networkName(network)} leaves nothing to spend.`
      : `Your ${from} balance on ${networkName(network)} is too small to spend.`, 422, [{ path, message: "Balance too small." }]);
  }
  const formatted = formatDecimal(value, decimals);
  const native = CHAINS[network].nativeAsset.symbol === from;
  const kept = isPositive(keep) ? ` after keeping ${tidy(keep)}` : "";
  const label = amount.bps === 10_000 ? `All your ${from}${kept}: ${formatted}` : `${amount.bps / 100}% of your ${from}${kept}: ${formatted}`;
  return {
    amount: formatted,
    assumption: assumption(path, label, { amount }, "balance", `You hold ${held(env, network, from)} ${from} on ${networkName(network)}${isPositive(keep) ? `; ${tidy(keep)} ${from} stays as you asked` : ""}${native ? `; ${NATIVE_FEE_RESERVE[network]} ${from} stays for network fees` : ""}.`, [], true),
  };
}

/* ---------------------------------------------------------- recipients */

/** R8: recipients are asked, never assumed, completed or corrected. */
export function recipientQuestion(env: Env, index: number, step: WorkStep): Question | null {
  const path = field(index, "recipient");
  const what = amountPhrase(step);
  const solana = step.network ? family(step.network.v) === "solana" : false;
  const placeholder = placeholderFor("address", undefined, solana);
  if (!step.recipient && step.nickname) {
    return question(path, "address", "RECIPIENT_MISSING", `Who should receive ${what}? Enter their address or full name (for example name.eth).`, "Kletia never guesses a recipient from a nickname.", [], true, placeholder);
  }
  if (!step.recipient) return question(path, "address", "RECIPIENT_MISSING", `Who should receive ${what}?`, "Enter an address or a name such as name.eth, name.base.eth or name.sns.", [], true, placeholder);
  const recipient = step.recipient.v;
  if (/^0x[0-9a-fA-F]{40}$/u.test(recipient) && evmChecksumState(recipient) === "invalid") {
    return question(path, "address", "RECIPIENT_CHECKSUM", `The capital letters in ${short(recipient)} do not match its checksum. Check the address and enter it again.`, "A checksum mismatch usually means a mistyped character. Kletia never corrects an address.", [], true, placeholder);
  }
  const kind = recipientFamily(recipient);
  // Where the recipient receives: a bridge pays on its destination, a transfer on its stated network. A Solana
  // recipient receives only on Solana: a stated Ethereum-family network is where the money is sent from
  // (transferPlacement). An Ethereum-family recipient with a stated Solana network is asked which one was meant.
  const stated = step.network && step.network.by !== "assumed" ? step.network.v : undefined;
  const network = step.kind?.v === "bridge" ? step.toNetwork?.v : stated && !(kind === "solana" && family(stated) !== "solana") ? stated : undefined;
  // A raw address is held to its family too (an EVM address is never paid on Solana).
  if (!isName(recipient)) return network && kind && kind !== "caip" && kind !== family(network) ? familyQuestion(env, index, step, recipient, kind, network) : null;
  if (/\.sol$/iu.test(recipient)) {
    const moved = recipient.replace(/\.sol$/iu, ".sns");
    const address = env.facts.resolveName(moved, "solana");
    if (address) {
      return question(path, "confirm", "RECIPIENT_NAME_MOVED", `Send to ${moved} (${short(address)})? SNS has paused .sol names during its registry move, and ${recipient} now resolves as ${moved}.`, "Each existing .sol name has a matching .sns name. Kletia shows the address it resolves to; check it before you sign.", [
        { id: moved, label: `Send to ${moved}`.slice(0, 48), detail: `Resolves to ${short(address)}`, value: { recipient: moved } },
      ], true, placeholderFor("address", undefined, true));
    }
    return question(path, "address", "RECIPIENT_UNRESOLVED", `Who should receive ${what}? ${recipient} cannot be used: SNS has paused .sol names during its registry move, and ${moved} did not resolve.`, "Paste the recipient's Solana address, or use their .sns name.", [], true, placeholderFor("address", undefined, true));
  }
  if (network && kind && kind !== "caip" && kind !== family(network)) return familyQuestion(env, index, step, recipient, kind, network);
  const probe = network ?? (kind === "solana" ? "solana" : "base");
  if (env.facts.resolveName(recipient, probe) === null) {
    return question(path, "address", "RECIPIENT_UNRESOLVED", `${recipient} has no ${networkName(probe)} address Kletia could find. Who should receive ${what}?`, "Check the spelling or paste the address. Kletia does not suggest other names.", [], true, placeholder);
  }
  return null;
}

/**
 * A recipient of one network family with a stated network of the other
 * (RECIPIENT_NETWORK_MISMATCH): enter a recipient of that network, or send on
 * a network of the recipient's family (where the person holds the asset).
 */
function familyQuestion(env: Env, index: number, step: WorkStep, recipient: string, kind: "eip155" | "solana", network: NetworkKey): Question {
  const path = field(index, "recipient");
  const evm = EVM_NETWORKS.filter((candidate) => lane(candidate) === lane(network)).filter((candidate) => {
    const symbol = symbolOnNetwork(env, candidate, step.from?.v, step.usdFrom);
    return symbol !== null && isPositive(env.facts.balance(candidate, symbol));
  });
  const options = kind === "eip155"
    ? evm.slice(0, 3).map((candidate) => networkOption(candidate, `You hold ${held(env, candidate, symbolOnNetwork(env, candidate, step.from?.v, step.usdFrom) as string)}`, { label: `Send on ${networkName(candidate)} instead` }))
    : [];
  const what = isName(recipient) ? `${kind === "eip155" ? "an Ethereum" : "a Solana"} name with no ${networkName(network)} address` : `${kind === "eip155" ? "an Ethereum-family" : "a Solana"} address that cannot receive on ${networkName(network)}`;
  return question(path, "address", "RECIPIENT_NETWORK_MISMATCH", `${short(recipient)} is ${what}. Enter a ${networkName(network)} address, or send on another network.`,
    isName(recipient) ? "Names resolve only on their own network family." : "An address belongs to one network family; funds sent across families are lost.", options, true, placeholderFor("address", undefined, family(network) === "solana"));
}
