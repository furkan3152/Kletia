/**
 * GET /contracts/:recordKey/state: one-block snapshot of a pinned or recorded
 * Kletia contract (owner, pending owner, the spec's reads, balances, code
 * check, Safe owner details) and whether this session can act on it.
 */
import { ADMIN_PINNED_DEPLOYMENTS, ASSETS, CHAINS, type AdminContractState, type AdminTokenAmount } from "@kletia/core";
import { erc20Abi, getAddress, keccak256, type Address, type Hex, type PublicClient } from "viem";
import type { KnownContract } from "./catalog.js";
import { specOf } from "./catalog.js";
import { getArtifact, isDeployable } from "./contract-artifacts/index.js";
import type { AdminDeps, AdminSessionContext } from "./deps.js";
import { hasFunction, ownerKindOf, rpc, SAFE_ABI, stringifyValue, tryRead, ZERO_ADDRESS } from "./verify/chain.js";
import { maskedRuntimeHash } from "./verify/mask.js";

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Whether the session's EVM actors can act on a contract owned by `owner`. */
export function canAct(
  session: AdminSessionContext, owner: string | null, ownerKind: AdminContractState["ownerKind"], safeOwners: readonly string[] | null,
): { adminCanAct: AdminContractState["adminCanAct"]; reason: string | null } {
  const actors = session.actors.map((actor) => actor.toLowerCase());
  const solanaNote = session.record.walletKind === "solana"
    ? `Signed in with Solana. Connect the EVM admin wallet ${session.actors.map(shortAddress).join(" or ") || "(none configured)"} to sign on-chain actions.`
    : null;
  if (!owner || ownerKind === "none") return { adminCanAct: "no", reason: "This contract has no owner." };
  if (actors.includes(owner.toLowerCase())) return { adminCanAct: "direct", reason: solanaNote };
  if (ownerKind === "safe" && safeOwners && safeOwners.some((entry) => actors.includes(entry.toLowerCase()))) {
    return { adminCanAct: "via-safe", reason: solanaNote };
  }
  return {
    adminCanAct: "no",
    reason: `Owned by ${shortAddress(getAddress(owner))}. Connect that wallet (add it to KLETIA_ADMIN_ADDRESSES) or transfer ownership.`,
  };
}

function knownTokens(network: KnownContract["network"]): { address: string; symbol: string; decimals: number }[] {
  return ASSETS.filter((asset) => asset.network === network && asset.address && (asset.symbol === "USDC" || asset.category === "wrapped"))
    .map((asset) => ({ address: asset.address as string, symbol: asset.symbol, decimals: asset.decimals }));
}

export async function erc20Amount(client: PublicClient, network: KnownContract["network"], token: string, holder: string, blockNumber?: bigint): Promise<AdminTokenAmount | null> {
  const known = ASSETS.find((asset) => asset.network === network && asset.address?.toLowerCase() === token.toLowerCase());
  const balance = await tryRead(client, network, token, erc20Abi, "balanceOf", [holder], blockNumber);
  if (!balance.ok) return null;
  let symbol = known?.symbol;
  let decimals = known?.decimals;
  if (symbol === undefined || decimals === undefined) {
    const [symbolRead, decimalsRead] = await Promise.all([
      tryRead(client, network, token, erc20Abi, "symbol", [], blockNumber),
      tryRead(client, network, token, erc20Abi, "decimals", [], blockNumber),
    ]);
    symbol = symbolRead.ok ? String(symbolRead.value) : "TOKEN";
    decimals = decimalsRead.ok ? Number(decimalsRead.value) : 18;
  }
  return { token: getAddress(token), symbol, decimals, amount: String(balance.value), usd: null };
}

export async function nativeAmount(client: PublicClient, network: KnownContract["network"], holder: string, blockNumber?: bigint): Promise<AdminTokenAmount> {
  const balance = await rpc(network, () => client.getBalance({ address: holder as Address, ...(blockNumber === undefined ? {} : { blockNumber }) }));
  const asset = CHAINS[network].nativeAsset;
  return { token: "native", symbol: asset.symbol, decimals: asset.decimals, amount: balance.toString(), usd: null };
}

export async function contractState(deps: AdminDeps, session: AdminSessionContext, known: KnownContract): Promise<AdminContractState> {
  const { network, address, contractId } = known;
  const spec = specOf(contractId);
  const artifact = spec.artifactId ? getArtifact(spec.artifactId) : null;
  const client = deps.client(network);
  const blockNumber = await rpc(network, () => client.getBlockNumber());
  const code = (await rpc(network, () => client.getCode({ address: address as Address, blockNumber }))) ?? "0x";

  let codeMatches: boolean | null = null;
  if (code === "0x") codeMatches = false;
  else if (isDeployable(artifact)) codeMatches = maskedRuntimeHash(code as Hex, artifact.immutableReferences) === artifact.maskedRuntimeHash;
  else if (known.pinned?.runtimeCodehash) codeMatches = keccak256(code as Hex) === known.pinned.runtimeCodehash;

  const values: Record<string, string | boolean | null> = {};
  let owner: string | null = null;
  let pendingOwner: string | null = null;
  if (artifact) {
    if (hasFunction(artifact.abi, "owner")) {
      const read = await tryRead(client, network, address, artifact.abi, "owner", [], blockNumber);
      owner = read.ok && typeof read.value === "string" ? getAddress(read.value) : null;
    }
    if (hasFunction(artifact.abi, "pendingOwner")) {
      const read = await tryRead(client, network, address, artifact.abi, "pendingOwner", [], blockNumber);
      pendingOwner = read.ok && typeof read.value === "string" && read.value.toLowerCase() !== ZERO_ADDRESS ? getAddress(read.value) : null;
    }
    const reads = await Promise.all(spec.reads.filter((fn) => hasFunction(artifact.abi, fn)).map(async (fn) => {
      const read = await tryRead(client, network, address, artifact.abi, fn, [], blockNumber);
      return [fn, read.ok ? stringifyValue(read.value) : null] as const;
    }));
    for (const [fn, value] of reads) values[fn] = value;
    if (contractId === "intent-router-v2" && hasFunction(artifact.abi, "adapterConfig", 1)) {
      const adapters = ADMIN_PINNED_DEPLOYMENTS.filter((entry) => entry.network === network && entry.contractId === "uniswap-v2-adapter").map((entry) => entry.address);
      const recorded = (await deps.store().listDeployments({ network, status: "verified" })).filter((record) => record.contractId === "uniswap-v2-adapter").map((record) => record.address);
      for (const adapter of [...new Set([...adapters, ...recorded])]) {
        const read = await tryRead(client, network, address, artifact.abi, "adapterConfig", [adapter], blockNumber);
        values[`adapterConfig(${adapter})`] = read.ok ? stringifyValue(read.value) : null;
      }
    }
  } else if (known.pinned?.owner) {
    owner = known.pinned.owner;
  }

  const { kind: ownerKind, safe } = await ownerKindOf(client, network, owner);
  let safeView: AdminContractState["safe"];
  if (safe && owner) {
    const nonce = await tryRead(client, network, owner, SAFE_ABI, "nonce", [], blockNumber);
    safeView = { threshold: safe.threshold, owners: safe.owners, nonce: nonce.ok ? String(nonce.value) : "0" };
  }

  const balances: AdminTokenAmount[] = [await nativeAmount(client, network, address, blockNumber)];
  const tokenAddresses = new Set<string>();
  if (contractId === "x402-gateway" && typeof values.usdc === "string") tokenAddresses.add(values.usdc);
  if (contractId === "legacy-smart-router" || contractId === "intent-router-v2") for (const token of knownTokens(network)) tokenAddresses.add(token.address);
  for (const token of tokenAddresses) {
    const amount = await erc20Amount(client, network, token, address, blockNumber);
    if (amount) balances.push(amount);
  }

  const acting = canAct(session, owner, ownerKind, safe?.owners ?? null);
  return {
    recordKey: known.recordKey, network, address: getAddress(address), contractId, block: blockNumber.toString(), codeMatches,
    owner, pendingOwner, ownerKind, ...(safeView ? { safe: safeView } : {}),
    adminCanAct: acting.adminCanAct, adminCanActReason: acting.reason, values, balances,
  };
}
