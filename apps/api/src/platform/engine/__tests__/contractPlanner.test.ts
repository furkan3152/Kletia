/**
 * Planning and preparing call steps against the registry: owner scoping
 * (owner, project visibility, other keys, keyless), kill switch, status and
 * revision checks, deny list, parameters, amounts and caps, recipients,
 * `$previous` bindings, chaining after a bridge (the auction untouched) and
 * the prepare-time re-checks of the service.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { findAssetBySymbol } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { configurePlatform, createIntent, prepareStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { STUB_ADAPTERS } from "./helpers.js";
import {
  fund,
  installDirectory,
  installEvmHarness,
  OTHER,
  OWNER_KEY,
  registrationOf,
  SIBLING_KEY,
  STRANGER_KEY,
  USDC_BASE,
  USER,
  VAULT,
  vaultDefinitionBody,
  type EvmHarness,
  type MemoryDirectory,
  type Registration,
} from "./contractHarness.js";

const ACCOUNT = `eip155:8453:${USER}`;
const ARBITRUM_ACCOUNT = `eip155:42161:${USER}`;
const ARBITRUM_USDC = findAssetBySymbol("arbitrum", "USDC")?.address as string;

let harness: EvmHarness;
let directory: MemoryDirectory;
let registration: Registration;

function rejects(code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof PlatformError, String(error));
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

function call(extra: Record<string, unknown> = {}) {
  return { kind: "call", network: "base", contract: registration.id, entry: "deposit", amount: "100", ...extra };
}

function plan(actions: unknown[], ownerKeyId: string | null = OWNER_KEY, accounts = [ACCOUNT]) {
  return createIntent({ accounts, actions }, ownerKeyId ? { ownerKeyId } : {});
}

beforeEach(async () => {
  harness = installEvmHarness();
  directory = installDirectory();
  configurePlatform({ store: new MemoryIntentStore(), adapters: STUB_ADAPTERS, contracts: directory });
  fund(harness.world, USDC_BASE, USER, 5_000_000_000n);
  registration = directory.add(await registrationOf(vaultDefinitionBody()));
});

afterEach(() => {
  harness.restore();
  configurePlatform({ contracts: null });
  delete process.env.KLETIA_CONTRACTS_ENABLED;
  delete process.env.KLETIA_CONTRACT_STEP_MAX_USD;
});

describe("call steps: scoping", () => {
  it("lets the owner key call its registration by id and by alias", async () => {
    assert.equal((await plan([call()])).steps[0]?.call?.contract, registration.id);
    assert.equal((await plan([call({ contract: "Acme Vault" })])).steps[0]?.call?.contract, registration.id);
  });

  it("treats other keys, other projects and keyless intents exactly like unknown ids", async () => {
    await assert.rejects(plan([call()], SIBLING_KEY), rejects("CONTRACT_UNKNOWN"));
    await assert.rejects(plan([call()], STRANGER_KEY), rejects("CONTRACT_UNKNOWN"));
    await assert.rejects(plan([call()], null), rejects("CONTRACT_UNKNOWN", /without an API key/u));
    await assert.rejects(plan([call({ contract: "ct_ffffffffffffffffffffffff" })]), rejects("CONTRACT_UNKNOWN"));
  });

  it("lets keys of the same project use project-visible registrations", async () => {
    registration.visibility = "project";
    assert.equal((await plan([call()], SIBLING_KEY)).steps[0]?.kind, "call");
    await assert.rejects(plan([call()], STRANGER_KEY), rejects("CONTRACT_UNKNOWN"));
  });

  it("is disabled without a directory or with the kill switch", async () => {
    process.env.KLETIA_CONTRACTS_ENABLED = "false";
    await assert.rejects(plan([call()]), rejects("CONTRACTS_DISABLED"));
    delete process.env.KLETIA_CONTRACTS_ENABLED;
    configurePlatform({ contracts: null });
    await assert.rejects(plan([call()]), rejects("CONTRACTS_DISABLED"));
  });
});

describe("call steps: registration state and entry", () => {
  it("refuses pending and suspended registrations", async () => {
    registration.status = "pending";
    registration.activeRevision = null;
    registration.activatesAt = "2026-10-09T12:15:00.000Z";
    await assert.rejects(plan([call()]), rejects("CONTRACT_PENDING", /2026-10-09T12:15/u));
    registration.status = "suspended";
    registration.activeRevision = 1;
    await assert.rejects(plan([call()]), rejects("CONTRACT_SUSPENDED"));
  });

  it("refuses unknown entries, wrong kinds and wrong networks", async () => {
    await assert.rejects(plan([call({ entry: "withdraw" })]), rejects("CONTRACT_ACTION_UNKNOWN"));
    await assert.rejects(plan([{ ...call(), kind: "action" }]), rejects("NETWORK_UNSUPPORTED"));
    await assert.rejects(plan([call({ network: "arbitrum" })], OWNER_KEY, [ARBITRUM_ACCOUNT]), rejects("NETWORK_UNSUPPORTED", /registered on Base/u));
    await assert.rejects(plan([call({ protocol: "aave-v3" })]), rejects("INTENT_UNSUPPORTED"));
    await assert.rejects(plan([call({ params: { venue: "x" } })]), rejects("INTENT_UNSUPPORTED"));
  });

  it("re-checks the deny list at plan", async () => {
    directory.deny.add(`base:${VAULT.toLowerCase()}`);
    await assert.rejects(plan([call()]), rejects("CONTRACT_DENIED"));
  });

  it("validates parameters against the entry", async () => {
    await assert.rejects(plan([call({ params: { lockDays: 3 } })]), rejects("CONTRACT_PARAM_INVALID"));
  });
});

describe("call steps: amounts, recipients and bindings", () => {
  it("enforces the entry limits and the per-step USD caps", async () => {
    await assert.rejects(plan([call({ amount: "25001" })]), rejects("CONTRACT_AMOUNT_LIMIT", /at most 25000/u));
    registration.verification = { ...registration.verification, domain: { verified: false, checkedAt: null } };
    await assert.rejects(plan([call({ amount: "1500" })]), rejects("CONTRACT_AMOUNT_LIMIT", /\$1000 cap/u));
    assert.equal((await plan([call({ amount: "900" })])).steps[0]?.input?.formatted, "900");
  });

  it("needs an amount for spending entries and the entry's own input asset", async () => {
    await assert.rejects(plan([{ kind: "call", network: "base", contract: registration.id, entry: "deposit" }]), rejects("AMOUNT_REQUIRED"));
    await assert.rejects(plan([call({ from: "WETH" })]), rejects("ASSET_MISMATCH"));
    assert.equal((await plan([call({ from: "USDC" })])).steps[0]?.input?.symbol, "USDC");
  });

  it("pays only the acting account unless the entry allows any recipient", async () => {
    await assert.rejects(plan([call({ recipient: OTHER })]), rejects("INTENT_UNSUPPORTED"));
    assert.equal((await plan([call({ recipient: USER })])).steps[0]?.recipient, undefined);
  });

  it("refuses $previous bindings without a previous step on the network", async () => {
    const withPrevious = vaultDefinitionBody(
      {
        abi: [
          ...(vaultDefinitionBody().abi as unknown[]).filter((item) => (item as { type: string }).type === "event"),
          { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }, { name: "hint", type: "uint256" }], outputs: [] },
        ],
      },
      { function: "deposit(uint256,address,uint256)", args: ["$amount", "$account", "$previous.output.amount"] },
    );
    registration = directory.add(await registrationOf(withPrevious, { id: "ct_00000000000000000000000b" }));
    await assert.rejects(plan([call()]), rejects("CONTRACT_BINDING_INVALID", /\$previous/u));
  });
});

describe("call steps: chaining", () => {
  beforeEach(async () => {
    harness.world.tokens.set(ARBITRUM_USDC.toLowerCase(), { symbol: "USDC", decimals: 6, slot: 9, layout: "solidity" });
    harness.world.vaultAsset = ARBITRUM_USDC;
    const body = vaultDefinitionBody({ network: "arbitrum" }, { phrases: { verbs: ["deposit"], aliases: ["hy vault"] } });
    registration = directory.add(await registrationOf(body, { id: "ct_0000000000000000000000a1" }));
  });

  it("funds a call after a bridge with the bridge's guaranteed minimum; the bridge still runs its auction", async () => {
    const graph = await plan(
      [
        { kind: "bridge", network: "base", toNetwork: "arbitrum", from: "USDC", amount: "100" },
        { kind: "call", network: "arbitrum", contract: registration.id, entry: "deposit", amount: "max" },
      ],
      OWNER_KEY,
      [ACCOUNT, ARBITRUM_ACCOUNT],
    );
    const [bridge, deposit] = graph.steps;
    assert.equal(bridge?.protocol, "relay");
    assert.equal(deposit?.kind, "call");
    assert.equal(deposit?.input?.amount, bridge?.minimumOutput?.amount);
    assert.deepEqual(graph.edges, [{ from: "s1", to: "s2", kind: "funds" }]);
    assert.equal(deposit?.call?.review.simulation.status, "ok", "simulated with the plan-time balance override");
    await assert.rejects(prepareStep(graph.id, "s2"), rejects("STEP_NOT_READY"));
  });

  it("plans the same chain from text with the key's alias", async () => {
    const graph = await createIntent(
      { accounts: [ACCOUNT, ARBITRUM_ACCOUNT], text: "bridge 100 USDC from base to arbitrum then deposit it into hy vault" },
      { ownerKeyId: OWNER_KEY },
    );
    assert.deepEqual(graph.steps.map((step) => step.kind), ["bridge", "call"]);
    assert.equal(graph.steps[1]?.call?.contract, registration.id);
    assert.equal(graph.steps[1]?.network, "arbitrum");
  });

  it("refuses max after a call that declares no output", async () => {
    harness.world.vaultAsset = USDC_BASE;
    const body = vaultDefinitionBody({}, { output: undefined, events: [{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$amount" } }] });
    registration = directory.add(await registrationOf(body, { id: "ct_0000000000000000000000c1" }));
    const actions = [call(), { kind: "transfer", network: "base", from: "USDC", amount: "max", recipient: OTHER }];
    await assert.rejects(plan(actions), rejects("AMOUNT_REQUIRED", /produces nothing to spend/u));
  });
});

describe("call steps: prepare-time re-checks", () => {
  it("refuses when the intent's key may no longer use the registration", async () => {
    const graph = await plan([call()]);
    registration.ownerKeyId = STRANGER_KEY;
    registration.projectId = "proj_2";
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("CONTRACT_NOT_USABLE"));
  });

  it("refuses a newer active revision, a suspension, a deny-listed target and the kill switch", async () => {
    const graph = await plan([call()]);
    registration.activeRevision = 2;
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("CONTRACT_REVISION_CHANGED"));
    registration.activeRevision = 1;
    registration.definitionHash = "f".repeat(64);
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("CONTRACT_REVISION_CHANGED"));
    const fresh = await registrationOf(vaultDefinitionBody());
    registration.definitionHash = fresh.definitionHash;
    registration.status = "suspended";
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("CONTRACT_SUSPENDED"));
    registration.status = "active";
    directory.deny.add(`base:${VAULT.toLowerCase()}`);
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("CONTRACT_DENIED"));
    directory.deny.clear();
    process.env.KLETIA_CONTRACTS_ENABLED = "false";
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("CONTRACTS_DISABLED"));
  });

  it("applies the USD cap again and records the daily notional through the directory", async () => {
    const graph = await plan([call()]);
    process.env.KLETIA_CONTRACT_STEP_MAX_USD = "50";
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("CONTRACT_AMOUNT_LIMIT"));
    delete process.env.KLETIA_CONTRACT_STEP_MAX_USD;
    directory.spendCap = 10;
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("CONTRACT_SPEND_LIMIT"));
    directory.spendCap = Number.POSITIVE_INFINITY;
    await prepareStep(graph.id, "s1");
    assert.deepEqual(directory.spends, [{ owner: OWNER_KEY, usd: 100 }]);
  });
});
