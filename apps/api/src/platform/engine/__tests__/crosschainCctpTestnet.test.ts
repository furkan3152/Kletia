/**
 * Circle CCTP V2 on the testnet lane (protocols design 3.5, P6): Arc Testnet
 * and Arbitrum Sepolia burn through the testnet TokenMessengerV2, Solana
 * Devnet is a forwarding destination, fees and attested messages come from
 * Circle's sandbox Iris (chosen from the source network, never production),
 * a route whose ends sit on different capital lanes is refused everywhere
 * (supports, plan, the fee read), and Arc's USDC burns as its 6-decimal
 * ERC-20 interface. Fee tables are the sandbox rows read live on 2026-10-15.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { address, getAddressEncoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { CCTP_V2_TESTNET_CONTRACTS, findAssetBySymbol, SOLANA_DEVNET_USDC_MINT, VENUE_CONTRACTS, type IntentGraph, type IntentStep, type TransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { CCTP_FORWARD_HOOK, cctpV2Adapter, decodeCctpMessage, resetCctpBurnLimitCache, TOKEN_MESSENGER_V2_ABI } from "../adapters/cctpV2.js";
import { assertCctpLane, CCTP_IRIS_SANDBOX_URL, CCTP_IRIS_URL, fetchCctpFastFees, irisUrl } from "../adapters/cctpClient.js";
import type { AdapterAction, SettlementResult, VerificationResult } from "../adapters/types.js";
import {
  bridgeAction,
  CCTP_TOKEN_MESSENGER,
  CCTP_TOKEN_MINTER,
  cctpMessage,
  depositForBurnLog,
  evmBridgeStep,
  installCrossChainMock,
  irisFeeTable,
  landPrepared,
  messageSentLog,
  PREPARED_AT,
  seconds,
  tokenAccountInfo,
  transferLog,
  type CrossChainMock,
} from "./crosschainFixtures.js";
import { EVM_ADDRESS, OTHER_EVM_ADDRESS, OTHER_SOL_ADDRESS, randomEvmHash, SOL_ADDRESS } from "./helpers.js";

const TESTNET_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const TESTNET_TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const TESTNET_MINTER = "0xb43db544E2c27092c107639Ad201b3dEfAbcF192";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const SEPOLIA_USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const SANDBOX_HOST = "iris-api-sandbox.circle.com";

/** Sandbox Fast rows read live 2026-10-15 (`GET /v2/burn/USDC/fees/{src}/{dst}?forward=true`). */
const SANDBOX_FEES: Readonly<Record<string, unknown>> = {
  "26/3": [{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 87656, med: 91243, high: 94829 } }, { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 87656, med: 91243, high: 94829 } }],
  "3/26": [{ finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 20297, med: 21150, high: 22214 } }, { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 20297, med: 21150, high: 22214 } }],
  "3/5": [{ finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 129934, med: 129934, high: 129934 } }, { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 129934, med: 129934, high: 129934 } }],
  "26/5": [{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 129934, med: 129934, high: 129934 } }, { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 129934, med: 129934, high: 129934 } }],
};

const AMOUNT = 1_000_000n; // 1 USDC
/** Arc -> Arb Sepolia: 0 bps + forwardFee.high 94,829. */
const MAX_FEE_ARC_SEPOLIA = 94_829n;
/** Arb Sepolia -> Arc: ceil(1,000,000 x 1.3 bps) = 130, plus 22,214. */
const MAX_FEE_SEPOLIA_ARC = 130n + 22_214n;
/** Arb Sepolia -> Solana Devnet: 130 + 129,934. */
const MAX_FEE_SEPOLIA_DEVNET = 130n + 129_934n;

let mock: CrossChainMock;
let restoreSandbox: () => void;
/** Sandbox Iris messages by burn transaction hash (lowercase). */
let sandboxMessages: Map<string, unknown>;
/** Every sandbox URL requested, and whether the testnet TokenMinter was read. */
let sandboxCalls: URL[];
let testnetMinterReads: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Wraps the shared cross-chain mock with the sandbox Iris host and the
 * testnet TokenMinter: its burn limit is answered like the mainnet minter's
 * (10,000,000 USDC, the value read back on Arc and Arbitrum Sepolia).
 */
function installSandbox(): () => void {
  const inner = globalThis.fetch;
  const minter = new RegExp(TESTNET_MINTER.slice(2), "giu");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === SANDBOX_HOST) {
      sandboxCalls.push(url);
      const fees = /^\/v2\/burn\/USDC\/fees\/(\d+)\/(\d+)$/u.exec(url.pathname);
      if (fees && url.searchParams.get("forward") === "true") {
        const table = SANDBOX_FEES[`${fees[1]}/${fees[2]}`];
        return table ? json(table) : json({ message: "unmocked" }, 500);
      }
      if (/^\/v2\/messages\/\d+$/u.test(url.pathname)) {
        const messages = sandboxMessages.get((url.searchParams.get("transactionHash") ?? "").toLowerCase());
        return messages ? json(messages) : json({ error: "Message hash not found" }, 404);
      }
      return json({ message: "unmocked" }, 500);
    }
    if (typeof init?.body === "string" && minter.test(init.body)) {
      testnetMinterReads += 1;
      return inner(input, { ...init, body: init.body.replace(minter, CCTP_TOKEN_MINTER.slice(2).toLowerCase()) });
    }
    return inner(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = inner;
  };
}

beforeEach(() => {
  mock = installCrossChainMock();
  resetCctpBurnLimitCache();
  sandboxMessages = new Map();
  sandboxCalls = [];
  testnetMinterReads = 0;
  restoreSandbox = installSandbox();
  // Mainnet tables on the same domain pairs: a testnet route that read production Iris would pick these up.
  mock.irisFees.set("3/5", irisFeeTable("solana"));
  mock.irisFees.set("6/3", irisFeeTable("arbitrum"));
});

afterEach(() => {
  restoreSandbox();
  mock.restore();
});

async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return `${error.code}: ${error.message}`;
  }
  return "OK";
}

function code(result: VerificationResult | SettlementResult | undefined): string | undefined {
  return result?.status === "failed" ? result.failure.code : result?.status;
}

const productionCalls = () => mock.calls.filter((url) => url.hostname === "iris-api.circle.com");
const word = (value: string) => `0x${value.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const svmWord = (value: string) => `0x${Buffer.from(getAddressEncoder().encode(address(value))).toString("hex")}` as Hex;

const arcToSepolia = (options: { recipient?: string; amount?: string } = {}) => bridgeAction("arc", "arbitrum-sepolia", { amount: AMOUNT.toString(), ...options });
const sepoliaToArc = (options: { recipient?: string } = {}) => bridgeAction("arbitrum-sepolia", "arc", { amount: AMOUNT.toString(), ...options });
const sepoliaToDevnet = () => bridgeAction("arbitrum-sepolia", "solana-devnet", { amount: AMOUNT.toString() });
const arcToDevnet = () => bridgeAction("arc", "solana-devnet", { amount: AMOUNT.toString() });

const prepareContext = (action: AdapterAction, step: IntentStep = evmBridgeStep(action, "cctp-v2", [])) => ({
  graph: {} as IntentGraph,
  step,
  action,
  now: Date.now(),
});

async function devnetUsdcAccount(owner: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(SOLANA_DEVNET_USDC_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return String(ata);
}

/** A testnet CCTP message: the shared builder with the testnet TokenMessenger as sender and recipient. */
function testnetMessage(options: Parameters<typeof cctpMessage>[0]): Hex {
  return cctpMessage(options).replace(new RegExp(CCTP_TOKEN_MESSENGER.slice(2), "giu"), TESTNET_MESSENGER.slice(2).toLowerCase()) as Hex;
}

describe("CCTP V2 testnet pins and lanes", () => {
  it("pins the testnet contracts in VENUE_CONTRACTS (Arc, Arbitrum Sepolia, Solana Devnet programs)", () => {
    for (const row of CCTP_V2_TESTNET_CONTRACTS) {
      assert.ok(VENUE_CONTRACTS.some((pin) => pin.protocol === row.protocol && pin.network === row.network && pin.role === row.role && pin.address === row.address), `${row.network} ${row.role}`);
    }
    assert.ok(CCTP_V2_TESTNET_CONTRACTS.some((row) => row.network === "arc" && row.role === "token-minter" && row.address === TESTNET_MINTER));
    assert.ok(CCTP_V2_TESTNET_CONTRACTS.some((row) => row.network === "solana-devnet" && row.role === "token-messenger-minter"));
  });

  it("chooses the sandbox Iris only for testnet source networks", () => {
    assert.equal(CCTP_IRIS_SANDBOX_URL, `https://${SANDBOX_HOST}`);
    assert.equal(CCTP_IRIS_URL, "https://iris-api.circle.com");
    for (const network of ["arc", "arbitrum-sepolia", "solana-devnet"] as const) assert.equal(irisUrl(network), CCTP_IRIS_SANDBOX_URL, network);
    for (const network of ["ethereum", "base", "arbitrum", "optimism", "polygon", "solana"] as const) assert.equal(irisUrl(network), CCTP_IRIS_URL, network);
  });

  it("serves the four demo routes, and refuses every mixed-lane route and Solana Devnet origins", () => {
    for (const action of [arcToSepolia(), sepoliaToArc(), sepoliaToDevnet(), arcToDevnet()]) {
      assert.equal(cctpV2Adapter.supports(action), true, `${action.network} -> ${action.destinationNetwork}`);
    }
    const refused: [Parameters<typeof bridgeAction>[0], Parameters<typeof bridgeAction>[1]][] = [
      ["arc", "arbitrum"], ["arbitrum-sepolia", "arbitrum"], ["arbitrum", "arbitrum-sepolia"], ["base", "arc"],
      ["arbitrum-sepolia", "solana"], ["base", "solana-devnet"], ["solana-devnet", "arbitrum-sepolia"], ["solana", "arbitrum-sepolia"],
    ];
    for (const [from, to] of refused) assert.equal(cctpV2Adapter.supports(bridgeAction(from, to)), false, `${from} -> ${to}`);
    // EURC on Arc is not USDC.
    assert.equal(cctpV2Adapter.supports(bridgeAction("arc", "arbitrum-sepolia", { symbol: "EURC", out: "USDC" })), false);
  });

  it("refuses a mixed-lane route in plan and in the fee read, before any Iris request", async () => {
    assert.throws(() => assertCctpLane("arbitrum-sepolia", "arbitrum"), (error: unknown) => error instanceof PlatformError && error.code === "ROUTE_UNSUPPORTED" && /never mix/u.test(error.message));
    assert.doesNotThrow(() => assertCctpLane("arc", "solana-devnet"));
    assert.doesNotThrow(() => assertCctpLane("base", "solana"));
    // Same domain numbers on both lanes (3 = Arbitrum and Arbitrum Sepolia): the network decides, not the domain.
    assert.match(await errorOf(() => fetchCctpFastFees({ network: "base", domain: 6 }, { network: "arbitrum-sepolia", domain: 3 })), /^ROUTE_UNSUPPORTED/u);
    assert.match(await errorOf(() => cctpV2Adapter.plan(bridgeAction("arc", "arbitrum", { amount: AMOUNT.toString() }))), /^ROUTE_UNSUPPORTED.*never mix/u);
    assert.match(await errorOf(() => cctpV2Adapter.plan(bridgeAction("base", "arbitrum-sepolia", { amount: AMOUNT.toString() }))), /^ROUTE_UNSUPPORTED.*never mix/u);
    assert.match(await errorOf(() => cctpV2Adapter.prepare(prepareContext(bridgeAction("arbitrum-sepolia", "solana", { amount: AMOUNT.toString() })))), /^ROUTE_UNSUPPORTED/u);
    assert.equal(sandboxCalls.length + productionCalls().length, 0, "no Iris request for a refused lane");
  });
});

describe("CCTP V2 testnet quotes and burns", () => {
  it("Arc -> Arbitrum Sepolia: sandbox fees, Arc USDC as a 6-decimal ERC-20 burn, the testnet minter's burn limit", async () => {
    const arcUsdc = findAssetBySymbol("arc", "USDC");
    assert.equal(arcUsdc?.address, ARC_USDC);
    assert.equal(arcUsdc?.decimals, 6, "Arc's USDC ERC-20 interface has 6 decimals (native gas USDC has 18)");
    const action = arcToSepolia();
    assert.equal(action.input.decimals, 6);
    const planned = await cctpV2Adapter.plan(action);
    assert.equal(planned.protocol, "cctp-v2");
    assert.equal(planned.expectedOutput.amount, (AMOUNT - MAX_FEE_ARC_SEPOLIA).toString());
    assert.equal(planned.minimumOutput.amount, (AMOUNT - MAX_FEE_ARC_SEPOLIA).toString());
    assert.deepEqual(planned.preview?.venueFees?.map((fee) => fee.amount), ["94829"], "0 bps on the sandbox Arc row: forwarding gas only");
    assert.equal(planned.preview?.approvalSpender, TESTNET_MESSENGER.toLowerCase());
    assert.ok(planned.warnings.some((warning) => /Iris sandbox/u.test(warning)), planned.warnings.join(" | "));
    assert.ok(planned.warnings.some((warning) => /Arc Testnet pays gas in USDC/u.test(warning)), planned.warnings.join(" | "));
    assert.deepEqual(sandboxCalls.map((url) => `${url.pathname}?${url.searchParams}`), ["/v2/burn/USDC/fees/26/3?forward=true"]);
    assert.equal(productionCalls().length, 0, "production Iris is never asked about a testnet burn");
    assert.ok(testnetMinterReads > 0, "the burn limit is read from the testnet TokenMinter");

    const prepared = await cctpV2Adapter.prepare(prepareContext(action));
    const [approve, burn] = prepared.transactions as [TransactionRequest, TransactionRequest];
    assert.ok(approve.vm === "evm" && burn.vm === "evm");
    assert.equal(approve.chainId, 5042002);
    assert.equal(approve.to.toLowerCase(), ARC_USDC);
    assert.equal(approve.data, `0x095ea7b3${TESTNET_MESSENGER.slice(2).toLowerCase().padStart(64, "0")}${AMOUNT.toString(16).padStart(64, "0")}`);
    assert.equal(burn.to, TESTNET_MESSENGER);
    assert.equal(burn.value, "0");
  });

  it("Arbitrum Sepolia -> Arc: 1.3 bps rounded up plus forwarding, exact burn to domain 26", async () => {
    const planned = await cctpV2Adapter.plan(sepoliaToArc());
    assert.equal(planned.minimumOutput.amount, (AMOUNT - MAX_FEE_SEPOLIA_ARC).toString());
    assert.deepEqual(planned.preview?.venueFees?.map((fee) => fee.amount), ["130", "22214"]);
    assert.ok(!planned.warnings.some((warning) => /Arc Testnet pays gas/u.test(warning)), "the Arc gas note is for Arc origins");
    const prepared = await cctpV2Adapter.prepare(prepareContext(sepoliaToArc()));
    const burn = prepared.transactions[1];
    assert.ok(burn?.vm === "evm");
    assert.equal(burn.chainId, 421614);
    const decoded = decodeFunctionData({ abi: TOKEN_MESSENGER_V2_ABI, data: burn.data as Hex });
    assert.equal(decoded.functionName, "depositForBurnWithHook");
    assert.deepEqual(decoded.args, [AMOUNT, 26, word(EVM_ADDRESS), getAddress(SEPOLIA_USDC), `0x${"00".repeat(32)}`, MAX_FEE_SEPOLIA_ARC, 1000, CCTP_FORWARD_HOOK]);
    assert.equal(productionCalls().length, 0);
  });

  it("Arbitrum Sepolia -> Solana Devnet mints into the recipient's existing devnet USDC account", async () => {
    assert.match(await errorOf(() => cctpV2Adapter.plan(sepoliaToDevnet())), /^RECIPIENT_TOKEN_ACCOUNT_MISSING/u);
    const ata = await devnetUsdcAccount(SOL_ADDRESS);
    mock.solanaAccounts.set(ata, tokenAccountInfo(OTHER_SOL_ADDRESS, SOLANA_DEVNET_USDC_MINT));
    assert.match(await errorOf(() => cctpV2Adapter.plan(sepoliaToDevnet())), /^ROUTE_UNAVAILABLE.*not a standard USDC account/u);
    mock.solanaAccounts.set(ata, tokenAccountInfo(SOL_ADDRESS, SOLANA_DEVNET_USDC_MINT));
    const planned = await cctpV2Adapter.plan(sepoliaToDevnet());
    assert.equal(planned.minimumOutput.amount, (AMOUNT - MAX_FEE_SEPOLIA_DEVNET).toString());
    assert.ok(planned.warnings.some((warning) => warning.includes(ata)));
    const prepared = await cctpV2Adapter.prepare(prepareContext(sepoliaToDevnet()));
    const burn = prepared.transactions[1];
    assert.ok(burn?.vm === "evm");
    const decoded = decodeFunctionData({ abi: TOKEN_MESSENGER_V2_ABI, data: burn.data as Hex });
    assert.deepEqual(decoded.args.slice(0, 3), [AMOUNT, 5, svmWord(ata)], "domain 5, minted into the devnet USDC token account");
    assert.ok(sandboxCalls.some((url) => url.pathname === "/v2/burn/USDC/fees/3/5"));
    assert.equal(productionCalls().length, 0, "3/5 is also Arbitrum -> Solana on production; the sandbox row is the one used");
  });

  it("Arc -> Solana Devnet is served on the 26/5 sandbox row", async () => {
    mock.solanaAccounts.set(await devnetUsdcAccount(SOL_ADDRESS), tokenAccountInfo(SOL_ADDRESS, SOLANA_DEVNET_USDC_MINT));
    const planned = await cctpV2Adapter.plan(arcToDevnet());
    assert.equal(planned.minimumOutput.amount, (AMOUNT - 129_934n).toString());
  });

  it("mainnet routes keep the production Iris", async () => {
    await cctpV2Adapter.plan(bridgeAction("base", "arbitrum", { amount: "100000000" }));
    assert.equal(sandboxCalls.length, 0);
    assert.ok(productionCalls().some((url) => url.pathname === "/v2/burn/USDC/fees/6/3"));
  });
});

describe("CCTP V2 testnet verification and settlement", () => {
  it("Arbitrum Sepolia -> Arc: proven on the testnet contracts, attested by the sandbox, settled on Arc's USDC credit", async () => {
    const action = sepoliaToArc({ recipient: OTHER_EVM_ADDRESS });
    const prepared = await cctpV2Adapter.prepare(prepareContext(action));
    const burnTx = prepared.transactions[1];
    assert.ok(burnTx?.vm === "evm");
    const data = burnTx.data as Hex;
    const mintRecipient = word(OTHER_EVM_ADDRESS);
    const sent = (overrides: Partial<Parameters<typeof cctpMessage>[0]> = {}) => testnetMessage({
      sourceDomain: 3, destinationDomain: 26, amount: AMOUNT, mintRecipient, messageSender: EVM_ADDRESS, maxFee: MAX_FEE_SEPOLIA_ARC, burnToken: SEPOLIA_USDC, ...overrides,
    });
    assert.equal(decodeCctpMessage(sent())?.sender, word(TESTNET_MESSENGER));
    const depositLog = { ...depositForBurnLog(data, EVM_ADDRESS), address: TESTNET_MESSENGER };
    const minimum = (AMOUNT - MAX_FEE_SEPOLIA_ARC).toString();

    // Logs from the mainnet contracts (same calldata) do not prove a testnet burn.
    const mainnetLogs = landPrepared(mock.rpc, prepared.transactions, [depositForBurnLog(data, EVM_ADDRESS), messageSentLog(sent())]);
    const mainnetStep = evmBridgeStep(action, "cctp-v2", prepared.transactions, { minimum });
    assert.equal(code(await cctpV2Adapter.verify({ step: mainnetStep, references: mainnetLogs, submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 })), "OUTCOME_NOT_PROVEN");

    const references = landPrepared(mock.rpc, prepared.transactions, [depositLog, messageSentLog(sent(), TESTNET_TRANSMITTER)]);
    const step = evmBridgeStep(action, "cctp-v2", prepared.transactions, { minimum, references });
    assert.equal(code(await cctpV2Adapter.verify({ step: { ...step, status: "submitted" }, references, submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 })), "confirmed");

    const burnHash = (references[references.length - 1] as string).toLowerCase();
    const poll = () => cctpV2Adapter.poll?.(step, Date.now());
    assert.equal(code(await poll()), "settling", "not indexed by the sandbox yet");
    // Production Iris answering for this hash is never consulted.
    mock.irisMessages.set(burnHash, { messages: [{ message: sent({ nonce: `0x${"11".repeat(32)}`, feeExecuted: 1n }), status: "complete", forwardState: "COMPLETE", forwardTxHash: randomEvmHash() }] });
    assert.equal(code(await poll()), "settling");
    assert.ok(sandboxCalls.some((url) => url.pathname === "/v2/messages/3" && url.searchParams.get("transactionHash")?.toLowerCase() === burnHash));
    assert.equal(productionCalls().filter((url) => url.pathname.startsWith("/v2/messages")).length, 0);

    const nonce = `0x${"5a".repeat(32)}` as Hex;
    const attested = sent({ nonce, feeExecuted: MAX_FEE_SEPOLIA_ARC });
    const forward = randomEvmHash();
    sandboxMessages.set(burnHash, { messages: [{ attestation: "0x01", message: attested, eventNonce: nonce, status: "complete", forwardState: "COMPLETE", forwardTxHash: forward }] });
    assert.equal(code(await poll()), "settling", "forward not landed on Arc yet");
    mock.rpc.evm.set(forward, {
      hash: forward, from: "0x3333333333333333333333333333333333333333", to: TESTNET_TRANSMITTER, input: "0x", value: 0n, chainId: 5042002,
      status: "success", blockNumber: 9_300n, timestamp: seconds(PREPARED_AT) + 40, logs: [transferLog(ARC_USDC, OTHER_EVM_ADDRESS, AMOUNT - MAX_FEE_SEPOLIA_ARC)],
    });
    const settled = await poll();
    assert.equal(settled?.status, "settled", JSON.stringify(settled));
    assert.equal(settled?.status === "settled" ? settled.actualOutput?.amount : null, minimum);
    assert.equal(settled?.evidence[0]?.reference, forward);
    assert.equal(settled?.evidence[0]?.network, "arc");
  });

  it("a settling step whose destination sits on the other lane never polls Iris", async () => {
    const action = sepoliaToArc();
    const prepared = await cctpV2Adapter.prepare(prepareContext(action));
    const references = landPrepared(mock.rpc, prepared.transactions, []);
    const step = evmBridgeStep(action, "cctp-v2", prepared.transactions, { references });
    const forged: IntentStep = { ...step, settlement: { kind: "cross-network", destinationNetwork: "arbitrum" } };
    assert.equal(code(await cctpV2Adapter.poll?.(forged, Date.now())), "STEP_INVALID");
    assert.equal(sandboxCalls.filter((url) => url.pathname.startsWith("/v2/messages")).length + productionCalls().length, 0);
  });
});
