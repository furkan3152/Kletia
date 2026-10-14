/**
 * Fee estimates (journey design §6.6): EVM gas limits and multipliers times
 * eth_gasPrice with the OP-stack and Arbitrum L1 parts, Solana signatures,
 * priority and rent; live facts read through holdings with the rpcMock fetch
 * double (eth_gasPrice and rent answered on top of it).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { configureHoldingsReaders, resetHoldingsCaches } from "../holdings.js";
import {
  EVM_GAS,
  estimateEvmFee,
  estimateSolanaFee,
  estimateStepFee,
  evmGasUnits,
  evmOperationsFor,
  gasPriceFrom,
  readFeeFacts,
  rentFrom,
  SOLANA_TOKEN_ACCOUNT_RENT_FALLBACK,
} from "../journey/fees.js";
import { installRpcMock, type RpcMock } from "./rpcMock.js";

const GWEI = 1_000_000_000n;

describe("fees: EVM", () => {
  it("uses the adapters' own limits as they are and typical values with 1.5x headroom", () => {
    assert.equal(evmGasUnits("ethereum", { operations: ["approve", "aave-supply"] }).gas, 320_000n);
    assert.equal(evmGasUnits("ethereum", { operations: ["native-transfer"] }).gas, 31_500n);
    assert.equal(evmGasUnits("ethereum", { operations: ["approve", "relay-deposit"] }).gas, 60_000n + 120_000n);
    assert.equal(EVM_GAS["erc4626-withdraw"].gas, 900_000n);
  });

  it("prefers the quote's gas hints with 1.5x headroom", () => {
    assert.equal(evmGasUnits("ethereum", { quotedGas: [100_000n, 50_001n], operations: ["lifi"] }).gas, 150_000n + 75_002n);
  });

  it("adds 20 % on OP-stack networks and 1,000 gas per transaction on Arbitrum", () => {
    assert.equal(evmGasUnits("base", { operations: ["approve", "aave-supply"] }).gas, 384_000n);
    assert.equal(evmGasUnits("optimism", { operations: ["native-transfer"] }).gas, 37_800n);
    assert.equal(evmGasUnits("arbitrum", { operations: ["approve", "aave-supply"] }).gas, 322_000n);
  });

  it("multiplies by eth_gasPrice and labels the result estimated", () => {
    const fee = estimateEvmFee({ network: "ethereum", gasPriceWei: 2n * GWEI, operations: ["native-transfer"] });
    assert.equal(fee.certainty, "estimated");
    assert.equal(fee.amount, (31_500n * 2n * GWEI).toString());
    assert.equal(fee.formatted, "0.000063");
    assert.equal(fee.symbol, "ETH");
    const unknown = estimateEvmFee({ network: "polygon", gasPriceWei: null, operations: ["erc20-transfer"] });
    assert.equal(unknown.amount, null);
    assert.equal(unknown.symbol, "POL");
    assert.match(unknown.detail, /gas price unknown/u);
  });

  it("maps step kinds and protocols to their transactions", () => {
    assert.deepEqual(evmOperationsFor("deposit", "aave-v3"), ["approve", "aave-supply"]);
    assert.deepEqual(evmOperationsFor("deposit", "sparklend", { nativeInput: true }), ["wrap", "approve", "aave-supply"]);
    assert.deepEqual(evmOperationsFor("deposit", "moonwell", { nativeInput: true }), ["moonwell-router"]);
    assert.deepEqual(evmOperationsFor("withdraw", "yearn-v3"), ["erc4626-withdraw"]);
    assert.deepEqual(evmOperationsFor("bridge", "relay", { nativeInput: true }), ["relay-deposit"]);
    assert.deepEqual(evmOperationsFor("bridge", "debridge-dln"), ["approve", "dln-create"]);
    assert.deepEqual(evmOperationsFor("transfer", "erc20-transfer"), ["erc20-transfer"]);
  });
});

describe("fees: Solana", () => {
  it("charges signatures, priority, rent for missing token accounts and the wallet minimum of an empty wallet", () => {
    const plain = estimateSolanaFee({ network: "solana", signatures: 1 });
    assert.equal(plain.amount, "5000");
    const swap = estimateSolanaFee({ network: "solana", priorityLamports: 100_000n, tokenAccounts: [false, true], tokenAccountRentLamports: 1_488_440n });
    assert.equal(swap.amount, String(5_000 + 100_000 + 1_488_440));
    const empty = estimateSolanaFee({
      network: "solana",
      priorityLamports: 100_000n,
      tokenAccounts: [false],
      tokenAccountRentLamports: 1_488_440n,
      walletRentLamports: 650_240n,
      walletLamports: 0n,
    });
    // The journey design's P5 figure: 5,000 + 100,000 + 1,488,440 + 650,240 lamports.
    assert.equal(empty.amount, "2243680");
    assert.equal(empty.formatted, "0.00224368");
  });

  it("counts an unknown token account as missing and falls back to the higher rent (upper bounds)", () => {
    const fee = estimateSolanaFee({ network: "solana", tokenAccounts: [null], tokenAccountRentLamports: null });
    assert.equal(fee.amount, String(5_000n + SOLANA_TOKEN_ACCOUNT_RENT_FALLBACK));
    const unknownWallet = estimateSolanaFee({ network: "solana", walletLamports: null });
    assert.equal(unknownWallet.amount, "5000", "an unknown wallet balance adds no wallet minimum");
  });

  it("estimates a planned step on its own network", () => {
    const solana = estimateStepFee({ kind: "swap", network: "solana", protocol: "jupiter" }, { tokenAccounts: [true] });
    assert.equal(solana.amount, "105000");
    const base = estimateStepFee({ kind: "deposit", network: "base", protocol: "aave-v3", input: { asset: "eip155:8453/slip44:60" } }, { gasPriceWei: GWEI / 100n });
    assert.equal(base.units, String((60_000n + 60_000n + 260_000n) * 6n / 5n));
  });
});

describe("fees: live facts through holdings (rpcMock)", () => {
  let mock: RpcMock;
  let original: typeof fetch;
  const seen: string[] = [];

  beforeEach(() => {
    configureHoldingsReaders(null);
    resetHoldingsCaches();
    seen.length = 0;
    mock = installRpcMock();
    original = globalThis.fetch;
    // rpcMock answers the chain reads it knows; eth_gasPrice and rent are answered here, everything else goes to it.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "null")) as { id: unknown; method: string; params?: unknown[] } | { id: unknown; method: string; params?: unknown[] }[];
      const requests = Array.isArray(payload) ? payload : [payload];
      if (requests.every((request) => request.method === "eth_gasPrice" || request.method === "getMinimumBalanceForRentExemption")) {
        const answers = requests.map((request) => {
          seen.push(request.method);
          const result = request.method === "eth_gasPrice" ? "0x3b9aca00" : request.params?.[0] === 0 ? 650_240 : 1_488_440;
          return { jsonrpc: "2.0", id: request.id, result };
        });
        return new Response(JSON.stringify(Array.isArray(payload) ? answers : answers[0]), { headers: { "content-type": "application/json" } });
      }
      return original(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = original;
    mock.restore();
    resetHoldingsCaches();
  });

  it("reads gas prices (cached 12 s) and Solana rent, then estimates", async () => {
    const facts = await readFeeFacts(["base", "solana", "base"]);
    assert.equal(gasPriceFrom(facts, "base"), GWEI);
    assert.deepEqual(rentFrom(facts, "solana"), { wallet: 650_240n, tokenAccount: 1_488_440n });
    const again = await readFeeFacts(["base"]);
    assert.equal(again.reads, 0, "the gas price is cached");
    assert.equal(seen.filter((method) => method === "eth_gasPrice").length, 1);
    const fee = estimateStepFee({ kind: "transfer", network: "base", protocol: "system-transfer", input: { asset: "eip155:8453/slip44:60" } }, { gasPriceWei: gasPriceFrom(facts, "base") });
    assert.equal(fee.amount, String(37_800n * GWEI));
    assert.deepEqual(mock.unknown, []);
  });
});
