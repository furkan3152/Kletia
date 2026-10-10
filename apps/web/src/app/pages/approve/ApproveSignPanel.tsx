/**
 * The approver's desk: connect the wallet the rule book names, choose a
 * decision, confirm it, and sign. Loaded lazily (wallet SDKs never reach the
 * gate page itself).
 *
 * The signature goes through `client.approvals.approveWithWallet` /
 * `rejectWithWallet` from `@kletia/sdk`, which reads the approval again,
 * recomputes its digest from the intent it names and refuses to sign when
 * they differ, then has the wallet sign exactly the `@kletia/core` typed data
 * (EIP-712 "Kletia Approvals" v1 on EVM) or message text (Solana
 * `signMessage`). Nothing here sends a transaction.
 */
import "../../site/art/base.css";
import "./approve.css";

import { parseAccountId } from "@kletia/core";
import type { ApprovalTypedData, ApprovalWalletSigner, PolicyApprovalView } from "@kletia/sdk";
import { SolanaSignMessage, type SolanaSignMessageFeature } from "@solana/wallet-standard-features";
import { Check, PenLine, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";

import { getKletiaClient, toPlatformError, type PlatformError } from "../../../shared/platform/kletiaClient";
import { useSolanaWallet } from "../../../shared/wallet/solana/useSolanaWallet";
import { shortenAddress } from "../../../shared/wallet/types";
import { useWallets } from "../../../shared/wallet/useWallets";
import { WalletDock } from "../../../shared/wallet/WalletDock";
import { WalletProviders } from "../../providers";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Button } from "../../site/ui/Button";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { formatStamp, formatUsd, maskedMatches, walletFamily, type WalletFamily } from "./approveModel";

export interface ApproveSignPanelProps {
  readonly view: PolicyApprovalView;
  /** The approval as the API answered after the decision. */
  readonly onDecided: (view: PolicyApprovalView) => void;
  readonly onClose: () => void;
}

/** How long a decision signature stays valid (never past the approval's own expiry). */
const VALID_FOR_SECONDS = 600;

interface Candidate {
  readonly family: WalletFamily;
  readonly walletName: string;
  readonly address: string;
  readonly accountId: string;
  /** The address fits one of the masked approver wallets. */
  readonly listed: boolean;
}

/** Network codes and SDK refusals that were checked locally (status 0) keep their own message. */
function describe(error: PlatformError): string | undefined {
  if (error.status === 0 && !["NETWORK_ERROR", "REQUEST_TIMEOUT"].includes(error.code)) return error.message;
  return undefined;
}

function walletRejected(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  return code === 4001 || code === "ACTION_REJECTED" || /reject|denied|cancel/iu.test(message);
}

function Desk({ view, onDecided, onClose }: ApproveSignPanelProps) {
  const wallets = useWallets();
  const { chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const solana = useSolanaWallet();
  const radioName = useId();
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [chosen, setChosen] = useState<WalletFamily | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PlatformError | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const inFlight = useRef(false);

  const listedFamilies = useMemo(() => new Set(view.approvers.wallets.map(walletFamily)), [view.approvers.wallets]);
  const candidates = useMemo<Candidate[]>(() => {
    const out: Candidate[] = [];
    for (const account of [wallets.evm, wallets.solana]) {
      if (!account) continue;
      const family: WalletFamily = account.namespace === "eip155" ? "evm" : "solana";
      if (!listedFamilies.has(family)) continue;
      out.push({
        family,
        walletName: account.walletName,
        address: account.address,
        accountId: account.accountId,
        listed: view.approvers.wallets.some((masked) => walletFamily(masked) === family && maskedMatches(masked, account.address)),
      });
    }
    return out;
  }, [listedFamilies, view.approvers.wallets, wallets.evm, wallets.solana]);
  const usable = candidates.filter((candidate) => candidate.listed);
  const signer = usable.find((candidate) => candidate.family === chosen) ?? usable[0] ?? null;
  const unlisted = candidates.filter((candidate) => !candidate.listed);

  // EIP-712 is signed on the wallet's active chain: it must be a network Kletia knows.
  const evmChainMismatch = signer?.family === "evm" && parseAccountId(signer.accountId)?.chain.evmChainId !== chainId;
  const solanaSigner = solana.wallet?.features[SolanaSignMessage] as SolanaSignMessageFeature[typeof SolanaSignMessage] | undefined;
  const solanaCannotSign = signer?.family === "solana" && !solanaSigner;
  const [chosenAt, setChosenAt] = useState(0);
  const expiresAt = Math.min(Math.floor(chosenAt / 1000) + VALID_FOR_SECONDS, view.signing.maxExpiresAt);
  const choose = (next: "approve" | "reject") => {
    setDecision(next);
    setChosenAt(Date.now());
  };

  const sign = async () => {
    if (!signer || !decision || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setCancelled(false);
    try {
      let walletSigner: ApprovalWalletSigner;
      if (signer.family === "evm") {
        const client = walletClient;
        if (!client?.account) throw new Error("Your EVM wallet is not ready to sign. Reconnect it and try again.");
        walletSigner = {
          account: signer.accountId,
          signTypedData: (typed: ApprovalTypedData) =>
            client.signTypedData({
              account: client.account,
              domain: typed.domain,
              types: typed.types,
              primaryType: typed.primaryType,
              message: typed.message,
            }),
        };
      } else {
        const account = solana.account;
        if (!solanaSigner || !account) throw new Error("This Solana wallet cannot sign messages. Connect a wallet that supports message signing.");
        walletSigner = {
          account: signer.accountId,
          signMessage: async (message: Uint8Array) => {
            const [output] = await solanaSigner.signMessage({ account, message });
            if (!output) throw new Error("The wallet returned no signature.");
            return output.signature;
          },
        };
      }
      const client = getKletiaClient();
      const decided =
        decision === "approve"
          ? await client.approvals.approveWithWallet(view.id, walletSigner, { validForSeconds: VALID_FOR_SECONDS })
          : await client.approvals.rejectWithWallet(view.id, walletSigner, { validForSeconds: VALID_FOR_SECONDS });
      onDecided(decided);
    } catch (caught) {
      if (walletRejected(caught)) setCancelled(true);
      else setError(toPlatformError(caught));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const familiesText =
    listedFamilies.size === 2 ? "an EVM or a Solana wallet" : listedFamilies.has("solana") ? "a Solana wallet" : "an EVM wallet";
  const ceiling = formatUsd(view.ceilingUsd);

  return (
    <div className={cx("flex flex-col gap-5 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cx(LABEL, "text-[#0047E0] dark:text-[#7EA6FF]")}>Approver desk</p>
          <h3 className="mt-1 font-display text-xl font-bold">{signer ? `Decide with ${signer.walletName}` : `Connect ${familiesText}`}</h3>
        </div>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
          <X className="h-4 w-4" aria-hidden="true" />
          Close
        </Button>
      </div>

      <WalletDock evmWorkspace={false} className="flex-wrap" />

      {candidates.length === 0 ? (
        <p className={cx("text-sm leading-relaxed", TEXT_MUTED)}>
          This approval needs {view.approvers.wallets.join(" or ")}. Connect that wallet with the buttons above.
        </p>
      ) : null}
      {unlisted.map((candidate) => (
        <p key={candidate.accountId} className={cx("bg-[#FFF3B0] p-3 text-sm font-semibold text-[#1A1A1A]", INK_BORDER)} role="status">
          {candidate.walletName} ({shortenAddress(candidate.address)}) is not a listed approver. This approval needs{" "}
          {view.approvers.wallets.filter((masked) => walletFamily(masked) === candidate.family).join(" or ")}. Connect that wallet.
        </p>
      ))}

      {usable.length > 1 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className={LABEL}>Sign with</legend>
          {usable.map((candidate) => (
            <label key={candidate.accountId} className="flex min-h-11 items-center gap-3 text-sm font-bold">
              <input
                type="radio"
                name={radioName}
                className="h-5 w-5 accent-[#0052FF]"
                checked={signer?.family === candidate.family}
                onChange={() => setChosen(candidate.family)}
                disabled={busy}
              />
              {candidate.walletName} · <span className="font-code">{shortenAddress(candidate.address)}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {signer ? (
        <>
          <fieldset className="flex flex-col gap-3" disabled={busy}>
            <legend className={LABEL}>Your decision</legend>
            <div className="flex flex-wrap gap-3">
              <Button variant={decision === "approve" ? "primary" : "secondary"} onClick={() => choose("approve")} aria-pressed={decision === "approve"}>
                <Check className="h-4 w-4" aria-hidden="true" />
                Approve
              </Button>
              <Button variant={decision === "reject" ? "ink" : "secondary"} onClick={() => choose("reject")} aria-pressed={decision === "reject"}>
                <X className="h-4 w-4" aria-hidden="true" />
                Reject
              </Button>
            </div>
          </fieldset>

          {decision ? (
            <div className={cx("flex flex-col gap-3 bg-[#FFFCF2] p-4 text-[#1A1A1A]", INK_BORDER)}>
              <p className="font-display text-lg font-bold">
                {decision === "approve" ? `Approve up to ${ceiling}` : "Reject and cancel the intent"}
              </p>
              <dl className="grid gap-1 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
                <dt className="font-bold">Signed by</dt>
                <dd className="font-code [overflow-wrap:anywhere]">
                  {signer.walletName} · {signer.address}
                </dd>
                <dt className="font-bold">What it signs</dt>
                <dd>
                  {signer.family === "evm" ? "Typed data “Kletia Approvals”, version 1" : "A text message that starts “Kletia approval”"}: this approval, its intent, the digest, “{decision}”, up to {ceiling}.
                </dd>
                <dt className="font-bold">Signature valid until</dt>
                <dd>About {formatStamp(new Date(expiresAt * 1000).toISOString())} (10 minutes, never past the approval's expiry)</dd>
              </dl>
              {evmChainMismatch ? (
                <p className="text-sm font-semibold text-[#7F1D1D]" role="alert">
                  Your wallet is on a network Kletia does not know. Switch it to Base, Ethereum, Arbitrum, OP Mainnet or Polygon, then sign.
                </p>
              ) : null}
              {solanaCannotSign ? (
                <p className="text-sm font-semibold text-[#7F1D1D]" role="alert">
                  This Solana wallet cannot sign messages. Connect one that can.
                </p>
              ) : null}
              <Button className="self-start" onClick={() => void sign()} disabled={busy || evmChainMismatch || solanaCannotSign} loading={busy}>
                <PenLine className="h-4 w-4" aria-hidden="true" />
                {busy ? "Waiting for your wallet" : decision === "approve" ? "Sign the approval" : "Sign the rejection"}
              </Button>
              <p className="text-xs leading-relaxed">
                If the rule book names this wallet on one network only, switch your wallet to that network before you sign. No transaction is sent and no gas is paid.
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      <div aria-live="polite">
        {cancelled ? (
          <p className="text-sm font-semibold" role="status">
            You cancelled in your wallet. Nothing was signed or sent.
          </p>
        ) : null}
        {error ? (
          <ApiErrorPanel error={error} title={decision === "reject" ? "The rejection was not recorded" : "The approval was not recorded"} {...(describe(error) ? { message: describe(error) } : {})} />
        ) : null}
      </div>
    </div>
  );
}

/** Lazily loaded approver desk: wallet providers plus the signing flow. */
export default function ApproveSignPanel(props: ApproveSignPanelProps) {
  return (
    <WalletProviders>
      <Desk {...props} />
    </WalletProviders>
  );
}
