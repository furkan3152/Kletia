/**
 * Safe proposals (admin design D.4 "Via Safe"): signature progress, sign with
 * the connected owner, execute when the threshold is met, or hand the
 * proposal to Safe{Wallet} (link and Transaction Builder JSON).
 */
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, PenLine, Send, X } from "lucide-react";
import { useState } from "react";
import type { Abi, Hex } from "viem";

import { LineBullet } from "../../../site/art/LineBullet";
import { lineFor } from "../../../site/art/tokens";
import { Button, ButtonLink } from "../../../site/ui/Button";
import { CopyButton } from "../../../site/ui/CopyButton";
import { Skeleton } from "../../../site/ui/Skeleton";
import { StatusPill, type StatusTone } from "../../../site/ui/StatusPill";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { toast } from "../../../site/ui/toast";
import { useAdmin, useAdminQuery } from "../api/useAdmin";
import { AddressText } from "../components/AddressText";
import { errorText } from "../api/errors";
import { AdminError } from "../components/AdminError";
import { EmptyState, SectionHeader } from "../components/SectionHeader";
import { chainIdOf, networkName } from "../model/plan";
import { hasSigned, missingSigners, packSignatures, safeAppUrl, signatureProgress, transactionBuilderJson, ZERO_ADDRESS } from "../model/safe";
import type { AdminSafeProposal } from "../model/types";

const STATUS_TONES: Readonly<Record<AdminSafeProposal["status"], StatusTone>> = {
  collecting: "info",
  ready: "success",
  executed: "success",
  stale: "neutral",
  cancelled: "neutral",
};

const EXEC_ABI = [
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const satisfies Abi;

export function SafeQueueSection() {
  const proposals = useAdminQuery(["safe", "proposals"], (api) => api.safeProposals());
  const list = proposals.data ?? [];
  const open = list.filter((item) => item.status === "collecting" || item.status === "ready");
  const closed = list.filter((item) => item.status !== "collecting" && item.status !== "ready");
  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        icon="shield"
        eyebrow="Safe queue"
        title="Proposals for the Safes"
        intro="Contracts owned by a Safe change only with enough owner signatures. Each owner signs here (or in Safe{Wallet}); once the threshold is met, any owner executes."
      />
      {proposals.error ? <AdminError error={proposals.error} title="The queue could not load" onRetry={() => void proposals.refetch()} /> : null}
      {proposals.isLoading ? <Skeleton className="h-48" surface="card" /> : null}
      {proposals.data && list.length === 0 ? <EmptyState>No proposals.</EmptyState> : null}
      {open.length > 0 ? (
        <ul className="flex flex-col gap-5">
          {open.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} />
          ))}
        </ul>
      ) : null}
      {closed.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="Closed proposals">
          <h2 className="font-display text-xl font-bold">Closed</h2>
          <ul className="flex flex-col gap-3">
            {closed.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} compact />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ProposalCard({ proposal, compact = false }: { readonly proposal: AdminSafeProposal; readonly compact?: boolean }) {
  const { client, signer, book, ops } = useAdmin();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"sign" | "execute" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signerAddress = signer.ready ? signer.address : null;
  const isOwner = Boolean(signerAddress && proposal.owners.some((owner) => owner.toLowerCase() === signerAddress.toLowerCase()));
  const signed = hasSigned(proposal, signerAddress);
  const missing = missingSigners(proposal);
  const line = lineFor(proposal.network);
  const appUrl = safeAppUrl(proposal.network, proposal.safe);
  const builder = JSON.stringify(transactionBuilderJson(proposal, chainIdOf(proposal.network)), null, 2);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "safe"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] });
  };

  const sign = async () => {
    setBusy("sign");
    setError(null);
    try {
      const signature = await ops.signSafeTx(proposal.network, proposal.safe, { to: proposal.to, value: proposal.value, data: proposal.data, nonce: proposal.nonce });
      await client.addSafeSignature(proposal.id, signature);
      toast.success("Signature added");
      refresh();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const execute = async () => {
    setBusy("execute");
    setError(null);
    try {
      const signatures = packSignatures(proposal.signatures);
      const txHash = await ops.writeCall({
        network: proposal.network,
        address: proposal.safe,
        abi: EXEC_ABI,
        functionName: "execTransaction",
        args: [proposal.to as Hex, BigInt(proposal.value), proposal.data as Hex, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, signatures],
      });
      const receipt = await ops.waitReceipt(proposal.network, txHash, 1);
      if (receipt.status !== "success") throw new Error("execTransaction reverted on-chain.");
      await client.markSafeExecuted(proposal.id, txHash);
      toast.success("Executed on-chain");
      refresh();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    try {
      await client.cancelSafe(proposal.id);
      refresh();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className={cx("flex flex-col gap-4 p-5", INK_BORDER, SURFACE, !compact && HARD_SHADOW, compact && "opacity-90")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
            {line ? <LineBullet line={line} decorative /> : null}
            {networkName(proposal.network)}
            <span className={TEXT_MUTED}>nonce {proposal.nonce}</span>
          </p>
          <h3 className="mt-1 font-display text-xl font-bold">{proposal.description}</h3>
        </div>
        <StatusPill tone={STATUS_TONES[proposal.status]}>{proposal.status}</StatusPill>
      </div>
      <dl className="grid gap-3 text-sm md:grid-cols-2">
        <div>
          <dt className={cx(LABEL, TEXT_MUTED)}>Safe</dt>
          <dd>
            <AddressText address={proposal.safe} network={proposal.network} book={book} />
          </dd>
        </div>
        <div>
          <dt className={cx(LABEL, TEXT_MUTED)}>Call</dt>
          <dd className="break-all font-code text-[13px]">
            {proposal.decoded ? `${proposal.decoded.fn}(${Object.entries(proposal.decoded.args).map(([key, value]) => `${key}: ${value}`).join(", ")})` : `${proposal.data.slice(0, 10)}…`}
          </dd>
        </div>
        <div>
          <dt className={cx(LABEL, TEXT_MUTED)}>Target</dt>
          <dd>
            <AddressText address={proposal.to} network={proposal.network} book={book} />
          </dd>
        </div>
        <div>
          <dt className={cx(LABEL, TEXT_MUTED)}>safeTxHash (read from the chain)</dt>
          <dd>
            <code className="break-all font-code text-[13px]">{proposal.safeTxHash}</code>
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex gap-1.5" aria-hidden="true">
          {Array.from({ length: proposal.threshold }, (_, index) => (
            <span key={index} className="kl-admin__pip" data-on={index < proposal.signatures.length || undefined} />
          ))}
        </span>
        <span className="text-sm font-bold">{signatureProgress(proposal)}</span>
        {missing.length > 0 && proposal.status === "collecting" ? (
          <span className={cx("text-sm", TEXT_MUTED)}>
            Waiting for {missing.map((owner) => book.get(owner.toLowerCase()) ?? `${owner.slice(0, 6)}…${owner.slice(-4)}`).join(", ")}
          </span>
        ) : null}
      </div>
      {proposal.executedTxHash ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className={cx(LABEL, TEXT_MUTED)}>Executed in</span>
          <AddressText address={proposal.executedTxHash} network={proposal.network} tx />
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm font-bold text-danger">
          {error}
        </p>
      ) : null}
      {!compact ? (
        <div className="flex flex-wrap items-center gap-2">
          {proposal.status === "collecting" ? (
            <Button onClick={() => void sign()} loading={busy === "sign"} disabled={!isOwner || signed || busy !== null} title={!isOwner ? "Connect a wallet that owns this Safe." : signed ? "You signed already." : undefined}>
              <PenLine className="h-4 w-4" aria-hidden="true" />
              {signed ? "Signed" : "Sign"}
            </Button>
          ) : null}
          {proposal.status === "ready" ? (
            <Button variant="accent" onClick={() => void execute()} loading={busy === "execute"} disabled={!isOwner || busy !== null}>
              <Send className="h-4 w-4" aria-hidden="true" />
              Execute
            </Button>
          ) : null}
          {appUrl ? (
            <ButtonLink to={appUrl} variant="secondary" size="md">
              Open in Safe{"{Wallet}"}
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </ButtonLink>
          ) : null}
          <span className="inline-flex items-center gap-2 text-sm font-bold">
            <CopyButton text={builder} label="Copy Transaction Builder JSON" appearance="light" />
            Transaction Builder JSON
          </span>
          <Button variant="ghost" onClick={() => void cancel()} loading={busy === "cancel"} disabled={busy !== null}>
            <X className="h-4 w-4" aria-hidden="true" />
            Cancel in the panel
          </Button>
        </div>
      ) : null}
      {!compact && !isOwner && signer.ready ? <p className={cx("text-sm", TEXT_MUTED)}>The connected wallet is not an owner of this Safe. Another owner signs here or in Safe{"{Wallet}"}.</p> : null}
      {!compact && !signer.ready ? <p className={cx("text-sm", TEXT_MUTED)}>{signer.reason}</p> : null}
    </li>
  );
}
