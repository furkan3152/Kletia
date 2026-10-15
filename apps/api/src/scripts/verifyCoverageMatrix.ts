/**
 * `npm run verify:coverage -- --api http://127.0.0.1:3000`: plans every cell
 * of the coverage table (protocols design §4, `coverageMatrix.ts`) against a
 * running Kletia API with `POST /v1/intents?dryRun=true`. Dry runs only:
 * nothing is stored, signed or sent, and the probe accounts are public
 * addresses Kletia never controls.
 *
 * Each cell is one of:
 * - plans:   200, and every step ran one of the protocols the cell allows;
 * - guided:  422 INTENT_UNSUPPORTED whose message matches the cell and offers
 *            at least one sentence (`--follow` also plans each offered one);
 * - venue:   a venue or provider could not quote right now (RPC, rate limit,
 *            liquidity): reported, and a failure only with `--strict`;
 * - FAIL:    a bare INTENT_UNSUPPORTED, a wrong protocol or output, or a
 *            refusal where a plan was expected.
 * Exit code 1 when any cell FAILs. `--out <file>` writes the results as JSON;
 * `--only <network,...>` limits the networks; `--delay <ms>` spaces requests.
 */
import { writeFileSync } from "node:fs";
import { CHAINS, type NetworkKey } from "@kletia/core";
import { COVERAGE_CELLS, quotedSentences, type CoverageCell } from "./coverageMatrix.js";

const EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOL = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

function accountsFor(network: NetworkKey): string[] {
  const testnet = CHAINS[network].environment === "testnet";
  const evm = testnet ? CHAINS.arc : CHAINS.ethereum;
  const solana = testnet ? CHAINS["solana-devnet"] : CHAINS.solana;
  return [`${evm.id}:${EVM}`, `${solana.id}:${SOL}`];
}

interface Args {
  readonly api: string;
  readonly out?: string;
  readonly only?: ReadonlySet<string>;
  readonly delayMs: number;
  readonly follow: boolean;
  readonly strict: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const only = value("--only");
  return {
    api: (value("--api") ?? process.env.KLETIA_API_URL ?? "http://127.0.0.1:3000").replace(/\/+$/u, ""),
    ...(value("--out") ? { out: value("--out") as string } : {}),
    ...(only ? { only: new Set(only.split(",").map((entry) => entry.trim())) } : {}),
    delayMs: Number(value("--delay") ?? 2100),
    follow: argv.includes("--follow"),
    strict: argv.includes("--strict"),
  };
}

interface Planned {
  readonly status: number;
  readonly steps: readonly { readonly protocol: string; readonly output?: string }[];
  readonly warnings: readonly string[];
  readonly error?: { readonly code: string; readonly message: string };
}

async function dryRun(api: string, text: string, network: NetworkKey): Promise<Planned> {
  try {
    const response = await fetch(`${api}/v1/intents?dryRun=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, accounts: accountsFor(network) }),
    });
    const body = (await response.json()) as {
      intent?: { steps?: { protocol: string; minimumOutput?: { symbol: string } }[]; warnings?: string[] };
      steps?: { protocol: string; minimumOutput?: { symbol: string } }[];
      warnings?: string[];
      error?: { code: string; message: string };
    };
    const graph = body.intent ?? body;
    return {
      status: response.status,
      steps: (graph.steps ?? []).map((step) => ({ protocol: step.protocol, ...(step.minimumOutput ? { output: step.minimumOutput.symbol } : {}) })),
      warnings: graph.warnings ?? [],
      ...(body.error ? { error: { code: body.error.code, message: String(body.error.message) } } : {}),
    };
  } catch (error) {
    return { status: 0, steps: [], warnings: [], error: { code: "FETCH_FAILED", message: String(error) } };
  }
}

type Verdict = "plans" | "guided" | "venue" | "FAIL";

interface Result {
  readonly network: NetworkKey;
  readonly kind: string;
  readonly text: string;
  readonly verdict: Verdict;
  readonly detail: string;
  readonly offered?: readonly { readonly text: string; readonly verdict: Verdict; readonly detail: string }[];
}

/** Codes that mean a venue or provider could not answer now, not that Kletia cannot read or route the cell. */
function isVenueError(code: string | undefined): boolean {
  return code !== undefined && code !== "INTENT_UNSUPPORTED" && code !== "TOKEN_UNKNOWN" && code !== "VENUE_UNKNOWN";
}

function judgePlan(cell: CoverageCell, planned: Planned): { verdict: Verdict; detail: string } {
  if (planned.status === 200 && planned.steps.length > 0) {
    const protocols = planned.steps.map((step) => step.protocol);
    const wrong = (cell.protocols ?? []).findIndex((allowed, index) => !allowed.includes(protocols[index] as never));
    if (wrong >= 0) return { verdict: "FAIL", detail: `step ${wrong + 1} ran ${protocols[wrong]}, expected ${cell.protocols?.[wrong]?.join("|")}` };
    const output = planned.steps.at(-1)?.output;
    if (cell.output && output !== cell.output) return { verdict: "FAIL", detail: `output ${output}, expected ${cell.output}` };
    if (cell.warning && !planned.warnings.some((warning) => cell.warning?.test(warning))) return { verdict: "FAIL", detail: "missing warning" };
    return { verdict: "plans", detail: protocols.join(" > ") };
  }
  const code = planned.error?.code;
  if (isVenueError(code)) return { verdict: "venue", detail: `${code}: ${planned.error?.message.slice(0, 160)}` };
  return { verdict: "FAIL", detail: `${code ?? planned.status}: ${planned.error?.message.slice(0, 200) ?? "no steps"}` };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cells = COVERAGE_CELLS.filter((cell) => !args.only || args.only.has(cell.network));
  const results: Result[] = [];
  const pause = () => new Promise((resolve) => setTimeout(resolve, args.delayMs));
  for (const cell of cells) {
    const planned = await dryRun(args.api, cell.text, cell.network);
    let result: Result;
    if (cell.expect === "plans") {
      result = { network: cell.network, kind: cell.kind, text: cell.text, ...judgePlan(cell, planned) };
    } else if (planned.error?.code === "INTENT_UNSUPPORTED" && cell.message?.test(planned.error.message)) {
      const sentences = quotedSentences(planned.error.message, cell.text);
      const offered: { text: string; verdict: Verdict; detail: string }[] = [];
      if (args.follow) {
        for (const text of sentences) {
          await pause();
          offered.push({ text, ...judgePlan({ ...cell, text, expect: "plans", protocols: [] }, await dryRun(args.api, text, cell.network)) });
        }
      }
      const failed = sentences.length === 0 ? "the refusal offers no sentence" : offered.find((entry) => entry.verdict === "FAIL")?.detail;
      result = {
        network: cell.network,
        kind: cell.kind,
        text: cell.text,
        verdict: failed ? "FAIL" : "guided",
        detail: failed ?? `offers ${sentences.map((text) => `"${text}"`).join(", ")}`,
        ...(offered.length > 0 ? { offered } : {}),
      };
    } else {
      const detail = planned.error ? `${planned.error.code}: ${planned.error.message.slice(0, 200)}` : `planned ${planned.steps.map((step) => step.protocol).join(" > ")}`;
      result = { network: cell.network, kind: cell.kind, text: cell.text, verdict: isVenueError(planned.error?.code) ? "venue" : "FAIL", detail };
    }
    results.push(result);
    console.log(`${result.verdict.padEnd(6)} ${cell.network.padEnd(16)} ${cell.kind.padEnd(26)} ${result.detail}`);
    await pause();
  }
  const count = (verdict: Verdict) => results.filter((result) => result.verdict === verdict).length;
  const failures = count("FAIL") + (args.strict ? count("venue") : 0);
  console.log(`\n${results.length} cells: ${count("plans")} plan, ${count("guided")} guided, ${count("venue")} venue errors, ${count("FAIL")} FAIL`);
  if (args.out) writeFileSync(args.out, `${JSON.stringify({ at: new Date().toISOString(), api: args.api, results }, null, 2)}\n`);
  process.exitCode = failures > 0 ? 1 : 0;
}

await main();
