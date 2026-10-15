/**
 * Safe transaction proposals: the safeTxHash comes from the
 * chain, signers are recovered server-side, execution is confirmed by the
 * Safe's ExecutionSuccess log. The server never signs or sends.
 */
import type { AdminEvmNetwork, AdminSafeProposal } from "@kletia/core";
import {
  decodeEventLog,
  decodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  recoverAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { findKnownContract, specOf } from "./catalog.js";
import { getArtifact } from "./contract-artifacts/index.js";
import type { AdminDeps, AdminSessionContext } from "./deps.js";
import { AdminHttpError, invalidRequest } from "./http/errors.js";
import { randomHex } from "../platform/http/secrets.js";
import { receiptOrPending, rpc, SAFE_ABI, stringifyValue, tryRead, ZERO_ADDRESS } from "./verify/chain.js";

export interface ProposalRequestBody {
  readonly network: AdminEvmNetwork;
  readonly safe: string;
  readonly to: string;
  readonly value: string;
  readonly data: string;
  readonly description: string;
  readonly actionId?: string | null;
}

interface SafeSnapshot {
  readonly nonce: bigint;
  readonly threshold: number;
  readonly owners: string[];
}

async function readSafe(deps: AdminDeps, network: AdminEvmNetwork, safe: string): Promise<SafeSnapshot> {
  const client = deps.client(network);
  const [nonce, threshold, owners] = await Promise.all([
    tryRead(client, network, safe, SAFE_ABI, "nonce"),
    tryRead(client, network, safe, SAFE_ABI, "getThreshold"),
    tryRead(client, network, safe, SAFE_ABI, "getOwners"),
  ]);
  if (!nonce.ok || !threshold.ok || !owners.ok || !Array.isArray(owners.value)) {
    throw new AdminHttpError(422, "ADMIN_INVALID_REQUEST", "The address is not a Safe on this network.");
  }
  return { nonce: BigInt(String(nonce.value)), threshold: Number(threshold.value), owners: (owners.value as string[]).map((owner) => getAddress(owner)) };
}

function decodeProposalCall(abiSource: { readonly abi: Abi } | null, data: Hex): AdminSafeProposal["decoded"] {
  if (!abiSource) return null;
  try {
    const decoded = decodeFunctionData({ abi: abiSource.abi, data }) as { functionName: string; args?: readonly unknown[] };
    const fn = abiSource.abi.find((item) => item.type === "function" && item.name === decoded.functionName);
    const inputs = fn && fn.type === "function" ? fn.inputs : [];
    const args: Record<string, string> = {};
    (decoded.args ?? []).forEach((value, index) => {
      args[inputs[index]?.name || `arg${index}`] = String(stringifyValue(value));
    });
    return { fn: decoded.functionName, args };
  } catch {
    return null;
  }
}

/**
 * Accepted calls: a function of a pinned or recorded Kletia contract (decoded
 * against its ABI, renounceOwnership refused), an ERC-20 transfer, or a plain
 * native transfer (empty data). Anything else is refused.
 */
async function decodeAllowedCall(deps: AdminDeps, network: AdminEvmNetwork, to: string, data: Hex, actionId: string | null): Promise<AdminSafeProposal["decoded"]> {
  if (data === "0x") {
    if (actionId) throw invalidRequest("A native transfer has no action id.");
    return { fn: "nativeTransfer", args: { to: getAddress(to) } };
  }
  const known = await findKnownContract(deps.store(), network, to);
  if (known) {
    const spec = specOf(known.contractId);
    const artifact = getArtifact(spec.artifactId);
    const decoded = decodeProposalCall(artifact, data);
    if (!decoded) throw invalidRequest("The calldata does not decode against the contract ABI.");
    if (decoded.fn === "renounceOwnership") throw invalidRequest("renounceOwnership is disabled by the panel.");
    if (actionId) {
      const action = spec.actions.find((entry) => entry.id === actionId);
      if (!action || action.fn !== decoded.fn) throw invalidRequest("The calldata does not match the named action.");
    }
    return decoded;
  }
  const transfer = decodeProposalCall({ abi: erc20Abi }, data);
  if (transfer?.fn === "transfer") return transfer;
  throw invalidRequest("Only Kletia contract calls, ERC-20 transfers and native transfers can be proposed.");
}

export async function createProposal(deps: AdminDeps, session: AdminSessionContext, body: ProposalRequestBody): Promise<AdminSafeProposal> {
  if (!isAddress(body.safe, { strict: false }) || !isAddress(body.to, { strict: false })) throw invalidRequest("safe and to must be addresses.");
  if (!/^(0|[1-9]\d{0,77})$/u.test(body.value)) throw invalidRequest("value must be a decimal integer (wei).");
  if (!/^0x(?:[0-9a-fA-F]{2})*$/u.test(body.data) || body.data.length > 20_000) throw invalidRequest("data must be 0x hex.");
  const safe = getAddress(body.safe);
  const to = getAddress(body.to);
  const data = body.data.toLowerCase() as Hex;
  const decoded = await decodeAllowedCall(deps, body.network, to, data, body.actionId ?? null);
  const snapshot = await readSafe(deps, body.network, safe);
  const actors = session.actors.map((actor) => actor.toLowerCase());
  if (!snapshot.owners.some((owner) => actors.includes(owner.toLowerCase()))) {
    throw new AdminHttpError(403, "ADMIN_SAFE_SIGNER_INVALID", "No admin EVM wallet of this session is an owner of this Safe.");
  }
  const store = deps.store();
  const open = (await store.listProposals({ network: body.network })).find((proposal) =>
    proposal.safe.toLowerCase() === safe.toLowerCase() && proposal.nonce === snapshot.nonce.toString() && (proposal.status === "collecting" || proposal.status === "ready"));
  if (open) throw new AdminHttpError(409, "ADMIN_SAFE_NONCE_BUSY", `Proposal ${open.id} already uses Safe nonce ${open.nonce}. Execute or cancel it first.`, { proposalId: open.id });
  const client = deps.client(body.network);
  const hash = await tryRead(client, body.network, safe, SAFE_ABI, "getTransactionHash", [
    to, BigInt(body.value), data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, snapshot.nonce,
  ]);
  if (!hash.ok || typeof hash.value !== "string") throw new AdminHttpError(502, "ADMIN_RPC_UNAVAILABLE", "The Safe transaction hash could not be read.");
  const proposal: AdminSafeProposal = {
    id: `sfp_${randomHex(12)}`, network: body.network, safe, to, value: BigInt(body.value).toString(), data, operation: 0,
    nonce: snapshot.nonce.toString(), safeTxHash: hash.value.toLowerCase(), description: body.description.slice(0, 300),
    actionId: body.actionId ?? null, decoded, threshold: snapshot.threshold, owners: snapshot.owners, signatures: [],
    status: "collecting", executedTxHash: null, createdBy: session.actor, createdAt: deps.now().toISOString(),
  };
  await store.insertProposal(proposal);
  return proposal;
}

export async function addSignature(deps: AdminDeps, proposal: AdminSafeProposal, signature: string): Promise<AdminSafeProposal> {
  if (proposal.status !== "collecting" && proposal.status !== "ready") throw invalidRequest(`The proposal is ${proposal.status}.`);
  if (!/^0x[0-9a-fA-F]{130}$/u.test(signature)) throw invalidRequest("signature must be a 65-byte 0x hex ECDSA signature.");
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) throw new AdminHttpError(403, "ADMIN_SAFE_SIGNER_INVALID", "Sign the Safe transaction as EIP-712 typed data (v must be 27 or 28).");
  let signer: string;
  try {
    signer = getAddress(await recoverAddress({ hash: proposal.safeTxHash as Hex, signature: signature as Hex }));
  } catch {
    throw new AdminHttpError(403, "ADMIN_SAFE_SIGNER_INVALID", "The signature does not recover to an address.");
  }
  if (!proposal.owners.some((owner) => owner.toLowerCase() === signer.toLowerCase())) {
    throw new AdminHttpError(403, "ADMIN_SAFE_SIGNER_INVALID", `${signer} is not an owner of this Safe.`);
  }
  if (proposal.signatures.some((entry) => entry.signer.toLowerCase() === signer.toLowerCase())) {
    throw new AdminHttpError(409, "ADMIN_SAFE_SIGNER_INVALID", `${signer} already signed.`);
  }
  const signatures = [...proposal.signatures, { signer, signature: signature.toLowerCase(), at: deps.now().toISOString() }];
  const updated: AdminSafeProposal = { ...proposal, signatures, status: signatures.length >= proposal.threshold ? "ready" : "collecting" };
  await deps.store().updateProposal(updated);
  return updated;
}

export async function markExecuted(deps: AdminDeps, proposal: AdminSafeProposal, txHash: string): Promise<AdminSafeProposal> {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(txHash)) throw invalidRequest("txHash must be a 32-byte 0x hex hash.");
  if (proposal.status === "executed") return proposal;
  if (proposal.status === "cancelled") throw invalidRequest("The proposal was cancelled.");
  const client = deps.client(proposal.network);
  const receipt = await receiptOrPending(client, proposal.network, txHash.toLowerCase() as Hex);
  if (receipt.status !== "success") throw new AdminHttpError(422, "ADMIN_INVALID_REQUEST", "The execution transaction reverted.");
  const executed = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== proposal.safe.toLowerCase()) return false;
    try {
      const event = decodeEventLog({ abi: SAFE_ABI, data: log.data, topics: log.topics });
      return event.eventName === "ExecutionSuccess" && String(event.args.txHash).toLowerCase() === proposal.safeTxHash.toLowerCase();
    } catch {
      return false;
    }
  });
  if (!executed) throw new AdminHttpError(422, "ADMIN_INVALID_REQUEST", "The transaction has no ExecutionSuccess log for this Safe transaction.");
  const updated: AdminSafeProposal = { ...proposal, status: "executed", executedTxHash: txHash.toLowerCase() };
  await deps.store().updateProposal(updated);
  return updated;
}

export async function cancelProposal(deps: AdminDeps, proposal: AdminSafeProposal): Promise<AdminSafeProposal> {
  if (proposal.status !== "collecting" && proposal.status !== "ready") throw invalidRequest(`The proposal is ${proposal.status}.`);
  const updated: AdminSafeProposal = { ...proposal, status: "cancelled" };
  await deps.store().updateProposal(updated);
  return updated;
}

/** Marks open proposals whose nonce is below the Safe's current nonce as stale. Read failures leave them unchanged. */
export async function refreshStale(deps: AdminDeps, proposals: AdminSafeProposal[]): Promise<AdminSafeProposal[]> {
  const nonces = new Map<string, bigint | null>();
  const out: AdminSafeProposal[] = [];
  for (const proposal of proposals) {
    if (proposal.status !== "collecting" && proposal.status !== "ready") {
      out.push(proposal);
      continue;
    }
    const key = `${proposal.network}:${proposal.safe.toLowerCase()}`;
    if (!nonces.has(key)) {
      try {
        const client = deps.client(proposal.network);
        const read = await rpc(proposal.network, () => client.readContract({ address: proposal.safe as Address, abi: SAFE_ABI, functionName: "nonce" }));
        nonces.set(key, read as bigint);
      } catch {
        nonces.set(key, null);
      }
    }
    const current = nonces.get(key);
    if (current !== null && current !== undefined && BigInt(proposal.nonce) < current) {
      const stale: AdminSafeProposal = { ...proposal, status: "stale" };
      await deps.store().updateProposal(stale);
      out.push(stale);
    } else {
      out.push(proposal);
    }
  }
  return out;
}
