/**
 * Solana Actions and blinks for links whose visitor flow is Solana-only
 * (links design §6): `GET /v1/blinks/{id}` (ActionGetResponse), `POST
 * /v1/blinks/{id}` (the unsigned transaction of the first Solana step, or
 * of `?step=` with a callback token) and `POST /v1/blinks/{id}/next` (the
 * chaining callback: submit the signature, then the next Solana step or
 * `completed`).
 *
 * - Exposure needs the link's blink eligibility (Solana-only flow of at most
 *   3 single-transaction steps, verified domain, active, `blink: true`,
 *   KLETIA_BLINKS_ENABLED, operator approval for third-party payees and
 *   custom contracts); otherwise GET answers `disabled` with the page as the
 *   fallback.
 * - A POST plans the visitor's intent exactly as `POST /v1/links/{id}/intents`
 *   and prepares through the same rules as the prepare route (use
 *   reservation, strict simulation): no code path is skipped.
 * - Callback tokens are HMAC-SHA256 over (link, intent, step, account) under
 *   a key derived from the platform secret, so a callback cannot be driven
 *   for another account; submit verifies on chain anyway.
 * - Errors are `ActionError { message }` with the status of the API code.
 */
import { getBase58Encoder } from "@solana/kit";
import { CHAINS, LINK_LIMITS, parseAccountId, timingSafeEqualString, type IntentGraph, type IntentStep, type NetworkKey, type StepExecutionPayload } from "@kletia/core";
import { PlatformError, toPlatformError } from "../../errors.js";
import { getIntent, prepareStep, submitStep } from "../../index.js";
import { HttpError, invalidRequest, isRecord } from "../context.js";
import { platformMac } from "../secrets.js";
import { kletiaWebOrigin } from "../webOrigin.js";
import { blinkStateOf, createLinkIntent, effectiveLinkStatus, linkClock, loadLink } from "./service.js";
import { countLink } from "./stats.js";
import { afterLinkSubmit, beforeLinkPrepare } from "./uses.js";
import type { LinkRecord } from "./store.js";

/** `@solana/actions` 1.6.6 ACTIONS_CORS_HEADERS (also set by the app-level CORS policy for /v1/blinks). */
export const ACTIONS_CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
});

export const ACTION_VERSION = "2.4";

const DEFAULT_API_ORIGIN = "https://api.kletiaai.xyz";

/** Origin of action hrefs: KLETIA_API_ORIGIN (an exact HTTPS origin; localhost HTTP outside production) or the hosted API. */
export function apiOrigin(): string {
  const raw = process.env.KLETIA_API_ORIGIN?.trim();
  if (!raw) return DEFAULT_API_ORIGIN;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const scheme = url.protocol === "https:" || (url.protocol === "http:" && local && process.env.NODE_ENV !== "production");
    if (scheme && url.pathname === "/" && !url.search && !url.hash && !url.username) return url.origin;
  } catch {
    // Fall through to the hosted API.
  }
  return DEFAULT_API_ORIGIN;
}

/** An ActionError reply: the status of the API code and `{ message }`. */
export class ActionFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ActionFailure";
  }
}

export function actionFailure(error: unknown): ActionFailure {
  if (error instanceof ActionFailure) return error;
  if (error instanceof HttpError) return new ActionFailure(error.status, error.message.slice(0, 500));
  const failure = toPlatformError(error);
  const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : failure.status;
  const message = error instanceof Error && typeof (error as { code?: unknown }).code === "string" ? error.message : failure.message;
  return new ActionFailure(status, message.slice(0, 500));
}

/* ------------------------------------------------------------ tokens */

function tokenMessage(linkId: string, intentId: string, stepId: string, account: string): string {
  return `blink-next|${linkId}|${intentId}|${stepId}|${account}`;
}

/** The callback token of one step for one account (null when no platform secret is configured). */
export function blinkToken(linkId: string, intentId: string, stepId: string, account: string): string | null {
  return platformMac("blink-next", tokenMessage(linkId, intentId, stepId, account))?.slice(0, 22) ?? null;
}

function assertToken(linkId: string, intentId: string, stepId: string, account: string, token: unknown): void {
  const expected = blinkToken(linkId, intentId, stepId, account);
  if (!expected || typeof token !== "string" || !timingSafeEqualString(expected, token)) {
    throw new ActionFailure(403, "This callback does not belong to this link, intent, step and account.");
  }
}

/* ------------------------------------------------------------- shapes */

function solanaNetwork(record: LinkRecord): NetworkKey {
  return record.definition.funding.networks.includes("solana-devnet") && !record.definition.funding.networks.includes("solana") ? "solana-devnet" : "solana";
}

function verbOf(record: LinkRecord): string {
  const first = record.definition.destination.actions[0];
  if (record.definition.funding.amount.mode === "deliver") return `Pay ${first?.amount ?? ""} ${record.pins.destinationAsset.symbol}`.trim();
  switch (first?.kind) {
    case "deposit":
      return "Deposit";
    case "stake":
      return `Stake as ${String(first.to ?? "")}`.trim();
    case "transfer":
      return "Pay";
    case "swap":
      return `Swap to ${String(first.to ?? "")}`.trim();
    case "bridge":
      return "Bridge";
    default:
      return "Continue";
  }
}

function shortLabel(text: string): string {
  return text.split(/\s+/u).slice(0, 5).join(" ").slice(0, 60);
}

export interface ActionGet {
  readonly type: "action";
  readonly icon: string;
  readonly title: string;
  readonly description: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly links?: { readonly actions: readonly Record<string, unknown>[] };
  readonly error?: { readonly message: string };
}

function iconOf(record: LinkRecord): string {
  return `${kletiaWebOrigin()}/go/${record.id}/card.png?variant=square&v=${record.revision}`;
}

function describe(record: LinkRecord): string {
  const { definition, publisher } = record;
  const domain = publisher.domain ? `${publisher.domain} ${publisher.domainVerified ? "verified" : "not verified"}` : "domain not verified";
  return `${definition.title}. ${domain}. Kletia builds the transaction; review it in your wallet.`.slice(0, 400);
}

/** GET /v1/blinks/{id}: metadata, `disabled` with the page as fallback when the link cannot be a blink now. */
export async function blinkMetadata(id: string): Promise<{ readonly status: number; readonly body: ActionGet | { readonly message: string }; readonly chain: string }> {
  const now = linkClock();
  let record: LinkRecord;
  try {
    record = await loadLink(id, now);
  } catch {
    return { status: 404, body: { message: "Unknown link." }, chain: CHAINS.solana.id };
  }
  const status = effectiveLinkStatus(record, now);
  const network = solanaNetwork(record);
  if (status === "deleted" || status === "expired") return { status: 410, body: { message: "This link expired or was withdrawn by its publisher." }, chain: CHAINS[network].id };
  countLink(record.id, "blinkView");
  const eligibility = blinkStateOf(record, now);
  const page = `${kletiaWebOrigin()}/go/${record.id}`;
  const label = shortLabel(verbOf(record));
  const base = { type: "action" as const, icon: iconOf(record), title: record.publisher.name, description: describe(record), label };
  if (!eligibility.enabled) {
    return { status: 200, body: { ...base, disabled: true, error: { message: `${eligibility.reason ?? "This link cannot be used as a blink right now."} Open ${page}.` } }, chain: eligibility.chain ?? CHAINS[network].id };
  }
  const actions = eligibility.assets.map((symbol) => {
    const bounds = record.definition.funding.amount.mode === "input" ? record.definition.funding.amount.bounds[symbol] : undefined;
    const href = `${apiOrigin()}/v1/blinks/${record.id}?asset=${encodeURIComponent(symbol)}${bounds ? "&amount={amount}" : ""}`;
    return {
      type: "transaction",
      label: shortLabel(eligibility.assets.length > 1 ? `${label} with ${symbol}` : label),
      href,
      ...(bounds
        ? { parameters: [{ type: "number", name: "amount", label: `Amount in ${symbol} (${bounds.min} to ${bounds.max})`, min: Number(bounds.min), max: Number(bounds.max), required: true }] }
        : {}),
    };
  });
  return { status: 200, body: { ...base, links: { actions } }, chain: eligibility.chain ?? CHAINS[network].id };
}

/* -------------------------------------------------------------- POST */

function solanaAccount(record: LinkRecord, body: unknown): { readonly address: string; readonly account: string } {
  const address = isRecord(body) && typeof body.account === "string" ? body.account.trim() : "";
  let bytes = 0;
  try {
    bytes = getBase58Encoder().encode(address).length;
  } catch {
    bytes = 0;
  }
  if (bytes !== 32) throw new ActionFailure(400, "account must be the base58 address of a Solana wallet.");
  return { address, account: `${CHAINS[solanaNetwork(record)].id}:${address}` };
}

function preparableStep(intent: IntentGraph, wanted?: string): IntentStep | null {
  const done = (step: IntentStep) => ["confirmed", "settled", "completed"].includes(step.status);
  if (wanted) return intent.steps.find((step) => step.id === wanted) ?? null;
  return intent.steps.find((step) => !done(step) && step.dependsOn.every((dependency) => {
    const parent = intent.steps.find((candidate) => candidate.id === dependency);
    return parent !== undefined && done(parent);
  })) ?? null;
}

/** Prepares one step through the prepare route's rules (use reservation, strict simulation). */
async function prepareThroughRoute(intentId: string, stepId: string): Promise<{ intent: IntentGraph; payload: StepExecutionPayload }> {
  const hold = await beforeLinkPrepare(intentId);
  try {
    const result = await prepareStep(intentId, stepId);
    hold?.succeeded();
    return { intent: result.intent, payload: result.payload };
  } catch (error) {
    await hold?.failed();
    throw error;
  }
}

export interface ActionTransaction {
  readonly type: "transaction";
  readonly transaction: string;
  readonly message: string;
  readonly links?: { readonly next: { readonly type: "post"; readonly href: string } };
}

function nextHref(record: LinkRecord, intentId: string, stepId: string, address: string): string | null {
  const token = blinkToken(record.id, intentId, stepId, address);
  return token ? `${apiOrigin()}/v1/blinks/${record.id}/next?intent=${intentId}&step=${stepId}&t=${token}` : null;
}

function stepMessage(step: IntentStep, intent: IntentGraph): string {
  const spend = step.input ? `${step.input.formatted} ${step.input.symbol}` : "";
  const receive = step.minimumOutput ? `at least ${step.minimumOutput.formatted} ${step.minimumOutput.symbol}` : "";
  const destination = step.settlement?.destinationNetwork ? ` on ${CHAINS[step.settlement.destinationNetwork].name}` : "";
  const parts = [spend ? `Spend ${spend} from ${CHAINS[step.network].name}.` : "", receive ? `Receive ${receive}${destination}.` : "", step.recipient && !intent.request.accounts.some((entry) => entry === step.recipient) ? `Paid to ${step.recipient.split(":").pop()}.` : ""];
  return parts.filter(Boolean).join(" ").slice(0, 400) || step.title.slice(0, 400);
}

/** POST /v1/blinks/{id}: plans the visitor's intent (or continues one with a token) and returns the unsigned transaction. */
export async function blinkTransaction(id: string, query: { readonly amount?: string; readonly asset?: string; readonly intent?: string; readonly step?: string; readonly t?: string }, body: unknown): Promise<ActionTransaction> {
  const now = linkClock();
  const record = await loadLink(id, now);
  const eligibility = blinkStateOf(record, now);
  if (!eligibility.enabled) throw new PlatformError("LINK_NOT_BLINK_ELIGIBLE", eligibility.reason ?? "This link cannot be used as a blink right now.", 422);
  const { address, account } = solanaAccount(record, body);
  let intentId: string;
  let stepId: string | undefined;
  if (query.intent || query.step || query.t) {
    if (!query.intent || !query.step) throw invalidRequest("intent and step go together.", [{ path: "intent", message: "Both required." }]);
    assertToken(record.id, query.intent, query.step, address, query.t);
    intentId = query.intent;
    stepId = query.step;
  } else {
    const asset = query.asset ?? eligibility.assets[0];
    if (!asset || !eligibility.assets.includes(asset)) throw new ActionFailure(422, `Choose one of ${eligibility.assets.join(", ")}.`);
    const planned = await createLinkIntent(record.id, {
      accounts: [account],
      source: { network: solanaNetwork(record), asset },
      ...(query.amount !== undefined ? { amount: query.amount } : {}),
    });
    intentId = planned.intent.id;
  }
  const intent = await getIntent(intentId);
  if (intent.metadata?.linkId !== record.id || !intent.request.accounts.some((entry) => entry === account)) throw new ActionFailure(403, "This intent does not belong to this link and account.");
  const step = preparableStep(intent, stepId);
  if (!step) throw new ActionFailure(409, "Nothing is left to sign for this intent.");
  if (CHAINS[step.network].vm !== "svm") throw new PlatformError("LINK_NOT_BLINK_ELIGIBLE", "This step is not on Solana; continue on the link page.", 422);
  const { payload } = await prepareThroughRoute(intentId, step.id);
  const transactions = payload.transactions;
  const only = transactions[0];
  if (transactions.length !== 1 || !only || only.vm !== "svm") throw new PlatformError("LINK_NOT_BLINK_ELIGIBLE", `This step needs ${transactions.length} transactions; continue on the link page.`, 422);
  const next = nextHref(record, intentId, step.id, address);
  return {
    type: "transaction",
    transaction: only.transaction,
    message: stepMessage(step, intent),
    ...(next ? { links: { next: { type: "post" as const, href: next } } } : {}),
  };
}

/** POST /v1/blinks/{id}/next: submits the signature, then the next Solana step or `completed`. */
export async function blinkNext(id: string, query: { readonly intent?: string; readonly step?: string; readonly t?: string }, body: unknown): Promise<Record<string, unknown>> {
  const record = await loadLink(id);
  if (!query.intent || !query.step) throw new ActionFailure(400, "intent and step are required.");
  const { address } = solanaAccount(record, body);
  assertToken(record.id, query.intent, query.step, address, query.t);
  const signature = isRecord(body) && typeof body.signature === "string" ? body.signature.trim() : "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/u.test(signature)) throw new ActionFailure(400, "signature must be the base58 transaction signature.");
  const submitted = await submitStep(query.intent, query.step, [signature]);
  await afterLinkSubmit(submitted);
  const base = { icon: iconOf(record), title: record.publisher.name };
  const following = preparableStep(submitted);
  if (following && CHAINS[following.network].vm === "svm" && following.id !== query.step) {
    const href = nextHref(record, submitted.id, following.id, address);
    if (href) {
      const prepareHref = href.replace(`/v1/blinks/${record.id}/next?`, `/v1/blinks/${record.id}?`);
      return {
        type: "action",
        ...base,
        description: `Step ${following.index + 1} of ${submitted.steps.length}: ${following.title}`.slice(0, 400),
        label: shortLabel(following.title),
        links: { actions: [{ type: "transaction", label: shortLabel(following.title), href: prepareHref }] },
      };
    }
  }
  const page = `${kletiaWebOrigin()}/go/${record.id}`;
  return {
    type: "completed",
    ...base,
    label: "Done",
    description: `Signed. Follow it at ${page.replace(/^https?:\/\//u, "")}.`,
  };
}

/** CAIP-2 of a link's blink cluster (X-Blockchain-Ids), without counting a view. */
export async function blinkChain(id: string): Promise<string> {
  try {
    return CHAINS[solanaNetwork(await loadLink(id))].id;
  } catch {
    return CHAINS.solana.id;
  }
}

/** Steps of a blink flow stay within the spec's chaining budget (tests). */
export const BLINK_MAX_STEPS = LINK_LIMITS.blinkMaxSteps;

/** The Solana account of an intent's request (tests). */
export function blinkAccountOf(intent: IntentGraph): string | null {
  return intent.request.accounts.find((entry) => parseAccountId(entry)?.chain.vm === "svm") ?? null;
}
