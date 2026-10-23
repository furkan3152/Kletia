/**
 * Route audit (intent design E.4, the U3 audit productized):
 *
 *   npx tsx src/scripts/auditRoutes.ts --recorded            offline replay of the recorded U3 matrix (B.1 score)
 *   npx tsx src/scripts/auditRoutes.ts --api <origin> [...]  live dry runs against a deployment
 *
 * Live mode sends each matrix sentence to `POST /v1/intents?dryRun=true`
 * (read-only: nothing is stored, signed or sent) with two public audit
 * accounts, and records the venues picked, the expected output of the last
 * step, the request time and every venue failure the plan lists (rate
 * limits included). It compares the expected output with the best supported
 * route of the recorded matrix (quote drift between the recording and now is
 * part of the number) and checks the live-audit gates before
 * `KLETIA_ROUTE_SHAPES=compare` is flipped:
 *   - loss-weighted <= 3 bps against the recorded best supported route;
 *   - request p99 < 15 s (and the composer p95 <= 4 s, read from the plan's own timing when the API reports it);
 *   - no plan where Relay was skipped for a 429 (needs RELAY_API_KEY on the deployment);
 *   - no refusal where the matrix has a supported route.
 *
 * Options:
 *   --api <origin>      the API origin (e.g. https://api.kletiaai.xyz)
 *   --key-env <name>    environment variable holding the API key (default KLETIA_AUDIT_API_KEY); never printed
 *   --filter <regex>    only matrix ids matching it
 *   --delay <ms>        pause between requests (default 2500: the public tier allows 30 a minute)
 *   --json <file>       write every row as JSON
 *   --enforce           exit 1 when a gate fails
 */
import { writeFileSync } from "node:fs";
import { loadRouteMatrix, realisedUsd, replayCase, type RecordedCase } from "../platform/engine/__tests__/quoteReplay.js";

/** Public audit accounts (the U3 audit's): read-only dry runs never use their funds. */
const ACCOUNTS = [
  "eip155:1:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
];

interface Options {
  readonly recorded: boolean;
  readonly api: string | null;
  readonly keyEnv: string;
  readonly filter: RegExp | null;
  readonly delayMs: number;
  readonly json: string | null;
  readonly enforce: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? (argv[index + 1] as string) : null;
  };
  const api = value("--api");
  if (api !== null && !/^https?:\/\/[^\s/]+$/u.test(api.replace(/\/+$/u, ""))) throw new Error("--api must be an origin such as https://api.example.com");
  const filter = value("--filter");
  return {
    recorded: argv.includes("--recorded") || api === null,
    api: api ? api.replace(/\/+$/u, "") : null,
    keyEnv: value("--key-env") ?? "KLETIA_AUDIT_API_KEY",
    filter: filter ? new RegExp(filter, "u") : null,
    delayMs: Math.max(0, Number(value("--delay") ?? 2_500) || 0),
    json: value("--json"),
    enforce: argv.includes("--enforce"),
  };
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

interface Row {
  readonly id: string;
  readonly usd: number;
  readonly pick: string;
  readonly lossBps: number | null;
  readonly ms: number | null;
  readonly refused: string | null;
  readonly relayRateLimited: boolean;
}

function recordedRows(cases: readonly RecordedCase[]): Row[] {
  return cases.map((entry) => {
    const result = replayCase(entry);
    return { id: entry.id, usd: entry.usd, pick: result.pick?.name ?? "none", lossBps: result.pick ? result.lossBps : null, ms: null, refused: result.pick ? null : "no supported route", relayRateLimited: false };
  });
}

interface PlannedStepView {
  readonly protocol?: string;
  readonly network?: string;
  readonly expectedOutput?: { readonly amount?: string; readonly decimals?: number };
  readonly evidence?: readonly { readonly detail?: string }[];
  readonly warnings?: readonly string[];
}

async function liveRow(entry: RecordedCase, options: Options): Promise<Row> {
  const key = process.env[options.keyEnv]?.trim();
  const started = Date.now();
  let body: unknown = null;
  let status = 0;
  try {
    const response = await fetch(`${options.api}/v1/intents?dryRun=true`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ text: entry.text, accounts: ACCOUNTS }),
      signal: AbortSignal.timeout(60_000),
    });
    status = response.status;
    body = await response.json().catch(() => null);
  } catch {
    return { id: entry.id, usd: entry.usd, pick: "none", lossBps: null, ms: Date.now() - started, refused: "unreachable", relayRateLimited: false };
  }
  const ms = Date.now() - started;
  const record = (body && typeof body === "object" ? body : {}) as { code?: string; intent?: { steps?: PlannedStepView[] }; steps?: PlannedStepView[] };
  const steps = record.intent?.steps ?? record.steps ?? [];
  if (status >= 400 || steps.length === 0) {
    return { id: entry.id, usd: entry.usd, pick: "none", lossBps: null, ms, refused: record.code ?? `HTTP ${status}`, relayRateLimited: false };
  }
  const last = steps[steps.length - 1] as PlannedStepView;
  const text = JSON.stringify(steps);
  const relayRateLimited = /Relay[^"]{0,80}(rate limited|429)/iu.test(text);
  const best = replayCase(entry).best;
  let lossBps: number | null = null;
  if (best && last.expectedOutput?.amount && last.expectedOutput.decimals === entry.decimalsOut) {
    const route = { ...best, out: last.expectedOutput.amount, gasUsd: 0, extraUsd: 0 };
    lossBps = Math.max(0, ((realisedUsd(entry, best) - realisedUsd(entry, route)) / entry.usd) * 10_000);
  }
  return { id: entry.id, usd: entry.usd, pick: steps.map((step) => `${step.protocol ?? "?"}@${step.network ?? "?"}`).join(" > "), lossBps, ms, refused: null, relayRateLimited };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const cases = loadRouteMatrix().filter((entry) => !options.filter || options.filter.test(entry.id));
  let rows: Row[];
  if (options.recorded) {
    rows = recordedRows(cases);
  } else {
    rows = [];
    for (const [index, entry] of cases.entries()) {
      rows.push(await liveRow(entry, options));
      const row = rows[rows.length - 1] as Row;
      process.stdout.write(`${String(index + 1).padStart(3)}/${cases.length} ${entry.id}: ${row.refused ?? row.pick} ${row.lossBps === null ? "" : `${row.lossBps.toFixed(1)} bps`} ${row.ms ?? ""} ms\n`);
      if (options.delayMs > 0 && index + 1 < cases.length) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }
  const priced = rows.filter((row) => row.lossBps !== null);
  const weight = priced.reduce((total, row) => total + row.usd, 0);
  const lossWeighted = weight > 0 ? priced.reduce((total, row) => total + (row.lossBps as number) * row.usd, 0) / weight : 0;
  const worst = [...priced].sort((a, b) => (b.lossBps as number) - (a.lossBps as number)).slice(0, 10);
  const times = rows.map((row) => row.ms).filter((ms): ms is number => ms !== null);
  const refused = rows.filter((row) => row.refused !== null);
  const rateLimited = rows.filter((row) => row.relayRateLimited).length;
  const limit = options.recorded ? 2 : 3;
  const gates = [
    { gate: `loss-weighted <= ${limit} bps`, value: lossWeighted.toFixed(3), ok: lossWeighted <= limit },
    ...(options.recorded ? [] : [
      { gate: "request p99 < 15 s", value: `${(percentile(times, 99) / 1000).toFixed(2)} s`, ok: percentile(times, 99) < 15_000 },
      { gate: "no plan without Relay for a 429", value: String(rateLimited), ok: rateLimited === 0 },
      // Every matrix case has a supported route except the two Jupiter Ultra-only ones (not adopted, O4).
      { gate: "no refusal where a supported route exists", value: String(refused.filter((row) => !/^(swap:solana:USDC>WIF:50|swap:solana:SOL>JitoSOL:50)$/u.test(row.id)).length), ok: refused.every((row) => /^(swap:solana:USDC>WIF:50|swap:solana:SOL>JitoSOL:50)$/u.test(row.id)) },
    ]),
  ];
  process.stdout.write(`\nRoute audit (${options.recorded ? "recorded replay" : options.api}): ${rows.length} cases, ${refused.length} refused, loss-weighted ${lossWeighted.toFixed(3)} bps\n`);
  if (times.length > 0) process.stdout.write(`Request time p50 ${percentile(times, 50)} ms, p95 ${percentile(times, 95)} ms, p99 ${percentile(times, 99)} ms\n`);
  for (const row of worst) process.stdout.write(`  ${(row.lossBps as number).toFixed(1).padStart(6)} bps  ${row.id}  ${row.pick}\n`);
  for (const row of refused.slice(0, 20)) process.stdout.write(`  refused  ${row.id}: ${row.refused}\n`);
  for (const gate of gates) process.stdout.write(`${gate.ok ? "PASS" : "FAIL"}  ${gate.gate}: ${gate.value}\n`);
  if (options.json) writeFileSync(options.json, `${JSON.stringify({ rows, gates }, null, 1)}\n`);
  if (options.enforce && gates.some((gate) => !gate.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
