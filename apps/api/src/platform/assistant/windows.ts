/**
 * Time windows of assistant questions, in UTC (weeks start on Monday):
 * the phrase a question says ("last month", "this week", "in September",
 * "the last 10 days") read into a named window, and a named window resolved
 * against the clock into `from` / `to` and a label the answer prints.
 * Vague words ("recently", "lately") resolve to the last 30 days with
 * `assumed`, which the answer states.
 */
import type { AssistantWindow, AssistantWindowName } from "@kletia/core";

const DAY_MS = 86_400_000;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_TITLES = MONTHS.map((month) => `${month.charAt(0).toUpperCase()}${month.slice(1)}`);

export interface WindowSpec {
  readonly name: AssistantWindowName;
  readonly days?: number;
  /** `month`: 0..11. */
  readonly month?: number;
  readonly assumed?: true;
}

const startOfDay = (time: number) => Math.floor(time / DAY_MS) * DAY_MS;
const startOfWeek = (time: number) => startOfDay(time) - ((new Date(time).getUTCDay() + 6) % 7) * DAY_MS;
const startOfMonth = (year: number, month: number) => Date.UTC(year, month, 1);
const dayLabel = (time: number) => `${new Date(time).getUTCDate()} ${MONTH_TITLES[new Date(time).getUTCMonth()]!.slice(0, 3)} ${new Date(time).getUTCFullYear()}`;

/** The window of a spec at `now`. */
export function resolveWindow(spec: WindowSpec, now: number): AssistantWindow {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const iso = (time: number) => new Date(time).toISOString();
  const make = (from: number | null, to: number, label: string): AssistantWindow => ({
    name: spec.name,
    from: from === null ? null : iso(from),
    to: iso(to),
    label,
    ...(spec.days !== undefined ? { days: spec.days } : {}),
    ...(spec.assumed ? { assumed: true as const } : {}),
  });
  switch (spec.name) {
    case "today":
      return make(startOfDay(now), now, `today (${dayLabel(now)})`);
    case "yesterday":
      return make(startOfDay(now) - DAY_MS, startOfDay(now), `yesterday (${dayLabel(startOfDay(now) - DAY_MS)})`);
    case "this_week":
      return make(startOfWeek(now), now, `this week (since ${dayLabel(startOfWeek(now))})`);
    case "last_week":
      return make(startOfWeek(now) - 7 * DAY_MS, startOfWeek(now), `last week (${dayLabel(startOfWeek(now) - 7 * DAY_MS)} to ${dayLabel(startOfWeek(now) - DAY_MS)})`);
    case "this_month":
      return make(startOfMonth(year, month), now, `${MONTH_TITLES[month]} ${year} so far`);
    case "last_month": {
      const from = startOfMonth(year, month - 1);
      const at = new Date(from);
      return make(from, startOfMonth(year, month), `${MONTH_TITLES[at.getUTCMonth()]} ${at.getUTCFullYear()}`);
    }
    case "month": {
      const wanted = spec.month ?? month;
      // A month later than this one is last year's.
      const inYear = wanted > month ? year - 1 : year;
      const end = Math.min(startOfMonth(inYear, wanted + 1), now);
      return make(startOfMonth(inYear, wanted), end, `${MONTH_TITLES[wanted]} ${inYear}${end === now ? " so far" : ""}`);
    }
    case "last_days": {
      const days = Math.max(1, Math.min(365, spec.days ?? 30));
      return make(now - days * DAY_MS, now, `the last ${days} days`);
    }
    case "this_year":
      return make(Date.UTC(year, 0, 1), now, `${year} so far`);
    case "last_year":
      return make(Date.UTC(year - 1, 0, 1), Date.UTC(year, 0, 1), `${year - 1}`);
    case "all":
      return make(null, now, "all time");
  }
}

const WORD_NUMBERS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, thirty: 30, ninety: 90 };

/** The window a question names, the phrase that said it (to strip before reading the rest), or null. */
export function windowPhrase(sentence: string): { readonly spec: WindowSpec; readonly phrase: string } | null {
  const rules: readonly [RegExp, (match: RegExpExecArray) => WindowSpec | null][] = [
    [/\b(?:in\s+the\s+|over\s+the\s+|for\s+the\s+)?(?:last|past)\s+(\d{1,3}|one|two|three|four|five|six|seven|ten|fourteen|thirty|ninety)\s+days?\b/u, (m) => {
      const days = WORD_NUMBERS[m[1] as string] ?? Number(m[1]);
      return days >= 1 && days <= 365 ? { name: "last_days", days } : null;
    }],
    [/\b(?:in\s+the\s+|over\s+the\s+)?(?:last|past)\s+(\d{1,2}|two|three|four|six)\s+weeks?\b/u, (m) => ({ name: "last_days", days: 7 * (WORD_NUMBERS[m[1] as string] ?? Number(m[1])) })],
    [/\b(?:in\s+the\s+|over\s+the\s+)?(?:last|past)\s+(\d{1,2}|two|three|six)\s+months?\b/u, (m) => ({ name: "last_days", days: Math.min(365, 30 * (WORD_NUMBERS[m[1] as string] ?? Number(m[1]))) })],
    [/\b(?:in\s+the\s+|over\s+the\s+|this\s+)?past\s+(?:24\s+hours|day)\b/u, () => ({ name: "last_days", days: 1 })],
    [/\b(?:in\s+the\s+|over\s+the\s+|this\s+)?past\s+week\b/u, () => ({ name: "last_days", days: 7 })],
    [/\b(?:in\s+the\s+|over\s+the\s+|this\s+)?past\s+month\b/u, () => ({ name: "last_days", days: 30 })],
    [/\b(?:in\s+the\s+|over\s+the\s+|this\s+)?past\s+year\b/u, () => ({ name: "last_days", days: 365 })],
    [/\btoday\b/u, () => ({ name: "today" })],
    [/\byesterday\b/u, () => ({ name: "yesterday" })],
    [/\bthis\s+week\b/u, () => ({ name: "this_week" })],
    [/\blast\s+week\b/u, () => ({ name: "last_week" })],
    [/\bthis\s+month\b/u, () => ({ name: "this_month" })],
    [/\blast\s+month\b/u, () => ({ name: "last_month" })],
    [/\b(?:this\s+year|ytd|year\s+to\s+date)\b/u, () => ({ name: "this_year" })],
    [/\blast\s+year\b/u, () => ({ name: "last_year" })],
    [/\b(?:ever|all\s+time|of\s+all\s+time|so\s+far|in\s+total|since\s+the\s+start)\b/u, () => ({ name: "all" })],
    [new RegExp(String.raw`\b(?:in|during|for)\s+(${MONTHS.join("|")}|${MONTHS.map((month) => month.slice(0, 3)).join("|")})\b`, "u"), (m) => {
      const word = m[1] as string;
      const month = MONTHS.findIndex((name) => name === word || name.slice(0, 3) === word);
      return month >= 0 ? { name: "month", month } : null;
    }],
    [/\b(?:recently|lately|recent|these\s+days|the\s+other\s+day)\b/u, () => ({ name: "last_days", days: 30, assumed: true })],
  ];
  for (const [pattern, read] of rules) {
    const match = pattern.exec(sentence);
    if (!match) continue;
    const spec = read(match);
    if (spec) return { spec, phrase: match[0] };
  }
  return null;
}
