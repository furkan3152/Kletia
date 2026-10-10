import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { address, getAddressEncoder } from "@solana/kit";
import { CHAINS, findAssetBySymbol, parseAccountId, type IntentGraph, type IntentStep } from "@kletia/core";
import { parseSolanaDexQuote, parseSolanaDexInstructions, type SolanaDex } from "../../../networks/solana/dexSwap.js";
import { orcaAdapter, raydiumAdapter } from "../adapters/solanaDex.js";
import { decodeDexRouteData } from "../adapters/solanaDexClient.js";
import type { AdapterAction, ProtocolAdapter } from "../adapters/types.js";
import { assetAmount, type ResolvedAsset } from "../assets.js";
import { decodeSolanaTransaction, simulateSolanaTransactionDetailed, SOLANA_PROGRAM_IDS } from "../chains/solana.js";
import { encodeStepRef } from "../stepRef.js";
import { randomSolanaSignature } from "./helpers.js";
import { ata, ATTACKER, installSolanaLendMock, lookupTableData, OWNER, SYSTEM, TOKEN_PROGRAM, USDC, WSOL,
  type LandedFixture, type SolanaLendMock } from "./solanaLendFixtures.js";

const CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const CP = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const POOL = "CYbD9RaToYMtWKA7QZyoLahnHdWq553Vm62Lh6qWtuxq";
const ORCA_POOL = "83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d";
const ALT = "BDqppwFYeMpUicN9xbfoM7FgRnHVW1uTUtrGA7uG2vQg";
const VAULT_A = "GviiXg2Xc1xCpyNY36r7h1EAy7uvse5UMkiiyHjRDU6Z";
const VAULT_B = "3bWPj5eepJm8CxUzk5MMFMN2CFJkntxKvbmy4zwwtpJd";
const OBSERVATION = "AA5RaVvyGyZgtmAsJJHT5ZVBxVPtAXuYaMwfgeFJW4Mk";
const IN = 10_000_000n;
const OUT = 1_097_536n;
const MIN = OUT * 9950n / 10_000n;
const NOW = 1_790_000_000_000;
type ApiInstruction = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
type Bundle = { computeBudgetInstructions: ApiInstruction[]; setupInstructions: ApiInstruction[]; swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null; otherInstructions: ApiInstruction[]; tokenLedgerInstruction: null; addressLookupTableAddresses: string[] };

function resolved(symbol: string): ResolvedAsset {
  const asset = findAssetBySymbol("solana", symbol);
  assert.ok(asset);
  return { ...asset, isNative: asset.address === null, verified: true, canonical: true };
}

function action(dex: SolanaDex = "raydium", input = resolved("SOL"), output = resolved("USDC")): AdapterAction {
  const account = parseAccountId(`${CHAINS.solana.id}:${OWNER}`);
  assert.ok(account);
  return { kind: "swap", network: "solana", destinationNetwork: "solana", input, output, amount: IN.toString(),
    account, recipient: account, slippageBps: 50, provider: dex };
}

function quoteFixture(dex: SolanaDex, label?: string): Record<string, unknown> {
  return { inputMint: WSOL, outputMint: USDC, inAmount: IN.toString(), outAmount: OUT.toString(),
    otherAmountThreshold: (MIN + 1n).toString(), swapMode: "ExactIn", slippageBps: 50, platformFee: null,
    priceImpactPct: "0.00021", instructionVersion: "V1", transactionVersion: 0,
    routePlan: [{ percent: 100, bps: null, swapInfo: { ammKey: dex === "raydium" ? POOL : ORCA_POOL,
      label: label ?? (dex === "raydium" ? "Raydium CLMM" : "Whirlpool"), inputMint: WSOL, outputMint: USDC,
      inAmount: IN.toString(), outAmount: OUT.toString() } }] };
}

function routeData(kind = 26, amount = IN, out = OUT, bps = 50): Uint8Array {
  const fields = kind === 17 ? [1] : kind === 47 ? [1, 0] : [];
  const data = new Uint8Array(35 + fields.length);
  data.set(Buffer.from("e517cb977ae3ad2a", "hex"));
  const view = new DataView(data.buffer);
  view.setUint32(8, 1, true);
  data[12] = kind;
  data.set(fields, 13);
  const offset = 13 + fields.length;
  data.set([100, 0, 1], offset);
  view.setBigUint64(offset + 3, amount, true);
  view.setBigUint64(offset + 11, out, true);
  view.setUint16(offset + 19, bps, true);
  return data;
}

function apiInstruction(programId: string, keys: readonly string[], data: Uint8Array, signerPositions: readonly number[] = [], writablePositions: readonly number[] = []): ApiInstruction {
  return { programId, accounts: keys.map((pubkey, index) => ({ pubkey, isSigner: signerPositions.includes(index), isWritable: writablePositions.includes(index) })), data: Buffer.from(data).toString("base64") };
}

async function bundleFixture(dex: SolanaDex, kind = dex === "raydium" ? 26 : 17): Promise<Bundle> {
  const input = await ata(OWNER, WSOL);
  const output = await ata(OWNER, USDC);
  const swapKeys = [TOKEN_PROGRAM, OWNER, input, output, SOLANA_PROGRAM_IDS.jupiterV6, USDC,
    SOLANA_PROGRAM_IDS.jupiterV6, ATTACKER, SOLANA_PROGRAM_IDS.jupiterV6, dex === "raydium" ? CLMM : WHIRLPOOL,
    dex === "raydium" ? OWNER : TOKEN_PROGRAM, dex === "raydium" ? ATTACKER : OWNER,
    dex === "raydium" ? POOL : ORCA_POOL, input,
    ...(dex === "raydium" ? [output, VAULT_A, VAULT_B, OBSERVATION, TOKEN_PROGRAM] : [VAULT_A, output, VAULT_B])];
  if (kind === 40) swapKeys.push(SOLANA_PROGRAM_IDS.token2022, SOLANA_PROGRAM_IDS.memo, WSOL, USDC);
  if (kind === 46) swapKeys.splice(9, swapKeys.length - 9, CP, OWNER, ATTACKER, ATTACKER, POOL, input, output,
    VAULT_A, VAULT_B, TOKEN_PROGRAM, TOKEN_PROGRAM, WSOL, USDC, OBSERVATION);
  if (kind === 47) swapKeys.splice(9, swapKeys.length - 9, WHIRLPOOL, TOKEN_PROGRAM, TOKEN_PROGRAM, SOLANA_PROGRAM_IDS.memo,
    OWNER, ORCA_POOL, WSOL, USDC, input, VAULT_A, output, VAULT_B);
  const transfer = new Uint8Array(12);
  const transferView = new DataView(transfer.buffer);
  transferView.setUint32(0, 2, true);
  transferView.setBigUint64(4, IN, true);
  return { tokenLedgerInstruction: null, computeBudgetInstructions: [apiInstruction(SOLANA_PROGRAM_IDS.computeBudget, [], Uint8Array.from([2, 0xc0, 0x5c, 0x15, 0]))],
    setupInstructions: [apiInstruction(SYSTEM, [OWNER, input], transfer, [0], [0, 1]),
      apiInstruction(TOKEN_PROGRAM, [input], Uint8Array.from([17]), [], [0])],
    swapInstruction: apiInstruction(SOLANA_PROGRAM_IDS.jupiterV6, swapKeys, routeData(kind), [1], [2, 3, 12, 13, 14]),
    cleanupInstruction: apiInstruction(TOKEN_PROGRAM, [input, OWNER, OWNER], Uint8Array.from([9]), [2], [0, 1]),
    otherInstructions: [], addressLookupTableAddresses: [] };
}

const addressEncoder = getAddressEncoder();
function poolFixture(dex: SolanaDex, label = dex === "raydium" ? "Raydium CLMM" : "Whirlpool") {
  const data = new Uint8Array(label === "Whirlpool" ? 653 : label === "Raydium CP" ? 637 : 1544);
  data.set(createHash("sha256").update(`account:${label === "Whirlpool" ? "Whirlpool" : "PoolState"}`).digest().subarray(0, 8));
  data.set(addressEncoder.encode(address(WSOL)), label === "Whirlpool" ? 101 : label === "Raydium CP" ? 168 : 73);
  data.set(addressEncoder.encode(address(USDC)), label === "Whirlpool" ? 181 : label === "Raydium CP" ? 200 : 105);
  data.set(addressEncoder.encode(address(ATTACKER)), label === "Raydium CLMM" ? 9 : 8);
  data.set(addressEncoder.encode(address(VAULT_A)), label === "Whirlpool" ? 133 : label === "Raydium CP" ? 72 : 137);
  data.set(addressEncoder.encode(address(VAULT_B)), label === "Whirlpool" ? 213 : label === "Raydium CP" ? 104 : 169);
  if (label !== "Whirlpool") data.set(addressEncoder.encode(address(OBSERVATION)), label === "Raydium CP" ? 296 : 201);
  return { owner: label === "Whirlpool" ? WHIRLPOOL : label === "Raydium CP" ? CP : CLMM, data };
}

function mintFixture(decimals: number) {
  const data = new Uint8Array(82); data[44] = decimals; data[45] = 1;
  return { owner: TOKEN_PROGRAM, data };
}

let mock: SolanaLendMock;
let quotes: Record<SolanaDex, Record<string, unknown>>;
let bundles: Record<SolanaDex, Bundle>;
let providerStatus: number;
let simulationUnavailable: boolean;
let proveCpi: boolean;
let detailedLoadedKeys: boolean;
const requests: URL[] = [];
let providerPosts: Record<string, unknown>[] = [];

beforeEach(async () => {
  mock = installSolanaLendMock();
  mock.accounts.set(POOL, poolFixture("raydium"));
  mock.accounts.set(ORCA_POOL, poolFixture("orca"));
  mock.accounts.set(WSOL, mintFixture(9)); mock.accounts.set(USDC, mintFixture(6));
  quotes = { raydium: quoteFixture("raydium"), orca: quoteFixture("orca") };
  bundles = { raydium: await bundleFixture("raydium"), orca: await bundleFixture("orca") };
  providerStatus = 200; simulationUnavailable = false; proveCpi = true; detailedLoadedKeys = false; requests.length = 0; providerPosts = [];
  const rpcFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/swap/v1/quote") {
      requests.push(url);
      return json(quotes[url.searchParams.get("dexes")?.includes("Raydium") ? "raydium" : "orca"], providerStatus);
    }
    if (url.pathname === "/swap/v1/swap-instructions") {
      providerPosts.push(body);
      const quote = body.quoteResponse as { routePlan: { swapInfo: { label: string } }[] };
      return json(bundles[quote.routePlan[0]?.swapInfo.label.includes("Raydium") ? "raydium" : "orca"], providerStatus);
    }
    if (body.method === "simulateTransaction") {
      if (simulationUnavailable) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "RPC unavailable" } });
      const params = body.params as [string, Record<string, unknown>];
      if (params[1].innerInstructions === true) {
        const decoded = await decodeSolanaTransaction("solana", params[0]);
        const index = decoded.instructions.findIndex((ix) => ix.program === SOLANA_PROGRAM_IDS.jupiterV6);
        const program = decoded.instructions[index]?.accounts[9] as string;
        const pool = program === WHIRLPOOL ? ORCA_POOL : POOL;
        return json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 100 }, value: { err: mock.simulationError,
          logs: [], unitsConsumed: 100_000, loadedAddresses: detailedLoadedKeys ? { writable: [pool], readonly: [] } : {},
          innerInstructions: proveCpi ? [{ index, instructions: [{ programId: program, accounts: [pool], data: "" }] }] : [] } } });
      }
    }
    if (body.method === "getMultipleAccounts") {
      const params = body.params as [string[], { encoding?: string }];
      if (params[1].encoding === "jsonParsed" && params[0].every((key) => key === ALT)) {
        return json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 100 }, value: params[0].map(() => ({
          owner: SOLANA_PROGRAM_IDS.addressLookupTable, executable: false, lamports: 2_000_000, rentEpoch: 0,
          data: { program: "address-lookup-table", parsed: { type: "lookupTable", info: { addresses: [POOL, ATTACKER] } }, space: 120 },
        })) } });
      }
    }
    return rpcFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => { mock.restore(); });

function prepare(adapter: ProtocolAdapter, dex: SolanaDex = adapter.id as SolanaDex) {
  return adapter.prepare({ graph: {} as IntentGraph, step: { quoteRef: encodeStepRef({ v: 1, slippageBps: 50 }) } as IntentStep, action: action(dex), now: NOW });
}

describe("venue-pinned direct Solana quotes", () => {
  for (const dex of ["raydium", "orca"] as const) {
    it(`plans ${dex} with a single direct pool and an integer on-chain floor`, async () => {
      const planned = await (dex === "raydium" ? raydiumAdapter : orcaAdapter).plan(action(dex));
      assert.equal(planned.protocol, dex); assert.equal(planned.minimumOutput.amount, MIN.toString());
      assert.equal(planned.transactionCount, 1);
      assert.equal(requests[0]?.searchParams.get("onlyDirectRoutes"), "true");
      assert.equal(requests[0]?.searchParams.get("instructionVersion"), "V1");
      assert.equal(requests[0]?.searchParams.get("dexes"), dex === "raydium" ? "Raydium CLMM,Raydium CP" : "Whirlpool");
    });
  }
  it("rejects mismatched, split, multi-hop, fee-bearing, exact-out and under-protected quotes", () => {
    const request = { inputMint: WSOL, outputMint: USDC, amount: IN.toString(), slippageBps: 50 };
    const bad: Record<string, unknown>[] = [
      { inAmount: "1" }, { outputMint: WSOL }, { slippageBps: 300 }, { swapMode: "ExactOut" }, { instructionVersion: "V2" },
      { transactionVersion: 1 }, { platformFee: { amount: "1", feeBps: 1 } }, { otherAmountThreshold: "1" }, { priceImpactPct: "NaN" },
      { routePlan: [] }, { routePlan: [...quotes.raydium.routePlan as unknown[], ...quotes.raydium.routePlan as unknown[]] },
      { routePlan: [{ percent: 100, swapInfo: { ...((quotes.raydium.routePlan as { swapInfo: Record<string, unknown> }[])[0]?.swapInfo), label: "Whirlpool" } }] },
    ];
    for (const change of bad) assert.throws(() => parseSolanaDexQuote({ ...quotes.raydium, ...change }, "raydium", request));
    const overflow = structuredClone(quotes.raydium);
    const tooLarge = (1n << 64n).toString();
    overflow.outAmount = tooLarge;
    overflow.otherAmountThreshold = ((1n << 64n) * 9950n / 10_000n).toString();
    (overflow.routePlan as { swapInfo: Record<string, unknown> }[])[0]!.swapInfo.outAmount = tooLarge;
    assert.throws(() => parseSolanaDexQuote(overflow, "raydium", request), /u64/iu);
  });
  it("fails closed on provider unavailability, pool spoofing, mint decimal drift and Token-2022", async () => {
    providerStatus = 503; await assert.rejects(() => raydiumAdapter.plan(action()), /HTTP 503/iu); providerStatus = 200;
    mock.accounts.set(POOL, { ...poolFixture("raydium"), owner: ATTACKER }); await assert.rejects(() => raydiumAdapter.plan(action()), /pinned DEX/iu);
    mock.accounts.set(POOL, poolFixture("raydium")); mock.accounts.set(USDC, mintFixture(9)); await assert.rejects(() => raydiumAdapter.plan(action()), /decimals/iu);
    mock.accounts.set(USDC, { ...mintFixture(6), owner: SOLANA_PROGRAM_IDS.token2022 }); await assert.rejects(() => raydiumAdapter.plan(action()), /Token-2022/iu);
  });
  it("limits price impact and excludes devnet, cross-network, stake and identical-asset routes", async () => {
    quotes.raydium.priceImpactPct = "0.06"; await assert.rejects(() => raydiumAdapter.plan(action()), /above 5%/iu);
    const base = action(); assert.equal(raydiumAdapter.supports(base), true);
    for (const route of [{ ...base, network: "solana-devnet" }, { ...base, destinationNetwork: "base" }, { ...base, kind: "stake" }, { ...base, output: base.input }]) {
      assert.equal(raydiumAdapter.supports(route as AdapterAction), false);
    }
  });
});

describe("direct DEX preparation rejects untrusted instructions", () => {
  for (const adapter of [raydiumAdapter, orcaAdapter]) {
    it(`prepares and independently simulates one unsigned ${adapter.id} swap`, async () => {
      const payload = await prepare(adapter);
      assert.equal(payload.transactions.length, 1); assert.equal(payload.records[0]?.to, SOLANA_PROGRAM_IDS.jupiterV6);
      const transaction = payload.transactions[0]; assert.ok(transaction?.vm === "svm");
      const decoded = await decodeSolanaTransaction("solana", transaction.transaction);
      assert.equal(decoded.feePayer, OWNER); assert.deepEqual(decoded.signers, [OWNER]);
      assert.equal(payload.minimumOutput.amount, MIN.toString());
      assert.equal(providerPosts[0]?.useSharedAccounts, false); assert.equal(providerPosts[0]?.dynamicSlippage, false);
      assert.deepEqual(mock.unknown, []);
    });
  }
  it("rejects changed signers, fee destinations, assets, pool, input and slippage", async () => {
    const baseline = await bundleFixture("raydium");
    for (const position of [0, 1, 2, 3, 4, 5, 6, 9, 12]) {
      bundles.raydium = structuredClone(baseline); bundles.raydium.swapInstruction.accounts[position]!.pubkey = ATTACKER;
      await assert.rejects(() => prepare(raydiumAdapter), /DEX transaction|another pool/iu);
    }
    bundles.raydium = structuredClone(baseline); bundles.raydium.swapInstruction.accounts[11]!.isSigner = true;
    await assert.rejects(() => prepare(raydiumAdapter), /another signer/iu);
    for (const data of [routeData(26, 1n), routeData(26, IN, OUT, 300), routeData(17), routeData(26, IN, 1n), Uint8Array.from([...routeData(), 0])]) {
      bundles.raydium = structuredClone(baseline); bundles.raydium.swapInstruction.data = Buffer.from(data).toString("base64");
      await assert.rejects(() => prepare(raydiumAdapter), /DEX transaction/iu);
    }
  });
  it("rejects arbitrary transfers, approvals, closes, extra swap, fee budget and unsigned-bundle version", async () => {
    const baseline = await bundleFixture("raydium");
    const attacks: ApiInstruction[] = [apiInstruction(TOKEN_PROGRAM, [OWNER, ATTACKER], Uint8Array.from([4]), [0]),
      apiInstruction(SYSTEM, [OWNER, ATTACKER], Buffer.from(baseline.setupInstructions[0]!.data, "base64"), [0], [0, 1]),
      apiInstruction(TOKEN_PROGRAM, [await ata(OWNER, USDC), ATTACKER, OWNER], Uint8Array.from([9]), [2]),
      apiInstruction(ATTACKER, [OWNER], Uint8Array.from([1]), [0]), baseline.swapInstruction];
    for (const ix of attacks) {
      bundles.raydium = structuredClone(baseline); bundles.raydium.setupInstructions.push(ix);
      await assert.rejects(() => prepare(raydiumAdapter), /DEX transaction/iu);
    }
    bundles.raydium = structuredClone(baseline); const fee = new Uint8Array(9); fee[0] = 3; new DataView(fee.buffer).setBigUint64(1, 1_000_001n, true);
    bundles.raydium.computeBudgetInstructions.push(apiInstruction(SOLANA_PROGRAM_IDS.computeBudget, [], fee));
    await assert.rejects(() => prepare(raydiumAdapter), /priority fee/iu);
    assert.throws(() => parseSolanaDexInstructions({ ...baseline, transactionVersion: 1 }));
    assert.throws(() => parseSolanaDexInstructions({ ...baseline, otherInstructions: [baseline.swapInstruction] }));
    assert.throws(() => parseSolanaDexInstructions({ ...baseline, addressLookupTableAddresses: ["invalid"] }));
  });
  it("requires successful RPC simulation and the actual reviewed-pool CPI", async () => {
    simulationUnavailable = true; await assert.rejects(() => prepare(raydiumAdapter), /could not be simulated/iu);
    simulationUnavailable = false; mock.simulationError = { InstructionError: [2, { Custom: 1 }] };
    await assert.rejects(() => prepare(raydiumAdapter), /could not be simulated/iu);
    mock.simulationError = null; proveCpi = false;
    await assert.rejects(() => prepare(raydiumAdapter), /did not prove a swap/iu);
  });
  it("resolves lookup-table keys for instruction and CPI validation even without simulation loadedAddresses", async () => {
    const entries = [POOL, ATTACKER];
    mock.accounts.set(ALT, { owner: SOLANA_PROGRAM_IDS.addressLookupTable, data: lookupTableData(entries) });
    bundles.raydium.addressLookupTableAddresses = [ALT];
    const payload = await prepare(raydiumAdapter); const tx = payload.transactions[0]; assert.ok(tx?.vm === "svm");
    const decoded = await decodeSolanaTransaction("solana", tx.transaction);
    assert.deepEqual(decoded.lookupTables, [ALT]); assert.ok(decoded.accountKeys.includes(POOL));
    // The complete decoded key list must not append duplicate loaded addresses reported by another RPC.
    detailedLoadedKeys = true;
    const simulation = await simulateSolanaTransactionDetailed("solana", tx.transaction, decoded.accountKeys, [], true);
    assert.deepEqual(simulation?.accountKeys, decoded.accountKeys);
  });
  it("decodes only supported reviewed enum variants and rejects Token-2022 remaining-account slices", () => {
    for (const kind of [26, 40, 46]) assert.ok(decodeDexRouteData(routeData(kind), "raydium"));
    for (const kind of [17, 47]) assert.ok(decodeDexRouteData(routeData(kind), "orca"));
    assert.equal(decodeDexRouteData(routeData(7), "raydium"), null);
    const whirlpool = routeData(47); whirlpool[14] = 1;
    assert.equal(decodeDexRouteData(whirlpool, "orca"), null);
  });
  it("checks complete CLMM V2, CP and Whirlpool V2 account layouts against on-chain pool state", async () => {
    for (const kind of [40, 46, 47]) {
      const dex = kind === 47 ? "orca" : "raydium";
      bundles[dex] = await bundleFixture(dex, kind);
      if (kind === 46) {
        quotes.raydium = quoteFixture("raydium", "Raydium CP");
        mock.accounts.set(POOL, poolFixture("raydium", "Raydium CP"));
      }
      const payload = await prepare(dex === "orca" ? orcaAdapter : raydiumAdapter);
      assert.equal(payload.transactions.length, 1);
      const vaultPosition = kind === 40 ? 15 : kind === 46 ? 16 : 18;
      bundles[dex].swapInstruction.accounts[vaultPosition]!.pubkey = ATTACKER;
      await assert.rejects(() => prepare(dex === "orca" ? orcaAdapter : raydiumAdapter), /vault/iu);
    }
  });
  it("prepares native-SOL output without funding or syncing an unrelated token account", async () => {
    const usdc = resolved("USDC"); const sol = resolved("SOL");
    const input = await ata(OWNER, USDC); const output = await ata(OWNER, WSOL);
    const out = 100_000_000n;
    const q = quoteFixture("raydium");
    q.inputMint = USDC; q.outputMint = WSOL; q.outAmount = out.toString();
    q.otherAmountThreshold = (out * 9950n / 10_000n).toString();
    const leg = (q.routePlan as { swapInfo: Record<string, unknown> }[])[0]!.swapInfo;
    leg.inputMint = USDC; leg.outputMint = WSOL; leg.outAmount = out.toString(); quotes.raydium = q;
    bundles.raydium.setupInstructions = [apiInstruction(SOLANA_PROGRAM_IDS.associatedToken,
      [OWNER, output, OWNER, WSOL, SYSTEM, TOKEN_PROGRAM], Uint8Array.from([1]), [0], [0, 1])];
    bundles.raydium.swapInstruction = apiInstruction(SOLANA_PROGRAM_IDS.jupiterV6,
      [TOKEN_PROGRAM, OWNER, input, output, SOLANA_PROGRAM_IDS.jupiterV6, WSOL, SOLANA_PROGRAM_IDS.jupiterV6, ATTACKER,
        SOLANA_PROGRAM_IDS.jupiterV6, CLMM, OWNER, ATTACKER, POOL, input, output, VAULT_B, VAULT_A, OBSERVATION, TOKEN_PROGRAM],
      routeData(26, IN, out), [1], [2, 3, 12, 13, 14]);
    bundles.raydium.cleanupInstruction = apiInstruction(TOKEN_PROGRAM, [output, OWNER, OWNER], Uint8Array.from([9]), [2], [0, 1]);
    const payload = await raydiumAdapter.prepare({ graph: {} as IntentGraph, step: { quoteRef: encodeStepRef({ v: 1, slippageBps: 50 }) } as IntentStep,
      action: action("raydium", usdc, sol), now: NOW });
    assert.equal(payload.minimumOutput.amount, "99500000");
    bundles.raydium.cleanupInstruction.accounts[1]!.pubkey = ATTACKER;
    await assert.rejects(() => raydiumAdapter.prepare({ graph: {} as IntentGraph, step: {} as IntentStep, action: action("raydium", usdc, sol), now: NOW }), /token operation/iu);
  });
  it("prepares a classic SPL-to-SPL swap without SOL wrapping or token-account closing", async () => {
    const inputAsset = resolved("USDC"); const outputAsset = resolved("USDT"); const usdt = outputAsset.address as string;
    mock.accounts.set(usdt, mintFixture(6));
    const pool = poolFixture("raydium");
    pool.data.set(addressEncoder.encode(address(USDC)), 73); pool.data.set(addressEncoder.encode(address(usdt)), 105);
    mock.accounts.set(POOL, pool);
    const q = quoteFixture("raydium"); q.inputMint = USDC; q.outputMint = usdt;
    const leg = (q.routePlan as { swapInfo: Record<string, unknown> }[])[0]!.swapInfo; leg.inputMint = USDC; leg.outputMint = usdt; quotes.raydium = q;
    const input = await ata(OWNER, USDC); const output = await ata(OWNER, usdt);
    bundles.raydium.setupInstructions = [apiInstruction(SOLANA_PROGRAM_IDS.associatedToken,
      [OWNER, output, OWNER, usdt, SYSTEM, TOKEN_PROGRAM], Uint8Array.from([1]), [0], [0, 1])];
    bundles.raydium.cleanupInstruction = null;
    bundles.raydium.swapInstruction = apiInstruction(SOLANA_PROGRAM_IDS.jupiterV6,
      [TOKEN_PROGRAM, OWNER, input, output, SOLANA_PROGRAM_IDS.jupiterV6, usdt, SOLANA_PROGRAM_IDS.jupiterV6, ATTACKER,
        SOLANA_PROGRAM_IDS.jupiterV6, CLMM, OWNER, ATTACKER, POOL, input, output, VAULT_A, VAULT_B, OBSERVATION, TOKEN_PROGRAM],
      routeData(), [1], [2, 3, 12, 13, 14]);
    const payload = await raydiumAdapter.prepare({ graph: {} as IntentGraph, step: {} as IntentStep, action: action("raydium", inputAsset, outputAsset), now: NOW });
    assert.equal(payload.input.symbol, "USDC"); assert.equal(payload.minimumOutput.symbol, "USDT"); assert.equal(payload.transactions.length, 1);
  });
});

async function verificationFixture(dex: SolanaDex): Promise<{ step: IntentStep; landed: LandedFixture; signature: string }> {
  const bundle = bundles[dex];
  const signature = randomSolanaSignature();
  const input = assetAmount(resolved("SOL"), IN.toString()); const output = assetAmount(resolved("USDC"), MIN.toString());
  const instructions = [...bundle.computeBudgetInstructions, ...bundle.setupInstructions, bundle.swapInstruction, ...(bundle.cleanupInstruction ? [bundle.cleanupInstruction] : [])]
    .map((ix) => ({ program: ix.programId, accounts: ix.accounts.map((account) => account.pubkey), data: Uint8Array.from(Buffer.from(ix.data, "base64")) }));
  const step: IntentStep = { id: "dex-swap", index: 0, kind: "swap", title: "DEX swap", protocol: dex, network: "solana", chain: CHAINS.solana.id,
    account: action(dex).account.id, mode: "wallet", dependsOn: [], status: "submitted", input, minimumOutput: output, evidence: [],
    quoteRef: encodeStepRef({ v: 1, slippageBps: 50, floors: [{ at: NOW / 1000, min: MIN.toString() }] }),
    prepared: { quoteBinding: "ab".repeat(32), preparedAt: new Date(NOW).toISOString(), expiresAt: NOW / 1000 + 90,
      transactions: [{ vm: "svm", network: "solana", feePayer: OWNER, to: SOLANA_PROGRAM_IDS.jupiterV6, description: "DEX swap" }] } };
  const landed: LandedFixture = { signature, feePayer: OWNER, blockTime: NOW / 1000 + 15, instructions,
    tokenBalances: [{ account: await ata(OWNER, USDC), owner: OWNER, mint: USDC, pre: 0n, post: OUT }],
    lamports: new Map([[OWNER, -IN - 5_000n]]), fee: 5_000 };
  return { step, landed, signature };
}

describe("direct DEX verification requires on-chain economic and venue evidence", () => {
  async function installReceipt(dex: SolanaDex, change: (fixture: LandedFixture) => LandedFixture = (value) => value, cpi = true) {
    const fixture = await verificationFixture(dex); mock.landed.set(fixture.signature, change(fixture.landed));
    // Base fixture harness returns no inner instructions; inject the real indexed CPI for these receipts.
    const rpcFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const response = await rpcFetch(input, init);
      if (typeof init?.body !== "string" || (JSON.parse(init.body) as { method?: string }).method !== "getTransaction") return response;
      const value = await response.json() as { result?: { meta?: Record<string, unknown> } };
      if (value.result?.meta) value.result.meta.innerInstructions = cpi ? [{ index: 3, instructions: [{ programId: dex === "raydium" ? CLMM : WHIRLPOOL,
        accounts: [dex === "raydium" ? POOL : ORCA_POOL], data: "" }] }] : [];
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { ...fixture, verify: () => (dex === "raydium" ? raydiumAdapter : orcaAdapter).verify({ step: fixture.step, references: [fixture.signature], submittedAt: NOW, now: NOW + 20_000 }) };
  }
  for (const dex of ["raydium", "orca"] as const) {
    it(`confirms ${dex} only after exact input and guaranteed wallet output`, async () => {
      const fixture = await installReceipt(dex); const result = await fixture.verify();
      assert.equal(result.status, "confirmed"); if (result.status === "confirmed") assert.equal(result.actualOutput?.amount, OUT.toString());
    });
  }
  it("rejects a foreign fee payer and stale transaction", async () => {
    const foreign = await installReceipt("raydium", (value) => ({ ...value, feePayer: ATTACKER }));
    assert.equal((await foreign.verify()).status, "failed");
    const stale = await installReceipt("raydium", (value) => ({ ...value, blockTime: NOW / 1000 - 400 }));
    const result = await stale.verify(); assert.ok(result.status === "failed"); assert.equal(result.failure.code, "REFERENCE_STALE");
  });
  it("rejects an inert route, insufficient output and excessive native input", async () => {
    const inert = await installReceipt("raydium", undefined, false); const noCpi = await inert.verify();
    assert.ok(noCpi.status === "failed"); assert.equal(noCpi.failure.code, "OUTCOME_NOT_PROVEN");
    const low = await installReceipt("raydium", (value) => ({ ...value, tokenBalances: value.tokenBalances?.map((balance) => ({ ...balance, post: MIN - 1n })) }));
    assert.equal((await low.verify()).status, "failed");
    const extra = await installReceipt("raydium", (value) => ({ ...value, lamports: new Map([[OWNER, -IN * 2n - 5_000n]]) }));
    assert.equal((await extra.verify()).status, "failed");
  });
  it("rejects an unrelated swap with a matching program and wallet balance changes", async () => {
    const fixture = await installReceipt("raydium", (value) => ({ ...value, instructions: value.instructions.map((ix) =>
      ix.program === SOLANA_PROGRAM_IDS.jupiterV6 ? { ...ix, data: routeData(26, IN / 2n) } : ix) }));
    const result = await fixture.verify(); assert.ok(result.status === "failed"); assert.equal(result.failure.code, "REFERENCE_MISMATCH");
  });
  it("rejects zero native debit even when a dust-sized input is below token-account rent", async () => {
    const dust = 1_000_000n;
    const fixture = await installReceipt("raydium", (value) => ({ ...value, lamports: new Map([[OWNER, -5_000n]]),
      instructions: value.instructions.map((ix) => {
        if (ix.program === SOLANA_PROGRAM_IDS.jupiterV6) return { ...ix, data: routeData(26, dust) };
        if (ix.program === SYSTEM) { const data = Uint8Array.from(ix.data); new DataView(data.buffer).setBigUint64(4, dust, true); return { ...ix, data }; }
        return ix;
      }) }));
    (fixture.step as { input: IntentStep["input"] }).input = assetAmount(resolved("SOL"), dust.toString());
    const result = await fixture.verify(); assert.ok(result.status === "failed"); assert.equal(result.failure.code, "OUTCOME_NOT_PROVEN");
  });
  it("accounts for existing wrapped SOL and rent refunds without weakening exact native spend", async () => {
    const wsol = await ata(OWNER, WSOL); const rent = 2_039_280n; const oldWrapped = 50_000_000n;
    const fixture = await installReceipt("raydium", (value) => ({ ...value,
      lamports: new Map([[OWNER, -IN + rent + oldWrapped - 5_000n], [wsol, -rent - oldWrapped]]),
      tokenBalances: [...value.tokenBalances ?? [], { owner: OWNER, mint: WSOL, account: wsol, pre: oldWrapped, post: 0n }] }));
    const result = await fixture.verify(); assert.equal(result.status, "confirmed");
    if (result.status === "confirmed") assert.equal(result.actualOutput?.amount, OUT.toString());
  });
  it("excludes reclaimed rent and existing wrapped SOL from native output used by later steps", async () => {
    const usdc = await ata(OWNER, USDC); const wsol = await ata(OWNER, WSOL);
    const out = 100_000_000n; const min = out * 9950n / 10_000n; const rent = 2_039_280n; const oldWrapped = 50_000_000n;
    const fixture = await installReceipt("raydium", (value) => ({ ...value,
      instructions: [value.instructions[0]!, { program: SOLANA_PROGRAM_IDS.jupiterV6,
        accounts: [TOKEN_PROGRAM, OWNER, usdc, wsol, SOLANA_PROGRAM_IDS.jupiterV6, WSOL, SOLANA_PROGRAM_IDS.jupiterV6, ATTACKER,
          SOLANA_PROGRAM_IDS.jupiterV6, CLMM, OWNER, ATTACKER, POOL, usdc, wsol, VAULT_B, VAULT_A, OBSERVATION, TOKEN_PROGRAM], data: routeData(26, IN, out) },
      { program: TOKEN_PROGRAM, accounts: [wsol, OWNER, OWNER], data: Uint8Array.from([9]) }],
      lamports: new Map([[OWNER, out + rent + oldWrapped - 5_000n], [wsol, -rent - oldWrapped]]),
      tokenBalances: [{ owner: OWNER, mint: USDC, account: usdc, pre: IN, post: 0n },
        { owner: OWNER, mint: WSOL, account: wsol, pre: oldWrapped, post: 0n }] }));
    const mutable = fixture.step as { input: IntentStep["input"]; minimumOutput: IntentStep["minimumOutput"]; quoteRef: string };
    mutable.input = assetAmount(resolved("USDC"), IN.toString()); mutable.minimumOutput = assetAmount(resolved("SOL"), min.toString());
    mutable.quoteRef = encodeStepRef({ v: 1, slippageBps: 50, floors: [{ at: NOW / 1000, min: min.toString() }] });
    // This receipt's route moved from instruction index 3 to index 1.
    const rpcFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const response = await rpcFetch(input, init);
      if (typeof init?.body !== "string" || (JSON.parse(init.body) as { method?: string }).method !== "getTransaction") return response;
      const value = await response.json() as { result: { meta: { innerInstructions: { index: number }[] } } };
      for (const group of value.result.meta.innerInstructions) group.index = 1;
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await fixture.verify(); assert.ok(result.status === "confirmed"); assert.equal(result.actualOutput?.amount, out.toString());
  });
});
