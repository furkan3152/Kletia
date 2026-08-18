import { useRef, useState } from "react";
import { useAccount, useChainId, useWalletClient } from "wagmi";
import { getAddress, isAddress, type Hex } from "viem";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import type { NetworkMode } from "../../config/networks";
import { getNetwork, isNetworkMode } from "../../config/networks";
import type { PolicyAgentV1 } from "../../types";

const HEX_32 = /^0x[0-9a-f]{64}$/iu;
const INTEGER = /^\d+$/u;

function assertPolicy(policy: PolicyAgentV1, owner: string, network: NetworkMode) {
  if (
    policy.version !== 1 ||
    !HEX_32.test(policy.policyId) ||
    !isAddress(policy.owner) ||
    getAddress(policy.owner) !== getAddress(owner) ||
    !policy.allowedNetworks.every(isNetworkMode) ||
    !INTEGER.test(policy.maxSpendUsdcAtomic) ||
    BigInt(policy.maxSpendUsdcAtomic) <= 0n ||
    policy.authority !== "planning_only_no_transaction_authority" ||
    policy.requiresPerStepWalletApproval !== true ||
    policy.expiresAt <= Math.floor(Date.now() / 1_000) ||
    getNetwork(network).chainId <= 0
  ) throw new Error("Policy does not match the active wallet or safety boundary.");
}

export function PolicyAgentCard({
  policy,
  network,
}: {
  policy: PolicyAgentV1;
  network: Exclude<NetworkMode, "arc">;
}) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { data: walletClient } = useWalletClient();
  const inFlight = useRef(false);
  const [state, setState] = useState<"idle" | "signing" | "signed">("idle");
  const [signature, setSignature] = useState<Hex>();
  const [error, setError] = useState<string>();

  const sign = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("signing");
    setError(undefined);
    try {
      if (!address || !walletClient || chainId !== getNetwork(network).chainId) {
        throw new Error(`Connect the policy owner on ${getNetwork(network).name}.`);
      }
      assertPolicy(policy, address, network);
      const signed = await walletClient.signTypedData({
        account: getAddress(address),
        domain: { name: "Kletia Policy Agent", version: "1", chainId },
        primaryType: "PolicyAgentV1",
        types: {
          PolicyAgentV1: [
            { name: "policyId", type: "bytes32" },
            { name: "owner", type: "address" },
            { name: "objective", type: "string" },
            { name: "allowedNetworks", type: "string[]" },
            { name: "allowedProtocols", type: "string[]" },
            { name: "allowedAssets", type: "string[]" },
            { name: "maxSpendUsdcAtomic", type: "uint256" },
            { name: "riskTolerance", type: "string" },
            { name: "expiresAt", type: "uint256" },
          ],
        },
        message: {
          policyId: policy.policyId as Hex,
          owner: getAddress(policy.owner),
          objective: policy.objective,
          allowedNetworks: policy.allowedNetworks,
          allowedProtocols: policy.allowedProtocols,
          allowedAssets: policy.allowedAssets,
          maxSpendUsdcAtomic: BigInt(policy.maxSpendUsdcAtomic),
          riskTolerance: policy.riskTolerance,
          expiresAt: BigInt(policy.expiresAt),
        },
      });
      setSignature(signed);
      setState("signed");
    } catch (cause) {
      setState("idle");
      setError(cause instanceof Error ? cause.message : "Policy signature was rejected.");
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <section className="mt-4 w-full border-[3px] border-[#1A1A1A] bg-[#E9D5FF] p-4 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A]">
      <div className="flex items-start justify-between gap-3 border-b-[3px] border-[#1A1A1A] pb-3">
        <div><p className="text-[10px] font-black uppercase tracking-widest">PolicyAgentV1</p><h3 className="font-black uppercase">{policy.name}</h3></div>
        <span className="border-2 border-[#1A1A1A] bg-white px-2 py-1 text-[9px] font-black uppercase">Planning only</span>
      </div>
      <p className="mt-3 text-xs font-bold">{policy.objective}</p>
      <div className="mt-3 grid gap-2 text-[10px] font-black uppercase sm:grid-cols-2">
        <span>Networks: {policy.allowedNetworks.join(", ")}</span>
        <span>Protocols: {policy.allowedProtocols.join(", ")}</span>
        <span>Assets: {policy.allowedAssets.join(", ")}</span>
        <span>USDC cap: {Number(BigInt(policy.maxSpendUsdcAtomic)) / 1_000_000}</span>
      </div>
      <p className="mt-3 border-2 border-[#1A1A1A] bg-white p-2 text-[9px] font-bold">
        This signature grants planning permission only. It cannot approve tokens, bridge, swap, lend, borrow, or move funds. Every financial step still needs a wallet signature.
      </p>
      <button type="button" onClick={() => void sign()} disabled={state !== "idle"} className="mt-3 flex w-full items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-[#7C3AED] px-3 py-3 text-xs font-black uppercase text-white shadow-[3px_3px_0_#1A1A1A] disabled:opacity-60">
        {state === "signing" ? <Loader2 className="h-4 w-4 animate-spin" /> : state === "signed" ? <CheckCircle2 className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
        {state === "signed" ? "Policy signed" : state === "signing" ? "Review in wallet" : "Sign planning policy"}
      </button>
      {signature ? <p className="mt-2 break-all font-mono text-[8px]">Signature: {signature}</p> : null}
      {error ? <p className="mt-2 text-[10px] font-black text-red-700">{error}</p> : null}
    </section>
  );
}
