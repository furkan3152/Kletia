import React from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  Fingerprint,
  KeyRound,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Wallet,
} from "lucide-react";

import {
  connectStellarPasskeyAccount,
  createStellarPasskeyAccount,
  disconnectStellarPasskeyAccount,
  fundStellarPasskeyAccount,
  readStellarPasskeyBrowserSupport,
  readStellarPasskeyReadiness,
  refreshStellarPasskeyAccount,
  restoreStellarPasskeyAccount,
  transferAssetFromStellarPasskeyAccount,
  type StellarPasskeyReadiness,
  type StellarPasskeySession,
} from "../runtime/passkeyAccount";
import "./PasskeyAccountCard.css";

type BusyAction = "loading" | "create" | "connect" | "fund" | "refresh" | "send" | "disconnect";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The passkey-account action could not be completed.";

const shorten = (value: string): string =>
  value.length > 20 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;

export function PasskeyAccountCard({
  evmAddress,
  onSessionChange,
  showTransferTools = true,
  initialRecipient = "",
  initialAmount = "1",
  initialSymbol = "XLM",
}: {
  evmAddress?: `0x${string}`;
  onSessionChange?: (session: StellarPasskeySession | null) => void;
  showTransferTools?: boolean;
  initialRecipient?: string;
  initialAmount?: string;
  initialSymbol?: "XLM" | "USDC";
}) {
  const browserSupport = React.useMemo(() => readStellarPasskeyBrowserSupport(), []);
  const [readiness, setReadiness] = React.useState<StellarPasskeyReadiness | null>(null);
  const [session, setSession] = React.useState<StellarPasskeySession | null>(null);
  const [busyAction, setBusyAction] = React.useState<BusyAction | null>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [transactionHash, setTransactionHash] = React.useState<string | null>(null);
  const [recipient, setRecipient] = React.useState(initialRecipient);
  const [amount, setAmount] = React.useState(initialAmount);
  const [sendSymbol, setSendSymbol] = React.useState<"XLM" | "USDC">(initialSymbol);

  const applySession = React.useCallback((next: StellarPasskeySession | null) => {
    setSession(next);
    onSessionChange?.(next);
  }, [onSessionChange]);

  React.useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      if (!browserSupport.supported) {
        setError(browserSupport.reason);
        setBusyAction(null);
        return;
      }
      try {
        const nextReadiness = await readStellarPasskeyReadiness();
        if (cancelled) return;
        setReadiness(nextReadiness);
        const restored = await restoreStellarPasskeyAccount(nextReadiness);
        if (cancelled) return;
        applySession(restored);
      } catch (caught) {
        if (!cancelled) setError(messageOf(caught));
      } finally {
        if (!cancelled) setBusyAction(null);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
    };
  }, [applySession, browserSupport.reason, browserSupport.supported]);

  const run = async (action: BusyAction, operation: () => Promise<void>) => {
    setBusyAction(action);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusyAction(null);
    }
  };

  const requireReadiness = (): StellarPasskeyReadiness => {
    if (!readiness?.ready) throw new Error(readiness?.reason || "Passkey accounts are unavailable.");
    return readiness;
  };

  const create = () => run("create", async () => {
    const activeReadiness = requireReadiness();
    const label = evmAddress ? `Kletia ${evmAddress.slice(0, 8)}` : "Kletia user";
    const result = await createStellarPasskeyAccount(activeReadiness, label);
    applySession(result.session);
    setTransactionHash(result.transactionHash);
    setNotice("Your passkey and Stellar Testnet smart account are ready.");
  });

  const connect = () => run("connect", async () => {
    const connected = await connectStellarPasskeyAccount(requireReadiness());
    applySession(connected);
    setNotice("Passkey account connected on this device.");
  });

  const refresh = () => run("refresh", async () => {
    if (!session) return;
    applySession(await refreshStellarPasskeyAccount(requireReadiness(), session.contractId));
    setNotice("Live Testnet balance refreshed.");
  });

  const fund = () => run("fund", async () => {
    const result = await fundStellarPasskeyAccount(requireReadiness());
    applySession(result.session);
    setTransactionHash(result.transactionHash);
    setNotice(
      result.amount === null
        ? "Testnet XLM funding confirmed."
        : `${result.amount.toFixed(2)} Testnet XLM funding confirmed.`,
    );
  });

  const send = () => run("send", async () => {
    const parsedAmount = Number(amount);
    const result = await transferAssetFromStellarPasskeyAccount(
      requireReadiness(),
      sendSymbol,
      recipient.trim(),
      parsedAmount,
    );
    applySession(result.session);
    setTransactionHash(result.transactionHash);
    setNotice(`${parsedAmount} ${sendSymbol} sent on Stellar Testnet.`);
  });

  const disconnect = () => run("disconnect", async () => {
    await disconnectStellarPasskeyAccount();
    applySession(null);
    setTransactionHash(null);
    setNotice("Local passkey session disconnected. The onchain account was not deleted.");
  });

  const busy = busyAction !== null;
  const localhostUrl = React.useMemo(() => {
    if (window.location.hostname !== "127.0.0.1") return null;
    const next = new URL(window.location.href);
    next.hostname = "localhost";
    return next.toString();
  }, []);
  return (
    <section className="stellar-passkey-card" aria-labelledby="stellar-passkey-title">
      <header>
        <span className="stellar-passkey-icon" aria-hidden="true"><Fingerprint /></span>
        <div>
          <span className="stellar-passkey-kicker">Stellar payment identity</span>
          <h2 id="stellar-passkey-title">Kletia Passkey Account</h2>
          <p>No extension or seed phrase. Your secp256r1 device passkey controls this Stellar contract account.</p>
        </div>
        <span className="stellar-passkey-network">TESTNET</span>
      </header>

      {busyAction === "loading" ? (
        <div className="stellar-passkey-message" data-tone="info">
          <Loader2 className="animate-spin" aria-hidden="true" />
          Checking the pinned live account and relayer identities…
        </div>
      ) : null}
      {error ? (
        <div className="stellar-passkey-message" data-tone="danger">
          <span>{error}</span>
          {localhostUrl ? <a href={localhostUrl}>Open localhost</a> : null}
        </div>
      ) : null}
      {notice ? (
        <div className="stellar-passkey-message" data-tone="success">
          <CheckCircle2 aria-hidden="true" />{notice}
        </div>
      ) : null}

      {!session && readiness?.ready ? (
        <div className="stellar-passkey-onboarding">
          <div className="stellar-passkey-benefits">
            <span><KeyRound aria-hidden="true" /><strong>1 click</strong><small>Create with Face ID, fingerprint or computer PIN</small></span>
            <span><ShieldCheck aria-hidden="true" /><strong>Self-custody</strong><small>Kletia never receives a private key</small></span>
            <span><Wallet aria-hidden="true" /><strong>Real C-account</strong><small>Deployed and verified on Stellar Testnet</small></span>
          </div>
          <div className="stellar-passkey-actions">
            <button type="button" className="stellar-button stellar-button-primary" disabled={busy} onClick={() => void create()}>
              {busyAction === "create" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Fingerprint aria-hidden="true" />}
              Create Stellar account
            </button>
            <button type="button" className="stellar-button" disabled={busy} onClick={() => void connect()}>
              {busyAction === "connect" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
              Use existing passkey
            </button>
          </div>
          <p className="stellar-passkey-boundary">
            {evmAddress
              ? `EVM wallet ${shorten(evmAddress)} stays connected for Base, Arc and Arbitrum. It identifies this session but cannot spend from the Stellar account.`
              : "An EVM wallet is optional. The passkey remains the Stellar spending authority."}
          </p>
        </div>
      ) : null}

      {session ? (
        <div className="stellar-passkey-session">
          <div className="stellar-passkey-account-row">
            <div>
              <span>Smart account</span>
              <strong>{shorten(session.contractId)}</strong>
              <small>
                {session.balanceXlm === null ? "XLM unavailable" : `${session.balanceXlm} XLM`}
                {" · "}
                {session.balanceUsdc === null ? "USDC unavailable" : `${session.balanceUsdc} USDC`}
              </small>
            </div>
            <a href={`https://stellar.expert/explorer/testnet/contract/${session.contractId}`} target="_blank" rel="noreferrer">
              Explorer <ArrowUpRight aria-hidden="true" />
            </a>
          </div>
          <div className="stellar-passkey-actions">
            <button type="button" className="stellar-button stellar-button-primary" disabled={busy} onClick={() => void fund()}>
              {busyAction === "fund" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Wallet aria-hidden="true" />}
              Get Testnet XLM
            </button>
            <button type="button" className="stellar-button" disabled={busy} onClick={() => void refresh()}>
              {busyAction === "refresh" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              Refresh
            </button>
            <button type="button" className="stellar-button" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
          {showTransferTools ? <form className="stellar-passkey-send" onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <label>
              Send with passkey
              <input aria-label="Passkey payment recipient" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="G... or C... recipient" autoComplete="off" />
            </label>
            <label>
              Asset
              <select aria-label="Passkey payment asset" value={sendSymbol} onChange={(event) => setSendSymbol(event.target.value as "XLM" | "USDC")}>
                <option value="XLM">XLM</option>
                <option value="USDC">Circle Testnet USDC</option>
              </select>
            </label>
            <label>
              Amount
              <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" aria-label={`Passkey ${sendSymbol} amount`} />
            </label>
            <button type="submit" className="stellar-button" disabled={busy || recipient.trim().length === 0}>
              {busyAction === "send" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
              Review with passkey
            </button>
          </form> : null}
          <p className="stellar-passkey-boundary">
            This account can sign XLM and Circle Testnet USDC transfers to G/C addresses. Anchor destinations that require a memo still need the reviewed muxed-address transfer path, so SEP-24 execution remains gated.
          </p>
        </div>
      ) : null}

      {transactionHash ? (
        <a className="stellar-passkey-tx" href={`https://stellar.expert/explorer/testnet/tx/${transactionHash}`} target="_blank" rel="noreferrer">
          Verified Testnet transaction · {shorten(transactionHash)} <ArrowUpRight aria-hidden="true" />
        </a>
      ) : null}
    </section>
  );
}
