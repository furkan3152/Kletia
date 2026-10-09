/**
 * Wallet execution for Intent Studio. Loaded with React.lazy only when the
 * user asks to execute (or a resumable intent exists), so the Studio route
 * itself never ships wagmi, RainbowKit or Solana wallet code.
 */
import { CHAINS, type AccountId, type IntentGraph, type IntentRequest, type IntentStep, type NetworkKey } from "@kletia/core";
import { ArrowUpRight, CircleCheck, History, Wallet, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { STUDIO_INTENT_SESSION_KEY } from "../../../shared/platform/intentSession";
import { sameOwner } from "../../../shared/platform/intentSigners";
import { useIntentExecution, type IntentExecution } from "../../../shared/platform/useIntentExecution";
import { shortenAddress, type ConnectedAccount } from "../../../shared/wallet/types";
import { WalletDock } from "../../../shared/wallet/WalletDock";
import { WalletProviders } from "../../providers";
import { IntentExecutionFlow } from "../../site/intent/IntentExecutionFlow";
import { networkColor, networkName } from "../../site/intent/format";
import { useChangeKey } from "../../site/motion/useChangeKey";
import { Button, ButtonLink } from "../../site/ui/Button";
import { Skeleton, SkeletonGroup, SkeletonText } from "../../site/ui/Skeleton";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";

export interface StudioExecutionPanelProps {
  /** The dry-run plan the user chose to execute (planned with demo or typed accounts). */
  readonly preview: IntentGraph | null;
  /** Intent id stored by a previous page load of this tab. */
  readonly resumeIntentId: string | null;
  readonly onClose: () => void;
  /** Reports whether a plan or execution is in flight (the page locks its launcher). */
  readonly onBusyChange?: (busy: boolean) => void;
}

type Namespace = "eip155" | "solana";

function namespacesOf(intent: IntentGraph): Set<Namespace> {
  const networks = new Set<NetworkKey>();
  for (const step of intent.steps) {
    networks.add(step.network);
    if (step.settlement?.destinationNetwork) networks.add(step.settlement.destinationNetwork);
  }
  for (const network of intent.summary.networks) networks.add(network);
  return new Set([...networks].filter((network) => CHAINS[network]).map((network) => CHAINS[network].namespace as Namespace));
}

function requestFor(preview: IntentGraph): Omit<IntentRequest, "accounts"> {
  const { request } = preview;
  return {
    ...(request.text ? { text: request.text } : {}),
    ...(request.actions ? { actions: request.actions } : {}),
    ...(request.defaultNetwork ? { defaultNetwork: request.defaultNetwork } : {}),
    ...(request.constraints ? { constraints: request.constraints } : {}),
  };
}

function connectedFor(execution: IntentExecution, namespace: Namespace): ConnectedAccount | null {
  return namespace === "eip155" ? execution.evm : execution.solana;
}

function WalletRequirement({ namespace, account }: { namespace: Namespace; account: ConnectedAccount | null }) {
  const label = namespace === "eip155" ? "EVM wallet" : "Solana wallet";
  // The check stamps in when a wallet connects during this visit (not when it was already connected).
  const connectedKey = useChangeKey(Boolean(account));
  return (
    <li
      className={cx(
        "flex flex-wrap items-center justify-between gap-2 border-2 border-[#1A1A1A] px-3 py-2 transition-colors duration-240 dark:border-[#4B5563]",
        account ? "bg-[#ECFDF5] dark:bg-[#0F2A1D]" : "bg-[#FBFAF7] dark:bg-[#0F1A2C]",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-bold">
        {account ? (
          <CircleCheck
            className={cx("h-4 w-4 text-[#047857] dark:text-[#4ADE80]", connectedKey > 0 && "kl-stamp")}
            aria-hidden="true"
          />
        ) : (
          <Wallet className="h-4 w-4 text-[#45464B] dark:text-[#A9B6C8]" aria-hidden="true" />
        )}
        {label}
      </span>
      <span className={cx("font-code text-xs", account ? "font-bold" : TEXT_MUTED)}>
        {account ? `${account.walletName} · ${shortenAddress(account.address)}` : "Not connected"}
      </span>
    </li>
  );
}

function StepBindings({ preview, execution }: { preview: IntentGraph; execution: IntentExecution }) {
  const steps = [...preview.steps].sort((a, b) => a.index - b.index);
  return (
    <ol className="flex flex-col gap-2" aria-label="Accounts each step will use">
      {steps.map((step) => {
        const namespace = CHAINS[step.network]?.namespace as Namespace | undefined;
        const account = namespace ? connectedFor(execution, namespace) : null;
        return (
          <li key={step.id} className="flex flex-col gap-1 border-l-[3px] pl-3" style={{ borderColor: networkColor(step.network) }}>
            <span className="text-sm font-bold">
              {String(step.index + 1).padStart(2, "0")} · {step.title}
            </span>
            <span className={cx("text-xs", TEXT_MUTED)}>
              {networkName(step.network)} ·{" "}
              {step.mode !== "wallet"
                ? "no signature needed"
                : account
                  ? <>signs with <span className="font-code font-bold">{account.walletName} {shortenAddress(account.address)}</span></>
                  : `connect a ${namespace === "solana" ? "Solana" : "EVM"} wallet`}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function SectionTitle({ index, title, done }: { index: number; title: string; done?: boolean }) {
  // The number box swaps to ✓ with a stamp when the section completes during this visit.
  const doneKey = useChangeKey(Boolean(done));
  return (
    <h3 className="flex items-center gap-3 font-display text-xl font-bold tracking-[-0.01em]">
      <span
        aria-hidden="true"
        className={cx(
          "flex h-8 w-8 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] text-sm font-black shadow-[2px_2px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[2px_2px_0_#475569]",
          done ? "bg-[#4ADE80] text-[#0B1120]" : "bg-[#FFD60A] text-[#1A1A1A]",
          done && doneKey > 0 && "kl-stamp",
        )}
      >
        {done ? "✓" : index}
      </span>
      {title}
    </h3>
  );
}

/** "Planning with your accounts…": a placeholder shaped like the review that follows. */
function ReviewSkeleton() {
  return (
    <SkeletonGroup label="Planning with your accounts" className="flex flex-col gap-4">
      <div className={cx("flex flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>Planning with your accounts…</p>
          <div className="flex gap-2">
            <Skeleton surface="card" className="h-6 w-24 border-2" />
            <Skeleton surface="card" className="h-6 w-24 border-2" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5">
              <Skeleton surface="card" className="h-2.5 w-16 border-2" />
              <Skeleton surface="card" className="h-4 w-24 border-2" />
            </div>
          ))}
        </div>
      </div>
      <div className={cx("flex flex-col gap-3 p-4", INK_BORDER, SURFACE)}>
        <div className="flex gap-2">
          <Skeleton surface="card" className="h-5 w-6 border-2" />
          <Skeleton surface="card" className="h-6 w-14 border-2" />
          <Skeleton surface="card" className="h-6 w-20 border-2" />
        </div>
        <Skeleton surface="card" className="h-5 w-2/3" />
        <SkeletonText surface="card" lines={2} />
      </div>
      <div className={cx("flex flex-col gap-4 p-4 sm:p-5", INK_BORDER, SURFACE)}>
        <div className="flex items-start gap-3">
          <Skeleton surface="card" className="h-5 w-5 shrink-0" />
          <SkeletonText surface="card" lines={2} className="flex-1" />
        </div>
        <Skeleton surface="card" className="h-14 w-56" />
      </div>
    </SkeletonGroup>
  );
}

function StudioExecution({ preview, resumeIntentId, onClose, onBusyChange }: StudioExecutionPanelProps) {
  const execution = useIntentExecution({ sessionKey: STUDIO_INTENT_SESSION_KEY, metadata: { surface: "studio" } });
  const { status, intent } = execution;
  const needed = useMemo(() => (preview ? namespacesOf(preview) : new Set<Namespace>()), [preview]);
  const needsEvm = needed.has("eip155");
  const needsSolana = needed.has("solana");
  const walletsReady = (!needsEvm || Boolean(execution.evm)) && (!needsSolana || Boolean(execution.solana));
  const accountsKey = execution.accounts.join(",");
  const request = useMemo(() => (preview ? requestFor(preview) : null), [preview]);
  const busy = status === "planning" || status === "executing";

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  // Re-plan with the real accounts once the wallets the plan needs are
  // connected (and again if the user switches accounts before signing).
  const plannedForRef = useRef<string | null>(null);
  const planWithWallets = execution.plan;
  useEffect(() => {
    if (!request || !walletsReady) return;
    if (status !== "idle" && status !== "review" && status !== "failed") return;
    if (status === "failed" && intent) return;
    if (plannedForRef.current === accountsKey) return;
    plannedForRef.current = accountsKey;
    void planWithWallets(request);
  }, [accountsKey, intent, planWithWallets, request, status, walletsReady]);

  const replan = useCallback(() => {
    if (request) void planWithWallets(request);
  }, [planWithWallets, request]);

  const describeAccount = useCallback(
    (accountId: AccountId) => {
      for (const account of [execution.evm, execution.solana]) {
        if (account && sameOwner(account.accountId, accountId)) {
          return `${account.walletName} · ${shortenAddress(account.address)}`;
        }
      }
      return null;
    },
    [execution.evm, execution.solana],
  );
  const walletFor = useCallback(
    (step: IntentStep) => {
      for (const account of [execution.evm, execution.solana]) {
        if (account && sameOwner(account.accountId, step.account)) return account.walletName;
      }
      return null;
    },
    [execution.evm, execution.solana],
  );

  const resumeMode = !preview && Boolean(resumeIntentId);
  const started = Boolean(intent) && status !== "review" && status !== "planning";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>Execute with your wallets</p>
          <h2 id="studio-execute-heading" tabIndex={-1} className="mt-1 font-display text-3xl font-bold tracking-[-0.03em] focus:outline-none sm:text-4xl">
            {preview ? preview.summary.title : intent?.summary.title ?? "Resume your intent"}
          </h2>
          {preview?.request.text ? (
            <p className={cx("mt-2 font-code text-sm", TEXT_MUTED)}>“{preview.request.text}”</p>
          ) : null}
        </div>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy} aria-label="Close the execution panel">
          <X className="h-4 w-4" aria-hidden="true" />
          Close
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:gap-10">
        <aside className="flex flex-col gap-6">
          <div className={cx("flex flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
            <SectionTitle index={1} title="Connect wallets" done={walletsReady && Boolean(preview)} />
            <WalletDock evmWorkspace={false} className="flex-wrap" />
            {preview ? (
              <ul className="flex flex-col gap-2" aria-label="Wallets this intent needs">
                {needsEvm ? <WalletRequirement namespace="eip155" account={execution.evm} /> : null}
                {needsSolana ? <WalletRequirement namespace="solana" account={execution.solana} /> : null}
              </ul>
            ) : null}
            <p className={cx("text-xs leading-relaxed", TEXT_MUTED)}>
              Kletia never holds keys. Each value-moving step is prepared as an unsigned transaction and signed in your
              own wallet.
            </p>
          </div>
          {preview ? (
            <div className={cx("flex flex-col gap-3 p-4 sm:p-5", INK_BORDER, SURFACE)}>
              <p className={LABEL}>Who signs each step</p>
              <StepBindings preview={preview} execution={execution} />
            </div>
          ) : null}
        </aside>

        <div className="flex min-w-0 flex-col gap-6">
          {resumeMode && !intent && status !== "executing" ? (
            <div className={cx("kl-rise flex flex-col gap-4 p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
              <SectionTitle index={2} title="Pick up where you left off" />
              <p className="text-sm leading-relaxed">
                This tab was executing an intent before it reloaded. Resuming refreshes its status from Kletia and
                continues with the next step. Steps that were already submitted are never signed again.
              </p>
              <p className={cx("break-all font-code text-xs", TEXT_MUTED)}>{resumeIntentId}</p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => void execution.resume(resumeIntentId ?? undefined)}>
                  <History className="h-4 w-4" aria-hidden="true" />
                  Resume
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    execution.forgetResumable();
                    onClose();
                  }}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          ) : null}

          {preview && !walletsReady ? (
            <div className={cx("flex flex-col gap-3 p-5", INK_BORDER, SURFACE)}>
              <SectionTitle index={2} title="Plan with your accounts" />
              <p className="text-sm leading-relaxed">
                The preview used demo accounts. Connect {needsEvm && needsSolana ? "an EVM and a Solana wallet" : needsSolana ? "a Solana wallet" : "an EVM wallet"}{" "}
                and Kletia plans this intent again with your own accounts, balances and live quotes before anything is
                signed.
              </p>
            </div>
          ) : null}

          {status === "planning" && !intent ? <ReviewSkeleton /> : null}

          {intent || status === "failed" ? (
            <div className="flex flex-col gap-4">
              <SectionTitle
                index={started ? 3 : 2}
                title={started ? "Execute" : "Review and confirm"}
                done={status === "completed"}
              />
              <IntentExecutionFlow
                execution={execution}
                describeAccount={describeAccount}
                walletFor={walletFor}
                {...(request ? { onReplan: replan } : {})}
                notifyProgress
                outcomeFooter={
                  <div className="flex flex-wrap gap-3">
                    <ButtonLink to="/app" size="sm">
                      Open console activity
                      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </ButtonLink>
                    <Button size="sm" variant="secondary" onClick={onClose}>
                      Plan another intent
                    </Button>
                  </div>
                }
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Lazily loaded Studio execution panel: wallet providers plus the execution flow. */
export default function StudioExecutionPanel(props: StudioExecutionPanelProps) {
  return (
    <WalletProviders>
      <StudioExecution
        key={props.preview ? `plan:${props.preview.id}` : `resume:${props.resumeIntentId ?? ""}`}
        {...props}
      />
    </WalletProviders>
  );
}
