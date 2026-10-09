/**
 * Live dry run of bring-your-own-contract (design §10) against mainnet RPCs,
 * Solana Action servers and the public bridge venues. Read-only: it plans,
 * simulates and prepares; it never signs or sends anything.
 *
 *   KLETIA_LIVE=1 node --import tsx --test src/platform/engine/__tests__/live/contractsLive.test.ts
 *
 * Skipped unless KLETIA_LIVE=1. Values that can legitimately move (a USDC
 * upgrade, share prices, a dead action server) are reported as diagnostics
 * rather than failures.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { contractDefinitionHash, validateContractDefinition, type ContractDefinition } from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { probeSolanaSimulation } from "../../chains/solana.js";
import { configureContractDirectory, type ActionTransport } from "../../contracts/directory.js";
import { inspectEvmContract } from "../../contracts/pins.js";
import { testContractAction } from "../../contracts/review.js";
import { resetSimulationEndpoints, simulationEndpoints } from "../../contracts/simulationRpc.js";
import { readSolanaProgramPins } from "../../contracts/solanaActions.js";
import { configurePlatform, createIntent, getIntentStore, prepareStep } from "../../service.js";
import { MemoryIntentStore } from "../../store.js";
import { MemoryDirectory, OWNER_KEY, STRANGER_KEY, vaultDefinitionBody, type Registration } from "../contractHarness.js";

const LIVE = process.env.KLETIA_LIVE === "1";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const HIGH_YIELD_ARBITRUM = "0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA";
const AAVE_POOL_BASE = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const SOL_HOLDER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const JUP6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const NOOP = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
const SYNTHETIC = "0x00000000000000000000000000000000c1e7a001";

const transport: ActionTransport = {
  async get(url) {
    const response = await fetch(url, { headers: { accept: "application/json", "x-accept-action-version": "2.4" }, redirect: "manual", signal: AbortSignal.timeout(8_000) });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), json };
  },
  async post(url, body) {
    const response = await fetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-accept-action-version": "2.4" }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(8_000) });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), json };
  },
};

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await response.json()) as { result: unknown }).result;
}

/** An EOA holding at least 200 USDC on Base, found from recent Transfer logs (read-only). */
async function fundedHolder(): Promise<string | null> {
  const url = "https://base-rpc.publicnode.com";
  const latest = BigInt(String(await rpc(url, "eth_blockNumber", [])));
  const logs = (await rpc(url, "eth_getLogs", [{ address: BASE_USDC, fromBlock: `0x${(latest - 5n).toString(16)}`, toBlock: `0x${latest.toString(16)}`, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"] }])) as { topics: string[] }[];
  for (const log of logs.slice(0, 150)) {
    const candidate = `0x${String(log.topics[2]).slice(26)}`;
    if ((await rpc(url, "eth_getCode", [candidate, "latest"])) !== "0x") continue;
    const balance = BigInt(String(await rpc(url, "eth_call", [{ to: BASE_USDC, data: `0x70a08231${candidate.slice(2).padStart(64, "0")}` }, "latest"])));
    if (balance >= 200_000_000n) return candidate;
  }
  return null;
}

async function evmRegistration(body: Record<string, unknown>, id: string): Promise<Registration> {
  const validated = validateContractDefinition(body);
  if (!validated.ok) throw new Error(JSON.stringify(validated.issues));
  const definition = validated.value as Extract<ContractDefinition, { vm: "evm" }>;
  const inspection = await inspectEvmContract(definition.network as "base", definition.address);
  return {
    id, ownerKeyId: OWNER_KEY, projectId: "proj_1", status: "active", activeRevision: 1, activatesAt: null,
    definition, definitionHash: await contractDefinitionHash(definition), pins: inspection.pins,
    verification: { source: { status: "exact_match", provider: "sourcify", checkedAt: null }, domain: { verified: false, checkedAt: null } },
    createdAt: new Date().toISOString(), visibility: "private",
  };
}

function code(error: unknown): string {
  return error instanceof PlatformError ? error.code : String(error);
}

/** Public RPCs and venues rate-limit: one retry on a transient upstream failure. */
async function retryTransient<T>(t: { diagnostic(message: string): void }, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!["RPC_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "UPSTREAM_TIMEOUT"].includes(code(error))) throw error;
    t.diagnostic(`retrying after ${code(error)}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return run();
  }
}

describe("BYOC live dry run (KLETIA_LIVE=1)", { skip: !LIVE }, () => {
  const directory = new MemoryDirectory();
  let holder: string | null = null;
  let vault: Registration;

  before(async () => {
    directory.actionTransport = transport;
    configureContractDirectory(directory);
    configurePlatform({ store: new MemoryIntentStore(), adapters: null, contracts: directory });
    holder = await fundedHolder();
    vault = directory.add(await evmRegistration(vaultDefinitionBody(), "ct_00000000000000000000b45e"));
  });

  after(() => configurePlatform({ contracts: null }));

  it("10.1 pins Base USDC as a ZeppelinOS proxy and refuses to register it (registry asset)", async (t) => {
    const inspection = await inspectEvmContract("base", BASE_USDC);
    assert.equal(inspection.pins.proxy?.kind, "zeppelinos");
    t.diagnostic(`implementation ${inspection.pins.proxy?.implementation} hash ${inspection.pins.proxy?.implementationCodeHash} admin ${inspection.pins.proxy?.admin}`);
    if (inspection.pins.proxy?.implementation.toLowerCase() !== "0x2ce6311ddae708829bc0784c967b7d77d19fd779") t.diagnostic("Circle upgraded Base USDC since 2026-10-09");
    const refused = validateContractDefinition(vaultDefinitionBody({ address: BASE_USDC }));
    assert.equal(refused.ok ? "ok" : refused.code, "CONTRACT_DENIED");
  });

  it("10.2 pins the Aave V3 Pool as an EIP-1967 proxy", async () => {
    const inspection = await inspectEvmContract("base", AAVE_POOL_BASE);
    assert.equal(inspection.pins.proxy?.kind, "eip1967");
    assert.ok(inspection.proxyHints.includes("eip1967"));
  });

  it("10.3 tests the Steakhouse vault, plans it from text, and hides it from other keys", async (t) => {
    for (const account of [holder, SYNTHETIC].filter((entry): entry is string => entry !== null)) {
      const result = await testContractAction(vault, { entry: "deposit", account: `eip155:8453:${account}`, amount: "100" });
      assert.equal(result.review.simulation.status, "ok");
      assert.deepEqual(result.review.simulation.assetChanges.map((change) => change.symbol), ["USDC", "steakUSDC"]);
      assert.equal(result.review.simulation.assetChanges[0]?.delta, "-100000000");
      assert.equal(result.transactions[0]?.selector, "0x095ea7b3");
      t.diagnostic(`${account}: +${result.expectedOutput?.formatted} ${result.expectedOutput?.symbol}, gas ${result.gas}, fees $${result.feesUsd?.toFixed(4)}`);
    }
    const graph = await createIntent({ accounts: [`eip155:8453:${SYNTHETIC}`], text: "deposit 100 USDC into acme vault" }, { ownerKeyId: OWNER_KEY, dryRun: true });
    assert.equal(graph.steps[0]?.kind, "call");
    assert.equal(graph.steps[0]?.protocol, "custom-call");
    assert.ok(graph.steps[0]?.call?.review.notices.length);
    const call = { kind: "call", network: "base", contract: vault.id, entry: "deposit", amount: "100" };
    await assert.rejects(createIntent({ accounts: [`eip155:8453:${SYNTHETIC}`], actions: [call] }, { dryRun: true }), (error) => code(error) === "CONTRACT_UNKNOWN");
    await assert.rejects(createIntent({ accounts: [`eip155:8453:${SYNTHETIC}`], actions: [call] }, { ownerKeyId: STRANGER_KEY, dryRun: true }), (error) => code(error) === "CONTRACT_UNKNOWN");
  });

  it("prepares the vault deposit for a funded account (never signed)", async (t) => {
    if (!holder) return t.skip("no funded holder found in the last blocks");
    const graph = await createIntent({ accounts: [`eip155:8453:${holder}`], actions: [{ kind: "call", network: "base", contract: vault.id, entry: "deposit", amount: "100" }] }, { ownerKeyId: OWNER_KEY });
    const { payload } = await prepareStep(graph.id, "s1");
    assert.ok(payload.transactions.length >= 1 && payload.transactions.length <= 2);
    assert.equal(payload.review?.simulation.status, "ok");
    t.diagnostic(`prepared ${payload.transactions.map((transaction) => transaction.description).join(" + ")}`);
  });

  it("10.4 chains a bridge from the auction into a call funded by its minimum", async (t) => {
    const body = vaultDefinitionBody({ network: "arbitrum", address: HIGH_YIELD_ARBITRUM, integrator: { name: "Acme High Yield", website: "https://acme.example" } }, { phrases: { verbs: ["deposit"], aliases: ["hy vault"] } });
    const highYield = directory.add(await evmRegistration(body, "ct_0000000000000000000a4b11"));
    const accounts = [`eip155:8453:${SYNTHETIC}`, `eip155:42161:${SYNTHETIC}`];
    const graph = await retryTransient(t, () => createIntent({ accounts, text: "bridge 100 USDC from base to arbitrum then deposit it into hy vault" }, { ownerKeyId: OWNER_KEY }));
    const [bridge, deposit] = graph.steps;
    assert.equal(bridge?.kind, "bridge");
    assert.equal(deposit?.kind, "call");
    assert.equal(deposit?.call?.contract, highYield.id);
    assert.equal(deposit?.input?.amount, bridge?.minimumOutput?.amount);
    assert.equal(deposit?.call?.review.simulation.status, "ok");
    t.diagnostic(`s1 ${bridge?.protocol} min ${bridge?.minimumOutput?.formatted} USDC → s2 +${deposit?.expectedOutput?.formatted} ${deposit?.expectedOutput?.symbol}; evidence: ${bridge?.evidence.map((entry) => entry.detail).join(" | ").slice(0, 300)}`);
    await assert.rejects(prepareStep(graph.id, "s2"), (error) => code(error) === "STEP_NOT_READY");
  });

  it("10.5 refuses forbidden functions, beneficiary literals, EOAs and Permit2", async () => {
    const approve = vaultDefinitionBody({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] }, { function: "approve(address,uint256)", args: ["$self", "$amount"] });
    assert.equal((validateContractDefinition(approve) as { code: string }).code, "CONTRACT_FUNCTION_FORBIDDEN");
    const multicall = vaultDefinitionBody({ abi: [{ type: "function", name: "multicall", stateMutability: "nonpayable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [] }] }, { function: "multicall(bytes[])", args: [{ array: [] }] });
    assert.equal((validateContractDefinition(multicall) as { code: string }).code, "CONTRACT_FUNCTION_FORBIDDEN");
    const literal = vaultDefinitionBody({}, { args: ["$amount", { literal: "0x1111111111111111111111111111111111111111" }] });
    assert.equal((validateContractDefinition(literal) as { code: string }).code, "CONTRACT_BINDING_INVALID");
    const eoa = await inspectEvmContract("base", SYNTHETIC);
    assert.equal(eoa.codeSize, 0);
    assert.ok(eoa.proxyHints.includes("not-deployed"));
    assert.equal((validateContractDefinition(vaultDefinitionBody({ address: PERMIT2 })) as { code: string }).code, "CONTRACT_DENIED");
  });

  it("10.6 refuses a prepare whose pinned code no longer matches and suspends the registration", async () => {
    const graph = await createIntent({ accounts: [`eip155:8453:${SYNTHETIC}`], actions: [{ kind: "call", network: "base", contract: vault.id, entry: "deposit", amount: "100" }] }, { ownerKeyId: OWNER_KEY });
    const store = getIntentStore();
    const stored = await store.get(graph.id);
    assert.ok(stored);
    const step = stored.steps[0]!;
    const tampered = { ...stored, steps: [{ ...step, call: { ...step.call!, pins: { ...step.call!.pins!, codeHash: `0x${"00".repeat(32)}` } } }] };
    await store.update(graph.id, tampered, stored.updatedAt);
    await assert.rejects(prepareStep(graph.id, "s1"), (error) => code(error) === "CONTRACT_CHANGED");
    assert.equal(directory.anomalies.at(-1)?.reason, "pins_changed");
    assert.equal(vault.status, "suspended");
    vault.status = "active";
  });

  it("10.7 holds the Jupiter blink to the CPI scan: refused while its route hands the user's wallet to programs outside the allowlist, prepared once they are allowlisted (re-blockhashed, never signed)", async (t) => {
    // Jupiter's route CPIs into AMM programs that change with every quote; some receive the user's wallet
    // (transfer authority or payer), which lets them act with the user's signature. Each refusal names one;
    // the run allowlists it (at most 6 programs) and asks again, so the route of the moment decides the outcome.
    const allowlist = [JUP6, NOOP];
    const wallet = /passes the user's wallet to ([1-9A-HJ-NP-Za-km-z]{32,44}),/u;
    const account = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL_HOLDER}`;
    let swap: Registration | null = null;
    let result;
    for (let attempt = 0; attempt < 5 && !result; attempt += 1) {
      const validated = validateContractDefinition({
        vm: "svm", network: "solana", integrator: { name: "Acme Swap", website: "https://acme.example" }, origin: "https://jupiter.dial.to", programs: allowlist,
        actions: [{ id: "swap", label: "Swap SOL to USDC", href: "https://jupiter.dial.to/api/v0/swap/SOL-USDC/{amount}", primaryProgram: JUP6, input: { token: "native" }, output: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", toleranceBps: 100 }, phrases: { verbs: ["swap"], aliases: ["acme swap"] }, limits: { maxAmount: "1" } }],
      });
      if (!validated.ok) {
        t.diagnostic(`allowlist ${allowlist.join(", ")} is not registrable: ${JSON.stringify(validated).slice(0, 200)}`);
        return;
      }
      const pins = await readSolanaProgramPins("solana", allowlist);
      if (attempt === 0) t.diagnostic(`JUP6 last deploy slot ${pins[0]?.lastDeploySlot}, authority ${pins[0]?.upgradeAuthority}`);
      swap = directory.add({
        id: "ct_00000000000000000000a0b1", ownerKeyId: OWNER_KEY, projectId: "proj_1", status: "active", activeRevision: 1, activatesAt: null,
        definition: validated.value, definitionHash: await contractDefinitionHash(validated.value), pins,
        verification: { domain: { verified: false, checkedAt: null }, programs: [{ program: JUP6, verified: false, provider: "ottersec", checkedAt: null }] },
        createdAt: new Date().toISOString(), visibility: "private",
      });
      try {
        result = await testContractAction(swap, { entry: "swap", account, amount: "0.01" });
      } catch (error) {
        if (code(error) === "ACTION_ENDPOINT_UNAVAILABLE") return t.skip("jupiter.dial.to is unavailable");
        const reached = code(error) === "ACTION_TRANSACTION_REJECTED" ? wallet.exec((error as Error).message)?.[1] : undefined;
        if (!reached) throw error;
        t.diagnostic(`refused (attempt ${attempt + 1}): the route hands the user's wallet to ${reached}, not allowlisted`);
        if (allowlist.length >= 6) return;
        allowlist.push(reached);
      }
    }
    if (!result) return t.diagnostic("the route kept changing; every attempt was refused (fail closed)");
    assert.equal(result.review.simulation.status, "ok");
    assert.ok(BigInt(result.expectedOutput?.amount ?? "0") > 0n);
    t.diagnostic(`accepted with ${allowlist.length} programs: +${result.expectedOutput?.formatted} USDC for 0.01 SOL; SOL ${result.review.simulation.assetChanges[0]?.formatted}`);
    try {
      const graph = await createIntent({ accounts: [account], text: "swap 0.01 SOL with acme swap" }, { ownerKeyId: OWNER_KEY });
      assert.equal(graph.steps[0]?.kind, "action");
      const { payload, intent } = await prepareStep(graph.id, "s1");
      assert.equal(payload.vm, "svm");
      assert.ok(intent.steps[0]?.evidence.some((entry) => entry.reference?.startsWith("ix1:")));
    } catch (error) {
      if (code(error) === "ACTION_ENDPOINT_UNAVAILABLE") return t.skip("jupiter.dial.to is unavailable");
      // A fresh quote may route through another program that receives the wallet: refused, never prepared.
      if (code(error) !== "ACTION_TRANSACTION_REJECTED" || !wallet.test((error as Error).message)) throw error;
      t.diagnostic(`plan/prepare refused: ${(error as Error).message.slice(0, 160)}`);
    }
  });

  it("10.8 refuses the transfer-sol action (System transfer to an undeclared third party)", async (t) => {
    const nick = "nick6zJc6HpW3kfBm4xS2dmbuVRyb5F3AnUvj5ymzR5";
    const body = (payees: unknown[]) => ({
      vm: "svm", network: "solana", integrator: { name: "Acme Pay", website: "https://acme.example" }, origin: "https://solana-actions.vercel.app", programs: [NOOP],
      ...(payees.length ? { payees } : {}),
      actions: [{ id: "tip", label: "Tip", href: `https://solana-actions.vercel.app/api/actions/transfer-sol?to=${nick}&amount={amount}`, primaryProgram: NOOP, input: { token: "native" }, limits: { maxAmount: "0.01" } }],
    });
    for (const [payees, pattern] of [[[], /undeclared third party/u], [[{ label: "Nick", address: nick, maxLamports: "1000000" }], /does not invoke the action's program/u]] as const) {
      const validated = validateContractDefinition(body([...payees]));
      assert.ok(validated.ok);
      const registration = {
        id: "ct_00000000000000000000c0c0", ownerKeyId: OWNER_KEY, projectId: null, status: "active" as const, activeRevision: 1, activatesAt: null,
        definition: validated.value, definitionHash: await contractDefinitionHash(validated.value), pins: await readSolanaProgramPins("solana", [NOOP]),
        verification: { domain: { verified: false, checkedAt: null } }, createdAt: new Date().toISOString(),
      };
      try {
        await testContractAction(registration, { entry: "tip", account: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL_HOLDER}`, amount: "0.001" });
        assert.fail("transfer-sol must be refused");
      } catch (error) {
        if (code(error) === "ACTION_ENDPOINT_UNAVAILABLE") return t.skip("solana-actions.vercel.app is unavailable");
        assert.equal(code(error), "ACTION_TRANSACTION_REJECTED");
        assert.match((error as Error).message, pattern);
      }
    }
  });

  it("10.9 simulates on Solana devnet and Arbitrum Sepolia", async () => {
    assert.equal(await probeSolanaSimulation("solana-devnet"), true);
    assert.ok((await simulationEndpoints("arbitrum-sepolia")).length > 0);
  });

  it("10.10 refuses a test when the only configured endpoint cannot simulate", async () => {
    const previous = process.env.KLETIA_SIMULATION_RPC_URLS_ETHEREUM;
    process.env.KLETIA_SIMULATION_RPC_URLS_ETHEREUM = "https://cloudflare-eth.com";
    resetSimulationEndpoints();
    try {
      assert.deepEqual(await simulationEndpoints("ethereum"), []);
      const body = vaultDefinitionBody({ network: "ethereum", address: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB" });
      const registration = await evmRegistration(body, "ct_00000000000000000000e7e7");
      await assert.rejects(testContractAction(registration, { entry: "deposit", account: `eip155:1:${SYNTHETIC}`, amount: "100" }), (error) => code(error) === "SIMULATION_UNAVAILABLE");
    } finally {
      if (previous === undefined) delete process.env.KLETIA_SIMULATION_RPC_URLS_ETHEREUM;
      else process.env.KLETIA_SIMULATION_RPC_URLS_ETHEREUM = previous;
      resetSimulationEndpoints();
    }
  });
});
