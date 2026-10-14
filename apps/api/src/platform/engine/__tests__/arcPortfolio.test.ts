/**
 * The Arc console portfolio during a price-source outage: the lending pool's
 * healthFactor read reverts when its oracle does not answer. The portfolio
 * still answers with every balance and reports the health factor as
 * unavailable (null), while any other failed read still fails the whole read
 * (no balance is ever made up). Runs against a stubbed Arc client.
 *
 *   cd apps/api && node --import tsx --test src/platform/engine/__tests__/arcPortfolio.test.ts
 */
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

// The legacy vault mode needs no runtime code hash: set before the Arc configuration loads.
process.env.ARC_VAULT_EXECUTION_MODE = "legacy_v1";

const { arcPublicClient, ARC_CONTRACTS } = await import("../../../shared/config/networks.js");
const { getArcPortfolio } = await import("../../../networks/arc/handlers.js");

const USER = "0x8e34897f35891e8de1dad2801dcd0660865f76fe";
const E18 = 10n ** 18n;

function revert(functionName: string): Error {
  return Object.assign(new Error(`The contract function "${functionName}" reverted with the following reason:\noracle unavailable`), {
    name: "ContractFunctionExecutionError",
  });
}

/** Answers every read of getArcPortfolio; `fail` names reads that revert. */
function stubArc(context: TestContext, fail: readonly string[] = []): string[] {
  const reads: string[] = [];
  context.mock.method(arcPublicClient, "getBlockNumber", async () => 4_242n);
  context.mock.method(arcPublicClient, "getBalance", async () => 5n * E18);
  context.mock.method(arcPublicClient, "readContract", async (call: { address: string; functionName: string; blockNumber?: bigint }) => {
    reads.push(call.functionName);
    assert.equal(call.blockNumber, 4_242n, `${call.functionName} is read at the observed block`);
    if (fail.includes(call.functionName)) throw revert(call.functionName);
    switch (call.functionName) {
      case "balanceOf":
        return 7n * E18;
      case "deposits":
        return [E18, 1_700_000_000n, E18 / 10n];
      case "pendingInterest":
        return E18 / 100n;
      case "getStakerInfo":
        return [3n * E18, 1_700_000_000n, 0n, E18, 1_700_000_100n, 0n];
      case "pendingRewards":
        return E18 / 50n;
      case "collateralBalance":
        return 10n * E18;
      case "getBorrowedBalance":
        return 2n * E18;
      case "getSuppliedBalance":
        return 0n;
      case "healthFactor":
        return (3n * E18) / 2n;
      default:
        throw new Error(`unexpected read ${call.functionName}`);
    }
  });
  return reads;
}

describe("Arc portfolio health factor", () => {
  it("is null (unavailable) when the oracle-priced read reverts, and every balance is still reported", async (context) => {
    const reads = stubArc(context, ["healthFactor"]);
    const result = await getArcPortfolio(USER);
    assert.ok(reads.includes("healthFactor"));
    const { lending, staking, wallet, vault, observedAtBlock } = result.data;
    assert.equal(lending.healthFactor, null);
    assert.equal(lending.healthAvailability, "unavailable");
    assert.equal(lending.collateralKLET, "10");
    assert.equal(lending.borrowedUSDC, "2");
    assert.equal(lending.suppliedUSDC, "0");
    assert.equal(staking.stakedAmount, "3");
    assert.equal(staking.pendingUnstake, "1");
    assert.deepEqual(wallet.map((asset) => [asset.symbol, asset.formatted]), [["USDC", "5"], ["KLET", "7"]]);
    assert.equal(vault.principal, "1");
    assert.equal(vault.address, ARC_CONTRACTS.Vault);
    assert.equal(observedAtBlock, "4242");
  });

  it("is formatted when the read answers", async (context) => {
    stubArc(context);
    const { lending } = (await getArcPortfolio(USER)).data;
    assert.equal(lending.healthFactor, "1.5");
    assert.equal(lending.healthAvailability, "available");
  });

  it("still fails the whole read when a balance cannot be read (nothing is made up)", async (context) => {
    stubArc(context, ["collateralBalance"]);
    await assert.rejects(getArcPortfolio(USER), /collateralBalance/u);
  });
});
