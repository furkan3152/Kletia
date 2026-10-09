/**
 * Recipient name hook: names resolve only through registered resolvers
 * (longest suffix wins), resolution is recorded on the step, and every
 * prepare resolves the name again and refuses when the address changed.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { NetworkKey } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import {
  looksLikeName,
  registerNameResolver,
  resetNameResolvers,
  resolverFor,
  resolveRecipientName,
  type NameResolver,
} from "../names.js";
import { planIntent } from "../planner.js";
import { quoteRoutes } from "../quotes.js";
import { createIntent, getIntent, prepareStep } from "../service.js";
import { ACCOUNTS, OTHER_EVM_ADDRESS, OTHER_SOL_ADDRESS, SOL_ADDRESS } from "./helpers.js";
import { resetVenueEngine } from "./venueStubs.js";

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

/** Scripted resolver: a name -> address table, or a thrown error. */
function fakeResolver(id: string, protocol: NameResolver["protocol"], suffixes: string[], networks: NetworkKey[], table: Map<string, string>): NameResolver & { fail: Error | null; calls: string[] } {
  const resolver = {
    id,
    protocol,
    suffixes,
    networks,
    fail: null as Error | null,
    calls: [] as string[],
    async resolve(name: string, network: NetworkKey) {
      resolver.calls.push(`${name}@${network}`);
      if (resolver.fail) throw resolver.fail;
      const address = table.get(name);
      return address ? { name, address, protocol, detail: `${id} resolver 0xR, block 123`, reference: "123" } : null;
    },
  };
  return resolver;
}

async function planError(input: unknown): Promise<PlatformError> {
  try {
    await planIntent(input);
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("planning succeeded but should have failed");
}

describe("recipient name hook", () => {
  const ens = new Map<string, string>([["vitalik.eth", VITALIK], ["jesse.base.eth", OTHER_EVM_ADDRESS]]);
  const basenames = new Map<string, string>([["jesse.base.eth", "0x2211d1D0020DAEA8039E46Cf1367962070d77DA9"]]);
  const sns = new Map<string, string>([["bonfida.sns", OTHER_SOL_ADDRESS], ["self.sns", SOL_ADDRESS], ["evm.sns", VITALIK]]);
  let ensResolver: ReturnType<typeof fakeResolver>;

  beforeEach(() => {
    resetVenueEngine();
    resetNameResolvers();
    ensResolver = fakeResolver("ens", "ens", [".eth"], ["ethereum", "base", "arbitrum", "optimism", "polygon"], ens);
  });
  afterEach(() => resetNameResolvers());

  it("recognises names, never addresses", () => {
    for (const name of ["vitalik.eth", "jesse.base.eth", "bonfida.sns", "toly.sol", "A-B.eth"]) assert.ok(looksLikeName(name), name);
    for (const value of [VITALIK, SOL_ADDRESS, "eth", ".eth", "-a.eth", "vitalik.com", "vitalik..eth", `eip155:1:${VITALIK}`]) assert.ok(!looksLikeName(value), value);
  });

  it("refuses names while no resolver is registered (the default)", async () => {
    const error = await planError({ text: "send 5 USDC to vitalik.eth on optimism", accounts: ACCOUNTS });
    assert.equal(error.code, "RECIPIENT_NAME_UNSUPPORTED");
    assert.equal(error.status, 422);
  });

  it("resolves a transfer recipient and records the name and evidence on the step", async () => {
    registerNameResolver(ensResolver);
    const graph = await planIntent({ text: "send 5 USDC to vitalik.eth on optimism", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.network, "optimism");
    assert.equal(step?.recipient, `eip155:10:${VITALIK}`);
    assert.equal(step?.recipientName, "vitalik.eth");
    const note = step?.evidence.find((entry) => entry.kind === "note");
    assert.match(note?.detail ?? "", /^Resolved vitalik\.eth to 0xd8dA.* via ENS: ens resolver 0xR, block 123/u);
    assert.equal(note?.reference, "123");
    assert.deepEqual(ensResolver.calls, ["vitalik.eth@optimism"]);
  });

  it("picks the resolver with the longest matching suffix and checks its networks", async () => {
    registerNameResolver(ensResolver);
    registerNameResolver(fakeResolver("basenames", "basenames", [".base.eth"], ["base"], basenames));
    assert.equal(resolverFor("jesse.base.eth", "base")?.id, "basenames");
    assert.equal(resolverFor("jesse.base.eth", "optimism")?.id, "ens", "Basenames only serves Base recipients");
    const graph = await planIntent({ text: "send 5 USDC to jesse.base.eth", accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.recipient, "eip155:8453:0x2211d1D0020DAEA8039E46Cf1367962070d77DA9");
    assert.throws(() => registerNameResolver(fakeResolver("ens", "ens", [".eth"], ["base"], ens)), /already registered/u);
    assert.throws(() => registerNameResolver(fakeResolver("bad", "ens", ["eth"], ["base"], ens)), /invalid suffixes/u);
  });

  it("resolves a bridge recipient on the destination network", async () => {
    registerNameResolver(fakeResolver("sns", "sns", [".sns", ".sol"], ["solana"], sns));
    const graph = await planIntent({ actions: [{ kind: "bridge", network: "base", from: "USDC", amount: "10", toNetwork: "solana", recipient: "bonfida.sns" }], accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.recipient, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${OTHER_SOL_ADDRESS}`);
    assert.equal(graph.steps[0]?.recipientName, "bonfida.sns");
    // A name that points at the sender is a self transfer; one for another VM is invalid for the network.
    assert.equal((await planError({ text: "send 1 USDC to self.sns", accounts: ACCOUNTS })).code, "SELF_TRANSFER");
    assert.equal((await planError({ text: "send 1 USDC to evm.sns", accounts: ACCOUNTS })).code, "RECIPIENT_INVALID");
  });

  it("fails closed on missing records and unreadable resolvers", async () => {
    registerNameResolver(ensResolver);
    assert.equal((await planError({ text: "send 5 USDC to nobody.eth on base", accounts: ACCOUNTS })).code, "RECIPIENT_NAME_UNRESOLVED");
    ensResolver.fail = new Error("rpc down");
    const unavailable = await planError({ text: "send 5 USDC to vitalik.eth on base", accounts: ACCOUNTS });
    assert.equal(unavailable.code, "NAME_RESOLUTION_UNAVAILABLE");
    assert.equal(unavailable.status, 503);
    ensResolver.fail = new PlatformError("NAME_TLD_PAUSED", ".sol resolution is paused.", 422);
    assert.equal((await planError({ text: "send 5 USDC to vitalik.eth on base", accounts: ACCOUNTS })).code, "NAME_TLD_PAUSED", "a resolver's own 4xx is kept");
    await assert.rejects(resolveRecipientName("vitalik.com", "base"), /not a supported name/u);
  });

  it("resolves names given to POST /v1/quotes", async () => {
    registerNameResolver(fakeResolver("sns", "sns", [".sns"], ["solana"], sns));
    const result = await quoteRoutes({ network: "base", from: "USDC", to: "USDC", toNetwork: "solana", amount: "5", recipient: "bonfida.sns" });
    assert.ok(result.best);
  });

  it("re-resolves before every prepare and refuses a changed address", async () => {
    registerNameResolver(ensResolver);
    const intent = await createIntent({ text: "send 5 USDC to vitalik.eth on base", accounts: ACCOUNTS });
    ensResolver.calls.length = 0;
    const prepared = await prepareStep(intent.id, "s1");
    assert.equal(prepared.intent.steps[0]?.status, "awaiting_signature");
    assert.deepEqual(ensResolver.calls, ["vitalik.eth@base"]);

    ens.set("vitalik.eth", OTHER_EVM_ADDRESS);
    try {
      await assert.rejects(prepareStep(intent.id, "s1"), (error: unknown) =>
        error instanceof PlatformError && error.code === "RECIPIENT_NAME_CHANGED" && error.status === 409);
      ensResolver.fail = new Error("rpc down");
      await assert.rejects(prepareStep(intent.id, "s1"), (error: unknown) => error instanceof PlatformError && error.code === "NAME_RESOLUTION_UNAVAILABLE");
      const stored = await getIntent(intent.id);
      assert.equal(stored.steps[0]?.recipient, `eip155:8453:${VITALIK}`, "the planned recipient is never rewritten");
    } finally {
      ens.set("vitalik.eth", VITALIK);
    }
  });
});
