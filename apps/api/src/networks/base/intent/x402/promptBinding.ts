/**
 * Prompt binding: payment caps, URLs and JSON bodies the prompt names.
 */
import { formatUnits, parseUnits } from "viem";
import { DECIMAL_USDC, USDC_DECIMALS } from "./constants.js";
import { BaseX402IntentError } from "./types.js";
import { paymentCap, publicHttpsUrl } from "./preflight.js";

export function promptPaymentCaps(prompt: string): Array<{
  readonly atomic: bigint;
  readonly decimal: string;
}> {
  const scrubbed = prompt
    .replace(/https:\/\/[^\s<>"']+/giu, " ")
    .replace(/0x[a-f\d]{40}/giu, " ");
  const amount = String.raw`((?:\d+(?:[.,]\d+)?|[.,]\d+))`;
  const candidates: string[] = [];
  const prefixPattern = new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}_])(?:max(?:imum)?|at\s+most|up\s+to|no\s+more\s+than|payment\s+(?:cap|limit|ceiling)|cap(?:\s+(?:one|each|per)\s+(?:call|request))?|en\s+fazla|ödeme\s+(?:tavanı|limiti)|tavan|üst\s+sınır)(?=$|[^\p{L}\p{N}_])[^\d\r\n]{0,48}${amount}\s*USDC\b`,
    "giu",
  );
  const suffixPattern = new RegExp(
    String.raw`${amount}\s*USDC\b[^\d\r\n]{0,32}(?:max(?:imum)?|cap|limit|ceiling|at\s+most|or\s+(?:less|under)|under|below|tavan|sınır(?:la|ı)?|altında|altinda|veya\s+daha\s+az)(?=$|[^\p{L}\p{N}_])`,
    "giu",
  );
  for (const pattern of [prefixPattern, suffixPattern]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(scrubbed)) !== null) {
      candidates.push(match[1]);
    }
  }
  const caps = new Map<
    string,
    {
      readonly atomic: bigint;
      readonly decimal: string;
    }
  >();
  for (const candidate of candidates) {
    const normalized = candidate.replace(",", ".").replace(/^\./, "0.");
    if (!DECIMAL_USDC.test(normalized)) continue;
    try {
      const atomic = parseUnits(normalized, USDC_DECIMALS);
      caps.set(atomic.toString(), {
        atomic,
        decimal: formatUnits(atomic, USDC_DECIMALS),
      });
    } catch {
      // An invalid decimal can never authorize a payment cap.
    }
  }
  return [...caps.values()];
}

export function promptContainsPaymentCap(
  prompt: string,
  expectedAtomic: bigint,
): boolean {
  return promptPaymentCaps(prompt).some(
    ({ atomic }) => atomic === expectedAtomic,
  );
}

export function promptContainsUrl(prompt: string, expectedUrl: string): boolean {
  const candidates = prompt.match(/https:\/\/[^\s<>"']+/giu) || [];
  return candidates.some((candidate) => {
    try {
      return (
        publicHttpsUrl(candidate.replace(/[),.;!?]+$/g, "")).toString() ===
        expectedUrl
      );
    } catch {
      return false;
    }
  });
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

export function promptContainsJsonObject(
  prompt: string,
  expectedValue: unknown,
): boolean {
  const expected = canonicalJson(expectedValue);
  for (let start = 0; start < prompt.length; start += 1) {
    if (prompt[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < prompt.length; index += 1) {
      const char = prompt[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(prompt.slice(start, index + 1));
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed) &&
              canonicalJson(parsed) === expected
            ) {
              return true;
            }
          } catch {}
          start = index;
          break;
        }
      }
    }
  }
  return false;
}

export function assertBaseX402PaymentPromptBinding(
  maxPayment: unknown,
  sourcePrompt: string,
): void {
  const cap = paymentCap(maxPayment);
  if (
    !sourcePrompt.trim() ||
    !promptContainsPaymentCap(sourcePrompt, cap.atomic)
  ) {
    throw new BaseX402IntentError(
      "X402_PROMPT_PAYMENT_UNBOUND",
      "The x402 payment cap must match the open USDC amount in the current user message.",
    );
  }
}
