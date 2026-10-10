import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createServer } from "node:http";
import express from "express";
import { getAddress, type Address } from "viem";
import { ARC_LEGACY_DEFI_CONTRACTS } from "../../../networks/arc/executionEnvironment.js";
// This fixture exercises DeFi balances, independently of a real Vault V2 RPC.
// Load its configuration in explicit legacy mode before importing the client.
const originalVaultMode = process.env.ARC_VAULT_EXECUTION_MODE;
process.env.ARC_VAULT_EXECUTION_MODE = "legacy_v1";
const { readLegacyArcDefiPositions } = await import("../../../networks/arc/legacyPositions.js");
const { getArcPortfolio } = await import("../../../networks/arc/handlers.js");
const { default: arcRouter } = await import("../../../networks/arc/routes.js");
const { arcPublicClient } = await import("../../../shared/config/networks.js");
if (originalVaultMode === undefined) delete process.env.ARC_VAULT_EXECUTION_MODE;
else process.env.ARC_VAULT_EXECUTION_MODE = originalVaultMode;

const USER = getAddress("0x1111111111111111111111111111111111111111");
const V2 = getAddress("0x2222222222222222222222222222222222222222");
type Reader = NonNullable<Parameters<typeof readLegacyArcDefiPositions>[3]>;
const original = { readContract: arcPublicClient.readContract, getBalance: arcPublicClient.getBalance, getBlockNumber: arcPublicClient.getBlockNumber };
afterEach(() => Object.assign(arcPublicClient, original));

function mockOracleOutage() {
  Object.assign(arcPublicClient, {
    getBlockNumber: async () => 123n,
    getBalance: async () => 10n ** 18n,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (["healthFactor", "_getMaxBorrow", "_getKletPrice"].includes(functionName)) throw new Error("OracleObservationStale");
      if (functionName === "deposits") return [2n * 10n ** 18n, 0n, 0n];
      if (functionName === "getStakerInfo") return [2n * 10n ** 18n, 0n, 0n, 3n * 10n ** 18n, 0n, 42n];
      return 5n * 10n ** 18n;
    },
  });
}

describe("Arc historical positions after deployment changes", () => {
  it("keeps original LP, staked, pending exit, collateral and debt balances labeled by historical target", async () => {
    const requests: { address: Address; functionName: string; blockNumber: bigint }[] = [];
    const reader = { readContract: async (request: typeof requests[number]) => {
      requests.push(request);
      if (request.functionName === "getStakerInfo") return [2n * 10n ** 18n, 0n, 0n, 3n * 10n ** 18n, 0n, 42n];
      return 5n * 10n ** 18n;
    } } as unknown as Reader;
    const result = await readLegacyArcDefiPositions(USER, 123n, { swap: V2, staking: V2, lending: V2 }, reader);
    assert.equal(result.swap?.address, ARC_LEGACY_DEFI_CONTRACTS.swap);
    assert.equal(result.swap?.lpTokenBalance, "5");
    assert.equal(result.staking?.address, ARC_LEGACY_DEFI_CONTRACTS.staking);
    assert.equal(result.staking?.stakedAmount, "2");
    assert.equal(result.staking?.pendingUnstake, "3");
    assert.equal(result.staking?.cooldownRemaining, 42);
    assert.equal(result.lending?.address, ARC_LEGACY_DEFI_CONTRACTS.lending);
    assert.equal(result.lending?.borrowedUSDC, "5");
    assert.equal(result.lending?.collateralKLET, "5");
    assert.equal(result.exitProtocol, "kletia legacy");
    assert.equal(requests.length, 6);
    assert.ok(requests.every((request) => request.blockNumber === 123n));
    assert.ok(requests.every((request) => request.address !== V2));
  });

  it("avoids counting the same historical position twice when it is still the active read target", async () => {
    const reader = { readContract: async () => { throw new Error("duplicate read"); } } as unknown as Reader;
    const result = await readLegacyArcDefiPositions(USER, 123n, ARC_LEGACY_DEFI_CONTRACTS, reader);
    assert.deepEqual(result, { exitProtocol: "kletia legacy" });
  });

  it("preserves portfolio balances and explicit unavailable health during an oracle outage", async () => {
    mockOracleOutage();
    const result = await getArcPortfolio(USER);
    assert.equal(result.data.lending.collateralKLET, "5");
    assert.equal(result.data.lending.borrowedUSDC, "5");
    assert.equal(result.data.lending.suppliedUSDC, "5");
    assert.equal(result.data.lending.healthFactor, null);
    assert.equal(result.data.lending.healthAvailability, "unavailable");
    assert.equal(result.data.liquidity.lpTokenBalance, "5");
    assert.equal(result.data.staking.pendingUnstake, "3");
  });

  it("keeps the historical lending HTTP read available with null oracle metrics and rejects raw target selection", async () => {
    mockOracleOutage();
    const app = express();
    app.use(arcRouter);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/lending/user/${USER}?deployment=legacy`);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.contract, ARC_LEGACY_DEFI_CONTRACTS.lending);
      assert.equal(data.borrowedUSDC, "5");
      assert.equal(data.collateralKLET, "5");
      assert.equal(data.suppliedUSDC, "5");
      assert.equal(data.healthFactor, null);
      assert.equal(data.maxBorrowUSDC, null);
      assert.equal(data.kletPriceUSDC, null);
      assert.equal(data.oracleAvailability, "unavailable");
      const invalid = await fetch(`http://127.0.0.1:${port}/lending/user/${USER}?deployment=${V2}`);
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).code, "INVALID_DEPLOYMENT");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
