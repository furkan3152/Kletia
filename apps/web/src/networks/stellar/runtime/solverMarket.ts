import {
  Address,
  StrKey,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

import { prepareStellarContractCall } from "./cctp";

type Hex32 = `0x${string}`;

export interface SolverBidSecretV1 {
  readonly schemaVersion: "kletia_solver_bid_secret_v1";
  readonly auctionContract: string;
  readonly workflowRoot: Hex32;
  readonly solver: string;
  readonly routeHash: Hex32;
  readonly quoteEvidenceHash: Hex32;
  readonly promisedOutputAtomic: string;
  readonly solverFeeAtomic: string;
  readonly durationSeconds: number;
  readonly quoteExpiresAtLedger: number;
  readonly salt: Hex32;
}

export interface PreparedSolverMarketXdrV1 {
  readonly schemaVersion: "kletia_solver_market_prepared_xdr_v1";
  readonly operation:
    | "auction_open"
    | "solver_register"
    | "solver_bond_lock"
    | "solver_bid_commit"
    | "solver_bid_reveal"
    | "auction_finalize"
    | "auction_expire_unsettled"
    | "solver_bond_reclaim";
  readonly source: string;
  readonly contractId: string;
  readonly xdr: string;
  readonly publicDisclosure: readonly string[];
  readonly enforcingSimulationPassed: true;
}

export interface CompetitiveWorkflowPlanV3 {
  readonly version: 3;
  readonly schemaVersion: "kletia_workflow_plan_v3";
  readonly lane: "testnet";
  readonly expiresAt: number;
  readonly walletBindings: readonly {
    readonly family: "stellar" | "evm";
    readonly network?: "testnet" | "public";
    readonly address: string;
  }[];
  readonly coordinationMarket: {
    readonly required: true;
    readonly mode: "stellar_commit_reveal_auction";
    readonly network: "stellar_testnet";
    readonly status: "auction_open_required" | "awaiting_bids";
    readonly auctionRoot: Hex32;
    readonly constraintsHash: Hex32;
    readonly contracts: {
      readonly bondVault: string;
      readonly routeAuction: string;
    };
  };
}

function exactBytes(value: string, length: number, field: string): Uint8Array {
  if (!new RegExp(`^0x[a-f\\d]{${length * 2}}$`, "iu").test(value)) {
    throw new Error(`${field} must be exact ${length}-byte hex.`);
  }
  return Uint8Array.from(
    value.slice(2).match(/.{2}/gu)?.map((entry) => Number.parseInt(entry, 16)) ?? [],
  );
}

function exactHash(value: string, field: string): Hex32 {
  exactBytes(value, 32, field);
  if (/^0x0{64}$/u.test(value)) throw new Error(`${field} cannot be zero.`);
  return value.toLowerCase() as Hex32;
}

function positiveAtomic(value: string, field: string): bigint {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${field} must be a positive atomic integer.`);
  const parsed = BigInt(value);
  if (parsed > ((1n << 127n) - 1n)) throw new Error(`${field} exceeds Soroban i128.`);
  return parsed;
}

function nonNegativeAtomic(value: string, field: string): bigint {
  if (!/^\d+$/u.test(value)) throw new Error(`${field} must be a non-negative atomic integer.`);
  const parsed = BigInt(value);
  if (parsed > ((1n << 127n) - 1n)) throw new Error(`${field} exceeds Soroban i128.`);
  return parsed;
}

function u32(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${field} must be a Soroban uint32.`);
  }
  return value;
}

function u64(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return BigInt(value);
}

function assertAccount(value: string, field: string): string {
  if (!StrKey.isValidEd25519PublicKey(value)) {
    throw new Error(`${field} must be a Stellar G-account.`);
  }
  return value;
}

function assertContract(value: string, field: string): string {
  if (!StrKey.isValidContract(value)) throw new Error(`${field} must be a Stellar contract ID.`);
  return value;
}

async function sha256(payload: Uint8Array): Promise<Hex32> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
  return `0x${Array.from(digest, (entry) => entry.toString(16).padStart(2, "0")).join("")}`;
}

function bytes32ScVal(value: string, field: string): xdr.ScVal {
  return xdr.ScVal.scvBytes(exactBytes(exactHash(value, field), 32, field));
}

function structScVal(fields: Readonly<Record<string, xdr.ScVal>>): xdr.ScVal {
  const entries = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol(key),
      val: value,
    }));
  return xdr.ScVal.scvMap(entries);
}

/**
 * Reproduces `BidCommitmentPreimage::to_xdr` and the two SHA-256 operations in
 * `KletiaRouteAuction` locally. Calling the contract's public
 * `compute_commitment` getter before commit would disclose the secret bid to
 * the RPC provider and defeats commit-reveal privacy, so the browser must
 * never use that RPC shortcut.
 */
export async function computeSolverBidCommitment(
  secret: SolverBidSecretV1,
): Promise<Hex32> {
  if (secret.schemaVersion !== "kletia_solver_bid_secret_v1") {
    throw new Error("Unsupported solver bid secret schema.");
  }
  const auctionContract = assertContract(secret.auctionContract, "auctionContract");
  const solver = assertAccount(secret.solver, "solver");
  const domainHash = await sha256(new TextEncoder().encode("KLETIA_ROUTE_BID_V1"));
  const preimage = structScVal({
    auction_contract: new Address(auctionContract).toScVal(),
    domain_hash: bytes32ScVal(domainHash, "domainHash"),
    duration_seconds: nativeToScVal(u64(secret.durationSeconds, "durationSeconds"), { type: "u64" }),
    promised_output: nativeToScVal(positiveAtomic(secret.promisedOutputAtomic, "promisedOutputAtomic"), { type: "i128" }),
    quote_evidence_hash: bytes32ScVal(secret.quoteEvidenceHash, "quoteEvidenceHash"),
    quote_expires_at_ledger: nativeToScVal(u32(secret.quoteExpiresAtLedger, "quoteExpiresAtLedger"), { type: "u32" }),
    route_hash: bytes32ScVal(secret.routeHash, "routeHash"),
    salt: bytes32ScVal(secret.salt, "salt"),
    solver: new Address(solver).toScVal(),
    solver_fee: nativeToScVal(nonNegativeAtomic(secret.solverFeeAtomic, "solverFeeAtomic"), { type: "i128" }),
    workflow_root: bytes32ScVal(secret.workflowRoot, "workflowRoot"),
  });
  return sha256(xdr.ScVal.schema.encode(preimage.toXdrObject()));
}

export function createSolverBidSalt(): Hex32 {
  const value = crypto.getRandomValues(new Uint8Array(32));
  if (value.every((entry) => entry === 0)) value[0] = 1;
  return `0x${Array.from(value, (entry) => entry.toString(16).padStart(2, "0")).join("")}`;
}

function stellarOwner(plan: CompetitiveWorkflowPlanV3): string {
  const binding = plan.walletBindings.find(
    (entry) => entry.family === "stellar" && entry.network === "testnet",
  );
  return assertAccount(binding?.address ?? "", "workflow Stellar owner");
}

function assertCompetitivePlan(plan: CompetitiveWorkflowPlanV3, owner: string): void {
  if (
    plan.version !== 3 ||
    plan.schemaVersion !== "kletia_workflow_plan_v3" ||
    plan.lane !== "testnet" ||
    plan.expiresAt <= Date.now() ||
    !plan.coordinationMarket.required ||
    plan.coordinationMarket.mode !== "stellar_commit_reveal_auction" ||
    plan.coordinationMarket.network !== "stellar_testnet" ||
    plan.coordinationMarket.status !== "auction_open_required" ||
    stellarOwner(plan) !== owner ||
    !StrKey.isValidContract(plan.coordinationMarket.contracts.routeAuction) ||
    !StrKey.isValidContract(plan.coordinationMarket.contracts.bondVault)
  ) {
    throw new Error("The competitive workflow is expired, unbound or not ready to open.");
  }
}

async function prepared(input: {
  operation: PreparedSolverMarketXdrV1["operation"];
  source: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  publicDisclosure: readonly string[];
}): Promise<PreparedSolverMarketXdrV1> {
  const source = assertAccount(input.source, "source");
  const contractId = assertContract(input.contractId, "contractId");
  return {
    schemaVersion: "kletia_solver_market_prepared_xdr_v1",
    operation: input.operation,
    source,
    contractId,
    xdr: await prepareStellarContractCall({
      source,
      contractId,
      method: input.method,
      args: input.args,
    }),
    publicDisclosure: input.publicDisclosure,
    enforcingSimulationPassed: true,
  };
}

export async function prepareRouteAuctionOpen(input: {
  readonly plan: CompetitiveWorkflowPlanV3;
  readonly owner: string;
  readonly minimumOutputAtomic: string;
  readonly maximumSolverFeeAtomic: string;
  readonly maximumDurationSeconds: number;
  readonly minimumBondAtomic: string;
  readonly commitDeadlineLedger: number;
  readonly revealDeadlineLedger: number;
  readonly settlementDeadlineLedger: number;
}): Promise<PreparedSolverMarketXdrV1> {
  const owner = assertAccount(input.owner, "owner");
  assertCompetitivePlan(input.plan, owner);
  const commitDeadline = u32(input.commitDeadlineLedger, "commitDeadlineLedger");
  const revealDeadline = u32(input.revealDeadlineLedger, "revealDeadlineLedger");
  const settlementDeadline = u32(input.settlementDeadlineLedger, "settlementDeadlineLedger");
  if (!(commitDeadline < revealDeadline && revealDeadline < settlementDeadline)) {
    throw new Error("Auction ledger deadlines must be strictly ordered.");
  }
  return prepared({
    operation: "auction_open",
    source: owner,
    contractId: input.plan.coordinationMarket.contracts.routeAuction,
    method: "open",
    args: [
      new Address(owner).toScVal(),
      bytes32ScVal(input.plan.coordinationMarket.auctionRoot, "auctionRoot"),
      bytes32ScVal(input.plan.coordinationMarket.constraintsHash, "constraintsHash"),
      nativeToScVal(positiveAtomic(input.minimumOutputAtomic, "minimumOutputAtomic"), { type: "i128" }),
      nativeToScVal(nonNegativeAtomic(input.maximumSolverFeeAtomic, "maximumSolverFeeAtomic"), { type: "i128" }),
      nativeToScVal(u64(input.maximumDurationSeconds, "maximumDurationSeconds"), { type: "u64" }),
      nativeToScVal(positiveAtomic(input.minimumBondAtomic, "minimumBondAtomic"), { type: "i128" }),
      nativeToScVal(commitDeadline, { type: "u32" }),
      nativeToScVal(revealDeadline, { type: "u32" }),
      nativeToScVal(settlementDeadline, { type: "u32" }),
    ],
    publicDisclosure: [
      "auction owner",
      "workflow and constraint commitments",
      "minimum output and maximum solver fee",
      "duration, bond and ledger deadlines",
    ],
  });
}

export async function prepareSolverRegistration(input: {
  readonly source: string;
  readonly bondVault: string;
  readonly metadataHash: Hex32;
  readonly amountAtomic: string;
}): Promise<PreparedSolverMarketXdrV1> {
  return prepared({
    operation: "solver_register",
    source: input.source,
    contractId: input.bondVault,
    method: "register",
    args: [
      new Address(assertAccount(input.source, "solver")).toScVal(),
      bytes32ScVal(input.metadataHash, "metadataHash"),
      nativeToScVal(positiveAtomic(input.amountAtomic, "amountAtomic"), { type: "i128" }),
    ],
    publicDisclosure: ["solver identity", "metadata commitment", "total deposited bond"],
  });
}

export async function prepareSolverBondLock(input: {
  readonly source: string;
  readonly bondVault: string;
  readonly workflowRoot: Hex32;
  readonly amountAtomic: string;
  readonly expiresAtLedger: number;
}): Promise<PreparedSolverMarketXdrV1> {
  return prepared({
    operation: "solver_bond_lock",
    source: input.source,
    contractId: input.bondVault,
    method: "lock",
    args: [
      new Address(assertAccount(input.source, "solver")).toScVal(),
      bytes32ScVal(input.workflowRoot, "workflowRoot"),
      nativeToScVal(positiveAtomic(input.amountAtomic, "amountAtomic"), { type: "i128" }),
      nativeToScVal(u32(input.expiresAtLedger, "expiresAtLedger"), { type: "u32" }),
    ],
    publicDisclosure: ["solver identity", "workflow root", "bond amount", "expiry and recovery timing"],
  });
}

export async function prepareSolverBidCommit(input: {
  readonly secret: SolverBidSecretV1;
}): Promise<PreparedSolverMarketXdrV1 & { readonly commitment: Hex32 }> {
  const commitment = await computeSolverBidCommitment(input.secret);
  const base = await prepared({
    operation: "solver_bid_commit",
    source: input.secret.solver,
    contractId: input.secret.auctionContract,
    method: "commit_bid",
    args: [
      new Address(assertAccount(input.secret.solver, "solver")).toScVal(),
      bytes32ScVal(input.secret.workflowRoot, "workflowRoot"),
      bytes32ScVal(commitment, "commitment"),
    ],
    publicDisclosure: ["solver identity", "workflow root", "opaque bid commitment"],
  });
  return { ...base, commitment };
}

export async function prepareSolverBidReveal(
  secret: SolverBidSecretV1,
): Promise<PreparedSolverMarketXdrV1> {
  return prepared({
    operation: "solver_bid_reveal",
    source: secret.solver,
    contractId: secret.auctionContract,
    method: "reveal_bid",
    args: [
      new Address(assertAccount(secret.solver, "solver")).toScVal(),
      bytes32ScVal(secret.workflowRoot, "workflowRoot"),
      bytes32ScVal(secret.routeHash, "routeHash"),
      bytes32ScVal(secret.quoteEvidenceHash, "quoteEvidenceHash"),
      nativeToScVal(positiveAtomic(secret.promisedOutputAtomic, "promisedOutputAtomic"), { type: "i128" }),
      nativeToScVal(nonNegativeAtomic(secret.solverFeeAtomic, "solverFeeAtomic"), { type: "i128" }),
      nativeToScVal(u64(secret.durationSeconds, "durationSeconds"), { type: "u64" }),
      nativeToScVal(u32(secret.quoteExpiresAtLedger, "quoteExpiresAtLedger"), { type: "u32" }),
      bytes32ScVal(secret.salt, "salt"),
    ],
    publicDisclosure: [
      "solver identity",
      "route and quote evidence hashes",
      "promised output and solver fee",
      "duration and quote expiry",
      "bid salt",
    ],
  });
}

export async function prepareRouteAuctionFinalize(input: {
  readonly source: string;
  readonly routeAuction: string;
  readonly workflowRoot: Hex32;
}): Promise<PreparedSolverMarketXdrV1> {
  return prepared({
    operation: "auction_finalize",
    source: input.source,
    contractId: input.routeAuction,
    method: "finalize",
    args: [bytes32ScVal(input.workflowRoot, "workflowRoot")],
    publicDisclosure: ["winning solver", "winning route hash", "promised net output"],
  });
}

export async function prepareAuctionExpiryRecovery(input: {
  readonly source: string;
  readonly routeAuction: string;
  readonly workflowRoot: Hex32;
  readonly recoveryHash: Hex32;
}): Promise<PreparedSolverMarketXdrV1> {
  return prepared({
    operation: "auction_expire_unsettled",
    source: input.source,
    contractId: input.routeAuction,
    method: "expire_unsettled",
    args: [
      bytes32ScVal(input.workflowRoot, "workflowRoot"),
      bytes32ScVal(input.recoveryHash, "recoveryHash"),
    ],
    publicDisclosure: ["workflow root", "recovery commitment", "NoWinner or Indeterminate state"],
  });
}

export async function prepareExpiredBondReclaim(input: {
  readonly source: string;
  readonly bondVault: string;
  readonly workflowRoot: Hex32;
  readonly recoveryHash: Hex32;
}): Promise<PreparedSolverMarketXdrV1> {
  return prepared({
    operation: "solver_bond_reclaim",
    source: input.source,
    contractId: input.bondVault,
    method: "reclaim_expired",
    args: [
      new Address(assertAccount(input.source, "solver")).toScVal(),
      bytes32ScVal(input.workflowRoot, "workflowRoot"),
      bytes32ScVal(input.recoveryHash, "recoveryHash"),
    ],
    publicDisclosure: ["solver identity", "workflow root", "recovery commitment"],
  });
}
