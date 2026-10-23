/**
 * Runs a prepared order's steps with the connected wallets: an approval the
 * EVM wallet sends (and Kletia waits for), a Solana transaction the wallet
 * signs without sending, or EIP-712 typed data; the signed result goes to
 * POST /v1/orders/submit. Safe steps are never run here: the view shows
 * them for the Safe to execute.
 */
import { useCallback } from "react";
import { useConfig, useSwitchChain, useWalletClient } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { getKletiaClient } from "../../../shared/platform/kletiaClient";
import { useSolanaWallet } from "../../../shared/wallet/solana/solanaWalletContext";
import { submitOrder, type SubmittedOrderView } from "./ordersApi";
import { walletTypedData, type OrderPreparationView, type OrderStepView } from "./ordersModel";

export type OrderRunResult = { readonly kind: "submitted"; readonly order: SubmittedOrderView } | { readonly kind: "safe"; readonly steps: readonly OrderStepView[] };

export function useOrderRunner(): (preparation: OrderPreparationView, onStep: (index: number) => void) => Promise<OrderRunResult> {
  const { wallet, account } = useSolanaWallet();
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const config = useConfig();

  return useCallback(
    async (preparation, onStep) => {
      if (preparation.submit === "wallet" && preparation.steps.some((step) => step.kind === "safe-transaction")) {
        return { kind: "safe", steps: preparation.steps };
      }
      for (const [index, step] of preparation.steps.entries()) {
        onStep(index);
        if (step.kind === "safe-transaction") throw new Error("This step runs in your Safe, not in this wallet.");
        if (step.kind === "solana-transaction") {
          if (!wallet || !account || account.address !== preparation.owner) throw new Error("Connect the Solana wallet that owns this order.");
          const { signSolanaOrderTransaction } = await import("../../../shared/wallet/solana/signOrderTransaction");
          const signedTransaction = await signSolanaOrderTransaction(wallet, account, "solana", step.transaction);
          return { kind: "submitted", order: await submitOrder(getKletiaClient(), preparation.id, { signedTransaction }) };
        }
        if (!walletClient?.account || walletClient.account.address.toLowerCase() !== preparation.owner.toLowerCase()) {
          throw new Error("Connect the EVM wallet that owns this order.");
        }
        if (walletClient.chain?.id !== step.chainId) await switchChainAsync({ chainId: step.chainId });
        if (step.kind === "evm-transaction") {
          const hash = await walletClient.sendTransaction({ account: walletClient.account, chain: null, to: step.to as `0x${string}`, data: step.data as `0x${string}`, value: 0n });
          const receipt = await waitForTransactionReceipt(config, { hash, chainId: step.chainId });
          if (receipt.status !== "success") throw new Error("The approval transaction failed on-chain.");
          continue;
        }
        const typed = walletTypedData(step.typedData);
        const signature = await walletClient.signTypedData({
          account: walletClient.account,
          domain: { ...typed.domain, verifyingContract: typed.domain.verifyingContract as `0x${string}` },
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        });
        return { kind: "submitted", order: await submitOrder(getKletiaClient(), preparation.id, { signature }) };
      }
      throw new Error("The preparation has no step to sign.");
    },
    [account, config, switchChainAsync, wallet, walletClient],
  );
}
