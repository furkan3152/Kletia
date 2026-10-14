/**
 * Contract registrations over HTTP (bring your own contract): CRUD and
 * scoping, the registration pipeline's refusals, revisions and activation
 * (fake clock), reverify and suspensions, the operator route, the kill
 * switch, test / inspect, contract webhook events, the engine directory
 * (scoping, aliases, spend caps, anomalies), the SSRF-guarded action
 * transport and, with KLETIA_TEST_DATABASE_URL, the Postgres store.
 *
 * The engine's chain reads (pins, Solana program pins, action metadata,
 * tests) and the off-chain providers (Sourcify, OtterSec, domain file, risk)
 * are stubbed through `configureContractEngine`; nothing touches a network.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/contracts.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type {
  ContractTestRequest,
  ContractTestResult,
  ContractView,
  EvmContractPins,
  NetworkKey,
  SolanaProgramPin,
} from "@kletia/core";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import type { RegisteredContract } from "../../index.js";
import { assertError, call, OPERATOR_KEY, serve, useTestEnvironment, waitFor, type TestServer } from "./support.js";

useTestEnvironment();
delete process.env.KLETIA_CONTRACTS_ENABLED;
delete process.env.KLETIA_CONTRACT_DENYLIST;
delete process.env.KLETIA_CONTRACT_KEY_DAILY_MAX_USD;
delete process.env.KLETIA_CONTRACT_ACTIVATION_DELAY_SECONDS;

const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const contracts = await import("../contracts.js");
const { configureContractEngine } = await import("../contractChecks.js");
const { contractTestLimiter, contractWriteLimiter } = await import("../limits.js");
const transportModule = await import("../actionTransport.js");
const { createGuardedLookup } = await import("../netguard.js");
const { apiKeyStore, issueAgentKey, issueDeveloperKey } = await import("../auth.js");
const { contractDirectory, createIntentDetailed, prepareStep } = await import("../../index.js");
const harnessModule = await import("../../engine/__tests__/contractHarness.js");
const { KLETIA_TOOLS, runTool } = await import("../mcp/tools.js");
const sessionsModule = await import("../sessions.js");

/* ------------------------------------------------------------ fixtures */

const START = Date.parse("2026-10-09T12:00:00.000Z");
let now = START;
const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const NOOP = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

function randomAddress(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

interface CodeState {
  codeSize: number;
  eip7702?: boolean;
  codeHash: string;
  hints?: string[];
  proxy?: EvmContractPins["proxy"];
}

const code = new Map<string, CodeState>();
const programs = new Map<string, SolanaProgramPin>();
let sourcifyProxy: { isProxy: boolean; proxyType: string | null; implementations: string[] } | null = null;
let riskScore: number | null = null;
const verifiedDomains = new Set<string>();
const tested: { contract: RegisteredContract; request: ContractTestRequest }[] = [];

function stateOf(address: string): CodeState {
  return code.get(address.toLowerCase()) ?? { codeSize: 2_048, codeHash: HASH_A };
}

function pinsOf(address: string, extra: readonly (string | { label: string; address: string })[] = []): EvmContractPins {
  const main = stateOf(address);
  return {
    codeHash: main.codeHash,
    codeSize: main.codeSize,
    proxy: main.proxy ?? null,
    addresses: extra.map((entry, index) => {
      const item = typeof entry === "string" ? { label: `address-${index + 1}`, address: entry } : entry;
      const state = stateOf(item.address);
      return { label: item.label, address: item.address, codeHash: state.codeHash, codeSize: state.codeSize, proxy: state.proxy ?? null };
    }),
    blockNumber: "1000",
    checkedAt: new Date(now).toISOString(),
  };
}

function programPin(program: string): SolanaProgramPin {
  return programs.get(program) ?? {
    program,
    loader: "BPFLoaderUpgradeab1e11111111111111111111111",
    programData: "4Ec7ZxZS3VWfP5Z7AqZq8F7mUvC7zZpY6uZz6Ckq3pQT",
    lastDeploySlot: "454465850",
    upgradeAuthority: "CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ",
  };
}

function testResult(contract: RegisteredContract, request: ContractTestRequest): ContractTestResult {
  return {
    contract: contract.id,
    revision: contract.activeRevision ?? 1,
    entry: request.entry,
    network: contract.definition.network,
    account: request.account,
    transactions: [{ description: "Deposit", to: contract.definition.vm === "evm" ? contract.definition.address : JUPITER, selector: "0x6e553f65" }],
    review: {
      kind: contract.definition.vm === "evm" ? "evm-call" : "solana-action",
      integrator: { name: contract.definition.integrator.name, domainVerified: false },
      notices: ["Not audited by Kletia."],
      approvals: [],
      simulation: { status: "ok", at: new Date(now).toISOString(), assetChanges: [], warnings: [] },
    },
    warnings: [],
  };
}

function installStubs(): void {
  configureContractEngine({
    engine: {
      inspectEvmContract: async (_network, address, extra) => {
        const state = stateOf(address);
        const hints = [...(state.hints ?? [])];
        if (state.eip7702) hints.push("eip7702-delegation");
        for (const [index, entry] of (extra ?? []).entries()) {
          const item = typeof entry === "string" ? { label: `address-${index + 1}`, address: entry } : entry;
          const other = stateOf(item.address);
          if (other.codeSize === 0) hints.push(`${item.label}:not-deployed`);
          if (other.eip7702) hints.push(`${item.label}:eip7702-delegation`);
        }
        return { codeSize: state.codeSize, eip7702: state.eip7702 === true, pins: pinsOf(address, extra ?? []), proxyHints: hints };
      },
      readSolanaProgramPins: async (_network, ids) => ids.map(programPin),
      fetchSolanaActionMetadata: async (_transport, href) => ({ url: href, title: "Swap SOL to USDC", label: "Swap", disabled: false, fetchedAt: new Date(now).toISOString() }),
      testContractAction: async (contract, request) => {
        tested.push({ contract, request });
        return testResult(contract, request);
      },
      simulationCapability: async () => ({ base: "ok" }),
    },
    checks: {
      sourcify: async (_network, address) => ({
        verification: { status: "exact_match", provider: "sourcify", checkedAt: new Date(now).toISOString(), url: `https://sourcify.dev/server/v2/contract/8453/${address}` },
        proxy: sourcifyProxy,
        abi: null,
      }),
      ottersec: async (program) => ({ program, verified: program === JUPITER ? false : null, provider: "ottersec", checkedAt: new Date(now).toISOString() }),
      domain: async (_website, id) => verifiedDomains.has(id),
      risk: async () => (riskScore === null ? null : { provider: "webacy", score: riskScore, checkedAt: new Date(now).toISOString() }),
      actionOrigin: async () => undefined,
    },
  });
}

const ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "event",
    name: "Deposit",
    anonymous: false,
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
];

function depositAction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "deposit",
    label: "Deposit into Acme USDC vault",
    function: "deposit(uint256,address)",
    args: ["$amount", "$account"],
    input: { token: "USDC", approval: { spender: "$self" } },
    output: { token: "$self", toleranceBps: 10 },
    events: [{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$amount" }, output: "shares" }],
    limits: { maxAmount: "25000" },
    ...overrides,
  };
}

const PHRASES = { verbs: ["deposit", "supply"], aliases: ["acme vault"] };

function evmDefinition(options: { network?: NetworkKey; address?: string; action?: Record<string, unknown>; extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    vm: "evm",
    network: options.network ?? "base",
    address: options.address ?? randomAddress(),
    integrator: { name: "Acme Yield", website: "https://acme.example" },
    abi: ABI,
    actions: [options.action ?? depositAction()],
    ...(options.extra ?? {}),
  };
}

function solanaDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vm: "svm",
    network: "solana",
    integrator: { name: "Blink Swap", website: "https://jupiter.dial.to" },
    origin: "https://jupiter.dial.to",
    programs: [JUPITER, NOOP],
    actions: [
      {
        id: "swap",
        label: "Swap SOL to USDC",
        href: "https://jupiter.dial.to/api/v0/swap/SOL-USDC/{amount}",
        primaryProgram: JUPITER,
        input: { token: "native" },
        output: { mint: USDC_SOLANA },
        phrases: { verbs: ["swap"], aliases: ["blink swap"] },
        limits: { maxAmount: "1" },
      },
    ],
    ...overrides,
  };
}

type ContractReply = { contract: ContractView & { revisions?: { revision: number }[] } };

let server: TestServer;
const events: { type: string; data: { contractId: string; ownerKeyId: string; revision: number; reason?: string } }[] = [];
let unsubscribe: () => void = () => undefined;

/** A developer key (a new project, or a sibling in `sibling`'s project); issued directly to avoid the per-IP issuance limit. */
async function issueKey(name: string, sibling?: { id: string }): Promise<{ id: string; key: string }> {
  const issued = await issueDeveloperKey(name, sibling ? { id: sibling.id, maxActive: 5 } : undefined);
  return { id: issued.id, key: issued.key };
}

async function register(key: string, body: Record<string, unknown>): Promise<ContractView> {
  const reply = await call<ContractReply>(server, "POST", "/contracts", { key, body });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.contract;
}

function resetLimiters(): void {
  contractWriteLimiter.reset();
  contractTestLimiter.reset();
}

before(async () => {
  resetEngine();
  installStubs();
  contracts.configureContractClock(() => now);
  unsubscribe = contracts.subscribeContractEvents((event) => events.push(event as (typeof events)[number]));
  server = await serve((app) => {
    app.use("/v1", createPlatformRouter(), platformErrorHandler);
  });
});

after(async () => {
  unsubscribe();
  configureContractEngine({ engine: null, checks: null });
  contracts.configureContractClock(null);
  await server.close();
});

beforeEach(() => {
  now = START;
  resetLimiters();
  sourcifyProxy = null;
  riskScore = null;
  events.length = 0;
});

/* ------------------------------------------------------------ registration */

describe("POST /v1/contracts", () => {
  it("registers a mainnet contract as pending, announces it, and activates it after the delay", async () => {
    const owner = await issueKey("acme");
    const address = randomAddress();
    const created = await call<ContractReply>(server, "POST", "/contracts", { key: owner.key, body: evmDefinition({ address }), headers: { "idempotency-key": "reg-1" } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const view = created.body.contract;
    assert.match(view.id, /^ct_[0-9a-f]{24}$/u);
    assert.equal(view.status, "pending");
    assert.equal(view.revision, 1);
    assert.equal(view.activeRevision, null);
    assert.equal(view.pendingRevision, 1);
    assert.equal(view.activatesAt, new Date(START + 900_000).toISOString());
    assert.equal(view.address?.toLowerCase(), address);
    assert.match(view.definitionHash, /^[0-9a-f]{64}$/u);
    assert.equal(view.actions[0] && "selector" in view.actions[0] ? view.actions[0].selector : null, "0x6e553f65");
    assert.ok(view.abi, "the owner sees the ABI");
    assert.equal(view.integrator.domainVerified, false);
    assert.equal(view.verification.source?.status, "exact_match");
    assert.deepEqual(events.map((event) => event.type), ["contract.registered"]);
    assert.equal(events[0]?.data.ownerKeyId, owner.id);

    // Idempotency-Key replays the stored response.
    const replay = await call<ContractReply>(server, "POST", "/contracts", { key: owner.key, body: evmDefinition({ address }), headers: { "idempotency-key": "reg-1" } });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.equal(replay.body.contract.id, view.id);

    // Still pending one second before the delay, active at activatesAt.
    now = START + 899_000;
    assert.equal((await call<ContractReply>(server, "GET", `/contracts/${view.id}`, { key: owner.key })).body.contract.status, "pending");
    now = START + 900_000;
    const active = await call<ContractReply>(server, "GET", `/contracts/${view.id}`, { key: owner.key });
    assert.equal(active.body.contract.status, "active");
    assert.equal(active.body.contract.activeRevision, 1);
    assert.equal(active.body.contract.pendingRevision, null);
    assert.deepEqual(active.body.contract.revisions?.map((entry) => entry.revision), [1]);
    assert.deepEqual(events.map((event) => event.type), ["contract.registered", "contract.activated"]);
    now = START;
  });

  it("activates testnet registrations at once", async () => {
    const owner = await issueKey("testnet");
    const view = await register(owner.key, evmDefinition({ network: "arbitrum-sepolia" }));
    assert.equal(view.status, "active");
    assert.equal(view.activeRevision, 1);
    assert.equal(view.activatesAt, null);
    assert.deepEqual(events.map((event) => event.type), ["contract.registered", "contract.activated"]);
  });

  it("refuses definitions with the core validator's codes and statuses", async () => {
    const owner = await issueKey("invalid");
    const approve = evmDefinition({
      action: depositAction({ function: "approve(address,uint256)", args: ["$self", "$amount"] }),
      extra: {
        abi: [...ABI, { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }],
      },
    });
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: approve }), 422, "CONTRACT_FUNCTION_FORBIDDEN");
    const literalReceiver = evmDefinition({ action: depositAction({ args: ["$amount", { literal: randomAddress() }] }) });
    const binding = assertError(await call(server, "POST", "/contracts", { key: owner.key, body: literalReceiver }), 422, "CONTRACT_BINDING_INVALID");
    assert.ok(binding.error.issues?.some((issue) => issue.path.startsWith("actions[0].args[1]")), JSON.stringify(binding.error.issues));
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition({ address: PERMIT2 }) }), 422, "CONTRACT_DENIED");
    const bytesAbi = [
      { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }, { name: "data", type: "bytes" }], outputs: [] },
      ABI[1],
    ];
    const bytes = evmDefinition({
      action: depositAction({ function: "deposit(uint256,address,bytes)", args: ["$amount", "$account", { literal: "0x1234" }] }),
      extra: { abi: bytesAbi },
    });
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: bytes }), 422, "CONTRACT_ARGUMENT_FORBIDDEN");
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: { ...evmDefinition(), extra: true } }), 400, "CONTRACT_DEFINITION_INVALID");
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: [] }), 400, "CONTRACT_DEFINITION_INVALID");
    assert.equal(events.length, 0, "nothing was registered");
  });

  it("refuses targets that cannot be pinned: not deployed, EIP-7702, unsupported proxies, Sourcify disagreement, risk", async () => {
    const owner = await issueKey("pins");
    const empty = randomAddress();
    code.set(empty, { codeSize: 0, codeHash: HASH_A });
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition({ address: empty }) }), 422, "CONTRACT_NOT_DEPLOYED");
    const delegated = randomAddress();
    code.set(delegated, { codeSize: 23, codeHash: HASH_A, eip7702: true });
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition({ address: delegated }) }), 422, "CONTRACT_DELEGATED_EOA");
    const diamond = randomAddress();
    code.set(diamond, { codeSize: 4_000, codeHash: HASH_A, hints: ["eip2535-diamond"] });
    const refused = assertError(await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition({ address: diamond }) }), 422, "CONTRACT_PROXY_UNSUPPORTED");
    assert.match(refused.error.message, /diamond/u);
    // Informational hints (the detected proxy kind) are not refusals.
    const proxied = randomAddress();
    const implementation = randomAddress();
    code.set(proxied, {
      codeSize: 300,
      codeHash: HASH_A,
      hints: ["zeppelinos"],
      proxy: { kind: "zeppelinos", implementation, implementationCodeHash: HASH_B, admin: null, beacon: null, beaconCodeHash: null },
    });
    sourcifyProxy = { isProxy: true, proxyType: "ZeppelinOSProxy", implementations: [randomAddress()] };
    const mismatch = assertError(await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition({ address: proxied }) }), 422, "CONTRACT_PROXY_UNSUPPORTED");
    assert.match(mismatch.error.message, /disagrees/u);
    sourcifyProxy = { isProxy: true, proxyType: "ZeppelinOSProxy", implementations: [implementation] };
    const pinned = await register(owner.key, evmDefinition({ address: proxied }));
    assert.equal((pinned.pins as EvmContractPins).proxy?.implementation, implementation);
    // Sourcify sees a proxy the on-chain reader could not pin.
    sourcifyProxy = { isProxy: true, proxyType: "EIP1967Proxy", implementations: [] };
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition() }), 422, "CONTRACT_PROXY_UNSUPPORTED");
    sourcifyProxy = null;
    // An extra pinned address without code.
    const helper = randomAddress();
    code.set(helper, { codeSize: 0, codeHash: HASH_A });
    const extra = evmDefinition({ extra: { addresses: [{ label: "router", address: helper }] }, action: depositAction({ input: { token: "USDC", approval: { spender: "router" } } }) });
    const missing = assertError(await call(server, "POST", "/contracts", { key: owner.key, body: extra }), 422, "CONTRACT_NOT_DEPLOYED");
    assert.equal(missing.error.issues?.[0]?.path, "addresses[0].address");
    riskScore = 91;
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition() }), 422, "CONTRACT_DENIED");
  });

  it("refuses duplicates, the per-key cap, overlapping phrases and too many writes", async () => {
    const owner = await issueKey("caps");
    const address = randomAddress();
    const phrased = depositAction({ phrases: PHRASES });
    await register(owner.key, evmDefinition({ address, network: "arbitrum-sepolia", action: phrased }));
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition({ address, network: "arbitrum-sepolia" }) }), 409, "CONTRACT_EXISTS");
    // The same alias + verb on the same network is ambiguous; on another network it is not.
    const overlap = assertError(
      await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition({ network: "arbitrum-sepolia", action: phrased }) }),
      400,
      "CONTRACT_DEFINITION_INVALID",
    );
    assert.equal(overlap.error.issues?.[0]?.path, "actions[0].phrases.aliases[0]");
    await register(owner.key, evmDefinition({ network: "arc", action: phrased }));
    // Every write counts (4 so far): 16 more fill the 20 per hour ...
    const quiet = depositAction();
    for (let index = 0; index < 16; index += 1) await register(owner.key, evmDefinition({ network: "arbitrum-sepolia", action: quiet }));
    const limited = assertError(await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition({ network: "arbitrum-sepolia", action: quiet }) }), 429, "RATE_LIMITED");
    assert.match(limited.error.message, /per API key/u);
    // ... then the 25 registrations cap (18 registered so far).
    resetLimiters();
    for (let index = 0; index < 7; index += 1) await register(owner.key, evmDefinition({ network: "arbitrum-sepolia", action: quiet }));
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition({ network: "arbitrum-sepolia", action: quiet }) }), 409, "CONTRACT_LIMIT_REACHED");
  });

  it("needs a key and the key's current secret", async () => {
    assertError(await call(server, "POST", "/contracts", { body: evmDefinition() }), 401, "API_KEY_REQUIRED");
    const owner = await issueKey("rotating");
    const rotated = await call<{ key: { key: string } }>(server, "POST", `/keys/${owner.id}/rotate`, { key: owner.key, body: { graceSeconds: 600 } });
    assert.equal(rotated.status, 200);
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition() }), 403, "KEY_SECRET_ROTATED");
    await register(rotated.body.key.key, evmDefinition({ network: "arbitrum-sepolia" }));
  });

  it("registers a Solana Action origin with program pins, OtterSec status and action metadata", async () => {
    const owner = await issueKey("solana");
    const view = await register(owner.key, solanaDefinition());
    assert.equal(view.vm, "svm");
    assert.equal(view.origin, "https://jupiter.dial.to");
    assert.equal(view.status, "pending");
    const pins = view.pins as SolanaProgramPin[];
    assert.deepEqual(pins.map((pin) => pin.program), [JUPITER, NOOP]);
    assert.equal(view.verification.programs?.find((entry) => entry.program === JUPITER)?.verified, false);
    const action = view.actions[0] as { metadata?: { title: string } | null };
    assert.equal(action.metadata?.title, "Swap SOL to USDC");
    assert.deepEqual(view.programs, [JUPITER, NOOP]);
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: solanaDefinition({ programs: ["11111111111111111111111111111111"] }) }), 422, "PROGRAM_NOT_ALLOWED");
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: solanaDefinition({ origin: "http://jupiter.dial.to" }) }), 422, "ACTION_URL_FORBIDDEN");
  });
});

/* ------------------------------------------------------------ read, list, scope */

describe("reading and scoping registrations", () => {
  it("lists the key's own and the project's visible registrations; other projects get 404", async () => {
    const owner = await issueKey("scope-owner");
    const sibling = await issueKey("scope-sibling", owner);
    const stranger = await issueKey("scope-stranger");
    const privateOne = await register(owner.key, evmDefinition({ network: "arbitrum-sepolia" }));
    const shared = await register(owner.key, evmDefinition({ network: "base", extra: { visibility: "project" } }));
    const own = await call<{ contracts: ContractView[] }>(server, "GET", "/contracts", { key: owner.key });
    assert.deepEqual(own.body.contracts.map((entry) => entry.id), [privateOne.id, shared.id]);
    const filtered = await call<{ contracts: ContractView[] }>(server, "GET", "/contracts?network=arbitrum-sepolia&status=active", { key: owner.key });
    assert.deepEqual(filtered.body.contracts.map((entry) => entry.id), [privateOne.id]);
    assertError(await call(server, "GET", "/contracts?status=deleted", { key: owner.key }), 400, "INVALID_REQUEST");

    const seen = await call<{ contracts: ContractView[] }>(server, "GET", "/contracts", { key: sibling.key });
    assert.deepEqual(seen.body.contracts.map((entry) => entry.id), [shared.id], "a sibling sees only project-visible registrations");
    assert.equal(seen.body.contracts[0]?.abi, undefined, "only the owner sees the ABI");
    assert.equal((await call(server, "GET", `/contracts/${shared.id}`, { key: sibling.key })).status, 200);
    assertError(await call(server, "GET", `/contracts/${privateOne.id}`, { key: sibling.key }), 404, "CONTRACT_NOT_FOUND");
    // Foreign and unknown ids are indistinguishable.
    const foreign = assertError(await call(server, "GET", `/contracts/${shared.id}`, { key: stranger.key }), 404, "CONTRACT_NOT_FOUND");
    const unknown = assertError(await call(server, "GET", `/contracts/ct_${"0".repeat(24)}`, { key: stranger.key }), 404, "CONTRACT_NOT_FOUND");
    assert.equal(foreign.error.message, unknown.error.message);
    assertError(await call(server, "GET", "/contracts/ct_nothex", { key: owner.key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", "/contracts"), 401, "API_KEY_REQUIRED");
    // Only the owner changes or deletes; a sibling cannot.
    assertError(await call(server, "DELETE", `/contracts/${shared.id}`, { key: sibling.key }), 404, "CONTRACT_NOT_FOUND");
    assertError(await call(server, "PATCH", `/contracts/${shared.id}`, { key: sibling.key, body: { visibility: "private" } }), 404, "CONTRACT_NOT_FOUND");
  });

  it("routes /contracts/inspect before /contracts/{id} and classifies functions", async () => {
    const owner = await issueKey("inspect");
    const address = randomAddress();
    configureContractEngine({
      checks: {
        sourcify: async () => ({
          verification: { status: "exact_match", provider: "sourcify", checkedAt: new Date(now).toISOString() },
          proxy: null,
          abi: [
            ...ABI,
            { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
          ] as never,
        }),
      },
    });
    const reply = await call<{ inspection: { vm: string; deployed: boolean; denied: string | null; functions: { name: string; allowed: boolean; code: string | null }[] } }>(
      server,
      "GET",
      `/contracts/inspect?network=base&address=${address}`,
      { key: owner.key },
    );
    installStubs();
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.inspection.vm, "evm");
    assert.equal(reply.body.inspection.deployed, true);
    assert.equal(reply.body.inspection.denied, null);
    assert.deepEqual(
      reply.body.inspection.functions.map((entry) => [entry.name, entry.allowed, entry.code]),
      [["deposit", true, null], ["approve", false, "CONTRACT_FUNCTION_FORBIDDEN"]],
    );
    const denied = await call<{ inspection: { denied: string | null } }>(server, "GET", `/contracts/inspect?network=base&address=${PERMIT2}`, { key: owner.key });
    assert.match(denied.body.inspection.denied ?? "", /Permit2/iu);
    const solana = await call<{ inspection: { vm: string; programs: { program: string; denied: string | null; pin: unknown }[] } }>(
      server,
      "GET",
      `/contracts/inspect?network=solana&programs=${JUPITER},11111111111111111111111111111111`,
      { key: owner.key },
    );
    assert.equal(solana.body.inspection.vm, "svm");
    assert.equal(solana.body.inspection.programs[0]?.denied, null);
    assert.match(solana.body.inspection.programs[1]?.denied ?? "", /built-in/u);
    assertError(await call(server, "GET", "/contracts/inspect?network=base&address=nope", { key: owner.key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", "/contracts/inspect?address=0x", { key: owner.key }), 400, "INVALID_REQUEST");
  });
});

/* ------------------------------------------------------------ revisions */

describe("PATCH, DELETE, reverify and suspension", () => {
  it("edits labels in place and turns security changes into a pending revision", async () => {
    const owner = await issueKey("patch");
    now = START;
    const view = await register(owner.key, evmDefinition());
    now = START + 900_000;
    const active = (await call<ContractReply>(server, "GET", `/contracts/${view.id}`, { key: owner.key })).body.contract;
    assert.equal(active.status, "active");
    events.length = 0;

    const relabelled = await call<ContractReply>(server, "PATCH", `/contracts/${view.id}`, {
      key: owner.key,
      body: { actions: [depositAction({ label: "Deposit USDC", phrases: { verbs: ["deposit"], aliases: ["acme prime"] } })] },
    });
    assert.equal(relabelled.status, 200, JSON.stringify(relabelled.body));
    assert.equal(relabelled.body.contract.revision, 1, "labels and phrases change in place");
    assert.equal(relabelled.body.contract.definitionHash, view.definitionHash);
    assert.equal(relabelled.body.contract.actions[0]?.label, "Deposit USDC");
    assert.equal(events.length, 0);

    const raised = await call<ContractReply>(server, "PATCH", `/contracts/${view.id}`, {
      key: owner.key,
      body: { actions: [depositAction({ limits: { maxAmount: "50000" } })] },
    });
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    const pending = raised.body.contract;
    assert.equal(pending.revision, 2);
    assert.equal(pending.activeRevision, 1, "revision 1 keeps serving");
    assert.equal(pending.pendingRevision, 2);
    assert.equal(pending.status, "active");
    assert.notEqual(pending.definitionHash, view.definitionHash);
    assert.equal(pending.activatesAt, new Date(START + 1_800_000).toISOString());
    assert.deepEqual(events.map((event) => [event.type, event.data.revision]), [["contract.registered", 2]]);

    // The engine keeps using revision 1 until revision 2 activates.
    const directory = contractDirectory();
    assert.ok(directory, "the router installed the directory");
    assert.equal((await directory.current(view.id))?.activeRevision, 1);
    now = START + 1_800_000;
    const current = await directory.current(view.id);
    assert.equal(current?.activeRevision, 2);
    assert.equal(current?.definitionHash, pending.definitionHash);
    assert.deepEqual(events.map((event) => [event.type, event.data.revision]), [["contract.registered", 2], ["contract.activated", 2]]);
    const history = await call<ContractReply>(server, "GET", `/contracts/${view.id}`, { key: owner.key });
    assert.deepEqual(history.body.contract.revisions?.map((entry) => entry.revision), [2, 1]);

    assertError(await call(server, "PATCH", `/contracts/${view.id}`, { key: owner.key, body: { network: "arbitrum" } }), 400, "CONTRACT_DEFINITION_INVALID");
    assertError(await call(server, "PATCH", `/contracts/${view.id}`, { key: owner.key, body: {} }), 400, "INVALID_REQUEST");
    assertError(await call(server, "PATCH", `/contracts/${view.id}`, { key: owner.key, body: { actions: [depositAction({ args: ["$amount", "$self"] })] } }), 422, "CONTRACT_BINDING_INVALID");
    now = START;
  });

  it("soft-deletes idempotently and frees the target", async () => {
    const owner = await issueKey("delete");
    const address = randomAddress();
    const view = await register(owner.key, evmDefinition({ address, network: "arbitrum-sepolia" }));
    assert.equal((await call(server, "DELETE", `/contracts/${view.id}`, { key: owner.key })).status, 204);
    assert.equal((await call(server, "DELETE", `/contracts/${view.id}`, { key: owner.key })).status, 204);
    assertError(await call(server, "GET", `/contracts/${view.id}`, { key: owner.key }), 404, "CONTRACT_NOT_FOUND");
    assert.equal(await contractDirectory()?.current(view.id), null, "deleted registrations are gone for the engine");
    await register(owner.key, evmDefinition({ address, network: "arbitrum-sepolia" }));
  });

  it("suspends on anomalies once, and reverify lifts a pin suspension through a new revision", async () => {
    const owner = await issueKey("reverify");
    const address = randomAddress();
    code.set(address, { codeSize: 2_048, codeHash: HASH_A });
    const view = await register(owner.key, evmDefinition({ address, network: "arbitrum-sepolia" }));
    const directory = contractDirectory();
    assert.ok(directory);
    events.length = 0;
    await directory.reportAnomaly(view.id, "pins_changed", "implementation changed");
    await directory.reportAnomaly(view.id, "outcome_mismatch", "again");
    assert.deepEqual(events.map((event) => [event.type, event.data.reason]), [["contract.suspended", "pins_changed"]]);
    const suspended = (await call<ContractReply>(server, "GET", `/contracts/${view.id}`, { key: owner.key })).body.contract;
    assert.equal(suspended.status, "suspended");
    assert.equal(suspended.suspendedReason, "pins_changed");
    assert.equal((await directory.current(view.id))?.status, "suspended");

    // The intended upgrade: new code, reverify → revision 2, active again on a testnet.
    code.set(address, { codeSize: 2_048, codeHash: HASH_B });
    events.length = 0;
    const reverified = await call<ContractReply>(server, "POST", `/contracts/${view.id}/reverify`, { key: owner.key });
    assert.equal(reverified.status, 200, JSON.stringify(reverified.body));
    assert.equal(reverified.body.contract.status, "active");
    assert.equal(reverified.body.contract.revision, 2);
    assert.equal(reverified.body.contract.activeRevision, 2);
    assert.equal((reverified.body.contract.pins as EvmContractPins).codeHash, HASH_B);
    assert.deepEqual(events.map((event) => event.type), ["contract.registered", "contract.activated", "contract.reactivated"]);

    // Unchanged code: verification refresh only.
    const again = await call<ContractReply>(server, "POST", `/contracts/${view.id}/reverify`, { key: owner.key });
    assert.equal(again.body.contract.revision, 2);
  });

  it("lets only operators suspend, and the owner cannot lift an operator suspension", async () => {
    const owner = await issueKey("operator");
    const view = await register(owner.key, evmDefinition({ network: "arbitrum-sepolia" }));
    assertError(await call(server, "POST", `/contracts/${view.id}/suspend`, { key: owner.key, body: { reason: "abuse" } }), 401, "API_KEY_REQUIRED");
    assertError(await call(server, "POST", `/contracts/${view.id}/suspend`, { key: OPERATOR_KEY, body: {} }), 400, "INVALID_REQUEST");
    events.length = 0;
    const suspended = await call<ContractReply>(server, "POST", `/contracts/${view.id}/suspend`, { key: OPERATOR_KEY, body: { reason: "phishing report #12" } });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    assert.equal(suspended.body.contract.status, "suspended");
    assert.equal(suspended.body.contract.suspendedReason, "operator: phishing report #12");
    assert.equal(suspended.body.contract.abi, undefined);
    assert.deepEqual(events.map((event) => event.type), ["contract.suspended"]);
    assertError(await call(server, "POST", `/contracts/${view.id}/reverify`, { key: owner.key }), 409, "CONTRACT_SUSPENDED");
    assertError(await call(server, "POST", `/contracts/ct_${"0".repeat(24)}/suspend`, { key: OPERATOR_KEY, body: { reason: "x" } }), 404, "CONTRACT_NOT_FOUND");
  });

  it("keeps a reserved brand name pending until the domain verifies", async () => {
    const owner = await issueKey("brand");
    const definition = evmDefinition({ network: "arbitrum-sepolia", extra: { integrator: { name: "Kletia Labs", website: "https://kletiaai.xyz" } } });
    const view = await register(owner.key, definition);
    assert.equal(view.status, "pending", "no delay on a testnet, but the domain is not verified yet");
    assert.equal((await call<ContractReply>(server, "GET", `/contracts/${view.id}`, { key: owner.key })).body.contract.status, "pending");
    verifiedDomains.add(view.id);
    const verified = await call<ContractReply>(server, "POST", `/contracts/${view.id}/reverify`, { key: owner.key });
    assert.equal(verified.body.contract.integrator.domainVerified, true);
    assert.equal(verified.body.contract.status, "active");
    // Reserved brands still need the brand's own website (core validator).
    const impostor = evmDefinition({ network: "arbitrum-sepolia", extra: { integrator: { name: "Kletia Labs", website: "https://kletia-rewards.example" } } });
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: impostor }), 400, "CONTRACT_DEFINITION_INVALID");
  });
});

/* ------------------------------------------------------------ test endpoint, kill switch */

describe("POST /v1/contracts/{id}/test and the kill switch", () => {
  afterEach(() => {
    delete process.env.KLETIA_CONTRACTS_ENABLED;
  });

  it("dry-runs the latest revision for the owner and validates the request", async () => {
    const owner = await issueKey("tester");
    const view = await register(owner.key, evmDefinition());
    const account = `eip155:8453:${randomAddress()}`;
    tested.length = 0;
    const reply = await call<{ test: ContractTestResult }>(server, "POST", `/contracts/${view.id}/test`, { key: owner.key, body: { entry: "deposit", account, amount: "100" } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.test.contract, view.id);
    assert.equal(tested[0]?.contract.status, "pending", "tests work while pending");
    assert.equal(tested[0]?.contract.definitionHash, view.definitionHash);
    assert.equal(tested[0]?.request.amount, "100");
    assertError(await call(server, "POST", `/contracts/${view.id}/test`, { key: owner.key, body: { entry: "withdraw", account } }), 422, "CONTRACT_ACTION_UNKNOWN");
    assertError(await call(server, "POST", `/contracts/${view.id}/test`, { key: owner.key, body: { entry: "deposit", account: `eip155:42161:${randomAddress()}` } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/contracts/${view.id}/test`, { key: owner.key, body: { entry: "deposit" } }), 400, "INVALID_REQUEST");
    const stranger = await issueKey("tester-stranger");
    assertError(await call(server, "POST", `/contracts/${view.id}/test`, { key: stranger.key, body: { entry: "deposit", account } }), 404, "CONTRACT_NOT_FOUND");
    contractTestLimiter.reset();
    for (let index = 0; index < 20; index += 1) contractTestLimiter.take(owner.id);
    assertError(await call(server, "POST", `/contracts/${view.id}/test`, { key: owner.key, body: { entry: "deposit", account } }), 429, "RATE_LIMITED");
  });

  it("returns 503 CONTRACTS_DISABLED for registration, tests and inspection while reads continue", async () => {
    const owner = await issueKey("kill");
    const view = await register(owner.key, evmDefinition({ network: "arbitrum-sepolia" }));
    process.env.KLETIA_CONTRACTS_ENABLED = "false";
    assertError(await call(server, "POST", "/contracts", { key: owner.key, body: evmDefinition() }), 503, "CONTRACTS_DISABLED");
    assertError(await call(server, "POST", `/contracts/${view.id}/test`, { key: owner.key, body: { entry: "deposit", account: `eip155:421614:${randomAddress()}` } }), 503, "CONTRACTS_DISABLED");
    assertError(await call(server, "GET", `/contracts/inspect?network=base&address=${randomAddress()}`, { key: owner.key }), 503, "CONTRACTS_DISABLED");
    assertError(await call(server, "PATCH", `/contracts/${view.id}`, { key: owner.key, body: { visibility: "project" } }), 503, "CONTRACTS_DISABLED");
    assert.equal((await call(server, "GET", `/contracts/${view.id}`, { key: owner.key })).status, 200);
    const directory = contractDirectory();
    assert.ok(directory);
    await assert.rejects(directory.resolve(owner.id, view.id), (error: { code?: string }) => error.code === "CONTRACTS_DISABLED");
    assert.deepEqual(await directory.phrases(owner.id), []);
    assert.equal((await directory.current(view.id))?.id, view.id, "verification still reads registrations");
  });
});

/* ------------------------------------------------------------ directory */

describe("contract directory (engine hook)", () => {
  it("removes a revoked sibling's access without revoking the registration owner", async () => {
    const owner = await issueKey("live-owner");
    const sibling = await issueKey("revoked-sibling", owner);
    const view = await register(owner.key, evmDefinition({ network: "arc", action: depositAction({ phrases: PHRASES }), extra: { visibility: "project" } }));
    const directory = contractDirectory();
    assert.ok(directory);
    assert.equal((await directory.resolve(sibling.id, "acme vault", "arc"))?.id, view.id);
    assert.equal(await directory.usableBy(view.id, sibling.id), true);
    assert.equal((await directory.phrases(sibling.id)).length, 1);

    assert.equal((await call(server, "DELETE", `/keys/${sibling.id}`, { key: owner.key })).status, 204);
    assert.equal(await directory.resolve(sibling.id, view.id), null);
    assert.equal(await directory.resolve(sibling.id, "acme vault", "arc"), null);
    assert.equal(await directory.usableBy(view.id, sibling.id), false);
    assert.deepEqual(await directory.phrases(sibling.id), []);
    assert.equal(await directory.usableBy(view.id, owner.id), true, "the owner's integration stays available");
  });

  it("refuses expired agent keys and an expired ancestor even when their project still has a live registration", async () => {
    const owner = await issueKey("lineage-owner");
    const parent = await issueKey("lineage-parent", owner);
    const parentRecord = await apiKeyStore().findById(parent.id);
    assert.ok(parentRecord);
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    const agent = await issueAgentKey("lineage-agent", parentRecord, expires, 20);
    const view = await register(owner.key, evmDefinition({ network: "arc", action: depositAction({ phrases: PHRASES }), extra: { visibility: "project" } }));
    const directory = contractDirectory();
    assert.ok(directory);
    assert.equal(await directory.usableBy(view.id, agent.id), true);

    await apiKeyStore().setExpiry(agent.id, owner.id, new Date(Date.now() - 1_000).toISOString());
    assert.equal(await directory.usableBy(view.id, agent.id), false);
    assert.deepEqual(await directory.phrases(agent.id), []);
    await apiKeyStore().setExpiry(agent.id, owner.id, expires);
    assert.equal(await directory.usableBy(view.id, agent.id), true);

    await apiKeyStore().setExpiry(parent.id, owner.id, new Date(Date.now() - 1_000).toISOString());
    assert.equal(await directory.resolve(agent.id, view.id), null);
    assert.equal(await directory.usableBy(view.id, agent.id), false);
    assert.deepEqual(await directory.phrases(agent.id), []);
    assert.equal(await directory.usableBy(view.id, owner.id), true);
  });

  it("never resolves foreign ids, resolves aliases per network and lists phrases", async () => {
    const owner = await issueKey("dir-owner");
    const sibling = await issueKey("dir-sibling", owner);
    const stranger = await issueKey("dir-stranger");
    const phrased = depositAction({ phrases: PHRASES });
    const onBase = await register(owner.key, evmDefinition({ network: "arbitrum-sepolia", action: phrased }));
    const onArc = await register(owner.key, evmDefinition({ network: "arc", action: phrased, extra: { visibility: "project" } }));
    const directory = contractDirectory();
    assert.ok(directory);
    assert.equal((await directory.resolve(owner.id, onBase.id))?.id, onBase.id);
    assert.equal(await directory.resolve(stranger.id, onBase.id), null);
    assert.equal(await directory.resolve(sibling.id, onBase.id), null, "private registrations stay with their key");
    assert.equal((await directory.resolve(sibling.id, onArc.id))?.id, onArc.id, "project-visible registrations serve the project");
    assert.equal(await directory.resolve(owner.id, "acme vault"), null, "an alias on two networks is ambiguous without one");
    assert.equal((await directory.resolve(owner.id, "Acme  Vault", "arc"))?.id, onArc.id);
    assert.equal(await directory.resolve(stranger.id, "acme vault", "arc"), null);
    assert.equal(await directory.usableBy(onBase.id, owner.id), true);
    assert.equal(await directory.usableBy(onBase.id, stranger.id), false);
    assert.equal(await directory.usableBy(onArc.id, sibling.id), true);
    const phrases = await directory.phrases(owner.id);
    assert.deepEqual(phrases.map((phrase) => [phrase.contract, phrase.entry, phrase.network, phrase.spends]).sort(), [
      [onArc.id, "deposit", "arc", true],
      [onBase.id, "deposit", "arbitrum-sepolia", true],
    ].sort());
    assert.deepEqual(await directory.phrases(stranger.id), []);
    assert.match(directory.denied("base", PERMIT2) ?? "", /Permit2/iu);

    // Revoking the owner key takes its registrations with it, also for the project.
    assert.equal((await call(server, "DELETE", `/keys/${owner.id}`, { key: owner.key })).status, 204);
    assert.equal(await directory.resolve(sibling.id, onArc.id), null);
    assert.equal(await directory.usableBy(onArc.id, sibling.id), false);
  });

  it("caps priced notional per key and UTC day", async () => {
    process.env.KLETIA_CONTRACT_KEY_DAILY_MAX_USD = "1000";
    try {
      const directory = contractDirectory();
      assert.ok(directory);
      const owner = await issueKey("spend");
      await directory.recordSpend(owner.id, 600);
      await assert.rejects(directory.recordSpend(owner.id, 500), (error: { code?: string; status?: number }) => error.code === "CONTRACT_SPEND_LIMIT" && error.status === 422);
      await directory.recordSpend(owner.id, 400);
      const usage = await call<{ contracts: { preparedToday: number; notionalTodayUsd: number } }>(server, "GET", "/usage", { key: owner.key });
      assert.deepEqual(usage.body.contracts, { registered: 0, suspended: 0, preparedToday: 2, notionalTodayUsd: 1000 });
      now = START + 86_400_000;
      await directory.recordSpend(owner.id, 900);
    } finally {
      now = START;
      delete process.env.KLETIA_CONTRACT_KEY_DAILY_MAX_USD;
    }
  });
});

/* ------------------------------------------------------------ engine integration */

describe("engine integration (offline EVM world)", () => {
  let harness: import("../../engine/__tests__/contractHarness.js").EvmHarness;
  before(() => {
    harness = harnessModule.installEvmHarness();
    harnessModule.resetContractCaches();
    harnessModule.fund(harness.world, harnessModule.USDC_BASE, harnessModule.USER, 1_000_000_000n);
    // The real engine reads pins from the offline world; providers stay stubbed.
    configureContractEngine({ engine: null });
  });
  after(() => {
    harness.restore();
    installStubs();
  });

  it("refuses prepare on an already planned project contract after its caller key is revoked", async () => {
    const owner = await issueKey("prepare-owner");
    const sibling = await issueKey("prepare-sibling", owner);
    const auth = { tier: "developer" as const, keyId: owner.id, projectId: owner.id };
    const view = await contracts.registerContract(auth, { ...harnessModule.vaultDefinitionBody(), visibility: "project" });
    now = START + 900_000;
    const { intent } = await createIntentDetailed({
      accounts: [`eip155:8453:${harnessModule.USER}`],
      actions: [{ kind: "call", network: "base", contract: view.id, entry: "deposit", amount: "100" }],
    }, { ownerKeyId: sibling.id });
    const step = intent.steps[0];
    assert.ok(step);
    await apiKeyStore().revoke(sibling.id, owner.id, new Date().toISOString());
    const reads = harness.router.calls.length;
    await assert.rejects(prepareStep(intent.id, step.id), (error: { code?: string }) => error.code === "CONTRACT_NOT_USABLE");
    assert.equal(harness.router.calls.length, reads, "refusal precedes any prepare or simulation RPC");
  });

  it("registers with the engine's pins, plans aliases for the owning key only, and honours activation and the kill switch", async () => {
    const owner = await issueKey("engine-owner");
    const stranger = await issueKey("engine-stranger");
    const auth = { tier: "developer" as const, keyId: owner.id, projectId: owner.id };
    const view = await contracts.registerContract(auth, harnessModule.vaultDefinitionBody());
    assert.equal(view.status, "pending");
    assert.equal((view.pins as EvmContractPins).codeSize, 5, "pins come from the engine's reads");
    const account = `eip155:8453:${harnessModule.USER}`;
    const text = { text: "deposit 100 USDC into acme vault", accounts: [account] };
    await assert.rejects(createIntentDetailed(text, { ownerKeyId: owner.id, dryRun: true }), (error: { code?: string }) => error.code === "CONTRACT_PENDING");
    // Over HTTP the retryable 409 tells the client when to come back (design §4.3). node:http, because the
    // offline harness answers every fetch.
    const pendingReply = await new Promise<{ status: number; retryAfter: string | undefined; body: string }>((resolve, reject) => {
      const payload = JSON.stringify(text);
      const request = http.request(`${server.base}/intents?dryRun=true`, {
        method: "POST",
        headers: { authorization: `Bearer ${owner.key}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, retryAfter: response.headers["retry-after"], body }));
      });
      request.on("error", reject);
      request.end(payload);
    });
    assert.equal(pendingReply.status, 409, pendingReply.body);
    assert.equal((JSON.parse(pendingReply.body) as { error: { code: string } }).error.code, "CONTRACT_PENDING");
    assert.match(pendingReply.retryAfter ?? "", /^[1-9]\d*$/u, "CONTRACT_PENDING carries Retry-After");

    now = START + 900_000;
    const { intent } = await createIntentDetailed(text, { ownerKeyId: owner.id, dryRun: true });
    const step = intent.steps[0];
    assert.equal(step?.kind, "call");
    assert.equal(step?.protocol, "custom-call");
    assert.equal(step?.call?.contract, view.id);
    assert.equal(step?.call?.revision, 1);
    assert.equal(step?.call?.definitionHash, view.definitionHash);
    assert.equal(step?.call?.review.simulation.status, "ok");

    const structured = { actions: [{ kind: "call", network: "base", contract: view.id, entry: "deposit", amount: "100" }], accounts: [account] };
    await assert.rejects(createIntentDetailed(structured, { ownerKeyId: stranger.id, dryRun: true }), (error: { code?: string }) => error.code === "CONTRACT_UNKNOWN");
    await assert.rejects(createIntentDetailed(structured, { dryRun: true }), (error: { code?: string }) => error.code === "CONTRACT_UNKNOWN");

    // MCP plan_intent plans with the connecting key; output carries the review, never calldata.
    const tool = KLETIA_TOOLS.find((entry) => entry.name === "plan_intent");
    assert.ok(tool);
    const planned = await runTool(tool, text, { tier: "developer", keyId: owner.id });
    assert.equal(planned.isError, undefined, JSON.stringify(planned));
    const steps = planned.structuredContent.steps as { kind: string; contract?: string; review?: { notices: string[] } }[];
    assert.equal(steps[0]?.contract, view.id);
    assert.match(steps[0]?.review?.notices[0] ?? "", /Not audited by Kletia/u);
    for (const forbidden of ["\"data\"", "fragment", "bindings", "calldata"]) assert.ok(!JSON.stringify(planned).includes(forbidden), `no ${forbidden}`);
    const keyless = await runTool(tool, text, { tier: "public" });
    assert.equal(keyless.isError, true, "keyless agents cannot plan registered contracts");

    // A session pins the registration the alias resolved to, and plans for the visitor under the owner's key.
    const session = await sessionsModule.createSession(auth, {
      actions: [{ kind: "call", network: "base", contract: "acme vault", entry: "deposit", amount: "100" }],
      amount: { action: 0, min: "10", max: "500" },
      allowedOrigins: ["https://acme.example"],
    });
    assert.equal(session.actions[0]?.contract, view.id, "the alias is replaced by the registration id");
    assert.equal(session.actions[0]?.label, "Deposit into Acme USDC vault");
    assert.deepEqual(session.integrator, { name: "Acme Yield", website: "https://acme.example", domainVerified: false });
    assert.equal(session.amount?.symbol, "USDC");
    const created = await sessionsModule.createSessionIntent(session.id, { accounts: [account], amount: "50", hostOrigin: "https://acme.example" });
    assert.equal(created.intent.steps[0]?.kind, "call");
    assert.equal(created.intent.steps[0]?.input?.formatted, "50");
    assert.equal(created.intent.metadata?.sessionId, session.id);
    const listed = await createIntentDetailed({ actions: [{ kind: "call", network: "base", contract: view.id, entry: "deposit", amount: "1" }], accounts: [account] }, { ownerKeyId: owner.id, dryRun: true });
    assert.equal(listed.intent.steps[0]?.call?.contract, view.id);

    process.env.KLETIA_CONTRACTS_ENABLED = "false";
    try {
      await assert.rejects(createIntentDetailed(structured, { ownerKeyId: owner.id, dryRun: true }), (error: { code?: string }) => error.code === "CONTRACTS_DISABLED");
    } finally {
      delete process.env.KLETIA_CONTRACTS_ENABLED;
    }
  });
});

/* ------------------------------------------------------------ action transport */

describe("SSRF-guarded action transport", () => {
  let local: http.Server;
  let port = 0;
  before(async () => {
    local = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        res.end();
      } else if (req.url === "/large") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ padding: "x".repeat(70_000) }));
      } else if (req.url === "/slow") {
        setTimeout(() => res.end("{}"), 1_000);
      } else if (req.url === "/.well-known/kletia.json") {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "a=b" });
        res.end(JSON.stringify({ contracts: ["ct_aaaaaaaaaaaaaaaaaaaaaaaa"] }));
      } else {
        res.writeHead(200, { "content-type": "application/json", "x-action-version": "2.4" });
        res.end(JSON.stringify({ title: "ok", method: req.method }));
      }
    });
    local.listen(0, "127.0.0.1");
    await once(local, "listening");
    port = (local.address() as AddressInfo).port;
    // Test seam: requests to public names reach the local server (the static URL policy still applies).
    transportModule.configureActionConnector((url, options, onResponse) =>
      http.request({ host: "127.0.0.1", port, path: `${url.pathname}${url.search}`, method: options.method, headers: options.headers }, onResponse),
    );
  });
  after(async () => {
    transportModule.configureActionConnector(null);
    local.closeAllConnections();
    await new Promise<void>((resolve) => local.close(() => resolve()));
  });

  it("refuses non-HTTPS, credentialed, private and internal URLs before connecting", async () => {
    for (const url of [
      "http://actions.acme.example/a",
      "https://user:pw@actions.acme.example/a",
      "https://127.0.0.1/a",
      "https://10.0.0.8/a",
      "https://[::1]/a",
      "https://169.254.169.254/latest",
      "https://localhost/a",
      "https://metadata.google.internal/a",
      "https://actions.acme.example:22/a",
    ]) {
      await assert.rejects(transportModule.createActionTransport().get(url), (error: { code?: string }) => error.code === "ACTION_URL_FORBIDDEN", url);
    }
  });

  it("refuses hosts that resolve to private addresses at connect time (rebinding)", async () => {
    const lookup = createGuardedLookup((_host, callback) => callback(null, [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.1", family: 4 }]));
    const refused = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup("rebind.example", { all: false }, (error) => resolve(error)));
    assert.equal(refused?.code, "EWEBHOOKFORBIDDEN");
    const allowed = createGuardedLookup((_host, callback) => callback(null, [{ address: "93.184.215.14", family: 4 }]));
    const address = await new Promise<string>((resolve) => allowed("ok.example", { all: false }, (_error, value) => resolve(String(value))));
    assert.equal(address, "93.184.215.14");
  });

  it("returns JSON and headers, never follows redirects, caps bodies and times out", async () => {
    const transport = transportModule.createActionTransport();
    const ok = await transport.post("https://actions.acme.example/api", { account: "x" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { title: "ok", method: "POST" });
    assert.equal(ok.headers["x-action-version"], "2.4");
    const redirect = await transport.get("https://actions.acme.example/redirect");
    assert.equal(redirect.status, 302, "a redirect is returned as-is, never followed");
    await assert.rejects(transport.get("https://actions.acme.example/large"), (error: { code?: string }) => error.code === "ACTION_ENDPOINT_UNAVAILABLE");
    await assert.rejects(
      transportModule.guardedJsonRequest("https://actions.acme.example/slow", { method: "GET", maxBytes: 1_000, timeoutMs: 100 }),
      (error: { code?: string; message?: string }) => error.code === "ACTION_ENDPOINT_UNAVAILABLE" && /did not answer/u.test(error.message ?? ""),
    );
  });

  it("verifies domains from /.well-known/kletia.json only when the file lists the id", async () => {
    assert.equal(await transportModule.domainListsContract("https://acme.example", "ct_aaaaaaaaaaaaaaaaaaaaaaaa"), true);
    assert.equal(await transportModule.domainListsContract("https://acme.example", "ct_bbbbbbbbbbbbbbbbbbbbbbbb"), false);
    assert.equal(await transportModule.domainListsContract("http://acme.example", "ct_aaaaaaaaaaaaaaaaaaaaaaaa"), false);
    assert.equal(await transportModule.domainListsContract(undefined, "ct_aaaaaaaaaaaaaaaaaaaaaaaa"), false);
  });
});

/* ------------------------------------------------------------ postgres store */

const DATABASE_URL = process.env.KLETIA_TEST_DATABASE_URL?.trim();

describe("postgres contract store", () => {
  it("creates, caps, updates with optimistic concurrency and counts spend", { skip: DATABASE_URL ? false : "KLETIA_TEST_DATABASE_URL not set" }, async () => {
    process.env.KLETIA_DATABASE_URL = DATABASE_URL;
    const { closePlatformDatabase, dbQuery } = await import("../db.js");
    const owner = `key_${randomBytes(12).toString("hex")}`;
    const spender = `key_${randomBytes(12).toString("hex")}`;
    try {
      const store = new contracts.PostgresContractStore();
      const created = new Date(now).toISOString();
      const definition = evmDefinition({ network: "arbitrum-sepolia" }) as never;
      const record = (id: string, target: string): Parameters<typeof store.create>[0] => ({
        id,
        ownerKeyId: owner,
        projectId: owner,
        vm: "evm",
        network: "arbitrum-sepolia",
        target,
        status: "active",
        visibility: "private",
        revision: 1,
        activeRevision: 1,
        pendingRevision: null,
        activatesAt: null,
        suspendedReason: null,
        verification: { domain: { verified: false, checkedAt: null } },
        metadata: {},
        pinsCheckedAt: created,
        createdAt: created,
        updatedAt: created,
      });
      const revision = (id: string) => ({ contractId: id, revision: 1, definition, definitionHash: "a".repeat(64), pins: pinsOf(randomAddress()), createdAt: created });
      const first = `ct_${randomBytes(12).toString("hex")}`;
      const target = randomAddress();
      await store.create(record(first, target), revision(first), 2);
      const second = `ct_${randomBytes(12).toString("hex")}`;
      await assert.rejects(store.create(record(second, target), revision(second), 2), (error: { code?: string }) => error.code === "CONTRACT_EXISTS");
      await store.create(record(second, randomAddress()), revision(second), 2);
      const third = `ct_${randomBytes(12).toString("hex")}`;
      await assert.rejects(store.create(record(third, randomAddress()), revision(third), 2), (error: { code?: string }) => error.code === "CONTRACT_LIMIT_REACHED");

      const entry = await store.get(first);
      assert.equal(entry?.active?.definitionHash, "a".repeat(64));
      assert.equal(entry?.record.updatedAt, created);
      const updatedAt = new Date(now + 1).toISOString();
      // A run-unique activation time: the shared test database may hold due rows from other runs,
      // so ties at one fixed time would let `LIMIT 10` drop this run's row.
      const activatesAt = new Date(Date.UTC(2001, 0, 1) + Number.parseInt(randomBytes(4).toString("hex"), 16)).toISOString();
      const next = { ...record(first, target), revision: 2, pendingRevision: 2, activatesAt, updatedAt };
      const inserted = { ...revision(first), revision: 2, definitionHash: "b".repeat(64) };
      assert.equal(await store.update(next, created, { insert: inserted }), true);
      assert.equal(await store.update({ ...next, updatedAt: new Date(now + 2).toISOString() }, created), false, "a stale writer loses");
      const reread = await store.get(first);
      assert.equal(reread?.pending?.definitionHash, "b".repeat(64));
      assert.equal((await store.listDue(activatesAt, 10)).some((item) => item.record.id === first), true);
      assert.equal((await store.listDue(new Date(Date.parse(activatesAt) - 1).toISOString(), 10)).some((item) => item.record.id === first), false, "not due before its time");
      assert.deepEqual((await store.history(first, 5)).map((item) => item.revision), [2, 1]);
      assert.deepEqual(await store.counts(owner), { registered: 2, suspended: 0 });
      assert.equal((await store.listVisible(owner, null)).length, 2);
      assert.deepEqual(await store.listVisible(spender, owner), [], "private registrations are not shared with sibling keys");
      const siblingEntry = await store.get(second);
      assert.ok(siblingEntry);
      assert.equal(await store.update({ ...siblingEntry.record, visibility: "project", updatedAt }, created), true);
      assert.deepEqual((await store.listVisible(spender, owner)).map((item) => item.record.id), [second]);
      assert.deepEqual(await store.listVisible(spender, spender), [], "project-visible registrations never become a global catalog");
      assert.deepEqual(await store.listVisible(spender, null), [], "keyless project membership grants no access");

      const day = "2026-10-09";
      assert.equal(await store.addSpend(owner, day, 600, 1000), true);
      assert.equal(await store.addSpend(owner, day, 500, 1000), false);
      assert.equal(await store.addSpend(owner, day, 400, 1000), true);
      assert.deepEqual(await store.spend(owner, day), { usd: 1000, prepared: 2 });
      // Concurrent writers cannot exceed the cap together.
      const results = await Promise.all(Array.from({ length: 10 }, () => store.addSpend(spender, day, 300, 1000)));
      assert.equal(results.filter(Boolean).length, 3);
    } finally {
      // Leave the shared test database as found.
      const schema = { name: "kletia_contracts", ddl: "SELECT 1" };
      await dbQuery(schema, "DELETE FROM kletia_contract_revisions WHERE contract_id IN (SELECT id FROM kletia_contracts WHERE owner_key_id = $1)", [owner]).catch(() => undefined);
      await dbQuery(schema, "DELETE FROM kletia_contracts WHERE owner_key_id = $1", [owner]).catch(() => undefined);
      await dbQuery(schema, "DELETE FROM kletia_contract_spend WHERE owner_key_id = ANY($1)", [[owner, spender]]).catch(() => undefined);
      delete process.env.KLETIA_DATABASE_URL;
      await closePlatformDatabase();
    }
  });
});

/* ------------------------------------------------------------ webhooks */

describe("contract webhook events", () => {
  it("are delivered only to the owner key's webhooks", async () => {
    const { WebhookDispatcher } = await import("../dispatcher.js");
    const { createWebhook } = await import("../webhooks.js");
    const owner = await issueKey("hooks-owner");
    const other = await issueKey("hooks-other");
    await createWebhook(owner.id, { url: "https://93.184.215.14/owner", events: ["contract.registered", "contract.activated"] });
    await createWebhook(other.id, { url: "https://93.184.215.14/other" });
    const legacy = await createWebhook(owner.id, { url: "https://93.184.215.14/legacy", events: ["intent.created"] });
    const delivered: { url: string; type: string; body: { data: { contractId: string } } }[] = [];
    const dispatcher = new WebhookDispatcher(async (url, body, headers) => {
      delivered.push({ url: url.toString(), type: headers["kletia-event-type"] ?? "", body: JSON.parse(body) as { data: { contractId: string } } });
      return 204;
    }, () => undefined);
    dispatcher.start();
    try {
      const view = await register(owner.key, evmDefinition({ network: "arbitrum-sepolia" }));
      await waitFor(() => delivered.length >= 2, 2_000, "contract deliveries");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(delivered.map((entry) => [entry.url, entry.type]), [
        ["https://93.184.215.14/owner", "contract.registered"],
        ["https://93.184.215.14/owner", "contract.activated"],
      ]);
      assert.equal(delivered[0]?.body.data.contractId, view.id);
      assert.ok(!delivered.some((entry) => entry.url.endsWith("/legacy")), "older webhooks keep their event list");
      assert.match(legacy.id, /^wh_/u);
    } finally {
      dispatcher.stop();
    }
  });
});

describe("browser access to the contract routes", () => {
  it("the /v1 CORS policy allows every method the platform routes use (PATCH /v1/contracts/{id})", async () => {
    const { platformCorsOptions } = await import("../../../shared/http/cors.js");
    const { PLATFORM_ROUTES } = await import("../router.js");
    const allowed = new Set((platformCorsOptions.methods as readonly string[]).map((method) => method.toUpperCase()));
    const used = new Set(PLATFORM_ROUTES.map((route) => route.method.toUpperCase()));
    assert.ok(used.has("PATCH"), "the contract routes use PATCH");
    for (const method of used) assert.ok(allowed.has(method), `${method} is allowed by the /v1 CORS policy`);
  });
});
