import { ArrowUpRight, Eye, KeyRound, Lock, Scale, ShieldCheck, SplitSquareHorizontal } from "lucide-react";
import React from "react";

import { SECURITY_POLICY_URL } from "../../site/siteLinks";
import { Section } from "../../site/ui/Section";
import { cx, FOCUS_RING } from "../../site/ui/styles";

const CONTROLS: readonly { title: string; body: string; icon: React.ReactNode }[] = [
  {
    title: "Your keys, your signatures",
    body: "The API only returns unsigned transactions. Each step is bound to one CAIP-10 account and the SDK refuses to sign with a different wallet.",
    icon: <KeyRound className="h-5 w-5" aria-hidden="true" />,
  },
  {
    title: "Simulate before you sign",
    body: "Prepared Solana transactions are simulated before they are returned; simulation failures are reported, never hidden.",
    icon: <Eye className="h-5 w-5" aria-hidden="true" />,
  },
  {
    title: "Identity-pinned contracts",
    body: "Base swaps execute through a publicly deployed, identity-pinned router with exact output floors. Provider instructions needing extra signers are rejected.",
    icon: <Lock className="h-5 w-5" aria-hidden="true" />,
  },
  {
    title: "Separate capital lanes",
    body: "Mainnet and testnet networks never share an intent graph, so testnet assets can never fund a production step.",
    icon: <SplitSquareHorizontal className="h-5 w-5" aria-hidden="true" />,
  },
  {
    title: "Evidence over assertions",
    body: "A step is settled only when Kletia observes it on-chain from the bound account, or the settlement network reports the destination fill.",
    icon: <ShieldCheck className="h-5 w-5" aria-hidden="true" />,
  },
  {
    title: "Honest status",
    body: "Development-stage and not yet audited. Uncertain transactions become indeterminate and are recovered by hash, never silently resent.",
    icon: <Scale className="h-5 w-5" aria-hidden="true" />,
  },
];

export function SecuritySection() {
  return (
    <Section
      id="security"
      tone="ink"
      eyebrow="Security model"
      title="Fail closed. Prove everything."
      intro="Kletia is designed so that a bug in planning cannot move funds the user did not see and sign."
      actions={
        <a
          href={SECURITY_POLICY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={cx(
            "inline-flex min-h-11 items-center gap-2 border-[3px] border-white px-4 text-xs font-black uppercase tracking-[0.14em] text-white transition-colors hover:bg-white hover:text-[#111318]",
            FOCUS_RING,
          )}
        >
          Security policy
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      }
    >
      <ul className="grid gap-px border-[3px] border-white/80 bg-white/30 sm:grid-cols-2 lg:grid-cols-3">
        {CONTROLS.map((control) => (
          <li key={control.title} className="bg-[#111318] p-6 dark:bg-[#060A14]">
            <span className="flex h-10 w-10 items-center justify-center border-2 border-[#FFD60A] text-[#FFD60A]">
              {control.icon}
            </span>
            <h3 className="mt-4 font-display text-lg font-bold">{control.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/75">{control.body}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
