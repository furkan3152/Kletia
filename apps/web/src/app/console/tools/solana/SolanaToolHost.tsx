/**
 * Hosts the Solana tools (Jupiter swap, send, liquid staking, lending rates)
 * the way the old Solana workspace did (one owner, one mainnet portfolio that
 * refreshes when a confirmed transaction invalidates it), without its tab
 * strip or chrome. The forms keep their own execution: useSolanaExecution's
 * pre-sign checks (v0 message, fee payer, sole signer, size, cluster) run
 * before the wallet is asked.
 */
import type { ReactNode } from "react";
import { formatAccountId, sameAccount } from "@kletia/core";
import { Wallet } from "lucide-react";

import { parsePortfolio, solanaPaths, type SolanaPortfolio } from "../../../../networks/solana/api";
import { useSolanaResource } from "../../../../networks/solana/hooks/useSolanaResource";
import { useKletiaEvent } from "../../../../shared/sync/bus";
import { useSolanaWallet } from "../../../../shared/wallet/solana/solanaWalletContext";
import { Button } from "../../../site/ui/Button";
import { cx, INK_BORDER, SURFACE } from "../../../site/ui/styles";
import { TOOL_COPY } from "../toolCopy";

export interface SolanaToolContext {
  /** The connected Solana wallet address; null until one is connected. */
  readonly owner: string | null;
  /** Mainnet portfolio of the owner (null while loading or without a wallet). */
  readonly portfolio: SolanaPortfolio | null;
}

export interface SolanaToolHostProps {
  /** Forms that sign need the wallet; read-only tools render without the connect bar. */
  readonly needsWallet: boolean;
  readonly children: (context: SolanaToolContext) => ReactNode;
}

export function SolanaToolHost({ needsWallet, children }: SolanaToolHostProps) {
  const { account, openPicker } = useSolanaWallet();
  const owner = account?.address ?? null;
  const portfolio = useSolanaResource(owner && needsWallet ? solanaPaths.portfolio(owner, "solana") : null, parsePortfolio);
  const refreshPortfolio = portfolio.refresh;
  useKletiaEvent("portfolio.invalidated", (event) => {
    if (event.network === "solana" && owner && sameAccount(event.account, formatAccountId("solana", owner))) refreshPortfolio();
  });

  return (
    <div className="flex flex-col gap-5">
      {needsWallet && !owner ? (
        <div className={cx("flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between", INK_BORDER, SURFACE)}>
          <p className="flex items-start gap-2 text-sm font-semibold">
            <Wallet className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {TOOL_COPY.solana.connectLead}
          </p>
          <Button size="sm" onClick={openPicker} className="shrink-0">
            {TOOL_COPY.solana.connect}
          </Button>
        </div>
      ) : null}
      {children({ owner, portfolio: needsWallet ? portfolio.data : null })}
    </div>
  );
}
