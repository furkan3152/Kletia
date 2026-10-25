/**
 * Prompt evidence helpers: asset occurrences, decimals, addresses, URLs,
 * JSON objects and the actions a prompt names.
 */
import type { NetworkId } from "../../config/networks.js";
import { assetAliasesForSymbol } from "../../assets/catalog.js";
import type { ParsedIntent } from "./schema.js";

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface PromptAssetOccurrence {
  readonly start: number;
  readonly end: number;
}

export function promptAssetOccurrences(
  reference: string,
  text: string,
): PromptAssetOccurrence[] {
  const phrase = escapeRegExp(reference).replace(/\s+/g, "\\s+");
  const matcher = new RegExp(
    `(^|[^\\p{L}\\p{N}_])(${phrase})(?=$|[^\\p{L}\\p{N}_])`,
    "giu",
  );
  return Array.from(text.matchAll(matcher)).map((match) => {
    const start = (match.index ?? 0) + match[1].length;
    return { start, end: start + match[2].length };
  });
}

export function isExplicitlyNegatedAssetOccurrence(
  text: string,
  occurrence: PromptAssetOccurrence,
): boolean {
  const before = text.slice(
    Math.max(0, occurrence.start - 64),
    occurrence.start,
  );
  const after = text.slice(occurrence.end, occurrence.end + 64);
  return (
    /(?:\b(?:not|no|without|except|exclude|avoid)\b|hariç|haric|kullanma|kullanmayın|kullanmayin)\s*(?:(?:the|a|an)\s+)?(?:(?:token|asset|coin)\s+)?$/iu.test(
      before,
    ) ||
    /(?:\b(?:do\s+not|don['’]?t)\s+(?:use|select|choose|include|route\s+through)\s+)$/iu.test(
      before,
    ) ||
    /^\s*(?:['’]?(?:yi|yı|yu|yü|i|ı|u|ü))?\s*(?:değil|degil|hariç|haric|yerine|olmasın|olmasin|kullanma|kullanmayın|kullanmayin)\b/iu.test(
      after,
    ) ||
    /^\s+(?:is|as)\s+not\b/iu.test(after)
  );
}

export function hasExplicitlyNegatedAssetReference(
  references: readonly string[],
  text: string,
): boolean {
  return references.some((reference) =>
    promptAssetOccurrences(reference, text).some((occurrence) =>
      isExplicitlyNegatedAssetOccurrence(text, occurrence),
    ),
  );
}

const EXPLICIT_EVM_ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/g;
const EXPLICIT_DECIMAL_PATTERN = /(?:\d+(?:[.,]\d+)?|[.,]\d+)/g;

export function normalizePromptDecimal(value: unknown): string | null {
  const raw = String(value ?? "")
    .trim()
    .replace(",", ".");
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) return null;
  const [wholeRaw, fractionRaw = ""] = raw.split(".");
  const whole = (wholeRaw || "0").replace(/^0+(?=\d)/, "");
  const fraction = fractionRaw.replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function explicitDecimalValues(text: string): Set<string> {
  const scrubbed = text
    .replace(/https:\/\/[^\s<>"']+/giu, " ")
    .replace(EXPLICIT_EVM_ADDRESS_PATTERN, " ");
  return new Set(
    Array.from(scrubbed.matchAll(EXPLICIT_DECIMAL_PATTERN))
      .map((match) => normalizePromptDecimal(match[0]))
      .filter((value): value is string => value !== null),
  );
}

function hasPromptBoundDecimal(value: unknown, text: string): boolean {
  const normalized = normalizePromptDecimal(value);
  return normalized !== null && explicitDecimalValues(text).has(normalized);
}

export function hasPromptBoundPrimaryAmount(
  intent: ParsedIntent,
  text: string,
  network: NetworkId,
): boolean {
  const amount = String(intent.amount ?? "").trim();
  const token = String(
    intent.action === "liquid_stake" ? intent.tokenOut : intent.tokenIn || "",
  ).trim();
  const tokenReferences = [
    token,
    ...(token ? assetAliasesForSymbol(network, token) : []),
  ].filter(
    (value, index, values) =>
      value.length > 0 &&
      value.length <= 64 &&
      values.findIndex(
        (candidate) => candidate.toLowerCase() === value.toLowerCase(),
      ) === index,
  );
  if (amount.toUpperCase() === "MAX") {
    if (
      intent.action === "remove_liquidity" &&
      /(?:tüm|tumu|tamamı|tamami|all|full|entire)[^,;:.!?\n]{0,24}(?:likidite|liquidity|lp|position)|(?:likidite|liquidity|lp|position)[^,;:.!?\n]{0,24}(?:tümü|tumu|tamamı|tamami|all|full|entire)/iu.test(
        text,
      )
    ) {
      return true;
    }
    return tokenReferences.some((tokenReference) => {
      const escapedToken = escapeRegExp(tokenReference).replace(/\s+/g, "\\s+");
      return new RegExp(
        `(?:^|[^a-zA-Z0-9])` +
          `(?:max|all|everything|full|entire|hepsi|tümü|tumu|tamamı|tamami)` +
          `(?:\\s+of)?(?:\\s+my)?\\s+(?:native\\s+)?${escapedToken}` +
          `(?=$|[^a-zA-Z0-9])|` +
          `(?:^|[^a-zA-Z0-9])${escapedToken}` +
          `(?:['’]?(?:s|nin|nın|nun|nün))?\\s+` +
          `(?:balance|bakiyesi|bakiyemin|tümü|tumu|tamamı|tamami|hepsi|max)` +
          `(?=$|[^a-zA-Z0-9])`,
        "iu",
      ).test(text);
    });
  }
  const normalizedAmount = normalizePromptDecimal(amount);
  if (!normalizedAmount) return false;
  if (tokenReferences.length > 0) {
    for (const tokenReference of tokenReferences) {
      const escapedToken = escapeRegExp(tokenReference).replace(/\s+/g, "\\s+");
      const amountBeforeToken = new RegExp(
        `((?:\\d+(?:[.,]\\d+)?|[.,]\\d+))\\s+` +
          `(?:native\\s+)?${escapedToken}(?=$|[^a-zA-Z0-9])`,
        "giu",
      );
      for (const match of text.matchAll(amountBeforeToken)) {
        if (normalizePromptDecimal(match[1]) === normalizedAmount) {
          return true;
        }
      }
      const tokenBeforeAmount = new RegExp(
        `(?:^|[^a-zA-Z0-9])${escapedToken}` +
          `\\s+(?:(?:amount|miktar(?:ı|i)?)\\s+)?` +
          `((?:\\d+(?:[.,]\\d+)?|[.,]\\d+))`,
        "giu",
      );
      for (const match of text.matchAll(tokenBeforeAmount)) {
        if (normalizePromptDecimal(match[1]) === normalizedAmount) {
          return true;
        }
      }
    }
    return false;
  }

  if (!hasPromptBoundDecimal(normalizedAmount, text)) return false;
  if (intent.action === "deploy_token") {
    return new RegExp(
      `${escapeRegExp(amount)}\\s+(?:token\\s+)?supply|` +
        `supply[^\\d\\n]{0,20}${escapeRegExp(amount)}`,
      "iu",
    ).test(text);
  }
  return true;
}

export function hasPromptBoundBasePrimaryAmount(
  intent: ParsedIntent,
  text: string,
): boolean {
  return hasPromptBoundPrimaryAmount(intent, text, "base");
}

function explicitPromptAddresses(text: string): Set<string> {
  return new Set(
    Array.from(text.matchAll(EXPLICIT_EVM_ADDRESS_PATTERN)).map((match) =>
      match[0].toLowerCase(),
    ),
  );
}

export function hasPromptBoundAddress(value: unknown, text: string): boolean {
  const address = String(value ?? "")
    .trim()
    .toLowerCase();
  return (
    /^0x[a-f0-9]{40}$/.test(address) &&
    explicitPromptAddresses(text).has(address)
  );
}

export function hasPromptBoundTransfer(
  recipient: unknown,
  amount: unknown,
  text: string,
): boolean {
  if (!hasPromptBoundAddress(recipient, text)) return false;
  const normalizedAmount = normalizePromptDecimal(amount);
  if (!normalizedAmount) return false;
  const address = String(recipient).toLowerCase();
  return (
    explicitTransferPairs(text).get(address)?.has(normalizedAmount) === true
  );
}

function explicitPromptUrls(text: string): Set<string> {
  const candidates = text.match(/https:\/\/[^\s<>"']+/giu) || [];
  return new Set(
    candidates.flatMap((candidate) => {
      const trimmed = candidate.replace(/[),.;!?]+$/g, "");
      try {
        const url = new URL(trimmed);
        url.hash = "";
        return [url.toString()];
      } catch {
        return [];
      }
    }),
  );
}

export function hasPromptBoundUrl(value: unknown, text: string): boolean {
  try {
    const url = new URL(String(value ?? "").trim());
    url.hash = "";
    return explicitPromptUrls(text).has(url.toString());
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function explicitPromptJsonObjects(text: string): unknown[] {
  const objects: unknown[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, index + 1));
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              objects.push(parsed);
            }
          } catch {}
          start = index;
          break;
        }
      }
    }
  }
  return objects;
}

export function hasPromptBoundJsonObject(value: unknown, text: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const expected = canonicalJson(value);
  return explicitPromptJsonObjects(text).some(
    (candidate) => canonicalJson(candidate) === expected,
  );
}

export const LLM_EXECUTABLE_ACTIONS = new Set([
  "swap",
  "stable_swap",
  "add_liquidity",
  "remove_liquidity",
  "stake",
  "unstake",
  "claim_rewards",
  "claim_unstaked",
  "liquid_stake",
  "liquid_unstake",
  "borrow",
  "lend",
  "repay",
  "withdraw",
  "bridge",
  "deploy_token",
  "basename_register",
  "basename_renew",
  "vault_deposit",
  "vault_withdraw",
  "vault_legacy_withdraw",
  "lending_deposit",
  "lending_withdraw",
  "lending_borrow",
  "lending_repay",
  "memo_send",
  "official_memo_send",
  "appkit_send",
  "appkit_bridge",
  "atomic_payout",
  "x402_request",
  "workflow",
]);

export function hasPromptBoundAction(action: string, text: string): boolean {
  const rules: Record<string, RegExp> = {
    swap: /\b(?:swap|swapp?ing|trade|exchange|convert|transform|change|turn|switch|buy|sell|takas|değiştir|degistir|dönüştür|donustur|çevir|cevir|satın\s+al|spend\b[^,;:.!?\n]{0,80}\b(?:receive|get|buy))\b/iu,
    stable_swap: /\b(?:swap|swapp?ing|exchange|convert|takas|çevir|cevir)\b/iu,
    add_liquidity:
      /(?:\b(?:add|provide|deposit)\b[^,;:.!?\n]{0,48}\bliquidity\b|\blikidite\b[^,;:.!?\n]{0,48}\b(?:ekle|sağla|yatır))/iu,
    remove_liquidity:
      /(?:\b(?:remove|withdraw|exit)\b[^,;:.!?\n]{0,48}\bliquidity\b|\blikidite\b[^,;:.!?\n]{0,48}\b(?:çıkar|cikar|çek|cek|kaldır))/iu,
    stake: /\b(?:stake|staking|lock|kilitle)\b/iu,
    unstake:
      /\b(?:unstake|unlock|stake(?:den|ten)\s+çık|stake(?:den|ten)\s+cik)\b/iu,
    claim_rewards:
      /^(?=[\s\S]*(?:\b(?:claim|collect|harvest)\b|(?:çek|cek|al)))(?=[\s\S]*(?:\brewards?\b|staking\s+rewards?|ödül|odul))[\s\S]*$/iu,
    claim_unstaked:
      /^(?=[\s\S]*(?:\b(?:claim|collect|withdraw)\b|(?:çek|cek|al)))(?=[\s\S]*(?:\bunstaked\b|\bcool(?:ed)?[- ]?down\b|unstake\s+(?:claim|funds?)|bekleyen\s+unstake))[\s\S]*$/iu,
    liquid_stake:
      /\b(?:liquid\s+stake|liquid\s+staking|likit\s+stake|acquire\s+(?:an?\s+)?l(?:s|r)t)\b/iu,
    liquid_unstake:
      /\b(?:liquid\s+unstake|redeem\s+(?:an?\s+)?l(?:s|r)t|exit\s+(?:an?\s+)?l(?:s|r)t)\b/iu,
    borrow: /\b(?:borrow|loan|borç\s+al|borclan|kredi\s+çek)\b/iu,
    borrow_capacity:
      /(?:\b(?:how\s+much|maximum|max|capacity|available|safe(?:ly)?)\b[^,;:.!?\n]{0,80}\b(?:borrow|loan)\b|\b(?:borrow|loan)\b[^,;:.!?\n]{0,80}\b(?:capacity|maximum|max|available|safe(?:ly)?))\b/iu,
    lend: /\b(?:lend|supply|deposit|earn|borç\s+ver|faize\s+yatır|mevduat(?:a)?\s+yatır)\b/iu,
    repay: /\b(?:repay|pay\s+back|borç\s+öde|borcu\s+öde|geri\s+öde)\b/iu,
    withdraw: /\b(?:withdraw|redeem|exit|geri\s+çek|mevduat(?:ı|i)?\s+çek)\b/iu,
    bridge: /\b(?:bridge|move|köprüle|koprule)\b/iu,
    deploy_token:
      /\b(?:create|deploy|launch|oluştur|olustur)\b[^,;:.!?\n]{0,48}\b(?:token|coin)\b/iu,
    basename_register:
      /\b(?:register|buy|purchase|kaydet|kayıt\s+et|satın\s+al)\b/iu,
    basename_renew: /\b(?:renew|extend|yenile|uzat)\b/iu,
    vault_deposit:
      /(?:\bvault\b[^,;:.!?\n]{0,48}\b(?:deposit|yatır)|\b(?:deposit|yatır)\b[^,;:.!?\n]{0,48}\bvault\b)/iu,
    vault_withdraw:
      /(?:\bvault\b[^,;:.!?\n]{0,48}\b(?:withdraw|redeem|çek)|\b(?:withdraw|redeem|çek)\b[^,;:.!?\n]{0,48}\bvault\b)/iu,
    vault_legacy_withdraw:
      /^(?=[\s\S]*(?:\blegacy\b|\beski\b))(?=[\s\S]*\bvault\b)(?=[\s\S]*(?:\b(?:withdraw|redeem)\b|çek))[\s\S]*$/iu,
    lending_deposit:
      /(?:\b(?:lending|collateral)\b[^,;:.!?\n]{0,48}\b(?:deposit|supply|add)|\b(?:deposit|supply|add|place|put|provide)\b[^,;:.!?\n]{0,64}\b(?:lending|collateral)\b|\bteminat\b[^,;:.!?\n]{0,32}\b(?:ekle|yatır))/iu,
    lending_withdraw:
      /(?:\b(?:lending|collateral)\b[^,;:.!?\n]{0,48}\b(?:withdraw|redeem)|\bteminat\b[^,;:.!?\n]{0,32}\b(?:çek|çıkar))/iu,
    lending_borrow: /\b(?:borrow|borç\s+al|kredi\s+çek)\b/iu,
    lending_repay: /\b(?:repay|borç\s+öde|geri\s+öde)\b/iu,
    memo_send:
      /^(?![\s\S]*\b(?:official|resm[iî])\s+memo\b)(?=[\s\S]*\b(?:memo|reference|referans)\b)(?=[\s\S]*(?:\b(?:send|pay|transfer)\b|gönder|öde))[\s\S]*$/iu,
    official_memo_send:
      /^(?=[\s\S]*\b(?:official|resm[iî])\s+memo\b)(?=[\s\S]*(?:\b(?:send|pay|transfer)\b|gönder|öde))[\s\S]*$/iu,
    appkit_send:
      /^(?=[\s\S]*\b(?:circle|app\s*kit)\b)(?=[\s\S]*(?:\b(?:send|pay|transfer)\b|gönder|öde))[\s\S]*$/iu,
    appkit_bridge: /\b(?:bridge|köprüle|koprule)\b/iu,
    atomic_payout:
      /\b(?:atomic\s+payout|batch\s+pay|batch\s+payment|payroll|toplu\s+ödeme|maaş\s+öde)\b/iu,
    x402_request:
      /^(?=[\s\S]*(?:\bx402\b|https:\/\/))(?=[\s\S]*(?:\b(?:call|request|pay|post|get)\b|istek|çağır|cagir|ödeme|odeme))(?=[\s\S]*(?:\bx402\b|\b(?:pay|payment|cap|limit|max(?:imum)?)\b|ödeme|odeme|tavan|limit))[\s\S]*$/iu,
    x402_discover:
      /^(?=[\s\S]*(?:\bx402\b|\b(?:service|api)\b|(?:^|[^\p{L}\p{N}_])servis(?:i|ler|leri)?(?=$|[^\p{L}\p{N}_])))(?=[\s\S]*(?:\b(?:find|search|discover)\b|bul|ara|keşfet|kesfet))[\s\S]*$/iu,
    portfolio:
      /\b(?:portfolio|balance|balances|positions?|holdings|portföy|portfoy|bakiye|pozisyonlar?)\b/iu,
    yield_compare:
      /\b(?:compare|comparison|best\s+(?:yield|rate)|yield|apy|apr|rates?|karşılaştır|karsilastir|getiri|faiz)\b/iu,
    allora_prediction: /\b(?:allora|predict|prediction|forecast|tahmin)\b/iu,
    agent_action:
      /\b(?:base\s+mcp|mcp\s+(?:agent|handoff)|agent\s+(?:mode|handoff)|ajan\s+modu)\b/iu,
    open_widget:
      /\b(?:open|show|launch|aç|ac|göster|goster)\b[^,;:.!?\n]{0,64}\b(?:widget|panel|tool|araç|arac)\b/iu,
    transfer: /\b(?:send|transfer|pay|gönder|gonder|aktar|öde|ode)\b/iu,
    workflow:
      /^(?=[\s\S]*(?:\b(?:then|after|next|and then)\b|\band\s+(?:swap|lend|supply|borrow|repay|withdraw)\b|sonra|ardından|ardindan))(?=[\s\S]*(?:\b(?:bridge|swap|lend|supply|borrow|repay|withdraw)\b|köprü|kopru|borç|borc|yatır|yatir|çek|cek))[\s\S]*$/iu,
    policy_agent:
      /\b(?:create|build|configure|set up|oluştur|olustur|kur)\b[^,;:.!?\n]{0,64}\b(?:policy\s+agent|sub[- ]?agent|alt\s+ajan|strategy\s+agent)\b/iu,
  };
  return rules[action]?.test(text) === true;
}

export function hasPromptBoundWorkflowAction(
  action: string,
  text: string,
): boolean {
  const canonical = new Map<string, string>([
    ["lending_deposit", "lend"],
    ["lending_withdraw", "withdraw"],
    ["lending_borrow", "borrow"],
    ["lending_repay", "repay"],
  ]).get(action) || action;
  return hasPromptBoundAction(canonical, text);
}

export function hasPromptBoundBaseAction(action: string, text: string): boolean {
  if (hasPromptBoundAction(action, text)) return true;
  if (
    action === "swap" &&
    (/\b(?:ile|karşılığında|karsiliginda)\b[^,;:.!?\n]{0,48}\b(?:al|sat)\b/iu.test(
      text,
    ) ||
      /(?<!borç )(?<!borc )(?<!kredi )\b(?:al|sat)\b/iu.test(text))
  ) {
    return true;
  }
  if (action === "lend" && /\b(?:yatır|yatir)\b/iu.test(text)) {
    return true;
  }
  if (
    action === "remove_liquidity" &&
    /likidite(?:yi|yı|u|ü|den|dan|inden|ından)?[^,;:.!?\n]{0,48}(?:çıkar|cikar|çek|cek|kaldır)/iu.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

function explicitTransferPairs(text: string): Map<string, Set<string>> {
  const pairs = new Map<string, Set<string>>();
  const add = (address: string, amount: string) => {
    const normalizedAmount = normalizePromptDecimal(amount);
    if (!normalizedAmount) return;
    const key = address.toLowerCase();
    const values = pairs.get(key) || new Set<string>();
    values.add(normalizedAmount);
    pairs.set(key, values);
  };
  const amountThenAddress =
    /(\d+(?:[.,]\d+)?)\s+(?:native\s+)?USDC\s+(?:to|->)\s*(0x[a-fA-F0-9]{40})/giu;
  for (const match of text.matchAll(amountThenAddress)) {
    add(match[2], match[1]);
  }
  const addressThenAmount =
    /(0x[a-fA-F0-9]{40})\s*(?::|=|receives?|gets?|alır|alir)?\s*(\d+(?:[.,]\d+)?)\s+(?:native\s+)?USDC/giu;
  for (const match of text.matchAll(addressThenAmount)) {
    add(match[1], match[2]);
  }
  return pairs;
}
