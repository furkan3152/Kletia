/**
 * Round-6 CLI surfaces: `kletia journey` and `kletia stop` (journey design
 * 8.2), `kletia project get|set|verify-domain` and `keys create-publishable`
 * (integrator 4.8), `keys create --sandbox` and the lane column (P12),
 * `intents list --owner` (P11), and the own-contract fixes (P10): signature
 * lists that keep their commas, the ERC-4626 prefill in `contracts init`
 * and the pending-contract warning of a session.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { validateContractDefinition } from "@kletia/core";
import { listOption, splitList } from "../dist/args.js";
import { cli, send, stubServer } from "./helpers.mjs";

const KEY = "kl_dev_abcdefghijklmnopqrstuvwxyz012345";
const PUB = "kl_pub_0123456789ABCDEFGHIJabcdefghijkl";
const HASH = "b".repeat(64);
const VAULT = "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const JOURNEY = {
  spec: "kletia.journey/v1",
  intentId: "int_j",
  computedAt: "2026-10-14T13:33:44.120Z",
  stage: "plan",
  basis: { intentUpdatedAt: "x", previewDigest: null, reads: "live", factsAt: null },
  stops: [
    {
      id: "start:s1", index: 0, kind: "start", network: "solana", holder: { account: null, own: true, label: "Your wallet" }, custody: "wallet", state: "current",
      holdings: [{ asset: { symbol: "USDC", decimals: 6 }, identity: { kind: "issuer", label: "Circle USDC" }, expected: { amount: "100000000", formatted: "100" }, atLeast: { amount: "100000000", formatted: "100" }, certainty: "quoted", value: { expectedUsd: 100, atLeastUsd: 100, price: 1, source: "usd-par", at: "x" }, role: "spent-next" }],
    },
    {
      id: "out:s1", index: 1, kind: "arrival", network: "base", holder: { account: null, own: true, label: "Your wallet" }, custody: "wallet", state: "upcoming",
      holdings: [{ asset: { symbol: "USDC", decimals: 6 }, identity: { kind: "issuer", label: "Circle USDC" }, expected: { amount: "99956099", formatted: "99.956099" }, atLeast: { amount: "99456319", formatted: "99.456319" }, certainty: "venue-minimum", value: { expectedUsd: 99.96, atLeastUsd: 99.46, price: 1, source: "usd-par", at: "x" }, role: "kept" }],
      eta: { afterFirstSignatureSeconds: 20, certainty: "quoted" },
    },
  ],
  legs: [{ id: "s1", index: 0, from: "start:s1", to: "out:s1", kind: "bridge", title: "Bridge 100 USDC from Solana to Base", network: "solana", destinationNetwork: "base", venue: { protocol: "relay", name: "Relay" }, signer: null, signatures: 1, seconds: 20, status: "ready" }],
  now: { stopIds: ["start:s1"], legId: "s1", waitingFor: "signature" },
  consequences: [
    { id: "time-window:start:s1", kind: "time-window", severity: "info", stopId: "start:s1", legIds: ["s1"], title: "This plan is valid until 14:03 UTC", detail: "Sign leg 1 before then.", certainty: "quoted", facts: {}, source: "Plan", options: [], collapsed: true },
    {
      id: "gas-to-continue:out:s1:base", kind: "gas-to-continue", severity: "block", stopId: "out:s1", legIds: ["s2"], title: "No ETH on Base to sign leg 2", detail: "Leg 2 needs about 0.0000017 ETH.", certainty: "simulated-assumed-funds", facts: {}, source: "Preview",
      options: [
        { id: "gas-topup", label: "Add $0.05 of ETH on arrival", recommended: true, costUsd: 0.07, effect: "x", action: { type: "acknowledge" } },
        { id: "bring-gas", label: "I will send ETH to Base myself", recommended: false, costUsd: null, effect: "x", action: { type: "acknowledge" } },
      ],
      prompt: { question: "How should ETH get there?", defaultOptionId: "gas-topup" }, collapsed: false,
    },
  ],
  blockers: ["gas-to-continue:out:s1:base"],
  digest: "sha256:j",
};

const project = (version = 4) => ({
  id: "prj_key_1",
  version,
  hash: HASH,
  settings: { schema: "kletia.project/v1", brand: { name: "Acme Store", website: "https://acme.example" }, allowedOrigins: ["https://acme.example"], defaults: { lane: "testnet", networks: ["arbitrum-sepolia"] } },
  domain: { host: "acme.example", verified: false, checkedAt: null, file: '{"projects":["prj_key_1"]}' },
  updatedAt: "2026-10-14T12:00:00.000Z",
  updatedBy: "key_1",
});

const DEPOSIT_EVENT = { type: "event", name: "Deposit", anonymous: false, inputs: [{ name: "sender", type: "address", indexed: true }, { name: "owner", type: "address", indexed: true }, { name: "assets", type: "uint256", indexed: false }, { name: "shares", type: "uint256", indexed: false }] };
const fn = (name, inputs, stateMutability = "nonpayable") => ({ type: "function", name, stateMutability, inputs, outputs: [] });
const VAULT_ABI = [fn("deposit", [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }]), fn("mint", [{ name: "shares", type: "uint256" }, { name: "receiver", type: "address" }]), fn("asset", [], "view"), DEPOSIT_EVENT];

let api;
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "kletia-r6-"));
  api = await stubServer((req, res) => {
    const route = `${req.method} ${req.path}`;
    if (route === "GET /v1/intents/int_j/journey") return send(res, 200, { journey: JOURNEY });
    if (route === "POST /v1/intents/int_j/stop") return send(res, 200, { intent: { id: "int_j", status: "partially_completed", summary: { title: "Bridge" }, request: { accounts: [] }, warnings: [], steps: [] }, journey: { ...JOURNEY, consequences: [], blockers: [] } });
    if (route === "GET /v1/intents") return send(res, 200, { intents: [] });
    if (route === "GET /v1/projects/current") return send(res, 200, { project: project() });
    if (route === "PATCH /v1/projects/current") return send(res, 200, { project: project(5) });
    if (route === "POST /v1/projects/current/domain/verify") return send(res, 200, { project: { ...project(), domain: { ...project().domain, verified: true, checkedAt: "2026-10-14T12:05:00.000Z" } } });
    if (route === "POST /v1/projects/current/publishable-keys") return send(res, 201, { key: { id: "key_pub_1", key: PUB, label: req.body.label, kind: "publishable", parentId: "key_1", createdAt: "x" } });
    if (route === "POST /v1/keys") return send(res, 201, { key: { id: "key_s", name: req.body.name, tier: "developer", key: "kl_dev_sandboxsecret0123456789", lane: req.body.sandbox ? "testnet" : "any" } });
    if (route === "GET /v1/keys") return send(res, 200, { keys: [{ id: "key_s", name: "sandbox", tier: "developer", last4: "6789", createdAt: "x", lastUsedAt: null, rotatedAt: null, previousExpiresAt: null, revokedAt: null, current: true, lane: "testnet" }] });
    if (route === "GET /v1/contracts/inspect") {
      return send(res, 200, {
        inspection: {
          vm: "evm", network: "base", address: req.url.searchParams.get("address"), deployed: true, codeSize: 100, eip7702: false, denied: null,
          pins: { codeHash: `0x${"1".repeat(64)}`, codeSize: 100, blockNumber: "1", proxy: null },
          verification: { source: { status: "exact_match", provider: "sourcify", checkedAt: "x" }, implementationSource: null },
          abi: VAULT_ABI,
          functions: [{ name: "deposit", signature: "deposit(uint256,address)", selector: "0x6e553f65", stateMutability: "nonpayable", allowed: true, code: null, reason: null, notes: [] }],
          hints: { erc4626: { asset: USDC, registrySymbol: "USDC" } },
        },
      });
    }
    if (route === "POST /v1/sessions") {
      return send(res, 201, { session: { id: `cs_${"a".repeat(32)}`, status: "active", expiresAt: "2026-10-14T13:00:00.000Z", used: 0, maxIntents: 1, integrator: { name: "Acme", verified: false }, allowedOrigins: ["https://acme.example"], actions: [], warnings: [{ code: "CONTRACT_PENDING", contract: "ct_5f1c2a9b7e3d4c6a8b0e1f23", activatesAt: "2026-10-15T12:00:00.000Z" }] } });
    }
    return false;
  });
});

after(() => api.close());

const keyed = (args, options = {}) => cli(args, { base: api.base, env: { KLETIA_API_KEY: KEY }, ...options });

test("kletia journey prints stops, legs and consequences by severity; --json prints the API object", async () => {
  const result = await cli(["journey", "int_j", "--refresh"], { base: api.base });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests.at(-1).url.searchParams.get("refresh"), "true");
  const out = result.stdout;
  assert.match(out, /Journey of int_j \(plan, reads live/u);
  assert.match(out, /0\s+solana\s+Your wallet\s+wallet\s+current\s+100 USDC\s+100 USDC\s+\$100\.00 \(usd-par\)\s+quoted/u);
  assert.match(out, /1\s+base\s+Your wallet\s+wallet\s+upcoming\s+99\.956099 USDC\s+99\.456319 USDC\s+\$99\.96 \(usd-par\)\s+venue-minimum\s+\+20s/u);
  assert.match(out, /s1\s+bridge\s+solana→base\s+Relay\s+20s\s+1\s+ready/u);
  assert.ok(out.indexOf("BLOCK  No ETH on Base") < out.indexOf("info   This plan is valid"), "blocking consequences first");
  assert.match(out, /- Add \$0\.05 of ETH on arrival \(recommended\)  \[gas-to-continue:out:s1:base=gas-topup\]/u);
  assert.match(out, /Now: waiting for signature at start:s1/u);
  assert.match(out, /Answer before the next signature: gas-to-continue:out:s1:base/u);
  const json = await cli(["journey", "int_j", "--json"], { base: api.base });
  assert.equal(JSON.parse(json.stdout).journey.digest, "sha256:j");
  assert.equal((await cli(["journey", "int_j", "--reads", "some"], { base: api.base })).code, 64);
});

test("kletia stop posts …/stop and prints the stopped intent and its journey", async () => {
  const result = await cli(["stop", "int_j"], { base: api.base });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests.at(-1).method, "POST");
  assert.equal(api.requests.at(-1).path, "/v1/intents/int_j/stop");
  assert.match(result.stdout, /status partially_completed/u);
  assert.match(result.stdout, /Journey of int_j/u);
});

test("intents list --owner and keys create --sandbox; keys list shows the lane", async () => {
  assert.equal((await keyed(["intents", "list", "--owner", "key_pub_1", "--limit", "5"])).code, 0);
  assert.equal(api.requests.at(-1).url.searchParams.get("owner"), "key_pub_1");
  assert.equal(api.requests.at(-1).url.searchParams.get("limit"), "5");
  const created = await cli(["keys", "create", "sandbox", "--sandbox", "--json"], { base: api.base });
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(api.requests.at(-1).body, { name: "sandbox", sandbox: true });
  assert.equal(JSON.parse(created.stdout).lane, "testnet");
  const plain = await cli(["keys", "create", "plain", "--json"], { base: api.base });
  assert.equal(plain.code, 0);
  assert.deepEqual(api.requests.at(-1).body, { name: "plain" });
  const list = await keyed(["keys", "list"]);
  assert.match(list.stdout, /lane/u);
  assert.match(list.stdout, /key_s \*\s+sandbox\s+…6789\s+active\s+testnet/u);
});

test("kletia project get, set (If-Match) and verify-domain; keys create-publishable shows the key once", async () => {
  const shown = await keyed(["project", "get"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /prj_key_1  version 4  hash b{64}/u);
  assert.match(shown.stdout, /publish at https:\/\/acme\.example\/\.well-known\/kletia\.json: \{"projects":\["prj_key_1"\]\}/u);
  const patch = join(dir, "patch.json");
  await writeFile(patch, JSON.stringify({ allowedOrigins: ["https://acme.example", "http://localhost:3000"], brand: null }));
  const set = await keyed(["project", "set", "--file", patch, "--if-match", HASH]);
  assert.equal(set.code, 0, set.stderr);
  const patched = api.requests.at(-1);
  assert.equal(patched.method, "PATCH");
  assert.equal(patched.headers["if-match"], `"${HASH}"`);
  assert.deepEqual(patched.body.allowedOrigins, ["https://acme.example", "http://localhost:3000"]);
  assert.match(set.stderr, /Saved version 5/u);
  const before = api.requests.length;
  const implicit = await keyed(["project", "set", "--file", patch]);
  assert.equal(implicit.code, 0);
  assert.deepEqual(api.requests.slice(before).map((request) => request.method), ["GET", "PATCH"], "without --if-match the current hash is read first");
  assert.equal((await keyed(["project", "set", "--file", patch, "--if-match", "v4"])).code, 64);
  const verified = await keyed(["project", "verify-domain"]);
  assert.match(verified.stderr, /The domain is verified\./u);
  const pub = await keyed(["keys", "create-publishable", "--label", "website", "--json"]);
  assert.equal(pub.code, 0, pub.stderr);
  assert.equal(JSON.parse(pub.stdout).key, PUB);
  assert.deepEqual(api.requests.at(-1).body, { label: "website" });
  const terminal = await keyed(["keys", "create-publishable"], { tty: true });
  assert.equal(terminal.code, 64, "a terminal needs --reveal or --secret-file, like every minted key");
});

test("--function keeps canonical signatures whole (commas inside parentheses)", () => {
  assert.deepEqual(splitList("deposit(uint256,address),mint(uint256,address)"), ["deposit(uint256,address)", "mint(uint256,address)"]);
  assert.deepEqual(splitList("deposit, mint"), ["deposit", "mint"]);
  assert.deepEqual(listOption({ function: ["deposit(uint256,address)", "redeem(uint256,address,address),withdraw"] }, "function"), ["deposit(uint256,address)", "redeem(uint256,address,address)", "withdraw"]);
  assert.deepEqual(splitList("swap((address,uint256),bytes)"), ["swap((address,uint256),bytes)"]);
});

test("contracts init prefills an ERC-4626 vault's deposit from the inspection hint", async () => {
  const out = join(dir, "vault.json");
  const result = await keyed(["contracts", "init", "--network", "base", "--address", VAULT, "--out", out, "--function", "deposit(uint256,address)", "--name", "Acme", "--website", "https://acme.example"]);
  assert.equal(result.code, 0, result.stderr);
  const starter = JSON.parse(await readFile(out, "utf8"));
  assert.equal(starter.actions.length, 1, "the signature selected exactly one function");
  const [deposit] = starter.actions;
  assert.equal(deposit.function, "deposit(uint256,address)");
  assert.deepEqual(deposit.args, ["$amount", "$account"]);
  assert.deepEqual(deposit.input, { token: "USDC", approval: { spender: "$self" } });
  assert.deepEqual(deposit.output, { token: "$self", toleranceBps: 10 });
  assert.deepEqual(deposit.events, [{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$amount" }, output: "shares" }]);
  assert.deepEqual(deposit.phrases, { verbs: ["deposit"], aliases: ["acme vault"] });
  assert.match(deposit.limits.maxAmount, /^TODO/u, "the mainnet cap stays a decision");
  assert.match(result.stdout, /ERC-4626 vault: the deposit entry takes USDC/u);
  deposit.limits.maxAmount = "25000";
  const checked = validateContractDefinition(starter);
  assert.ok(checked.ok, JSON.stringify(checked.issues));
});

test("sessions create prints a pending-contract warning", async () => {
  const file = join(dir, "session.json");
  await writeFile(file, JSON.stringify({ actions: [{ kind: "call", network: "base", contract: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entry: "deposit", amount: "10" }], allowedOrigins: ["https://acme.example"], expiresInSeconds: 900 }));
  const result = await keyed(["sessions", "create", "--file", file]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /warning: ct_5f1c2a9b7e3d4c6a8b0e1f23 is still pending; it activates at 2026-10-15 12:00:00Z/u);
});
