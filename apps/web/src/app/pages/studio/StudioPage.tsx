import { useState } from "react";

import { useRoute } from "../../routes/useRoute";
import { Badge } from "../../site/ui/Badge";
import { CONTAINER, cx, LABEL, TEXT_MUTED } from "../../site/ui/styles";
import { StudioWorkspace } from "./StudioWorkspace";

function readPromptParam(search: string): string {
  try {
    return (new URLSearchParams(search).get("q") ?? "").slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * Intent Studio (read-only planning preview). Wallet execution will be added
 * by wrapping StudioWorkspace in WalletProviders and passing `renderActions`.
 */
export default function StudioPage() {
  const { location } = useRoute();
  const [initialText] = useState(() => readPromptParam(location.search));

  return (
    <>
      <header className="kl-grid-backdrop border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "flex flex-col gap-6 py-12 sm:py-16 lg:flex-row lg:items-end lg:justify-between")}>
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>Intent Studio</p>
              <Badge tone="yellow">Preview</Badge>
            </div>
            <h1 className="mt-4 text-balance font-display text-[clamp(2.4rem,6.5vw,4.5rem)] font-bold leading-[0.95] tracking-[-0.045em]">
              Type an outcome. <span className="text-[#9945FF]">See the plan.</span>
            </h1>
            <p className={cx("mt-5 max-w-2xl text-lg leading-relaxed", TEXT_MUTED)}>
              Studio sends your words to <code className="font-code text-[0.9em]">POST /v1/intents?dryRun=true</code> and
              draws the graph Kletia compiles: steps per network, protocols, expected and minimum outputs, fees and
              timing.
            </p>
          </div>
        </div>
      </header>
      <div className={cx(CONTAINER, "py-10 sm:py-14")}>
        <StudioWorkspace initialText={initialText} />
      </div>
    </>
  );
}
