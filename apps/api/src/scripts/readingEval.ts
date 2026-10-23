/**
 * npm run eval:reading -w apps/api [-- options]
 *
 * Model-assisted reading evaluation. Readers for the intent
 * eval (`eval:intents -- --llm <mode>`), and a bake-off over the corpora:
 *
 *   --mode replay       recordings in __tests__/fixtures/reading-replay (the CI default); a missing
 *                       recording is no proposal and is counted
 *   --mode adversarial  a hostile provider: plausible but wrong readings, identical in every family
 *                       (the worst case: both families agree on a wrong reading); the gate is 0 wrong plans
 *   --mode fuzz         random span soup, identical in every family
 *   --mode live         OpenRouter with OPENROUTER_EVAL_API_KEY (or OPENROUTER_API_KEY) and the
 *                       KLETIA_READING_MODELS / KLETIA_READING_PROFILES profiles; --record writes recordings
 *   --corpus <name>     repo, hard, redteam or all (default all)
 *
 * The key is read from env only and never printed. Exit 1 on any wrong plan.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReadingHook } from "../platform/engine/clarify/types.js";
import { loadEvalFixtures, loadIntentEval, modeRunOptions, runIntentEval, scoreIntentEval } from "../platform/engine/goal/evalHarness.js";
import { EVAL_CORPUS_FILES } from "../platform/engine/goal/evalTransitions.js";
import { READING_CATALOG_HASH, ReadingLayer, readingConfigFromEnv, type ReadingConfig } from "../platform/engine/reading/index.js";
import { openRouterProvider } from "../platform/engine/reading/openrouter.js";
import { ReadingTransportError, type ReadingCall, type ReadingProvider } from "../platform/engine/reading/provider.js";
import { loadRecordings, recordingKey, replayProvider, type Recording } from "../platform/engine/reading/replay.js";

export const READING_EVAL_MODES = ["replay", "adversarial", "fuzz", "live"] as const;
export type ReadingEvalMode = (typeof READING_EVAL_MODES)[number];

const REPLAY_DIR = fileURLToPath(new URL("../platform/engine/__tests__/fixtures/reading-replay/", import.meta.url));

/** Profiles for offline modes: placeholders of three distinct vendors (no real model ids in the repository). */
const OFFLINE_CONFIG: ReadingConfig = {
  switch: "on",
  profiles: [
    { model: "eval-a/primary", provider: "eval-a" },
    { model: "eval-b/crosscheck", provider: "eval-b" },
    { model: "eval-c/hedge", provider: "eval-c" },
  ],
};

function seeded(text: string): () => number {
  let state = Number.parseInt(createHash("sha256").update(text).digest("hex").slice(0, 8), 16) || 1;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** The numbered tokens of a reading prompt ("Tokens: 0:swap 1:<amount_1> ..."). */
function tokensOf(user: string): string[] {
  const line = /Tokens: (.*)\n/u.exec(user)?.[1] ?? "";
  return line.split(" ").map((entry) => entry.replace(/^\d+:/u, ""));
}

const KINDS = ["convert", "relocate", "earn", "exit", "acquire"];
const OPS = [undefined, "swap", "bridge", "stake", "deposit", "withdraw"];
const CONNECTOR = new Set(["to", "into", "onto", "for", "as", "from", "with", "using", "on", "in", "at", "via"]);

/**
 * A hostile reading: every token is put in some field (so coverage holds),
 * sides and networks shuffled, the kind and op picked at random. The same
 * answer for every family, so agreement never saves the gates.
 */
function adversarialAnswer(call: ReadingCall): string {
  if (call.purpose === "answer") return JSON.stringify({ option: null });
  const tokens = tokensOf(call.user);
  const rnd = seeded(call.user);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)] as T;
  const goal: Record<string, unknown> = { kind: pick(KINDS) };
  const op = pick(OPS);
  if (op) goal.op = op;
  const spend: Record<string, [number, number]> = {};
  const want: Record<string, [number, number]> = {};
  const rest: Record<string, [number, number]> = {};
  let verb: [number, number] | null = null;
  for (let at = 0; at < tokens.length; at += 1) {
    const word = tokens[at] as string;
    const withConnector = at > 0 && CONNECTOR.has(tokens[at - 1] as string) ? at - 1 : at;
    const span: [number, number] = [withConnector, at + 1];
    if (/^<amount_/u.test(word)) (rnd() < 0.5 ? spend : want).amount = [at, at + 1];
    else if (CONNECTOR.has(word)) continue;
    else if (!verb && /^(swap|bridge|stake|deposit|withdraw|buy|sell|convert|move|get|put|lend|supply|exit|close|trade)$/u.test(word)) verb = [at, at + 1];
    else if (/^(base|arbitrum|optimism|ethereum|solana|polygon|bnb|avalanche|arc|linea|op)$/u.test(word)) {
      const slot = pick(["spend", "want", "on"]);
      if (slot === "on") rest.on = span;
      else (slot === "spend" ? spend : want).network = span;
    } else if (/^(aave|morpho|kamino|jito|lido|marinade|compound|spark|moonwell|euler|fluid)$/u.test(word)) {
      if (rnd() < 0.5) want.venue = span;
      else rest.position = span;
    } else (rnd() < 0.5 ? spend : want).asset = span;
  }
  goal.verb = verb ?? [0, 1];
  if (Object.keys(spend).length) goal.spend = spend;
  if (Object.keys(want).length) goal.want = want;
  Object.assign(goal, rest);
  return JSON.stringify({ verdict: "reading", goal });
}

/** Random span soup over the token count. */
function fuzzAnswer(call: ReadingCall): string {
  if (call.purpose === "answer") return rndJunk(call.user);
  const n = Math.max(1, tokensOf(call.user).length);
  const rnd = seeded(`fuzz${call.user}`);
  const span = () => {
    const start = Math.floor(rnd() * n);
    return [start, Math.min(n, start + 1 + Math.floor(rnd() * 3))];
  };
  const goal: Record<string, unknown> = { kind: KINDS[Math.floor(rnd() * KINDS.length)], verb: span() };
  const op = OPS[Math.floor(rnd() * OPS.length)];
  if (op) goal.op = op;
  goal.spend = { asset: span(), ...(rnd() < 0.5 ? { amount: span() } : {}), ...(rnd() < 0.3 ? { network: span() } : {}) };
  goal.want = { ...(rnd() < 0.7 ? { asset: span() } : {}), ...(rnd() < 0.3 ? { network: span() } : {}), ...(rnd() < 0.2 ? { venue: span() } : {}) };
  if (rnd() < 0.4) goal.on = span();
  return rnd() < 0.1 ? rndJunk(call.user) : JSON.stringify({ verdict: "reading", goal });
}

function rndJunk(seed: string): string {
  const junk = ["", "{", "null", "[]", '{"verdict":"reading"}', '{"option":"base"}', "Sure! Here is the JSON:", '{"verdict":"reading","goal":{"kind":"deliver"}}'];
  return junk[Math.floor(seeded(seed)() * junk.length)] as string;
}

export interface EvalReader {
  readonly hook: ReadingHook;
  readonly layer: ReadingLayer;
  readonly missing: () => number;
  readonly recorded: () => Recording[];
}

/** A reading hook for the intent eval (`--llm <mode>`); every family gets the same answer in hostile modes. */
export function evalReader(mode: ReadingEvalMode, options: { record?: boolean } = {}): EvalReader {
  let provider: ReadingProvider;
  let config = OFFLINE_CONFIG;
  const recorded: Recording[] = [];
  let missing = () => 0;
  switch (mode) {
    case "replay": {
      const replay = replayProvider(loadRecordings(REPLAY_DIR), READING_CATALOG_HASH);
      provider = replay;
      missing = () => replay.missing.length;
      // Recordings are keyed by the configured profiles; without any, the offline placeholders (every key misses).
      const configured = readingConfigFromEnv({ ...process.env, KLETIA_MODEL_READING: "eval", OPENROUTER_API_KEY: "replay" });
      config = configured.switch === "off" ? OFFLINE_CONFIG : configured;
      break;
    }
    case "adversarial":
      provider = { kind: "scripted", call: (call) => Promise.resolve({ text: adversarialAnswer(call) }) };
      break;
    case "fuzz":
      provider = { kind: "scripted", call: (call) => Promise.resolve({ text: fuzzAnswer(call) }) };
      break;
    case "live": {
      const key = process.env.OPENROUTER_EVAL_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
      config = readingConfigFromEnv({ ...process.env, KLETIA_MODEL_READING: "eval", ...(key ? { OPENROUTER_API_KEY: key } : {}) });
      if (!key || config.switch === "off") throw new Error(`live reading eval needs an OpenRouter key and two pinned models of distinct vendors (${config.offReason ?? "key_missing"})`);
      const live = openRouterProvider(key);
      provider = {
        kind: "openrouter",
        async call(call) {
          const answer = await live.call(call);
          if (options.record) {
            recorded.push({ key: recordingKey(call, READING_CATALOG_HASH), model: call.profile.model, provider: call.profile.provider, variant: call.variant, text: answer.text, ...(answer.servedProvider ? { servedProvider: answer.servedProvider } : {}) });
          }
          return answer;
        },
      };
      break;
    }
    default:
      throw new ReadingTransportError("mode");
  }
  const layer = new ReadingLayer({ config: { ...config, switch: "on" }, provider, log: () => undefined, limits: { perSessionHour: Number.MAX_SAFE_INTEGER, perProjectDay: Number.MAX_SAFE_INTEGER } });
  return { hook: layer.hookFor({ scope: `eval:${mode}` }), layer, missing, recorded: () => recorded };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const at = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const mode = (at("--mode") ?? "adversarial") as ReadingEvalMode;
  if (!READING_EVAL_MODES.includes(mode)) throw new Error(`--mode must be one of ${READING_EVAL_MODES.join(", ")}`);
  const corpus = at("--corpus") ?? "all";
  const reader = evalReader(mode, { record: argv.includes("--record") });
  const names = corpus === "all" ? ["repo", "hard", "redteam"] : [corpus];
  let wrong = 0;
  for (const name of names) {
    const path = fileURLToPath(new URL(`../platform/engine/__tests__/fixtures/${EVAL_CORPUS_FILES[name] ?? name}`, import.meta.url));
    const loaded = loadIntentEval(path);
    const fixtures = loadEvalFixtures(path, loaded, fileURLToPath(new URL("../../../../", import.meta.url)));
    for (const evalMode of ["decide", "plan"] as const) {
      const results = await runIntentEval(loaded, fixtures, { ...modeRunOptions(evalMode), reader: reader.hook });
      const board = scoreIntentEval(loaded, results);
      wrong += board.byClass.plans_wrongly;
      console.log(`${name} ${evalMode}: ${board.correct}/${board.prompts} correct, wrong plans ${board.byClass.plans_wrongly}`);
    }
  }
  const m = reader.layer.metrics;
  console.log(`reading ${mode}: calls ${m.calls}, failures ${m.failures}, proposals ${m.proposals}, missing recordings ${reader.missing()}`);
  console.log(`rejected: ${Object.entries(m.rejected).sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code} ${count}`).join(", ") || "none"}`);
  if (argv.includes("--record") && reader.recorded().length > 0) {
    mkdirSync(REPLAY_DIR, { recursive: true });
    writeFileSync(`${REPLAY_DIR}recorded-${Date.now()}.json`, `${JSON.stringify(reader.recorded(), null, 1)}\n`);
  }
  return wrong > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : "reading eval failed");
    process.exit(1);
  });
}
