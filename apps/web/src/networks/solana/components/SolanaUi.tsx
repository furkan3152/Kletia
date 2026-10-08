import React from "react";
import { CHAINS } from "@kletia/core";
import {
  CircleCheck,
  CircleX,
  ExternalLink,
  LoaderCircle,
  PenLine,
  ShieldCheck,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { useSolanaWallet } from "../../../shared/wallet/solana/solanaWalletContext";
import type { SolanaExecution } from "../hooks/useSolanaExecution";
import { ui } from "../styles";

export function PanelHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-gradient-to-br from-[#9945FF] to-[#14F195] text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569]">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-xl font-black uppercase tracking-tight text-[#1A1A1A] dark:text-white sm:text-2xl">
            {title}
          </h2>
          <p className="mt-1 text-sm font-bold text-gray-700 dark:text-slate-300">{description}</p>
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function ConnectSolanaCta({
  title = "Connect a Solana wallet",
  description = "Phantom, Solflare, Backpack and any other Wallet Standard wallet work. Kletia prepares unsigned transactions; your wallet signs every one.",
}: {
  title?: string;
  description?: string;
}) {
  const { openPicker, status } = useSolanaWallet();
  return (
    <div className={`${ui.card} flex flex-col items-start gap-3 bg-[#F3E8FF] dark:bg-[#1C1433]`}>
      <p className="flex items-center gap-2 text-base font-black uppercase">
        <Wallet className="h-5 w-5 text-[#9945FF]" aria-hidden="true" />
        {title}
      </p>
      <p className="text-sm font-bold text-gray-700 dark:text-slate-300">{description}</p>
      <button
        type="button"
        onClick={openPicker}
        aria-haspopup="dialog"
        disabled={status === "connecting"}
        className={ui.primaryButton}
      >
        {status === "connecting" ? (
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Wallet className="h-4 w-4" aria-hidden="true" />
        )}
        Connect a Solana wallet
      </button>
    </div>
  );
}

export function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b-2 border-dashed border-[#1A1A1A]/30 py-2 last:border-b-0 dark:border-slate-600">
      <dt className={ui.label}>{label}</dt>
      <dd className="min-w-0 text-right text-sm font-black break-words">{children}</dd>
    </div>
  );
}

const PHASE_COPY: Record<string, string> = {
  preparing: "Preparing an unsigned transaction",
  signing: "Waiting for your wallet signature",
  confirming: "Waiting for on-chain confirmation",
};

/**
 * Review, signing and confirmation states for a prepared Solana transaction.
 * `children` renders the action-specific review details.
 */
export function ExecutionPanel<TDetails>({
  execution,
  confirmLabel,
  children,
}: {
  execution: SolanaExecution<TDetails>;
  confirmLabel: string;
  children?: React.ReactNode;
}) {
  const { account } = useSolanaWallet();
  const { phase, prepared, error, logs, explorerUrl, signature } = execution;
  if (phase === "idle") return null;
  const network = prepared?.request.network ?? "solana";
  const explorerName = CHAINS[network].explorer.name;
  const progress = PHASE_COPY[phase];

  return (
    <section
      aria-label="Transaction status"
      className={`${ui.card} flex flex-col gap-4 ${
        phase === "confirmed" ? "bg-[#DCFCE7] dark:bg-[#0F2A1D]" : ""
      }`}
    >
      <div aria-live="polite" className="flex flex-col gap-2">
        {progress ? (
          <p className="flex items-center gap-2 text-sm font-black uppercase">
            <LoaderCircle className="h-4 w-4 animate-spin text-[#9945FF]" aria-hidden="true" />
            {progress}
          </p>
        ) : null}
        {phase === "review" ? (
          <p className="flex items-center gap-2 text-sm font-black uppercase">
            <ShieldCheck className="h-4 w-4 text-[#9945FF]" aria-hidden="true" />
            Review before signing
          </p>
        ) : null}
        {phase === "confirmed" ? (
          <p className="flex items-center gap-2 text-base font-black uppercase">
            <CircleCheck className="h-5 w-5 text-[#047857] dark:text-[#14F195]" aria-hidden="true" />
            Confirmed on {CHAINS[network].name}
          </p>
        ) : null}
        {phase === "failed" ? (
          <p className="flex items-center gap-2 text-sm font-black uppercase text-[#B91C1C] dark:text-red-300">
            <CircleX className="h-4 w-4" aria-hidden="true" />
            {signature ? "Transaction did not confirm" : "Not sent"}
          </p>
        ) : null}
      </div>

      {children}

      {error ? (
        <p role="alert" className={ui.errorBox}>
          {error}
        </p>
      ) : null}
      {prepared?.blockedReason && phase === "review" ? (
        <p role="alert" className={ui.errorBox}>
          {prepared.blockedReason}
        </p>
      ) : null}

      {explorerUrl ? (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`${ui.ghostButton} self-start`}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          View on {explorerName}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}

      {logs.length > 0 ? (
        <details className="border-[3px] border-[#1A1A1A] bg-[#1A1A1A] p-3 font-mono text-xs text-[#14F195] dark:border-[#4B5563]">
          <summary className="cursor-pointer font-black uppercase tracking-wider text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#14F195]">
            Execution log ({logs.length})
          </summary>
          <ol className="mt-2 flex flex-col gap-1">
            {logs.map((line, index) => (
              <li key={`${index}-${line}`} className="break-words">
                <span aria-hidden="true" className="mr-1 text-gray-500">
                  &gt;
                </span>
                {line}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {phase === "review" ? (
          <button
            type="button"
            onClick={() => void execution.confirm()}
            disabled={Boolean(prepared?.blockedReason) || !account}
            className={ui.primaryButton}
          >
            <PenLine className="h-4 w-4" aria-hidden="true" />
            {account ? confirmLabel : "Connect a wallet to sign"}
          </button>
        ) : null}
        {phase === "review" || phase === "failed" || phase === "confirmed" ? (
          <button type="button" onClick={execution.reset} className={ui.ghostButton}>
            {phase === "confirmed" ? "Done" : phase === "failed" ? "Dismiss" : "Cancel"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
