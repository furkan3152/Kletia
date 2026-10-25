/**
 * Base token, protocol, amount and constraint extraction for the
 * deterministic Base grammar.
 */
import {
  BASE_PROTOCOL_ALIASES,
  BASE_TOKEN_REGISTRY,
  normalizeBaseProtocolId,
} from "../../../networks/base/protocols.js";
import { IntentSchema, type ParsedIntent } from "./schema.js";
import {
  escapeRegExp,
  isExplicitlyNegatedAssetOccurrence,
} from "./promptEvidence.js";
import {
  explicitMaxGas,
  explicitMaxPriceImpactBps,
  isExplicitlyExcludedProtocol,
} from "./promptConstraints.js";

interface LocatedToken {
  readonly symbol: string;
  readonly index: number;
}

export function locateBaseTokens(prompt: string): LocatedToken[] {
  const aliases = Object.keys(BASE_TOKEN_REGISTRY).sort(
    (left, right) => right.length - left.length,
  );
  const located: LocatedToken[] = [];
  for (const symbol of aliases) {
    const matcher = new RegExp(
      `(^|[^a-zA-Z0-9])(${escapeRegExp(symbol)})(?=$|[^a-zA-Z0-9])`,
      "ig",
    );
    for (const match of prompt.matchAll(matcher)) {
      const index = (match.index ?? 0) + match[1].length;
      const occurrence = {
        start: index,
        end: index + match[2].length,
      };
      if (isExplicitlyNegatedAssetOccurrence(prompt, occurrence)) {
        continue;
      }
      const canonical = symbol === "USDBC" ? "USDBC" : symbol;
      if (
        !located.some(
          (entry) =>
            entry.index === index ||
            (entry.symbol === "ETH" &&
              canonical === "WETH" &&
              entry.index === index + 1),
        )
      ) {
        located.push({ symbol: canonical, index });
      }
    }
  }
  return located.sort((left, right) => left.index - right.index);
}

const BASE_PROTOCOL_PRODUCT_NAMES = [
  ["moonwell flagship vault", "moonwell-vault"],
  ["moonwell frontier vault", "moonwell-vault"],
  ["moonwell vault", "moonwell-vault"],
  ["seamless vault", "seamless-vault"],
  ["spark vault", "spark-vault"],
  ["fluid vault", "fluid-vault"],
] as const;

interface BaseProtocolMention {
  readonly alias: string;
  readonly protocolId: string;
  readonly productName: boolean;
}

function baseProtocolMentions(): BaseProtocolMention[] {
  const products = BASE_PROTOCOL_PRODUCT_NAMES.map(([alias, protocolId]) => ({
    alias,
    protocolId,
    productName: true,
  }));
  const aliases = Object.keys(BASE_PROTOCOL_ALIASES).map((alias) => ({
    alias,
    protocolId: normalizeBaseProtocolId(alias) || alias,
    productName: false,
  }));
  return [...products, ...aliases].sort(
    (left, right) => right.alias.length - left.alias.length,
  );
}

function hasExplicitBaseProtocolContext(
  prompt: string,
  mention: BaseProtocolMention,
  index: number,
): boolean {
  if (mention.productName) return true;

  const before = prompt.slice(Math.max(0, index - 72), index);
  const after = prompt.slice(
    index + mention.alias.length,
    index + mention.alias.length + 96,
  );
  const explicitSelectorBefore =
    /(?:\b(?:via|using|use|through|on|from|at)\b|üzerinden|aracılığıyla|araciligiyla|protokol\s+olarak)\s*$/iu.test(
      before,
    );
  const explicitSelectorAfter =
    /^(?:['’]?(?:da|de|ta|te|dan|den|tan|ten)|\s+(?:via|üzerinden|aracılığıyla|araciligiyla)\b)/iu.test(
      after,
    );
  if (explicitSelectorBefore || explicitSelectorAfter) return true;

  const protocolNounBefore =
    /\b(?:protocol|router|dex|exchange|market|vault|pool|protokol|yönlendirici|yonlendirici|borsa|piyasa|havuz)\s*$/iu.test(
      before,
    );
  const protocolNounAfter =
    /^\s+(?:protocol|router|dex|exchange|market|vault|pool|protokol|yönlendirici|yonlendirici|borsa|piyasa|havuz)\b/iu.test(
      after,
    );
  if (protocolNounBefore || protocolNounAfter) return true;

  // A token symbol such as AERO, WELL, MORPHO or AAVE is also present in the
  // Base asset registry. It may only select a venue through the explicit
  // connectors above, never merely because a later clause mentions a pool.
  const isTokenAlias =
    BASE_TOKEN_REGISTRY[
      mention.alias.toUpperCase() as keyof typeof BASE_TOKEN_REGISTRY
    ] !== undefined;
  if (isTokenAlias) return false;

  return /^\s+[^,;:.!?\n]{0,64}\b(?:protocol|router|dex|vault|pool|protokol|havuz(?:undan|dan|den|unda|inde|u)?)\b/iu.test(
    after,
  );
}

export function extractBaseProtocol(prompt: string): string | undefined {
  for (const mention of baseProtocolMentions()) {
    const matcher = new RegExp(
      `(^|[^a-z0-9])(${escapeRegExp(mention.alias)})(?=$|[^a-z0-9])`,
      "igu",
    );
    for (const match of prompt.matchAll(matcher)) {
      const index = (match.index ?? 0) + match[1].length;
      if (
        isExplicitlyExcludedProtocol(mention.alias, prompt) ||
        !hasExplicitBaseProtocolContext(prompt, mention, index)
      ) {
        continue;
      }
      return mention.protocolId;
    }
  }
  return undefined;
}

export function isExplicitProtocolTokenOccurrence(
  prompt: string,
  token: LocatedToken,
): boolean {
  return baseProtocolMentions().some((mention) => {
    if (
      mention.productName ||
      mention.alias.toUpperCase() !== token.symbol.toUpperCase() ||
      isExplicitlyExcludedProtocol(mention.alias, prompt)
    ) {
      return false;
    }
    const matcher = new RegExp(
      `(^|[^a-z0-9])(${escapeRegExp(mention.alias)})(?=$|[^a-z0-9])`,
      "igu",
    );
    return Array.from(prompt.matchAll(matcher)).some((match) => {
      const index = (match.index ?? 0) + match[1].length;
      return (
        index === token.index &&
        hasExplicitBaseProtocolContext(prompt, mention, index)
      );
    });
  });
}

export function extractExplicitlyExcludedBaseProtocols(prompt: string): string[] {
  const excluded = new Set<string>();
  for (const mention of baseProtocolMentions()) {
    if (isExplicitlyExcludedProtocol(mention.alias, prompt)) {
      excluded.add(mention.protocolId);
    }
  }
  return [...excluded];
}

export function attachExplicitBaseExecutionConstraints(
  intent: ParsedIntent,
  prompt: string,
): ParsedIntent {
  const maxGas = explicitMaxGas(prompt);
  const maxPriceImpactBps = explicitMaxPriceImpactBps(prompt);
  const excludedProtocols = extractExplicitlyExcludedBaseProtocols(prompt);
  return IntentSchema.parse({
    ...intent,
    ...(maxGas !== null ? { maxGas } : {}),
    ...(maxPriceImpactBps !== null ? { maxPriceImpactBps } : {}),
    ...(excludedProtocols.length > 0 ? { excludedProtocols } : {}),
  });
}

export function extractNamedBaseYieldProtocols(prompt: string): string[] {
  const definitions: readonly [RegExp, string][] = [
    [/\baave(?:\s*v3)?\b/i, "aave-v3"],
    [/\bmoonwell\b/i, "moonwell"],
    [/\bcompound(?:\s*v3)?\b/i, "compound-v3"],
    [/\bseamless(?:\s+vault)?\b/i, "seamless-vault"],
    [/\bspark(?:\s+vault)?\b/i, "spark-vault"],
    [/\bfluid(?:\s+vault)?\b/i, "fluid-vault"],
  ];
  return definitions.flatMap(([matcher, protocolId]) =>
    matcher.test(prompt) ? [protocolId] : [],
  );
}

export function extractAmount(
  prompt: string,
  tokens: readonly LocatedToken[],
): string | undefined {
  if (
    /\b(max|all|everything|tamam[ıi]|tüm|tümü|hepsi|bakiyemin tamam[ıi])\b/i.test(
      prompt,
    )
  ) {
    return "MAX";
  }
  for (const token of tokens) {
    const prefix = prompt.slice(Math.max(0, token.index - 32), token.index);
    const match = /(\d+(?:[.,]\d+)?)\s*$/.exec(prefix);
    if (match) return match[1].replace(",", ".");
  }
  const generic = /\b(\d+(?:[.,]\d+)?)\b/.exec(prompt);
  return generic?.[1].replace(",", ".");
}

export function extractAmountForToken(
  prompt: string,
  token: LocatedToken | undefined,
): string | undefined {
  if (!token) return undefined;
  const prefix = prompt.slice(Math.max(0, token.index - 32), token.index);
  const match = /(\d+(?:[.,]\d+)?)\s*$/.exec(prefix);
  return match?.[1].replace(",", ".");
}

export function extractMinimumOutputForToken(
  prompt: string,
  token: LocatedToken | undefined,
): string | undefined {
  if (!token) return undefined;
  const prefix = prompt.slice(Math.max(0, token.index - 96), token.index);
  const match =
    /(?:accept|receive)[^,;:.!?\n]{0,48}\bless\s+than\s+(\d+(?:[.,]\d+)?)\s*$/i.exec(
      prefix,
    );
  return match?.[1].replace(",", ".");
}

export function extractSlippagePercent(prompt: string): string | undefined {
  const match =
    /(?:slippage[^,;:.!?\n]{0,20}?(\d+(?:[.,]\d+)?)\s*%|(\d+(?:[.,]\d+)?)\s*%\s*slippage)/i.exec(
      prompt,
    );
  const raw = (match?.[1] || match?.[2])?.replace(",", ".");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 50 ? raw : undefined;
}

export function detectRiskTolerance(prompt: string): ParsedIntent["riskTolerance"] {
  if (
    /\b(conservative|low[- ]?risk|düşük risk|en güvenli|guvenli)\b/i.test(
      prompt,
    )
  ) {
    return "conservative";
  }
  if (
    /\b(aggressive|high[- ]?risk|yüksek risk|riskli|maksimum getiri)\b/i.test(
      prompt,
    )
  ) {
    return "aggressive";
  }
  return "balanced";
}
