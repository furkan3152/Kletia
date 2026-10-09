import { ArrowRight } from "lucide-react";

import { Reveal } from "../../site/motion/Reveal";
import { ButtonLink } from "../../site/ui/Button";
import { CodeBlock, type CodeTab } from "../../site/ui/CodeBlock";
import { Section } from "../../site/ui/Section";
import { IFRAME_SNIPPET, REST_CREATE_INTENT, SDK_PLAN_AND_EXECUTE, WIDGET_SNIPPET } from "../../site/snippets";

const TABS: readonly CodeTab[] = [
  { id: "sdk", label: "TypeScript SDK", language: "ts", code: SDK_PLAN_AND_EXECUTE, filename: "intent.ts" },
  { id: "rest", label: "REST", language: "bash", code: REST_CREATE_INTENT, filename: "POST /v1/intents" },
  { id: "widget", label: "React widget", language: "tsx", code: WIDGET_SNIPPET, filename: "IntentPanel.tsx" },
  { id: "iframe", label: "iframe", language: "html", code: IFRAME_SNIPPET, filename: "index.html" },
];

const POINTS = [
  { title: "Plan", call: "intents.create()", body: "returns the plan with a quote, fees and a minimum output for every leg." },
  { title: "Execute", call: "executeIntent()", body: "walks each leg through the wallet that owns it and waits for the chain." },
  { title: "Follow", call: "intents.stream()", body: "tells you what happened next over Server-Sent Events; signed webhooks cover the time nobody is watching." },
];

export function CodeShowcase() {
  return (
    <Section
      id="code"
      tone="ink"
      reveal
      platform={5}
      eyebrow="SDK"
      title="The whole flow is three SDK calls."
      intro="The SDK only depends on @kletia/core and runs in browsers, Node 20 and edge runtimes. Every call maps to one documented REST route."
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
        <div className="flex flex-col gap-6">
          <Reveal as="ol" stagger className="space-y-5">
            {POINTS.map((point, index) => (
              <li key={point.title} data-reveal-item className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-4">
                <span
                  aria-hidden="true"
                  className="flex h-11 w-11 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#FFD60A] font-display text-xl font-bold text-[#1A1A1A] shadow-[3px_3px_0_#000]"
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="font-code text-[11px] font-bold uppercase tracking-[0.16em] text-[#FFD60A]">{point.title}</h3>
                  <p className="mt-1 text-[15px] leading-relaxed text-white/80">
                    <code className="font-code text-[0.92em] font-semibold text-white">{point.call}</code> {point.body}
                  </p>
                </div>
              </li>
            ))}
          </Reveal>
          <p className="text-[15px] leading-relaxed text-white/80">
            No build step? Drop in the React widget or the <code className="font-code text-[0.92em] text-white">/embed</code> iframe and skip most of the code.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <ButtonLink to="/developers#quickstart" variant="accent" className="!border-white !shadow-[3px_3px_0_#FFFFFF]">
              Quickstart
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </ButtonLink>
            <ButtonLink to="/developers#explorer" variant="secondary" className="!border-white !shadow-[3px_3px_0_#FFD60A]">
              Try the API in the explorer
            </ButtonLink>
            <ButtonLink to="/developers#embed" variant="ghost" className="!border-white/40 !text-white hover:!bg-white/10">
              Embed guide
            </ButtonLink>
          </div>
        </div>
        <CodeBlock
          tabs={TABS}
          label="Integration examples"
          reveal="lines"
          className="!shadow-[8px_8px_0_#FFD60A] dark:!shadow-[8px_8px_0_#FFD60A]"
          maxHeightClassName="max-h-[30rem]"
        />
      </div>
    </Section>
  );
}
