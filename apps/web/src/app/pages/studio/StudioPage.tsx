import type { IntentGraph } from "@kletia/core";
import { ArrowRight, History } from "lucide-react";
import { useState, type ReactNode } from "react";

import { readIntentSession, STUDIO_INTENT_SESSION_KEY } from "../../../shared/platform/intentSession";
import { deskHandoffHref, DESK_ENTRY } from "../../console/tools/deskHandoff";
import { Link } from "../../routes/Link";
import { useRoute } from "../../routes/useRoute";
import { PlatformNumber } from "../../site/art/Ornaments";
import { buttonClasses, CONTAINER, cx, HARD_SHADOW, INK_BORDER, TEXT_MUTED } from "../../site/ui/styles";
import { StudioWorkspace } from "./StudioWorkspace";

function readPromptParam(search: string): string {
  try {
    return (new URLSearchParams(search).get("q") ?? "").slice(0, 500);
  } catch {
    return "";
  }
}

/*
 * The desk link never prefetches: hovering it would load the console chunk
 * and its wallet runtimes on a site page. The desk loads when it opens.
 */
function DeskLink({ to, className, children }: { readonly to: string; readonly className: string; readonly children: ReactNode }) {
  return (
    <Link to={to} prefetch={false} className={className}>
      {children}
    </Link>
  );
}

/** "Run in the console": the desk plans the sentence again with the user's own accounts and signs it. */
function RunInConsole({ intent }: { readonly intent: IntentGraph }) {
  const signatures = intent.summary.signaturesRequired;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className={cx("text-sm", TEXT_MUTED)}>
        Ready to run it? The console plans it again with your own accounts, then your wallet signs {signatures} time
        {signatures === 1 ? "" : "s"}.
      </p>
      <DeskLink to={deskHandoffHref(intent)} className={buttonClasses("primary", "md", "shrink-0")}>
        Run in the console
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </DeskLink>
    </div>
  );
}

/**
 * Intent Studio: wallet-free dry-run planning with a live graph. Running a
 * plan happens in the console (the desk at /app), which plans it again with
 * the connected accounts; Studio never loads wallet code (console design 2).
 */
export default function StudioPage() {
  const { location } = useRoute();
  const [initialText] = useState(() => readPromptParam(location.search));
  // A tab that was executing an intent from Studio before this round: the desk picks the record up once.
  const [resumable] = useState(() => readIntentSession(STUDIO_INTENT_SESSION_KEY) !== null);

  return (
    <>
      <header className="kla-grain border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "flex flex-col gap-6 py-8 sm:py-12 lg:py-10")}>
          <div className="max-w-3xl lg:max-w-none">
            <PlatformNumber code="STU">Intent Studio</PlatformNumber>
            <h1 className="mt-5 text-balance font-display text-[clamp(2.3rem,6.2vw,4.25rem)] font-bold leading-[1] tracking-[-0.045em] lg:text-[3.25rem]">
              Write a route and see its legs.
            </h1>
            <p className={cx("mt-4 max-w-2xl text-base leading-relaxed sm:text-lg lg:mt-3 lg:max-w-3xl lg:text-base", TEXT_MUTED)}>
              Studio sends your sentence to <code className="font-code text-[0.9em]">POST /v1/intents?dryRun=true</code> and draws
              the plan that comes back. Nothing is signed or stored until you run it in the console with your own wallets.
            </p>
            {resumable ? (
              <div
                role="status"
                className={cx("kl-rise mt-6 flex flex-col gap-3 bg-[#FFF3B0] p-4 text-[#1A1A1A] sm:flex-row sm:items-center sm:justify-between", INK_BORDER, HARD_SHADOW)}
              >
                <p className="flex items-center gap-2 text-sm font-bold">
                  <History className="h-4 w-4 shrink-0" aria-hidden="true" />
                  This tab was running an intent before it reloaded. The console picks it up where it stopped.
                </p>
                <DeskLink to={DESK_ENTRY} className={buttonClasses("ink", "sm", "shrink-0")}>
                  Pick it up in the console
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </DeskLink>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <div className={cx(CONTAINER, "flex flex-col gap-12 py-8 sm:py-12 lg:py-10")}>
        <StudioWorkspace
          initialText={initialText}
          renderActions={(intent) => <RunInConsole intent={intent} />}
          executionNote={
            <p>
              <strong>A dry run plans and quotes.</strong> Running it in the console plans again with the wallets you
              connect and asks before every signature.
            </p>
          }
        />
      </div>
    </>
  );
}
