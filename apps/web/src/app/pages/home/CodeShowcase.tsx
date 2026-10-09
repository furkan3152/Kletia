import { ArrowRight } from "lucide-react";

import { Reveal } from "../../site/motion/Reveal";
import { ButtonLink } from "../../site/ui/Button";
import { CodeBlock, type CodeTab } from "../../site/ui/CodeBlock";
import { Section } from "../../site/ui/Section";
import { cx, LABEL } from "../../site/ui/styles";
import { IFRAME_SNIPPET, REST_CREATE_INTENT, SDK_PLAN_AND_EXECUTE, WIDGET_SNIPPET } from "../../site/snippets";

const TABS: readonly CodeTab[] = [
  { id: "sdk", label: "TypeScript SDK", language: "ts", code: SDK_PLAN_AND_EXECUTE, filename: "intent.ts" },
  { id: "rest", label: "REST", language: "bash", code: REST_CREATE_INTENT, filename: "POST /v1/intents" },
  { id: "widget", label: "React widget", language: "tsx", code: WIDGET_SNIPPET, filename: "IntentPanel.tsx" },
  { id: "iframe", label: "iframe", language: "html", code: IFRAME_SNIPPET, filename: "index.html" },
];

const POINTS = [
  { title: "Plan", body: "intents.create() returns a typed IntentGraph with quotes, fees and floors." },
  { title: "Execute", body: "executeIntent() drives each step through the wallet that owns it." },
  { title: "Observe", body: "Stream events over SSE or receive HMAC-signed webhooks." },
  { title: "Embed", body: "No build step? Drop in the React widget or the /embed iframe; users sign with their own wallets." },
];

export function CodeShowcase() {
  return (
    <Section
      id="code"
      tone="ink"
      reveal
      eyebrow="Developer experience"
      title={
        <>
          Plan, sign and prove in <span className="text-[#FFD60A]">three calls</span>.
        </>
      }
      intro="The SDK depends only on @kletia/core. It runs in browsers, Node 20+ and edge runtimes, and every request maps 1:1 to the documented REST API. Or skip the code and embed the widget."
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
        <div className="flex flex-col gap-6">
          <Reveal as="ol" stagger className="group/points space-y-5">
            {POINTS.map((point, index) => (
              <li key={point.title} data-reveal-item className="flex gap-4">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-white/80 font-display text-lg font-bold text-[#FFD60A] group-data-[reveal=shown]/points:animate-[kl-stamp_320ms_var(--kl-ease-snap)_backwards] motion-reduce:!animate-none"
                  style={{ animationDelay: `${180 + index * 120}ms` }}
                >
                  {index + 1}
                </span>
                <div>
                  <h3 className={cx(LABEL, "text-white")}>{point.title}</h3>
                  <p className="mt-1 text-[15px] leading-relaxed text-white/75">{point.body}</p>
                </div>
              </li>
            ))}
          </Reveal>
          <div className="flex flex-wrap gap-3 pt-2">
            <ButtonLink to="/developers#quickstart" variant="accent" className="!border-white !shadow-[3px_3px_0_#FFFFFF]">
              Quickstart
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </ButtonLink>
            <ButtonLink to="/developers#explorer" variant="secondary" className="!border-white !shadow-[3px_3px_0_#FFD60A]">
              Try the API live
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
