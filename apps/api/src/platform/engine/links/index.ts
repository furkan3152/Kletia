/**
 * Intent links, engine side (intent-links design L2, §3.4, §3.5, §3.7).
 * `planLinkIntent` turns a stored link and a visitor's funding choice into
 * an intent of the publisher key: the deterministic expansion of core
 * (`expandLink`), deliver sizing for "receive at least" links, the
 * unverified-publisher cap, then `createIntentDetailed` under the owner key
 * (BYOC scoping, Rule Book, previews all apply as for any intent of that
 * key) with an envelope check on the planned graph before anything is
 * stored: every network, payer, recipient, contract and the root input must
 * be what the link fixed, else LINK_PLAN_OUT_OF_BOUNDS and nothing is kept.
 */
import {
  CHAINS,
  expandLink,
  formatAccountId,
  fromBaseUnits,
  isLinkId,
  LINK_LIMITS,
  LinkExpansionError,
  linkFundingAsset,
  normalizeAddress,
  parseAccountId,
  parseAssetId,
  sameAddressAccount,
  toBaseUnits,
  type AccountId,
  type IntentGraph,
  type IntentPreview,
  type IntentRequest,
  type LinkExpansion,
  type LinkFundingChoice,
  type NetworkKey,
  type ParsedAccountId,
  type StoredLinkDefinition,
  type VirtualMachine,
} from "@kletia/core";
import { isPlatformError, PlatformError, toPlatformError, type PlatformIssue } from "../../errors.js";
import { notionalUsdMicros, policyPrice } from "../policy/pricing.js";
import { previewIntent } from "../preview/index.js";
import { createIntentDetailed } from "../service.js";
import { canonicalJson, sha256Hex } from "../util.js";
import { sizeDelivery } from "./deliver.js";
import { linkPinDrift, linkPinDriftError } from "./pins.js";

export { DeliverCandidateRejected, resetDeliverSizing, sizeDelivery, type DeliverSizingInput, type DeliverSizingResult } from "./deliver.js";
export { linkPolicyCheck, type LinkPolicyCheck } from "./policy.js";
export { linkPinDrift, linkPinDriftError, type LinkPinDrift } from "./pins.js";

const CLIENT_REFERENCE = /^[A-Za-z0-9_.:-]{1,80}$/u;

/**
 * A visitor's clientReference, namespaced per link and visitor accounts: the
 * publisher key owns every link intent, so a raw reference would let one
 * visitor replay (and read) another visitor's intent.
 */
export function linkClientReference(linkId: string, accounts: readonly string[], clientReference: string): string {
  if (!CLIENT_REFERENCE.test(clientReference)) {
    throw new PlatformError("INVALID_REQUEST", "clientReference must match [A-Za-z0-9_.:-]{1,80}.", 400, [{ path: "clientReference", message: "Invalid format." }]);
  }
  return `link:${sha256Hex(`${linkId}|${[...accounts].sort().join(",")}|${clientReference}`).slice(0, 48)}`;
}

export interface LinkPlanInput {
  /** Definition + pins (core type). */
  readonly link: StoredLinkDefinition;
  /** `lk_…`: becomes `metadata.linkId` (uses, strict simulation). */
  readonly linkId: string;
  readonly ownerKeyId: string;
  /** `{ network, asset, amount? }`. */
  readonly choice: LinkFundingChoice;
  /** One visitor account per VM the route signs on (ignored when `indicative`). */
  readonly accounts: readonly AccountId[];
  readonly dryRun: boolean;
  /** Placeholder accounts + preview stage "indicative" (quotes without a wallet); always a dry run. */
  readonly indicative?: boolean;
  /**
   * The publisher's domain is verified. Unverified publishers (the default:
   * fail closed) are limited to KLETIA_LINK_UNVERIFIED_MAX_USD of priced
   * root input per intent, and an unpriced input is refused.
   */
  readonly publisherVerified?: boolean;
  /** Visitor retries of one creation: idempotent per link, visitor accounts and reference (namespaced, see linkClientReference). */
  readonly clientReference?: string;
}

export interface PlannedLinkIntent {
  readonly intent: IntentGraph;
  readonly preview: IntentPreview;
  readonly replayed: boolean;
}

/** Placeholder accounts of indicative quotes (as BYOC sessions use). */
const PLACEHOLDER = { evm: "0x000000000000000000000000000000000000c0de", svm: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" } as const;

function outOfBounds(message: string): PlatformError {
  console.error(`[platform] link plan out of bounds: ${message}`);
  return new PlatformError("LINK_PLAN_OUT_OF_BOUNDS", `The planned intent left the link's envelope (${message}); nothing was stored.`, 500);
}

function issues(list: readonly { readonly path: string; readonly message: string }[]): PlatformIssue[] {
  return list.map((entry) => ({ path: entry.path, message: entry.message }));
}

/** Core expansion errors as PlatformErrors (catalogued statuses). */
function expansionError(error: LinkExpansionError): PlatformError {
  switch (error.code) {
    case "LINK_INPUT_OUT_OF_BOUNDS":
      return new PlatformError("LINK_INPUT_OUT_OF_BOUNDS", error.message, 422, issues(error.issues));
    case "LINK_SOURCE_NOT_ALLOWED":
      return new PlatformError("LINK_SOURCE_NOT_ALLOWED", error.message, 422, issues(error.issues));
    case "LINK_ACCOUNTS_REQUIRED":
      return new PlatformError("LINK_ACCOUNTS_REQUIRED", error.message, 422, issues(error.issues));
    default:
      return outOfBounds(error.message);
  }
}

/**
 * Expansion with named pins planned by name: the planner resolves the name
 * again (it must still give the pinned address: the envelope check) and the
 * step records `recipientName`, so every prepare re-resolves it too
 * (RECIPIENT_NAME_CHANGED), exactly like any intent paying a name.
 */
function expand(link: StoredLinkDefinition, choice: LinkFundingChoice, deliverInput?: string): LinkExpansion {
  let expansion: LinkExpansion;
  try {
    expansion = expandLink(link, choice, deliverInput !== undefined ? { deliverInput } : {});
  } catch (error) {
    if (error instanceof LinkExpansionError) throw expansionError(error);
    throw toPlatformError(error);
  }
  const named = link.pins.recipients.filter((pin) => pin.name);
  if (named.length === 0) return expansion;
  return {
    ...expansion,
    actions: expansion.actions.map((action) => {
      const pin = named.find((entry) => entry.account === action.recipient);
      return pin?.name ? { ...action, recipient: pin.name } : action;
    }),
  };
}

const VM_LABEL: Readonly<Record<VirtualMachine, string>> = { evm: "EVM", svm: "Solana" };

/** The network of each VM the route uses (for placeholder accounts and the lane). */
function vmNetworks(expansion: LinkExpansion): Map<VirtualMachine, NetworkKey> {
  const out = new Map<VirtualMachine, NetworkKey>();
  for (const action of expansion.actions) {
    const vm = CHAINS[action.network].vm;
    if (!out.has(vm)) out.set(vm, action.network);
  }
  return out;
}

/**
 * Exactly one visitor account per VM the route signs on, each on the link's
 * capital lane (§3.7 step 3). Accounts for other VMs are refused: an extra
 * account would count as "own" and could receive a bridge's default payout.
 */
export function linkVisitorAccounts(expansion: LinkExpansion, accounts: readonly AccountId[]): ParsedAccountId[] {
  const required = expansion.requiredVms;
  const lane = CHAINS[expansion.source.network].lane;
  const problems: PlatformIssue[] = [];
  const parsed: ParsedAccountId[] = [];
  const seen = new Set<VirtualMachine>();
  accounts.forEach((account, index) => {
    const value = typeof account === "string" ? parseAccountId(account) : null;
    if (!value) {
      problems.push({ path: `accounts[${index}]`, message: "Not a CAIP-10 account." });
      return;
    }
    const vm = value.chain.vm;
    if (!required.includes(vm)) problems.push({ path: `accounts[${index}]`, message: `This link signs on ${required.map((entry) => VM_LABEL[entry]).join(" and ")} only.` });
    else if (seen.has(vm)) problems.push({ path: `accounts[${index}]`, message: `One ${VM_LABEL[vm]} account only.` });
    else if (value.chain.lane !== lane) problems.push({ path: `accounts[${index}]`, message: `Use an account on the ${lane} lane.` });
    seen.add(vm);
    parsed.push(value);
  });
  for (const vm of required) {
    if (!accounts.some((account) => parseAccountId(account)?.chain.vm === vm)) problems.push({ path: "accounts", message: `Add your ${VM_LABEL[vm]} account.` });
  }
  if (problems.length > 0) {
    throw new PlatformError(
      "LINK_ACCOUNTS_REQUIRED",
      `This link needs exactly one account per network family it signs on: ${required.map((entry) => VM_LABEL[entry]).join(" and ")}.`,
      422,
      problems,
    );
  }
  return parsed;
}

function placeholderAccounts(expansion: LinkExpansion): AccountId[] {
  return [...vmNetworks(expansion)].map(([vm, network]) => formatAccountId(CHAINS[network], PLACEHOLDER[vm]) as AccountId);
}

function unverifiedCapUsd(): number {
  const raw = Number(process.env.KLETIA_LINK_UNVERIFIED_MAX_USD ?? LINK_LIMITS.unverifiedMaxUsd);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, LINK_LIMITS.unverifiedMaxUsd * 1_000) : LINK_LIMITS.unverifiedMaxUsd;
}

/** Unverified publishers: priced root input ≤ $1,000 (conservative oracle); unpriced inputs are refused. */
async function assertUnverifiedCap(network: NetworkKey, asset: string, symbol: string, decimals: number, units: bigint): Promise<void> {
  const cap = unverifiedCapUsd();
  const quote = await policyPrice({ asset: asset as never, symbol, decimals, network }).catch(() => null);
  if (!quote) {
    throw new PlatformError("LINK_INPUT_OUT_OF_BOUNDS", `This publisher's links are limited to $${cap.toLocaleString("en-US")} and the price of ${symbol} is unknown right now.`, 422, [
      { path: "amount", message: "Unpriced input from an unverified publisher." },
    ]);
  }
  const micros = notionalUsdMicros(units, decimals, quote);
  if (micros > BigInt(Math.round(cap * 1_000_000))) {
    throw new PlatformError("LINK_INPUT_OUT_OF_BOUNDS", `This publisher's domain is not verified, so its links are limited to $${cap.toLocaleString("en-US")} per intent.`, 422, [
      { path: "amount", message: `At most $${cap.toLocaleString("en-US")} of ${symbol}.` },
    ]);
  }
}

function addressOf(account: ParsedAccountId): string {
  return normalizeAddress(account.chain.namespace, account.address);
}

/** A pinned recipient matches only on its own chain (a contract wallet may not exist elsewhere). */
function samePinned(recipient: string, pinned: string): boolean {
  const left = parseAccountId(recipient);
  const right = parseAccountId(pinned);
  return left !== null && right !== null && left.chain.id === right.chain.id && addressOf(left) === addressOf(right);
}

export interface LinkEnvelopeCheck {
  readonly expansion: LinkExpansion;
  /** The accounts the intent was planned with (visitor or placeholders). */
  readonly accounts: readonly AccountId[];
  /** Destination action kinds the link fixed (plus the funding leg's swap / bridge). */
  readonly kinds: readonly string[];
}

/**
 * Defence in depth against planner bugs (§3.7 step 8): the planned graph
 * may only touch the envelope's networks, be paid by the visitor, pay the
 * visitor or a pinned recipient, call pinned registrations, and spend
 * exactly the chosen root input from one root step.
 */
export function assertLinkEnvelope(graph: IntentGraph, check: LinkEnvelopeCheck): void {
  const { envelope } = check.expansion;
  const own = (account: string) => check.accounts.some((candidate) => sameAddressAccount(candidate, account));
  const funded = new Set(graph.edges.filter((edge) => edge.kind === "funds").map((edge) => edge.to));
  const kinds = new Set(["swap", "bridge", ...check.kinds]);
  for (const step of graph.steps) {
    for (const network of [step.network, step.settlement?.destinationNetwork]) {
      if (network && !envelope.networks.includes(network)) throw outOfBounds(`step ${step.id} touches ${network}`);
    }
    if (!kinds.has(step.kind)) throw outOfBounds(`step ${step.id} is a ${step.kind} step`);
    if (!own(step.account)) throw outOfBounds(`step ${step.id} is paid by an account the visitor did not give`);
    const recipient = step.recipient ?? step.account;
    if (!own(recipient) && !envelope.recipients.some((pinned) => samePinned(recipient, pinned))) {
      throw outOfBounds(`step ${step.id} pays ${recipient}, which the link did not pin`);
    }
    if (step.call) {
      const call = step.call;
      if (!envelope.contracts.some((pin) => pin.contract === call.contract && pin.revision === call.revision && pin.definitionHash === call.definitionHash)) {
        throw outOfBounds(`step ${step.id} calls ${call.contract} revision ${call.revision}, which the link did not pin`);
      }
    } else if (step.kind === "call" || step.kind === "action") {
      throw outOfBounds(`step ${step.id} calls a contract without a registration snapshot`);
    }
  }
  const roots = graph.steps.filter((step) => !funded.has(step.id) && step.input !== undefined);
  if (roots.length !== 1) throw outOfBounds(`${roots.length} steps spend the visitor's funds directly`);
  const root = roots[0] as (typeof roots)[number];
  const input = root.input as NonNullable<typeof root.input>;
  let expected: string;
  try {
    expected = toBaseUnits(envelope.root.amount, input.decimals);
  } catch {
    throw outOfBounds("the root amount does not fit the input asset");
  }
  if (root.network !== envelope.root.network || !sameAssetId(input.asset, envelope.root.asset) || input.amount !== expected) {
    throw outOfBounds(`the root step spends ${input.amount} of ${input.asset} on ${root.network}, not the chosen ${expected} of ${envelope.root.asset} on ${envelope.root.network}`);
  }
}

function sameAssetId(a: string, b: string): boolean {
  const left = parseAssetId(a);
  const right = parseAssetId(b);
  if (!left || !right || left.chain.id !== right.chain.id || left.assetNamespace !== right.assetNamespace) return false;
  return left.assetNamespace === "erc20" ? left.reference.toLowerCase() === right.reference.toLowerCase() : left.reference === right.reference;
}

/** Ends deliver sizing when an earlier creation is replayed (never leaves this module). */
class LinkReplayed extends Error {}

/** The definition's cache identity (sizing cache, quotes): any PATCH changes it. */
function linkKey(link: StoredLinkDefinition, choice: LinkFundingChoice): string {
  return `${sha256Hex(canonicalJson(link))}|${choice.network}|${choice.asset.toLowerCase()}`;
}

async function withPreview(created: { readonly intent: IntentGraph; readonly replayed: boolean }, stage: "plan" | "indicative"): Promise<PlannedLinkIntent> {
  try {
    const preview = await previewIntent(created.intent, { stage, ...(stage === "indicative" ? { store: false } : {}) });
    return { intent: created.intent, preview, replayed: created.replayed };
  } catch (error) {
    throw toPlatformError(error);
  }
}

/**
 * Plans (and unless a dry run, stores) a visitor's intent from a link
 * (frozen L2 → L3 interface). Throws LINK_INPUT_OUT_OF_BOUNDS,
 * LINK_SOURCE_NOT_ALLOWED, LINK_ACCOUNTS_REQUIRED, LINK_DELIVERY_UNQUOTABLE,
 * LINK_PLAN_OUT_OF_BOUNDS, plus whatever planning under the owner key
 * refuses (Rule Book, BYOC, quotes).
 */
export async function planLinkIntent(input: LinkPlanInput): Promise<PlannedLinkIntent> {
  try {
    if (!isLinkId(input.linkId)) throw outOfBounds("the link id is malformed");
    const { link, choice } = input;
    // Pinned names and registrations must still be what visitors were shown (§3.7 step 4).
    const drift = await linkPinDrift(link);
    if (drift) throw linkPinDriftError(drift);
    const indicative = input.indicative === true;
    const dryRun = input.dryRun || indicative;
    const first = expand(link, choice);
    const accounts = indicative ? placeholderAccounts(first) : linkVisitorAccounts(first, input.accounts).map((account) => account.id as AccountId);
    const kinds = link.definition.destination.actions.map((action) => action.kind);
    const source = linkFundingAsset(choice.network, choice.asset);
    if (!source) throw new PlatformError("LINK_SOURCE_NOT_ALLOWED", `This link cannot be funded with ${choice.asset} on ${CHAINS[choice.network].name}.`, 422);
    const verified = input.publisherVerified === true;

    const create = async (expansion: LinkExpansion, extraCheck?: (graph: IntentGraph) => void) => {
      const request: IntentRequest = {
        actions: expansion.actions,
        accounts,
        ...(link.definition.constraints ? { constraints: link.definition.constraints } : {}),
        ...(link.definition.metadata ? { metadata: link.definition.metadata } : {}),
        ...(input.clientReference && !dryRun ? { clientReference: linkClientReference(input.linkId, accounts, input.clientReference) } : {}),
      };
      return createIntentDetailed(request, {
        ownerKeyId: input.ownerKeyId,
        // Visitors are public callers: the publisher key owns the intent, nobody acts with it.
        actorKeyId: null,
        dryRun,
        linkId: input.linkId,
        verifyPlan: async (graph) => {
          assertLinkEnvelope(graph, { expansion, accounts, kinds });
          extraCheck?.(graph);
          if (!verified) {
            const root = graph.steps.find((step) => step.input !== undefined && !graph.edges.some((edge) => edge.to === step.id && edge.kind === "funds"));
            if (root?.input) await assertUnverifiedCap(root.network, root.input.asset, root.input.symbol, root.input.decimals, BigInt(root.input.amount));
          }
        },
      });
    };

    if (first.case !== "deliver-bridge") {
      if (!verified) await assertUnverifiedCap(choice.network, source.id, source.symbol, source.decimals, BigInt(toBaseUnits(first.envelope.root.amount, source.decimals)));
      return await withPreview(await create(first), indicative ? "indicative" : "plan");
    }

    // Deliver across networks: the bridge pays the pinned recipient at least the fixed amount (§3.5).
    const head = link.definition.destination.actions[0];
    const delivered = first.destination.asset;
    const target = BigInt(toBaseUnits(String(head?.amount ?? "0"), delivered.decimals));
    if (!verified) await assertUnverifiedCap(choice.network, source.id, source.symbol, source.decimals, BigInt(toBaseUnits(first.envelope.root.amount, source.decimals)));
    let replay: Awaited<ReturnType<typeof create>> | null = null;
    const sizing = await sizeDelivery({
      key: linkKey(link, choice),
      targetUnits: target,
      targetDecimals: delivered.decimals,
      inputDecimals: source.decimals,
      plan: async (inputUnits, check) => {
        const expansion = expand(link, choice, fromBaseUnits(inputUnits.toString(), source.decimals));
        const created = await create(expansion, (graph) => {
          const bridge = graph.steps.find((step) => step.settlement?.destinationNetwork === expansion.destination.network && step.network === expansion.source.network);
          const minimum = bridge?.minimumOutput;
          if (!bridge || !minimum) throw outOfBounds("the deliver bridge has no guaranteed minimum");
          if (!sameAssetId(minimum.asset, delivered.asset)) throw outOfBounds(`the deliver bridge pays ${minimum.symbol}, not ${delivered.symbol}`);
          const pinned = expansion.envelope.recipients[0];
          if (!pinned || !samePinned(bridge.recipient ?? bridge.account, pinned)) throw outOfBounds("the deliver bridge does not pay the pinned recipient");
          check(BigInt(minimum.amount));
        });
        // A visitor's retry (same clientReference) returns the intent sized and stored before.
        if (created.replayed) {
          replay = created;
          throw new LinkReplayed();
        }
        return created;
      },
    }).catch((error: unknown) => {
      if (error instanceof LinkReplayed && replay) return { value: replay };
      throw error;
    });
    return await withPreview(sizing.value, indicative ? "indicative" : "plan");
  } catch (error) {
    if (isPlatformError(error)) throw error;
    throw toPlatformError(error);
  }
}
