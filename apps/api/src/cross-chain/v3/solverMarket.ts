import {
  Address,
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { STELLAR_TESTNET } from "../../networks/stellar/config.js";
import { readStellarSolverMarketReadiness } from "../../networks/stellar/solverMarketReadiness.js";
import { CHAINS_V3 } from "./chains.js";
import type { WorkflowEvidenceV3, WorkflowPlanV3 } from "./types.js";

function controlled(code: string, message: string, statusCode = 409, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}

function hex32Bytes(value: string, field: string): Uint8Array {
  if (!/^0x[a-f\d]{64}$/iu.test(value)) {
    throw controlled("WORKFLOW_V3_SOLVER_MARKET_HASH_INVALID", `${field} is not an exact 32-byte hash.`);
  }
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function bytes32Hex(value: unknown, field: string): `0x${string}` {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw controlled("WORKFLOW_V3_SOLVER_MARKET_STATE_INVALID", `${field} is not an exact onchain bytes32 value.`, 503);
  }
  return `0x${Buffer.from(value).toString("hex")}`;
}

function enumCase(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1) return keys[0] ?? "";
  }
  return "";
}

async function simulateContractCall(input: {
  readonly source: string;
  readonly contractId: string;
  readonly method: string;
  readonly args: readonly xdr.ScVal[];
}): Promise<{ readonly value: unknown; readonly latestLedger: number }> {
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 10_000 });
  const account = await server.getAccount(input.source);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  })
    .addOperation(new Contract(input.contractId).call(input.method, ...input.args))
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (
    !rpc.Api.isSimulationSuccess(simulation) ||
    rpc.Api.isSimulationRestore(simulation) ||
    !simulation.result
  ) {
    throw controlled(
      "WORKFLOW_V3_SOLVER_MARKET_READ_FAILED",
      `The exact ${input.method} state could not be simulated without restoration.`,
      503,
    );
  }
  return {
    value: scValToNative(simulation.result.retval) as unknown,
    latestLedger: simulation.latestLedger,
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw controlled(
      "WORKFLOW_V3_SOLVER_MARKET_STATE_INVALID",
      `${field} did not return a contract record.`,
      503,
    );
  }
  return value as Record<string, unknown>;
}

export async function assertSolverAuctionNotOpenedV3(
  plan: WorkflowPlanV3,
): Promise<void> {
  if (!plan.coordinationMarket.required) return;
  if (
    plan.lane !== "testnet" ||
    plan.coordinationMarket.status !== "auction_open_required" ||
    plan.coordinationMarket.winner ||
    plan.selectedRouteId !== null
  ) {
    throw controlled(
      "WORKFLOW_V3_ROUTE_QUOTE_FROZEN",
      "Solver route quotes cannot change after auction selection or outside the unopened Testnet market state.",
    );
  }
  const readiness = await readStellarSolverMarketReadiness("testnet");
  const source = process.env.STELLAR_CONTROL_PLANE_READ_SOURCE_ACCOUNT?.trim() || "";
  const auctionContract = readiness.contracts.find((entry) => entry.key === "routeAuction");
  if (
    !readiness.ready ||
    !auctionContract?.ready ||
    !auctionContract.contractId ||
    !StrKey.isValidEd25519PublicKey(source)
  ) {
    throw controlled(
      "WORKFLOW_V3_SOLVER_MARKET_NOT_READY",
      "The live route quote cannot be rebound without the attested Stellar auction deployment.",
      503,
    );
  }
  const existing = await simulateContractCall({
    source,
    contractId: auctionContract.contractId,
    method: "get",
    args: [xdr.ScVal.scvBytes(hex32Bytes(plan.coordinationMarket.auctionRoot, "auctionRoot"))],
  });
  if (existing.value !== null && existing.value !== undefined) {
    throw controlled(
      "WORKFLOW_V3_SOLVER_AUCTION_ALREADY_OPEN",
      "This exact auction root already exists on Stellar; its quote and constraints are immutable.",
    );
  }
}

export async function verifyAndBindSolverAuctionWinnerV3(
  plan: WorkflowPlanV3,
): Promise<{
  readonly plan: WorkflowPlanV3;
  readonly evidence: WorkflowEvidenceV3;
}> {
  if (
    !plan.coordinationMarket.required ||
    plan.coordinationMarket.mode !== "stellar_commit_reveal_auction" ||
    (plan.coordinationMarket.status !== "auction_open_required" &&
      plan.coordinationMarket.status !== "awaiting_bids") ||
    plan.selectedRouteId !== null ||
    plan.expiresAt <= Date.now()
  ) {
    throw controlled(
      "WORKFLOW_V3_SOLVER_MARKET_NOT_BINDABLE",
      "This workflow is expired, already selected, or not waiting for a competitive Stellar route.",
    );
  }
  if (plan.lane !== "testnet" || plan.coordinationMarket.network !== "stellar_testnet") {
    throw controlled(
      "WORKFLOW_V3_SOLVER_MARKET_LANE_UNAVAILABLE",
      "The reviewed solver market is currently limited to Stellar Testnet.",
      503,
    );
  }
  const readiness = await readStellarSolverMarketReadiness(plan.lane);
  const source = process.env.STELLAR_CONTROL_PLANE_READ_SOURCE_ACCOUNT?.trim() || "";
  const auctionContract = readiness.contracts.find((entry) => entry.key === "routeAuction");
  const vaultContract = readiness.contracts.find((entry) => entry.key === "solverBondVault");
  if (
    !readiness.ready ||
    !auctionContract?.ready ||
    !auctionContract.contractId ||
    !vaultContract?.ready ||
    !vaultContract.contractId ||
    !StrKey.isValidEd25519PublicKey(source)
  ) {
    throw controlled(
      "WORKFLOW_V3_SOLVER_MARKET_NOT_READY",
      "The exact Stellar solver-market deployment and read source are not live-attested.",
      503,
    );
  }
  const rootScVal = xdr.ScVal.scvBytes(
    hex32Bytes(plan.coordinationMarket.auctionRoot, "auctionRoot"),
  );
  const auctionRead = await simulateContractCall({
    source,
    contractId: auctionContract.contractId,
    method: "get",
    args: [rootScVal],
  });
  const auction = record(auctionRead.value, "route auction");
  const status = enumCase(auction.status);
  if (status !== "Finalized") {
    throw controlled(
      status === "NoWinner"
        ? "WORKFLOW_V3_SOLVER_MARKET_NO_WINNER"
        : "WORKFLOW_V3_SOLVER_MARKET_NOT_FINALIZED",
      status === "NoWinner"
        ? "The sealed auction ended without an eligible, live-bonded route."
        : "The sealed auction has not finalized an eligible winner yet.",
    );
  }
  const observedWorkflowRoot = bytes32Hex(auction.workflow_root, "workflow_root");
  const observedConstraints = bytes32Hex(auction.constraints_hash, "constraints_hash");
  if (
    observedWorkflowRoot !== plan.coordinationMarket.auctionRoot ||
    observedConstraints !== plan.coordinationMarket.constraintsHash
  ) {
    throw controlled(
      "WORKFLOW_V3_SOLVER_MARKET_IDENTITY_MISMATCH",
      "The finalized auction did not bind this exact workflow root and constraints hash.",
    );
  }
  const solver = String(auction.winner ?? "");
  const routeHash = bytes32Hex(auction.winning_route_hash, "winning_route_hash");
  const winningNetOutput = BigInt(String(auction.winning_net_output ?? "-1"));
  const minimumBond = BigInt(String(auction.minimum_bond ?? "-1"));
  const settlementDeadline = Number(auction.settlement_deadline_ledger);
  const route = plan.routes.find(
    (candidate) => candidate.solverRouteHash.toLowerCase() === routeHash.toLowerCase(),
  );
  if (
    (!StrKey.isValidEd25519PublicKey(solver) && !StrKey.isValidContract(solver)) ||
    !route ||
    !route.available ||
    !route.hydration ||
    route.hydration.status !== "live_quote_bound" ||
    !route.metrics.amountDependentCostsComplete ||
    route.metrics.estimatedOutputAtomic === null ||
    route.quoteExpiresAt <= Date.now() ||
    route.steps.some((step) => step.executionReadiness !== "ready") ||
    winningNetOutput < 0n ||
    minimumBond <= 0n ||
    !Number.isSafeInteger(settlementDeadline) ||
    settlementDeadline <= auctionRead.latestLedger
  ) {
    throw controlled(
      "WORKFLOW_V3_SOLVER_MARKET_WINNER_INVALID",
      "The finalized winner, executable route, fresh quote, economic result or settlement window is invalid.",
      503,
    );
  }
  const bondRead = await simulateContractCall({
    source,
    contractId: vaultContract.contractId,
    method: "bond_lock",
    args: [
      new Address(solver).toScVal(),
      rootScVal,
    ],
  });
  const bond = record(bondRead.value, "solver bond lock");
  const bondAmount = BigInt(String(bond.amount ?? "-1"));
  const bondExpiry = Number(bond.expires_at_ledger);
  const bondReclaimAfter = Number(bond.reclaim_after_ledger);
  if (
    String(bond.solver ?? "") !== solver ||
    bytes32Hex(bond.workflow_root, "bond workflow_root") !== plan.coordinationMarket.auctionRoot ||
    enumCase(bond.status) !== "Locked" ||
    bondAmount < minimumBond ||
    !Number.isSafeInteger(bondExpiry) ||
    bondExpiry < settlementDeadline ||
    !Number.isSafeInteger(bondReclaimAfter) ||
    bondReclaimAfter <= bondExpiry
  ) {
    throw controlled(
      "WORKFLOW_V3_SOLVER_BOND_INVALID",
      "The auction winner no longer has the exact live workflow bond required by the auction.",
      503,
    );
  }
  const observedAtLedger = String(Math.min(auctionRead.latestLedger, bondRead.latestLedger));
  const nextPlan: WorkflowPlanV3 = {
    ...plan,
    selectedRouteId: route.id,
    currentStepId: null,
    coordinationMarket: {
      ...plan.coordinationMarket,
      status: "winner_selected",
      winner: {
        solver,
        routeId: route.id,
        routeHash,
        netOutputAtomic: winningNetOutput.toString(),
        observedAtLedger,
      },
    },
  };
  return {
    plan: nextPlan,
    evidence: {
      stepId: "solver-market-selection",
      kind: "auction_result",
      reference: `${auctionContract.contractId}:${plan.coordinationMarket.auctionRoot}:${observedAtLedger}`,
      level: "chain_native_verified",
      observedAt: new Date().toISOString(),
      chain: CHAINS_V3.stellar_testnet,
      details: {
        auctionContract: auctionContract.contractId,
        bondVaultContract: vaultContract.contractId,
        solver,
        routeId: route.id,
        routeHash,
        winningNetOutputAtomic: winningNetOutput.toString(),
        bondAmountAtomic: bondAmount.toString(),
        bondExpiresAtLedger: bondExpiry,
        bondReclaimAfterLedger: bondReclaimAfter,
        bidCommitmentProvesQuoteTruth: false,
        foreignExecutionProven: false,
      },
    },
  };
}
