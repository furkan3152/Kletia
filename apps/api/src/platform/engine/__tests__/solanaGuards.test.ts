import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CHAINS, parseAccountId, type ParsedAccountId } from "@kletia/core";
import {
  assertSolanaWalletRecipient,
  buildSolanaTransfer,
  SolanaProviderError,
  verifySolanaTransaction,
} from "../../../networks/solana/index.js";
import { fetchProviderJson } from "../../../networks/solana/http.js";
import { toPlatformError } from "../../errors.js";
import { relayAdapter } from "../adapters/relay.js";
import { solanaTransferAdapter } from "../adapters/solanaTransfer.js";
import type { AdapterAction } from "../adapters/types.js";
import type { ResolvedAsset } from "../assets.js";
import { EVM_ADDRESS, OTHER_SOL_ADDRESS, randomSolanaSignature, RELAY_EVM_TARGET, SOL_ADDRESS } from "./helpers.js";
import { installRpcMock, type RpcMock } from "./rpcMock.js";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** A USDC token account (owned by the Token program), the mistake the recipient check catches. */
const TOKEN_ACCOUNT = "7ZzgsXZgvQ9qC9DeYZmFXJUfEZyBPiSeEGxbKjPkWwTN";
const FEE_MINT = "CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo";
const FRESH_WALLET = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
const STAKE_ACCOUNT = "GKu2xfGZopa8C9K11wduQWgP4W4H7EEcaNdsUb7mxhyr";
const EMPTY_PDA = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

interface AccountFixture {
  readonly owner: string;
  readonly space: number;
  /** Simulates RPC nodes that omit `space` (only the sliced data shows contents). */
  readonly omitSpace?: boolean;
  /** jsonParsed `info` for mints. */
  readonly parsed?: Record<string, unknown>;
}

let mock: RpcMock;
const accounts = new Map<string, AccountFixture>();
const methods: string[] = [];
let accountReadsFail = false;
let currentEpoch = 700;
let relayQuotes = 0;

function rpcJson(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json" } });
}

function accountInfo(address: string, config: Record<string, unknown> | undefined): unknown {
  const fixture = accounts.get(address);
  if (!fixture) return { context: { slot: 100 }, value: null };
  const data = config?.encoding === "jsonParsed" && fixture.parsed
    ? {
        parsed: { info: fixture.parsed, type: "mint" },
        program: fixture.owner === TOKEN_2022_PROGRAM ? "spl-token-2022" : "spl-token",
        space: fixture.space,
      }
    : [fixture.space > 0 ? "AA==" : "", "base64"];
  return {
    context: { slot: 100 },
    value: {
      data,
      executable: false,
      lamports: 2_039_280,
      owner: fixture.owner,
      rentEpoch: 0,
      ...(fixture.omitSpace ? {} : { space: fixture.space }),
    },
  };
}

/** Layers getAccountInfo / getEpochInfo / getLatestBlockhash over the shared RPC double. */
function installAccountMock(): void {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }
    const payload = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { id?: unknown; method?: unknown; params?: unknown[] })
      : null;
    const method = typeof payload?.method === "string" ? payload.method : null;
    if (method) methods.push(method);
    if (method === "getAccountInfo") {
      if (accountReadsFail) return new Response("unavailable", { status: 503 });
      const params = payload?.params ?? [];
      return rpcJson(payload?.id, accountInfo(String(params[0]), params[1] as Record<string, unknown> | undefined));
    }
    if (method === "getEpochInfo") {
      return rpcJson(payload?.id, { absoluteSlot: 1, blockHeight: 1, epoch: currentEpoch, slotIndex: 1, slotsInEpoch: 432_000, transactionCount: 1 });
    }
    if (method === "getLatestBlockhash") {
      return rpcJson(payload?.id, { context: { slot: 100 }, value: { blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: 1_000 } });
    }
    return inner(input, init);
  }) as typeof fetch;
}

function mintFixture(owner: string, extensions?: unknown[]): AccountFixture {
  return { owner, space: 82, parsed: { decimals: 6, isInitialized: true, supply: "1000000", ...(extensions ? { extensions } : {}) } };
}

function feeConfig(older: { epoch: number; bps: number; max: number }, newer: { epoch: number; bps: number; max: number }) {
  const fee = (entry: { epoch: number; bps: number; max: number }) => ({
    epoch: entry.epoch,
    maximumFee: entry.max,
    transferFeeBasisPoints: entry.bps,
  });
  return [{
    extension: "transferFeeConfig",
    state: {
      newerTransferFee: fee(newer),
      olderTransferFee: fee(older),
      transferFeeConfigAuthority: null,
      withdrawWithheldAuthority: null,
      withheldAmount: 0,
    },
  }];
}

beforeEach(() => {
  mock = installRpcMock();
  accounts.clear();
  methods.length = 0;
  accountReadsFail = false;
  currentEpoch = 700;
  relayQuotes = 0;
  accounts.set(SOL_ADDRESS, { owner: SYSTEM_PROGRAM, space: 0 });
  accounts.set(TOKEN_ACCOUNT, { owner: TOKEN_PROGRAM, space: 165 });
  accounts.set(USDC_SOL, mintFixture(TOKEN_PROGRAM));
  accounts.set(STAKE_ACCOUNT, { owner: STAKE_PROGRAM, space: 200 });
  accounts.set(EMPTY_PDA, { owner: STAKE_PROGRAM, space: 0 });
  installAccountMock();
});

afterEach(() => {
  mock.restore();
});

async function errorCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SolanaProviderError) return `${error.code}/${error.status}`;
    throw error;
  }
  return "OK";
}

/* ------------------------------------------------------------ recipients */

describe("Solana recipients must be wallets", () => {
  it("refuses token accounts, mints and program-owned accounts holding data", async () => {
    assert.equal(await errorCode(() => assertSolanaWalletRecipient("solana", TOKEN_ACCOUNT)), "SOLANA_RECIPIENT_NOT_WALLET/422");
    assert.equal(await errorCode(() => assertSolanaWalletRecipient("solana", USDC_SOL)), "SOLANA_RECIPIENT_NOT_WALLET/422");
    accounts.set(FEE_MINT, mintFixture(TOKEN_2022_PROGRAM));
    assert.equal(await errorCode(() => assertSolanaWalletRecipient("solana", FEE_MINT)), "SOLANA_RECIPIENT_NOT_WALLET/422");
    assert.equal(await errorCode(() => assertSolanaWalletRecipient("solana", STAKE_ACCOUNT)), "SOLANA_RECIPIENT_NOT_WALLET/422");
    // Older RPC nodes omit `space`; the one-byte data slice still shows the account holds state.
    accounts.set(STAKE_ACCOUNT, { owner: STAKE_PROGRAM, space: 200, omitSpace: true });
    assert.equal(await errorCode(() => assertSolanaWalletRecipient("solana", STAKE_ACCOUNT)), "SOLANA_RECIPIENT_NOT_WALLET/422");
  });

  it("allows system wallets, accounts that do not exist yet and empty program-owned addresses", async () => {
    assert.equal(await errorCode(() => assertSolanaWalletRecipient("solana", SOL_ADDRESS)), "OK");
    assert.equal(await errorCode(() => assertSolanaWalletRecipient("solana", FRESH_WALLET)), "OK");
    assert.equal(await errorCode(() => assertSolanaWalletRecipient("solana", EMPTY_PDA)), "OK");
  });

  it("fails closed when the recipient account cannot be read", async () => {
    accountReadsFail = true;
    assert.equal(await errorCode(() => assertSolanaWalletRecipient("solana", FRESH_WALLET)), "SOLANA_RPC_UNAVAILABLE/503");
    const mapped = toPlatformError(new SolanaProviderError("x", "SOLANA_RPC_UNAVAILABLE", 503));
    assert.equal(mapped.status, 502);
  });

  it("buildSolanaTransfer refuses a token-account recipient for SPL and native SOL before building", async () => {
    const spl = { network: "solana" as const, from: SOL_ADDRESS, to: TOKEN_ACCOUNT, mint: USDC_SOL, amount: "1000000", decimals: 6 };
    assert.equal(await errorCode(() => buildSolanaTransfer(spl)), "SOLANA_RECIPIENT_NOT_WALLET/422");
    assert.equal(
      await errorCode(() => buildSolanaTransfer({ ...spl, mint: "SOL", amount: "1000000", decimals: 9 })),
      "SOLANA_RECIPIENT_NOT_WALLET/422",
    );
    assert.equal(await errorCode(() => buildSolanaTransfer({ ...spl, to: USDC_SOL })), "SOLANA_RECIPIENT_NOT_WALLET/422");
    assert.ok(!methods.includes("getLatestBlockhash"), "nothing is built for a refused recipient");
    accountReadsFail = true;
    assert.equal(await errorCode(() => buildSolanaTransfer({ ...spl, to: FRESH_WALLET })), "SOLANA_RPC_UNAVAILABLE/503");
    assert.ok(!methods.includes("getLatestBlockhash"));
  });

  it("buildSolanaTransfer still builds transfers to wallets that do not exist yet", async () => {
    const prepared = await buildSolanaTransfer({ network: "solana", from: SOL_ADDRESS, to: FRESH_WALLET, mint: USDC_SOL, amount: "1000000", decimals: 6 });
    assert.ok(prepared.transaction.length > 0);
    assert.equal(prepared.simulation.ok, true);
    assert.deepEqual(mock.unknown, []);
  });
});

/* ---------------------------------------------------- transfer-fee mints */

describe("Token-2022 transfer-fee mints are refused", () => {
  const transfer = { network: "solana" as const, from: SOL_ADDRESS, to: FRESH_WALLET, mint: FEE_MINT, amount: "10000000", decimals: 6 };

  it("refuses a mint whose current fee is nonzero", async () => {
    accounts.set(FEE_MINT, mintFixture(TOKEN_2022_PROGRAM, feeConfig({ epoch: 600, bps: 0, max: 0 }, { epoch: 698, bps: 269, max: 1_000_000_000 })));
    assert.equal(await errorCode(() => buildSolanaTransfer(transfer)), "TOKEN_TRANSFER_FEE_UNSUPPORTED/422");
  });

  it("refuses a nonzero fee scheduled for a later epoch, and an older fee still in force", async () => {
    accounts.set(FEE_MINT, mintFixture(TOKEN_2022_PROGRAM, feeConfig({ epoch: 600, bps: 0, max: 0 }, { epoch: 701, bps: 50, max: 10 })));
    assert.equal(await errorCode(() => buildSolanaTransfer(transfer)), "TOKEN_TRANSFER_FEE_UNSUPPORTED/422");
    accounts.set(FEE_MINT, mintFixture(TOKEN_2022_PROGRAM, feeConfig({ epoch: 600, bps: 100, max: 1_000 }, { epoch: 701, bps: 0, max: 0 })));
    assert.equal(await errorCode(() => buildSolanaTransfer(transfer)), "TOKEN_TRANSFER_FEE_UNSUPPORTED/422");
  });

  it("refuses an unreadable fee config", async () => {
    accounts.set(FEE_MINT, mintFixture(TOKEN_2022_PROGRAM, [{ extension: "transferFeeConfig", state: { olderTransferFee: null } }]));
    assert.equal(await errorCode(() => buildSolanaTransfer(transfer)), "TOKEN_TRANSFER_FEE_UNSUPPORTED/422");
  });

  it("allows Token-2022 mints whose fee is zero now and plain Token-2022 mints", async () => {
    // The older fee stopped at the newer (zero) fee's epoch.
    accounts.set(FEE_MINT, mintFixture(TOKEN_2022_PROGRAM, feeConfig({ epoch: 600, bps: 100, max: 1_000 }, { epoch: 699, bps: 0, max: 0 })));
    assert.equal(await errorCode(() => buildSolanaTransfer(transfer)), "OK");
    accounts.set(FEE_MINT, mintFixture(TOKEN_2022_PROGRAM, feeConfig({ epoch: 600, bps: 0, max: 0 }, { epoch: 600, bps: 0, max: 0 })));
    assert.equal(await errorCode(() => buildSolanaTransfer(transfer)), "OK");
    accounts.set(FEE_MINT, mintFixture(TOKEN_2022_PROGRAM, [{ extension: "metadataPointer", state: {} }]));
    assert.equal(await errorCode(() => buildSolanaTransfer(transfer)), "OK");
    assert.deepEqual(mock.unknown, []);
  });
});

/* ------------------------------------------------------------- adapters */

const DEVNET = CHAINS["solana-devnet"];

function account(id: string): ParsedAccountId {
  const parsed = parseAccountId(id);
  assert.ok(parsed, id);
  return parsed;
}

function solanaAsset(network: "solana" | "solana-devnet", mint: string | null): ResolvedAsset {
  return {
    network,
    id: (mint ? `${CHAINS[network].id}/token:${mint}` : `${CHAINS[network].id}/slip44:501`) as ResolvedAsset["id"],
    symbol: mint ? "TKN" : "SOL",
    name: mint ? "Token" : "Solana",
    decimals: mint ? 6 : 9,
    address: mint,
    isNative: mint === null,
    canonical: true,
    verified: true,
  };
}

function transferAction(recipient: string, mint: string | null): AdapterAction {
  const asset = solanaAsset("solana-devnet", mint);
  return {
    kind: "transfer",
    network: "solana-devnet",
    destinationNetwork: "solana-devnet",
    input: asset,
    output: asset,
    amount: mint ? "10000000" : "1000000000",
    account: account(`solana:${DEVNET.reference}:${SOL_ADDRESS}`),
    recipient: account(`solana:${DEVNET.reference}:${recipient}`),
    slippageBps: 50,
  };
}

describe("Solana transfer planning checks the recipient and mint", () => {
  it("refuses token-account recipients and fee-charging mints at plan time", async () => {
    assert.equal(await errorCode(() => solanaTransferAdapter.plan(transferAction(TOKEN_ACCOUNT, USDC_SOL))), "SOLANA_RECIPIENT_NOT_WALLET/422");
    assert.equal(await errorCode(() => solanaTransferAdapter.plan(transferAction(TOKEN_ACCOUNT, null))), "SOLANA_RECIPIENT_NOT_WALLET/422");
    accounts.set(FEE_MINT, mintFixture(TOKEN_2022_PROGRAM, feeConfig({ epoch: 600, bps: 0, max: 0 }, { epoch: 698, bps: 269, max: 1_000_000_000 })));
    assert.equal(await errorCode(() => solanaTransferAdapter.plan(transferAction(FRESH_WALLET, FEE_MINT))), "TOKEN_TRANSFER_FEE_UNSUPPORTED/422");
  });

  it("fails closed when the recipient cannot be checked", async () => {
    accountReadsFail = true;
    assert.equal(await errorCode(() => solanaTransferAdapter.plan(transferAction(FRESH_WALLET, null))), "SOLANA_RPC_UNAVAILABLE/503");
  });

  it("plans transfers to wallets", async () => {
    const planned = await solanaTransferAdapter.plan(transferAction(FRESH_WALLET, USDC_SOL));
    assert.equal(planned.protocol, "spl-token");
    assert.equal(planned.minimumOutput.amount, "10000000");
    assert.equal((await solanaTransferAdapter.plan(transferAction(OTHER_SOL_ADDRESS, null))).protocol, "system-transfer");
    assert.deepEqual(mock.unknown, []);
  });
});

describe("Relay bridges into Solana check the destination recipient", () => {
  const usdcBase: ResolvedAsset = {
    network: "base",
    id: `${CHAINS.base.id}/erc20:${USDC_BASE}` as ResolvedAsset["id"],
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    address: USDC_BASE,
    isNative: false,
    canonical: true,
    verified: true,
  };
  const usdcSol: ResolvedAsset = { ...solanaAsset("solana", USDC_SOL), symbol: "USDC", name: "USD Coin" };

  function bridgeAction(recipient: string): AdapterAction {
    return {
      kind: "bridge",
      network: "base",
      destinationNetwork: "solana",
      input: usdcBase,
      output: usdcSol,
      amount: "25000000",
      account: account(`${CHAINS.base.id}:${EVM_ADDRESS}`),
      recipient: account(`solana:${CHAINS.solana.reference}:${recipient}`),
      slippageBps: 50,
    };
  }

  beforeEach(() => {
    mock.relayQuote = (body) => {
      relayQuotes += 1;
      return {
        steps: [{
          id: "deposit",
          kind: "transaction",
          requestId: `0x${"12".repeat(32)}`,
          items: [{ status: "incomplete", data: { from: EVM_ADDRESS, to: RELAY_EVM_TARGET, data: "0x1234", value: "0", chainId: 8453 } }],
        }],
        fees: { gas: { amountUsd: "0.01" } },
        details: {
          recipient: body.recipient,
          currencyIn: { currency: { chainId: 8453, address: USDC_BASE, decimals: 6, symbol: "USDC" }, amount: "25000000" },
          currencyOut: { currency: { chainId: 792703809, address: USDC_SOL, decimals: 6, symbol: "USDC" }, amount: "24900000", minimumAmount: "24775500" },
          timeEstimate: 12,
        },
      };
    };
  });

  it("refuses token-account and mint recipients without requesting a quote", async () => {
    assert.equal(await errorCode(() => relayAdapter.plan(bridgeAction(TOKEN_ACCOUNT))), "SOLANA_RECIPIENT_NOT_WALLET/422");
    assert.equal(await errorCode(() => relayAdapter.plan(bridgeAction(USDC_SOL))), "SOLANA_RECIPIENT_NOT_WALLET/422");
    assert.equal(relayQuotes, 0);
  });

  it("fails closed when the destination recipient cannot be checked", async () => {
    accountReadsFail = true;
    assert.equal(await errorCode(() => relayAdapter.plan(bridgeAction(FRESH_WALLET))), "SOLANA_RPC_UNAVAILABLE/503");
    assert.equal(relayQuotes, 0);
  });

  it("plans bridges to wallets", async () => {
    const planned = await relayAdapter.plan(bridgeAction(SOL_ADDRESS));
    assert.equal(planned.protocol, "relay");
    assert.equal(planned.minimumOutput.amount, "24775500");
    assert.equal(relayQuotes, 1);
    assert.deepEqual(mock.unknown, []);
  });
});

/* -------------------------------------------------- /api/solana/tx evidence */

describe("Solana evidence endpoint never confirms an unchecked signer", () => {
  it("reports processed while the body is unreadable and a signer is expected", async () => {
    const signature = randomSolanaSignature();
    mock.solana.set(signature, { signature, confirmationStatus: "confirmed" });
    const unchecked = await verifySolanaTransaction("solana", signature, SOL_ADDRESS);
    assert.equal(unchecked.status, "processed");
    assert.equal(unchecked.signer, null);
    // Without an expected signer the status is reported as is.
    assert.equal((await verifySolanaTransaction("solana", signature)).status, "confirmed");
  });

  it("confirms the expected fee payer and fails another once the body is readable", async () => {
    const signature = randomSolanaSignature();
    mock.solana.set(signature, {
      signature,
      confirmationStatus: "finalized",
      body: { accountKeys: [SOL_ADDRESS, SYSTEM_PROGRAM], programIndexes: [1], blockTime: 1_790_000_000, fee: 5_000, preBalances: [10, 1], postBalances: [5, 1] },
    });
    assert.equal((await verifySolanaTransaction("solana", signature, SOL_ADDRESS)).status, "finalized");
    const foreign = await verifySolanaTransaction("solana", signature, OTHER_SOL_ADDRESS);
    assert.equal(foreign.status, "failed");
    assert.equal(foreign.signer, SOL_ADDRESS);
  });
});

/* ------------------------------------------------ bounded provider reads */

describe("Solana provider fetch bounds the response size", () => {
  function streamed(chunks: number, chunkBytes: number, headers: Record<string, string> = {}) {
    const state = { pulled: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulled >= chunks) {
          controller.close();
          return;
        }
        state.pulled += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    globalThis.fetch = (async () => new Response(body, { status: 200, headers })) as typeof fetch;
    return state;
  }

  it("rejects a declared oversized body without reading it", async () => {
    const state = streamed(40, 65_536, { "content-length": "5000000" });
    assert.equal(
      await errorCode(() => fetchProviderJson("https://provider.invalid/x", { provider: "Jupiter", maxBytes: 100_000 })),
      "PROVIDER_RESPONSE_TOO_LARGE/502",
    );
    assert.ok(state.pulled <= 1, `pulled ${state.pulled} chunks`);
    assert.ok(state.cancelled);
  });

  it("stops reading a streamed body as soon as it exceeds the limit", async () => {
    const state = streamed(40, 65_536);
    assert.equal(
      await errorCode(() => fetchProviderJson("https://provider.invalid/x", { provider: "Jupiter", maxBytes: 100_000 })),
      "PROVIDER_RESPONSE_TOO_LARGE/502",
    );
    assert.ok(state.pulled <= 3, `pulled ${state.pulled} chunks`);
    assert.ok(state.cancelled);
  });

  it("counts bytes, not UTF-16 characters, and still parses bodies within the limit", async () => {
    const wide = JSON.stringify({ name: "é".repeat(600) });
    globalThis.fetch = (async () => new Response(wide, { status: 200 })) as typeof fetch;
    assert.equal(
      await errorCode(() => fetchProviderJson("https://provider.invalid/x", { provider: "Jupiter", maxBytes: 1_000 })),
      "PROVIDER_RESPONSE_TOO_LARGE/502",
    );
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    assert.deepEqual(await fetchProviderJson("https://provider.invalid/x", { provider: "Jupiter", maxBytes: 1_000 }), { ok: true });
  });
});
