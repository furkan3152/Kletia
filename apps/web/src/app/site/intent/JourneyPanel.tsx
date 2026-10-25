import "../art/journey.css";

import { Fragment, useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import type { Journey } from "@kletia/core";
import { ClarifyCard, SeverityMark } from "@kletia/widget";
import { journeyModel, journeyPromptView, type JourneyModel, type JourneyNoticeView } from "@kletia/widget/review";

import { CertaintyGlyph, JourneyMap } from "../art/JourneyMap";
import { isOverdue, journeyAnnouncement, whereMoneyIs } from "../art/journeyFormat";
import { cx, LABEL, TEXT_MUTED } from "../ui/styles";

/**
 * Where the money is after every step, and what follows: the JourneyMap
 * plus its signage. Notices carry a road sign (shape and word, never
 * colour alone); the one prompt to ask next is a question card (through
 * `journeyPromptView`), with every option a real button; the rest folds
 * under "More about this route". Once the journey is over, or waits for a
 * decision, "Where your money is now" leads.
 *
 * Journey prompts render here and only here: the desk's question slot
 * carries clarify questions. One open card per task: while a clarify
 * question is open (`holdPrompt`), the prompt waits.
 */

export type JourneyPanelPhase = "review" | "live" | "after" | "indicative";

export interface JourneyPanelProps {
  readonly journey: Journey;
  /** Valid answers by consequence id → option id (`validJourneyAnswers`). */
  readonly answered?: Readonly<Record<string, string>>;
  /** The user picked an option of a prompt; absent on read-only (indicative) itineraries. */
  readonly onAnswer?: (consequenceId: string, optionId: string) => void;
  readonly phase: JourneyPanelPhase;
  /** A clarify question is open on the same task: the prompt waits. */
  readonly holdPrompt?: boolean;
  readonly busy?: boolean;
  /** The option being sent (pressed, others disabled). */
  readonly pending?: string | null;
  /** Focus target of "focus the first open blocker" (the prompt, else the first blocking notice). */
  readonly blockerRef?: Ref<HTMLDivElement>;
  /** Heading level of the panel title (stops get the next level). Default 3. */
  readonly headingLevel?: 2 | 3 | 4;
  /** Print "Where your money is now" (off when the host's outcome card already says it). */
  readonly showOutcome?: boolean;
  readonly className?: string;
}

function Sign({ notice }: { readonly notice: JourneyNoticeView }) {
  return (
    <span className="kla-sign" data-tone={notice.sign.tone}>
      <SeverityMark shape={notice.sign.shape} />
      <span aria-hidden="true">{notice.sign.word}</span>
      <span className="kla-sr">{notice.sign.spoken}: </span>
    </span>
  );
}

function Notice({ notice }: { readonly notice: JourneyNoticeView }) {
  const links = notice.options.filter((option) => option.url);
  return (
    <div className="kla-jnotice" role="note" data-severity={notice.severity}>
      <p className="kla-jnotice__title">
        <Sign notice={notice} />
        <span>{notice.title}</span>
      </p>
      {notice.detail ? <p className="kla-jnotice__detail">{notice.detail}</p> : null}
      {notice.answer ? <p className="kla-jnotice__answer">Your answer: {notice.answer}</p> : null}
      {links.map((option) => (
        <a key={option.id} className="kla-link" href={option.url!} target="_blank" rel="noopener noreferrer">
          {option.label}
          <span className="kla-sr"> (opens in a new tab)</span>
        </a>
      ))}
      {notice.source ? <p className="kla-jnotice__source">{notice.source}</p> : null}
    </div>
  );
}

/** Seconds left on the leg in transit, ticking locally between journey reads (never polled). */
function useTransitClock(journey: Journey, model: JourneyModel, live: boolean): { readonly remaining: number | null; readonly overdue: boolean } {
  const transit = journey.stops.find((stop) => stop.kind === "transit" && stop.state === "current");
  const remainingAtRead = transit?.eta?.remainingSeconds ?? null;
  const readAt = Date.parse(journey.computedAt);
  const moving = live && remainingAtRead !== null && Number.isFinite(readAt) && model.stage === "live";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!moving) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [moving]);
  if (!moving || remainingAtRead === null) return { remaining: null, overdue: false };
  const elapsed = Math.max(0, (now - readAt) / 1000);
  return { remaining: Math.max(0, Math.round(remainingAtRead - elapsed)), overdue: isOverdue(readAt, Math.max(1, remainingAtRead), now) };
}

export function JourneyPanel({
  journey,
  answered = {},
  onAnswer,
  phase,
  holdPrompt = false,
  busy = false,
  pending = null,
  blockerRef,
  headingLevel = 3,
  showOutcome = true,
  className,
}: JourneyPanelProps) {
  const headingId = useId();
  const model = useMemo(() => journeyModel(journey, { answered }), [journey, answered]);
  const money = useMemo(() => whereMoneyIs(journey, model), [journey, model]);
  const live = phase === "live";
  const clock = useTransitClock(journey, model, live);

  // Arrivals and new blockers are announced once, politely; the first render says nothing.
  const previous = useRef<JourneyModel | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (live) {
      const said = journeyAnnouncement(previous.current, model, journey);
      if (said) setAnnouncement(said);
    }
    previous.current = model;
  }, [journey, live, model]);

  const readOnly = !onAnswer || phase === "indicative";
  const promptId = readOnly || holdPrompt ? null : model.prompts[0] ?? null;
  const consequence = promptId ? journey.consequences.find((entry) => entry.id === promptId) ?? null : null;
  const view = consequence ? journeyPromptView(consequence) : null;
  // The notice beside the card already prints the sign, title, detail and facts.
  const card = view ? { ...view, why: undefined, note: undefined } : null;
  const expanded = model.notices.expanded;
  const folded = model.notices.folded.filter((notice) => notice.id !== card?.id);
  const firstBlocker = card ? null : model.blockers[0]?.id ?? null;
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const stopLevel = Math.min(5, headingLevel + 1) as 3 | 4 | 5;

  const promptCard = card ? (
    <div ref={blockerRef} tabIndex={-1} className="kla-qcard focus:outline-none" data-kind="journey">
      <ClarifyCard
        question={card}
        pending={pending}
        disabled={busy}
        dismissible={false}
        onAnswer={(answer) => {
          if ("optionId" in answer) onAnswer?.(card.id, answer.optionId);
        }}
        onDismiss={() => undefined}
      />
    </div>
  ) : null;
  const promptPlaced = card !== null && expanded.some((notice) => notice.id === card.id);

  return (
    <section
      aria-labelledby={headingId}
      className={cx("flex min-w-0 flex-col gap-4", className)}
      data-journey-phase={phase}
      data-stage={model.stage}
    >
      {live ? (
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
      ) : null}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Heading id={headingId} className={cx(LABEL, "!text-[12px]")}>
          {phase === "indicative" ? "Indicative itinerary" : model.header.title}
        </Heading>
        <span className={cx("font-code text-xs", TEXT_MUTED)}>{model.header.line}</span>
      </div>
      {phase === "indicative" ? (
        <p className={cx("text-sm", TEXT_MUTED)}>
          Planned for a stand-in account: Kletia reads your own balances when you plan with your wallet, and asks about anything that
          would stop a later leg before you sign.
        </p>
      ) : null}

      {showOutcome && money.length > 0 ? (
        <div className="kla-jnotice" role="note" data-outcome="">
          <p className="kla-jnotice__title">{model.outcome?.title}</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {money.map((line) => (
              <li key={`${line.stopId}-${line.sentence}`} className="flex flex-wrap items-center gap-x-2 font-code text-sm font-bold">
                <CertaintyGlyph certainty={line.certainty} />
                <span className="kla-sr">{line.spoken}: </span>
                <span>{line.sentence}</span>
                {line.accountShort ? (
                  <span className="font-normal" title={line.account ?? undefined}>
                    {line.accountShort}
                  </span>
                ) : null}
                {line.usd ? <span className="font-normal">≈ {line.usd}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <JourneyMap
        model={model}
        live={live}
        overdue={clock.overdue}
        remainingSeconds={clock.remaining}
        headingLevel={stopLevel}
      />
      {/* Reduced motion: the marker is static and the line says where it is. */}
      <p className="text-sm font-semibold">{model.nowLine}</p>

      {expanded.map((notice) => (
        <Fragment key={notice.id}>
          {notice.id === firstBlocker ? (
            <div ref={blockerRef} tabIndex={-1} className="focus:outline-none">
              <Notice notice={notice} />
            </div>
          ) : (
            <Notice notice={notice} />
          )}
          {notice.id === card?.id ? promptCard : null}
        </Fragment>
      ))}
      {promptPlaced ? null : promptCard}
      {folded.length > 0 ? (
        <details className="kl-details border-[3px] border-dashed border-[#121212]/30 dark:border-white/15">
          <summary className={cx("flex min-h-11 cursor-pointer items-center gap-2 px-3", LABEL)}>More about this route ({folded.length})</summary>
          <div className="flex flex-col gap-3 px-3 pb-3">
            {folded.map((notice) => (
              <Notice key={notice.id} notice={notice} />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
