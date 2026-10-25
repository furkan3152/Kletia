/**
 * Stage 2: normalise request actions (kinds, networks, amounts, capital
 * lane) and the L2 staking refusals.
 */
import {
  CHAINS,
  getProtocol,
  isSolanaAddress,
  sameCapitalLane,
  type IntentActionKind,
  type IntentActionSpec,
  type IntentRequest,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { PlatformError, unsupported } from "../../errors.js";
import {
  EVM_STAKING_NETWORK,
  GRAMMAR_EXAMPLES,
  l2StakeAlternatives,
  LIQUID_STAKING_TOKENS,
  NATIVE_STAKE_PROTOCOL,
  NATIVE_STAKE_PROVIDER,
} from "../grammar.js";
import {
  CONTRACT_KINDS,
  EVM_STAKE_PROTOCOLS,
  issue,
  joinList,
  NATIVE_STAKE_NETWORKS,
  STAKE_PROTOCOLS,
  SUPPORTED_KINDS,
} from "./shared.js";
import type { AmountSpec, NormalizedAction } from "./types.js";
import { isNativeStake, lendingNames, solanaStakeNames } from "./resolve.js";

/** "Lido, Rocket Pool, ether.fi, Stader, Mantle LSP or Frax Ether" (every EVM staking protocol the grammar maps). */
function evmStakeNames(): string {
  return joinList(Object.keys(EVM_STAKE_PROTOCOLS).map((id) => getProtocol(id as ProtocolId)?.name ?? id), "or");
}

/** "wstETH (Lido), rETH (Rocket Pool), ... or sfrxETH (Frax Ether)". */
function evmStakeTokens(): string {
  return joinList(Object.values(EVM_STAKE_PROTOCOLS).map((entry) => `${entry?.symbol} (${entry?.provider})`), "or");
}

/**
 * "stake ETH" on an EVM network without staking: the refusal names the
 * two ways that work, as sentences the grammar reads (buy a liquid
 * staking token there at market, or bridge to Ethereum and stake). Never
 * planned silently as a swap.
 */
function l2StakeRefusal(network: NetworkKey, amount: string | undefined, path: string): PlatformError {
  const alternatives = l2StakeAlternatives(network);
  const name = CHAINS[network].name;
  const value = amount && amount !== "max" ? amount : "1";
  const ways: string[] = [];
  if (alternatives && alternatives.tokens.length > 0) {
    const [first, ...rest] = alternatives.tokens;
    ways.push(`buy ${joinList(alternatives.tokens, "or")} on ${name} at market ("swap ${value} ${alternatives.etherSymbol} to ${first} on ${network}"${rest.length > 0 ? `, or ${rest.join(", ")}` : ""})`);
  }
  if (alternatives && alternatives.etherSymbol.toUpperCase() === "ETH") {
    ways.push(`bridge to Ethereum and stake there ("bridge ${value} ETH from ${network} to ethereum then stake it with lido")`);
  }
  const instead = ways.length > 0 ? ` On ${name} you can ${ways.join(", or ")}.` : "";
  return unsupported(
    `Staking ETH runs on ${CHAINS[EVM_STAKING_NETWORK].name} (${evmStakeNames()}), not on ${name}.${instead}`,
    GRAMMAR_EXAMPLES,
    issue(`${path}.network`, "No staking venue on this network."),
  );
}

function portionFrom(spec: IntentActionSpec, path: string): number {
  const raw = spec.params?.portionBps;
  if (raw === undefined) return 10_000;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new PlatformError("INVALID_REQUEST", "params.portionBps must be an integer between 1 and 10000.", 400, issue(`${path}.params.portionBps`, "Out of range."));
  }
  return value;
}

/** Call / action specs: the VM must match the network; the amount is optional (non-spending entries). */
function normalizeContractAction(spec: IntentActionSpec, index: number): NormalizedAction {
  const path = `actions[${index}]`;
  const vm = spec.kind === "call" ? "evm" : "svm";
  if (CHAINS[spec.network].vm !== vm) {
    throw new PlatformError(
      "NETWORK_UNSUPPORTED",
      spec.kind === "call"
        ? `call steps run registered EVM contracts; ${CHAINS[spec.network].name} is not an EVM network (use kind "action" for Solana Actions).`
        : `action steps run registered Solana Actions; ${CHAINS[spec.network].name} is not a Solana network (use kind "call" for EVM contracts).`,
      422,
      issue(`${path}.network`, "Wrong VM for this kind."),
    );
  }
  const expected: ProtocolId = spec.kind === "call" ? "custom-call" : "solana-actions";
  if (spec.protocol && spec.protocol !== expected) {
    throw unsupported(`${spec.kind} steps execute under ${expected}, not ${spec.protocol}.`, GRAMMAR_EXAMPLES, issue(`${path}.protocol`, "Unsupported."));
  }
  if (spec.params?.venue !== undefined) {
    throw unsupported("params.venue applies to deposit and withdraw actions only.", GRAMMAR_EXAMPLES, issue(`${path}.params.venue`, "Unsupported."));
  }
  if (spec.toNetwork !== undefined && spec.toNetwork !== spec.network) {
    throw unsupported(`${spec.kind} steps run on one network; move funds with a bridge step first.`, GRAMMAR_EXAMPLES, issue(`${path}.toNetwork`, "Unsupported."));
  }
  const amount: AmountSpec = spec.amount === undefined
    ? { type: "none" }
    : spec.amount === "max"
      ? { type: "previous", portionBps: portionFrom(spec, path) }
      : { type: "exact", value: spec.amount };
  if (amount.type === "previous" && index === 0) {
    throw unsupported(
      "\"max\" means the output of the previous step, so the first action needs an explicit amount.",
      GRAMMAR_EXAMPLES,
      issue(`${path}.amount`, "No previous step."),
    );
  }
  return {
    index,
    kind: spec.kind,
    network: spec.network,
    destinationNetwork: spec.network,
    amount,
    ...(spec.from ? { from: spec.from } : {}),
    ...(spec.recipient ? { recipient: spec.recipient } : {}),
    protocol: expected,
    contract: spec.contract ?? "",
    entry: spec.entry ?? "",
    ...(spec.params ? { params: spec.params } : {}),
  };
}

/**
 * `receiveExact`: only `true`, only on a payment (a transfer, or a
 * bridge that pays a recipient) with an exact amount. A same-network
 * transfer delivers its amount by construction; a crossing payment is sized
 * by inverse quoting (routing/deliverExact.ts).
 */
function exactDelivery(spec: IntentActionSpec, kind: IntentActionKind, amount: AmountSpec, path: string): true | undefined {
  const raw = (spec as { readonly receiveExact?: unknown }).receiveExact;
  if (raw === undefined || raw === false) return undefined;
  if (raw !== true) {
    throw new PlatformError("INVALID_REQUEST", "receiveExact must be true when set.", 400, issue(`${path}.receiveExact`, "Must be true."));
  }
  if ((kind !== "transfer" && kind !== "bridge") || !spec.recipient) {
    throw new PlatformError("INVALID_REQUEST", "receiveExact applies to payments only: a transfer or a bridge with a recipient.", 400, issue(`${path}.receiveExact`, "Not a payment."));
  }
  if (amount.type !== "exact") {
    throw new PlatformError("INVALID_REQUEST", "receiveExact needs an exact amount (the amount the recipient receives).", 400, issue(`${path}.amount`, "Must be a decimal amount."));
  }
  return true;
}

/** Normalises structured or grammar-produced actions and enforces one capital lane. */
export function normalizeActions(actions: readonly IntentActionSpec[], request: IntentRequest): NormalizedAction[] {
  const normalized = actions.map((spec, index): NormalizedAction => {
    const path = `actions[${index}]`;
    let kind = spec.kind;
    if (!SUPPORTED_KINDS.includes(kind)) {
      throw unsupported(
        `${kind === "borrow" ? "Borrowing is" : kind === "repay" ? "Repaying a loan is" : `"${kind}" is`} not available yet. Supported: swap, transfer, bridge, stake (SOL liquid staking), deposit and withdraw (lending venues), and call / action steps of registered contracts.`,
        GRAMMAR_EXAMPLES,
        issue(`${path}.kind`, "Unsupported action kind."),
      );
    }
    if (CONTRACT_KINDS.includes(kind)) return normalizeContractAction(spec, index);
    if (spec.amount === undefined) {
      throw new PlatformError("AMOUNT_REQUIRED", "Every action needs an amount (decimal or \"max\").", 400, issue(`${path}.amount`, "Required."));
    }
    if (kind === "withdraw" && spec.amount === "max" && spec.params?.portionBps !== undefined) {
      throw unsupported(
        "\"max\" on a withdraw closes the whole position; give an exact amount to withdraw part of it.",
        GRAMMAR_EXAMPLES,
        issue(`${path}.params.portionBps`, "Not allowed with a full withdrawal."),
      );
    }
    const amount: AmountSpec = spec.amount === "max"
      ? kind === "withdraw" ? { type: "position" } : { type: "previous", portionBps: portionFrom(spec, path) }
      : { type: "exact", value: spec.amount };
    if (amount.type === "previous" && index === 0) {
      throw unsupported(
        "\"max\" means the output of the previous step, so the first action needs an explicit amount.",
        GRAMMAR_EXAMPLES,
        issue(`${path}.amount`, "No previous step."),
      );
    }
    let destinationNetwork = spec.toNetwork ?? spec.network;
    if (kind === "swap" && destinationNetwork !== spec.network) kind = "bridge";
    if (kind !== "bridge") destinationNetwork = spec.network;
    if (kind === "bridge" && destinationNetwork === spec.network) {
      throw unsupported("A bridge needs a different destination network (toNetwork).", GRAMMAR_EXAMPLES, issue(`${path}.toNetwork`, "Same as network."));
    }
    let protocol = spec.protocol;
    let provider = typeof spec.params?.provider === "string" ? spec.params.provider.slice(0, 32) : undefined;
    let to = spec.to;
    if (kind === "stake" && CHAINS[spec.network].vm === "evm" && spec.network !== EVM_STAKING_NETWORK && typeof request.text === "string") {
      // A sentence gets sentences back; structured actions keep the live-venue refusal of draftStep.
      throw l2StakeRefusal(spec.network, spec.amount, path);
    }
    if (kind === "stake" && CHAINS[spec.network].vm === "evm") {
      // EVM liquid staking: the protocol comes from the request or from the token it mints (default Lido).
      const byTarget = to
        ? (Object.entries(EVM_STAKE_PROTOCOLS).find(([, entry]) => entry?.symbol.toUpperCase() === to?.toUpperCase())?.[0] as ProtocolId | undefined)
        : undefined;
      if (protocol && !EVM_STAKE_PROTOCOLS[protocol]) {
        throw unsupported(
          `Liquid staking on ${CHAINS[spec.network].name} runs through ${evmStakeNames()}, not ${getProtocol(protocol)?.name ?? protocol}.`,
          GRAMMAR_EXAMPLES,
          issue(`${path}.protocol`, "Unsupported."),
        );
      }
      if (to && !byTarget) {
        throw unsupported(`Liquid staking on ${CHAINS[spec.network].name} mints ${evmStakeTokens()}, not ${to}.`, GRAMMAR_EXAMPLES, issue(`${path}.to`, "Unsupported."));
      }
      protocol = protocol ?? byTarget ?? "lido";
      const target = EVM_STAKE_PROTOCOLS[protocol] as { symbol: string; provider: string };
      if (to && byTarget !== protocol) {
        throw unsupported(`${getProtocol(protocol)?.name ?? protocol} mints ${target.symbol}, not ${to}.`, GRAMMAR_EXAMPLES, issue(`${path}.to`, "Mismatch."));
      }
      to = target.symbol;
      provider = provider ?? target.provider;
    } else if (kind === "stake" && isNativeStake(spec)) {
      // Native staking: a stake account the wallet owns, delegated to a validator; the output is the delegated SOL.
      if (!NATIVE_STAKE_NETWORKS.includes(spec.network)) {
        throw unsupported(
          `Native staking runs on ${joinList(NATIVE_STAKE_NETWORKS.map((network) => CHAINS[network].name), "and")}, not ${CHAINS[spec.network].name}.`,
          GRAMMAR_EXAMPLES,
          issue(`${path}.network`, "Unsupported."),
        );
      }
      const native = CHAINS[spec.network].nativeAsset.symbol;
      if (to && to.toUpperCase() !== native.toUpperCase()) {
        throw unsupported(`Native staking keeps ${native} in a stake account; it does not mint ${to}.`, GRAMMAR_EXAMPLES, issue(`${path}.to`, "Mismatch."));
      }
      to = native;
      protocol = NATIVE_STAKE_PROTOCOL;
      // A named validator is its vote account (base58, up to 44 characters): kept whole, never cut.
      const named = typeof spec.params?.provider === "string" ? spec.params.provider.trim() : undefined;
      provider = named && isSolanaAddress(named) ? named : NATIVE_STAKE_PROVIDER;
    } else if (kind === "stake") {
      if (protocol && EVM_STAKE_PROTOCOLS[protocol]) {
        throw unsupported(
          `${getProtocol(protocol)?.name ?? protocol} stakes ETH on Ethereum; SOL stakes with ${solanaStakeNames()}.`,
          GRAMMAR_EXAMPLES,
          issue(`${path}.protocol`, "Unsupported on this network."),
        );
      }
      const key = protocol ? STAKE_PROTOCOLS[protocol] : undefined;
      if (protocol && !key) {
        throw unsupported(`SOL liquid staking runs through ${solanaStakeNames()}, not ${getProtocol(protocol)?.name ?? protocol}.`, GRAMMAR_EXAMPLES, issue(`${path}.protocol`, "Unsupported."));
      }
      if (key && !to) to = LIQUID_STAKING_TOKENS[key]?.symbol;
      if (!provider) {
        const target = Object.values(LIQUID_STAKING_TOKENS).find((entry) => entry.symbol.toUpperCase() === (to ?? "JitoSOL").toUpperCase());
        provider = target?.provider ?? "Jito";
      }
      to = to ?? "JitoSOL";
      protocol = "jupiter";
    }
    const lending = kind === "deposit" || kind === "withdraw";
    if (lending && protocol && !(getProtocol(protocol)?.kinds ?? []).includes(kind)) {
      throw unsupported(
        `${getProtocol(protocol)?.name ?? protocol} does not take ${kind}s. Deposits and withdrawals run on ${lendingNames()}.`,
        GRAMMAR_EXAMPLES,
        issue(`${path}.protocol`, "Unsupported."),
      );
    }
    const venue = typeof spec.params?.venue === "string" ? spec.params.venue.trim().slice(0, 128) : undefined;
    if (venue && !lending) {
      throw unsupported("params.venue applies to deposit and withdraw actions only.", GRAMMAR_EXAMPLES, issue(`${path}.params.venue`, "Unsupported."));
    }
    const receiveExact = exactDelivery(spec, kind, amount, path);
    return {
      index,
      kind,
      network: spec.network,
      destinationNetwork,
      amount,
      ...(spec.from ? { from: spec.from } : {}),
      ...(to ? { to } : {}),
      ...(spec.recipient ? { recipient: spec.recipient } : {}),
      ...(protocol ? { protocol } : {}),
      ...(provider ? { provider } : {}),
      ...(venue ? { venue } : {}),
      ...(receiveExact ? { receiveExact } : {}),
    };
  });
  const lane = normalized[0]?.network;
  for (const action of normalized) {
    for (const network of [action.network, action.destinationNetwork]) {
      if (lane && !sameCapitalLane(lane, network)) {
        throw new PlatformError(
          "CAPITAL_LANE_MIXED",
          `${CHAINS[network].name} (${CHAINS[network].environment}) cannot share an intent with ${CHAINS[lane].name} (${CHAINS[lane].environment}).`,
          422,
          issue(`actions[${action.index}].network`, "Mainnet and testnet networks never mix in one intent."),
        );
      }
      if (request.constraints?.allowTestnets === false && CHAINS[network].environment === "testnet") {
        throw new PlatformError("TESTNET_NOT_ALLOWED", `${CHAINS[network].name} is a testnet and constraints.allowTestnets is false.`, 422);
      }
    }
  }
  return normalized;
}
