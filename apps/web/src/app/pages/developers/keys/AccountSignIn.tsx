/**
 * Wallet sign-in of the developer portal: pick a browser wallet (EVM through
 * EIP-6963, Solana through the Wallet Standard events; see
 * injectedWallets.ts), read the exact message, sign it. The API builds and
 * verifies the message; the portal refuses to ask for a signature over text
 * that names another site, address, chain, purpose or a past expiry.
 * Signing in moves no funds and approves no transaction.
 */
import { KeyRound, PenLine, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../../site/ui/Button";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { walletErrorText } from "../../admin/model/session";
import { base58Encode } from "../../admin/model/signIn";
import { accountApi, isPlatformError } from "./accountClient";
import { accountChainId, accountErrorText, accountMessageProblems } from "./accountModel";
import { setAccountSession } from "./accountSessionStore";
import { connectWallet, discoverEvmWallets, discoverSolanaWallets, signWithWallet, type ConnectedWallet, type WalletOption } from "./injectedWallets";

/** Wall-clock time, read when a message arrives (never during render). */
const currentTime = () => Date.now();

interface Prepared {
  readonly option: WalletOption;
  readonly connected: ConnectedWallet;
  readonly message: string;
  readonly problems: readonly string[];
}

export interface AccountSignInProps {
  readonly onCancel: () => void;
}

export default function AccountSignIn({ onCancel }: AccountSignInProps) {
  const [wallets, setWallets] = useState<readonly WalletOption[] | null>(null);
  const [scan, setScan] = useState(0);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void discoverEvmWallets().then((evm) => {
      if (live) setWallets([...evm, ...discoverSolanaWallets()]);
    });
    return () => {
      live = false;
    };
  }, [scan]);

  const prepare = async (option: WalletOption) => {
    setBusy(option.id);
    setError(null);
    setPrepared(null);
    try {
      const connected = await connectWallet(option);
      const chainId = accountChainId(connected.chainId);
      const nonce = await accountApi.nonce(option.kind === "evm" ? { walletKind: "evm", address: connected.address, chainId } : { walletKind: "solana", address: connected.address });
      const problems = accountMessageProblems(nonce.message, {
        kind: option.kind,
        host: window.location.host,
        origin: window.location.origin,
        address: connected.address,
        ...(option.kind === "evm" ? { chainId } : {}),
        now: currentTime(),
      });
      setPrepared({ option, connected, message: nonce.message, problems });
    } catch (failure) {
      setError(isPlatformError(failure) ? accountErrorText(failure.code, failure.message) : walletErrorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const sign = async () => {
    if (!prepared || prepared.problems.length > 0) return;
    setBusy("sign");
    setError(null);
    try {
      const signature = await signWithWallet(prepared.option, prepared.connected, prepared.message, base58Encode);
      const signedIn = await accountApi.signIn(prepared.message, signature);
      setAccountSession({ token: signedIn.token, walletKind: signedIn.session.walletKind, address: signedIn.session.address, expiresAt: signedIn.session.expiresAt });
    } catch (failure) {
      // A failed attempt uses the message up: start again from a fresh one.
      setPrepared(null);
      setError(isPlatformError(failure) ? accountErrorText(failure.code, failure.message) : walletErrorText(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className={cx("flex min-w-0 flex-col gap-3 p-4", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-lg font-bold">Choose a wallet</h3>
          <Button size="sm" variant="ghost" onClick={() => setScan((value) => value + 1)} aria-label="Look for wallets again">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Look again
          </Button>
        </div>
        <p className={cx("text-sm", TEXT_MUTED)}>
          EVM wallets sign an EIP-4361 (Sign-In with Ethereum) message; smart-contract wallets work too. Solana wallets sign the same fields as plain text.
        </p>
        {wallets === null ? <p className={cx("text-sm", TEXT_MUTED)}>Looking for browser wallets…</p> : null}
        {wallets !== null && wallets.length === 0 ? (
          <p className="text-sm">No browser wallet found. Install or unlock an EVM or Solana wallet extension, then look again.</p>
        ) : null}
        {wallets !== null && wallets.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {wallets.map((option) => (
              <li key={`${option.kind}:${option.id}`}>
                <Button size="sm" variant="secondary" onClick={() => void prepare(option)} loading={busy === option.id} disabled={busy !== null}>
                  <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                  {option.name}
                  <span className={cx(LABEL, "ml-1 border-2 border-current px-1")}>{option.kind === "evm" ? "EVM" : "Solana"}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="border-l-[4px] border-[#B91C1C] bg-danger-bg px-3 py-2 text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      {prepared ? (
        <section aria-labelledby="account-signin-message" className="flex flex-col gap-3">
          <h3 id="account-signin-message" className="font-display text-lg font-bold">
            The message you will sign
          </h3>
          <pre className={cx("max-h-72 overflow-auto whitespace-pre-wrap break-all p-3 font-code text-[12px]", INK_BORDER, SURFACE)}>{prepared.message}</pre>
          <p className={cx("text-xs", TEXT_MUTED)}>Valid for 5 minutes, once. Signing it moves no funds and approves no transaction.</p>
          {prepared.problems.length > 0 ? (
            <ul role="alert" className="flex flex-col gap-1.5">
              {prepared.problems.map((problem) => (
                <li key={problem} className="border-l-[4px] border-[#B91C1C] bg-danger-bg px-3 py-2 text-sm font-semibold text-danger">
                  {problem} The portal will not ask your wallet to sign it.
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="accent" onClick={() => void sign()} loading={busy === "sign"} disabled={prepared.problems.length > 0 || busy !== null}>
              <PenLine className="h-4 w-4" aria-hidden="true" />
              Sign in your wallet
            </Button>
            <Button variant="secondary" onClick={() => setPrepared(null)} disabled={busy === "sign"}>
              Cancel
            </Button>
          </div>
        </section>
      ) : (
        <div>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Not now
          </Button>
        </div>
      )}
    </div>
  );
}
