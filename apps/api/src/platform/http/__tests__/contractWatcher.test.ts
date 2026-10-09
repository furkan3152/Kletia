/**
 * Background contract watcher: activation of due revisions, pin re-checks
 * (EVM code / proxy implementation, Solana program deployments) that suspend
 * changed registrations, RPC failures that suspend nothing, and the daily
 * domain re-check. Engine reads and providers are stubbed; the clock is fake.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/contractWatcher.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { EvmContractPins, SolanaProgramPin } from "@kletia/core";
import { useTestEnvironment } from "./support.js";

useTestEnvironment();
delete process.env.KLETIA_CONTRACTS_ENABLED;

const contracts = await import("../contracts.js");
const { configureContractEngine } = await import("../contractChecks.js");
const { runContractWatch, DOMAIN_RECHECK_MS } = await import("../contractWatcher.js");

const START = Date.parse("2026-10-09T12:00:00.000Z");
let now = START;
const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"bb".repeat(32)}`;
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const codeHashes = new Map<string, string>();
const deploySlots = new Map<string, string>();
const failing = new Set<string>();
const domains = new Set<string>();
const events: { type: string; contractId: string; reason?: string }[] = [];

function address(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

function pins(target: string): EvmContractPins {
  return {
    codeHash: codeHashes.get(target) ?? HASH_A,
    codeSize: 1_024,
    proxy: null,
    addresses: [],
    blockNumber: "1",
    checkedAt: new Date(now).toISOString(),
  };
}

function programPin(program: string): SolanaProgramPin {
  return {
    program,
    loader: "BPFLoaderUpgradeab1e11111111111111111111111",
    programData: "4Ec7ZxZS3VWfP5Z7AqZq8F7mUvC7zZpY6uZz6Ckq3pQT",
    lastDeploySlot: deploySlots.get(program) ?? "100",
    upgradeAuthority: "CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ",
  };
}

const ABI = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [] },
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
];

function evm(network: "base" | "arbitrum-sepolia", target: string, integrator = { name: "Acme Yield", website: "https://acme.example" }): Record<string, unknown> {
  return {
    vm: "evm",
    network,
    address: target,
    integrator,
    abi: ABI,
    actions: [
      {
        id: "deposit",
        label: "Deposit",
        function: "deposit(uint256,address)",
        args: ["$amount", "$account"],
        input: { token: "USDC", approval: { spender: "$self" } },
        output: { token: "$self" },
        events: [{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$amount" }, output: "shares" }],
        limits: { maxAmount: "1000" },
      },
    ],
  };
}

const auth = (keyId: string) => ({ tier: "developer" as const, keyId, projectId: keyId });

before(() => {
  contracts.configureContractClock(() => now);
  contracts.subscribeContractEvents((event) => events.push({ type: event.type, contractId: event.data.contractId, ...(event.data.reason ? { reason: event.data.reason } : {}) }));
  configureContractEngine({
    engine: {
      inspectEvmContract: async (_network, target) => {
        if (failing.has(target.toLowerCase())) throw new Error("RPC unavailable");
        return { codeSize: 1_024, eip7702: false, pins: pins(target.toLowerCase()), proxyHints: [] };
      },
      readSolanaProgramPins: async (_network, ids) => ids.map(programPin),
      fetchSolanaActionMetadata: async (_transport, href) => ({ url: href, title: "Swap", label: "Swap", disabled: false, fetchedAt: new Date(now).toISOString() }),
    },
    checks: {
      sourcify: async () => ({ verification: { status: "exact_match", provider: "sourcify", checkedAt: new Date(now).toISOString() }, proxy: null, abi: null }),
      ottersec: async (program) => ({ program, verified: null, provider: "ottersec", checkedAt: new Date(now).toISOString() }),
      domain: async (_website, id) => domains.has(id),
      risk: async () => null,
      actionOrigin: async () => undefined,
    },
  });
});

after(() => {
  contracts.configureContractClock(null);
  configureContractEngine({ engine: null, checks: null });
});

beforeEach(() => {
  events.length = 0;
});

describe("contract watcher", () => {
  it("activates due revisions and suspends registrations whose code changed", async () => {
    const owner = `key_${randomBytes(12).toString("hex")}`;
    const stable = address();
    const upgraded = address();
    const mainnet = address();
    const a = await contracts.registerContract(auth(owner), evm("arbitrum-sepolia", stable));
    const b = await contracts.registerContract(auth(owner), evm("arbitrum-sepolia", upgraded));
    const c = await contracts.registerContract(auth(owner), evm("base", mainnet));
    assert.equal(c.status, "pending");
    events.length = 0;

    codeHashes.set(upgraded, HASH_B);
    now = START + 900_000;
    const report = await runContractWatch();
    assert.equal(report.activated, 1);
    assert.equal(report.suspended, 1);
    assert.equal(report.errors, 0);
    assert.ok(report.checked >= 3);
    assert.deepEqual(
      events.filter((event) => [a.id, b.id, c.id].includes(event.contractId)).map((event) => [event.contractId, event.type, event.reason ?? null]),
      [
        [c.id, "contract.activated", null],
        [b.id, "contract.suspended", "pins_changed"],
      ],
    );
    const directory = contracts.createContractDirectory();
    assert.equal((await directory.current(a.id))?.status, "active");
    assert.equal((await directory.current(b.id))?.status, "suspended");
    assert.equal((await directory.current(c.id))?.status, "active");
    now = START;
  });

  it("suspends a Solana Actions registration when an allowlisted program is redeployed, and never on RPC failures", async () => {
    const owner = `key_${randomBytes(12).toString("hex")}`;
    const solana = await contracts.registerContract(auth(owner), {
      vm: "svm",
      network: "solana-devnet",
      integrator: { name: "Blink Swap", website: "https://blinks.example" },
      origin: "https://blinks.example",
      programs: [JUPITER],
      actions: [{ id: "swap", label: "Swap", href: "https://blinks.example/api/swap/{amount}", primaryProgram: JUPITER, input: { token: "native" }, limits: { maxAmount: "1" } }],
    });
    const flaky = address();
    const evmView = await contracts.registerContract(auth(owner), evm("arbitrum-sepolia", flaky));
    failing.add(flaky);
    deploySlots.set(JUPITER, "200");
    const report = await runContractWatch();
    assert.ok(report.errors >= 1);
    const directory = contracts.createContractDirectory();
    assert.equal((await directory.current(solana.id))?.status, "suspended");
    assert.equal((await directory.current(evmView.id))?.status, "active", "an RPC failure suspends nothing");
    assert.ok(events.some((event) => event.contractId === solana.id && event.type === "contract.suspended" && event.reason === "program_changed"));
    failing.delete(flaky);
    deploySlots.delete(JUPITER);
  });

  it("re-checks domains daily and suspends a reserved brand that loses its domain", async () => {
    const owner = `key_${randomBytes(12).toString("hex")}`;
    const brand = await contracts.registerContract(auth(owner), evm("arbitrum-sepolia", address(), { name: "Kletia Labs", website: "https://kletiaai.xyz" }));
    const plain = await contracts.registerContract(auth(owner), evm("arbitrum-sepolia", address()));
    assert.equal(brand.status, "pending");
    domains.add(brand.id);
    domains.add(plain.id);
    await runContractWatch();
    const directory = contracts.createContractDirectory();
    assert.equal((await directory.current(brand.id))?.status, "active", "the verified domain lets the reserved brand activate");
    assert.equal((await directory.current(plain.id))?.verification.domain.verified, true);

    domains.delete(brand.id);
    events.length = 0;
    await runContractWatch();
    assert.equal((await directory.current(brand.id))?.status, "active", "domains are re-checked at most daily");
    now = START + DOMAIN_RECHECK_MS;
    await runContractWatch();
    const lost = await directory.current(brand.id);
    assert.equal(lost?.status, "suspended");
    assert.equal(lost?.verification.domain.verified, false);
    assert.ok(events.some((event) => event.contractId === brand.id && event.reason === "domain_unverified"));
    now = START;
  });
});
