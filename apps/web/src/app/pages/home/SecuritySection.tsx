import { ArrowUpRight, Eye, KeyRound, Lock, Scale, ShieldCheck, SplitSquareHorizontal } from "lucide-react";
import React from "react";

import { Reveal } from "../../site/motion/Reveal";
import { SECURITY_POLICY_URL } from "../../site/siteLinks";
import { Section } from "../../site/ui/Section";
import { cx } from "../../site/ui/styles";
import { EvidenceChain } from "./EvidenceChain";

const FOCUS_ON_INK =
  "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#FFD60A]";

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
      reveal
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
            FOCUS_ON_INK,
          )}
        >
          Security policy
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      }
    >
      <EvidenceChain />
      <Reveal as="ul" stagger className="group/controls grid gap-px border-[3px] border-white/80 bg-white/30 sm:grid-cols-2 lg:grid-cols-3">
        {CONTROLS.map((control, index) => (
          <li key={control.title} data-reveal-item className="group grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 bg-[#111318] p-5 sm:block sm:p-6 transition-colors duration-150 hover:bg-[#161a22] motion-reduce:transition-none dark:bg-[#060A14] dark:hover:bg-[#0A1020]">
            <span
              className="row-span-2 flex h-10 w-10 items-center justify-center border-2 border-[#FFD60A] text-[#FFD60A] transition-colors duration-150 group-hover:bg-[#FFD60A] group-hover:text-[#111318] group-data-[reveal=shown]/controls:animate-[kl-stamp_320ms_var(--kl-ease-snap)_backwards] motion-reduce:!animate-none motion-reduce:transition-none"
              style={{ animationDelay: `${200 + Math.min(index, 8) * 60}ms` }}
            >
              {control.icon}
            </span>
            <h3 className="font-display text-lg font-bold leading-snug sm:mt-4">{control.title}</h3>
            <p className="mt-1.5 text-sm sm:mt-2 leading-relaxed text-white/75">{control.body}</p>
          </li>
        ))}
      </Reveal>
    </Section>
  );
}
