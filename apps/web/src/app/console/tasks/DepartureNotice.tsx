/**
 * The ticket's departure line: plain when the plan departs where the user
 * asked (or where Kletia picked), and a yellow notice when it departs
 * elsewhere ("This plan starts on Solana, not Base.", or the sentence named
 * another network), with its action ("Change", "Start from Base instead").
 */
import type { ReactNode } from "react";

import type { DepartureLine } from "../state/deskModel";

export function DepartureNotice({ line, action }: { readonly line: DepartureLine; readonly action?: ReactNode }) {
  if (line.tone === "notice") {
    return (
      <p
        role="note"
        data-departure-line="notice"
        className="mt-3 flex flex-wrap items-center gap-2 border-2 border-[#121212] bg-[#C6FF3A] px-2 py-1.5 text-sm font-bold text-[#121212]"
      >
        <span>{line.text}</span>
        {action}
      </p>
    );
  }
  return (
    <p data-departure-line="plain" className="mt-3 flex flex-wrap items-center gap-2 text-sm font-bold">
      <span>{line.text}</span>
      {action}
    </p>
  );
}
