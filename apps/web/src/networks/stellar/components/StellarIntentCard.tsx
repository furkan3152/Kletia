import React from "react";
import {
  getNetworkDetails,
  requestAccess,
  signTransaction,
} from "@stellar/freighter-api";
import { Networks, StrKey } from "@stellar/stellar-sdk";
import { formatUnits, parseUnits } from "viem";
import {
  AlertTriangle,
  ArrowLeftRight,
  Banknote,
  CheckCircle2,
  ExternalLink,
  Fingerprint,
  Loader2,
  RefreshCw,
  Route,
  Send,
  ShieldCheck,
  Wallet,
} from "lucide-react";

import { BACKEND_URL } from "../../../shared/config/runtime";
import {
  intentActionButtonClass,
  intentActionInputClass,
  intentActionSectionClass,
  intentPositiveButtonClass,
  intentPrimaryButtonClass,
} from "../../../shared/components/chat/intentActionStyles";
import {
  prepareStellarPayment,
  prepareStellarSdexPathPayment,
  prepareStellarUsdcTrustline,
  submitSignedStellarClassicTransaction,
  validateStellarPathQuote,
  type StellarPathQuote,
} from "../runtime/classic";
import type { StellarWorkspaceIntentResolution } from "../runtime/intentWorkspace";
import { PasskeyAccountCard } from "./PasskeyAccountCard";
import { StellarPayoutIntentCard } from "./StellarPayoutIntentCard";

const FREIGHTER_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/freighter/bcacfldlkkdogcmkkibnjlakofdplcbk";

type Portfolio = {
  account: string;
  assets: Array<{
    asset: { symbol: string };
    balance: string;
    authorized: boolean;
  }>;
  observedAt: string;
};

type BusyAction =
  | "connect"
  | "interpret"
  | "portfolio"
  | "quote"
  | "swap"
  | "transfer"
  | "trustline";

type QuoteState = "idle" | "loading" | "ready" | "unavailable" | "error";

const panelClass = intentActionSectionClass;
const buttonClass = intentActionButtonClass;
const primaryButtonClass = intentPrimaryButtonClass;
const positiveButtonClass = intentPositiveButtonClass;
const inputClass = intentActionInputClass;

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The Stellar action could not be completed.";
}

function validStellarAmount(value: string): boolean {
  return /^\d+(?:\.\d{1,7})?$/u.test(value.trim()) && Number(value) > 0;
}

function exceedsStellarCap(value: string, cap: string | undefined): boolean {
  if (!cap) return false;
  try {
    return parseUnits(value, 7) > parseUnits(cap, 7);
  } catch {
    return true;
  }
}

const STAGE_LABELS: Readonly<Record<string, string>> = {
  read_balance: "Check live balance",
  create_trustline: "Enable the asset",
  payment: "Send payment",
  swap: "Swap at the best reviewed route",
  bridge: "Move funds to the next network",
  supply: "Supply to the selected market",
  borrow_capacity: "Show safe borrow capacity",
  private_payment: "Prepare protected payment",
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The Stellar service returned an invalid response.");
  }
  const record = body as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(
      typeof record.message === "string"
        ? record.message
        : "The Stellar service is temporarily unavailable.",
    ) as Error & { code?: string; status?: number };
    error.code = typeof record.code === "string" ? record.code : undefined;
    error.status = response.status;
    throw error;
  }
  return record;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 8_000): Promise<T> {
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(
          () => reject(new Error("Freighter did not answer before the request expired.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

async function connectFreighterTestnet(): Promise<string> {
  const access = await withTimeout(requestAccess());
  if (access.error || !StrKey.isValidEd25519PublicKey(access.address)) {
    throw new Error(
      access.error?.message ||
        `Freighter is not available for ${window.location.origin}. Enable its site access, unlock it, and retry.`,
    );
  }
  const network = await withTimeout(getNetworkDetails());
  if (network.error || network.networkPassphrase !== Networks.TESTNET) {
    throw new Error("Switch Freighter to Stellar Testnet before continuing.");
  }
  return access.address;
}

async function signAndSubmit(unsignedXdr: string, address: string): Promise<string> {
  const network = await withTimeout(getNetworkDetails());
  if (network.error || network.networkPassphrase !== Networks.TESTNET) {
    throw new Error("Switch Freighter to Stellar Testnet before signing.");
  }
  const signed = await withTimeout(
    signTransaction(unsignedXdr, {
      networkPassphrase: Networks.TESTNET,
      address,
    }),
  );
  if (signed.error || !signed.signedTxXdr || signed.signerAddress !== address) {
    throw new Error(signed.error?.message || "Freighter rejected the Stellar transaction.");
  }
  return submitSignedStellarClassicTransaction(signed.signedTxXdr, unsignedXdr);
}

export function StellarIntentCard({
  resolution: initialResolution,
  evmAddress,
  stellarAddress,
  onStellarAddressChange,
  onOpenWorkspace,
  onResolutionChange,
}: {
  resolution: StellarWorkspaceIntentResolution;
  evmAddress?: `0x${string}`;
  stellarAddress: string;
  onStellarAddressChange: (address: string) => void;
  onOpenWorkspace: (intent: StellarWorkspaceIntentResolution) => void;
  onResolutionChange?: (intent: StellarWorkspaceIntentResolution) => void;
}) {
  const [resolution, setResolution] = React.useState(initialResolution);
  const [portfolio, setPortfolio] = React.useState<Portfolio | null>(null);
  const [busy, setBusy] = React.useState<BusyAction | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [txHash, setTxHash] = React.useState<string | null>(null);
  const [showPasskey, setShowPasskey] = React.useState(false);
  const [transferSigner, setTransferSigner] = React.useState<"passkey" | "freighter">("passkey");
  const [swapSource, setSwapSource] = React.useState<"XLM" | "USDC">(
    resolution.assetIn === "USDC" ? "USDC" : "XLM",
  );
  const [swapMode, setSwapMode] = React.useState<"strict_send" | "strict_receive">(
    resolution.strictReceive ? "strict_receive" : "strict_send",
  );
  const [swapAmount, setSwapAmount] = React.useState(resolution.amount || "");
  const [quote, setQuote] = React.useState<StellarPathQuote | null>(null);
  const [quoteState, setQuoteState] = React.useState<QuoteState>("idle");
  const [quoteMessage, setQuoteMessage] = React.useState<string | null>(null);
  const [transferSymbol, setTransferSymbol] = React.useState<"XLM" | "USDC">(
    resolution.assetIn === "XLM" ? "XLM" : "USDC",
  );
  const [transferAmount, setTransferAmount] = React.useState(resolution.amount || "");
  const [recipient, setRecipient] = React.useState(resolution.recipient || "");
  const validSwapAmount = validStellarAmount(swapAmount);
  const validTransferAmount = validStellarAmount(transferAmount);
  const validRecipient = StrKey.isValidEd25519PublicKey(recipient.trim());
  const quoteExceedsMaximum = Boolean(
    quote && exceedsStellarCap(quote.selectedRoute.sourceAmount, resolution.maximumSend),
  );

  const hasUsdcTrustline = Boolean(
    portfolio?.assets.some(
      (entry) => entry.asset.symbol === "USDC" && entry.authorized,
    ),
  );

  const run = async (action: BusyAction, operation: () => Promise<void>) => {
    setBusy(action);
    setError(null);
    setNotice(null);
    setTxHash(null);
    try {
      await operation();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  };

  const loadPortfolio = React.useCallback(async (address: string) => {
    const body = await readJson(
      await fetch(
        `${BACKEND_URL}/api/stellar/portfolio/${encodeURIComponent(address)}`,
        { headers: { "X-Kletia-Chain-Ref": "stellar:testnet" } },
      ),
    );
    setPortfolio((body.portfolio as Portfolio | undefined) || null);
  }, []);

  React.useEffect(() => {
    if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const body = await readJson(
          await fetch(
            `${BACKEND_URL}/api/stellar/portfolio/${encodeURIComponent(stellarAddress)}`,
            { headers: { "X-Kletia-Chain-Ref": "stellar:testnet" } },
          ),
        );
        if (!cancelled) {
          setPortfolio((body.portfolio as Portfolio | undefined) || null);
        }
      } catch {
        if (!cancelled) setPortfolio(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stellarAddress]);

  const connect = () =>
    run("connect", async () => {
      const nextAddress = await connectFreighterTestnet();
      onStellarAddressChange(nextAddress);
      await loadPortfolio(nextAddress);
      setNotice("Stellar wallet connected.");
    });

  const interpretWithSmartParser = () =>
    run("interpret", async () => {
      const body = await readJson(
        await fetch(`${BACKEND_URL}/api/stellar/intent/interpret`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Kletia-Chain-Ref": "stellar:testnet",
          },
          body: JSON.stringify({
            prompt: resolution.sourcePrompt,
            semanticConsent: true,
          }),
        }),
      );
      const candidate = body.intent;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Smart parser returned an invalid intent.");
      }
      const next = candidate as Partial<StellarWorkspaceIntentResolution>;
      if (
        ![
          "portfolio",
          "transfer",
          "swap",
          "trustline",
          "payout",
          "private_payment",
          "cross_chain",
          "unknown",
        ].includes(String(next.kind)) ||
        typeof next.title !== "string" ||
        typeof next.summary !== "string" ||
        typeof next.nextStep !== "string" ||
        typeof next.strictReceive !== "boolean" ||
        typeof next.readyToPrepare !== "boolean"
      ) {
        throw new Error("Smart parser response failed its browser boundary.");
      }
      const interpreted = {
        ...next,
        sourcePrompt: resolution.sourcePrompt,
        semanticModelUsed: true,
      } as StellarWorkspaceIntentResolution;
      sessionStorage.setItem("kletia-stellar-smart-parser-consent", "true");
      setResolution(interpreted);
      onResolutionChange?.(interpreted);
      setNotice("Goal understood. Review the action before signing anything.");
    });

  const refreshPortfolio = () => {
    if (!stellarAddress) return connect();
    return run("portfolio", async () => {
      await loadPortfolio(stellarAddress);
      setNotice("Live Stellar balances refreshed.");
    });
  };

  const requestQuote = () => {
    setQuoteState("loading");
    setQuoteMessage(null);
    setQuote(null);
    return run("quote", async () => {
      try {
        const body = await readJson(
          await fetch(`${BACKEND_URL}/api/stellar/quote`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Kletia-Chain-Ref": "stellar:testnet",
            },
            body: JSON.stringify({
              mode: swapMode,
              assetIn: swapSource,
              assetOut: swapSource === "XLM" ? "USDC" : "XLM",
              amount: swapAmount,
            }),
          }),
        );
        const nextQuote = validateStellarPathQuote(body.quote);
        setQuote(nextQuote);
        setQuoteState("ready");
        setQuoteMessage("Fresh route ready to review.");
      } catch (caught) {
        const candidate = caught as Error & { code?: string };
        if (candidate.code === "STELLAR_ROUTE_UNAVAILABLE") {
          setQuoteState("unavailable");
          setQuoteMessage(candidate.message);
          return;
        }
        setQuoteState("error");
        setQuoteMessage(messageOf(caught));
      }
    });
  };

  const executeSwap = () =>
    run("swap", async () => {
      if (!quote) throw new Error("Compare routes before signing the swap.");
      if (!stellarAddress) throw new Error("Connect your Stellar wallet before signing.");
      const unsignedXdr = await prepareStellarSdexPathPayment({
        sourceAccount: stellarAddress,
        quote,
      });
      const hash = await signAndSubmit(unsignedXdr, stellarAddress);
      setTxHash(hash);
      setQuote(null);
      setQuoteState("idle");
      await loadPortfolio(stellarAddress);
      setNotice("Swap confirmed on Stellar Testnet.");
    });

  const executeTransfer = () =>
    run("transfer", async () => {
      if (!stellarAddress) throw new Error("Connect your Stellar wallet before signing.");
      const unsignedXdr = await prepareStellarPayment({
        sourceAccount: stellarAddress,
        destination: recipient.trim(),
        symbol: transferSymbol,
        amount: transferAmount,
      });
      const hash = await signAndSubmit(unsignedXdr, stellarAddress);
      setTxHash(hash);
      await loadPortfolio(stellarAddress);
      setNotice("The payment was confirmed on Stellar Testnet.");
    });

  const createTrustline = () =>
    run("trustline", async () => {
      if (!stellarAddress) throw new Error("Connect Freighter before signing the trustline.");
      const unsignedXdr = await prepareStellarUsdcTrustline({
        sourceAccount: stellarAddress,
      });
      const hash = await signAndSubmit(unsignedXdr, stellarAddress);
      setTxHash(hash);
      await loadPortfolio(stellarAddress);
      setNotice("The reviewed Circle Testnet USDC trustline was confirmed.");
    });

  const updateQuoteInput = (update: () => void) => {
    update();
    setQuote(null);
    setQuoteState("idle");
    setQuoteMessage(null);
  };

  return (
    <section className={`${panelClass} stellar-intent-theme`} aria-label="Stellar intent action">
      <header className="flex items-start justify-between gap-3 border-b-[3px] border-[#1A1A1A] pb-3 dark:border-[#4B5563]">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#0052FF] text-white shadow-[2px_2px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[2px_2px_0_#475569]">
            {resolution.kind === "swap" ? (
              <ArrowLeftRight className="h-5 w-5" />
            ) : resolution.kind === "payout" ? (
              <Banknote className="h-5 w-5" />
            ) : resolution.kind === "cross_chain" ? (
              <Route className="h-5 w-5" />
            ) : (
              <Fingerprint className="h-5 w-5" />
            )}
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#0052FF] dark:text-[#60A5FA]">
              {resolution.kind === "cross_chain" ? "Testnet workflow" : "Stellar Testnet"}
            </p>
            <h3 className="mt-1 text-sm font-black sm:text-base">{resolution.title}</h3>
            <p className="mt-1 text-xs font-bold leading-relaxed text-[#4B4657] dark:text-slate-300">
              {resolution.summary}
            </p>
          </div>
        </div>
        <span className="shrink-0 border-2 border-[#1A1A1A] bg-[#F3F4F6] px-2 py-1 text-[9px] font-black uppercase dark:border-[#4B5563] dark:bg-[#1A2841]">
          {resolution.kind === "cross_chain"
            ? resolution.scenarioId
              ? "Review"
              : "Unsupported"
            : resolution.readyToPrepare
              ? "Ready"
              : "Add details"}
        </span>
      </header>

      {error ? (
        <div className="mt-3 border-[3px] border-[#1A1A1A] bg-[#FFD9D6] p-3 text-xs font-bold dark:border-[#4B5563] dark:bg-[#4A2025]" role="alert">
          <strong className="block font-black uppercase">Couldn&apos;t continue</strong>
          <span>{error}</span>
          {error.includes("Freighter") ? (
            <a className="mt-2 inline-flex items-center gap-1 underline" href={FREIGHTER_EXTENSION_URL} target="_blank" rel="noreferrer">
              Open official Freighter <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <div className="mt-3 flex items-start gap-2 border-[3px] border-[#1A1A1A] bg-[#B9F6D2] p-3 text-xs font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#174C35] dark:text-white" role="status">
          <CheckCircle2 className="h-4 w-4 shrink-0" /> {notice}
        </div>
      ) : null}
      {txHash ? (
        <details className="mt-2 text-[10px] font-bold">
          <summary className="cursor-pointer font-black uppercase">Transaction details</summary>
          <code className="mt-2 block break-all">{txHash}</code>
        </details>
      ) : null}

      {resolution.kind === "unknown" || !resolution.readyToPrepare ? (
        <div className="mt-3 grid gap-3 border-[3px] border-[#1A1A1A] bg-[#FFF36D] p-3 text-xs font-bold dark:border-[#4B5563] dark:bg-[#5B4B12]">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <div>
            <strong className="block font-black uppercase">One detail needed</strong>
            <span>{resolution.blockingReason || resolution.nextStep}</span>
            </div>
          </div>
          {resolution.kind === "unknown" && !resolution.semanticModelUsed ? (
            <button type="button" className={primaryButtonClass} disabled={busy !== null} onClick={() => void interpretWithSmartParser()}>
              {busy === "interpret" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
              {busy === "interpret" ? "Understanding goal" : "Use smart parser"}
            </button>
          ) : null}
        </div>
      ) : null}

      {resolution.kind === "payout" ? (
        <div className="mt-3">
          <StellarPayoutIntentCard resolution={resolution} evmAddress={evmAddress} />
        </div>
      ) : null}

      {resolution.kind === "swap" ? (
        <div className="mt-3 grid gap-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              className={buttonClass}
              disabled={Boolean(resolution.maximumSend)}
              onClick={() => updateQuoteInput(() => setSwapSource((value) => value === "XLM" ? "USDC" : "XLM"))}
            >
              <ArrowLeftRight className="h-4 w-4" /> {swapSource} → {swapSource === "XLM" ? "USDC" : "XLM"}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={Boolean(resolution.maximumSend)}
              onClick={() => updateQuoteInput(() => setSwapMode((value) => value === "strict_send" ? "strict_receive" : "strict_send"))}
            >
              {swapMode === "strict_send" ? "Exact send" : "Exact receive"}
            </button>
          </div>
          <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider">
            {swapMode === "strict_send" ? "Send amount" : "Receive amount"}
            <input
              className={inputClass}
              value={swapAmount}
              inputMode="decimal"
              autoComplete="off"
              onChange={(event) => updateQuoteInput(() => setSwapAmount(event.target.value))}
            />
          </label>
          {resolution.maximumSend ? (
            <div className="border-[3px] border-[#1A1A1A] bg-[#FFF36D] p-3 text-xs font-black text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#5B4B12] dark:text-white">
              Hard limit: spend no more than {resolution.maximumSend} {resolution.assetIn}.
            </div>
          ) : null}
          <button type="button" className={primaryButtonClass} disabled={busy !== null || !validSwapAmount} onClick={() => void requestQuote()}>
            {busy === "quote" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Route className="h-4 w-4" />}
            {busy === "quote" ? "Comparing routes" : "Compare routes"}
          </button>

          {quoteState === "idle" ? (
            <div className="border-[3px] border-dashed border-[#746F7E] p-3 text-xs font-bold dark:border-[#4B5563]">
              Enter the amount, compare the live route, then connect your wallet only when you are ready to sign.
            </div>
          ) : null}
          {quoteState === "unavailable" || quoteState === "error" ? (
            <div className={`border-[3px] border-[#1A1A1A] p-3 text-xs font-bold dark:border-[#4B5563] ${quoteState === "unavailable" ? "bg-[#FFF36D] text-[#1A1A1A] dark:bg-[#5B4B12] dark:text-white" : "bg-[#FFD9D6] dark:bg-[#4A2025]"}`}>
              <strong className="block font-black uppercase">
                {quoteState === "unavailable" ? "No route right now" : "Route service unavailable"}
              </strong>
              {quoteMessage}
            </div>
          ) : null}
          {quote ? (
            <div className="grid gap-3 border-[3px] border-[#1A1A1A] bg-white p-3 dark:border-[#4B5563] dark:bg-[#0F172A]">
              <div className="grid grid-cols-2 gap-2">
                <div className="border-2 border-[#1A1A1A] bg-[#F3F4F6] p-2 dark:border-[#4B5563] dark:bg-[#1A2841]">
                  <span className="text-[9px] font-black uppercase text-gray-500 dark:text-slate-400">You send</span>
                  <strong className="mt-1 block text-sm font-black">{quote.selectedRoute.sourceAmount} {quote.sourceAsset.symbol}</strong>
                </div>
                <div className="border-2 border-[#1A1A1A] bg-[#B9F6D2] p-2 text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#174C35] dark:text-white">
                  <span className="text-[9px] font-black uppercase opacity-70">You receive</span>
                  <strong className="mt-1 block text-sm font-black">{quote.selectedRoute.destinationAmount} {quote.destinationAsset.symbol}</strong>
                </div>
              </div>
              <details className="border-t-2 border-[#1A1A1A] pt-2 text-[10px] font-bold dark:border-[#4B5563]">
                <summary className="cursor-pointer font-black uppercase">Route details</summary>
                <p className="mt-2">Executable venue: Stellar DEX · slippage limit 0.5% · quote expires {new Date(quote.quoteExpiresAt).toLocaleTimeString()}</p>
                <p className="mt-1 text-[#8A4B08] dark:text-[#FFD36D]">
                  {quote.executionPolicy.warning}
                </p>
                <p className="mt-1">
                  Aquarius comparison: {quote.aquarius?.quotedAmountAtomic
                    ? formatUnits(BigInt(quote.aquarius.quotedAmountAtomic), 7)
                    : "not available"}. Comparison data is never used as executable calldata.
                </p>
              </details>
              {quoteExceedsMaximum ? (
                <div className="border-[3px] border-[#1A1A1A] bg-[#FFD9D6] p-3 text-xs font-black dark:border-[#4B5563] dark:bg-[#4A2025]">
                  This route exceeds your maximum send limit and cannot be signed.
                </div>
              ) : null}
              {swapSource === "XLM" && stellarAddress && !hasUsdcTrustline ? (
                <div className="bg-[#FFF36D] p-2 text-xs font-bold text-[#1A1A1A]">
                  Add the reviewed USDC trustline before receiving USDC.
                </div>
              ) : null}
              {!stellarAddress ? (
                <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void connect()}>
                  <Wallet className="h-4 w-4" /> Connect Stellar wallet
                </button>
              ) : null}
              <button
                type="button"
                className={positiveButtonClass}
                disabled={busy !== null || !stellarAddress || quoteExceedsMaximum || (swapSource === "XLM" && !hasUsdcTrustline)}
                onClick={() => void executeSwap()}
              >
                {busy === "swap" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
                Review and sign swap
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {resolution.kind === "transfer" ? (
        <div className="mt-3 grid gap-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Stellar payment signer">
            <button type="button" className={transferSigner === "passkey" ? primaryButtonClass : buttonClass} onClick={() => setTransferSigner("passkey")}>
              <Fingerprint className="h-4 w-4" /> Passkey account
            </button>
            <button type="button" className={transferSigner === "freighter" ? primaryButtonClass : buttonClass} onClick={() => setTransferSigner("freighter")}>
              <Wallet className="h-4 w-4" /> Classic account
            </button>
          </div>
          {transferSigner === "passkey" ? (
            <PasskeyAccountCard
              evmAddress={evmAddress}
              initialRecipient={recipient}
              initialAmount={transferAmount || "1"}
              initialSymbol={transferSymbol}
            />
          ) : (
            <>
              <p className="text-xs font-bold">
                Use Freighter only for an existing Classic G-account. The passkey account above is the seedless default.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {(["XLM", "USDC"] as const).map((symbol) => (
                  <button key={symbol} type="button" className={transferSymbol === symbol ? primaryButtonClass : buttonClass} onClick={() => setTransferSymbol(symbol)}>
                    {symbol}
                  </button>
                ))}
              </div>
              <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider">
                Amount
                <input className={inputClass} value={transferAmount} inputMode="decimal" autoComplete="off" onChange={(event) => setTransferAmount(event.target.value)} />
              </label>
              <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider">
                Destination G-address
                <input className={inputClass} value={recipient} placeholder="G…" spellCheck={false} autoComplete="off" onChange={(event) => setRecipient(event.target.value.trim())} />
              </label>
              {!stellarAddress ? (
                <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void connect()}>
                  <Wallet className="h-4 w-4" /> Connect Freighter
                </button>
              ) : null}
              <button type="button" className={positiveButtonClass} disabled={busy !== null || !stellarAddress || !validTransferAmount || !validRecipient} onClick={() => void executeTransfer()}>
                {busy === "transfer" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Review and sign payment
              </button>
            </>
          )}
        </div>
      ) : null}

      {resolution.kind === "portfolio" ? (
        <div className="mt-3 grid gap-3">
          {portfolio ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {portfolio.assets.map((entry) => (
                <div key={entry.asset.symbol} className="border-[3px] border-[#1A1A1A] bg-white p-3 dark:border-[#4B5563] dark:bg-[#0F172A]">
                  <span className="text-[10px] font-black uppercase text-gray-500 dark:text-slate-400">{entry.asset.symbol}</span>
                  <strong className="mt-1 block break-all text-base font-black">{entry.balance}</strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs font-bold">Connect a Classic account to read XLM and reviewed USDC directly from Horizon.</p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" className={primaryButtonClass} disabled={busy !== null} onClick={() => void refreshPortfolio()}>
              {busy === "connect" || busy === "portfolio" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {stellarAddress ? "Refresh balances" : "Connect Stellar wallet"}
            </button>
            <button type="button" className={buttonClass} onClick={() => setShowPasskey((value) => !value)}>
              <Fingerprint className="h-4 w-4" /> {showPasskey ? "Hide passkey account" : "Use seedless passkey account"}
            </button>
          </div>
          {showPasskey ? <PasskeyAccountCard evmAddress={evmAddress} /> : null}
        </div>
      ) : null}

      {resolution.kind === "trustline" ? (
        <div className="mt-3 grid gap-3">
          <p className="text-xs font-bold">
            This signs only the exact Circle Testnet USDC trustline. It does not approve spending.
          </p>
          {!stellarAddress ? (
            <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void connect()}>
              <Wallet className="h-4 w-4" /> Connect Freighter
            </button>
          ) : null}
          {hasUsdcTrustline ? (
            <div className="flex items-center gap-2 bg-[#B9F6D2] p-3 text-xs font-black text-[#1A1A1A]">
              <CheckCircle2 className="h-4 w-4" /> Reviewed USDC is already enabled.
            </div>
          ) : (
            <button type="button" className={positiveButtonClass} disabled={busy !== null || !stellarAddress} onClick={() => void createTrustline()}>
              {busy === "trustline" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Review and sign trustline
            </button>
          )}
        </div>
      ) : null}

      {resolution.kind === "private_payment" ? (
        <div className="mt-3 grid gap-3">
          <p className="text-xs font-bold leading-relaxed">{resolution.nextStep}</p>
          {resolution.stages && resolution.stages.length > 0 ? (
            <ol className="grid gap-2">
              {resolution.stages.map((stage, index) => (
                <li key={`${stage.action}:${stage.network}:${index}`} className="flex items-center gap-2 border-2 border-[#1A1A1A] bg-white p-2 text-xs font-black dark:border-[#4B5563] dark:bg-[#0F172A]">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center bg-[#0052FF] text-white">{index + 1}</span>
                  <span>{STAGE_LABELS[stage.action] || "Review next step"}</span>
                </li>
              ))}
            </ol>
          ) : null}
          <details className="border-t-2 border-[#1A1A1A] pt-2 text-xs dark:border-[#4B5563]">
            <summary className="cursor-pointer font-black">Advanced execution and recovery</summary>
            <button type="button" className={`${primaryButtonClass} mt-2 w-full`} onClick={() => onOpenWorkspace(resolution)}>
              <ShieldCheck className="h-4 w-4" />
              Open protected payment tools
            </button>
          </details>
        </div>
      ) : null}

      {stellarAddress ? (
        <details className="mt-3 border-t-2 border-[#1A1A1A] pt-2 text-[9px] font-bold dark:border-[#4B5563]">
          <summary className="cursor-pointer font-black uppercase">Connected account</summary>
          <p className="mt-1 break-all">{stellarAddress}</p>
        </details>
      ) : null}
    </section>
  );
}
