import React from "react";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Banknote,
  Fingerprint,
  Loader2,
  RefreshCw,
  Route,
} from "lucide-react";

import {
  intentActionButtonClass,
  intentActionInputClass,
  intentPositiveButtonClass,
} from "../../../shared/components/chat/intentActionStyles";
import type { StellarWorkspaceIntentResolution } from "../runtime/intentWorkspace";
import {
  compareStellarLastMileRoutes,
  readStellarLastMileReadiness,
  type StellarLastMileCandidate,
  type StellarLastMileReadiness,
  type StellarPayoutSourceNetwork,
} from "../runtime/lastMile";
import type { StellarPasskeySession } from "../runtime/passkeyAccount";
import {
  readStellarPasskeyReadiness,
  transferSep24WithdrawalFromStellarPasskeyAccount,
} from "../runtime/passkeyAccount";
import {
  completePaymentCenterSep45,
  createPaymentCenterHostedWithdrawal,
  createPaymentCenterSession,
  preparePaymentCenterSep45Challenge,
  readPaymentCenterSession,
  refreshPaymentCenterWithdrawalStatus,
  requestPaymentCenterFirmQuote,
  submitPaymentCenterTransferEvidence,
  type PaymentCenterSessionHandle,
} from "../runtime/paymentCenter";
import { verifyAndSignStellarSep45Challenge } from "../runtime/sep45";
import { PasskeyAccountCard } from "./PasskeyAccountCard";

const inputClass = intentActionInputClass;
const buttonClass = intentActionButtonClass;
const positiveButtonClass = intentPositiveButtonClass;

const SOURCE_LABELS: Record<StellarPayoutSourceNetwork, string> = {
  stellar_testnet: "Stellar Testnet",
  arc_testnet: "Arc Testnet",
  base_sepolia: "Base Sepolia",
  arbitrum_sepolia: "Arbitrum Sepolia",
};

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The live payout comparison could not be completed.";
}

function validAmount(value: string): boolean {
  return /^\d+(?:\.\d{1,7})?$/u.test(value) && Number(value) > 0;
}

function sourceNeedsBridge(source: StellarPayoutSourceNetwork): boolean {
  return source !== "stellar_testnet";
}

export function StellarPayoutIntentCard({
  resolution,
  evmAddress,
  compact = false,
  passkeySession: externalPasskeySession,
  showPasskeySetup = true,
}: {
  resolution?: StellarWorkspaceIntentResolution;
  evmAddress?: `0x${string}`;
  compact?: boolean;
  passkeySession?: StellarPasskeySession | null;
  showPasskeySetup?: boolean;
}) {
  const [sourceNetwork, setSourceNetwork] = React.useState<StellarPayoutSourceNetwork>(
    resolution?.sourceNetwork || "stellar_testnet",
  );
  const [amountMode, setAmountMode] = React.useState<"send_exact" | "receive_exact">(
    resolution?.amountMode || "send_exact",
  );
  const [amount, setAmount] = React.useState(resolution?.amount || "100");
  const [country, setCountry] = React.useState(
    resolution?.destinationCountry || "TR",
  );
  const [currency, setCurrency] = React.useState(
    resolution?.destinationCurrency || "TRY",
  );
  const [deliveryMethod, setDeliveryMethod] = React.useState(
    resolution?.deliveryMethod || "BANK",
  );
  const [readiness, setReadiness] = React.useState<StellarLastMileReadiness | null>(null);
  const [localPasskeySession, setLocalPasskeySession] = React.useState<StellarPasskeySession | null>(null);
  const [showPasskey, setShowPasskey] = React.useState(false);
  const [candidates, setCandidates] = React.useState<StellarLastMileCandidate[]>([]);
  const [providerNotes, setProviderNotes] = React.useState<
    Array<{ provider: string; reason: string }>
  >([]);
  const [busy, setBusy] = React.useState(false);
  const [authenticatingProvider, setAuthenticatingProvider] = React.useState<string | null>(null);
  const [paymentSession, setPaymentSession] = React.useState<PaymentCenterSessionHandle | null>(null);
  const [paymentStep, setPaymentStep] = React.useState<
    "firm_quote" | "hosted_withdrawal" | "status" | "transfer" | null
  >(null);
  const [hostedWithdrawalUrl, setHostedWithdrawalUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const pollingStatus = React.useRef(false);
  const paymentSessionRef = React.useRef<PaymentCenterSessionHandle | null>(null);
  const passkeySession = externalPasskeySession ?? localPasskeySession;
  const canCompare =
    readiness?.paymentCore === "discovery_configured" &&
    validAmount(amount) &&
    /^[A-Z]{2}$/u.test(country.toUpperCase()) &&
    /^[A-Z]{3}$/u.test(currency.toUpperCase()) &&
    Boolean(deliveryMethod.trim());
  const shouldPollWithdrawal = Boolean(
    paymentSession?.session.sep24Transaction &&
      !["settled", "failed", "refunded", "canceled", "expired"].includes(
        paymentSession.session.state,
      ),
  );

  React.useEffect(() => {
    paymentSessionRef.current = paymentSession;
  }, [paymentSession]);

  React.useEffect(() => {
    let cancelled = false;
    void readStellarLastMileReadiness()
      .then((value) => {
        if (!cancelled) setReadiness(value);
      })
      .catch((caught) => {
        if (!cancelled) setError(messageOf(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!shouldPollWithdrawal) return;
    let cancelled = false;
    const refresh = async () => {
      if (pollingStatus.current) return;
      const handle = paymentSessionRef.current;
      if (!handle?.session.sep24Transaction) return;
      pollingStatus.current = true;
      try {
        const updated = await refreshPaymentCenterWithdrawalStatus(handle);
        if (!cancelled) setPaymentSession(updated);
      } catch {
        // Background polling is advisory; the explicit refresh button surfaces
        // provider errors without turning eventual consistency into UI noise.
      } finally {
        pollingStatus.current = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    shouldPollWithdrawal,
    paymentSession?.session.sessionId,
    paymentSession?.session.sep24Transaction?.transactionId,
    paymentSession?.sessionToken,
  ]);

  const resetRoutes = () => {
    setCandidates([]);
    setProviderNotes([]);
    setError(null);
    setPaymentSession(null);
    setPaymentStep(null);
    setHostedWithdrawalUrl(null);
  };

  const requestFirmQuote = async () => {
    if (!paymentSession?.session.authenticated) return;
    setPaymentStep("firm_quote");
    setError(null);
    try {
      const handle = await requestPaymentCenterFirmQuote(paymentSession);
      setPaymentSession(handle);
    } catch (caught) {
      setPaymentSession((current) => {
        if (current) {
          void readPaymentCenterSession(current)
            .then(setPaymentSession)
            .catch(() => undefined);
        }
        return current;
      });
      setError(messageOf(caught));
    } finally {
      setPaymentStep(null);
    }
  };

  const prepareHostedWithdrawal = async () => {
    if (!paymentSession?.session.firmQuote) return;
    setPaymentStep("hosted_withdrawal");
    setError(null);
    try {
      const result = await createPaymentCenterHostedWithdrawal(paymentSession);
      setPaymentSession(result.handle);
      setHostedWithdrawalUrl(result.interactiveUrl);
    } catch (caught) {
      setPaymentSession((current) => {
        if (current) {
          void readPaymentCenterSession(current)
            .then(setPaymentSession)
            .catch(() => undefined);
        }
        return current;
      });
      setError(messageOf(caught));
    } finally {
      setPaymentStep(null);
    }
  };

  const refreshWithdrawal = async () => {
    if (!paymentSession?.session.sep24Transaction) return;
    setPaymentStep("status");
    setError(null);
    try {
      setPaymentSession(
        await refreshPaymentCenterWithdrawalStatus(paymentSession),
      );
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setPaymentStep(null);
    }
  };

  const sendWithdrawal = async () => {
    const instruction =
      paymentSession?.session.sep24Transaction?.status?.transferInstruction;
    if (!paymentSession || !passkeySession || !instruction) return;
    setPaymentStep("transfer");
    setError(null);
    try {
      const passkeyReadiness = await readStellarPasskeyReadiness();
      const result = await transferSep24WithdrawalFromStellarPasskeyAccount(
        passkeyReadiness,
        passkeySession,
        instruction,
      );
      setLocalPasskeySession(result.session);
      setPaymentSession(
        await submitPaymentCenterTransferEvidence({
          handle: paymentSession,
          transactionHash: result.transactionHash,
        }),
      );
    } catch (caught) {
      if (paymentSession) {
        void readPaymentCenterSession(paymentSession)
          .then(setPaymentSession)
          .catch(() => undefined);
      }
      setError(messageOf(caught));
    } finally {
      setPaymentStep(null);
    }
  };

  const authenticatePayout = async (candidate: StellarLastMileCandidate) => {
    if (!passkeySession) {
      setError("Create or connect your Stellar passkey identity first.");
      return;
    }
    setAuthenticatingProvider(candidate.provider);
    setError(null);
    try {
      const readiness = await readStellarPasskeyReadiness();
      let handle = await createPaymentCenterSession({
        provider: candidate.provider,
        quoteRequest: {
          sourceNetwork,
          amountMode,
          amount,
          destinationCountry: country.toUpperCase(),
          destinationCurrency: currency.toUpperCase(),
          deliveryMethod: deliveryMethod.toUpperCase(),
          passkeyAccount: passkeySession.contractId,
        },
      });
      setPaymentSession(handle);
      const prepared = await preparePaymentCenterSep45Challenge(handle);
      handle = prepared.handle;
      setPaymentSession(handle);
      const signedAuthorizationEntries =
        await verifyAndSignStellarSep45Challenge({
          readiness,
          passkeyAccount: passkeySession.contractId,
          challenge: prepared.challenge,
        });
      handle = await completePaymentCenterSep45({
        handle,
        signedAuthorizationEntries,
      });
      if (!handle.session.authenticated) {
        throw new Error("The anchor did not confirm the passkey session.");
      }
      setPaymentSession(handle);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setAuthenticatingProvider(null);
    }
  };

  const compare = async () => {
    setBusy(true);
    setError(null);
    setCandidates([]);
    setProviderNotes([]);
    try {
      const result = await compareStellarLastMileRoutes({
        sourceNetwork,
        amountMode,
        amount,
        destinationCountry: country.toUpperCase(),
        destinationCurrency: currency.toUpperCase(),
        deliveryMethod: deliveryMethod.toUpperCase(),
        ...(passkeySession ? { passkeyAccount: passkeySession.contractId } : {}),
      });
      setCandidates(result.candidates);
      setProviderNotes(result.unavailableProviders);
      if (result.candidates.length === 0) {
        setError(
          "No configured anchor returned this exact country, currency, and payout rail. Kletia did not create a fallback route.",
        );
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3" aria-label="Stellar live payout planner">
      {!compact ? (
        <div className="border-[3px] border-[#1A1A1A] bg-[#EDE9FE] p-3 text-xs font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#251B43] dark:text-white">
          <strong className="block font-black uppercase">One payment identity</strong>
          Your secp256r1 passkey account is the Stellar identity for anchor authentication. It does not give Kletia custody or turn an EVM wallet into a Stellar signer.
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider">
          Funds start on
          <select
            className={inputClass}
            value={sourceNetwork}
            onChange={(event) => {
              setSourceNetwork(event.target.value as StellarPayoutSourceNetwork);
              resetRoutes();
            }}
          >
            {Object.entries(SOURCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider">
          Amount rule
          <select
            className={inputClass}
            value={amountMode}
            onChange={(event) => {
              setAmountMode(event.target.value as "send_exact" | "receive_exact");
              resetRoutes();
            }}
          >
            <option value="send_exact">Send exact USDC</option>
            <option value="receive_exact">Receive exact fiat</option>
          </select>
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider">
          {amountMode === "send_exact" ? "USDC amount" : `${currency || "Fiat"} amount`}
          <input
            className={inputClass}
            value={amount}
            inputMode="decimal"
            autoComplete="off"
            onChange={(event) => {
              setAmount(event.target.value.trim());
              resetRoutes();
            }}
          />
        </label>
        <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider">
          Payout rail
          <input
            className={inputClass}
            value={deliveryMethod}
            placeholder="BANK, SEPA, PIX…"
            autoComplete="off"
            onChange={(event) => {
              setDeliveryMethod(event.target.value.toUpperCase());
              resetRoutes();
            }}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider">
          Country
          <input
            className={inputClass}
            maxLength={2}
            value={country}
            placeholder="TR"
            onChange={(event) => {
              setCountry(event.target.value.toUpperCase());
              resetRoutes();
            }}
          />
        </label>
        <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider">
          Currency
          <input
            className={inputClass}
            maxLength={3}
            value={currency}
            placeholder="TRY"
            onChange={(event) => {
              setCurrency(event.target.value.toUpperCase());
              resetRoutes();
            }}
          />
        </label>
      </div>

      {sourceNeedsBridge(sourceNetwork) ? (
        <div className="flex items-start gap-2 border-[3px] border-[#1A1A1A] bg-[#FFF36D] p-3 text-xs font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#5B4B12] dark:text-white">
          <Route className="h-4 w-4 shrink-0" />
          Execution will first move USDC to the same Stellar payment account through a separately verified CCTP checkpoint. This comparison does not bridge or spend funds.
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        {showPasskeySetup ? <button
          type="button"
          className={buttonClass}
          onClick={() => setShowPasskey((value) => !value)}
        >
          <Fingerprint className="h-4 w-4" />
          {passkeySession
            ? "Passkey identity ready"
            : showPasskey
              ? "Hide passkey setup"
              : "Set up passkey identity"}
        </button> : (
          <div className="flex min-h-12 items-center gap-2 border-[3px] border-[#1A1A1A] bg-[#F3F4F6] px-4 py-3 text-xs font-black dark:border-[#4B5563] dark:bg-[#1A2841]">
            <Fingerprint className="h-4 w-4" /> {passkeySession ? "Passkey identity ready" : "Create the passkey identity in Step 1"}
          </div>
        )}
        <button
          type="button"
          className={positiveButtonClass}
          disabled={!canCompare || busy}
          onClick={() => void compare()}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {busy ? "Checking live providers" : "Compare live payout routes"}
        </button>
      </div>

      {showPasskeySetup && showPasskey ? (
        <PasskeyAccountCard evmAddress={evmAddress} onSessionChange={setLocalPasskeySession} showTransferTools={false} />
      ) : null}

      {readiness && readiness.paymentCore !== "discovery_configured" ? (
        <div className="flex items-start gap-2 border-[3px] border-[#1A1A1A] bg-[#FFF36D] p-3 text-xs font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#5B4B12] dark:text-white">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span><strong className="block font-black uppercase">Live payout providers not configured</strong>{readiness.reason}</span>
        </div>
      ) : null}

      {error ? (
        <div className="border-[3px] border-[#1A1A1A] bg-[#FFD9D6] p-3 text-xs font-bold dark:border-[#4B5563] dark:bg-[#4A2025]" role="alert">
          <strong className="block font-black uppercase">No executable claim</strong>
          {error}
        </div>
      ) : null}

      {candidates.map((candidate, index) => (
        <article key={`${candidate.provider}:${candidate.observedAt}`} className="grid gap-3 border-[3px] border-[#1A1A1A] bg-white p-3 shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#0F172A] dark:shadow-[3px_3px_0_#475569]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[9px] font-black uppercase tracking-wider text-[#6D28D9] dark:text-[#C4B5FD]">
                {index === 0 ? "Best live result" : "Live alternative"}
              </p>
              <h4 className="font-black">{candidate.provider}</h4>
            </div>
            <span className="border-2 border-[#1A1A1A] bg-[#B9F6D2] px-2 py-1 text-[9px] font-black uppercase text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#174C35] dark:text-white">
              SEP-38 live
            </span>
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <div className="border-2 border-[#1A1A1A] bg-[#F3F4F6] p-2 dark:border-[#4B5563] dark:bg-[#1A2841]">
              <span className="text-[9px] font-black uppercase opacity-70">You send</span>
              <strong className="mt-1 block">{candidate.sellAmount} USDC</strong>
            </div>
            <ArrowRight className="h-4 w-4" />
            <div className="border-2 border-[#1A1A1A] bg-[#B9F6D2] p-2 text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#174C35] dark:text-white">
              <span className="text-[9px] font-black uppercase opacity-70">Local payout</span>
              <strong className="mt-1 block">{candidate.buyAmount} {candidate.destinationCurrency}</strong>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-[9px] font-black uppercase">
            <span className="border-2 border-[#1A1A1A] px-2 py-1 dark:border-[#4B5563]">SEP-24 hosted withdrawal</span>
            <span className="border-2 border-[#1A1A1A] px-2 py-1 dark:border-[#4B5563]">{candidate.deliveryMethod}</span>
            {candidate.sep45Advertised ? (
              <span className="inline-flex items-center gap-1 border-2 border-[#1A1A1A] px-2 py-1 dark:border-[#4B5563]"><Fingerprint className="h-3 w-3" /> SEP-45 advertised</span>
            ) : null}
            {candidate.sep12Advertised ? (
              <span className="inline-flex items-center gap-1 border-2 border-[#1A1A1A] px-2 py-1 dark:border-[#4B5563]"><BadgeCheck className="h-3 w-3" /> SEP-12 advertised</span>
            ) : null}
            {candidate.sep31PartnerAdvertised ? (
              <span className="border-2 border-[#1A1A1A] px-2 py-1 dark:border-[#4B5563]">SEP-31 partner rail advertised</span>
            ) : null}
          </div>
          <div className="flex items-start gap-2 border-t-2 border-[#1A1A1A] pt-2 text-[10px] font-bold dark:border-[#4B5563]">
            <Banknote className="h-4 w-4 shrink-0" />
            <span>
              {paymentSession?.session.provider === candidate.provider && paymentSession.session.authenticated
                ? "Passkey identity verified. A firm quote and hosted withdrawal still must be prepared before any funds can move."
                : candidate.blockedReason} This is an indicative price, not a wallet approval.
              {candidate.realWorldSettlement === false ? " This provider is a Testnet reference anchor and does not prove a real bank payout." : ""}
            </span>
          </div>
          {candidate.sep45Advertised ? (
            <button
              type="button"
              className={positiveButtonClass}
              disabled={
                !passkeySession ||
                authenticatingProvider !== null ||
                (paymentSession?.session.provider === candidate.provider &&
                  paymentSession.session.authenticated)
              }
              onClick={() => void authenticatePayout(candidate)}
            >
              {authenticatingProvider === candidate.provider ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : paymentSession?.session.provider === candidate.provider &&
                paymentSession.session.authenticated ? (
                <BadgeCheck className="h-4 w-4" />
              ) : (
                <Fingerprint className="h-4 w-4" />
              )}
              {authenticatingProvider === candidate.provider
                ? "Verify with passkey"
                : paymentSession?.session.provider === candidate.provider &&
                    paymentSession.session.authenticated
                  ? "Passkey identity verified"
                  : passkeySession
                    ? "Continue with passkey"
                    : "Connect passkey to continue"}
            </button>
          ) : null}
          {paymentSession?.session.provider === candidate.provider &&
          paymentSession.session.authenticated ? (
            <div className="grid gap-2 border-t-[3px] border-[#1A1A1A] pt-3 dark:border-[#4B5563]">
              {paymentSession.session.firmQuote ? (
                <div className="grid gap-2 border-2 border-[#1A1A1A] bg-[#EDE9FE] p-3 text-xs font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#251B43] dark:text-white">
                  <div className="flex items-center justify-between gap-3">
                    <strong className="font-black uppercase">Firm quote</strong>
                    <span className="text-[9px] font-black uppercase">
                      Expires {new Date(paymentSession.session.firmQuote.expiresAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <p>
                    {paymentSession.session.firmQuote.sellAmount} USDC → {paymentSession.session.firmQuote.buyAmount} {currency}
                  </p>
                  {paymentSession.session.firmQuote.fee ? (
                    <p className="text-[10px]">
                      Provider fee: {paymentSession.session.firmQuote.fee.total} {paymentSession.session.firmQuote.fee.asset.startsWith("iso4217:") ? paymentSession.session.firmQuote.fee.asset.slice(8) : "USDC"}
                    </p>
                  ) : null}
                </div>
              ) : paymentSession.session.state === "authenticated" ? (
                <button
                  type="button"
                  className={positiveButtonClass}
                  disabled={paymentStep !== null}
                  onClick={() => void requestFirmQuote()}
                >
                  {paymentStep === "firm_quote" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Banknote className="h-4 w-4" />
                  )}
                  {paymentStep === "firm_quote"
                    ? "Reserving live rate"
                    : "Get firm payout quote"}
                </button>
              ) : null}

              {paymentSession.session.firmQuote &&
              paymentSession.session.state === "firm_quote_ready" &&
              !paymentSession.session.sep24Transaction ? (
                <button
                  type="button"
                  className={positiveButtonClass}
                  disabled={paymentStep !== null}
                  onClick={() => void prepareHostedWithdrawal()}
                >
                  {paymentStep === "hosted_withdrawal" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="h-4 w-4" />
                  )}
                  {paymentStep === "hosted_withdrawal"
                    ? "Creating secure provider session"
                    : "Continue to payout details"}
                </button>
              ) : null}

              {paymentSession.session.sep24Transaction && hostedWithdrawalUrl ? (
                <a
                  className={`${positiveButtonClass} justify-center`}
                  href={hostedWithdrawalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ArrowRight className="h-4 w-4" />
                  Open secure provider form
                </a>
              ) : null}

              {paymentSession.session.sep24Transaction ? (
                <div className="grid gap-2 border-2 border-[#1A1A1A] bg-[#F3F4F6] p-3 text-[10px] font-bold dark:border-[#4B5563] dark:bg-[#1A2841]">
                  <div className="flex items-center justify-between gap-3">
                    <strong className="font-black uppercase">Payout status</strong>
                    <span className="font-black uppercase">
                      {paymentSession.session.sep24Transaction.status?.status
                        ?.replace(/_/gu, " ") || "Waiting for provider form"}
                    </span>
                  </div>
                  <p>
                    {paymentSession.session.sep24Transaction.status?.message ||
                      "Complete the provider form first. Kletia will not prepare or send USDC until the provider explicitly reports that it is ready to receive the exact payment."}
                  </p>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={paymentStep !== null}
                    onClick={() => void refreshWithdrawal()}
                  >
                    {paymentStep === "status" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    {paymentStep === "status"
                      ? "Checking provider"
                      : "Check provider now"}
                  </button>
                </div>
              ) : null}

              {paymentSession.session.state === "awaiting_user_transfer" &&
              paymentSession.session.sep24Transaction?.status
                ?.transferInstruction &&
              !paymentSession.session.submittedTransfer ? (
                <div className="grid gap-2 border-[3px] border-[#1A1A1A] bg-[#FFF36D] p-3 text-xs font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#5B4B12] dark:text-white">
                  <strong className="font-black uppercase">Ready for passkey approval</strong>
                  <p>
                    Send exactly {paymentSession.session.sep24Transaction.status.transferInstruction.amount} USDC to the reviewed provider account. The ID memo is encoded in the muxed Stellar destination when required.
                  </p>
                  <button
                    type="button"
                    className={positiveButtonClass}
                    disabled={!passkeySession || paymentStep !== null}
                    onClick={() => void sendWithdrawal()}
                  >
                    {paymentStep === "transfer" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Fingerprint className="h-4 w-4" />
                    )}
                    {paymentStep === "transfer"
                      ? "Verifying passkey transfer"
                      : "Approve exact USDC payout"}
                  </button>
                </div>
              ) : null}

              {paymentSession.session.sep24Transaction?.status
                ?.transferBlockedReason ? (
                <div className="border-2 border-[#1A1A1A] bg-[#FFD9D6] p-3 text-[10px] font-bold dark:border-[#4B5563] dark:bg-[#4A2025]">
                  <strong className="block font-black uppercase">Payment not prepared</strong>
                  {paymentSession.session.sep24Transaction.status.transferBlockedReason}
                </div>
              ) : null}

              {paymentSession.session.submittedTransfer ? (
                <div className="border-2 border-[#1A1A1A] bg-[#B9F6D2] p-3 text-[10px] font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#174C35] dark:text-white">
                  <strong className="block font-black uppercase">
                    {paymentSession.session.submittedTransfer.chainVerifiedAt
                      ? "USDC transfer verified on Stellar"
                      : "Transfer submitted — recovery mode"}
                  </strong>
                  Kletia will track this existing transaction and the provider payout. It will not ask you to send the USDC again.
                </div>
              ) : null}

              {paymentSession.session.state === "firm_quote_indeterminate" ||
              paymentSession.session.state === "sep24_session_indeterminate" ? (
                <div className="border-2 border-[#1A1A1A] bg-[#FFF36D] p-3 text-[10px] font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#5B4B12] dark:text-white">
                  <strong className="block font-black uppercase">Provider result needs review</strong>
                  Kletia will not repeat this provider request because it may already have created a quote or withdrawal. Start a fresh session only after checking the provider.
                </div>
              ) : null}
            </div>
          ) : null}
        </article>
      ))}

      {providerNotes.length > 0 ? (
        <details className="border-t-2 border-[#1A1A1A] pt-2 text-[10px] font-bold dark:border-[#4B5563]">
          <summary className="cursor-pointer font-black uppercase">Unavailable reviewed providers</summary>
          <ul className="mt-2 grid gap-1">
            {providerNotes.map((note) => <li key={note.provider}>{note.provider}: {note.reason}</li>)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
