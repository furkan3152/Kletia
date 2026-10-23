/**
 * The owner wallet's decision on a sub-agent request: pick a browser wallet
 * (the account sign-in's EIP-6963 / Wallet Standard discovery), ask the API
 * for the message, check it names this portal, wallet, decision, request and
 * rule book (approvalMessageProblems), show it, then sign. A failed attempt
 * uses the message up; the next one starts from a fresh message.
 */
import { PenLine } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../../site/ui/Button";
import { cx, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { walletErrorText } from "../../admin/model/session";
import { base58Encode } from "../../admin/model/signIn";
import { isPlatformError } from "../keys/accountClient";
import { accountChainId } from "../keys/accountModel";
import { connectWallet, discoverEvmWallets, discoverSolanaWallets, signWithWallet, type ConnectedWallet, type WalletOption } from "../keys/injectedWallets";
import { approvalMessageProblems, type SubagentRequest } from "./agentTreeModel";
import { agentsApi } from "./agentsClient";

const currentTime = () => Date.now();

interface Prepared {
  readonly option: WalletOption;
  readonly connected: ConnectedWallet;
  readonly message: string;
  readonly problems: readonly string[];
}

export interface WalletDecisionProps {
  readonly request: SubagentRequest;
  readonly decision: "approve" | "deny";
  readonly onDone: (request: SubagentRequest) => void;
  readonly onCancel: () => void;
}

export function WalletDecision({ request, decision, onDone, onCancel }: WalletDecisionProps) {
  const [wallets, setWallets] = useState<readonly WalletOption[] | null>(null);
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
  }, []);

  const prepare = async (option: WalletOption) => {
    setBusy(option.id);
    setError(null);
    setPrepared(null);
    try {
      const connected = await connectWallet(option);
      const identity = option.kind === "evm" ? { walletKind: "evm" as const, address: connected.address, chainId: accountChainId(connected.chainId) } : { walletKind: "solana" as const, address: connected.address };
      const { message } = await agentsApi.challenge(request.id, decision, identity);
      const problems = approvalMessageProblems(message, { host: window.location.host, origin: window.location.origin, address: connected.address, decision, request, now: currentTime() });
      setPrepared({ option, connected, message, problems });
    } catch (failure) {
      setError(isPlatformError(failure) ? failure.message : walletErrorText(failure));
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
      onDone(await agentsApi.decideWithWallet(request.id, decision, prepared.message, signature));
    } catch (failure) {
      setPrepared(null);
      setError(isPlatformError(failure) ? failure.message : walletErrorText(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cx("flex min-w-0 flex-col gap-3 p-3", INK_BORDER, SURFACE)}>
      <p className={cx("text-sm", TEXT_MUTED)}>
        Only the wallet that owns this project can {decision} with a signature. Signing moves no funds; the message works once, for 10 minutes.
      </p>
      {wallets === null ? <p className={cx("text-sm", TEXT_MUTED)}>Looking for browser wallets…</p> : null}
      {wallets !== null && wallets.length === 0 ? <p className="text-sm">No browser wallet found. Unlock an EVM or Solana wallet extension, or decide with a project key.</p> : null}
      {wallets && wallets.length > 0 && !prepared ? (
        <ul className="flex flex-wrap gap-2">
          {wallets.map((option) => (
            <li key={`${option.kind}:${option.id}`}>
              <Button size="sm" variant="secondary" onClick={() => void prepare(option)} loading={busy === option.id} disabled={busy !== null}>
                <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
                {option.name}
                <span className={cx(LABEL, "ml-1 border-2 border-current px-1")}>{option.kind === "evm" ? "EVM" : "Solana"}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="border-l-[4px] border-[#B91C1C] bg-danger-bg px-3 py-2 text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      {prepared ? (
        <>
          <pre className={cx("max-h-72 overflow-auto whitespace-pre-wrap break-all p-3 font-code text-[12px]", INK_BORDER, SURFACE)}>{prepared.message}</pre>
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
            <Button variant={decision === "approve" ? "accent" : "secondary"} onClick={() => void sign()} loading={busy === "sign"} disabled={prepared.problems.length > 0 || busy !== null}>
              <PenLine className="h-4 w-4" aria-hidden="true" />
              Sign to {decision}
            </Button>
            <Button variant="ghost" onClick={onCancel} disabled={busy === "sign"}>
              Cancel
            </Button>
          </div>
        </>
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
