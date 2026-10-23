/**
 * The desk's notice that sub-agent requests wait for the connected wallet
 * (docs/platform/subagents.md): `GET /v1/agents/pending` answers only a
 * count for projects the wallet owns. Read when a wallet connects and every
 * two minutes; a failed read shows nothing. Deciding happens on the portal's
 * Agents page, with the wallet's signature.
 */
import { CHAINS } from "@kletia/core";
import { useEffect, useState } from "react";

import { Link } from "../../routes/Link";
import { cx, FOCUS_RING } from "../../site/ui/styles";
import { deskApprovalNotice } from "../../pages/developers/agents/agentTreeModel";
import { agentsApi } from "../../pages/developers/agents/agentsClient";

const REFRESH_MS = 120_000;

export interface SubagentNoticeProps {
  readonly evm: string | null;
  readonly solana: string | null;
}

export function SubagentNotice({ evm, solana }: SubagentNoticeProps) {
  const accounts = [...(evm ? [`eip155:${CHAINS.base.evmChainId}:${evm}`] : []), ...(solana ? [`solana:${CHAINS.solana.reference}:${solana}`] : [])].join(",");
  // The count is kept with the accounts it was read for, so a disconnect shows nothing at once.
  const [read, setRead] = useState<{ readonly accounts: string; readonly pending: number }>({ accounts: "", pending: 0 });
  useEffect(() => {
    if (!accounts) return undefined;
    const controller = new AbortController();
    const load = () => {
      void Promise.all(accounts.split(",").map((account) => agentsApi.pending(account, controller.signal).catch(() => 0))).then((counts) => {
        if (!controller.signal.aborted) setRead({ accounts, pending: counts.reduce((total, count) => total + count, 0) });
      });
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [accounts]);
  const notice = deskApprovalNotice(read.accounts === accounts ? read.pending : 0);
  if (!notice) return null;
  return (
    <Link
      to={notice.href}
      className={cx("block border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-3 py-2 text-sm font-bold text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] dark:border-[#FFD60A]", FOCUS_RING)}
    >
      {notice.text} <span className="underline decoration-2 underline-offset-2">Review in Agents</span>
    </Link>
  );
}
