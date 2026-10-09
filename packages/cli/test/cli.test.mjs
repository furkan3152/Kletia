import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { signWebhookPayload, verifyWebhookSignature } from "@kletia/core";
import { CLI_VERSION, run } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "dist", "bin.js");
const API_KEY = "kl_dev_abcdefghijklmnopqrstuvwxyz012345";
const NEW_KEY = "kl_dev_NEWSECRETnewsecretNEWSECRET1234";
const WEBHOOK_SECRET = "whsec_0123456789abcdefghijklmnopqrstuv";
const EVM = "0x000000000000000000000000000000000000dEaD";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/* ------------------------------------------------------------ stub API */

const requests = [];
const intents = new Map();

function intentFor(id, status = "planned", extra = {}) {
  return {
    spec: "kletia.intent/v1",
    id,
    status,
    createdAt: "2026-10-09T10:00:00.000Z",
    updatedAt: `2026-10-09T10:00:0${status === "planned" ? 0 : 5}.000Z`,
    request: { accounts: [`eip155:8453:${EVM}`] },
    summary: { title: "Bridge 25 USDC from Base to Solana", signaturesRequired: 1, totalFeesUsd: 0.12, estimatedSeconds: 20 },
    warnings: [],
    steps: [
      {
        id: "s1",
        status: status === "completed" ? "settled" : status === "failed" ? "failed" : "ready",
        network: "base",
        protocol: "relay",
        settlement: { destinationNetwork: "solana" },
        input: { formatted: "25", symbol: "USDC" },
        expectedOutput: { formatted: "24.9", symbol: "USDC" },
        minimumOutput: { formatted: "24.85", symbol: "USDC" },
        evidence: [],
        ...extra,
      },
    ],
  };
}

const evt = (n, intentId, type, data) => ({ id: `evt_${String(n).padStart(32, "0")}`, type, at: "2026-10-09T10:00:01.000Z", data: { intentId, ...data } });

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "x-request-id": "req-cli", ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

const api = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const body = await readBody(req);
  requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body });
  const route = `${req.method} ${url.pathname}`;
  const keyed = req.headers.authorization === `Bearer ${API_KEY}`;
  if (route === "GET /v1/networks") {
    return send(res, 200, { networks: [{ key: "base", name: "Base", vm: "evm", environment: "mainnet", actions: ["swap", "bridge"], protocols: ["relay"] }] });
  }
  if (route === "POST /v1/quotes") {
    const route1 = { protocol: "relay", output: { formatted: "24.912345678", symbol: "USDC" }, minimumOutput: { formatted: "24.85" }, feesUsd: 0.1, estimatedSeconds: 12, transactionCount: 1, warnings: [] };
    const route2 = { ...route1, protocol: "lifi", output: { formatted: "24.8", symbol: "USDC" } };
    return send(res, 200, { routes: [route1, route2], best: route1, quotedAt: "", unavailable: [{ protocol: "debridge", code: "ROUTE_UNAVAILABLE", message: "no liquidity" }] });
  }
  if (route === "POST /v1/intents") {
    if (url.searchParams.get("dryRun") === "true") {
      const recipient = body.text.includes("send")
        ? `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`
        : body.text.includes("arbitrum")
          ? `eip155:42161:${EVM.toLowerCase()}`
          : undefined;
      return send(res, 200, { intent: intentFor("int_dry", "planned", recipient ? { recipient } : {}) });
    }
    intents.set("int_saved", "planned");
    return send(res, 201, { intent: intentFor("int_saved") });
  }
  const intentMatch = /^\/v1\/intents\/(int_[a-z]+)(\/events)?$/u.exec(url.pathname);
  if (intentMatch && req.method === "GET") {
    const id = intentMatch[1];
    if (!intents.has(id)) return send(res, 404, { error: { code: "INTENT_NOT_FOUND", message: "Intent not found.", docs: "https://kletiaai.xyz/developers#error-INTENT_NOT_FOUND" } });
    if (!intentMatch[2]) return send(res, 200, { intent: intentFor(id, intents.get(id)) });
    // Event stream: two events, then the intent ends.
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("retry: 3000\n\n");
    const outcome = id === "int_failing" ? "failed" : "completed";
    const events = [
      evt(1, id, "intent.step_updated", { stepId: "s1", network: "base", status: "submitted" }),
      evt(2, id, "intent.status_changed", { status: outcome, previous: "executing" }),
    ];
    setTimeout(() => {
      res.write(`id: ${events[0].id}\nevent: ${events[0].type}\ndata: ${JSON.stringify(events[0])}\n\n`);
      setTimeout(() => {
        intents.set(id, outcome);
        res.write(`id: ${events[1].id}\nevent: ${events[1].type}\ndata: ${JSON.stringify(events[1])}\n\n`);
      }, 20);
    }, 20);
    req.on("close", () => res.end());
    return undefined;
  }
  if (route === "POST /v1/keys") {
    return send(res, 201, { key: { id: "key_000000000000000000000001", name: body.name, tier: "developer", createdAt: "2026-10-09T10:00:00.000Z", key: NEW_KEY } });
  }
  if (!keyed && url.pathname !== "/v1/errors" && url.pathname !== "/v1/venues") return send(res, 401, { error: { code: "API_KEY_REQUIRED", message: "This endpoint requires an API key." } });
  if (route === "GET /v1/keys") {
    // A hostile name must not be able to smuggle a secret onto the terminal.
    return send(res, 200, { keys: [{ id: "key_000000000000000000000001", name: `leak ${API_KEY} ${NEW_KEY}`, tier: "developer", last4: "2345", createdAt: "", lastUsedAt: null, rotatedAt: null, previousExpiresAt: null, revokedAt: null, current: true }] });
  }
  if (route === "POST /v1/keys/key_000000000000000000000001/rotate") {
    return send(res, 200, { key: { id: "key_000000000000000000000001", name: "ci", tier: "developer", createdAt: "", key: NEW_KEY, rotatedAt: "2026-10-09T10:00:00.000Z", previousExpiresAt: "2026-10-10T10:00:00.000Z" } });
  }
  if (route === "DELETE /v1/keys/key_000000000000000000000001") return send(res, 204);
  if (route === "POST /v1/webhooks") {
    return send(res, 201, { webhook: { id: "wh_000000000000000000000001", url: body.url, events: body.events ?? [], createdAt: "", secret: WEBHOOK_SECRET } });
  }
  if (route === "POST /v1/webhooks/wh_000000000000000000000001/test") {
    return send(res, 200, { delivery: { id: "dl_1", webhookId: "wh_000000000000000000000001", eventId: "evt_x", eventType: "webhook.test", attempt: 1, status: "failed", httpStatus: 405, durationMs: 31, error: "http_status", test: true, at: "2026-10-09T10:00:00.000Z" } });
  }
  if (route === "GET /v1/usage") {
    return send(res, 200, { keyId: "key_1", tier: "developer", window: url.searchParams.get("window"), since: "", generatedAt: "", rateLimit: { limit: 300, remaining: 299, resetAt: null, windowSeconds: 60 }, totals: { requests: 3, byStatusClass: { "2xx": 3 } }, byRoute: [{ route: "GET /networks", requests: 3, byStatusClass: { "2xx": 3 } }], series: [], intents: { created: 1, byStatus: { planned: 1 } } });
  }
  if (route === "GET /v1/venues") {
    const venue = { venue: "base:aave-v3:usdc", protocol: "aave-v3", network: "base", name: "Aave V3 USDC", asset: "USDC", supplyApy: 0.04285, apySource: "rate", totalSupplied: { formatted: "181637065.58", symbol: "USDC" }, exitLiquidity: { formatted: "17339876.87", symbol: "USDC" }, utilization: 0.9045, observedAt: "", warnings: [] };
    return send(res, 200, { venues: [venue], unavailable: [{ venue: "base:moonwell:usdc", code: "RPC_UNAVAILABLE", message: "down" }] });
  }
  if (route === "GET /v1/errors") {
    return send(res, 200, { errors: [{ code: "PROVIDER_UNAVAILABLE", status: 502, category: "upstream", retryable: true, title: "Provider unavailable", remedy: "Retry shortly.", docs: "https://kletiaai.xyz/developers#error-PROVIDER_UNAVAILABLE" }], families: [{ pattern: "<PROVIDER>_UNAVAILABLE", code: "PROVIDER_UNAVAILABLE" }] });
  }
  if (route === "GET /v1/webhooks") {
    return send(res, 500, { error: { code: "INTERNAL_ERROR", message: `failed for ${API_KEY}` } });
  }
  return send(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${route}` } });
});

/** A local webhook receiver for `webhooks forward`. */
const received = [];
const receiver = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
  res.writeHead(204).end();
});

let BASE;
let RECEIVER;

before(async () => {
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  BASE = `http://127.0.0.1:${api.address().port}`;
  RECEIVER = `http://127.0.0.1:${receiver.address().port}/hooks`;
});

after(() => {
  api.closeAllConnections?.();
  api.close();
  receiver.close();
});

/** Runs the CLI in-process; `tty` makes stdout look like a terminal. */
async function cli(args, { env = {}, tty = false, stdin } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    stdout: { write: (chunk) => { stdout += chunk; }, isTTY: tty },
    stderr: { write: (chunk) => { stderr += chunk; } },
    env: { KLETIA_BASE_URL: BASE, ...env },
    ...(stdin !== undefined ? { readStdin: async () => stdin } : {}),
  });
  return { code, stdout, stderr };
}

const keyed = { KLETIA_API_KEY: API_KEY };
const last = () => requests.at(-1);

/* ---------------------------------------------------------------- tests */

test("the CLI version is locked to @kletia/core and @kletia/sdk", async () => {
  const own = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));
  const core = JSON.parse(await readFile(join(here, "..", "..", "core", "package.json"), "utf8"));
  const sdk = JSON.parse(await readFile(join(here, "..", "..", "sdk", "package.json"), "utf8"));
  assert.equal(own.version, CLI_VERSION);
  assert.equal(own.version, core.version);
  assert.equal(own.version, sdk.version);
  assert.equal(own.dependencies["@kletia/core"], core.version);
  assert.equal(own.dependencies["@kletia/sdk"], sdk.version);
  assert.equal(own.bin.kletia, "./dist/bin.js");
  const { stdout, code } = await cli(["--version"]);
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`@kletia/cli ${CLI_VERSION.replaceAll(".", "\\.")}`, "u"));
});

test("networks prints a table or JSON", async () => {
  const table = await cli(["networks"]);
  assert.equal(table.code, 0);
  assert.match(table.stdout, /^network\s+name\s+vm/mu);
  assert.match(table.stdout, /base\s+Base\s+evm\s+mainnet\s+swap,bridge\s+relay/u);
  assert.equal(last().headers["x-kletia-client"], `cli/${CLI_VERSION}`);
  const json = await cli(["networks", "--json"]);
  assert.equal(JSON.parse(json.stdout)[0].key, "base");
});

test("quote sends the movement, accepts account shorthand and marks the best route", async () => {
  const result = await cli(["quote", "25", "USDC", "--from", "base", "--to", "solana", "--account", `base:${EVM}`, "--slippage-bps", "50"]);
  assert.equal(result.code, 0);
  assert.deepEqual(last().body, {
    from: { network: "base", asset: "USDC", amount: "25", account: `eip155:8453:${EVM}` },
    to: { network: "solana", asset: "USDC" },
    slippageBps: 50,
  });
  assert.match(result.stdout, /^\*\s+relay\s+24\.912345 USDC\s+24\.85/mu);
  assert.match(result.stderr, /debridge: ROUTE_UNAVAILABLE/u);
  const bad = await cli(["quote", "ten", "USDC", "--from", "base"]);
  assert.equal(bad.code, 64);
  const unknown = await cli(["quote", "1", "USDC", "--from", "basee"]);
  assert.equal(unknown.code, 64);
  assert.match(unknown.stderr, /Unknown network "basee"/u);
});

test("plan is a dry run unless --save, and calls out recipients that are not yours", async () => {
  const dry = await cli(["plan", "bridge 25 USDC from base to solana", "--account", `base:${EVM}`]);
  assert.equal(dry.code, 0);
  assert.equal(last().search, "?dryRun=true");
  assert.deepEqual(last().body.accounts, [`eip155:8453:${EVM}`]);
  assert.match(dry.stdout, /s1\s+ready\s+base→solana\s+relay\s+25 USDC\s+24\.9 USDC \(min 24\.85\)/u);
  assert.match(dry.stderr, /Dry run: nothing was stored/u);
  const external = await cli(["plan", "send 5 USDC to a friend", "--account", `base:${EVM}`]);
  assert.match(external.stdout, /Sends to accounts that are not yours:\n\s+s1: solana:/u);
  const rehomed = await cli(["plan", "bridge 25 USDC from base to arbitrum", "--account", `base:${EVM}`]);
  assert.equal(rehomed.code, 0);
  assert.doesNotMatch(rehomed.stdout, /not yours/u, "the same EVM address on another network is the user's own");
  const saved = await cli(["plan", "bridge 25 USDC from base to solana", "--account", `eip155:8453:${EVM}`, "--save"]);
  assert.equal(saved.code, 0);
  assert.equal(last().search, "");
  assert.match(saved.stderr, /kletia intents watch int_saved/u);
  const missing = await cli(["plan", "bridge 25 USDC"]);
  assert.equal(missing.code, 64);
  assert.match(missing.stderr, /--account/u);
});

test("intents watch follows the event stream; exit 0 when completed, 2 when not", async () => {
  intents.set("int_watched", "executing");
  const done = await cli(["intents", "watch", "int_watched"]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /step s1 on base: submitted/u);
  assert.match(done.stdout, /status executing → completed/u);
  assert.match(done.stdout, /int_watched completed\n$/u);
  intents.set("int_failing", "executing");
  const failed = await cli(["intents", "watch", "int_failing", "--json"]);
  assert.equal(failed.code, 2);
  const lines = failed.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.at(-1).intent.status, "failed");
  assert.equal(lines[0].event.type, "intent.step_updated");
  const missing = await cli(["intents", "watch", "int_nope"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /INTENT_NOT_FOUND \(HTTP 404\)/u);
  assert.match(missing.stderr, /docs: https:\/\/kletiaai\.xyz\/developers#error-INTENT_NOT_FOUND/u);
  assert.match(missing.stderr, /request id: req-cli/u);
});

test("keys create refuses to print a secret on a terminal before calling the API", async () => {
  const before = requests.length;
  const refused = await cli(["keys", "create", "ci"], { tty: true });
  assert.equal(refused.code, 64);
  assert.match(refused.stderr, /--secret-file/u);
  assert.equal(requests.length, before, "no key was minted");
  const revealed = await cli(["keys", "create", "ci", "--reveal"], { tty: true });
  assert.equal(revealed.code, 0);
  assert.equal(revealed.stdout, `${NEW_KEY}\n`);
});

test("keys create piped prints only the secret on stdout; the summary goes to stderr", async () => {
  const piped = await cli(["keys", "create", "ci"]);
  assert.equal(piped.code, 0);
  assert.equal(piped.stdout, `${NEW_KEY}\n`);
  assert.match(piped.stderr, /Created key_000000000000000000000001 \(ci, developer\)/u);
  assert.doesNotMatch(piped.stderr, /NEWSECRET/u);
  const json = await cli(["keys", "create", "ci", "--json"]);
  assert.equal(JSON.parse(json.stdout).key, NEW_KEY);
});

test("--secret-file writes the secret with mode 600 and never overwrites", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kletia-cli-"));
  const file = join(dir, "key.txt");
  const result = await cli(["keys", "create", "ci", "--secret-file", file], { tty: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(file, "utf8"), `${NEW_KEY}\n`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stdout + result.stderr, /NEWSECRET/u);
  const before = requests.length;
  const again = await cli(["keys", "rotate", "key_000000000000000000000001", "--secret-file", file], { env: keyed });
  assert.equal(again.code, 64);
  assert.match(again.stderr, /already exists/u);
  assert.equal(requests.length, before, "refused before rotating");
  const existing = join(dir, "other.txt");
  await writeFile(existing, "keep");
  assert.equal((await cli(["webhooks", "create", "https://example.com/hook", "--secret-file", existing], { env: keyed })).code, 64);
  assert.equal(await readFile(existing, "utf8"), "keep");
});

test("output never shows the configured key or other secrets", async () => {
  const list = await cli(["keys", "list"], { env: keyed });
  assert.equal(list.code, 0);
  assert.doesNotMatch(list.stdout, /abcdefghijklmnop|NEWSECRET/u);
  assert.match(list.stdout, /kl_dev_…/u);
  const failing = await cli(["webhooks", "list"], { env: keyed });
  assert.equal(failing.code, 1);
  assert.doesNotMatch(failing.stderr, /abcdefghijklmnop/u);
  assert.equal(last().headers.authorization, `Bearer ${API_KEY}`);
  const flag = await cli(["networks", "--api-key", API_KEY]);
  assert.equal(flag.code, 64);
  assert.match(flag.stderr, /KLETIA_API_KEY/u);
  assert.doesNotMatch(flag.stderr, /abcdefghijklmnop/u);
});

test("keyed commands need KLETIA_API_KEY; destructive ones need --yes", async () => {
  const before = requests.length;
  assert.equal((await cli(["keys", "list"])).code, 64);
  assert.equal((await cli(["keys", "revoke", "key_000000000000000000000001"], { env: keyed })).code, 64);
  assert.equal((await cli(["webhooks", "delete", "wh_000000000000000000000001"], { env: keyed })).code, 64);
  assert.equal(requests.length, before);
  const revoked = await cli(["keys", "revoke", "key_000000000000000000000001", "--yes"], { env: keyed });
  assert.equal(revoked.code, 0);
  assert.equal(last().method, "DELETE");
});

test("keys rotate passes the grace window; webhooks test, usage and errors print summaries", async () => {
  const rotated = await cli(["keys", "rotate", "key_000000000000000000000001", "--grace-seconds", "600"], { env: keyed });
  assert.equal(rotated.code, 0);
  assert.deepEqual(last().body, { graceSeconds: 600 });
  assert.match(last().headers["idempotency-key"], /^[0-9a-f-]{36}$/u);
  assert.match(rotated.stderr, /old secret works until 2026-10-10 10:00:00Z/u);
  const tested = await cli(["webhooks", "test", "wh_000000000000000000000001"], { env: keyed });
  assert.equal(tested.code, 1, "a failed test delivery is a non-zero exit");
  assert.match(tested.stdout, /webhook\.test\s+failed\s+405\s+31ms\s+http_status/u);
  const usage = await cli(["usage", "--window", "7d"], { env: keyed });
  assert.equal(last().search, "?window=7d");
  assert.match(usage.stdout, /rate limit: 299\/300/u);
  const family = await cli(["errors", "RELAY_UNAVAILABLE"]);
  assert.equal(family.code, 0);
  assert.match(family.stdout, /PROVIDER_UNAVAILABLE \(for RELAY_UNAVAILABLE\)/u);
  const venues = await cli(["venues", "--network", "base", "--protocol", "aave-v3"]);
  assert.equal(venues.code, 0, venues.stderr);
  assert.equal(last().search, "?network=base&protocol=aave-v3");
  assert.match(venues.stdout, /base:aave-v3:usdc\s+4\.29%/u);
  assert.match(venues.stderr, /base:moonwell:usdc: RPC_UNAVAILABLE/u);
});

test("webhooks verify checks stdin against KLETIA_WEBHOOK_SECRET", async () => {
  const body = JSON.stringify(evt(9, "int_x", "intent.status_changed", { status: "completed", previous: "settling" }));
  const signature = await signWebhookPayload(WEBHOOK_SECRET, body);
  const env = { KLETIA_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const valid = await cli(["webhooks", "verify", "--signature", signature], { env, stdin: body });
  assert.equal(valid.code, 0);
  assert.match(valid.stdout, /valid: intent\.status_changed/u);
  const tampered = await cli(["webhooks", "verify", "--signature", signature], { env, stdin: body.replace("completed", "failed") });
  assert.equal(tampered.code, 1);
  assert.match(tampered.stderr, /invalid \(mismatch\)/u);
  assert.equal((await cli(["webhooks", "verify", "--signature", signature], { stdin: body })).code, 64, "needs the secret");
});

test("webhooks forward re-signs streamed events for a local endpoint only", async () => {
  intents.set("int_forward", "executing");
  received.length = 0;
  const env = { KLETIA_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const result = await cli(["webhooks", "forward", "--intent", "int_forward", "--to", RECEIVER], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(received.length, 2);
  for (const delivery of received) {
    const check = await verifyWebhookSignature(WEBHOOK_SECRET, delivery.body, delivery.headers["kletia-signature"]);
    assert.ok(check.valid);
    assert.equal(JSON.parse(delivery.body).id, delivery.headers["kletia-event-id"]);
  }
  assert.match(result.stdout, /204\s+intent\.status_changed/u);
  const remote = await cli(["webhooks", "forward", "--intent", "int_forward", "--to", "https://example.com/hook"], { env });
  assert.equal(remote.code, 64);
});

test("the kletia binary runs as a process with exit codes", async () => {
  const exec = promisify(execFile);
  const ok = await exec(process.execPath, [BIN, "networks", "--json"], { env: { ...process.env, KLETIA_BASE_URL: BASE, KLETIA_API_KEY: "" } });
  assert.equal(JSON.parse(ok.stdout)[0].key, "base");
  // stdout is a pipe here, so the one-time secret goes to stdout.
  const created = await exec(process.execPath, [BIN, "keys", "create", "spawned"], { env: { ...process.env, KLETIA_BASE_URL: BASE } });
  assert.equal(created.stdout, `${NEW_KEY}\n`);
  await assert.rejects(exec(process.execPath, [BIN, "nope"], { env: { ...process.env, KLETIA_BASE_URL: BASE } }), (error) => error.code === 64);
});
