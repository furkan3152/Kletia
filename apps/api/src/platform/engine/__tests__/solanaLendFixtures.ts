/**
 * Offline Solana chain and provider double for the Jupiter Lend and Kamino
 * adapters: account state (getAccountInfo / getMultipleAccounts), blockhash,
 * simulation, landed transactions with instructions and lookup-table
 * accounts, plus the Jupiter Lend and Kamino KTX HTTP APIs. Anything else
 * fails loudly (recorded in `unknown`).
 */
import { createHash } from "node:crypto";
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { resetJupiterLendCache } from "../adapters/jupiterLendClient.js";

export const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
export const ATTACKER = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SYSTEM = "11111111111111111111111111111111";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
export const JL_PROGRAM = "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9";
export const JL_LIQUIDITY = "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC";
export const JL_USDC = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";
export const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
export const FARMS = "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr";
export const KAMINO_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
export const KAMINO_LMA = "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo";
export const KAMINO_USDC_RESERVE = "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59";
export const KAMINO_USDC_SUPPLY = "Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6";
export const KAMINO_USDC_COLLATERAL_MINT = "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D";
export const KAMINO_USDC_COLLATERAL_VAULT = "3DzjXRfxRm6iejfyyMynR4tScddaanrePJ1NJU2XnPPL";
/** One of the market's near-empty decoy USDC reserves. */
export const KAMINO_DECOY_USDC_RESERVE = "6pazpY4icuXZ5sb2jMWAqdG4TtbUoY1SJ45237Fjht9h";
export const INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111";
/** Jupiter Lend liquidity-side accounts of the USDC lending (from a live API instruction). */
export const JL_RESERVES = "94vK29npVbyRHXH63rRcTiSr26SFhrQTzbpNJuhQEDu";
export const JL_POSITION = "Hf9gtkM4dpVBahVSzEXSVCAPpKzBsBcns3s8As3z77oF";
export const JL_RATE_MODEL = "5pjzT5dFTsXcwixoab1QDLvZQvpYJxJeBphkyfHGn688";
export const JL_VAULT = "BmkUoKMFYBxNSzWXyUjyMJjMAaVz4d8ZnxwwmhDCUXFB";
export const JL_CLAIM = "HN1r4VfkDn53xQQfeGDYrNuDKFdemAhZsHYRwBrFhsW";
export const JL_LIQUIDITY_STATE = "7s1da8DduuBFqGra5bJBjpnvL5E9mGzCuMk1Qkh4or2Z";
export const JL_REWARDS = "5xSPBiD3TibamAnwHDhZABdB4z4F9dcj5PnbteroBTTd";
/** 1.063454277416 underlying per jlUSDC (12-decimal fixed point), the live value on 2026-10-09. */
export const JL_PRICE = 1_063_454_277_416n;

const encoder = getAddressEncoder();
const decoder = getAddressDecoder();
const base58 = getBase58Decoder();

export interface AccountFixture {
  readonly owner: string;
  readonly data: Uint8Array;
  readonly lamports?: bigint;
}

export interface LandedInstruction {
  readonly program: string;
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
}

export interface TokenBalance {
  readonly owner: string;
  readonly mint: string;
  readonly account: string;
  readonly pre: bigint;
  readonly post: bigint;
}

export interface LandedFixture {
  readonly signature: string;
  readonly feePayer: string;
  readonly blockTime: number;
  readonly err?: unknown;
  readonly instructions: readonly LandedInstruction[];
  /** Accounts to serve through `meta.loadedAddresses.writable` instead of static keys. */
  readonly loaded?: readonly string[];
  readonly tokenBalances?: readonly TokenBalance[];
  /** Lamport change per account (fee payer's includes the fee). */
  readonly lamports?: ReadonlyMap<string, bigint>;
  readonly fee?: number;
}

type Responder = { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

export interface SolanaLendMock {
  readonly accounts: Map<string, AccountFixture>;
  readonly landed: Map<string, LandedFixture>;
  simulationError: unknown;
  /** Jupiter Lend API responders by path suffix ("tokens", "deposit-instructions", ...). */
  readonly jupiter: Map<string, (body: Record<string, unknown> | null) => Responder>;
  /** Kamino KTX responders by action ("deposit" | "withdraw"). */
  readonly kamino: Map<string, (body: Record<string, unknown>) => Responder>;
  readonly methods: string[];
  readonly unknown: string[];
  restore(): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? Number(value) : value)), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function accountValue(fixture: AccountFixture | undefined) {
  if (!fixture) return null;
  return {
    data: [Buffer.from(fixture.data).toString("base64"), "base64"],
    executable: false,
    lamports: Number(fixture.lamports ?? 2_000_000n),
    owner: fixture.owner,
    rentEpoch: 0,
    space: fixture.data.length,
  };
}

function landedBody(fixture: LandedFixture) {
  const loaded = new Set(fixture.loaded ?? []);
  const keys: string[] = [fixture.feePayer];
  const add = (key: string) => {
    if (!loaded.has(key) && !keys.includes(key)) keys.push(key);
  };
  for (const instruction of fixture.instructions) {
    add(instruction.program);
    instruction.accounts.forEach(add);
  }
  for (const balance of fixture.tokenBalances ?? []) add(balance.account);
  for (const account of fixture.lamports?.keys() ?? []) add(account);
  const loadedList = [...loaded];
  const all = [...keys, ...loadedList];
  const index = (key: string) => all.indexOf(key);
  const balances = (side: "pre" | "post") => (fixture.tokenBalances ?? []).map((balance) => ({
    accountIndex: index(balance.account),
    mint: balance.mint,
    owner: balance.owner,
    programId: TOKEN_PROGRAM,
    uiTokenAmount: { amount: String(side === "pre" ? balance.pre : balance.post), decimals: 6, uiAmount: null, uiAmountString: "0" },
  }));
  const pre = all.map(() => 10_000_000_000);
  const post = all.map((key) => 10_000_000_000 + Number(fixture.lamports?.get(key) ?? 0n));
  return {
    slot: 99,
    blockTime: fixture.blockTime,
    version: 0,
    meta: {
      err: fixture.err ?? null,
      status: fixture.err ? { Err: fixture.err } : { Ok: null },
      fee: fixture.fee ?? 5_000,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: balances("pre"),
      postTokenBalances: balances("post"),
      loadedAddresses: { writable: loadedList, readonly: [] },
      innerInstructions: [],
      logMessages: [],
      rewards: [],
      computeUnitsConsumed: 1000,
    },
    transaction: {
      signatures: [fixture.signature],
      message: {
        accountKeys: keys,
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        recentBlockhash: SYSTEM,
        instructions: fixture.instructions.map((instruction) => ({
          programIdIndex: index(instruction.program),
          accounts: instruction.accounts.map(index),
          data: base58.decode(instruction.data),
          stackHeight: null,
        })),
        addressTableLookups: [],
      },
    },
  };
}

function solanaResult(mock: SolanaLendMock, method: string, params: unknown[]): unknown {
  switch (method) {
    case "getAccountInfo":
      return { context: { slot: 100 }, value: accountValue(mock.accounts.get(String(params[0]))) };
    case "getMultipleAccounts":
      return { context: { slot: 100 }, value: (params[0] as string[]).map((key) => accountValue(mock.accounts.get(key))) };
    case "getLatestBlockhash":
      return { context: { slot: 100 }, value: { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1_000 } };
    case "simulateTransaction":
      return { context: { slot: 100 }, value: { err: mock.simulationError, logs: [], accounts: null, unitsConsumed: 60_000, returnData: null } };
    case "getSignatureStatuses":
      return {
        context: { slot: 100 },
        value: (params[0] as string[]).map((signature) => {
          const landed = mock.landed.get(signature);
          return landed ? { slot: 99, confirmations: null, err: landed.err ?? null, status: { Ok: null }, confirmationStatus: "finalized" } : null;
        }),
      };
    case "getTransaction": {
      const landed = mock.landed.get(String(params[0]));
      return landed ? landedBody(landed) : null;
    }
    default:
      throw new Error(`unmocked Solana method ${method}`);
  }
}

export function installSolanaLendMock(): SolanaLendMock {
  const original = globalThis.fetch;
  resetJupiterLendCache();
  const mock: SolanaLendMock = {
    accounts: new Map(),
    landed: new Map(),
    simulationError: null,
    jupiter: new Map(),
    kamino: new Map(),
    methods: [],
    unknown: [],
    restore: () => {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const text = typeof init?.body === "string" ? init.body : "";
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    if (body && body.jsonrpc === "2.0" && typeof body.method === "string") {
      const method = body.method;
      mock.methods.push(method);
      try {
        return json({ jsonrpc: "2.0", id: body.id, result: solanaResult(mock, method, (body.params as unknown[]) ?? []) });
      } catch (error) {
        mock.unknown.push(`${method}: ${(error as Error).message}`);
        return json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: (error as Error).message } });
      }
    }
    if (url.pathname.startsWith("/lend/v1/earn/")) {
      const responder = mock.jupiter.get(url.pathname.slice("/lend/v1/earn/".length));
      if (responder) {
        const answer = await responder(body);
        return json(answer.body, answer.status ?? 200);
      }
    }
    if (url.hostname === "api.kamino.finance" && url.pathname.startsWith("/ktx/klend/")) {
      const responder = mock.kamino.get(url.pathname.slice("/ktx/klend/".length));
      if (responder && body) {
        const answer = await responder(body);
        return json(answer.body, answer.status ?? 200);
      }
    }
    // Prices and Kamino reserve metrics are advisory: answer empty.
    if (url.pathname.startsWith("/price/") || url.pathname.includes("/reserves/metrics")) return json(url.pathname.includes("metrics") ? [] : {});
    mock.unknown.push(url.href);
    return json({ message: "unmocked" }, 500);
  }) as typeof fetch;
  return mock;
}

/* ---------------------------------------------------------- byte helpers */

export function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function u128(value: bigint): Uint8Array {
  return Uint8Array.from([...u64(value & ((1n << 64n) - 1n)), ...u64(value >> 64n)]);
}

export function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

/** Discriminator + u64 amount (Anchor instruction data). */
export function instructionData(discriminator: string, amount: bigint): Uint8Array {
  return Uint8Array.from([...hex(discriminator), ...u64(amount)]);
}

function put(target: Uint8Array, offset: number, bytes: Uint8Array): void {
  target.set(bytes, offset);
}

function key(value: string): Uint8Array {
  return Uint8Array.from(encoder.encode(address(value)));
}

export async function ata(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM): Promise<string> {
  const [account] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: address(tokenProgram) });
  return String(account);
}

/** A classic SPL token account (165 bytes). */
export function tokenAccountData(mint: string, owner: string, amount: bigint): Uint8Array {
  const data = new Uint8Array(165);
  put(data, 0, key(mint));
  put(data, 32, key(owner));
  put(data, 64, u64(amount));
  data[108] = 1;
  return data;
}

export async function jupiterLendPdas(): Promise<{ lending: string; lendingAdmin: string }> {
  const text = new TextEncoder();
  const [lending] = await getProgramDerivedAddress({ programAddress: address(JL_PROGRAM), seeds: [text.encode("lending"), key(USDC), key(JL_USDC)] });
  const [lendingAdmin] = await getProgramDerivedAddress({ programAddress: address(JL_PROGRAM), seeds: [text.encode("lending_admin")] });
  return { lending: String(lending), lendingAdmin: String(lendingAdmin) };
}

/** The Jupiter Lend USDC Lending account (196 bytes, IDL layout). */
export function lendingAccountData(overrides: { mint?: string; fTokenMint?: string; price?: bigint } = {}): Uint8Array {
  const data = new Uint8Array(196);
  put(data, 0, hex(createHash("sha256").update("account:Lending").digest("hex").slice(0, 16)));
  put(data, 8, key(overrides.mint ?? USDC));
  put(data, 40, key(overrides.fTokenMint ?? JL_USDC));
  data[72] = 2;
  data[74] = 6;
  put(data, 75, key(JL_REWARDS));
  put(data, 107, u64(1_043_302_055_997n));
  put(data, 115, u64(overrides.price ?? JL_PRICE));
  put(data, 123, u64(1_791_535_148n));
  put(data, 131, key(JL_RESERVES));
  put(data, 163, key(JL_POSITION));
  data[195] = 255;
  return data;
}

/** Address-lookup-table account data: 56-byte header then 32-byte entries. */
export function lookupTableData(entries: readonly string[]): Uint8Array {
  const data = new Uint8Array(56 + entries.length * 32);
  data[0] = 1;
  put(data, 4, u64((1n << 64n) - 1n));
  entries.forEach((entry, index) => put(data, 56 + index * 32, key(entry)));
  return data;
}

/** Kamino reserve (8,624 bytes) with the fields the adapter reads; rate = liquidity / collateral. */
export function reserveAccountData(options: {
  market?: string;
  mint?: string;
  supplyVault?: string;
  collateralMint?: string;
  collateralVault?: string;
  tokenProgram?: string;
  decimals?: number;
  available: bigint;
  borrowed: bigint;
  collateralSupply: bigint;
}): Uint8Array {
  const data = new Uint8Array(8_624);
  put(data, 0, hex(createHash("sha256").update("account:Reserve").digest("hex").slice(0, 16)));
  put(data, 32, key(options.market ?? KAMINO_MARKET));
  put(data, 128, key(options.mint ?? USDC));
  put(data, 160, key(options.supplyVault ?? KAMINO_USDC_SUPPLY));
  put(data, 224, u64(options.available));
  put(data, 232, u128(options.borrowed << 60n));
  put(data, 272, u64(BigInt(options.decimals ?? 6)));
  put(data, 408, key(options.tokenProgram ?? TOKEN_PROGRAM));
  put(data, 2560, key(options.collateralMint ?? KAMINO_USDC_COLLATERAL_MINT));
  put(data, 2592, u64(options.collateralSupply));
  put(data, 2600, key(options.collateralVault ?? KAMINO_USDC_COLLATERAL_VAULT));
  return data;
}

export function decodeKey(bytes: Uint8Array): string {
  return String(decoder.decode(bytes));
}

export async function vanillaObligationOf(owner: string): Promise<string> {
  const [obligation] = await getProgramDerivedAddress({
    programAddress: address(KLEND),
    seeds: [new Uint8Array([0]), new Uint8Array([0]), key(owner), key(KAMINO_MARKET), key(SYSTEM), key(SYSTEM)],
  });
  return String(obligation);
}
