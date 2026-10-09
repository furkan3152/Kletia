import { ArrowUpRight } from "lucide-react";

import { STAMP_LABELS, type StampState } from "../../site/art";
import { LineStrip } from "../../site/art/LineStrip";
import { Stamp } from "../../site/art/Stamp";
import { Reveal } from "../../site/motion/Reveal";
import { SECURITY_POLICY_URL } from "../../site/siteLinks";
import { Section } from "../../site/ui/Section";
import { cx } from "../../site/ui/styles";

const FOCUS_ON_INK =
  "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#FFD60A]";

const CHECKS: readonly { id: string; title: string; body: string }[] = [
  {
    id: "account",
    title: "One account per leg",
    body: "Each leg is bound to one CAIP-10 account, and the SDK refuses to sign it with a different wallet.",
  },
  {
    id: "simulated",
    title: "Simulated before you see it",
    body: "Prepared Solana transactions are simulated before they are returned. A failed simulation is reported, never hidden.",
  },
  {
    id: "pinned",
    title: "Pinned contracts",
    body: "Base swaps run through a publicly deployed router pinned by identity, with exact minimum outputs. Instructions that need extra signers are rejected.",
  },
  {
    id: "capital",
    title: "Separate capital",
    body: "Mainnet and testnet networks never share a plan, so test tokens can never fund a production leg.",
  },
  {
    id: "evidence",
    title: "Evidence before progress",
    body: "A leg settles only when Kletia reads it on-chain from the bound account, or the settlement network reports the fill.",
  },
  {
    id: "status",
    title: "Plain status",
    body: "Kletia is in development and has not been audited. If a transaction's outcome is unknown, it is marked held and recovered by hash, never sent twice.",
  },
];

/** The stamps a leg can collect, in the order it collects them; held and failed are the two ways it can stop. */
const STAMPS: readonly { state: StampState; text: string; width: string }[] = [
  { state: "planned", text: "Quoted, nothing signed.", width: "9.5rem" },
  { state: "signed", text: "Your wallet signed it.", width: "7.25rem" },
  { state: "settled", text: "Read on-chain from your account.", width: "9.5rem" },
  { state: "held", text: "Outcome unknown: recovered by hash, never resent.", width: "9.5rem" },
  { state: "failed", text: "Stopped before it settled. Nothing moves after it.", width: "7.5rem" },
];

export function SecuritySection() {
  return (
    <Section
      id="security"
      platform={8}
      eyebrow="Security model"
      tone="ink"
      reveal
      title="A planning bug still cannot move money the user did not sign for."
      intro="Six checks sit between a sentence and a signature."
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
          Read the security policy
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      }
    >
      <div className="kla-grain mb-10 border-[3px] border-black bg-[#FFFCF2] text-[#1A1A1A] shadow-[6px_6px_0_#000] dark:bg-[#ECE6D6] [--kla-grain:var(--kla-stock-grain)]">
        <p className="border-b-[3px] border-black bg-[#FFD60A] px-5 py-2.5 font-code text-[11px] font-extrabold uppercase tracking-[0.18em]">
          Every leg is stamped in order
        </p>
        <ol className="grid grid-cols-2 gap-x-4 gap-y-8 px-4 py-7 sm:grid-cols-3 sm:gap-x-6 sm:px-5 lg:grid-cols-5">
          {STAMPS.map((stamp, index) => (
            <li key={stamp.state} className="flex min-w-0 flex-col items-center gap-4 text-center">
              {/* Each die prints at its own size: the round seal and the octagon are smaller than the plates. */}
              <span className="flex h-28 items-center justify-center">
                <span className="block max-w-full" style={{ width: stamp.width }}>
                  <Stamp state={stamp.state} animate delayMs={index * 140} className="w-full [transform:rotate(var(--kla-rot))]" />
                </span>
              </span>
              <p className="max-w-[15rem] text-[13px] font-semibold leading-snug sm:text-sm">
                <span className="sr-only">{STAMP_LABELS[stamp.state]}. </span>
                {stamp.text}
              </p>
            </li>
          ))}
        </ol>
      </div>
      <Reveal>
        <LineStrip tone="ink" from="your sentence" to="your signature" stops={CHECKS} />
      </Reveal>
    </Section>
  );
}
