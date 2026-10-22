/**
 * Named Solana DEX venues (Raydium, Orca, Meteora) through the Jupiter
 * program: the Codex suite (T1) adapted to registry labels, the verified pool
 * layouts of Raydium AMM v4, Meteora DLMM and DAMM v2 (evidence pool bytes
 * read on 2026-10-14), owner / split / CPI refusals, explicitOnly with a spy,
 * and verification with wallet additions (review 5.2, T4).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { address, getAddressEncoder } from "@solana/kit";
import { CHAINS, findAssetBySymbol, parseAccountId, venueByLabel, type IntentGraph, type IntentStep } from "@kletia/core";
import { parseSolanaDexQuote, parseSolanaDexInstructions, type SolanaDex } from "../../../networks/solana/dexSwap.js";
import { PlatformError } from "../../errors.js";
import { configureAdapters } from "../adapters/registry.js";
import { meteoraAdapter, orcaAdapter, raydiumAdapter } from "../adapters/solanaDex.js";
import { DAMM_V2_POOL_AUTHORITY, decodeDexPool, decodeDexRouteData, dexLabels, POOL_LAYOUTS, RAYDIUM_AMM_AUTHORITY,
  unverifiedDexLabels } from "../adapters/solanaDexClient.js";
import type { AdapterAction, ProtocolAdapter } from "../adapters/types.js";
import { assetAmount, type ResolvedAsset } from "../assets.js";
import { decodeSolanaTransaction, simulateSolanaTransactionDetailed, SOLANA_PROGRAM_IDS } from "../chains/solana.js";
import { LIGHTHOUSE_PROGRAM } from "../contracts/solanaActions.js";
import { planIntent } from "../planner.js";
import { encodeStepRef } from "../stepRef.js";
import { ACCOUNTS, randomSolanaSignature, resetEngine, STUB_ADAPTERS, stubJupiter } from "./helpers.js";
import { ata, ATTACKER, installSolanaLendMock, lookupTableData, OWNER, SYSTEM, TOKEN_PROGRAM, USDC, WSOL,
  type LandedFixture, type LandedInstruction, type SolanaLendMock } from "./solanaLendFixtures.js";

const CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const CP = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const DAMM_V2 = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const POOL = "CYbD9RaToYMtWKA7QZyoLahnHdWq553Vm62Lh6qWtuxq";
const ORCA_POOL = "83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d";
// Evidence pools (SOL / USDC) and the accounts Jupiter's swap-instructions listed for them on 2026-10-14.
const AMM_POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const AMM_VAULT_A = "DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz";
const AMM_VAULT_B = "HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz";
const DLMM_POOL = "HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR";
const DLMM_RESERVE_X = "H7j5NPopj3tQvDg4N8CxwtYciTn3e8AEV6wSVrxpyDUc";
const DLMM_RESERVE_Y = "HbYjRzx7teCxqW3unpXBEcNHhfVZvW2vW9MQ99TkizWt";
const DLMM_ORACLE = "EgEYXef2FCoEYLHJJW74dMbom1atLXo6KwPuA6mSATYA";
const DLMM_BITMAP = "9HcJeBEsq5px2bYZbdo7vzQWVsPK3SHTkchy42hBn7HC";
const DLMM_EVENTS = "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6";
const DAMM_POOL = "8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie";
const DAMM_VAULT_A = "sx8hCMCauCdbZ7sVBGSJmH7b7JmtuN8d8YwYmBpuPLH";
const DAMM_VAULT_B = "8S8HjmPZr8tNNEmMj5pcqS5RN73uF6DmcUDEDaoUQ1Ei";
const DAMM_EVENTS = "3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet";
const JUPITER_EVENTS = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
/** ATTACKER of the shared fixtures is the Raydium AMM authority itself; AMM v4 cases use this one. */
const EVIL = "5xSPBiD3TibamAnwHDhZABdB4z4F9dcj5PnbteroBTTd";
const ALT = "BDqppwFYeMpUicN9xbfoM7FgRnHVW1uTUtrGA7uG2vQg";
const VAULT_A = "GviiXg2Xc1xCpyNY36r7h1EAy7uvse5UMkiiyHjRDU6Z";
const VAULT_B = "3bWPj5eepJm8CxUzk5MMFMN2CFJkntxKvbmy4zwwtpJd";
const OBSERVATION = "AA5RaVvyGyZgtmAsJJHT5ZVBxVPtAXuYaMwfgeFJW4Mk";
const IN = 10_000_000n;
const OUT = 1_097_536n;
const MIN = OUT * 9950n / 10_000n;
const NOW = 1_790_000_000_000;

/** Pool account data read from Solana mainnet on 2026-10-14 (getAccountInfo, base64). */
const EVIDENCE_POOLS = {
  AMM_V4: "BgAAAAAAAAD+AAAAAAAAAAcAAAAAAAAAAwAAAAAAAAAJAAAAAAAAAAYAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAEBCDwAAAAAA9AEAAAAAAAAAAAAAAAAAAEBCDwAAAAAAQEIPAAAAAAABAAAAAAAAAADKmjsAAAAAAMqaOwAAAAAFAAAAAAAAABAnAAAAAAAAGQAAAAAAAAAQJwAAAAAAAAwAAAAAAAAAZAAAAAAAAAAZAAAAAAAAABAnAAAAAAAAwAH/AgAAAAB6rE8AAAAAAE64FyutAwAALkI4/Jo0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACzqVos/TzgAAAAAAAAAAABzVLPxIFgFAAAAAAAAAAAAMWNjiHMDAACZN03ShGQFAAAAAAAAAAAAQEusDaXyOAAAAAAAAAAAAEiYZsIJJAAAuHDhLdN5iRVh0un6jyZDGDTrc28vJPwqKk3/H9XcpN/yy7m3YO3bGFcGMDBjrTPXtXKW6gLU4DNeMc6vpMxC3QabiFf+q4GE+2h/Y0YYwDXaxDncGus7VZig8AAAAAABxvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWFsT5PYWOiP+v6gjENnRJfo5qkywMgxSCYqGuPMx4KexvkvOQ/5YJ6K1De7jkwfGqQ6wF0kMIzKd96FEsVQkpLTasTDzvqfGb9UyNwPXk0c7uUyfSZIKynSsTy6pDRHIY0NB1GoKC2mEwX+KZw3uZjlhHHbETUDcxD4vhBFpgr27qvkPHweIeqm+XyL01XiG9EnlnR1bByOEGxucSuhFtlwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOW2K2XLO72m9WiI5m/ujmTcVWAZnA+IsR/ic70Fnoqh/uGSXI1YAABO2XAAAAAAACEEAAAAAAAAAAAAAAAAAAA=",
  DLMM: "IQsxYrVlsQ0QJwoAeACIE4CEHgCghgEAIFb5/+CpBgDoAwAAAAAAALuPAACLGgAApqf//wAAAABG7M9qAAAAAAAAAAAAAAAA/wEAAKOn//8BAAAAAAAAAAabiFf+q4GE+2h/Y0YYwDXaxDncGus7VZig8AAAAAABxvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWHvdAzm3U+U81sNMxib4appdIf/Hv9uXru6Jao2fQRZQfaUnglWidunp7nPr8UyxbCEpX1b2OC52cKyjqNDjGUhOFXnAgAAAABCgi4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAyzTlOBCksmu1TXkKCOxNx5VB/uYxY9vqPBg6ZHhBq+8AAAAAAAAAAAAAAAAAAAAAht////////////////////f///////8fAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHCSBWoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  DAMM_V2: "8ZptBBGxbbyAGgYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAHG+nrzvtutOj1l82qryXQxsbvkwtL24OR8pgIDRS9dYQ0NYQ5zgJFx/RmeIBqqgFav/PIludVxa5ECTKSrnPRGbnGR5t6lLn6PfGI9fA07q7s9iJzvjroOSTOA6HiedWMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALZ7npfR4pEtbMjH/6CGPST/8oRfhdNq1GLRQUghFYggkD6gi2ynTG0KvSgeRgYAAAAAAAAAAAAAAAAAAAAAAABh+iUUAAAAACfYVgIAAAAAAAAAAAAAAAAAAAAAAAAAAEtS6W8fMrtDAAAAAAAAAAAqGi6JGarPqQAAAAAAAAAAegP4JwlEnlIAAAAAAAAAAMf1mmgAAAAAAQAAAAAAAABF5dmaOmXdJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPymljfzf5QEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAW+RRDEMMV2xAVJdPAAAAAEwWJ5m+AQAAAAAAAAAAAAA5HGSZQQAAAAAAAAAAAAAAVZgLVmwAAACcX4fgDwAAAAAAAAAAAAAAAAAAAAAAAAD9AAAAAAAAAAAAAAAAAAAAtnuel9HikS1syMf/oIY9JP/yhF+F02rUYtFBSCEViCBVsA1j+wkAALDbTWZdAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
} as const;

type ApiInstruction = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
type Bundle = { computeBudgetInstructions: ApiInstruction[]; setupInstructions: ApiInstruction[]; swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null; otherInstructions: ApiInstruction[]; tokenLedgerInstruction: null; addressLookupTableAddresses: string[] };

const ADAPTER: Readonly<Record<SolanaDex, ProtocolAdapter>> = { raydium: raydiumAdapter, orca: orcaAdapter, meteora: meteoraAdapter };
const LABEL_OF_KIND: Readonly<Record<number, string>> = { 17: "Whirlpool", 47: "Whirlpool", 26: "Raydium CLMM", 40: "Raydium CLMM", 46: "Raydium CP",
  105: "Raydium", 38: "Meteora DLMM", 108: "Meteora DAMM v2" };
const POOL_OF_KIND: Readonly<Record<number, string>> = { 17: ORCA_POOL, 47: ORCA_POOL, 26: POOL, 40: POOL, 46: POOL, 105: AMM_POOL, 38: DLMM_POOL, 108: DAMM_POOL };
const POOL_OF_PROGRAM: Readonly<Record<string, string>> = { [CLMM]: POOL, [CP]: POOL, [WHIRLPOOL]: ORCA_POOL, [AMM_V4]: AMM_POOL, [DLMM]: DLMM_POOL, [DAMM_V2]: DAMM_POOL };

function resolved(symbol: string): ResolvedAsset {
  const asset = findAssetBySymbol("solana", symbol);
  assert.ok(asset);
  return { ...asset, isNative: asset.address === null, verified: true, canonical: true };
}

function action(input = resolved("SOL"), output = resolved("USDC")): AdapterAction {
  const account = parseAccountId(`${CHAINS.solana.id}:${OWNER}`);
  assert.ok(account);
  return { kind: "swap", network: "solana", destinationNetwork: "solana", input, output, amount: IN.toString(),
    account, recipient: account, slippageBps: 50 };
}

function quoteFixture(kind: number): Record<string, unknown> {
  return { inputMint: WSOL, outputMint: USDC, inAmount: IN.toString(), outAmount: OUT.toString(),
    otherAmountThreshold: (MIN + 1n).toString(), swapMode: "ExactIn", slippageBps: 50, platformFee: null,
    priceImpactPct: "0.00021", instructionVersion: "V1", transactionVersion: 0,
    routePlan: [{ percent: 100, bps: null, swapInfo: { ammKey: POOL_OF_KIND[kind], label: LABEL_OF_KIND[kind], inputMint: WSOL, outputMint: USDC,
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

/** The venue's CPI account list after Jupiter's nine route accounts, SOL -> USDC (pool mint A is SOL). */
function venueAccounts(kind: number, input: string, output: string): string[] {
  switch (kind) {
    case 17: return [WHIRLPOOL, TOKEN_PROGRAM, OWNER, ORCA_POOL, input, VAULT_A, output, VAULT_B];
    case 47: return [WHIRLPOOL, TOKEN_PROGRAM, TOKEN_PROGRAM, SOLANA_PROGRAM_IDS.memo, OWNER, ORCA_POOL, WSOL, USDC, input, VAULT_A, output, VAULT_B];
    case 26: return [CLMM, OWNER, ATTACKER, POOL, input, output, VAULT_A, VAULT_B, OBSERVATION, TOKEN_PROGRAM];
    case 40: return [CLMM, OWNER, ATTACKER, POOL, input, output, VAULT_A, VAULT_B, OBSERVATION, TOKEN_PROGRAM, SOLANA_PROGRAM_IDS.token2022, SOLANA_PROGRAM_IDS.memo, WSOL, USDC];
    case 46: return [CP, OWNER, ATTACKER, ATTACKER, POOL, input, output, VAULT_A, VAULT_B, TOKEN_PROGRAM, TOKEN_PROGRAM, WSOL, USDC, OBSERVATION];
    case 105: return [AMM_V4, TOKEN_PROGRAM, AMM_POOL, RAYDIUM_AMM_AUTHORITY, AMM_VAULT_A, AMM_VAULT_B, input, output, OWNER];
    case 38: return [DLMM, DLMM_POOL, DLMM_BITMAP, DLMM_RESERVE_X, DLMM_RESERVE_Y, input, output, WSOL, USDC, DLMM_ORACLE, DLMM, OWNER,
      TOKEN_PROGRAM, TOKEN_PROGRAM, DLMM_EVENTS, DLMM, EVIL];
    case 108: return [DAMM_V2, DAMM_V2_POOL_AUTHORITY, DAMM_POOL, input, output, DAMM_VAULT_A, DAMM_VAULT_B, WSOL, USDC, OWNER,
      TOKEN_PROGRAM, TOKEN_PROGRAM, DAMM_V2, DAMM_EVENTS, DAMM_V2];
    default: throw new Error(`no fixture for kind ${kind}`);
  }
}

async function bundleFixture(kind: number): Promise<Bundle> {
  const input = await ata(OWNER, WSOL);
  const output = await ata(OWNER, USDC);
  const swapKeys = [TOKEN_PROGRAM, OWNER, input, output, SOLANA_PROGRAM_IDS.jupiterV6, USDC,
    SOLANA_PROGRAM_IDS.jupiterV6, JUPITER_EVENTS, SOLANA_PROGRAM_IDS.jupiterV6, ...venueAccounts(kind, input, output)];
  const transfer = new Uint8Array(12);
  const transferView = new DataView(transfer.buffer);
  transferView.setUint32(0, 2, true);
  transferView.setBigUint64(4, IN, true);
  return { tokenLedgerInstruction: null, computeBudgetInstructions: [apiInstruction(SOLANA_PROGRAM_IDS.computeBudget, [], Uint8Array.from([2, 0xc0, 0x5c, 0x15, 0]))],
    setupInstructions: [apiInstruction(SYSTEM, [OWNER, input], transfer, [0], [0, 1]),
      apiInstruction(TOKEN_PROGRAM, [input], Uint8Array.from([17]), [], [0])],
    swapInstruction: apiInstruction(SOLANA_PROGRAM_IDS.jupiterV6, swapKeys, routeData(kind), [1], [2, 3]),
    cleanupInstruction: apiInstruction(TOKEN_PROGRAM, [input, OWNER, OWNER], Uint8Array.from([9]), [2], [0, 1]),
    otherInstructions: [], addressLookupTableAddresses: [] };
}

const addressEncoder = getAddressEncoder();
/** Synthetic CLMM / CP / Whirlpool pool state (Codex fixtures). */
function poolFixture(label: "Raydium CLMM" | "Raydium CP" | "Whirlpool") {
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

function evidencePool(name: keyof typeof EVIDENCE_POOLS) {
  return { owner: name === "AMM_V4" ? AMM_V4 : name === "DLMM" ? DLMM : DAMM_V2, data: Uint8Array.from(Buffer.from(EVIDENCE_POOLS[name], "base64")) };
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

function dexOfLabels(text: string | null | undefined): SolanaDex {
  return text?.includes("Raydium") ? "raydium" : text?.includes("Meteora") ? "meteora" : "orca";
}

/** Switches a venue to another route-plan variant (quote label, pool and instruction bundle). */
async function useKind(dex: SolanaDex, kind: number): Promise<void> {
  quotes[dex] = quoteFixture(kind);
  bundles[dex] = await bundleFixture(kind);
}

beforeEach(async () => {
  mock = installSolanaLendMock();
  mock.accounts.set(POOL, poolFixture("Raydium CLMM"));
  mock.accounts.set(ORCA_POOL, poolFixture("Whirlpool"));
  mock.accounts.set(AMM_POOL, evidencePool("AMM_V4"));
  mock.accounts.set(DLMM_POOL, evidencePool("DLMM"));
  mock.accounts.set(DAMM_POOL, evidencePool("DAMM_V2"));
  mock.accounts.set(WSOL, mintFixture(9)); mock.accounts.set(USDC, mintFixture(6));
  quotes = { raydium: quoteFixture(26), orca: quoteFixture(17), meteora: quoteFixture(38) };
  bundles = { raydium: await bundleFixture(26), orca: await bundleFixture(17), meteora: await bundleFixture(38) };
  providerStatus = 200; simulationUnavailable = false; proveCpi = true; detailedLoadedKeys = false; requests.length = 0; providerPosts = [];
  const rpcFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/swap/v1/quote") {
      requests.push(url);
      return json(quotes[dexOfLabels(url.searchParams.get("dexes"))], providerStatus);
    }
    if (url.pathname === "/swap/v1/swap-instructions") {
      providerPosts.push(body);
      const quote = body.quoteResponse as { routePlan: { swapInfo: { label: string } }[] };
      return json(bundles[dexOfLabels(quote.routePlan[0]?.swapInfo.label)], providerStatus);
    }
    if (body.method === "simulateTransaction") {
      if (simulationUnavailable) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "RPC unavailable" } });
      const params = body.params as [string, Record<string, unknown>];
      if (params[1].innerInstructions === true) {
        const decoded = await decodeSolanaTransaction("solana", params[0]);
        const index = decoded.instructions.findIndex((ix) => ix.program === SOLANA_PROGRAM_IDS.jupiterV6);
        const program = decoded.instructions[index]?.accounts[9] as string;
        const pool = POOL_OF_PROGRAM[program] as string;
        return json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 100 }, value: { err: mock.simulationError,
          logs: [], unitsConsumed: 100_000, loadedAddresses: detailedLoadedKeys ? { writable: [pool], readonly: [] } : {},
          innerInstructions: proveCpi ? [{ index, instructions: [{ programId: program, accounts: [pool], data: "" }] }] : [] } } });
      }
    }
    if (body.method === "getMultipleAccounts") {
      // The transaction builder reads lookup tables jsonParsed.
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

function prepare(adapter: ProtocolAdapter) {
  return adapter.prepare({ graph: {} as IntentGraph, step: { quoteRef: encodeStepRef({ v: 1, slippageBps: 50 }) } as IntentStep, action: action(), now: NOW });
}

async function rejectsWithCode(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PlatformError, String(error));
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

describe("labels and pool layouts come from the registry and the evidence pools", () => {
  it("quotes every registry label of a venue that has a verified layout, and refuses none", () => {
    assert.deepEqual(dexLabels("raydium"), ["Raydium", "Raydium CLMM", "Raydium CP"]);
    assert.deepEqual(dexLabels("orca"), ["Whirlpool"]);
    assert.deepEqual(dexLabels("meteora"), ["Meteora DLMM", "Meteora DAMM v2"]);
    for (const dex of ["raydium", "orca", "meteora"] as const) assert.deepEqual(unverifiedDexLabels(dex), [], dex);
    for (const label of Object.keys(POOL_LAYOUTS)) assert.ok(venueByLabel(label), label);
  });
  it("decodes Raydium AMM v4, Meteora DLMM and DAMM v2 evidence pools byte for byte", () => {
    const amm = decodeDexPool("raydium", "Raydium", AMM_POOL, evidencePool("AMM_V4"));
    assert.deepEqual([amm.program, amm.mintA, amm.mintB, amm.vaultA, amm.vaultB], [AMM_V4, WSOL, USDC, AMM_VAULT_A, AMM_VAULT_B]);
    const dlmm = decodeDexPool("meteora", "Meteora DLMM", DLMM_POOL, evidencePool("DLMM"));
    assert.deepEqual([dlmm.program, dlmm.mintA, dlmm.mintB, dlmm.vaultA, dlmm.vaultB, dlmm.observation], [DLMM, WSOL, USDC, DLMM_RESERVE_X, DLMM_RESERVE_Y, DLMM_ORACLE]);
    const damm = decodeDexPool("meteora", "Meteora DAMM v2", DAMM_POOL, evidencePool("DAMM_V2"));
    assert.deepEqual([damm.program, damm.mintA, damm.mintB, damm.vaultA, damm.vaultB], [DAMM_V2, WSOL, USDC, DAMM_VAULT_A, DAMM_VAULT_B]);
  });
  it("refuses a pool owned by another label's program, the wrong venue's label, or a resized AMM v4 account", () => {
    assert.throws(() => decodeDexPool("raydium", "Raydium CLMM", POOL, poolFixture("Raydium CP")), /pinned DEX program/u);
    assert.throws(() => decodeDexPool("meteora", "Meteora DLMM", DAMM_POOL, evidencePool("DAMM_V2")), /pinned DEX program/u);
    assert.throws(() => decodeDexPool("raydium", "Whirlpool", ORCA_POOL, poolFixture("Whirlpool")), /unsupported venue layout/u);
    const amm = evidencePool("AMM_V4");
    assert.throws(() => decodeDexPool("raydium", "Raydium", AMM_POOL, { ...amm, data: Uint8Array.from([...amm.data, 0]) }), /unreadable layout/u);
    const dlmm = evidencePool("DLMM"); dlmm.data[0] ^= 1;
    assert.throws(() => decodeDexPool("meteora", "Meteora DLMM", DLMM_POOL, dlmm), /unreadable layout/u);
  });
});

describe("venue-pinned direct Solana quotes", () => {
  for (const dex of ["raydium", "orca", "meteora"] as const) {
    it(`plans ${dex} with a single direct pool and an integer on-chain floor`, async () => {
      const planned = await ADAPTER[dex].plan(action());
      assert.equal(planned.protocol, dex); assert.equal(planned.minimumOutput.amount, MIN.toString());
      assert.equal(planned.transactionCount, 1); assert.equal(planned.floor, "onchain");
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.searchParams.get("onlyDirectRoutes"), "true");
      assert.equal(requests[0]?.searchParams.get("instructionVersion"), "V1");
      assert.equal(requests[0]?.searchParams.get("dexes"), dexLabels(dex).join(","));
    });
  }
  it("is explicitOnly: a plain swap 1 SOL to USDC makes exactly one Jupiter call and never quotes a named pool", async () => {
    let jupiterPlans = 0;
    const jupiter: ProtocolAdapter = { ...stubJupiter, plan: async (value) => { jupiterPlans += 1; return stubJupiter.plan(value); } };
    resetEngine();
    configureAdapters([jupiter, raydiumAdapter, orcaAdapter, meteoraAdapter, ...STUB_ADAPTERS.filter((entry) => entry.id !== "jupiter")]);
    try {
      const graph = await planIntent({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS });
      assert.deepEqual(graph.steps.map((step) => step.protocol), ["jupiter"]);
      assert.equal(jupiterPlans, 1);
      assert.equal(requests.length, 0, "no named-pool quote");
      assert.ok(raydiumAdapter.explicitOnly && orcaAdapter.explicitOnly && meteoraAdapter.explicitOnly);
    } finally {
      resetEngine();
    }
  });
  it("rejects mismatched, split, multi-hop, foreign-label, fee-bearing, exact-out and under-protected quotes", () => {
    const request = { inputMint: WSOL, outputMint: USDC, amount: IN.toString(), slippageBps: 50 };
    const labels = dexLabels("raydium");
    const leg = (quotes.raydium.routePlan as { swapInfo: Record<string, unknown> }[])[0]?.swapInfo;
    const bad: Record<string, unknown>[] = [
      { inAmount: "1" }, { outputMint: WSOL }, { slippageBps: 300 }, { swapMode: "ExactOut" }, { instructionVersion: "V2" },
      { transactionVersion: 1 }, { platformFee: { amount: "1", feeBps: 1 } }, { otherAmountThreshold: "1" }, { priceImpactPct: "NaN" },
      { routePlan: [] }, { routePlan: [...quotes.raydium.routePlan as unknown[], ...quotes.raydium.routePlan as unknown[]] },
      { routePlan: [{ percent: 60, swapInfo: leg }, { percent: 40, swapInfo: leg }] },
      { routePlan: [{ percent: 99, swapInfo: leg }] },
      { routePlan: [{ percent: 100, swapInfo: { ...leg, label: "Whirlpool" } }] },
      { routePlan: [{ percent: 100, swapInfo: { ...leg, label: "Meteora DLMM" } }] },
    ];
    for (const change of bad) {
      assert.throws(() => parseSolanaDexQuote({ ...quotes.raydium, ...change }, "raydium", labels, request), (error: unknown) =>
        (error as { code?: string }).code === "DEX_QUOTE_MISMATCH", JSON.stringify(change).slice(0, 80));
    }
    const overflow = structuredClone(quotes.raydium);
    const tooLarge = (1n << 64n).toString();
    overflow.outAmount = tooLarge;
    overflow.otherAmountThreshold = ((1n << 64n) * 9950n / 10_000n).toString();
    (overflow.routePlan as { swapInfo: Record<string, unknown> }[])[0]!.swapInfo.outAmount = tooLarge;
    assert.throws(() => parseSolanaDexQuote(overflow, "raydium", labels, request), /u64/iu);
  });
  it("fails closed on provider unavailability, pool spoofing, mint decimal drift and Token-2022", async () => {
    providerStatus = 503; await assert.rejects(() => raydiumAdapter.plan(action()), /HTTP 503/iu); providerStatus = 200;
    mock.accounts.set(POOL, { ...poolFixture("Raydium CLMM"), owner: ATTACKER }); await assert.rejects(() => raydiumAdapter.plan(action()), /pinned DEX/iu);
    mock.accounts.set(POOL, poolFixture("Raydium CP")); await assert.rejects(() => raydiumAdapter.plan(action()), /pinned DEX/iu, "CP-owned pool quoted as CLMM");
    mock.accounts.set(POOL, poolFixture("Raydium CLMM")); mock.accounts.set(USDC, mintFixture(9)); await assert.rejects(() => raydiumAdapter.plan(action()), /decimals/iu);
    mock.accounts.set(USDC, { ...mintFixture(6), owner: SOLANA_PROGRAM_IDS.token2022 }); await assert.rejects(() => raydiumAdapter.plan(action()), /Token-2022/iu);
  });
  it("refuses an evidence pool whose mints are not the swap assets", async () => {
    const dlmm = evidencePool("DLMM");
    dlmm.data.set(addressEncoder.encode(address(ATTACKER)), 120);
    mock.accounts.set(DLMM_POOL, dlmm);
    await rejectsWithCode(meteoraAdapter.plan(action()), "VENUE_UNVERIFIED", /mints do not match/u);
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
  for (const dex of ["raydium", "orca", "meteora"] as const) {
    it(`prepares and independently simulates one unsigned ${dex} swap`, async () => {
      const payload = await prepare(ADAPTER[dex]);
      assert.equal(payload.transactions.length, 1); assert.equal(payload.records[0]?.to, SOLANA_PROGRAM_IDS.jupiterV6);
      const transaction = payload.transactions[0]; assert.ok(transaction?.vm === "svm");
      const decoded = await decodeSolanaTransaction("solana", transaction.transaction);
      assert.equal(decoded.feePayer, OWNER); assert.deepEqual(decoded.signers, [OWNER]);
      assert.equal(payload.minimumOutput.amount, MIN.toString());
      assert.equal(providerPosts[0]?.useSharedAccounts, false); assert.equal(providerPosts[0]?.dynamicSlippage, false);
      assert.deepEqual(mock.unknown, []);
    });
  }
  for (const [dex, kind] of [["raydium", 105], ["meteora", 108], ["raydium", 40], ["raydium", 46], ["orca", 47]] as const) {
    it(`prepares route-plan variant ${kind} (${LABEL_OF_KIND[kind]})`, async () => {
      await useKind(dex, kind);
      if (kind === 46) mock.accounts.set(POOL, poolFixture("Raydium CP"));
      const payload = await prepare(ADAPTER[dex]);
      assert.equal(payload.transactions.length, 1);
      assert.match(payload.warnings[0] ?? "", new RegExp(`Single direct ${LABEL_OF_KIND[kind]} pool`, "u"));
    });
  }
  it("rejects changed signers, fee destinations, assets, pool, input and slippage", async () => {
    const baseline = await bundleFixture(26);
    for (const position of [0, 1, 2, 3, 4, 5, 6, 9, 12]) {
      bundles.raydium = structuredClone(baseline); bundles.raydium.swapInstruction.accounts[position]!.pubkey = ATTACKER;
      await assert.rejects(() => prepare(raydiumAdapter), /DEX transaction|another pool/iu);
    }
    bundles.raydium = structuredClone(baseline); bundles.raydium.swapInstruction.accounts[11]!.isSigner = true;
    await assert.rejects(() => prepare(raydiumAdapter), /another signer/iu);
    for (const data of [routeData(26, 1n), routeData(26, IN, OUT, 300), routeData(17), routeData(38), routeData(26, IN, 1n), Uint8Array.from([...routeData(), 0])]) {
      bundles.raydium = structuredClone(baseline); bundles.raydium.swapInstruction.data = Buffer.from(data).toString("base64");
      await assert.rejects(() => prepare(raydiumAdapter), /DEX transaction/iu);
    }
  });
  it("pins every AMM v4, DLMM and DAMM v2 account Jupiter passes to the pool program", async () => {
    // Positions in the route instruction: venue accounts start at 9 (the program).
    const cases: readonly [SolanaDex, number, readonly number[]][] = [
      ["raydium", 105, [9, 10, 11, 12, 13, 14, 15, 16, 17]],
      ["meteora", 38, [9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]],
      ["meteora", 108, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]],
    ];
    for (const [dex, kind, positions] of cases) {
      await useKind(dex, kind);
      const baseline = structuredClone(bundles[dex]);
      for (const position of positions) {
        bundles[dex] = structuredClone(baseline); bundles[dex].swapInstruction.accounts[position]!.pubkey = EVIL;
        await assert.rejects(() => prepare(ADAPTER[dex]), /DEX transaction|another pool/iu, `${kind}@${position}`);
      }
      // Unpinned accounts the pool program checks itself (DLMM bitmap extension) still prepare.
      if (kind === 38) {
        bundles[dex] = structuredClone(baseline); bundles[dex].swapInstruction.accounts[11]!.pubkey = DLMM;
        await prepare(ADAPTER[dex]);
      }
    }
  });
  it("keeps the AMM v4 coin and pc vault order of the pool", async () => {
    await useKind("raydium", 105);
    const swapped = structuredClone(bundles.raydium);
    swapped.swapInstruction.accounts[13]!.pubkey = AMM_VAULT_B; swapped.swapInstruction.accounts[14]!.pubkey = AMM_VAULT_A;
    bundles.raydium = swapped;
    await assert.rejects(() => prepare(raydiumAdapter), /Raydium AMM authority, token account or vault/u);
  });
  it("rejects arbitrary transfers, approvals, closes, extra swap, fee budget and unsigned-bundle version", async () => {
    const baseline = await bundleFixture(26);
    const attacks: ApiInstruction[] = [apiInstruction(TOKEN_PROGRAM, [OWNER, ATTACKER], Uint8Array.from([4]), [0]),
      apiInstruction(SYSTEM, [OWNER, ATTACKER], Buffer.from(baseline.setupInstructions[0]!.data, "base64"), [0], [0, 1]),
      apiInstruction(TOKEN_PROGRAM, [await ata(OWNER, USDC), ATTACKER, OWNER], Uint8Array.from([9]), [2]),
      apiInstruction(ATTACKER, [OWNER], Uint8Array.from([1]), [0]), baseline.swapInstruction,
      apiInstruction(LIGHTHOUSE_PROGRAM, [OWNER], Uint8Array.from([2]), [])];
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
  it("requires successful RPC simulation and the actual reviewed-pool CPI (SIMULATION_UNVERIFIED)", async () => {
    simulationUnavailable = true; await assert.rejects(() => prepare(raydiumAdapter), /could not be simulated/iu);
    simulationUnavailable = false; mock.simulationError = { InstructionError: [2, { Custom: 1 }] };
    await assert.rejects(() => prepare(raydiumAdapter), /could not be simulated/iu);
    mock.simulationError = null; proveCpi = false;
    await rejectsWithCode(prepare(raydiumAdapter), "SIMULATION_UNVERIFIED", /did not prove a swap/u);
    await rejectsWithCode(prepare(meteoraAdapter), "SIMULATION_UNVERIFIED", /Meteora pool/u);
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
  it("decodes only the reviewed enum variants of the venue and rejects Token-2022 remaining-account slices", () => {
    for (const kind of [26, 40, 46, 105]) assert.ok(decodeDexRouteData(routeData(kind), "raydium"), String(kind));
    for (const kind of [17, 47]) assert.ok(decodeDexRouteData(routeData(kind), "orca"), String(kind));
    for (const kind of [38, 108]) assert.ok(decodeDexRouteData(routeData(kind), "meteora"), String(kind));
    // Legacy Raydium with OpenBook accounts, Meteora DAMM v1, DLMM swap V2, plain DAMM v2: never seen live, refused.
    for (const kind of [7, 19, 75, 77]) {
      for (const dex of ["raydium", "orca", "meteora"] as const) assert.equal(decodeDexRouteData(routeData(kind), dex), null, `${dex} ${kind}`);
    }
    assert.equal(decodeDexRouteData(routeData(38), "raydium"), null, "labels belong to one venue");
    assert.equal(decodeDexRouteData(routeData(105), "meteora"), null);
    const whirlpool = routeData(47); whirlpool[14] = 1;
    assert.equal(decodeDexRouteData(whirlpool, "orca"), null);
  });
  it("prepares native-SOL output without funding or syncing an unrelated token account", async () => {
    const usdc = resolved("USDC"); const sol = resolved("SOL");
    const input = await ata(OWNER, USDC); const output = await ata(OWNER, WSOL);
    const out = 100_000_000n;
    const q = quoteFixture(26);
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
      action: action(usdc, sol), now: NOW });
    assert.equal(payload.minimumOutput.amount, "99500000");
    bundles.raydium.cleanupInstruction.accounts[1]!.pubkey = ATTACKER;
    await assert.rejects(() => raydiumAdapter.prepare({ graph: {} as IntentGraph, step: {} as IntentStep, action: action(usdc, sol), now: NOW }), /token operation/iu);
  });
  it("prepares a classic SPL-to-SPL swap without SOL wrapping or token-account closing", async () => {
    const inputAsset = resolved("USDC"); const outputAsset = resolved("USDT"); const usdt = outputAsset.address as string;
    mock.accounts.set(usdt, mintFixture(6));
    const pool = poolFixture("Raydium CLMM");
    pool.data.set(addressEncoder.encode(address(USDC)), 73); pool.data.set(addressEncoder.encode(address(usdt)), 105);
    mock.accounts.set(POOL, pool);
    const q = quoteFixture(26); q.inputMint = USDC; q.outputMint = usdt;
    const leg = (q.routePlan as { swapInfo: Record<string, unknown> }[])[0]!.swapInfo; leg.inputMint = USDC; leg.outputMint = usdt; quotes.raydium = q;
    const input = await ata(OWNER, USDC); const output = await ata(OWNER, usdt);
    bundles.raydium.setupInstructions = [apiInstruction(SOLANA_PROGRAM_IDS.associatedToken,
      [OWNER, output, OWNER, usdt, SYSTEM, TOKEN_PROGRAM], Uint8Array.from([1]), [0], [0, 1])];
    bundles.raydium.cleanupInstruction = null;
    bundles.raydium.swapInstruction = apiInstruction(SOLANA_PROGRAM_IDS.jupiterV6,
      [TOKEN_PROGRAM, OWNER, input, output, SOLANA_PROGRAM_IDS.jupiterV6, usdt, SOLANA_PROGRAM_IDS.jupiterV6, ATTACKER,
        SOLANA_PROGRAM_IDS.jupiterV6, CLMM, OWNER, ATTACKER, POOL, input, output, VAULT_A, VAULT_B, OBSERVATION, TOKEN_PROGRAM],
      routeData(), [1], [2, 3, 12, 13, 14]);
    const payload = await raydiumAdapter.prepare({ graph: {} as IntentGraph, step: {} as IntentStep, action: action(inputAsset, outputAsset), now: NOW });
    assert.equal(payload.input.symbol, "USDC"); assert.equal(payload.minimumOutput.symbol, "USDT"); assert.equal(payload.transactions.length, 1);
  });
});

async function verificationFixture(dex: SolanaDex): Promise<{ step: IntentStep; landed: LandedFixture; signature: string }> {
  const bundle = bundles[dex];
  const signature = randomSolanaSignature();
  const input = assetAmount(resolved("SOL"), IN.toString()); const output = assetAmount(resolved("USDC"), MIN.toString());
  const instructions = [...bundle.computeBudgetInstructions, ...bundle.setupInstructions, bundle.swapInstruction, ...(bundle.cleanupInstruction ? [bundle.cleanupInstruction] : [])]
    .map((ix) => ({ program: ix.programId, accounts: ix.accounts.map((account) => account.pubkey), data: Uint8Array.from(Buffer.from(ix.data, "base64")) }));
  const account = action().account;
  const step: IntentStep = { id: "dex-swap", index: 0, kind: "swap", title: "DEX swap", protocol: dex, network: "solana", chain: CHAINS.solana.id,
    account: account.id, mode: "wallet", dependsOn: [], status: "submitted", input, minimumOutput: output, evidence: [],
    quoteRef: encodeStepRef({ v: 1, slippageBps: 50, floors: [{ at: NOW / 1000, min: MIN.toString() }] }),
    prepared: { quoteBinding: "ab".repeat(32), preparedAt: new Date(NOW).toISOString(), expiresAt: NOW / 1000 + 90,
      transactions: [{ vm: "svm", network: "solana", feePayer: OWNER, to: SOLANA_PROGRAM_IDS.jupiterV6, description: "DEX swap" }] } };
  const landed: LandedFixture = { signature, feePayer: OWNER, blockTime: NOW / 1000 + 15, instructions,
    tokenBalances: [{ account: await ata(OWNER, USDC), owner: OWNER, mint: USDC, pre: 0n, post: OUT }],
    lamports: new Map([[OWNER, -IN - 5_000n]]), fee: 5_000 };
  return { step, landed, signature };
}

type InnerGroup = { index: number; instructions: { programId: string; accounts: string[]; data: string }[] };

describe("direct DEX verification requires on-chain economic and venue evidence", () => {
  /**
   * Installs a landed receipt. Inner instructions default to the reviewed
   * pool's CPI under the route's index in the landed list.
   */
  async function installReceipt(dex: SolanaDex, change: (fixture: LandedFixture) => LandedFixture = (value) => value,
    inner?: (instructions: readonly LandedInstruction[]) => InnerGroup[]) {
    const fixture = await verificationFixture(dex);
    const landed = change(fixture.landed);
    mock.landed.set(fixture.signature, landed);
    const groups = inner ?? ((instructions) => {
      const index = instructions.findIndex((ix) => ix.program === SOLANA_PROGRAM_IDS.jupiterV6);
      const program = instructions[index]?.accounts[9] as string;
      return [{ index, instructions: [{ programId: program, accounts: [POOL_OF_PROGRAM[program] as string], data: "" }] }];
    });
    const rpcFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const response = await rpcFetch(input, init);
      if (typeof init?.body !== "string" || (JSON.parse(init.body) as { method?: string }).method !== "getTransaction") return response;
      const value = await response.json() as { result?: { meta?: Record<string, unknown> } };
      if (value.result?.meta) value.result.meta.innerInstructions = groups(landed.instructions);
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { ...fixture, verify: () => ADAPTER[dex].verify({ step: fixture.step, references: [fixture.signature], submittedAt: NOW, now: NOW + 20_000 }) };
  }
  for (const dex of ["raydium", "orca", "meteora"] as const) {
    it(`confirms ${dex} only after exact input and guaranteed wallet output`, async () => {
      const fixture = await installReceipt(dex); const result = await fixture.verify();
      assert.equal(result.status, "confirmed"); if (result.status === "confirmed") assert.equal(result.actualOutput?.amount, OUT.toString());
    });
  }
  it("confirms AMM v4 and DAMM v2 receipts against the evidence pools", async () => {
    for (const [dex, kind] of [["raydium", 105], ["meteora", 108]] as const) {
      await useKind(dex, kind);
      const result = await (await installReceipt(dex)).verify();
      assert.equal(result.status, "confirmed", `${kind}: ${JSON.stringify(result)}`);
    }
  });
  it("T4: confirms with a Lighthouse assertion after the route or a wallet SetComputeUnitPrice before it", async () => {
    const assertion: LandedInstruction = { program: LIGHTHOUSE_PROGRAM, accounts: [OWNER], data: Uint8Array.from([5, 0, 1, 2]) };
    const price = new Uint8Array(9); price[0] = 3; new DataView(price.buffer).setBigUint64(1, 50_000n, true);
    const priced: LandedInstruction = { program: SOLANA_PROGRAM_IDS.computeBudget, accounts: [], data: price };
    for (const change of [
      (value: LandedFixture) => ({ ...value, instructions: [...value.instructions, assertion] }),
      (value: LandedFixture) => ({ ...value, instructions: [priced, ...value.instructions] }),
      (value: LandedFixture) => ({ ...value, instructions: [priced, ...value.instructions.slice(0, -1), assertion, ...value.instructions.slice(-1)] }),
    ]) {
      const result = await (await installReceipt("raydium", change)).verify();
      assert.equal(result.status, "confirmed", JSON.stringify(result));
    }
  });
  it("T4: a Lighthouse non-assertion or a Lighthouse instruction with an inner CPI is REFERENCE_MISMATCH", async () => {
    const memoryWrite: LandedInstruction = { program: LIGHTHOUSE_PROGRAM, accounts: [OWNER], data: Uint8Array.from([0, 1]) };
    const write = await (await installReceipt("raydium", (value) => ({ ...value, instructions: [...value.instructions, memoryWrite] }))).verify();
    assert.ok(write.status === "failed"); assert.equal(write.failure.code, "REFERENCE_MISMATCH"); assert.match(write.failure.message, /Lighthouse/u);
    const assertion: LandedInstruction = { program: LIGHTHOUSE_PROGRAM, accounts: [OWNER], data: Uint8Array.from([5]) };
    const cpi = await (await installReceipt("raydium", (value) => ({ ...value, instructions: [...value.instructions, assertion] }), (instructions) => {
      const route = instructions.findIndex((ix) => ix.program === SOLANA_PROGRAM_IDS.jupiterV6);
      return [{ index: route, instructions: [{ programId: CLMM, accounts: [POOL], data: "" }] },
        { index: instructions.length - 1, instructions: [{ programId: TOKEN_PROGRAM, accounts: [OWNER], data: "" }] }];
    })).verify();
    assert.ok(cpi.status === "failed"); assert.equal(cpi.failure.code, "REFERENCE_MISMATCH"); assert.match(cpi.failure.message, /invoked other programs/u);
    // Another unapproved top-level program is still refused by the strict provider rules.
    const foreign = await (await installReceipt("raydium", (value) => ({ ...value,
      instructions: [...value.instructions, { program: ATTACKER, accounts: [OWNER], data: Uint8Array.from([1]) }] }))).verify();
    assert.ok(foreign.status === "failed"); assert.equal(foreign.failure.code, "REFERENCE_MISMATCH");
  });
  it("rejects a foreign fee payer and stale transaction", async () => {
    const foreign = await installReceipt("raydium", (value) => ({ ...value, feePayer: ATTACKER }));
    assert.equal((await foreign.verify()).status, "failed");
    const stale = await installReceipt("raydium", (value) => ({ ...value, blockTime: NOW / 1000 - 400 }));
    const result = await stale.verify(); assert.ok(result.status === "failed"); assert.equal(result.failure.code, "REFERENCE_STALE");
  });
  it("rejects an inert route, insufficient output and excessive native input", async () => {
    const inert = await installReceipt("raydium", undefined, () => []); const noCpi = await inert.verify();
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
    const result = await fixture.verify(); assert.ok(result.status === "confirmed", JSON.stringify(result)); assert.equal(result.actualOutput?.amount, out.toString());
  });
});
