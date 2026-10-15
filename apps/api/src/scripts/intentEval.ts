/**
 * npm run eval:intents -w apps/api [-- options]
 *
 * Runs the intent eval corpus and prints the family scoreboard and the
 * gates.
 *
 *   (no options)        offline: decideTurn with the fixture wallets and fixed prices
 *   --fails             also print every failing prompt
 *   --json <file>       write the per-prompt results as JSON
 *   --corpus <file>     another corpus (default: the platform test fixture)
 *   --api <origin>      run the wallet-independent prompts against a live API
 *                       (POST /v1/intents?clarify=true&dryRun=true: read-only, nothing stored or signed)
 *   --key <key>         API key for --api (or KLETIA_EVAL_API_KEY); public tier without one
 *   --delay <ms>        pause between live requests (default 400; the public tier allows 30 a minute)
 *   --family <a,b>      only these families
 *   --enforce           exit 1 when a gate fails (always on once INTENT_EVAL_ENFORCE is)
 *   --llm               reserved for the optional LLM layer; refused until it lands
 *
 * Exit 1 on a crash, a broken corpus or (enforced) a failed gate.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  INTENT_EVAL_ENFORCE,
  evalGates,
  formatScoreboard,
  loadEvalFixtures,
  loadIntentEval,
  runIntentEval,
  runIntentEvalLive,
  scoreIntentEval,
} from "../platform/engine/goal/evalHarness.js";

interface Args {
  fails: boolean;
  enforce: boolean;
  llm: boolean;
  json?: string;
  corpus?: string;
  families?: string[];
  api?: string;
  key?: string;
  delay: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { fails: false, enforce: false, llm: false, delay: 400 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--fails": args.fails = true; break;
      case "--enforce": args.enforce = true; break;
      case "--llm": args.llm = true; break;
      case "--json": args.json = value(); break;
      case "--corpus": args.corpus = value(); break;
      case "--api": args.api = value(); break;
      case "--family": args.families = value().split(",").map((name) => name.trim()).filter(Boolean); break;
      case "--key": args.key = value(); break;
      case "--delay": {
        const ms = Number(value());
        if (!Number.isInteger(ms) || ms < 0 || ms > 60_000) throw new Error("--delay is 0 to 60000 ms");
        args.delay = ms;
        break;
      }
      default: throw new Error(`unknown option ${String(flag)}`);
    }
  }
  if (args.api && !/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/u.test(args.api)) throw new Error("--api is an http(s) origin");
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.llm) {
    console.error("--llm: the LLM proposal layer is not built yet.");
    return 2;
  }
  const evalPath = args.corpus ?? fileURLToPath(new URL("../platform/engine/__tests__/fixtures/intent-eval.json", import.meta.url));
  const loaded = loadIntentEval(evalPath);
  const fixtures = loadEvalFixtures(evalPath, loaded);
  const families = args.families;
  const corpus = families ? { ...loaded, prompts: loaded.prompts.filter((prompt) => families.includes(prompt.family)) } : loaded;
  if (corpus.prompts.length === 0) throw new Error("no prompt matches --family");
  const started = Date.now();
  const key = args.key ?? process.env.KLETIA_EVAL_API_KEY;
  const results = args.api
    ? await runIntentEvalLive(corpus, fixtures, { api: args.api, ...(key ? { key } : {}), delayMs: args.delay })
    : await runIntentEval(corpus, fixtures);
  const board = scoreIntentEval(corpus, results);
  console.log(`${args.api ? `live ${args.api}` : "offline"} · ${results.length} results in ${Date.now() - started} ms`);
  console.log(formatScoreboard(board, { failList: args.fails }));
  if (args.json) writeFileSync(args.json, `${JSON.stringify(results, null, 1)}\n`);
  if (board.byClass.crashed > 0) return 1;
  if ((args.enforce || INTENT_EVAL_ENFORCE) && evalGates(board).some((gate) => !gate.ok)) return 1;
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
