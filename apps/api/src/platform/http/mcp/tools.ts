/**
 * MCP tools served at /v1/mcp. Almost every tool is read-only: it reads
 * registries, quotes, dry-run plans, intents, balances, previews, receipts,
 * rule books or the caller's contract registrations through the same engine
 * calls as the REST handlers. Two tools write, and neither moves funds:
 * `create_intent` stores an intent for the key's own signer service (Rule
 * Book, policyTools.ts) and `create_link` publishes an intent link a human
 * reviews and signs (linkTools.ts). No tool prepares, signs or submits
 * anything, and no calldata reaches an agent; `create_signing_link` hands
 * the user a Studio link to plan and sign with their own wallet. Custom contract steps (registered with the caller's
 * key) can be planned and test-simulated, never handed off: Studio is keyless,
 * so those go through sessions created by the integrator's backend.
 *
 * Outputs are compact summaries (agents pay for every token) and never carry
 * provider error text: failures become `isError` results with the stable
 * Platform API error code, message, hints and docs link.
 */
import {
  CONTRACT_ENTRY_ID_PATTERN,
  CONTRACT_ID_PATTERN,
  NETWORK_KEYS,
  sameAddressAccount,
  validateContractTestRequest,
  type AssetAmount,
  type ContractReview,
  type ContractTestResult,
  type ContractView,
  type ClarifyAssumption,
  type ClarifyQuestion,
  type IntentGraph,
  type IntentPreview,
  type IntentStep,
  type IntentTurnRequest,
  type Journey,
} from "@kletia/core";
import {
  createIntentDetailed,
  getIntent,
  INTENT_ID_PATTERN,
  journeyFor,
  listIntents,
  quoteRoutes,
  readAccountPortfolio,
  toPlatformError,
  type QuoteRoute,
} from "../../index.js";
import { assetRegistry, networkCapabilities, protocolRegistry } from "../catalog.js";
import { HttpError, invalidRequest, type ApiTier } from "../context.js";
import { createContractDirectory, getContract, keyContext, listContracts, parseContractListFilter, testContract } from "../contracts.js";
import { perpsOption, runClarifyTurn } from "../clarify.js";
import { contractTestLimiter } from "../limits.js";
import { PlatformError } from "../../errors.js";
import { JOURNEY_PLAN_DEADLINE_MS } from "../../engine/journey/facts.js";
import { errorDocsLink } from "../errorsRoute.js";
import { GET_JOURNEY_TOOL, GET_RECEIPT_TOOL, journeySummary, PREVIEW_INTENT_TOOL, previewSummary, receiptLine } from "./featureTools.js";
import { journeyReadLimiter } from "../journey.js";
import { AGENT_TOOLS } from "./agentTools.js";
import { ASK_PORTFOLIO_TOOL } from "./assistantTool.js";
import { LINK_TOOLS } from "./linkTools.js";
import { deniedPlan, POLICY_TOOLS, remainingFor, stampSummary } from "./policyTools.js";
import { HANDOFF_MAX_TEXT, signingLink } from "./handoff.js";

type JsonSchema = Record<string, unknown>;

export interface ToolCaller {
  readonly tier: ApiTier;
  readonly keyId?: string;
}

export interface ToolAnnotations {
  readonly title: string;
  /** False for the tools that store (`create_intent`, `create_link`, the sub-agent tools); none signs or sends. */
  readonly readOnlyHint: boolean;
  /** True only for `revoke_subagent` (it revokes keys). */
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface KletiaTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: ToolAnnotations;
  run(args: Record<string, unknown>, caller: ToolCaller): Promise<Record<string, unknown>>;
  /** The text content of a result, when plain JSON would read poorly (default: the result as JSON). */
  render?(value: Record<string, unknown>): string | null;
}

export interface ToolResult {
  [key: string]: unknown;
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly structuredContent: Record<string, unknown>;
  readonly isError?: true;
}

const MAX_EVIDENCE = 3;
const MAX_HOLDINGS = 25;
const MAX_TEXT_CHARS = 24_000;

const NETWORK: JsonSchema = { type: "string", enum: [...NETWORK_KEYS], description: "Kletia network key (see list_networks)." };
const ACCOUNT: JsonSchema = {
  type: "string",
  maxLength: 128,
  description: "CAIP-10 account: eip155:<chain id>:0x… or solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:<base58 address>.",
};

function annotations(title: string, openWorld: boolean, idempotent = true): ToolAnnotations {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: idempotent, openWorldHint: openWorld };
}

function amount(value: AssetAmount | undefined): string | undefined {
  return value ? `${value.formatted} ${value.symbol}` : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** What an agent needs from a review: who, what, permissions, simulated result, provenance, notices. Never calldata. */
function reviewView(review: ContractReview | undefined): Record<string, unknown> | undefined {
  if (!review) return undefined;
  return compact({
    kind: review.kind,
    integrator: review.integrator,
    notices: review.notices,
    contract: review.contract
      ? compact({
          network: review.contract.network,
          address: review.contract.address,
          source: review.contract.source,
          proxy: review.contract.proxy,
          revision: review.contract.revision,
        })
      : undefined,
    call: review.call
      ? compact({
          label: review.call.label,
          function: review.call.function,
          args: review.call.args.map((arg) => ({ name: arg.name, value: arg.display, source: arg.source })),
          value: amount(review.call.value),
        })
      : undefined,
    approvals: review.approvals.length > 0
      ? review.approvals.map((approval) => ({ token: approval.token.symbol, spender: approval.spender, amount: amount(approval.amount) }))
      : undefined,
    action: review.action
      ? compact({ url: review.action.url, domain: review.action.domain, title: review.action.title, programs: review.action.programs, instructionCount: review.action.instructionCount })
      : undefined,
    simulation: compact({
      status: review.simulation.status,
      assetChanges: review.simulation.assetChanges.map((change) => `${change.formatted} ${change.symbol}${change.listed ? "" : " (unlisted)"}`),
      networkFee: amount(review.simulation.networkFee),
      warnings: review.simulation.warnings.length > 0 ? review.simulation.warnings : undefined,
    }),
  });
}

function stepView(step: IntentStep): Record<string, unknown> {
  return compact({
    id: step.id,
    title: step.title,
    kind: step.kind,
    network: step.network,
    protocol: step.protocol,
    venue: step.venue,
    account: step.account,
    status: step.status,
    input: amount(step.input),
    expectedOutput: amount(step.expectedOutput),
    minimumOutput: amount(step.minimumOutput),
    actualOutput: amount(step.actualOutput),
    recipient: step.recipient,
    recipientName: step.recipientName,
    dependsOn: step.dependsOn.length > 0 ? step.dependsOn : undefined,
    feesUsd: step.feesUsd,
    extraCosts: step.extraCosts && step.extraCosts.length > 0 ? step.extraCosts.map((cost) => amount(cost)) : undefined,
    estimatedSeconds: step.estimatedSeconds,
    warnings: step.warnings && step.warnings.length > 0 ? step.warnings : undefined,
    references: step.references && step.references.length > 0 ? step.references : undefined,
    evidence: step.evidence.length > 0
      ? step.evidence.slice(-MAX_EVIDENCE).map((entry) => compact({ kind: entry.kind, reference: entry.reference, url: entry.url, observedAt: entry.observedAt }))
      : undefined,
    failure: step.failure,
    contract: step.call?.contract,
    entry: step.call?.entry,
    review: reviewView(step.call?.review),
  });
}

/** Compact registration for agents: entries and verification status, never ABIs or pins beyond code hashes. */
function contractSummary(view: ContractView): Record<string, unknown> {
  const evmPins = "codeHash" in view.pins ? view.pins : null;
  return compact({
    id: view.id,
    vm: view.vm,
    network: view.network,
    target: view.address ?? view.origin,
    status: view.status,
    suspendedReason: view.suspendedReason ?? undefined,
    revision: view.revision,
    activeRevision: view.activeRevision,
    pendingRevision: view.pendingRevision ?? undefined,
    activatesAt: view.activatesAt ?? undefined,
    visibility: view.visibility,
    integrator: view.integrator,
    source: view.verification.source?.status,
    implementationSource: view.verification.implementationSource?.status,
    programs: view.verification.programs?.map((program) => ({ program: program.program, verified: program.verified })),
    codeHash: evmPins?.codeHash,
    implementationCodeHash: evmPins?.proxy?.implementationCodeHash,
    definitionHash: view.definitionHash,
    entries: view.actions.map((action) =>
      compact({
        id: action.id,
        label: action.label,
        input: action.input?.token,
        verbs: action.phrases?.verbs,
        aliases: action.phrases?.aliases,
        maxAmount: action.limits?.maxAmount,
      }),
    ),
  });
}

function testView(result: ContractTestResult): Record<string, unknown> {
  return compact({
    contract: result.contract,
    revision: result.revision,
    entry: result.entry,
    network: result.network,
    account: result.account,
    input: amount(result.input),
    expectedOutput: amount(result.expectedOutput),
    minimumOutput: amount(result.minimumOutput),
    transactions: result.transactions.map((transaction) => compact({ description: transaction.description, to: transaction.to, selector: transaction.selector, value: transaction.value, programs: transaction.programs })),
    gas: result.gas,
    feesUsd: result.feesUsd,
    review: reviewView(result.review),
    warnings: result.warnings.length > 0 ? result.warnings : undefined,
  });
}

function keyRequired(tool: string, caller: ToolCaller): string {
  if (!caller.keyId) throw new HttpError(401, "API_KEY_REQUIRED", `${tool} needs an API key: connect with Authorization: Bearer <key>.`);
  return caller.keyId;
}

const CONTRACT_REFERENCE_IN_TEXT = /\bct_[0-9a-f]{24}\b/iu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Signing links lead to keyless Studio, which can never plan registered
 * contracts: refuse text that names one (an id, or an alias of the caller's
 * registrations) with a pointer to sessions.
 */
async function assertNoContractHandoff(text: unknown, caller: ToolCaller): Promise<void> {
  if (typeof text !== "string") return;
  const lower = text.toLowerCase();
  let named = CONTRACT_REFERENCE_IN_TEXT.test(lower);
  if (!named && caller.keyId) {
    const phrases = await createContractDirectory().phrases(caller.keyId).catch(() => []);
    named = phrases.some((phrase) => phrase.aliases.some((alias) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}($|[^a-z0-9])`, "u").test(lower)));
  }
  if (named) {
    throw new PlatformError(
      "CONTRACT_HANDOFF_UNSUPPORTED",
      "This intent uses a registered custom contract, which Kletia Studio (keyless) cannot plan. Create a session with POST /v1/sessions from the integrator's backend and embed it instead.",
      422,
      [{ path: "text", message: "Names a custom contract." }],
    );
  }
}

/**
 * Recipients that are not one of the request's own accounts: the user must
 * confirm them before signing. The user's own address on another network of
 * the same VM (a bridge's default recipient) is theirs, as in the planner.
 */
function externalRecipients(intent: IntentGraph): string[] {
  const own = intent.request.accounts;
  const external = intent.steps
    .map((step) => step.recipient)
    .filter((recipient): recipient is NonNullable<typeof recipient> => recipient !== undefined)
    .filter((recipient) => !own.some((account) => sameAddressAccount(account, recipient)));
  return [...new Set(external)];
}

function summaryView(intent: IntentGraph): Record<string, unknown> {
  const summary = intent.summary;
  return compact({
    title: summary.title,
    networks: summary.networks,
    inputs: summary.inputs.map((entry) => amount(entry)),
    outputs: summary.outputs.map((entry) => amount(entry)),
    totalFeesUsd: summary.totalFeesUsd,
    estimatedSeconds: summary.estimatedSeconds,
    signaturesRequired: summary.signaturesRequired,
    crossNetwork: summary.crossNetwork,
  });
}

function routeView(route: QuoteRoute): Record<string, unknown> {
  return compact({
    protocol: route.protocol,
    label: route.label,
    network: route.network,
    toNetwork: route.toNetwork,
    input: amount(route.input),
    output: amount(route.output),
    minimumOutput: amount(route.minimumOutput),
    netMinimumOutput: route.extraCosts && route.extraCosts.length > 0 ? amount(route.netMinimumOutput) : undefined,
    feesUsd: route.feesUsd,
    extraCosts: route.extraCosts && route.extraCosts.length > 0 ? route.extraCosts.map((cost) => amount(cost)) : undefined,
    estimatedSeconds: route.estimatedSeconds,
    transactionCount: route.transactionCount,
    eligible: route.eligible ? undefined : false,
    warnings: route.warnings.length > 0 ? route.warnings : undefined,
  });
}

/**
 * The journey next to get_intent: it shares GET …/journey's per-intent
 * limit, and a refused or failed read leaves it out (the intent is still
 * returned).
 */
async function intentJourney(intent: IntentGraph): Promise<Journey | null> {
  try {
    journeyReadLimiter.take(intent.id);
    return await journeyFor(intent);
  } catch {
    return null;
  }
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

/** The planned view agents read (no calldata, no quote bindings). */
async function plannedView(intent: IntentGraph, preview: IntentPreview | undefined, journey: Journey | null, caller: ToolCaller): Promise<Record<string, unknown>> {
  const remaining = intent.policy && caller.keyId ? await remainingFor(caller.keyId).catch(() => []) : [];
  return {
    dryRun: true,
    ...(intent.policy ? { policy: { ...stampSummary(intent.policy), ...(remaining.length > 0 ? { remaining } : {}) } } : {}),
    summary: summaryView(intent),
    steps: intent.steps.map(stepView),
    warnings: intent.warnings,
    externalRecipients: externalRecipients(intent),
    // The fare breakdown (stage plan): what leaves the user's wallets, what arrives, fees and needs.
    ...(preview ? { preview: previewSummary(preview) } : {}),
    // Where the money is after each step, and what the user must decide before signing.
    ...(journey ? { journey: journeySummary(journey) } : {}),
    expiresAt: intent.expiresAt,
  };
}

function questionView(question: ClarifyQuestion): Record<string, unknown> {
  return compact({
    id: question.id,
    kind: question.kind,
    reason: question.reason,
    purpose: question.purpose,
    prompt: question.prompt,
    why: question.why,
    options: question.options.map((option) => compact({ id: option.id, label: option.label, detail: option.detail, recommended: option.recommended, sentence: option.sentence })),
    allowsText: question.allowsText,
    placeholder: question.placeholder,
  });
}

function assumptionView(entry: ClarifyAssumption): Record<string, unknown> {
  return { id: entry.id, label: entry.label, reason: entry.reason, material: entry.material, alternatives: entry.alternatives.map((option) => ({ id: option.id, label: option.label })) };
}

/**
 * plan_intent with clarify (the default for text): one dry-run turn on a
 * client-held thread. MCP never remembers threads and never stores intents
 * here; needs_input is a normal result the agent relays to the person.
 */
async function clarifyPlan(args: Record<string, unknown>, caller: ToolCaller): Promise<Record<string, unknown>> {
  const { clarify: _clarify, ...request } = args;
  const response = await runClarifyTurn(request as unknown as IntentTurnRequest, {
    ...(caller.keyId ? { ownerKeyId: caller.keyId } : {}),
    ...(await perpsOption(caller.keyId)),
    dryRun: true,
    preview: true,
    thread: null,
  });
  if (response.status === "cancelled") {
    return { status: "cancelled", dryRun: true, thread: response.thread, next: "The task was cancelled. Start again with a new sentence when the person wants to." };
  }
  if (response.status === "needs_input") {
    return {
      status: "needs_input",
      dryRun: true,
      questions: response.questions.map(questionView),
      assumptions: response.assumptions.map(assumptionView),
      draft: { summary: response.draft.summary, missing: response.draft.missing },
      thread: response.thread,
      next: "Ask the person each question. Never pick an option of a question whose purpose is true yourself, and never answer a confirm (INTERPRETATION_CONFIRM) for the person: relay it, and when Kletia answers CONFIRM_AUTHORITY_REQUIRED, call create_signing_link with the original text so the person confirms in Kletia. Then call plan_intent with the same accounts, this thread and answer { question, option } (or { question, text }).",
    };
  }
  if (response.status === "handoff") {
    return {
      status: "handoff",
      dryRun: true,
      handoff: response.handoff,
      assumptions: response.assumptions.map(assumptionView),
      thread: response.thread,
      next: `Nothing was planned or stored: this is a ${response.handoff.surface} request ("${response.handoff.summary}"), which runs on its own Kletia surface, not as an intent. Tell the person the summary and every assumption, then call create_signing_link with the original text: Kletia reads it again there and sends the person to the desk view that holds it, prefilled, where they check it and sign. Never execute it yourself.`,
    };
  }
  let journey: Journey | null = null;
  try {
    journey = await journeyFor(response.intent, { preview: response.preview ?? null, reads: "live", deadlineMs: JOURNEY_PLAN_DEADLINE_MS });
  } catch {
    // The journey is advisory here; the plan stands without it.
  }
  return {
    status: "planned",
    ...(await plannedView(response.intent, response.preview, journey, caller)),
    sentence: response.sentence,
    assumptions: response.assumptions.map(assumptionView),
    thread: response.thread,
    next: "Nothing was stored. Tell the person what Kletia assumed, then call create_signing_link with text set to `sentence` and give the link to the user.",
  };
}

/** needs_input as text: the questions with numbered options and the sentence each leads to. */
function renderPlan(value: Record<string, unknown>): string | null {
  if (value.status !== "needs_input" || !Array.isArray(value.questions)) return null;
  const lines = ["Kletia needs input before it can plan this. Ask the person:"];
  (value.questions as Record<string, unknown>[]).forEach((question, index) => {
    lines.push(`${index + 1}. ${String(question.prompt)} (${String(question.why)}) [question ${String(question.id)}${question.purpose ? ", the person must answer" : ""}]`);
    ((question.options as Record<string, unknown>[] | undefined) ?? []).forEach((option, number) => {
      const extra = [option.detail ? String(option.detail) : "", option.recommended ? "suggested" : "", option.sentence ? `leads to "${String(option.sentence)}"` : ""].filter(Boolean).join("; ");
      lines.push(`   ${number + 1}) ${String(option.label)} [option ${String(option.id)}]${extra ? `: ${extra}` : ""}`);
    });
    if (question.allowsText) lines.push(`   or a typed answer${question.placeholder ? ` (${String(question.placeholder)})` : ""}`);
  });
  lines.push("Send the answer to plan_intent with the thread from structuredContent.");
  return lines.join("\n");
}

export const KLETIA_TOOLS: readonly KletiaTool[] = Object.freeze([
  {
    name: "list_networks",
    description:
      "List the networks Kletia supports, with the actions and protocols it can execute on each (source network → destination networks). Call this first to learn valid network keys.",
    inputSchema: {
      type: "object",
      properties: { environment: { type: "string", enum: ["mainnet", "testnet"], description: "Only mainnet or only testnet networks." } },
      additionalProperties: false,
    },
    annotations: annotations("List networks", false),
    async run(args) {
      const environment = stringArg(args, "environment");
      const networks = networkCapabilities()
        .filter((network) => !environment || network.environment === environment)
        .map((network) => ({
          key: network.key,
          id: network.id,
          name: network.name,
          vm: network.vm,
          environment: network.environment,
          nativeAsset: network.nativeAsset.symbol,
          actions: network.actions,
          executableProtocols: network.executableProtocols,
          routes: network.routes,
        }));
      return { networks };
    },
  },
  {
    name: "list_protocols",
    description: "List the protocols in Kletia's registry (DEX aggregators, bridges, lending, liquid staking, ...) and whether Kletia can execute each one.",
    inputSchema: {
      type: "object",
      properties: {
        network: NETWORK,
        executableOnly: { type: "boolean", description: "Only protocols Kletia can execute (default true)." },
      },
      additionalProperties: false,
    },
    annotations: annotations("List protocols", false),
    async run(args) {
      const network = stringArg(args, "network");
      const executableOnly = args.executableOnly !== false;
      const protocols = protocolRegistry()
        .filter((protocol) => (!executableOnly || protocol.executable) && (!network || protocol.networks.some((key) => key === network)))
        .map((protocol) => ({
          id: protocol.id,
          name: protocol.name,
          category: protocol.category,
          networks: protocol.networks,
          executable: protocol.executable,
          summary: protocol.summary,
        }));
      return { protocols };
    },
  },
  {
    name: "list_assets",
    description: "List the canonical assets Kletia knows on one network (symbol, address or mint, decimals). Other tokens can be named by address or mint.",
    inputSchema: { type: "object", properties: { network: NETWORK }, required: ["network"], additionalProperties: false },
    annotations: annotations("List assets", false),
    async run(args) {
      const assets = assetRegistry(stringArg(args, "network")).map((asset) =>
        compact({ symbol: asset.symbol, name: asset.name, decimals: asset.decimals, address: asset.address ?? "native", category: asset.category, id: asset.id }),
      );
      return { assets };
    },
  },
  {
    name: "get_quote",
    description:
      "Quote routes for moving one asset: a swap on one network, or a bridge (optionally with a swap) to another network. Quotes are advisory and nothing is stored. Without `account`, Kletia prices with a neutral stand-in sender.",
    inputSchema: {
      type: "object",
      properties: {
        network: NETWORK,
        from: { type: "string", minLength: 1, maxLength: 128, description: "Input asset on `network`: symbol, address or mint." },
        to: { type: "string", minLength: 1, maxLength: 128, description: "Output asset (on `toNetwork` when bridging)." },
        amount: { type: "string", pattern: "^(0|[1-9][0-9]*)(\\.[0-9]+)?$", description: "Decimal amount of `from`, e.g. \"25\" or \"0.5\"." },
        toNetwork: NETWORK,
        account: ACCOUNT,
        recipient: { type: "string", maxLength: 128, description: "Recipient address or CAIP-10 account (defaults to the sender)." },
        slippageBps: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["network", "from", "to", "amount"],
      additionalProperties: false,
    },
    annotations: annotations("Quote routes", true, false),
    async run(args) {
      const result = await quoteRoutes(args);
      return {
        best: result.best ? routeView(result.best) : null,
        routes: result.routes.map(routeView),
        unavailable: result.unavailable.map((entry) => ({ protocol: entry.protocol, code: entry.code })),
        quotedAt: result.quotedAt,
      };
    },
  },
  {
    name: "plan_intent",
    description:
      "Plan an intent as a dry run: compile plain English such as \"bridge 25 USDC from base to solana then swap half to JitoSOL\" (or structured actions) into network-bound steps with live quotes. Nothing is stored and nothing can be signed from the result. " +
      "Kletia asks when a sentence leaves out something that decides where money goes or how much (status needs_input, a normal result, not an error): " +
      "when status is needs_input, ask the person. Never answer a question whose purpose is true yourself; you may accept a suggested option for other questions only when the person told you to go with Kletia's suggestions. " +
      "Send the answer back with the returned `thread` as `answer` { question, option } (or { question, text }), or send an option's `sentence` as new text. " +
      "When status is planned, tell the person about every assumption, and about every `block` consequence of `journey` and ask its question. Review `externalRecipients`, then call create_signing_link with `sentence` so the user signs in Kletia Studio. Set clarify to false (or send actions) for the strict planner, which refuses incomplete sentences.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 1000, description: "The intent in plain English, or a reply on a thread (\"50\", \"make it 2\", \"cancel\")." },
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          description: "Structured alternative to `text` (planned strictly, never asked about).",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", maxLength: 16, description: "swap, transfer, bridge, stake, deposit, …, or call / action for a registered custom contract." },
              network: NETWORK,
              from: { type: "string", maxLength: 128 },
              to: { type: "string", maxLength: 128 },
              amount: { type: "string", maxLength: 40 },
              toNetwork: NETWORK,
              recipient: { type: "string", maxLength: 128 },
              protocol: { type: "string", maxLength: 40 },
              contract: {
                type: "string",
                maxLength: 64,
                description: "Custom contract steps (kind call or action): a registration id (ct_…) or alias of the connecting key (see list_contracts).",
              },
              entry: { type: "string", pattern: CONTRACT_ENTRY_ID_PATTERN.source, description: "The registration's action id, e.g. deposit." },
              params: {
                type: "object",
                maxProperties: 10,
                additionalProperties: { type: ["string", "number", "boolean"] },
                description: "Action options, e.g. { \"venue\": \"<venue slug>\" } for deposits and withdrawals.",
              },
            },
            required: ["kind", "network"],
            additionalProperties: false,
          },
        },
        accounts: { type: "array", minItems: 1, maxItems: 6, items: ACCOUNT, description: "The user's accounts, one per network family involved." },
        defaultNetwork: NETWORK,
        constraints: {
          type: "object",
          properties: {
            maxSlippageBps: { type: "integer", minimum: 1, maximum: 1000 },
            maxFeeUsd: { type: "number", minimum: 0 },
            allowTestnets: { type: "boolean" },
          },
          additionalProperties: false,
        },
        clarify: { type: "boolean", description: "Ask instead of refusing an incomplete sentence (default true)." },
        thread: {
          type: "object",
          description: "The `thread` of the previous plan_intent result, exactly as returned (kletia.thread/v1). Send it with `answer`, `assumption` or a follow-up `text`.",
        },
        answer: {
          type: "object",
          properties: {
            question: { type: "string", maxLength: 96, description: "The question id (q.…)." },
            option: { type: "string", maxLength: 128, description: "The id of the option the person chose." },
            text: { type: "string", minLength: 1, maxLength: 1000, description: "The person's own answer, when the question allows text." },
          },
          required: ["question"],
          additionalProperties: false,
        },
        assumption: {
          type: "object",
          properties: { id: { type: "string", maxLength: 96, description: "The assumption id (a.…)." }, option: { type: "string", maxLength: 128, description: "One of its alternatives." } },
          required: ["id", "option"],
          additionalProperties: false,
        },
      },
      required: ["accounts"],
      additionalProperties: false,
    },
    annotations: annotations("Plan an intent (dry run)", true, false),
    async run(args, caller) {
      const clarify = args.clarify !== false && args.actions === undefined;
      if (!clarify && typeof args.text !== "string" && !Array.isArray(args.actions)) {
        throw invalidRequest("Provide text or actions.", [{ path: "text", message: "Required unless actions are given." }]);
      }
      if (!clarify && (args.thread !== undefined || args.answer !== undefined || args.assumption !== undefined)) {
        throw invalidRequest("thread, answer and assumption need clarify (and text, not actions).", [{ path: "clarify", message: "Must not be false with a thread." }]);
      }
      // With a key, the caller's registered contracts (ids, aliases) plan too, as a dry run, and its rule book judges the plan.
      try {
        if (clarify) return await clarifyPlan(args, caller);
        const { clarify: _clarify, ...request } = args;
        const planned = await createIntentDetailed(request, { dryRun: true, preview: true, journey: true, ...(caller.keyId ? { ownerKeyId: caller.keyId } : {}) });
        return {
          ...(await plannedView(planned.intent, planned.preview, planned.journey ?? null, caller)),
          next: "Nothing was stored. To execute, call create_signing_link with the same text and give the link to the user.",
        };
      } catch (error) {
        // A refusal of the rule book is an answer, not an error: the agent sees the rule ids it broke.
        const denied = caller.keyId ? deniedPlan(error) : null;
        if (!denied) throw error;
        return {
          dryRun: true,
          planned: false,
          policy: denied,
          next: "The rule book of this key refused the plan. Change the request so it fits every rule listed; splitting amounts or adding accounts does not help.",
        };
      }
    },
    render: renderPlan,
  },
  {
    name: "get_intent",
    description: "Read a stored intent by id: status, steps, amounts, recipients, on-chain evidence, its journey (where the money is now and what follows) and whether its verifiable receipt is issued.",
    inputSchema: {
      type: "object",
      properties: { intentId: { type: "string", pattern: INTENT_ID_PATTERN.source, description: "int_ followed by 32 hex characters." } },
      required: ["intentId"],
      additionalProperties: false,
    },
    annotations: annotations("Read an intent", false),
    async run(args) {
      const intent = await getIntent(stringArg(args, "intentId") ?? "");
      const journey = await intentJourney(intent);
      return {
        id: intent.id,
        status: intent.status,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
        expiresAt: intent.expiresAt,
        summary: summaryView(intent),
        steps: intent.steps.map(stepView),
        warnings: intent.warnings,
        externalRecipients: externalRecipients(intent),
        ...(intent.policy ? { policy: stampSummary(intent.policy) } : {}),
        ...(journey ? { journey: journeySummary(journey) } : {}),
        receipt: await receiptLine(intent.id),
      };
    },
  },
  {
    name: "list_intents",
    description: "List the most recent intents created with the API key this MCP connection authenticates with (requires an API key).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10." } },
      additionalProperties: false,
    },
    annotations: annotations("List intents", false),
    async run(args, caller) {
      if (!caller.keyId) {
        throw new HttpError(401, "API_KEY_REQUIRED", "list_intents needs an API key: connect with Authorization: Bearer <key>.");
      }
      const limit = typeof args.limit === "number" ? args.limit : 10;
      const intents = await listIntents(caller.keyId, limit);
      return {
        intents: intents.map((intent) => ({ id: intent.id, status: intent.status, title: intent.summary.title, createdAt: intent.createdAt })),
      };
    },
  },
  {
    name: "get_portfolio",
    description:
      "Read balances (with USD values and their price source where priced) for one CAIP-10 account on its network; with `positions: true` also its lending, savings and vault positions (aTokens, Comet balances, vault shares), valued in the underlying.",
    inputSchema: {
      type: "object",
      properties: { accountId: ACCOUNT, positions: { type: "boolean", description: "Also read venue positions (slower)." } },
      required: ["accountId"],
      additionalProperties: false,
    },
    annotations: annotations("Read a portfolio", true),
    async run(args) {
      const portfolio = await readAccountPortfolio(stringArg(args, "accountId") ?? "", { positions: args.positions === true });
      return {
        account: portfolio.account,
        network: portfolio.network,
        totalUsd: portfolio.totalUsd,
        holdings: portfolio.holdings
          .slice(0, MAX_HOLDINGS)
          .map((holding) => compact({ symbol: holding.symbol, amount: holding.formatted, usd: holding.usd ?? undefined, priceSource: holding.priceSource, asset: holding.asset, verified: holding.verified })),
        omittedHoldings: Math.max(0, portfolio.holdings.length - MAX_HOLDINGS),
        unpricedCount: portfolio.unpricedCount,
        ...(portfolio.positions
          ? {
              positions: portfolio.positions.map((position) =>
                compact({
                  venue: position.venue,
                  name: position.name,
                  protocol: position.protocol,
                  holds: `${position.receipt.formatted} ${position.receipt.symbol}`,
                  worth: `${position.underlying.formatted} ${position.underlying.symbol}`,
                  usd: position.usd ?? undefined,
                  apy: position.apy ?? undefined,
                  withdrawableNow: position.withdrawableNow ? `${position.withdrawableNow.formatted} ${position.withdrawableNow.symbol}` : undefined,
                }),
              ),
              positionsUnavailable: (portfolio.positionsUnavailable ?? []).map((entry) => ({ venue: entry.venue, code: entry.code })),
            }
          : {}),
        observedAt: portfolio.observedAt,
      };
    },
  },
  {
    name: "create_signing_link",
    description:
      `Create a Kletia Studio link for the user to execute an intent with their own wallet. Studio plans the text again with the user's connected accounts, shows every step and recipient for review, and asks the wallet to sign. No tool here moves funds; this is the only way to execute. Text: at most ${HANDOFF_MAX_TEXT} characters.`,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: HANDOFF_MAX_TEXT, description: "The intent in plain English, as accepted by plan_intent." } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: annotations("Create a signing link", false),
    async run(args, caller) {
      const link = signingLink(args.text);
      await assertNoContractHandoff(link.text, caller);
      return { ...link };
    },
  },
  {
    name: "list_contracts",
    description:
      "List the custom contracts and Solana Actions registered with the API key this MCP connection authenticates with (and project-visible ones of its project): status, entries with their verbs and aliases, source and domain verification. Requires an API key. Kletia has not audited these contracts.",
    inputSchema: {
      type: "object",
      properties: {
        network: NETWORK,
        status: { type: "string", enum: ["pending", "active", "suspended"] },
      },
      additionalProperties: false,
    },
    annotations: annotations("List contract registrations", false),
    async run(args, caller) {
      const keyId = keyRequired("list_contracts", caller);
      const filter = parseContractListFilter({ network: stringArg(args, "network"), status: stringArg(args, "status") });
      const views = await listContracts(await keyContext(caller.tier, keyId), filter);
      return { contracts: views.map(contractSummary) };
    },
  },
  {
    name: "get_contract",
    description: "Read one custom contract registration (ct_…) of the connecting API key or its project: status, entries, verification and code hashes. Requires an API key.",
    inputSchema: {
      type: "object",
      properties: { contractId: { type: "string", pattern: CONTRACT_ID_PATTERN.source, description: "ct_ followed by 24 hex characters." } },
      required: ["contractId"],
      additionalProperties: false,
    },
    annotations: annotations("Read a contract registration", false),
    async run(args, caller) {
      const keyId = keyRequired("get_contract", caller);
      const id = stringArg(args, "contractId") ?? "";
      if (!CONTRACT_ID_PATTERN.test(id)) throw invalidRequest("contractId must be ct_ followed by 24 hex characters.", [{ path: "contractId", message: "Invalid contract id." }]);
      return contractSummary(await getContract(await keyContext(caller.tier, keyId), id));
    },
  },
  {
    name: "test_contract_action",
    description:
      "Dry-run one entry of a custom contract registration for an account: Kletia builds and simulates the call (EVM) or fetches and simulates the Solana Action, then returns the review (approvals, simulated asset changes, notices). Nothing is stored or signed and no calldata is returned. Requires an API key; at most 20 tests per minute per key.",
    inputSchema: {
      type: "object",
      properties: {
        contractId: { type: "string", pattern: CONTRACT_ID_PATTERN.source },
        entry: { type: "string", pattern: CONTRACT_ENTRY_ID_PATTERN.source, description: "Action id of the registration, e.g. deposit." },
        account: ACCOUNT,
        amount: { type: "string", pattern: "^(0|[1-9][0-9]*)(\\.[0-9]+)?$", description: "Decimal amount of the entry's input token." },
        params: { type: "object", maxProperties: 8, additionalProperties: { type: ["string", "number", "boolean"] } },
      },
      required: ["contractId", "entry", "account"],
      additionalProperties: false,
    },
    annotations: annotations("Simulate a contract action", true, false),
    async run(args, caller) {
      const keyId = keyRequired("test_contract_action", caller);
      const id = stringArg(args, "contractId") ?? "";
      if (!CONTRACT_ID_PATTERN.test(id)) throw invalidRequest("contractId must be ct_ followed by 24 hex characters.", [{ path: "contractId", message: "Invalid contract id." }]);
      const { contractId: _contractId, ...rest } = args;
      const parsed = validateContractTestRequest(rest);
      if (!parsed.ok) throw invalidRequest("The test request is invalid.", parsed.issues);
      contractTestLimiter.take(keyId);
      return testView(await testContract(await keyContext(caller.tier, keyId), id, parsed.value));
    },
  },
  PREVIEW_INTENT_TOOL,
  GET_JOURNEY_TOOL,
  GET_RECEIPT_TOOL,
  ASK_PORTFOLIO_TOOL,
  ...POLICY_TOOLS,
  ...LINK_TOOLS,
  ...AGENT_TOOLS,
] satisfies KletiaTool[]);

function textOf(value: Record<string, unknown>): string {
  const text = JSON.stringify(value);
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}… (truncated; see structuredContent)` : text;
}

/** Runs one tool and shapes the MCP result; failures become `isError` results with the API error code. */
export async function runTool(tool: KletiaTool, args: Record<string, unknown>, caller: ToolCaller): Promise<ToolResult> {
  try {
    const value = await tool.run(args, caller);
    return { content: [{ type: "text", text: tool.render?.(value) ?? textOf(value) }], structuredContent: value };
  } catch (error) {
    const failure = error instanceof HttpError ? error : toPlatformError(error);
    const docs = errorDocsLink(failure.code);
    const hints = "hints" in failure && failure.hints ? failure.hints : undefined;
    // Rule Book refusals carry error.policy (decision id, rule ids, retryAt, approval link).
    const policy = (failure as { readonly policy?: unknown }).policy;
    const structured = {
      error: compact({ code: failure.code, message: failure.message, issues: failure.issues, hints, docs, policy }),
    };
    return { isError: true, content: [{ type: "text", text: `${failure.code}: ${failure.message}` }], structuredContent: structured };
  }
}
