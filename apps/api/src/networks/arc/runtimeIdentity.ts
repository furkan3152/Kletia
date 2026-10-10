import { keccak256, type Address, type Hex } from "viem";
import { ARC_REVIEWED_V2_RUNTIMES } from "./reviewedRuntimePins.js";
import type { ArcDefiProtocol, ArcReviewedDeployment } from "./executionEnvironment.js";

export class ArcDefiReadinessError extends Error {
  readonly statusCode = 503;
  constructor(readonly code: "ARC_DEFI_V2_NOT_CONFIGURED" | "ARC_DEFI_V2_RUNTIME_MISMATCH" | "ARC_DEFI_V2_CHAIN_MISMATCH", message: string) {
    super(message);
    this.name = "ArcDefiReadinessError";
  }
}

export interface ArcIdentityReader {
  getChainId(): Promise<number>;
  getBytecode(address: Address): Promise<Hex | undefined>;
  readSwapPool(address: Address): Promise<Address>;
}

/** Every plan rechecks chain and exact reviewed runtime; an operator hash alone grants no authority. */
export async function assertReviewedArcDefiRuntime(
  protocol: ArcDefiProtocol,
  deployments: Readonly<Record<ArcDefiProtocol, ArcReviewedDeployment | null>>,
  reader: ArcIdentityReader,
  options: { readonly requireLendingPoolIdentity?: boolean } = {},
): Promise<void> {
  const deployment = deployments[protocol];
  if (!deployment) {
    throw new ArcDefiReadinessError("ARC_DEFI_V2_NOT_CONFIGURED", `Arc ${protocol} accepts legacy position exits only until its reviewed V2 deployment is configured.`);
  }
  const [chainId, code] = await Promise.all([reader.getChainId(), reader.getBytecode(deployment.address)]);
  if (chainId !== 5042002) throw new ArcDefiReadinessError("ARC_DEFI_V2_CHAIN_MISMATCH", "The Arc RPC is serving a different chain; no transaction was prepared.");
  if (!code || code === "0x" || deployment.runtimeCodehash !== ARC_REVIEWED_V2_RUNTIMES[protocol].runtimeCodehash || keccak256(code) !== deployment.runtimeCodehash) {
    throw new ArcDefiReadinessError("ARC_DEFI_V2_RUNTIME_MISMATCH", `Arc ${protocol} bytecode does not match the compiled reviewed V2 source; no transaction was prepared.`);
  }
  // Repayment and existing-position exits retain the source contract's oracle
  // outage behavior. New exposure also pins the mutable price-source pool.
  if (protocol === "lending" && options.requireLendingPoolIdentity !== false) {
    await assertReviewedArcDefiRuntime("swap", deployments, reader);
    const pool = await reader.readSwapPool(deployment.address);
    if (pool.toLowerCase() !== deployments.swap?.address.toLowerCase()) {
      throw new ArcDefiReadinessError("ARC_DEFI_V2_RUNTIME_MISMATCH", "Arc Lending V2 points to a pool outside the reviewed Swap V2 deployment; no transaction was prepared.");
    }
  }
}
