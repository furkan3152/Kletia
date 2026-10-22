/**
 * Revenue and claims: what was pushed to the treasury, what accrued in
 * contracts (with the claim that releases it), treasury holdings, LP-only
 * and owner-funded rows. Testnet amounts are shown, never totalled.
 */
import { HandCoins, RefreshCw } from "lucide-react";
import { useState } from "react";
import { getAddress, type Abi } from "viem";

import { LineBullet } from "../../../site/art/LineBullet";
import { lineFor } from "../../../site/art/tokens";
import { Button } from "../../../site/ui/Button";
import { Skeleton } from "../../../site/ui/Skeleton";
import { Stat } from "../../../site/ui/Stat";
import { StatusPill } from "../../../site/ui/StatusPill";
import { cx, INK_BORDER_THIN, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { toast } from "../../../site/ui/toast";
import { useAdmin, useAdminQuery } from "../api/useAdmin";
import { useOwnerCall } from "../api/useOwnerCall";
import { AddressText } from "../components/AddressText";
import { errorText } from "../api/errors";
import { AdminError } from "../components/AdminError";
import { EmptyState, SectionHeader } from "../components/SectionHeader";
import { claimState, FEE_KIND_LABELS, feeTotals, formatTokenAmount, formatUsd, isTestnetRow, scanText } from "../model/fees";
import { ADMIN_EVM_NETWORKS, networkName } from "../model/plan";
import type { AdminFeeRow } from "../model/types";
import { StepUpNote } from "../components/StepUpNote";

/** ABIs of the claim functions the API names. */
const CLAIM_ABIS: Readonly<Record<string, Abi>> = {
  withdraw: [{ type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }], outputs: [] }],
  rescueTokens: [{ type: "function", name: "rescueTokens", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }],
  rescueToken: [{ type: "function", name: "rescueToken", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }],
  transfer: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }],
};

const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

export function FeesSection() {
  const fees = useAdminQuery(["fees"], (api) => api.fees());
  const view = fees.data;
  const totals = view ? feeTotals(view.rows) : null;
  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        icon="ticket"
        eyebrow="Fees"
        title="Revenue and claims"
        intro="Router V2 and the launch factory pay fees to the treasury inside each transaction, so there is little to claim. x402 gateways and the legacy router hold balances an owner can withdraw."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void fees.refetch()} loading={fees.isFetching}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Read again
          </Button>
        }
      />
      {fees.error ? <AdminError error={fees.error} title="Fees could not load" onRetry={() => void fees.refetch()} /> : null}
      <dl className="grid gap-6 sm:grid-cols-3">
        <Stat label="Paid to treasuries (USD)" value={totals ? formatUsd(totals.pushedUsd) : "…"} accent="#0B5E3A" />
        <Stat label="Accrued, claimable (USD)" value={totals ? formatUsd(totals.accruedUsd) : "…"} accent="#FFD60A" />
        <Stat label="Unpriced tokens" value={totals ? totals.unpricedTokens : "…"} accent="#0052FF" note={totals && totals.testnetRows > 0 ? `${totals.testnetRows} testnet rows not totalled.` : undefined} />
      </dl>
      {view && Math.abs((totals?.pushedUsd ?? 0) - view.totals.pushedUsd) > 0.01 ? (
        <p className="text-sm font-semibold text-warning">The API's total differs from the rows shown ({formatUsd(view.totals.pushedUsd)}); the rows are what was read.</p>
      ) : null}
      {view?.errors.map((item) => (
        <p key={item.network} role="alert" className="border-l-[4px] border-[#B91C1C] bg-danger-bg px-3 py-2 text-sm font-semibold text-danger">
          {networkName(item.network)}: {item.message}
        </p>
      ))}
      {fees.isLoading ? <Skeleton className="h-64" surface="card" /> : null}
      {view && view.rows.length === 0 ? <EmptyState>No fees recorded yet.</EmptyState> : null}
      {view
        ? ADMIN_EVM_NETWORKS.filter((network) => view.rows.some((row) => row.network === network)).map((network) => {
            const line = lineFor(network);
            return (
              <section key={network} className="flex flex-col gap-3" aria-label={`Fees on ${networkName(network)}`}>
                <h2 className="flex items-center gap-2 font-display text-xl font-bold">
                  {line ? <LineBullet line={line} decorative /> : null}
                  {networkName(network)}
                  {view.rows.some((row) => row.network === network && isTestnetRow(row)) ? <StatusPill tone="neutral">Testnet</StatusPill> : null}
                </h2>
                <ul className="flex flex-col gap-3">
                  {view.rows
                    .filter((row) => row.network === network)
                    .map((row) => (
                      <FeeRowCard key={`${row.contractId}:${row.address}:${row.kind}`} row={row} />
                    ))}
                </ul>
              </section>
            );
          })
        : null}
      {view ? <p className={cx("text-sm", TEXT_MUTED)}>As of {view.asOf.slice(0, 19).replace("T", " ")} UTC. Stablecoins count as one dollar; native and wrapped native use the API's price; other tokens stay unpriced.</p> : null}
    </div>
  );
}

function FeeRowCard({ row }: { readonly row: AdminFeeRow }) {
  const { client, catalog, book, signer, goTo } = useAdmin();
  const run = useOwnerCall();
  const [busy, setBusy] = useState<"claim" | "rescan" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const claim = claimState(row);
  const scan = scanText(row);
  const name = catalog?.contracts[row.contractId]?.name ?? row.contractId;
  const signerAddress = signer.ready ? signer.address : null;

  const doClaim = async () => {
    if (!row.claim || !signerAddress) return;
    const abi = CLAIM_ABIS[row.claim.fn];
    if (!abi) {
      setError(`The panel has no form for ${row.claim.fn}. Use Manage.`);
      return;
    }
    setBusy("claim");
    setError(null);
    try {
      const to = row.recipient ?? signerAddress;
      const amount = row.amounts.find((item) => item.amount !== "0");
      const args =
        row.claim.fn === "withdraw"
          ? [getAddress(to)]
          : row.claim.fn === "transfer"
            ? [getAddress(signerAddress), BigInt(amount?.amount ?? "0")]
            : [amount?.token === "native" ? NATIVE_TOKEN : getAddress(amount?.token ?? NATIVE_TOKEN), getAddress(to), BigInt(amount?.amount ?? "0")];
      const target = row.claim.fn === "transfer" && amount && amount.token !== "native" ? amount.token : row.address;
      const result = await run({
        network: row.network,
        address: target,
        abi,
        functionName: row.claim.fn,
        args,
        actionId: null,
        description: `Claim ${amount ? formatTokenAmount(amount) : ""} from ${name} (${networkName(row.network)})`,
        via: row.claim.via === "direct" ? "direct" : { safe: row.claim.caller },
      });
      if (result.kind === "sent") toast.success("Claimed", { description: "The API re-read the transaction and logged it." });
      else toast.success("Proposal signed", { action: { label: "Safe queue", onClick: () => goTo("safe") } });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const rescan = async () => {
    if (!row.scanKey) return;
    setBusy("rescan");
    try {
      const result = await client.rescanFees(row.scanKey);
      toast.info("Scan continued", { description: `Through block ${result.scannedThroughBlock}.` });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className={cx("flex flex-col gap-3 p-4", INK_BORDER_THIN, SURFACE)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-display text-lg font-bold">{name}</p>
          <AddressText address={row.address} network={row.network} />
        </div>
        <StatusPill tone={row.kind === "accrued" ? "warning" : row.kind === "pushed" ? "success" : "neutral"}>{FEE_KIND_LABELS[row.kind]}</StatusPill>
      </div>
      {row.amounts.length > 0 ? (
        <ul className="flex flex-wrap gap-x-6 gap-y-1">
          {row.amounts.map((amount) => (
            <li key={amount.token} className="flex items-baseline gap-2">
              <span className="font-code text-base font-bold">{formatTokenAmount(amount)}</span>
              <span className={cx("text-sm", TEXT_MUTED)}>{isTestnetRow(row) ? "testnet" : formatUsd(amount.usd)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={cx("text-sm", TEXT_MUTED)}>Nothing recorded.</p>
      )}
      {row.recipient ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className={cx(LABEL, TEXT_MUTED)}>{row.kind === "pushed" ? "Paid to" : "Goes to"}</span>
          <AddressText address={row.recipient} network={row.network} book={book} copy={false} />
        </p>
      ) : null}
      {row.note ? <p className={cx("text-sm", TEXT_MUTED)}>{row.note}</p> : null}
      {scan ? <p className={cx("text-sm", TEXT_MUTED)}>{scan}</p> : null}
      {error ? (
        <p role="alert" className="text-sm font-bold text-danger">
          {error}
        </p>
      ) : null}
      {row.scanKey ? <StepUpNote /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {row.claim ? (
          <Button variant="accent" size="sm" onClick={() => void doClaim()} loading={busy === "claim"} disabled={!claim.available || !signerAddress || busy !== null}>
            <HandCoins className="h-4 w-4" aria-hidden="true" />
            {row.claim.via === "safe" ? "Propose the claim" : `Claim with ${row.claim.fn}`}
          </Button>
        ) : null}
        {row.scanKey ? (
          <Button variant="secondary" size="sm" onClick={() => void rescan()} loading={busy === "rescan"} disabled={busy !== null}>
            Continue the scan
          </Button>
        ) : null}
        {claim.reason && !(row.note && !row.claim) ? <span className={cx("text-sm", TEXT_MUTED)}>{claim.reason}</span> : null}
        {row.claim && claim.available && !signerAddress ? <span className={cx("text-sm", TEXT_MUTED)}>{signer.ready ? null : signer.reason}</span> : null}
      </div>
    </li>
  );
}
