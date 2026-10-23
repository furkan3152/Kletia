/**
 * The consent card on an eligible refusal: "Read once", "Allow for this
 * session" (typed desk text only), "Rewrite it" and "Show what is sent".
 * Nothing is sent before the person chooses.
 */
import { useState } from "react";

import { Button } from "../../site/ui/Button";
import { READING_COPY, type ReadingPreference } from "./modelReading";

export interface ModelReadingCardProps {
  readonly busy: boolean;
  /** Session consent is offered only for text the person typed in the desk input. */
  readonly typed: boolean;
  readonly onRead: (scope: "once" | "session") => void;
  readonly onRewrite: () => void;
}

export function ModelReadingCard({ busy, typed, onRead, onRewrite }: ModelReadingCardProps) {
  const [showSent, setShowSent] = useState(false);
  return (
    <section aria-label={READING_COPY.cardTitle} className="flex flex-col gap-2 border-l-4 border-[var(--kl-info,var(--kl-warning))] px-3 py-2 text-sm text-fg">
      <p className="font-bold">{READING_COPY.cardTitle}</p>
      <p>{READING_COPY.cardBody}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={() => onRead("once")}>
          {READING_COPY.readOnce}
        </Button>
        {typed ? (
          <Button type="button" disabled={busy} onClick={() => onRead("session")}>
            {READING_COPY.allowSession}
          </Button>
        ) : null}
        <Button type="button" disabled={busy} onClick={onRewrite}>
          {READING_COPY.rewrite}
        </Button>
        <button type="button" className="underline underline-offset-2" aria-expanded={showSent} onClick={() => setShowSent((open) => !open)}>
          {READING_COPY.showSent}
        </button>
      </div>
      {showSent ? <p className="text-fg-muted">{READING_COPY.sentNote}</p> : null}
    </section>
  );
}

/** The desk setting: Off / Ask each time / On for this session. */
export function ModelReadingSetting({ value, onChange }: { readonly value: ReadingPreference; readonly onChange: (value: ReadingPreference) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span>{READING_COPY.settingsLabel}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as ReadingPreference)}>
        {(Object.keys(READING_COPY.settings) as ReadingPreference[]).map((key) => (
          <option key={key} value={key}>
            {READING_COPY.settings[key]}
          </option>
        ))}
      </select>
    </label>
  );
}
