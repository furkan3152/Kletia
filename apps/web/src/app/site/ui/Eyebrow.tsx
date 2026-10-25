import "./ui.css";

import type { ReactNode } from "react";

import { MachineWindow } from "../../kit";

/**
 * A page or section eyebrow in the Card machine language: an engraved label with a lime
 * lamp, sentence case. It replaces the transit "platform number" signs on the site's pages.
 */
export function Eyebrow({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <span className={className ? `ku-eyebrow ${className}` : "ku-eyebrow"}>{children}</span>;
}

/**
 * The no-service scene (404, a dead link, an unknown receipt): the machine's printer window
 * jammed, and an empty card slot with the code. Decorative: the page's heading says what happened.
 */
export function NoServiceScene({ code, caption = "Paper jam · nothing to print" }: { readonly code: string; readonly caption?: string }) {
  return (
    <div className="ku-scene" aria-hidden="true">
      <MachineWindow state="jam" caption={caption} />
      <div className="ku-scene-slot">
        <div className="ku-scene-card">
          <div className="ku-scene-band">
            <span>No card</span>
            <span className="ku-scene-serial">#{code}</span>
          </div>
          <b className="ku-scene-code">{code}</b>
          <span className="ku-scene-rule" />
          <span className="ku-scene-rule ku-scene-rule--short" />
        </div>
      </div>
    </div>
  );
}
