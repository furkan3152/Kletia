import React from "react";
import { createPortal } from "react-dom";
import { explorerAddressUrl } from "@kletia/core";
import { Copy, ExternalLink, LoaderCircle, LogOut, Wallet as WalletIcon, X } from "lucide-react";

import { safeWalletIcon, shortenAddress } from "../types";
import { useSolanaWallet } from "./solanaWalletContext";

const INSTALL_LINKS = [
  { name: "Phantom", href: "https://phantom.com" },
  { name: "Solflare", href: "https://solflare.com" },
  { name: "Backpack", href: "https://backpack.app" },
] as const;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

const buttonBase =
  "flex min-h-11 items-center gap-2 border-[3px] border-[#1A1A1A] px-3 py-2 text-xs font-black uppercase tracking-wider shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#9945FF] active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569]";

/**
 * Accessible Solana wallet picker. Opened through `useSolanaWallet().openPicker()`
 * from the navbar pill, the Solana workspace or any other feature.
 */
export function SolanaWalletPicker() {
  const { pickerOpen, closePicker, wallets, wallet, account, status, error, connect, disconnect } =
    useSolanaWallet();
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const [copied, setCopied] = React.useState(false);
  const titleId = React.useId();
  const descriptionId = React.useId();

  React.useEffect(() => {
    if (!pickerOpen) return;
    const restoreTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (restoreTarget?.isConnected) restoreTarget.focus();
    };
  }, [pickerOpen]);

  if (!pickerOpen || typeof document === "undefined") return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePicker();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleConnect = async (walletName: string) => {
    const connected = await connect(walletName);
    if (connected) closePicker();
  };

  const copyAddress = async () => {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 p-3 sm:items-center sm:p-6">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 cursor-default"
        onClick={closePicker}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleKeyDown}
        className="relative z-10 flex max-h-[min(90dvh,40rem)] w-full max-w-md flex-col overflow-hidden border-[4px] border-[#1A1A1A] bg-white text-[#1A1A1A] shadow-[8px_8px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:text-white dark:shadow-[8px_8px_0_#475569]"
      >
        <div className="flex items-center justify-between gap-3 border-b-[4px] border-[#1A1A1A] bg-gradient-to-r from-[#9945FF] to-[#14F195] px-4 py-3 dark:border-[#4B5563]">
          <h2
            id={titleId}
            className="flex items-center gap-2 text-base font-black uppercase tracking-wider text-[#1A1A1A]"
          >
            <WalletIcon className="h-5 w-5" aria-hidden="true" />
            Solana wallet
          </h2>
          <button
            type="button"
            onClick={closePicker}
            aria-label="Close Solana wallet dialog"
            className="flex h-11 w-11 items-center justify-center border-[3px] border-[#1A1A1A] bg-white text-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#1A1A1A] active:translate-y-0.5 active:shadow-none"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="custom-scrollbar flex flex-col gap-4 overflow-y-auto p-4">
          <p id={descriptionId} className="text-sm font-bold text-gray-700 dark:text-slate-300">
            {account
              ? "Kletia prepares unsigned transactions; this wallet reviews and signs each one."
              : "Choose a Wallet Standard wallet. Kletia never sees your keys and every transaction needs your approval."}
          </p>

          <div aria-live="polite" className="min-h-0">
            {status === "connecting" ? (
              <p className="flex items-center gap-2 border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-3 py-2 text-xs font-black uppercase text-[#1A1A1A] dark:border-[#4B5563]">
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                Waiting for wallet approval
              </p>
            ) : null}
          </div>
          {error ? (
            <p
              role="alert"
              className="border-[3px] border-[#1A1A1A] bg-[#FEE2E2] px-3 py-2 text-sm font-bold text-[#7F1D1D] dark:border-red-500 dark:bg-red-950/40 dark:text-red-200"
            >
              {error}
            </p>
          ) : null}

          {account && wallet ? (
            <section
              aria-label="Connected Solana account"
              className="flex flex-col gap-3 border-[3px] border-[#1A1A1A] bg-[#F5F5F0] p-3 shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#0F172A] dark:shadow-[3px_3px_0_#475569]"
            >
              <div className="flex items-center gap-3">
                {safeWalletIcon(wallet.icon) ? (
                  <img
                    src={safeWalletIcon(wallet.icon)}
                    alt=""
                    width={32}
                    height={32}
                    className="h-8 w-8 border-2 border-[#1A1A1A] bg-white object-contain"
                  />
                ) : null}
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-600 dark:text-slate-400">
                    {wallet.name}
                  </p>
                  <p className="truncate font-mono text-sm font-black" title={account.address}>
                    {shortenAddress(account.address, 6, 6)}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void copyAddress()}
                  className={`${buttonBase} bg-white text-[#1A1A1A] dark:bg-[#1A2841] dark:text-white`}
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  <span aria-live="polite">{copied ? "Copied" : "Copy address"}</span>
                </button>
                <a
                  href={explorerAddressUrl("solana", account.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${buttonBase} bg-white text-[#1A1A1A] dark:bg-[#1A2841] dark:text-white`}
                >
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  Solscan
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <button
                  type="button"
                  onClick={() => {
                    void disconnect();
                  }}
                  className={`${buttonBase} bg-[#FF3B30] text-white`}
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  Disconnect
                </button>
              </div>
            </section>
          ) : null}

          {wallets.length > 0 ? (
            <section aria-label="Detected Solana wallets" className="flex flex-col gap-2">
              <h3 className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-600 dark:text-slate-400">
                {account ? "Switch wallet" : "Detected wallets"}
              </h3>
              <ul className="flex flex-col gap-2">
                {wallets.map((candidate) => {
                  const icon = safeWalletIcon(candidate.icon);
                  const active = wallet?.name === candidate.name && Boolean(account);
                  return (
                    <li key={candidate.name}>
                      <button
                        type="button"
                        disabled={status === "connecting" || active}
                        onClick={() => void handleConnect(candidate.name)}
                        aria-current={active ? "true" : undefined}
                        className={`${buttonBase} w-full justify-between bg-white text-[#1A1A1A] hover:bg-[#F3E8FF] dark:bg-[#1A2841] dark:text-white dark:hover:bg-[#243652]`}
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          {icon ? (
                            <img
                              src={icon}
                              alt=""
                              width={28}
                              height={28}
                              className="h-7 w-7 shrink-0 object-contain"
                            />
                          ) : (
                            <WalletIcon className="h-6 w-6 shrink-0" aria-hidden="true" />
                          )}
                          <span className="truncate text-sm normal-case tracking-normal">
                            {candidate.name}
                          </span>
                        </span>
                        <span className="shrink-0 text-[10px]">
                          {active ? "Connected" : "Connect"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : (
            <section aria-label="Install a Solana wallet" className="flex flex-col gap-2">
              <p className="text-sm font-bold">
                No Solana wallet was detected in this browser. Install one of these Wallet
                Standard wallets, then reload this page:
              </p>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {INSTALL_LINKS.map((link) => (
                  <li key={link.name}>
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`${buttonBase} w-full justify-center bg-[#14F195] text-[#1A1A1A]`}
                    >
                      {link.name}
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default SolanaWalletPicker;
