// "Start here" (start/startModel.ts): sandbox first, the first call's tier, the run summary,
// the issuance limit message, and files that never hold the key. Run with Node 22.18 or later:
//   node --test apps/web/src/app/pages/developers/__tests__/startModel.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPastedKey,
  ENV_FILE,
  envLine,
  firstCallCurl,
  firstCallPlan,
  issueKeyBody,
  issueLimitMessage,
  keyNameError,
  shipFiles,
  START_SURFACES,
  summarizeRun,
} from "../start/startModel.ts";

const KEY = `kl_dev_${"A1b2C3d4".repeat(4)}`;
const AGENT = `kl_agt_${"Z9y8X7w6".repeat(4)}`;
const API = "http://127.0.0.1:3840";
const WEB = "http://127.0.0.1:3841";
const ACCOUNT = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:92x2Ef9emSPRLCDhZNBRoJmqfP65AhNYMYV4pFVsE4BK";

test("issuing: sandbox sends sandbox true, live sends only the name, names are checked", () => {
  assert.deepEqual(issueKeyBody(" my-app ", "sandbox"), { name: "my-app", sandbox: true });
  assert.deepEqual(issueKeyBody("my-app", "live"), { name: "my-app" });
  assert.equal(keyNameError("my-first-app"), null);
  assert.match(keyNameError(""), /1-64/u);
  assert.match(keyNameError("x".repeat(65)), /1-64/u);
  assert.match(keyNameError("<script>"), /1-64/u);
});

test("pasted keys are checked locally", () => {
  assert.equal(classifyPastedKey(""), "empty");
  assert.equal(classifyPastedKey(` ${KEY} `), "developer");
  assert.equal(classifyPastedKey(AGENT), "agent");
  assert.equal(classifyPastedKey(`kl_pub_${"q".repeat(32)}`), "publishable");
  assert.equal(classifyPastedKey("kl_dev_short"), "malformed");
});

test("the first call: the key tier with a live key, the public tier without one or with a sandbox key", () => {
  const live = firstCallPlan({ apiOrigin: API, account: ACCOUNT, key: KEY, lane: "any" });
  assert.equal(live.tier, "key");
  assert.equal(live.url, `${API}/v1/intents?dryRun=true`);
  assert.deepEqual(live.headers.find(([name]) => name === "authorization"), ["authorization", `Bearer ${KEY}`]);
  assert.deepEqual(JSON.parse(live.body), { text: "swap 1 SOL to USDC", accounts: [ACCOUNT] });

  const sandbox = firstCallPlan({ apiOrigin: API, account: ACCOUNT, key: KEY, lane: "testnet" });
  assert.equal(sandbox.tier, "public");
  assert.equal(sandbox.headers.some(([name]) => name === "authorization"), false);
  assert.match(sandbox.label, /public tier/u);

  for (const key of ["", "kl_dev_nope", `kl_pub_${"q".repeat(32)}`]) {
    const plan = firstCallPlan({ apiOrigin: API, account: ACCOUNT, key, lane: null });
    assert.equal(plan.tier, "public", key);
    assert.equal(plan.headers.some(([name]) => name === "authorization"), false, key);
  }
  assert.equal(firstCallPlan({ apiOrigin: API, account: ACCOUNT, key: AGENT, lane: null }).tier, "key");
});

test("snippets use $KLETIA_API_KEY and never the key; the .env line holds it only through envLine", () => {
  const curl = firstCallCurl(API, ACCOUNT, "key");
  assert.match(curl, /Bearer \$KLETIA_API_KEY/u);
  assert.ok(!curl.includes(KEY));
  assert.doesNotMatch(firstCallCurl(API, ACCOUNT, "public"), /authorization/u);
  for (const line of curl.split("\n").slice(0, -1)) assert.match(line, /\\$/u, "every continued line ends with a backslash");

  for (const { id } of START_SURFACES) {
    const files = shipFiles({ surface: id, apiOrigin: API, webOrigin: WEB, embedVersion: "0.1.0", account: ACCOUNT });
    assert.ok(files.length > 0, id);
    for (const file of files) {
      assert.doesNotMatch(file.code, /kl_(?:dev|agt)_[0-9A-Za-z]{32}/u, `${id}/${file.id}`);
      assert.ok(!file.code.includes("Bearer kl_"), `${id}/${file.id}`);
    }
  }
  assert.equal(ENV_FILE.split("\n").at(-1), "KLETIA_API_KEY=");
  assert.equal(envLine(` ${KEY} `), `KLETIA_API_KEY=${KEY}`);
});

test("files use this deployment's origins and the embed script of the package version", () => {
  const [html] = shipFiles({ surface: "embed", apiOrigin: API, webOrigin: WEB, embedVersion: "0.1.0", account: ACCOUNT });
  assert.ok(html.code.includes(`<script src="${WEB}/sdk/embed/0.1.0/kletia-embed.min.js" crossorigin="anonymous"></script>`));
  assert.ok(html.code.includes(`origin="${WEB}"`), "a self-hosted deployment names its origin");
  assert.match(html.code, /file:\/\//u, "says why file:// cannot work");
  const hosted = shipFiles({ surface: "embed", apiOrigin: "https://api.kletiaai.xyz", webOrigin: "https://kletiaai.xyz", embedVersion: "0.1.0", account: ACCOUNT });
  assert.doesNotMatch(hosted[0].code, / origin="/u, "the hosted origin is the element's default");
  const node = shipFiles({ surface: "node", apiOrigin: API, webOrigin: WEB, embedVersion: "0.1.0", account: ACCOUNT });
  assert.match(node[0].code, /process\.env\.KLETIA_API_KEY/u);
  assert.ok(node[0].code.includes(`baseUrl: "${API}"`));
  assert.deepEqual(node.map((file) => file.filename), ["plan.mjs", ".env"]);
  const rest = shipFiles({ surface: "rest", apiOrigin: API, webOrigin: WEB, embedVersion: "0.1.0", account: ACCOUNT });
  assert.match(rest[0].code, /set -a; \. \.\/\.env; set \+a/u);
});

test("Run's summary: status, time, steps, the first step and what arrives; errors show their code", () => {
  const ok = summarizeRun({
    status: 200,
    latencyMs: 287.4,
    requestId: "req_1",
    body: { steps: [{ title: "Swap 1 SOL for USDC", expectedOutput: { formatted: "105.7", symbol: "USDC" } }] },
  });
  assert.deepEqual(ok, { ok: true, line: "200 · 287 ms · 1 step · Swap 1 SOL for USDC · ≈105.7 USDC", requestId: "req_1" });
  assert.equal(summarizeRun({ status: 200, latencyMs: 10, body: { steps: [] } }).line, "200 · 10 ms · 0 steps");
  const wrapped = summarizeRun({
    status: 200,
    latencyMs: 320,
    body: { intent: { steps: [{ title: "Swap 1 SOL for USDC on Solana", expectedOutput: { formatted: "104.693365", symbol: "USDC" } }] } },
  });
  assert.equal(wrapped.line, "200 · 320 ms · 1 step · Swap 1 SOL for USDC on Solana · ≈104.693365 USDC", "the API wraps the graph in { intent }");
  const refused = summarizeRun({ status: 403, latencyMs: 40, body: { error: { code: "POLICY_VIOLATION", message: "…" } } });
  assert.deepEqual(refused, { ok: false, line: "403 · 40 ms · POLICY_VIOLATION", requestId: null });
  assert.equal(summarizeRun({ status: 502, latencyMs: 5, body: "<html>" }).line, "502 · 5 ms");
});

test("the issuance limit counts down from Retry-After", () => {
  const since = 1_000_000;
  assert.match(issueLimitMessage(720, since, since), /try again in 12 min\.$/u);
  assert.match(issueLimitMessage(720, since + 61_000, since), /try again in 11 min\.$/u);
  assert.match(issueLimitMessage(30, since + 31_000, since), /try again now/u);
  assert.match(issueLimitMessage(null, since, since), /5 per hour/u);
});
