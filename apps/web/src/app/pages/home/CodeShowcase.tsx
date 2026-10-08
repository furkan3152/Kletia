import { ArrowRight } from "lucide-react";

import { ButtonLink } from "../../site/ui/Button";
import { CodeBlock, type CodeTab } from "../../site/ui/CodeBlock";
import { Section } from "../../site/ui/Section";
import { cx, LABEL } from "../../site/ui/styles";
import { REST_CREATE_INTENT, SDK_PLAN_AND_EXECUTE, WIDGET_SNIPPET } from "../../site/snippets";

const TABS: readonly CodeTab[] = [
  { id: "sdk", label: "TypeScript SDK", language: "ts", code: SDK_PLAN_AND_EXECUTE, filename: "intent.ts" },
  { id: "rest", label: "REST", language: "bash", code: REST_CREATE_INTENT, filename: "POST /v1/intents" },
  { id: "widget", label: "React widget", language: "tsx", code: WIDGET_SNIPPET, badge: "Preview", filename: "IntentPanel.tsx" },
];

const POINTS = [
  { title: "Plan", body: "intents.create() returns a typed IntentGraph with quotes, fees and floors." },
  { title: "Execute", body: "executeIntent() drives each step through the wallet that owns it." },
  { title: "Observe", body: "Stream events over SSE or receive HMAC-signed webhooks." },
];

export function CodeShowcase() {
  return (
    <Section
      id="code"
      tone="ink"
      eyebrow="Developer experience"
      title={
        <>
          Plan, sign and prove in <span className="text-[#FFD60A]">three calls</span>.
        </>
      }
      intro="The SDK depends only on @kletia/core. It runs in browsers, Node 20+ and edge runtimes, and every request maps 1:1 to the documented REST API."
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
        <div className="flex flex-col gap-6">
          <ol className="space-y-5">
            {POINTS.map((point, index) => (
              <li key={point.title} className="flex gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-white/80 font-display text-lg font-bold text-[#FFD60A]">
                  {index + 1}
                </span>
                <div>
                  <h3 className={cx(LABEL, "text-white")}>{point.title}</h3>
                  <p className="mt-1 text-[15px] leading-relaxed text-white/75">{point.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-3 pt-2">
            <ButtonLink to="/developers#quickstart" variant="accent" className="!border-white !shadow-[3px_3px_0_#FFFFFF]">
              Quickstart
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </ButtonLink>
            <ButtonLink to="/developers#explorer" variant="secondary" className="!border-white !shadow-[3px_3px_0_#FFD60A]">
              Try the API live
            </ButtonLink>
          </div>
        </div>
        <CodeBlock
          tabs={TABS}
          label="Integration examples"
          className="!shadow-[8px_8px_0_#FFD60A] dark:!shadow-[8px_8px_0_#FFD60A]"
          maxHeightClassName="max-h-[30rem]"
        />
      </div>
    </Section>
  );
}
