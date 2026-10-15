/**
 * Gate states 3-5 (admin design G.2) with both admin wallets: connect the EVM
 * or the Solana admin wallet, read the exact sign-in message on a ticket,
 * then sign it. The API builds and verifies the message; the panel only
 * refuses to ask for a signature over text that names another site, address,
 * chain or a past expiry.
 */
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { KeyRound, LogOut, PenLine } from "lucide-react";
import { useState } from "react";
import { useAccount, useDisconnect } from "wagmi";

import { useSolanaWallet } from "../../../shared/wallet/solana/useSolanaWallet";
import { TicketHead, TicketShell } from "../../site/art/TicketShell";
import { Button } from "../../site/ui/Button";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { AdminApiError, describeAdminError, type AdminClient } from "./api/adminClient";
import type { WalletOps } from "./api/useAdmin";
import { GateCard } from "./components/GateCard";
import { networkForChainId } from "./model/plan";
import { shortAddress, walletErrorText } from "./model/session";
import { parseSignInMessage, signInProblems } from "./model/signIn";
import type { AdminNonceResponse, AdminSessionView, AdminWalletKind } from "./model/types";

/** Wall-clock time, read when a message arrives (never during render). */
const currentTime = () => Date.now();

/** Base is the default chain id of an EVM sign-in when the wallet sits on a chain the panel does not list. */
const DEFAULT_EVM_CHAIN_ID = 8453;

interface Prepared {
  readonly kind: AdminWalletKind;
  readonly address: string;
  readonly nonce: AdminNonceResponse;
  readonly problems: readonly string[];
}

export function SignInView({ client, ops, onSignedIn }: { readonly client: AdminClient; readonly ops: WalletOps; readonly onSignedIn: (session: AdminSessionView) => void }) {
  const evm = useAccount();
  const { disconnect } = useDisconnect();
  const { openConnectModal } = useConnectModal();
  const solana = useSolanaWallet();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState<"prepare" | "sign" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState<{ kind: AdminWalletKind; address: string } | null>(null);

  const evmAddress = evm.address ?? null;
  const solanaAddress = solana.account?.address ?? null;

  const prepare = async (kind: AdminWalletKind) => {
    const address = kind === "evm" ? evmAddress : solanaAddress;
    if (!address) return;
    setBusy("prepare");
    setError(null);
    setPrepared(null);
    try {
      const chainId = networkForChainId(evm.chainId) ? (evm.chainId as number) : DEFAULT_EVM_CHAIN_ID;
      const nonce = await client.nonce(kind === "evm" ? { kind, address, chainId } : { kind, address });
      const problems = signInProblems(parseSignInMessage(nonce.message), {
        kind,
        host: window.location.host,
        address,
        ...(kind === "evm" ? { chainId } : {}),
        now: currentTime(),
      });
      setPrepared({ kind, address, nonce, problems });
    } catch (failure) {
      setError(describeAdminError(failure));
    } finally {
      setBusy(null);
    }
  };

  const sign = async () => {
    if (!prepared || prepared.problems.length > 0) return;
    setBusy("sign");
    setError(null);
    try {
      const signature = await ops.signText(prepared.kind, prepared.nonce.message);
      const session = await client.verify(prepared.nonce.message, signature);
      onSignedIn(session);
    } catch (failure) {
      if (failure instanceof AdminApiError) {
        if (failure.code === "ADMIN_NOT_ALLOWED") {
          setDenied({ kind: prepared.kind, address: prepared.address });
          setPrepared(null);
        } else {
          // A failed attempt burns the nonce: start again from a fresh message.
          setError(`${describeAdminError(failure)} Prepare a new message to try again.`);
          setPrepared(null);
        }
      } else {
        setError(walletErrorText(failure));
      }
    } finally {
      setBusy(null);
    }
  };

  if (denied) {
    return (
      <GateCard
        icon="shield"
        eyebrow="Not an admin"
        title="This wallet is not an admin"
        tone="danger"
        actions={
          <>
            <Button
              variant="ink"
              onClick={() => {
                if (denied.kind === "evm") disconnect();
                else void solana.disconnect();
                setDenied(null);
              }}
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Disconnect
            </Button>
            <Button variant="secondary" onClick={() => setDenied(null)}>
              Use another wallet
            </Button>
          </>
        }
      >
        <p>
          Connected: <code className="font-code text-fg">{shortAddress(denied.address)}</code>. Only wallets listed in{" "}
          <code className="font-code text-fg">{denied.kind === "evm" ? "KLETIA_ADMIN_ADDRESSES" : "KLETIA_ADMIN_SOLANA_ADDRESSES"}</code> on the API can sign in.
        </p>
      </GateCard>
    );
  }

  const walletCard = (kind: AdminWalletKind) => {
    const address = kind === "evm" ? evmAddress : solanaAddress;
    const title = kind === "evm" ? "EVM admin wallet" : "Solana admin wallet";
    const standard = kind === "evm" ? "Sign-In with Ethereum (EIP-4361). Smart-contract wallets (ERC-1271) work too." : "Sign In With Solana: an ed25519 signature over plain text.";
    const active = prepared?.kind === kind;
    return (
      <div className={cx("flex min-w-0 flex-col gap-4 p-5", INK_BORDER, HARD_SHADOW, SURFACE, active && "outline outline-[3px] outline-offset-2 outline-[#FFD60A]")}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-xl font-bold">{title}</h2>
          <span className={cx(LABEL, "border-2 border-current px-1.5", kind === "solana" ? "bg-[#14F195] text-[#0B1120]" : "bg-[#0052FF] text-white")}>{kind === "evm" ? "EVM" : "Solana"}</span>
        </div>
        <p className={cx("text-sm", TEXT_MUTED)}>{standard}</p>
        {address ? (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className={cx(LABEL, TEXT_MUTED)}>Connected</span>
            <code className="break-all font-code text-[13px]">{address}</code>
          </p>
        ) : null}
        <div className="mt-auto flex flex-wrap gap-2">
          {address ? (
            <Button onClick={() => void prepare(kind)} loading={busy === "prepare" && !prepared} disabled={busy !== null}>
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              Sign in with this wallet
            </Button>
          ) : (
            <Button variant={kind === "evm" ? "primary" : "secondary"} onClick={() => (kind === "evm" ? openConnectModal?.() : solana.openPicker())}>
              Connect {kind === "evm" ? "EVM" : "Solana"} wallet
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-10 sm:py-14">
      <header className="flex flex-col gap-3">
        <p className={cx(LABEL, "font-extrabold", TEXT_MUTED)}>Operator panel</p>
        <h1 className="font-display text-4xl font-bold leading-tight sm:text-5xl">Connect the admin wallet</h1>
        <p className={cx("max-w-2xl text-[15px] leading-relaxed", TEXT_MUTED)}>
          Sign in with either admin wallet. Both give the same panel access. Signing in moves no funds and approves no transaction; deploys and owner
          actions on EVM networks are signed later, one by one, by the EVM admin wallet.
        </p>
      </header>
      <div className="grid gap-5 md:grid-cols-2">
        {walletCard("evm")}
        {walletCard("solana")}
      </div>
      {error ? (
        <p role="alert" className="border-l-[4px] border-[#B91C1C] bg-danger-bg px-3 py-2 text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      {prepared ? (
        <section aria-labelledby="admin-signin-message" className="flex flex-col gap-4">
          <h2 id="admin-signin-message" className="font-display text-2xl font-bold">
            The message you will sign
          </h2>
          <TicketShell
            label="Admin sign-in message"
            kind="blank"
            className="w-full"
            main={
              <>
                <TicketHead icon="key" title="Admin sign-in" serial={prepared.nonce.nonce.slice(0, 8).toUpperCase()} />
                <pre className="kl-admin__message mt-3">{prepared.nonce.message}</pre>
              </>
            }
            stub={
              <div className="flex h-full flex-col gap-2">
                <p className="kla-ticket__stub-k">Expires</p>
                <p className="font-display text-lg font-bold leading-tight">in 5 minutes</p>
                <p className="font-body text-[13px] leading-snug">One use only. A failed attempt needs a new message.</p>
              </div>
            }
          />
          {prepared.problems.length > 0 ? (
            <ul role="alert" className="flex flex-col gap-1.5">
              {prepared.problems.map((problem) => (
                <li key={problem} className="border-l-[4px] border-[#B91C1C] bg-danger-bg px-3 py-2 text-sm font-semibold text-danger">
                  {problem} The panel will not ask your wallet to sign it.
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
      ) : null}
    </div>
  );
}
