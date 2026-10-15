/**
 * POST /actions/verify: confirms a direct owner action sent by an admin EVM
 * wallet from the panel, decodes it against the artifact ABI and audits it.
 */
import type { AdminActionVerifyRequest } from "@kletia/core";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { findKnownContract, specOf } from "../catalog.js";
import { getArtifact } from "../contract-artifacts/index.js";
import type { AdminDeps, AdminSessionContext } from "../deps.js";
import { AdminHttpError } from "../http/errors.js";
import { receiptOrPending, stringifyValue, transactionOrPending } from "./chain.js";

export interface VerifiedAction {
  readonly decoded: { readonly fn: string; readonly args: Readonly<Record<string, string>> };
  readonly block: string;
  readonly contractId: string;
}

export async function verifyAction(deps: AdminDeps, session: AdminSessionContext, request: AdminActionVerifyRequest): Promise<VerifiedAction> {
  const known = await findKnownContract(deps.store(), request.network, request.contract);
  if (!known) throw new AdminHttpError(404, "ADMIN_NOT_FOUND", "The contract is not a pinned or recorded Kletia contract on this network.");
  const spec = specOf(known.contractId);
  const artifact = getArtifact(spec.artifactId);
  if (!artifact) throw new AdminHttpError(404, "ADMIN_ARTIFACT_NOT_FOUND", `No ABI for ${spec.name}.`);
  const client = deps.client(request.network);
  const hash = request.txHash.toLowerCase() as Hex;
  const receipt = await receiptOrPending(client, request.network, hash);
  if (receipt.status !== "success") throw new AdminHttpError(422, "ADMIN_INVALID_REQUEST", "The transaction reverted.");
  const tx = await transactionOrPending(client, request.network, hash);
  const from = getAddress(tx.from);
  if (!session.actors.some((actor) => actor.toLowerCase() === from.toLowerCase())) {
    throw new AdminHttpError(403, "ADMIN_EVM_WALLET_REQUIRED", `The transaction was sent by ${from}, not by an admin EVM wallet of this session.`);
  }
  if (!tx.to || tx.to.toLowerCase() !== known.address.toLowerCase()) {
    throw new AdminHttpError(422, "ADMIN_INVALID_REQUEST", "The transaction was not sent to this contract.");
  }
  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: artifact.abi, data: tx.input }) as { functionName: string; args?: readonly unknown[] };
  } catch {
    throw new AdminHttpError(422, "ADMIN_INVALID_REQUEST", "The calldata does not decode against the contract ABI.");
  }
  if (request.actionId !== null) {
    const action = spec.actions.find((entry) => entry.id === request.actionId);
    if (!action || action.fn !== decoded.functionName) throw new AdminHttpError(422, "ADMIN_INVALID_REQUEST", "The calldata does not match the named action.");
  }
  const fn = artifact.abi.find((item) => item.type === "function" && item.name === decoded.functionName);
  const inputs = fn && fn.type === "function" ? fn.inputs : [];
  const args: Record<string, string> = {};
  (decoded.args ?? []).forEach((value, index) => {
    const name = inputs[index]?.name || `arg${index}`;
    args[name] = String(stringifyValue(value));
  });
  return { decoded: { fn: decoded.functionName, args }, block: receipt.blockNumber.toString(), contractId: known.contractId };
}
