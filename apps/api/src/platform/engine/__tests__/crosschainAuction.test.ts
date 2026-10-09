/**
 * The cross-network auction with the real Relay, LI.FI and deBridge DLN
 * adapters against mocked providers: every venue runs its full quote checks
 * and the winner is the highest guaranteed output net of extra costs (DLN's
 * fixed fee), within the time limit.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { CHAINS } from "@kletia/core";
import { resetDlnFixFeeCache, debridgeDlnAdapter } from "../adapters/debridge.js";
import { lifiAdapter } from "../adapters/lifi.js";
import { resetLifiClient } from "../adapters/lifiClient.js";
import { relayAdapter } from "../adapters/relay.js";
import type { AdapterAction } from "../adapters/types.js";
import { runVenueAuction } from "../auction.js";
import {
  bridgeAction,
  dlnEvmCall,
  dlnOrderBody,
  dlnSolanaArgs,
  dlnSolanaTransaction,
  dlnStateInfo,
  DLN_SOLANA_STATE,
  ETH_PROXY_MINT,
  installCrossChainMock,
  lifiQuoteBody,
  RELAY_DEPOSITORY,
  RELAY_SOLANA_DEPOSITORY,
  tokenAccountInfo,
  USDC_SOL,
  type CrossChainMock,
} from "./crosschainFixtures.js";
import { EVM_ADDRESS, SOL_ADDRESS } from "./helpers.js";

const VENUES = [relayAdapter, lifiAdapter, debridgeDlnAdapter];
const OPTIONS = { maxSeconds: 600, explicitMaxSeconds: false, prefer: [] };

let mock: CrossChainMock;

beforeEach(() => {
  mock = installCrossChainMock();
  resetLifiClient();
  resetDlnFixFeeCache();
  mock.prices.set(ETH_PROXY_MINT, 2_500);
  mock.solanaAccounts.set(DLN_SOLANA_STATE, dlnStateInfo());
});

afterEach(() => {
  mock.restore();
});

/** Relay answers with a pinned depository deposit guaranteeing `minimum`. */
function relayQuotes(action: AdapterAction, minimum: string) {
  const chainId = CHAINS[action.network].settlement.relayChainId as number;
  mock.rpc.relayQuote = (body) => ({
    steps: [{
      id: "deposit",
      kind: "transaction",
      requestId: `0x${"12".repeat(32)}`,
      items: [{
        status: "incomplete",
        data: CHAINS[action.network].vm === "svm"
          ? { instructions: [{ programId: RELAY_SOLANA_DEPOSITORY, keys: [{ pubkey: SOL_ADDRESS, isSigner: true, isWritable: true }], data: "0b9c60da" }], addressLookupTableAddresses: [] }
          : {
              from: EVM_ADDRESS,
              to: RELAY_DEPOSITORY,
              data: encodeFunctionData({
                abi: parseAbi(["function depositErc20(address depositor, address token, uint256 amount, bytes32 id)"]),
                functionName: "depositErc20",
                args: [EVM_ADDRESS, action.input.address as Hex, BigInt(action.amount), `0x${"34".repeat(32)}`],
              }),
              value: "0",
              chainId,
            },
      }],
    }],
    fees: { gas: { amountUsd: "0.01" } },
    details: {
      recipient: body.recipient,
      currencyIn: { currency: { chainId: body.originChainId, address: body.originCurrency, decimals: 6, symbol: "USDC" }, amount: action.amount },
      // Quoted amount consistent with the 50 bps slippage floor Relay is held to.
      currencyOut: { currency: { chainId: body.destinationChainId, address: body.destinationCurrency, decimals: 6, symbol: "USDC" }, amount: ((BigInt(minimum) * 10_000n) / 9_950n).toString(), minimumAmount: minimum },
      timeEstimate: 2,
    },
  });
}

function dlnQuotes(action: AdapterAction, takeAmount: bigint) {
  if (CHAINS[action.network].vm === "svm") {
    const data = dlnSolanaTransaction(action, dlnSolanaArgs(action, { takeAmount }));
    mock.dlnOrder = () => dlnOrderBody(action, { data }, { takeAmount });
    return;
  }
  const { data } = dlnEvmCall(action, { takeAmount });
  mock.dlnOrder = () => dlnOrderBody(action, { data }, { takeAmount });
}

describe("cross-network auction across Relay, LI.FI and deBridge DLN", () => {
  it("picks the highest guaranteed output net of DLN's fixed fee (Base -> Arbitrum, 25 USDC)", async () => {
    const action = bridgeAction("base", "arbitrum");
    relayQuotes(action, "24849594");
    mock.lifiQuote = () => lifiQuoteBody(action);
    dlnQuotes(action, 24_669_417n);
    const result = await runVenueAuction(VENUES, action, OPTIONS);
    assert.equal(result.winner.protocol, "lifi");
    assert.deepEqual(result.losers.map((quote) => quote.protocol), ["relay", "debridge-dln"]);
    const dln = result.losers.find((quote) => quote.protocol === "debridge-dln");
    // 24.657082 USDC (24.669417 minus the 5 bps re-quote cushion) minus 0.001 ETH at $2,500 = 22.157082 USDC net
    // (USD values are rounded to cents, hence the tolerance).
    const net = dln?.netMinimum ?? 0n;
    assert.ok(net > 22_157_000n && net < 22_157_500n, String(net));
    assert.equal(result.failures.length, 0);
  });

  it("lets DLN win at size, when its exact take still beats the others after the fixed fee", async () => {
    // 10,000 USDC: DLN takes 9,990 (10 bps) and charges $2.50; LI.FI keeps 0.25%; Relay guarantees 9,950.
    const action = bridgeAction("base", "arbitrum", { amount: "10000000000" });
    relayQuotes(action, "9950000000");
    mock.lifiQuote = () => lifiQuoteBody(action);
    dlnQuotes(action, 9_990_000_000n);
    const result = await runVenueAuction(VENUES, action, OPTIONS);
    assert.equal(result.winner.protocol, "debridge-dln");
    // 9,990 minus the 5 bps cushion (9,985.005) minus $2.50 = 9,982.505 USDC net.
    const net = result.winner.netMinimum ?? 0n;
    assert.ok(net > 9_982_400_000n && net < 9_982_600_000n, String(net));
    assert.deepEqual(result.losers.map((quote) => quote.protocol), ["lifi", "relay"]);
  });

  it("keeps planning when a venue fails its checks or is unreachable", async () => {
    const action = bridgeAction("base", "arbitrum");
    relayQuotes(action, "24849594");
    mock.lifiQuote = () => lifiQuoteBody(action, { to: "0x1111111111111111111111111111111111111111" });
    dlnQuotes(action, 24_669_417n);
    mock.dlnFixFee = 2n;
    const result = await runVenueAuction(VENUES, action, OPTIONS);
    assert.equal(result.winner.protocol, "relay");
    assert.deepEqual(result.failures.map((failure) => [failure.protocol, failure.error.code]).sort(), [
      ["debridge-dln", "PROVIDER_TRANSACTION_INVALID"],
      ["lifi", "PROVIDER_TRANSACTION_INVALID"],
    ]);
  });

  it("excludes LI.FI's 18-minute CCTP route under the default time limit and lets it win when allowed (Base -> Solana)", async () => {
    const action = bridgeAction("base", "solana");
    const [ata] = await findAssociatedTokenPda({ owner: address(SOL_ADDRESS), mint: address(USDC_SOL), tokenProgram: TOKEN_PROGRAM_ADDRESS });
    mock.solanaAccounts.set(String(ata), tokenAccountInfo(SOL_ADDRESS, USDC_SOL));
    relayQuotes(action, "24847531");
    mock.lifiQuote = () => lifiQuoteBody(action, { tool: "polymerStandard", solanaAta: String(ata) });
    dlnQuotes(action, 24_002_368n);
    const fast = await runVenueAuction(VENUES, action, OPTIONS);
    assert.equal(fast.winner.protocol, "relay");
    assert.equal(fast.losers.find((quote) => quote.protocol === "lifi")?.excluded, "slow");
    const patient = await runVenueAuction(VENUES, action, { ...OPTIONS, maxSeconds: 3_600, explicitMaxSeconds: true });
    assert.equal(patient.winner.protocol, "lifi");
  });

  it("excludes a DLN order whose fixed fee cannot be priced (Solana -> Base without a SOL price)", async () => {
    const action = bridgeAction("solana", "base");
    assert.equal(lifiAdapter.supports(action), false);
    relayQuotes(action, "24848499");
    dlnQuotes(action, 24_990_000n);
    const result = await runVenueAuction([relayAdapter, debridgeDlnAdapter], action, OPTIONS);
    assert.equal(result.winner.protocol, "relay");
    assert.equal(result.losers[0]?.protocol, "debridge-dln");
    assert.equal(result.losers[0]?.excluded, "unpriced");
  });
});
