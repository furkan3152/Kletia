import type { IconName } from "../../site/art";
import { Icon } from "../../site/art/Icon";
import { Section } from "../../site/ui/Section";

interface Rule {
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
  readonly tag: string;
}

const RULES: readonly Rule[] = [
  {
    icon: "name",
    title: "Ids instead of names",
    body: "Chains, accounts and tokens travel as CAIP-2, CAIP-10 and CAIP-19 ids, so USDC on Base is never mistaken for USDC on Polygon.",
    tag: "@kletia/core",
  },
  {
    icon: "key",
    title: "The API never signs",
    body: "Responses carry unsigned transactions. Keys stay in the user's wallet, and Kletia never holds funds.",
    tag: "unsigned payloads",
  },
  {
    icon: "verify",
    title: "Settled means seen on-chain",
    body: "A hash on its own moves nothing. Kletia waits until it reads the transaction from the bound account, and a cross-network leg waits for the destination fill.",
    tag: "StepEvidence",
  },
  {
    icon: "bridge",
    title: "Legs merge when they can",
    body: "If one venue can bridge and swap in a single transaction, the planner uses it and the user signs once.",
    tag: "bridge auction",
  },
  {
    icon: "webhook",
    title: "Events you can check",
    body: "Server-Sent Events while someone is watching, HMAC-SHA256 signed webhooks when nobody is. Each webhook carries a timestamp and is retried after 1, 5 and 25 seconds.",
    tag: "Kletia-Signature",
  },
  {
    icon: "route",
    title: "Compiled by a grammar",
    body: "A fixed grammar turns the text into legs. Wording it does not know gets a 422 that lists the phrases it does know, so nothing is guessed.",
    tag: "INTENT_UNSUPPORTED",
  },
  {
    icon: "shield",
    title: "Fails closed",
    body: "Solana transactions are simulated before you receive them, Base swaps go through an identity-pinned router, and test funds never touch a mainnet leg.",
    tag: "simulation · pinning · lanes",
  },
  {
    icon: "sdk",
    title: "Open source",
    body: "The engine, the spec, the SDK and this site are MIT licensed. Read the code that plans your users' transactions.",
    tag: "MIT",
  },
];

/** A brass pin holding the notice to the wall. */
function Pin({ side }: { readonly side: "left" | "right" }) {
  return (
    <span
      aria-hidden="true"
      className={`absolute -top-[9px] z-[2] h-4 w-4 rounded-full border-[3px] border-[#1A1A1A] bg-[#FFD60A] shadow-[inset_-2px_-2px_0_rgba(26,26,26,0.35)] ${side === "left" ? "left-7" : "right-7"}`}
    />
  );
}

/**
 * House rules: the planner's guarantees as a notice posted on the platform.
 * Printed stock: the notice keeps its ink at night.
 */
export function FeatureGrid() {
  return (
    <Section
      id="infrastructure"
      platform={6}
      eyebrow="House rules"
      tone="paper"
      bordered
      reveal
      title="Rules the planner follows on every route."
      intro="Each one is enforced by the API and written down in the public spec."
    >
      <div className="kla-grain relative -rotate-[0.4deg] border-[3px] border-[#1A1A1A] bg-[#FFFCF2] pb-3 text-[#1A1A1A] shadow-hard-lg dark:bg-[#ECE6D6] [--kla-plate:#FFD60A] [--kla-grain:var(--kla-stock-grain)]">
        <Pin side="left" />
        <Pin side="right" />
        <p className="flex flex-wrap justify-between gap-2 bg-[#1A1A1A] px-6 py-3.5 font-code text-xs font-extrabold uppercase leading-tight tracking-[0.18em] text-[#FFD60A]">
          <span>Kletia planner</span>
          <span className="font-semibold text-[#F4F1EA]">House rules · in force on every route</span>
        </p>
        <ol className="grid px-6 md:grid-cols-2">
          {RULES.map((rule, index) => (
            <li
              key={rule.title}
              className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-4 border-b-[1.5px] border-dashed border-[#1A1A1A]/35 py-6 last:border-b-0 md:odd:pr-7 md:even:border-l-[1.5px] md:even:pl-7 md:[&:nth-last-child(2)]:border-b-0"
            >
              <Icon name={rule.icon} size={34} />
              <div className="min-w-0">
                <h3 className="mt-1 font-display text-lg font-bold leading-snug tracking-[-0.015em]">
                  <span className="mr-2 font-code text-xs font-bold text-[#5B5C61]">{String(index + 1).padStart(2, "0")}</span>
                  {rule.title}
                </h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-[#45464B]">{rule.body}</p>
                <code className="mt-2 inline-block font-code text-[11.5px] font-semibold text-[#0047E0]">{rule.tag}</code>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
