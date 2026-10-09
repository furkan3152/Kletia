import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CONTRACT_REVIEW_NOTICE, validateContractDefinition } from "@kletia/core";
import { run } from "../dist/index.js";

const API_KEY = "kl_dev_abcdefghijklmnopqrstuvwxyz012345";
const EVM = "0x000000000000000000000000000000000000dEaD";
const VAULT = "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const IMPLEMENTATION = "0x2ce6311ddae708829bc0784c967b7d77d19fd779";
const CT = "ct_5f1c2a9b7e3d4c6a8b0e1f23";
const CS = `cs_${"0123456789abcdef".repeat(2)}`;
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const fn = (name, inputs, stateMutability = "nonpayable") => ({ type: "function", name, stateMutability, inputs, outputs: [] });
const DEPOSIT_EVENT = {
  type: "event",
  name: "Deposit",
  anonymous: false,
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "owner", type: "address", indexed: true },
    { name: "assets", type: "uint256", indexed: false },
    { name: "shares", type: "uint256", indexed: false },
  ],
};
const VAULT_ABI = [
  { type: "error", name: "ZeroShares", inputs: [] },
  { type: "event", name: "Transfer", anonymous: false, inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] },
  fn("deposit", [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }]),
  fn("redeem", [{ name: "shares", type: "uint256" }, { name: "receiver", type: "address" }, { name: "owner", type: "address" }]),
  fn("approve", [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }]),
  fn("balanceOf", [{ name: "account", type: "address" }], "view"),
  DEPOSIT_EVENT,
];

const DEFINITION = {
  vm: "evm",
  network: "base",
  address: VAULT,
  integrator: { name: "Acme Yield", website: "https://acme.example" },
  abi: [VAULT_ABI[2], DEPOSIT_EVENT],
  actions: [
    {
      id: "deposit",
      label: "Deposit into Acme USDC vault",
      function: "deposit(uint256,address)",
      args: ["$amount", "$account"],
      input: { token: "USDC", approval: { spender: "$self" } },
      output: { token: "$self", toleranceBps: 10 },
      events: [{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$amount" }, output: "shares" }],
      phrases: { verbs: ["deposit"], aliases: ["acme vault"] },
      limits: { maxAmount: "25000" },
    },
  ],
};

const contractView = (overrides = {}) => ({
  id: CT,
  vm: "evm",
  network: "base",
  address: VAULT,
  integrator: { name: "Acme Yield", website: "https://acme.example", domainVerified: false },
  visibility: "private",
  status: "pending",
  revision: 1,
  activeRevision: null,
  pendingRevision: 1,
  activatesAt: "2026-10-09T12:15:00.000Z",
  definitionHash: "9c1e".padEnd(64, "0"),
  pins: {
    codeHash: `0xa6705a10${"0".repeat(56)}`,
    codeSize: 21808,
    proxy: { kind: "zeppelinos", implementation: IMPLEMENTATION, implementationCodeHash: `0x11b75a23${"0".repeat(56)}`, admin: null, beacon: null, beaconCodeHash: null },
    addresses: [],
    blockNumber: "52376674",
    checkedAt: "2026-10-09T10:41:00.000Z",
  },
  verification: { source: { status: "exact_match", provider: "sourcify", checkedAt: "x" }, implementationSource: { status: "exact_match", provider: "sourcify", checkedAt: "x" }, domain: { verified: false, checkedAt: null } },
  actions: [{ ...DEFINITION.actions[0], selector: "0x6e553f65" }],
  createdAt: "2026-10-09T12:00:00.000Z",
  updatedAt: "2026-10-09T12:00:00.000Z",
  suspendedReason: null,
  ...overrides,
});

const usdc = (amount, formatted) => ({ asset: `eip155:8453/erc20:${USDC}`, symbol: "USDC", decimals: 6, amount, formatted });
const testResult = (status = "ok") => ({
  contract: CT,
  revision: 1,
  entry: "deposit",
  network: "base",
  account: `eip155:8453:${EVM}`,
  input: usdc("100000000", "100"),
  expectedOutput: { asset: `eip155:8453/erc20:${VAULT}`, symbol: "steakUSDC", decimals: 18, amount: "90605876748956758586", formatted: "90.605876748956758586" },
  transactions: [
    { description: "Approve exactly 100 USDC for Acme Yield (0xbeeF…8183)", to: USDC, selector: "0x095ea7b3", value: "0" },
    { description: "Deposit into Acme USDC vault (Acme Yield)", to: VAULT, selector: "0x6e553f65", value: "0" },
  ],
  gas: "404971",
  feesUsd: 0.01,
  review: {
    kind: "evm-call",
    integrator: { name: "Acme Yield", website: "https://acme.example", domainVerified: false },
    notices: [CONTRACT_REVIEW_NOTICE, "Domain not verified."],
    contract: { network: "base", address: VAULT, explorerUrl: "https://basescan.org", source: "exact_match", registeredAt: "x", revision: 1 },
    call: {
      label: "Deposit into Acme USDC vault",
      function: "deposit(uint256 assets, address receiver)",
      args: [
        { name: "assets", type: "uint256", display: "100 USDC", source: "amount" },
        { name: "receiver", type: "address", display: EVM, source: "account" },
      ],
    },
    approvals: [{ token: { asset: `eip155:8453/erc20:${USDC}`, symbol: "USDC", decimals: 6 }, spender: VAULT, amount: usdc("100000000", "100") }],
    simulation: {
      status,
      at: "2026-10-09T12:01:00.000Z",
      block: "52376674",
      assetChanges: [
        { asset: `eip155:8453/erc20:${USDC}`, symbol: "USDC", decimals: 6, listed: true, delta: "-100000000", formatted: "-100" },
        { asset: `eip155:8453/erc20:${VAULT}`, symbol: "steakUSDC", decimals: 18, listed: false, delta: "90605876748956758586", formatted: "+90.605876748956758586" },
        { asset: "eip155:8453/erc20:0x4200000000000000000000000000000000000042", symbol: "OP", decimals: 18, listed: true, delta: "5", formatted: "0.000000000000000005" },
      ],
      networkFee: { asset: "eip155:8453/slip44:60", symbol: "ETH", decimals: 18, amount: "4049710000000", formatted: "0.00000404971", usd: 0.01 },
      warnings: [],
    },
  },
  warnings: [],
});

const session = {
  id: CS,
  status: "active",
  expiresAt: "2026-10-09T12:15:00.000Z",
  createdAt: "2026-10-09T12:00:00.000Z",
  integrator: { name: "Acme Yield", website: "https://acme.example", domainVerified: true },
  allowedOrigins: ["https://acme.example"],
  actions: [{ kind: "call", network: "base", contract: CT, entry: "deposit", amount: "100", label: "Deposit into Acme USDC vault" }],
  amount: { action: 0, min: "10", max: "1000", default: "100", symbol: "USDC" },
  maxIntents: 1,
  used: 0,
  embedUrl: `https://kletiaai.xyz/embed#session=${CS}`,
};

/* ------------------------------------------------------------ stub API */

const requests = [];
const settings = { abi: VAULT_ABI, testStatus: "ok" };

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "x-request-id": "req-ct" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

const api = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url, "http://127.0.0.1");
  const body = text ? JSON.parse(text) : undefined;
  requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body });
  const route = `${req.method} ${url.pathname}`;
  if (route === `GET /v1/sessions/${CS}`) return send(res, 200, { session: { ...session, embedUrl: undefined } });
  if (req.headers.authorization !== `Bearer ${API_KEY}`) return send(res, 401, { error: { code: "API_KEY_REQUIRED", message: "This endpoint requires an API key." } });
  if (route === "POST /v1/contracts") return send(res, 201, { contract: contractView() });
  if (route === "GET /v1/contracts") return send(res, 200, { contracts: [contractView(), contractView({ id: "ct_000000000000000000000002", status: "suspended", suspendedReason: "pins_changed" })] });
  if (route === "GET /v1/contracts/inspect") {
    const network = url.searchParams.get("network");
    if (network === "solana") {
      return send(res, 200, {
        inspection: {
          vm: "svm",
          network,
          programs: url.searchParams.get("programs").split(",").map((program) => ({
            program,
            pin: { program, loader: "BPFLoaderUpgradeab1e11111111111111111111111", programData: "4Ec7", lastDeploySlot: "454465850", upgradeAuthority: "CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ" },
            denied: null,
            verification: { program, verified: false, provider: "ottersec", checkedAt: "x" },
          })),
        },
      });
    }
    const address = url.searchParams.get("address");
    const denied = address.toLowerCase() === USDC.toLowerCase() ? "USDC is a registry token; calling a token directly is refused." : null;
    return send(res, 200, {
      inspection: {
        vm: "evm",
        network,
        address,
        deployed: true,
        codeSize: 21808,
        eip7702: false,
        denied,
        pins: contractView().pins,
        verification: { source: { status: settings.abi ? "exact_match" : "unverified", provider: "sourcify", checkedAt: "x" }, implementationSource: null },
        abi: settings.abi,
        functions: settings.abi
          ? [
              { name: "deposit", signature: "deposit(uint256,address)", selector: "0x6e553f65", stateMutability: "nonpayable", allowed: true, code: null, reason: null, notes: [] },
              { name: "approve", signature: "approve(address,uint256)", selector: "0x095ea7b3", stateMutability: "nonpayable", allowed: false, code: "CONTRACT_FUNCTION_FORBIDDEN", reason: "approves the contract's own token to anyone.", notes: [] },
            ]
          : [],
      },
    });
  }
  if (route === `GET /v1/contracts/${CT}`) return send(res, 200, { contract: { ...contractView(), revisions: [{ revision: 1, definitionHash: "9c1e".padEnd(64, "0"), createdAt: "2026-10-09T12:00:00.000Z" }] } });
  if (route === `PATCH /v1/contracts/${CT}`) return send(res, 200, { contract: contractView({ status: "active", activeRevision: 1, revision: 2, pendingRevision: 2 }) });
  if (route === `DELETE /v1/contracts/${CT}`) return send(res, 204);
  if (route === `POST /v1/contracts/${CT}/test`) return send(res, 200, { test: testResult(settings.testStatus) });
  if (route === `POST /v1/contracts/${CT}/reverify`) return send(res, 200, { contract: contractView({ status: "active", activeRevision: 1, pendingRevision: null, activatesAt: null }) });
  if (route === "POST /v1/sessions") return send(res, 201, { session });
  return send(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${route}` } });
});

let BASE;
let DIR;

before(async () => {
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  BASE = `http://127.0.0.1:${api.address().port}`;
  DIR = await mkdtemp(join(tmpdir(), "kletia-contracts-"));
});

after(() => {
  api.closeAllConnections?.();
  api.close();
});

async function cli(args, { env = { KLETIA_API_KEY: API_KEY }, stdin } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    stdout: { write: (chunk) => { stdout += chunk; }, isTTY: false },
    stderr: { write: (chunk) => { stderr += chunk; } },
    env: { KLETIA_BASE_URL: BASE, ...env },
    ...(stdin !== undefined ? { readStdin: async () => stdin } : {}),
  });
  return { code, stdout, stderr };
}

async function file(name, value) {
  const path = join(DIR, name);
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return path;
}

const last = () => requests.at(-1);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/* ---------------------------------------------------------------- tests */

test("contracts register validates locally, sends the file and explains activation and domain verification", async () => {
  const path = await file("acme.json", DEFINITION);
  const result = await cli(["contracts", "register", "--file", path]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(last().method, "POST");
  assert.equal(last().path, "/v1/contracts");
  assert.deepEqual(last().body, DEFINITION, "the file as written");
  assert.match(last().headers["idempotency-key"], UUID);
  assert.match(result.stdout, new RegExp(`^${CT}  Acme Yield \\(https://acme\\.example, domain not verified\\)`, "u"));
  assert.match(result.stdout, /status pending until 2026-10-09 12:15:00Z/u);
  assert.match(result.stdout, /zeppelinos proxy → 0x2ce6311ddae708829bc0784c967b7d77d19fd779/u);
  assert.match(result.stdout, /deposit\s+deposit\(uint256,address\) 0x6e553f65\s+Deposit into Acme USDC vault\s+deposit → acme vault/u);
  assert.match(result.stderr, /\.well-known\/kletia\.json containing \{"contracts":\["ct_5f1c2a9b7e3d4c6a8b0e1f23"\]\}/u);
  assert.match(result.stderr, /kletia contracts test ct_5f1c2a9b7e3d4c6a8b0e1f23 --entry deposit/u);

  const json = await cli(["contracts", "register", "--file", "-", "--json"], { stdin: JSON.stringify(DEFINITION) });
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).id, CT);
});

test("contracts register refuses an unsafe definition locally, before any request", async () => {
  const unsafe = structuredClone(DEFINITION);
  unsafe.abi.push(VAULT_ABI[4]);
  unsafe.actions.push({ ...structuredClone(DEFINITION.actions[0]), id: "approve", function: "approve(address,uint256)", args: ["$self", "$amount"], phrases: undefined });
  delete unsafe.actions[1].phrases;
  const path = await file("unsafe.json", unsafe);
  const before = requests.length;
  const result = await cli(["contracts", "register", "--file", path]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /CONTRACT_FUNCTION_FORBIDDEN: The contract definition is invalid \(checked locally; nothing was sent\)/u);
  assert.match(result.stderr, /abi\[2\]: approve\(address,uint256\) has the selector 0x095ea7b3/u);
  assert.match(result.stderr, /docs: https:\/\/kletiaai\.xyz\/developers#error-CONTRACT_FUNCTION_FORBIDDEN/u);
  const json = await cli(["contracts", "register", "--file", path, "--json"]);
  assert.equal(JSON.parse(json.stderr).error.code, "CONTRACT_FUNCTION_FORBIDDEN");

  // A literal receiver would credit the deposit to someone else.
  const redirected = structuredClone(DEFINITION);
  redirected.actions[0].args = ["$amount", { literal: EVM }];
  const binding = await cli(["contracts", "register", "--file", await file("redirect.json", redirected)]);
  assert.equal(binding.code, 1);
  assert.match(binding.stderr, /CONTRACT_BINDING_INVALID/u);
  assert.equal(requests.length, before, "nothing was sent");
});

test("contracts register: usage errors stop before the API", async () => {
  const before = requests.length;
  assert.equal((await cli(["contracts", "register"])).code, 64);
  const missing = await cli(["contracts", "register", "--file", join(DIR, "nope.json")]);
  assert.equal(missing.code, 64);
  assert.match(missing.stderr, /Cannot read .*nope\.json \(ENOENT\)/u);
  const broken = await cli(["contracts", "register", "--file", await file("broken.json", "{ not json")]);
  assert.equal(broken.code, 64);
  assert.match(broken.stderr, /is not valid JSON/u);
  const keyless = await cli(["contracts", "register", "--file", await file("ok.json", DEFINITION)], { env: {} });
  assert.equal(keyless.code, 64);
  assert.match(keyless.stderr, /needs an API key/u);
  assert.equal(requests.length, before);
});

test("contracts list, get, update, delete and reverify call their routes", async () => {
  const listed = await cli(["contracts", "list", "--network", "base", "--status", "active"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(last().search, "?network=base&status=active");
  assert.match(listed.stdout, /^contract\s+status\s+network\s+target/mu);
  assert.match(listed.stdout, /ct_000000000000000000000002\s+suspended \(pins_changed\)/u);
  assert.equal((await cli(["contracts", "list", "--vm", "tvm"])).code, 64);

  const shown = await cli(["contracts", "get", CT]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /pins: code 0xa670…0000 \(21808 bytes\) at block 52376674/u);
  assert.match(shown.stdout, /source: exact_match, implementation exact_match/u);
  assert.match(shown.stdout, /revisions: 1 \(2026-10-09 12:00:00Z, 9c1e00000000\)/u);
  const before = requests.length;
  const badId = await cli(["contracts", "get", "ct_nope"]);
  assert.equal(badId.code, 64);
  assert.equal(requests.length, before);

  const patch = { actions: [{ ...DEFINITION.actions[0], label: "Deposit USDC" }] };
  const updated = await cli(["contracts", "update", CT, "--file", await file("patch.json", patch)]);
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal(last().method, "PATCH");
  assert.deepEqual(last().body, patch);
  assert.match(last().headers["idempotency-key"], UUID);
  assert.match(updated.stderr, /active; revision 2 activates/u);
  assert.equal((await cli(["contracts", "update", CT, "--file", await file("empty.json", {})])).code, 64);

  assert.equal((await cli(["contracts", "delete", CT])).code, 64, "needs --yes");
  const deleted = await cli(["contracts", "delete", CT, "--yes"]);
  assert.equal(deleted.code, 0);
  assert.equal(last().method, "DELETE");
  assert.equal(deleted.stdout, `Deleted ${CT}.\n`);

  const reverified = await cli(["contracts", "reverify", CT]);
  assert.equal(reverified.code, 0);
  assert.equal(last().path, `/v1/contracts/${CT}/reverify`);
  assert.match(reverified.stderr, /Re-verified ct_5f1c2a9b7e3d4c6a8b0e1f23: active\./u);
});

test("contracts test prints the review users will see and never signs", async () => {
  const result = await cli(["contracts", "test", CT, "--entry", "deposit", "--account", `base:${EVM}`, "--amount", "100", "--param", "lockDays=30"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(last().body, { entry: "deposit", account: `eip155:8453:${EVM}`, amount: "100", params: { lockDays: "30" } });
  assert.equal(last().headers["idempotency-key"], undefined);
  const out = result.stdout;
  assert.match(out, /in 100 USDC → out 90\.605876 steakUSDC/u);
  assert.match(out, /1\s+Approve exactly 100 USDC for Acme Yield .*0x095ea7b3/u);
  assert.match(out, /Who: Acme Yield \(https:\/\/acme\.example, domain not verified\)/u);
  assert.match(out, /What: Deposit into Acme USDC vault\n\s+deposit\(uint256 assets, address receiver\) on base 0xbeeF/u);
  assert.match(out, /assets\s+100 USDC\s+your amount/u);
  assert.match(out, /receiver\s+0x0+dEaD\s+your address/u);
  assert.match(out, /allow 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183 to spend exactly 100 USDC/u);
  assert.match(out, /Result \(simulation ok at block 52376674\):\n\s+-100 USDC\n\s+\+90\.605876748956758586 steakUSDC \(unlisted\)\n\s+\+0\.000000000000000005 OP\n/u);
  assert.doesNotMatch(out, /\+\+/u);
  assert.match(out, /Provenance: source exact_match/u);
  assert.match(out, /Notice: Not audited by Kletia\./u);
  // Who, what, permissions, result, provenance, notice: in that order.
  const order = ["Who:", "What:", "Permissions:", "Result", "Provenance:", "Notice:"].map((label) => out.indexOf(label));
  assert.deepEqual([...order].sort((a, b) => a - b), order);

  settings.testStatus = "unavailable";
  try {
    assert.equal((await cli(["contracts", "test", CT, "--entry", "deposit", "--account", `base:${EVM}`, "--amount", "100"])).code, 1, "an unproven simulation is not a pass");
  } finally {
    settings.testStatus = "ok";
  }

  const before = requests.length;
  assert.equal((await cli(["contracts", "test", CT, "--account", `base:${EVM}`])).code, 64, "--entry is required");
  assert.equal((await cli(["contracts", "test", CT, "--entry", "deposit", "--account", "base:nope"])).code, 64);
  const amount = await cli(["contracts", "test", CT, "--entry", "deposit", "--account", `base:${EVM}`, "--amount", "ten"]);
  assert.equal(amount.code, 64);
  assert.match(amount.stderr, /--amount: Must be a positive decimal string/u);
  assert.equal((await cli(["contracts", "test", CT, "--entry", "deposit", "--account", `base:${EVM}`, "--param", "lockDays"])).code, 64);
  assert.equal(requests.length, before);
});

test("contracts inspect shows pins, proxy and functions with allow/deny marks; Solana programs with authorities", async () => {
  const evm = await cli(["contracts", "inspect", "--network", "base", "--address", VAULT]);
  assert.equal(evm.code, 0, evm.stderr);
  assert.equal(last().search, `?network=base&address=${VAULT}`);
  assert.match(evm.stdout, /proxy zeppelinos → 0x2ce6311ddae708829bc0784c967b7d77d19fd779/u);
  assert.match(evm.stdout, /^ok\s+deposit\(uint256,address\)\s+0x6e553f65/mu);
  assert.match(evm.stdout, /^no\s+approve\(address,uint256\)\s+0x095ea7b3\s+nonpayable\s+approves the contract's own token/mu);

  const svm = await cli(["contracts", "inspect", "--network", "solana", "--program", JUP]);
  assert.equal(svm.code, 0, svm.stderr);
  assert.equal(new URLSearchParams(last().search).get("programs"), JUP);
  assert.match(svm.stdout, /JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4\s+allowed\s+upgradeable by CvQZZ23q\S+\s+454465850\s+not verified/u);

  const before = requests.length;
  assert.equal((await cli(["contracts", "inspect", "--network", "base"])).code, 64);
  assert.equal((await cli(["contracts", "inspect", "--network", "solana", "--address", VAULT])).code, 64);
  assert.equal(requests.length, before);
});

test("contracts init writes a starter from the verified ABI with only registrable functions", async () => {
  const out = join(DIR, "starter.json");
  const result = await cli(["contracts", "init", "--network", "base", "--address", VAULT.toLowerCase(), "--out", out, "--name", "Acme Yield", "--website", "https://acme.example"]);
  assert.equal(result.code, 0, result.stderr);
  const starter = JSON.parse(await readFile(out, "utf8"));
  assert.equal(starter.address, VAULT, "checksummed");
  assert.deepEqual(starter.abi.map((item) => item.name), ["deposit", "redeem", "Deposit", "Transfer"], "approve, balanceOf and errors are left out; referenced events first");
  const [deposit, redeem] = starter.actions;
  assert.deepEqual(deposit.args, ["$amount", "$account"]);
  assert.deepEqual(deposit.events, [{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$amount" } }]);
  assert.match(deposit.input.token, /^TODO/u);
  assert.match(redeem.args[0], /^TODO: bind shares \(uint256\)/u, "only unambiguous bindings are guessed");
  assert.deepEqual(redeem.args.slice(1), ["$account", "$account"]);
  assert.match(redeem.events[0].event, /^TODO/u, "Deposit does not prove a redeem");
  assert.match(result.stdout, /Wrote .*starter\.json for base:0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183 \(actions: deposit, redeem\)/u);
  assert.match(result.stdout, /Decide these before `kletia contracts register/u);
  assert.match(result.stdout, /actions\[0\]\.input\.token/u);

  // Deciding the TODOs of one action gives a definition the validator accepts.
  const chosen = join(DIR, "deposit.json");
  assert.equal((await cli(["contracts", "init", "--network", "base", "--address", VAULT, "--out", chosen, "--function", "deposit", "--name", "Acme Yield", "--website", "https://acme.example"])).code, 0);
  const one = JSON.parse(await readFile(chosen, "utf8"));
  one.actions[0].input.token = "USDC";
  one.actions[0].limits.maxAmount = "25000";
  const checked = validateContractDefinition(one);
  assert.ok(checked.ok, JSON.stringify(checked.issues));

  // Never overwrites, and refuses before calling the API.
  const before = requests.length;
  const again = await cli(["contracts", "init", "--network", "base", "--address", VAULT, "--out", out]);
  assert.equal(again.code, 64);
  assert.match(again.stderr, /already exists/u);
  assert.equal(requests.length, before);
});

test("contracts init refuses denied targets and forbidden functions without leaving a file", async () => {
  const denied = join(DIR, "usdc.json");
  const token = await cli(["contracts", "init", "--network", "base", "--address", USDC, "--out", denied]);
  assert.equal(token.code, 1);
  assert.match(token.stderr, /cannot be registered: USDC is a registry token/u);
  await assert.rejects(stat(denied));

  const forbidden = join(DIR, "approve.json");
  const approve = await cli(["contracts", "init", "--network", "base", "--address", VAULT, "--out", forbidden, "--function", "approve"]);
  assert.equal(approve.code, 64);
  assert.match(approve.stderr, /approve\(address,uint256\) cannot be registered/u);
  await assert.rejects(stat(forbidden));

  // Unverified source: the ABI comes from a file (a build artifact here).
  settings.abi = null;
  try {
    const unverified = join(DIR, "unverified.json");
    const refused = await cli(["contracts", "init", "--network", "base", "--address", VAULT, "--out", unverified]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /pass --abi <file>/u);
    await assert.rejects(stat(unverified));
    const artifact = await file("Vault.json", { abi: VAULT_ABI, bytecode: "0x" });
    const fromFile = await cli(["contracts", "init", "--network", "base", "--address", VAULT, "--out", unverified, "--abi", artifact, "--function", "deposit"]);
    assert.equal(fromFile.code, 0, fromFile.stderr);
    assert.equal(JSON.parse(await readFile(unverified, "utf8")).actions[0].function, "deposit(uint256,address)");
  } finally {
    settings.abi = VAULT_ABI;
  }
  assert.equal((await cli(["contracts", "init", "--network", "solana", "--address", VAULT, "--out", join(DIR, "sol.json")])).code, 64);
});

test("sessions create validates the template locally and prints the embed URL; sessions get is public", async () => {
  const template = {
    actions: [{ kind: "call", network: "base", contract: CT, entry: "deposit", amount: "100" }],
    amount: { action: 0, min: "10", max: "1000" },
    allowedOrigins: ["https://acme.example"],
    expiresInSeconds: 900,
  };
  const created = await cli(["sessions", "create", "--file", await file("session.json", template)]);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(last().path, "/v1/sessions");
  assert.deepEqual(last().body, template);
  assert.match(last().headers["idempotency-key"], UUID);
  assert.match(created.stdout, /embed: https:\/\/kletiaai\.xyz\/embed#session=cs_0123/u);
  assert.match(created.stdout, /visitor amount for action 1: 10-1000 USDC \(default 100\)/u);
  assert.match(created.stdout, /1\. call on base: Deposit into Acme USDC vault \(100\)/u);

  const before = requests.length;
  const invalid = await cli(["sessions", "create", "--file", await file("bad-session.json", { text: "deposit 100 USDC", actions: [], allowedOrigins: ["http://evil.example"] })]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /INVALID_REQUEST: The session template is invalid \(checked locally; nothing was sent\)/u);
  assert.match(invalid.stderr, /allowedOrigins\[0\]: Must be an origin/u);
  assert.equal(requests.length, before);

  const shown = await cli(["sessions", "get", CS], { env: {} });
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(last().headers.authorization, undefined);
  assert.match(shown.stdout, new RegExp(`^${CS}  active`, "u"));
  assert.equal((await cli(["sessions", "get", "cs_short"], { env: {} })).code, 64);
});

test("help lists the contract and session commands", async () => {
  const help = await cli(["help"]);
  for (const name of ["contracts register", "contracts test", "contracts inspect", "contracts init", "sessions create"]) {
    assert.match(help.stdout, new RegExp(`\\n  ${name} `, "u"), name);
  }
  const group = await cli(["contracts"]);
  assert.equal(group.code, 64);
  assert.match(group.stderr, /kletia contracts register --file <definition\.json>/u);
});
