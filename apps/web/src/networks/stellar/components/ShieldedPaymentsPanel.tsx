import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
  KeyRound,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { BACKEND_URL } from "../../../shared/config/runtime";
import {
  compileLocalShieldedIntent,
  openPrivatePaymentsSession,
  PrivatePaymentsArchiveConsentRequiredError,
  privatePaymentsAmountAtomic,
  readPrivatePaymentsBrowserReport,
  type PrivatePaymentsOperation,
  type PrivatePaymentsSession,
} from "../runtime/privatePayments";

type ReadinessResponse = {
  success?: boolean;
  privatePayments?: {
    readiness?: {
      xlmLifecycle?: "available" | "quarantined";
      usdcLifecycle?: "not_deployed";
    };
    privacyProperties?: {
      inPoolAmountsHidden?: boolean;
      inPoolBalancesHidden?: boolean;
      recipientLinkHiddenFromPublicLedger?: boolean;
      transactionSubmitterOrAuthorizationMayBePublic?: boolean;
    };
    claimBoundary?: {
      audited?: boolean;
      productionReady?: boolean;
      privateBridge?: boolean;
      privateEvmExecution?: boolean;
    };
  };
};

const operationLabels: Record<PrivatePaymentsOperation, string> = {
  deposit: "Deposit into shielded pool",
  private_transfer: "Private in-pool transfer",
  withdraw: "Withdraw to public Stellar",
};

function formatXlm(atomic: bigint): string {
  const whole = atomic / 10_000_000n;
  const fraction = (atomic % 10_000_000n).toString().padStart(7, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The shielded operation failed.";
}

export function ShieldedPaymentsPanel({ stellarAddress }: { stellarAddress: string }) {
  const browserReport = React.useMemo(() => readPrivatePaymentsBrowserReport(), []);
  const sessionRef = React.useRef<PrivatePaymentsSession | null>(null);
  const [readiness, setReadiness] = React.useState<ReadinessResponse | null>(null);
  const [acceptedRisk, setAcceptedRisk] = React.useState(false);
  const [archiveConsent, setArchiveConsent] = React.useState(false);
  const [archiveRequired, setArchiveRequired] = React.useState(false);
  const [sessionReady, setSessionReady] = React.useState(false);
  const [registered, setRegistered] = React.useState(false);
  const [balance, setBalance] = React.useState<bigint | null>(null);
  const [noteCount, setNoteCount] = React.useState<number | null>(null);
  const [operation, setOperation] =
    React.useState<PrivatePaymentsOperation>("deposit");
  const [amount, setAmount] = React.useState("0.1");
  const [recipient, setRecipient] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [executionIndeterminate, setExecutionIndeterminate] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);
  const [localIntent, setLocalIntent] = React.useState(
    "Deposit 0.1 XLM into my shielded balance",
  );
  const [localIntentStatus, setLocalIntentStatus] = React.useState<string | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    void fetch(`${BACKEND_URL}/api/stellar/private-payments/readiness`, {
      headers: { "X-Kletia-Chain-Ref": "stellar:testnet" },
    })
      .then(async (response) => response.json() as Promise<ReadinessResponse>)
      .then((body) => {
        if (!cancelled) setReadiness(body);
      })
      .catch(() => {
        if (!cancelled) setReadiness({ success: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => () => sessionRef.current?.close(), []);

  const runtimeReady =
    readiness?.success === true &&
    readiness.privatePayments?.readiness?.xlmLifecycle === "available";

  const refresh = React.useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    const state = await session.refresh();
    setBalance(state.balance);
    setNoteCount(state.noteCount);
    setRegistered(session.registrationPublic);
  }, []);

  const openSession = async () => {
    if (!stellarAddress) {
      setError("Connect Freighter on Stellar Testnet first.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const session = await openPrivatePaymentsSession({
        expectedAddress: stellarAddress,
        archiveConsent,
      });
      sessionRef.current?.close();
      sessionRef.current = session;
      setSessionReady(true);
      setRegistered(session.registrationPublic);
      setArchiveRequired(session.archiveUsed);
      await refresh();
    } catch (caught) {
      if (caught instanceof PrivatePaymentsArchiveConsentRequiredError) {
        setArchiveRequired(true);
      }
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    const session = sessionRef.current;
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const reference = await session.registerPublicKeys();
      setRegistered(true);
      setResult(
        `Recipient discovery keys registered publicly. Transaction ${reference}.`,
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    const session = sessionRef.current;
    if (!session) return;
    if (executionIndeterminate) {
      setError(
        "This session has an indeterminate shielded submission. Do not retry it; sync notes and inspect the connected Stellar account first.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const atomic = privatePaymentsAmountAtomic(amount);
      const outcome = await session.execute(
        operation,
        atomic,
        operation === "deposit" ? undefined : recipient || stellarAddress,
      );
      await refresh();
      setResult(
        outcome.references.length > 0
          ? `The upstream SDK completed and local note state was refreshed. Reference: ${outcome.references.join(", ")}.`
          : "The upstream SDK completed and local note state was refreshed. No transaction hash was exposed by this SDK response, so Kletia does not label it independently chain-verified.",
      );
    } catch (caught) {
      const walletCode =
        caught && typeof caught === "object" && "code" in caught
          ? (caught as { code?: unknown }).code
          : undefined;
      const message = errorText(caught);
      const explicitlyRejected =
        walletCode === -4 || /\b(?:rejected|declined|denied|cancelled)\b/iu.test(message);
      if (!explicitlyRejected) {
        setExecutionIndeterminate(true);
        setError(
          `${message} The result may be indeterminate after wallet authorization. Silent retry is locked for this session; sync notes and inspect the public account before taking another action.`,
        );
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  const applyLocalIntent = () => {
    setError(null);
    const resolution = compileLocalShieldedIntent(localIntent);
    if (resolution.status === "clarification") {
      setLocalIntentStatus(resolution.question);
      return;
    }
    setOperation(resolution.operation);
    setAmount(resolution.amount);
    setRecipient(resolution.recipient || "");
    setLocalIntentStatus(resolution.explanation);
  };

  return (
    <section className="stellar-panel stellar-shielded-panel" aria-labelledby="shielded-payments-title">
      <div className="stellar-panel-header">
        <div>
          <p className="stellar-eyebrow">Real ZK privacy · experimental Testnet</p>
          <h2 id="shielded-payments-title">Shielded Stellar payments</h2>
        </div>
        <LockKeyhole aria-hidden="true" />
      </div>

      <div className="stellar-shielded-truth-grid">
        <div data-tone="positive">
          <ShieldCheck aria-hidden="true" />
          <strong>Hidden by proof</strong>
          <span>In-pool amount, private balance, spent-note link, and recipient output link.</span>
        </div>
        <div data-tone="warning">
          <AlertTriangle aria-hidden="true" />
          <strong>Still public</strong>
          <span>Deposit/withdraw amount and address, pool interaction timing, and possibly submitter or authorization identity.</span>
        </div>
        <div data-tone="danger">
          <KeyRound aria-hidden="true" />
          <strong>Not claimed</strong>
          <span>No private bridge, no hidden Aave execution, no USDC pool, no audit, and no mainnet safety.</span>
        </div>
      </div>

      <div className="stellar-notice" data-tone={runtimeReady ? "positive" : "warning"}>
        <strong>{runtimeReady ? "Pinned XLM privacy-pool contracts are live." : "The shielded runtime is quarantined."}</strong>{" "}
        This surface uses Nethermind Stellar Private Payments 0.1.0-alpha.1 directly in the browser. Kletia API never receives note secrets, witnesses, or private transfer amounts.
      </div>

      <div className="stellar-shielded-intent">
        <label className="stellar-label" htmlFor="shielded-local-intent">
          Private intent · compiled only in this browser
          <textarea
            id="shielded-local-intent"
            className="stellar-textarea"
            rows={2}
            value={localIntent}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setLocalIntent(event.target.value);
              setLocalIntentStatus(null);
            }}
          />
        </label>
        <div className="stellar-shielded-actions">
          <button
            type="button"
            className="stellar-button"
            onClick={applyLocalIntent}
          >
            <Fingerprint aria-hidden="true" />
            Compile locally
          </button>
          <button
            type="button"
            className="stellar-button"
            onClick={() => {
              setLocalIntent("Withdraw 0.1 XLM to my connected account");
              setLocalIntentStatus(null);
            }}
          >
            Use withdrawal example
          </button>
        </div>
        <small className="stellar-field-help">
          This field is never sent to Kletia API or an AI model. The local
          compiler accepts one reviewed operation and asks instead of guessing.
        </small>
        {localIntentStatus ? (
          <div className="stellar-notice" role="status">
            {localIntentStatus}
          </div>
        ) : null}
      </div>

      {!sessionReady ? (
        <div className="stellar-compact-form">
          <label className="stellar-consent-row">
            <input
              type="checkbox"
              checked={acceptedRisk}
              onChange={(event) => setAcceptedRisk(event.target.checked)}
            />
            <span>
              I understand this is unaudited Testnet research software and will not use real assets.
            </span>
          </label>
          {archiveRequired ? (
            <label className="stellar-consent-row">
              <input
                type="checkbox"
                checked={archiveConsent}
                onChange={(event) => setArchiveConsent(event.target.checked)}
              />
              <span>
                Allow the Nethermind archive to restore old pool events. It can observe my IP and event queries and can omit or forge history; live pool-root checks still gate spending.
              </span>
            </label>
          ) : null}
          <div className="stellar-capability-list">
            {browserReport.capabilities.map((capability) => (
              <div className="stellar-capability-item" key={capability.capability}>
                <div>
                  <strong>{capability.capability.replace(/_/gu, " ")}</strong>
                  <small>{capability.detail}</small>
                </div>
                {capability.ready ? <CheckCircle2 aria-label="available" /> : <AlertTriangle aria-label="unavailable" />}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="stellar-button"
            data-variant="positive"
            disabled={busy || !acceptedRisk || !browserReport.ready || !runtimeReady || !stellarAddress || (archiveRequired && !archiveConsent)}
            onClick={() => void openSession()}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Fingerprint aria-hidden="true" />}
            Load local proof wallet
          </button>
        </div>
      ) : (
        <div className="stellar-compact-form" aria-busy={busy}>
          <div className="stellar-shielded-balance">
            <span>Private XLM balance</span>
            <strong>{balance === null ? "—" : `${formatXlm(balance)} XLM`}</strong>
            <small>{noteCount ?? "—"} locally decrypted note(s) · amount never sent to Kletia API</small>
          </div>

          {!registered ? (
            <div className="stellar-notice" data-tone="warning">
              <strong>Your shielded discovery keys are not registered.</strong>{" "}
              Registration publicly links this G-account to shielded receive keys. It does not reveal later private transfer amounts or which private output belongs to you.
              <button
                type="button"
                className="stellar-button"
                disabled={busy}
                onClick={() => void register()}
              >
                <KeyRound aria-hidden="true" />
                Review my public key registration
              </button>
            </div>
          ) : null}

          <div className="stellar-segmented" role="group" aria-label="Shielded operation">
            {(Object.keys(operationLabels) as PrivatePaymentsOperation[]).map((kind) => (
              <button
                type="button"
                key={kind}
                className="stellar-button"
                data-variant={operation === kind ? "primary" : undefined}
                aria-pressed={operation === kind}
                onClick={() => setOperation(kind)}
              >
                {operationLabels[kind]}
              </button>
            ))}
          </div>

          <label className="stellar-label" htmlFor="shielded-xlm-amount">
            {operation === "private_transfer" ? "Private transfer amount" : "Public amount"}
            <span className="stellar-input-group">
              <input
                id="shielded-xlm-amount"
                className="stellar-input"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <span className="stellar-input-suffix">XLM</span>
            </span>
          </label>

          {operation !== "deposit" ? (
            <label className="stellar-label" htmlFor="shielded-stellar-recipient">
              {operation === "private_transfer" ? "Registered shielded recipient" : "Public withdrawal recipient"}
              <input
                id="shielded-stellar-recipient"
                className="stellar-input"
                placeholder={stellarAddress || "G…"}
                spellCheck={false}
                autoComplete="off"
                value={recipient}
                onChange={(event) => setRecipient(event.target.value.trim())}
              />
            </label>
          ) : null}

          <div className="stellar-notice" data-tone={operation === "private_transfer" ? "positive" : "warning"}>
            {operation === "private_transfer"
              ? "The amount and recipient output link are shielded inside the pool. The transaction still reveals that someone interacted with this pool at this time."
              : "This boundary crosses between public Stellar and the shielded pool, so the amount and public address are visible onchain."}
          </div>

          <div className="stellar-shielded-actions">
            <button
              type="button"
              className="stellar-button"
              data-variant="positive"
              disabled={
                busy ||
                executionIndeterminate ||
                (operation === "private_transfer" && !registered)
              }
              onClick={() => void execute()}
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Fingerprint aria-hidden="true" />}
              Review, prove, and sign
            </button>
            <button
              type="button"
              className="stellar-button"
              disabled={busy}
              onClick={() => void refresh().catch((caught) => setError(errorText(caught)))}
            >
              <RefreshCw aria-hidden="true" />
              Sync private notes
            </button>
          </div>
        </div>
      )}

      {error ? <div className="stellar-error" role="alert">{error}</div> : null}
      {executionIndeterminate ? (
        <div className="stellar-notice" data-tone="danger" role="status">
          <strong>Indeterminate submission lock.</strong> Kletia will not resend
          this operation automatically or let a button click duplicate it in
          this session.
        </div>
      ) : null}
      {result ? <div className="stellar-notice" data-tone="positive" role="status">{result}</div> : null}
    </section>
  );
}
