/**
 * The assistant (docs/platform/assistant.md): one question about the
 * caller's own wallets in, one grounded answer out.
 *
 * Order: refusals first (keys and seed phrases, instructions aimed at the
 * assistant, any wallet outside the caller's set) -> route
 * (`assistantRouteOf`) -> a portfolio request that wants action becomes
 * sentences (actions.ts) -> otherwise the deterministic parser, and only when
 * it cannot read the question and the caller consented, the model's reading
 * (checked against the query shape) -> the query runs in code (execute.ts)
 * -> the template answer, or with consent the model's wording when every
 * number, asset, network and date in it matches the facts.
 */
import {
  assistantRouteOf,
  isEvmAddress,
  isSolanaAddress,
  parseAccountId,
  type AssistantAnswer,
  type AssistantQuery,
  type AssistantRoute,
  type AssistantWalletLabel,
  type DataWalletSet,
} from "@kletia/core";
import { runAction } from "./actions.js";
import type { AssistantDataPort } from "./dataPort.js";
import { executeQuery, type ExecContext } from "./execute.js";
import { checkGrounding, groundingContext } from "./grounding.js";
import type { AssistantModel, ModelScope } from "./model.js";
import { normalizeQuestion, parseQuestion, type ParsedQuestion } from "./parse.js";
import { resolveWindow, type WindowSpec } from "./windows.js";

export interface AskInput {
  readonly question: string;
  readonly set: DataWalletSet;
  readonly port: AssistantDataPort;
  /** The model steps, when the switch is on and the caller consented; null otherwise. */
  readonly model: { readonly model: AssistantModel; readonly scope: ModelScope } | null;
  /** Why the model is not used ("off", "no-consent"), said when a question needs it. */
  readonly modelUnavailable?: "off" | "no-consent";
  readonly now?: number;
}

const KEYS = /\b(?:private\s+keys?|seed\s+(?:phrase|words)|secret\s+(?:key|phrase|recovery)|mnemonic|recovery\s+(?:phrase|words)|keystore|passphrase|wallet\s+password)\b/u;
const INSTRUCTIONS = /\b(?:your\s+(?:instructions|rules|prompt)|ignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier)|system\s+prompt|developer\s+mode|jailbreak|reveal\s+your|you\s+are\s+now|act\s+as|pretend\s+to\s+be|disregard\s+(?:the|your|all))\b/u;
const OTHER_PEOPLE = /\b(?:someone\s+else'?s?|somebody\s+else'?s?|another\s+(?:person|user|wallet|account)'?s?|other\s+(?:people|users)'?s?|my\s+(?:friend|wife|husband|brother|sister|boss|colleague|partner|dad|mom|mother|father)'?s?|vitalik|whales?'?)\b/u;
/** "how much eth does bob have", "what's bob's balance": a question about someone else. */
const OTHER_SUBJECT = /\b(?:does|did|has)\s+(?!i\b|it\b|my\b|the\b|this\b|that\b|kletia\b)[a-z]+\s+(?:have|hold|own|earn|spend|pay|bridge|swap)\b|\b(?!what|that|it|let|today|there|here|who|where|how)[a-z]+'s\s+(?:wallets?|portfolio|balances?|holdings|positions?|address|transactions|net\s+worth)\b/u;
/** Advice and predictions: the assistant reads data, it does not recommend or forecast. */
/** "show my predictions" is about prediction-market positions; "predict", "your predictions" and price predictions are forecasts. */
const ADVICE = /\b(?:should\s+i|is\s+it\s+(?:a\s+)?(?:good|bad)\s+(?:time|idea)|will\s+[a-z0-9]+\s+(?:go|pump|dump|rise|fall|moon|crash)|predict(?:s|ed|ing)?|(?:your|price)\s+predictions?|price\s+target|financial\s+advice|what\s+(?:should|to)\s+(?:i\s+)?buy|worth\s+buying)\b/u;
const NAME = /\b[a-z0-9-]+\.(?:eth|sol)\b/iu;

export const EXAMPLE_QUESTIONS = Object.freeze([
  "What's my biggest position?",
  "How much did I spend on fees last month?",
  "Did I bridge to Solana this week?",
  "How is my Aave loan doing?",
]);

/** "EVM wallet 1", "Solana wallet 1": what answers and the model see instead of addresses. */
export function walletLabels(set: Pick<DataWalletSet, "evm" | "solana">): AssistantWalletLabel[] {
  return [
    ...set.evm.map((address, index) => ({ label: `EVM wallet ${index + 1}`, address, vm: "evm" as const })),
    ...set.solana.map((address, index) => ({ label: `Solana wallet ${index + 1}`, address, vm: "solana" as const })),
  ];
}

function ownAddress(set: DataWalletSet, address: string): boolean {
  return set.solana.includes(address) || set.evm.some((evm) => evm.toLowerCase() === address.toLowerCase());
}

/** A refusal reason, or null: keys, instructions to the assistant, other people's wallets. */
export function refusalOf(question: string, set: DataWalletSet): string | null {
  const sentence = normalizeQuestion(question);
  if (KEYS.test(sentence)) return "Kletia never holds, shows or asks for private keys or seed phrases, so it cannot reveal them. Keep them offline; nobody from Kletia will ever ask for them.";
  if (INSTRUCTIONS.test(sentence)) return "I answer questions about your own wallets from Kletia's data, and I don't follow instructions inside a question.";
  if (ADVICE.test(sentence)) return "I answer from your wallets' data and don't give investment advice or price predictions. I can show what you hold, what it earned and how it changed.";
  const addresses = [...question.matchAll(/\b0x[0-9a-fA-F]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/gu)].map((match) => match[0]).filter((word) => isEvmAddress(word) || isSolanaAddress(word));
  if (addresses.some((address) => !ownAddress(set, address)) || NAME.test(question) || OTHER_PEOPLE.test(sentence) || OTHER_SUBJECT.test(sentence)) {
    return "I only answer about the wallets you are signed in with (or that your API key may read). Ask about your own wallets.";
  }
  return null;
}

function labeller(set: DataWalletSet, labels: readonly AssistantWalletLabel[]): (subject: string) => string {
  const labelOf = (address: string) => labels.find((entry) => entry.address.toLowerCase() === address.toLowerCase())?.label ?? "A wallet";
  return (subject) => {
    const account = parseAccountId(subject);
    if (account) return `${labelOf(account.address)} on ${account.chain.name}`;
    return labels.reduce((text, entry) => text.split(entry.address).join(entry.label), subject).replace(/\b0x[0-9a-fA-F]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/gu, "a wallet");
  };
}

/** The window the query runs over: the one said, else a default per subject (said in the answer when assumed). */
function windowFor(parsed: ParsedQuestion): WindowSpec | null {
  if (parsed.window) return parsed.window;
  if (parsed.query.subject === "pnl" && parsed.query.aggregate !== "total") return { name: "last_days", days: 30, assumed: true };
  if (parsed.query.subject === "pnl" || parsed.query.subject === "earnings" || parsed.query.subject === "transactions" || parsed.query.subject === "fees") return { name: "all" };
  return null;
}

function needsModelText(reason: AskInput["modelUnavailable"]): string {
  const how = reason === "no-consent"
    ? "Turn on model help for this session to let a model read it (only the question, with addresses masked, is sent)."
    : "Model-assisted answers are not available here.";
  return `Kletia's parser could not read this question. ${how} You can also ask, for example: "${EXAMPLE_QUESTIONS[0]}"`;
}

/** Answers one question. Never throws for a question it cannot answer: that is a status. */
export async function ask(input: AskInput): Promise<AssistantAnswer> {
  const now = input.now ?? Date.now();
  const asOf = new Date(now).toISOString();
  const wallets = walletLabels(input.set);
  const ctx: ExecContext = { set: input.set, port: input.port, labelOf: labeller(input.set, wallets) };
  const base = { facts: [], query: null, followUps: [], assumptions: [], gaps: [], wording: "template" as const, understoodBy: null, wallets, asOf };
  const refusal = refusalOf(input.question, input.set);
  const route: AssistantRoute = assistantRouteOf(input.question) ?? "portfolio-question";
  if (refusal) return { ...base, route, status: "refused", text: refusal, followUps: EXAMPLE_QUESTIONS.slice(0, 2) };

  if (route === "portfolio-action") {
    const done = await runAction(input.question, ctx, now);
    const { action, assumptions, ...rest } = done;
    return { ...base, ...rest, route, assumptions, understoodBy: "parser", ...(action ? { action } : {}), followUps: done.followUps.length ? done.followUps : ["Show my portfolio"] };
  }

  let parsed = parseQuestion(input.question, route);
  let understoodBy: AssistantAnswer["understoodBy"] = parsed ? "parser" : null;
  if (!parsed && input.model) {
    parsed = await input.model.model.understand(input.question, input.model.scope);
    if (parsed) understoodBy = "model";
  }
  if (!parsed) {
    return { ...base, route, status: input.model ? "unknown" : "needs-model", text: input.model ? `I could not read this question. You can ask, for example: "${EXAMPLE_QUESTIONS[0]}"` : needsModelText(input.modelUnavailable), followUps: EXAMPLE_QUESTIONS.slice(0, 3) };
  }
  const spec = windowFor(parsed);
  const window = spec ? resolveWindow(spec, now) : undefined;
  const query: AssistantQuery = { ...parsed.query, ...(window ? { window } : {}) };
  const result = await executeQuery(query, ctx);
  const assumptions = window?.assumed ? [`Read as ${window.label}, since the question did not say an exact period.`] : [];
  let text = result.text;
  let wording: AssistantAnswer["wording"] = "template";
  if (input.model && result.facts.length > 0 && result.status !== "refused") {
    const phrased = await input.model.model.phrase({ question: input.question, facts: result.facts.map((fact) => ({ label: fact.label, value: fact.value })), gaps: result.gaps, assumptions }, input.model.scope);
    if (phrased && checkGrounding(phrased, result.facts, groundingContext(query, assumptions)).ok) {
      text = phrased;
      wording = "model";
    }
  }
  return {
    ...base,
    route,
    status: result.status,
    text,
    facts: result.facts,
    query,
    ...(result.table ? { table: result.table } : {}),
    ...(result.chart ? { chart: result.chart } : {}),
    followUps: result.followUps.slice(0, 3),
    assumptions,
    gaps: result.gaps,
    wording,
    understoodBy,
  };
}
