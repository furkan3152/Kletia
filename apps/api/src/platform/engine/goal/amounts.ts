/**
 * Amounts for the Goal reader (intent engine v2 §3.1 AmountSel, §3.2):
 * number spelling ("twenty five" -> 25), number forms ("1k", "1e-2",
 * "1,000", ".5"), the AmountSel <-> text round trip, and the lowering of an
 * AmountSel to the clarify layer's ThreadAmount.
 *
 * Every rewrite of what the person typed ("1k" -> 1000, "1e-2" -> 0.01) is
 * reported as a correction, so it shows as a material chip; nothing is
 * guessed silently. A form that is not clearly one number ("1.234.567",
 * "5 5") is not read.
 */
import type { AmountSel, ThreadAmount } from "@kletia/core";
import { NUMBER_SCALES, NUMBER_TENS, NUMBER_UNITS } from "./lexicon.js";

const POSITIVE_DECIMAL = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/u;
const ZERO = /^0(?:\.0+)?$/u;

export interface NumberRead {
  /** Canonical decimal string (token units or dollars). */
  readonly value: string;
  /** The text as typed when it differs from `value` ("1,000", "1,5", ".5"). */
  readonly raw?: string;
  /** Set when the form was rewritten ("1k" -> "1000"): shown as a material correction. */
  readonly rewritten?: true;
}

function canonical(value: string): string | null {
  let out = value.startsWith(".") ? `0${value}` : value;
  out = out.replace(/^0+(?=\d)/u, "");
  if (!POSITIVE_DECIMAL.test(out) || ZERO.test(out)) return null;
  return out;
}

/** "1.5" * 10^exp as a decimal string ("1", 3 -> "1000"; "1", -2 -> "0.01"). */
export function shiftDecimal(value: string, exp: number): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match || !Number.isInteger(exp) || Math.abs(exp) > 30) return null;
  let digits = `${match[1]}${match[2] ?? ""}`;
  let point = (match[1] as string).length + exp;
  if (point <= 0) {
    digits = `${"0".repeat(1 - point)}${digits}`;
    point = 1;
  }
  if (point > digits.length) digits = digits.padEnd(point, "0");
  const whole = digits.slice(0, point).replace(/^0+(?=\d)/u, "");
  const fraction = digits.slice(point).replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * One number as typed, or null when it is not clearly one number:
 * "12", "12.5", ".5", "1,000" (thousands), "1,5" (a decimal comma, flagged by
 * the clarify layer), "1k" / "0.5k", "1e-2".
 */
export function readNumber(raw: string): NumberRead | null {
  const text = raw.trim().toLowerCase();
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(text)) {
    const value = canonical(text);
    return value ? { value, ...(value !== text ? { raw: text } : {}) } : null;
  }
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(text)) {
    const value = canonical(text.replace(/,/gu, ""));
    return value ? { value, raw: text } : null;
  }
  if (/^\d+,\d{1,2}$/u.test(text)) {
    const value = canonical(text.replace(",", "."));
    return value ? { value, raw: text } : null;
  }
  const thousands = /^(\d+(?:\.\d+)?)k$/u.exec(text);
  if (thousands) {
    const shifted = shiftDecimal(thousands[1] as string, 3);
    const value = shifted ? canonical(shifted) : null;
    return value ? { value, raw: text, rewritten: true } : null;
  }
  const scientific = /^(\d+(?:\.\d+)?)e([+-]?\d{1,2})$/u.exec(text);
  if (scientific) {
    const shifted = shiftDecimal(scientific[1] as string, Number(scientific[2]));
    const value = shifted ? canonical(shifted) : null;
    return value ? { value, raw: text, rewritten: true } : null;
  }
  return null;
}

/** "30%", "33.33%", "30 percent" as basis points (1..10000), or null. */
export function readPercent(raw: string): number | null {
  const match = /^(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|percent|pct)$/u.exec(raw.trim().toLowerCase());
  if (!match) return null;
  const bps = Math.round(Number(match[1]) * 100);
  return bps >= 1 && bps <= 10_000 ? bps : null;
}

/* ------------------------------------------------------ number words */

const isUnit = (word: string) => Object.hasOwn(NUMBER_UNITS, word);
const isTen = (word: string) => Object.hasOwn(NUMBER_TENS, word);
const isScale = (word: string) => Object.hasOwn(NUMBER_SCALES, word);
const isNumberWord = (word: string) => isUnit(word) || isTen(word) || isScale(word);

/**
 * The value of a run of number words ("twenty five", "two thousand five
 * hundred", "a hundred"), or null when the run is not one well-formed number
 * ("five five", "twenty twenty").
 */
export function numberWordsValue(words: readonly string[]): number | null {
  if (words.length === 0) return null;
  let total = 0;
  let current = 0;
  /** What the last word was, so "five five" and "twenty twenty" are refused. */
  let last: "none" | "unit" | "ten" | "hundred" | "thousand" = "none";
  for (const [index, raw] of words.entries()) {
    const word = raw === "a" && index === 0 ? "one" : raw;
    if (word === "and") {
      if (last !== "hundred" && last !== "thousand") return null;
      continue;
    }
    if (isUnit(word)) {
      if (last === "unit") return null;
      if (last === "ten" && NUMBER_UNITS[word]! >= 10) return null;
      if (last === "ten" && NUMBER_UNITS[word] === 0) return null;
      current += NUMBER_UNITS[word]!;
      last = "unit";
    } else if (isTen(word)) {
      if (last === "unit" || last === "ten") return null;
      current += NUMBER_TENS[word]!;
      last = "ten";
    } else if (word === "hundred") {
      if (last === "hundred" || current >= 100) return null;
      current = (current || 1) * 100;
      last = "hundred";
    } else if (word === "thousand") {
      if (last === "thousand" || total > 0) return null;
      total = (current || 1) * 1000;
      current = 0;
      last = "thousand";
    } else {
      return null;
    }
  }
  const value = total + current;
  return value > 0 && value < 1_000_000 ? value : null;
}

/**
 * Spells runs of number words as digits ("bridge twenty five USDC" ->
 * "bridge 25 USDC"). `minWords` 2 converts only compound numbers (the strict
 * reader already converts single words); a run that is not one well-formed
 * number is left as typed.
 */
export function spellNumbers(text: string, minWords = 1): string {
  const words = text.split(" ");
  const out: string[] = [];
  let index = 0;
  while (index < words.length) {
    const lower = (words[index] as string).toLowerCase();
    const startsRun = isNumberWord(lower) || (lower === "a" && isScale((words[index + 1] ?? "").toLowerCase()));
    if (!startsRun) {
      out.push(words[index] as string);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < words.length) {
      const next = (words[end] as string).toLowerCase();
      if (isNumberWord(next) || (next === "and" && isNumberWord((words[end + 1] ?? "").toLowerCase()) && isScale((words[end - 1] as string).toLowerCase()))) end += 1;
      else break;
    }
    const run = words.slice(index, end).map((word) => word.toLowerCase());
    // A trailing "and" is never part of the number ("one hundred and" + verb).
    const value = run.length >= minWords ? numberWordsValue(run) : null;
    if (value !== null && !(run.length === 1 && run[0] === "a")) out.push(String(value));
    else out.push(...words.slice(index, end));
    index = end;
  }
  return out.join(" ");
}

/* --------------------------------------------------- AmountSel <-> text */

/** Text that reads back as the same AmountSel (the round-trip property test). */
export function renderAmount(sel: AmountSel): string {
  switch (sel.t) {
    case "exact":
      return sel.value;
    case "usd":
      return `$${sel.value}`;
    case "portion":
      return sel.bps % 100 === 0 ? `${sel.bps / 100}%` : `${(sel.bps / 100).toFixed(2).replace(/0$/u, "")}%`;
    case "max":
      return "all";
    case "allBut":
      return `all but ${sel.keep}`;
    case "previous":
      return "it";
  }
}

/**
 * The clarify layer's amount for an AmountSel, or null when the slots cannot
 * say it ("all but 0.1"). `share` says what a portion or "all" is of: the
 * balance ("half my SOL"), the previous step's output ("swap half to ETH"
 * after a bridge) or the venue position ("take everything out of aave").
 */
export function toThreadAmount(
  sel: AmountSel,
  options: { readonly share: "balance" | "previous" | "position"; readonly previousExists: boolean; readonly raw?: string },
): (ThreadAmount & { usd?: boolean }) | null {
  const share = (bps: number): ThreadAmount | null => {
    if (options.share === "previous") return options.previousExists ? { t: "previous", bps } : null;
    return { t: options.share, bps };
  };
  switch (sel.t) {
    case "exact":
      return { t: "exact", value: sel.value, ...(options.raw && options.raw !== sel.value ? { raw: options.raw.slice(0, 40) } : {}) };
    case "usd":
      return { t: "exact", value: sel.value, usd: true };
    case "portion":
      return share(sel.bps);
    case "max":
      return share(10_000);
    case "previous":
      return options.previousExists ? { t: "previous", bps: 10_000 } : null;
    case "allBut":
      return null;
  }
}
