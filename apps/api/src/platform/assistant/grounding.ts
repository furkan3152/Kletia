/**
 * The grounding rule (docs/platform/assistant.md): every number, asset,
 * network, month, address and link in an answer must come from the computed
 * facts. A model's wording is checked here and replaced by the template when
 * anything does not match; the eval runs the same check on every answer.
 */
import { CHAINS, getProtocol, LENDING_HEALTH_THRESHOLDS, NETWORK_KEYS, type AssistantFact, type AssistantQuery } from "@kletia/core";
import { SYMBOLS } from "./parse.js";

/** Numbers the templates use as rules, not data: liquidation at 1 (and the $1 minimum move), the health thresholds, "24 hours". */
const CONSTANTS: readonly number[] = [1, LENDING_HEALTH_THRESHOLDS.warning, LENDING_HEALTH_THRESHOLDS.critical, 24];
/** Month names as written in dates ("May" is left out: it is also a verb). */
const MONTHS = /\b(?:January|February|March|April|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/gu;
const NUMBER = /(?<![\p{L}_])[-+]?\$?\d[\d,]*(?:\.\d+)?%?/gu;
const NETWORK_NAMES = [...new Set(NETWORK_KEYS.flatMap((key) => [CHAINS[key].name, CHAINS[key].shortName]))].filter((name) => name.length > 2);

function numbersIn(text: string): number[] {
  return [...text.matchAll(NUMBER)].map((match) => Number(match[0].replace(/[$,%+]/gu, ""))).filter(Number.isFinite);
}

/**
 * What an answer may repeat besides its facts: the window's label, the
 * assumptions stated, and the networks, assets and venues the question
 * itself named (as the query read them).
 */
export function groundingContext(query: AssistantQuery | null, assumptions: readonly string[]): string[] {
  const filter = query?.filter ?? {};
  return [
    query?.window?.label ?? "",
    ...assumptions,
    ...[...(filter.networks ?? []), ...(filter.destinations ?? [])].map((network) => CHAINS[network].name),
    ...(filter.assets ?? []),
    ...(filter.protocols ?? []).map((protocol) => getProtocol(protocol)?.name ?? protocol),
  ];
}

export interface GroundingResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Checks `text` against the facts (and the window and assumption labels the
 * answer may repeat): numbers (signs aside) must be printed in a fact,
 * listed symbols, network names and months must appear in one, and
 * addresses, names and links are never allowed.
 */
export function checkGrounding(text: string, facts: readonly AssistantFact[], extra: readonly string[] = [], options: { readonly quotedExamples?: boolean } = {}): GroundingResult {
  // A template's quoted example sentences ("rebalance my portfolio to 60/40 ...") are suggestions to type, not claims.
  if (options.quotedExamples) text = text.replace(/"[^"]{1,160}"/gu, "\"\"");
  const sources = [...facts.flatMap((fact) => [fact.label, fact.value]), ...extra].join(" \n ");
  const lower = sources.toLowerCase();
  const allowed = new Set<number>([...CONSTANTS, ...numbersIn(sources).flatMap((value) => [value, Math.abs(value)])]);
  const problems: string[] = [];
  for (const value of numbersIn(text)) if (!allowed.has(Math.abs(value)) && !allowed.has(value)) problems.push(`number ${value}`);
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9.]*/gu)) {
    const word = match[0].replace(/\.$/u, "");
    if (SYMBOLS.has(word.toLowerCase()) && word.length > 1 && word === word.toUpperCase() && !new RegExp(`\\b${word.replace(/\./gu, "\\.")}\\b`, "iu").test(sources)) problems.push(`asset ${word}`);
  }
  for (const name of NETWORK_NAMES) if (new RegExp(`\\b${name}\\b`, "u").test(text) && !lower.includes(name.toLowerCase())) problems.push(`network ${name}`);
  for (const match of text.matchAll(MONTHS)) if (!lower.includes(match[0].toLowerCase().slice(0, 3))) problems.push(`month ${match[0]}`);
  if (/\b0x[0-9a-f]{6,}/iu.test(text) || /\b[1-9A-HJ-NP-Za-km-z]{25,}\b/u.test(text)) problems.push("address");
  if (/\b[\w-]+\.(?:eth|sol)\b/iu.test(text)) problems.push("name");
  if (/https?:\/\/|www\./iu.test(text)) problems.push("link");
  return { ok: problems.length === 0, problems };
}
