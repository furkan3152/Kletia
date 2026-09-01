import React from "react";
import {
  ArrowRight,
  Banknote,
  Fingerprint,
  Landmark,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { resolveStellarWorkspaceIntent } from "../runtime/intentWorkspace";
import type { StellarPasskeySession } from "../runtime/passkeyAccount";
import { PasskeyAccountCard } from "./PasskeyAccountCard";
import { StellarPayoutIntentCard } from "./StellarPayoutIntentCard";
import "./StellarHub.css";

const panel =
  "border-[4px] border-[#1A1A1A] bg-white p-4 shadow-[6px_6px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:shadow-[6px_6px_0_#475569] sm:p-5";
const action =
  "flex min-h-12 items-center justify-between gap-3 border-[3px] border-[#1A1A1A] bg-white px-4 py-3 text-left text-sm font-black shadow-[3px_3px_0_#1A1A1A] transition hover:-translate-y-0.5 hover:shadow-[5px_5px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#6D28D9] dark:border-[#4B5563] dark:bg-[#1A2841] dark:shadow-[3px_3px_0_#475569]";

export function StellarPaymentCenter({
  evmAddress,
  initialIntent,
  onIntentConsumed,
  onIntentSelect,
}: {
  evmAddress?: `0x${string}`;
  initialIntent?: string;
  onIntentConsumed?: () => void;
  onIntentSelect?: (prompt: string) => void;
}) {
  const [passkeySession, setPasskeySession] = React.useState<StellarPasskeySession | null>(null);
  const initialResolution = React.useMemo(() => {
    const candidate = initialIntent?.trim();
    if (!candidate) return undefined;
    const resolution = resolveStellarWorkspaceIntent(candidate);
    return resolution.kind === "payout" ? resolution : undefined;
  }, [initialIntent]);

  React.useEffect(() => {
    if (initialIntent) onIntentConsumed?.();
  }, [initialIntent, onIntentConsumed]);

  return (
    <main className="mx-auto grid w-full max-w-6xl gap-5 pb-12" aria-label="Stellar Payment Center">
      <section className="relative overflow-hidden border-[4px] border-[#1A1A1A] bg-[#6D28D9] p-5 text-white shadow-[7px_7px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[7px_7px_0_#475569] sm:p-7">
        <Sparkles className="absolute -right-5 -top-5 h-32 w-32 opacity-15" aria-hidden="true" />
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#DDD6FE]">
          Stellar Testnet · Payment Center
        </p>
        <h1 className="mt-2 max-w-3xl text-2xl font-black leading-tight sm:text-4xl">
          Move USDC into a local payment rail.
        </h1>
        <p className="mt-3 max-w-3xl text-sm font-bold leading-relaxed text-[#EDE9FE] sm:text-base">
          Kletia brings USDC from a supported Testnet, compares reviewed anchor prices, and keeps the hosted withdrawal, delivery, and refund states in one payment flow.
        </p>
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          {[
            [Fingerprint, "Passkey identity", "secp256r1 Stellar account"],
            [Banknote, "Live FX", "SEP-38 provider quotes"],
            [Landmark, "Hosted off-ramp", "SEP-24 withdrawal lifecycle"],
          ].map(([Icon, title, detail]) => (
            <div key={String(title)} className="border-[3px] border-[#1A1A1A] bg-white p-3 text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A]">
              {React.createElement(Icon as typeof Fingerprint, { className: "h-5 w-5" })}
              <strong className="mt-2 block text-xs font-black uppercase">{String(title)}</strong>
              <span className="mt-1 block text-[10px] font-bold">{String(detail)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <div className={panel}>
          <div className="mb-4 flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#FFF36D] text-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A]">
              <Fingerprint className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#6D28D9] dark:text-[#C4B5FD]">Step 1</p>
              <h2 className="text-lg font-black">Your Stellar payment identity</h2>
              <p className="mt-1 text-xs font-bold leading-relaxed text-[#4B4657] dark:text-slate-300">
                Create or restore a seedless contract account with your device passkey. Kletia cannot sign with it.
              </p>
            </div>
          </div>
          <PasskeyAccountCard evmAddress={evmAddress} onSessionChange={setPasskeySession} showTransferTools={false} />
        </div>

        <div className={panel}>
          <div className="mb-4 flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#B9F6D2] text-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A]">
              <Banknote className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#6D28D9] dark:text-[#C4B5FD]">Step 2</p>
              <h2 className="text-lg font-black">Compare a real payout</h2>
              <p className="mt-1 text-xs font-bold leading-relaxed text-[#4B4657] dark:text-slate-300">
                Only allowlisted anchor responses appear. Missing live support stays unavailable instead of becoming a mock route.
              </p>
            </div>
          </div>
          <StellarPayoutIntentCard
            resolution={initialResolution}
            evmAddress={evmAddress}
            compact
            passkeySession={passkeySession}
            showPasskeySetup={false}
          />
        </div>
      </section>

      <section className={panel}>
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-6 w-6 shrink-0 text-[#6D28D9] dark:text-[#C4B5FD]" />
          <div>
            <h2 className="text-base font-black">What happens after comparison?</h2>
            <p className="mt-1 text-xs font-bold leading-relaxed text-[#4B4657] dark:text-slate-300">
              Kletia will bind SEP-45 authentication, a firm SEP-38 quote, the anchor&apos;s SEP-24 hosted withdrawal, optional SEP-12 remediation, and refund evidence into one state machine. SEP-31 stays a separate partner-anchor track; it is not a direct wallet off-ramp.
            </p>
          </div>
        </div>
        <ol className="mt-4 grid gap-2 sm:grid-cols-4">
          {["Authenticate", "Complete KYC", "Approve settlement", "Track delivery or refund"].map((label, index) => (
            <li key={label} className="flex items-center gap-2 border-[2px] border-[#1A1A1A] bg-[#F5F5F0] p-3 text-xs font-black dark:border-[#4B5563] dark:bg-[#1A2841]">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center bg-[#6D28D9] text-white">{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </section>

      <section className={panel}>
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#6D28D9] dark:text-[#C4B5FD]">Stellar network tools</p>
        <h2 className="mt-1 text-lg font-black">Use native tools when you need them</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            ["Show Stellar balances", "Show my live XLM and USDC balances on Stellar"],
            ["Send a Stellar payment", "Send 5 USDC to a Stellar address"],
            ["Swap XLM and USDC", "Swap 5 XLM to USDC using the best live Stellar route"],
          ].map(([label, prompt]) => (
            <button key={label} type="button" className={action} onClick={() => onIntentSelect?.(prompt)}>
              <span>{label}</span><ArrowRight className="h-4 w-4 shrink-0" />
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
