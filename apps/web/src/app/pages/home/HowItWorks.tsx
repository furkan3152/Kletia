import type { IconName, StampState } from "../../site/art";
import { Icon } from "../../site/art/Icon";
import { LineRule } from "../../site/art/Ornaments";
import { TicketStub } from "../../site/art/Ticket";
import { Section } from "../../site/ui/Section";
import { cx, TEXT_MUTED } from "../../site/ui/styles";
import { HERO_SERIAL } from "./homeExamples";

interface Step {
  readonly title: string;
  readonly body: string;
  readonly artifact: string;
  readonly icon: IconName;
}

const STEPS: readonly Step[] = [
  {
    title: "You write it",
    body: "Send plain English or structured actions to POST /v1/intents. Accounts are CAIP-10 ids, one per chain family.",
    artifact: "IntentRequest",
    icon: "ticket",
  },
  {
    title: "Kletia plans it",
    body: "A grammar turns the text into legs. Each leg names one account, one venue and the least it will accept.",
    artifact: "IntentGraph",
    icon: "route",
  },
  {
    title: "The wallet signs it",
    body: "Every leg that moves value goes to the user's wallet: EIP-1193 on EVM, Wallet Standard on Solana.",
    artifact: "unsigned transaction",
    icon: "key",
  },
  {
    title: "The chain proves it",
    body: "A leg is settled when Kletia reads it on-chain from the bound account. The next leg waits until then.",
    artifact: "StepEvidence",
    icon: "verify",
  },
];

interface StubState {
  readonly state: StampState;
  readonly done: number;
  readonly caption: string;
  readonly stampCaption?: string;
  /** Small tilt and drop, so the three stubs look laid on the desk by hand. */
  readonly pose: string;
}

const STUBS: readonly StubState[] = [
  { state: "planned", done: 0, caption: "Planned. Quotes are in, nothing is signed yet.", pose: "-rotate-2" },
  { state: "signed", done: 1, caption: "Signed. The wallet sent leg 1; Kletia is watching for it.", stampCaption: "Leg 1 of 2", pose: "rotate-[1.5deg] translate-y-4" },
  { state: "settled", done: 2, caption: "Settled. Both legs were read on-chain.", pose: "-rotate-[0.6deg] translate-y-1" },
];

/** How a route runs: four steps with their artifacts, and one ticket stub collecting its three stamps. */
export function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      platform={3}
      eyebrow="How a route runs"
      tone="paper"
      bordered
      reveal
      title="What happens to one sentence."
      intro="The same request and the same quotes always give the same plan. There is no language model between your text and the transactions."
      className="[--kla-table:#EDE9DF] dark:[--kla-table:#0E1729]"
    >
      <LineRule className="mb-14" />
      <div className="grid gap-14 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] xl:gap-16">
        <ol className="grid content-start gap-7">
          {STEPS.map((step, index) => (
            <li key={step.title} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-4">
              <span className="flex h-[3.25rem] w-[3.25rem] items-center justify-center border-[3px] border-[#1A1A1A] bg-[#FBFAF7] text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:text-[#F1F5F9]">
                <Icon name={step.icon} size={30} />
              </span>
              <div className="min-w-0">
                <h3 className="font-display text-xl font-bold leading-tight tracking-[-0.015em]">
                  <span className="mr-2 font-code text-sm font-bold text-[#45464B] dark:text-[#A9B6C8]">{index + 1}.</span>
                  {step.title}
                </h3>
                <p className={cx("mt-1.5 text-[15px] leading-relaxed", TEXT_MUTED)}>{step.body}</p>
                <code className="mt-2 inline-block font-code text-[11.5px] font-semibold text-[#0047E0] dark:text-[#7EA6FF]">{step.artifact}</code>
              </div>
            </li>
          ))}
        </ol>

        <div className="min-w-0">
          <p className={cx("mb-5 font-code text-[10px] font-bold uppercase tracking-[0.16em]", TEXT_MUTED)}>One ticket, three stamps</p>
          {/* Phones: one stub per row with its caption beside it, so a stamp never lands on the punched holes. */}
          <ol className="grid gap-9 pl-2 sm:grid-cols-3 sm:gap-6 sm:pl-3">
            {STUBS.map((stub, index) => (
              <li key={stub.state} className="grid min-w-0 grid-cols-[10.5rem_minmax(0,1fr)] items-center gap-6 sm:block">
                <TicketStub
                  serial={HERO_SERIAL}
                  legs={2}
                  legsDone={stub.done}
                  state={stub.state}
                  stampCaption={stub.stampCaption}
                  animateStamp
                  stampDelayMs={index * 160}
                  className={stub.pose}
                />
                <p className={cx("text-[15px] leading-relaxed sm:mt-8 sm:text-sm", TEXT_MUTED)}>{stub.caption}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Section>
  );
}
