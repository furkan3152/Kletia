/**
 * One owner call, by the path the contract's owner allows (admin design D.4):
 * - direct: simulate, send from the connected EVM wallet, wait one
 *   confirmation, then the API re-reads and audits the transaction;
 * - via Safe: the API proposes (it reads the Safe's nonce and the
 *   authoritative safeTxHash on chain), the connected owner signs the SafeTx,
 *   the API recovers and stores the signature.
 * The server never signs or sends anything.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { encodeFunctionData, type Abi, type Hex } from "viem";

import type { AdminEvmNetwork, AdminSafeProposal } from "../model/types";
import { useAdmin } from "./useAdmin";

export interface OwnerCallInput {
  readonly network: AdminEvmNetwork;
  readonly address: string;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args: readonly unknown[];
  readonly value?: bigint;
  readonly actionId: string | null;
  readonly description: string;
  /** "direct" sends from the wallet; a Safe address proposes through that Safe. */
  readonly via: "direct" | { readonly safe: string };
}

export type OwnerCallResult =
  | { readonly kind: "sent"; readonly txHash: Hex; readonly auditId: string | null }
  | { readonly kind: "proposed"; readonly proposal: AdminSafeProposal };

export function useOwnerCall() {
  const { client, ops } = useAdmin();
  const queryClient = useQueryClient();
  return useCallback(
    async (input: OwnerCallInput, onStep?: (step: "wallet" | "confirming" | "verifying" | "proposing" | "signing") => void): Promise<OwnerCallResult> => {
      if (input.via === "direct") {
        onStep?.("wallet");
        const txHash = await ops.writeCall({ network: input.network, address: input.address, abi: input.abi, functionName: input.functionName, args: input.args, value: input.value });
        onStep?.("confirming");
        const receipt = await ops.waitReceipt(input.network, txHash, 1);
        if (receipt.status !== "success") throw new Error("The transaction reverted on-chain.");
        onStep?.("verifying");
        const verified = await client
          .verifyAction({ network: input.network, txHash, contract: input.address, actionId: input.actionId })
          .finally(() => void queryClient.invalidateQueries({ queryKey: ["admin"] }));
        return { kind: "sent", txHash, auditId: verified.auditId };
      }
      onStep?.("proposing");
      const data = encodeFunctionData({ abi: input.abi, functionName: input.functionName, args: input.args as unknown[] });
      const proposal = await client.proposeSafe({
        network: input.network,
        safe: input.via.safe,
        to: input.address,
        value: (input.value ?? 0n).toString(),
        data,
        description: input.description,
        actionId: input.actionId,
      });
      onStep?.("signing");
      const signature = await ops.signSafeTx(input.network, proposal.safe, { to: proposal.to, value: proposal.value, data: proposal.data, nonce: proposal.nonce });
      const signed = await client.addSafeSignature(proposal.id, signature);
      void queryClient.invalidateQueries({ queryKey: ["admin", "safe"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] });
      return { kind: "proposed", proposal: signed };
    },
    [client, ops, queryClient],
  );
}
