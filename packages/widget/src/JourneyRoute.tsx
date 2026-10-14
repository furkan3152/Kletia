import { Fragment, useId, type Ref } from "react";
import { CHAINS, type Journey, type JourneyCertainty } from "@kletia/core";
import { ClarifyCard } from "./ClarifyCard.js";
import {
  JOURNEY_CERTAINTY_INFO,
  journeyModel,
  journeyPromptView,
  type JourneyNoticeView,
  type JourneyStopView,
  type SeverityShape,
} from "./review.js";

export interface JourneyRouteProps {
  readonly journey: Journey;
  /** Answers to the journey's prompts by consequence id → option id (`validJourneyAnswers`). */
  readonly answered: Readonly<Record<string, string>>;
  /** The user picked an option of a prompt. */
  readonly onAnswer: (consequenceId: string, optionId: string) => void;
  /** A clarify question is open: the journey's prompt waits (one open card per task). */
  readonly holdPrompt?: boolean;
  /** Disables the prompt while the host is busy. */
  readonly busy?: boolean;
  /** The prompt answer in flight (an option id). */
  readonly pending?: string | null;
  /** Focus target for "focus the first open blocker". */
  readonly promptRef?: Ref<HTMLDivElement>;
  /** Move focus to the prompt when it appears (never while the user types). */
  readonly autoFocusPrompt?: boolean;
}

/** Certainty glyphs of the fare plus a filled square for `observed`; decorative (the words are read). */
export function JourneyGlyph({ certainty }: { readonly certainty: JourneyCertainty }) {
  const shape = JOURNEY_CERTAINTY_INFO[certainty]?.shape ?? "dashed";
  return (
    <svg className="kw-glyph" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {shape === "square" ? <rect x="1.5" y="1.5" width="9" height="9" fill="currentColor" /> : null}
      {shape === "dot" ? <circle cx="6" cy="6" r="4.5" fill="currentColor" /> : null}
      {shape === "half" ? (
        <>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.75a4.25 4.25 0 0 1 0 8.5z" fill="currentColor" />
        </>
      ) : null}
      {shape === "ring" ? <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}
      {shape === "diamond" ? <path d="M6 1.2 10.8 6 6 10.8 1.2 6z" fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}
      {shape === "dashed" ? <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.6" /> : null}
    </svg>
  );
}

/** Severity shape (octagon, diamond, triangle, circle); always printed with its word. */
export function SeverityMark({ shape }: { readonly shape: SeverityShape }) {
  return (
    <svg className="kw-sev-mark" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {shape === "octagon" ? <path d="M3.9 1h4.2L11 3.9v4.2L8.1 11H3.9L1 8.1V3.9z" fill="currentColor" /> : null}
      {shape === "diamond" ? <path d="M6 .8 11.2 6 6 11.2.8 6z" fill="currentColor" /> : null}
      {shape === "triangle" ? <path d="M6 1 11.4 10.8H.6z" fill="currentColor" /> : null}
      {shape === "circle" ? <circle cx="6" cy="6" r="5" fill="currentColor" /> : null}
    </svg>
  );
}

function Notice({ notice }: { readonly notice: JourneyNoticeView }) {
  const links = notice.options.filter((option) => option.url);
  return (
    <div className="kw-jr-notice" role="note" data-severity={notice.severity}>
      <p className="kw-jr-notice-title">
        <span className="kw-sev" data-severity={notice.severity}>
          <SeverityMark shape={notice.sign.shape} />
          <span aria-hidden="true">{notice.sign.word}</span>
          <span className="kw-sr">{notice.sign.spoken}: </span>
        </span>
        {notice.title}
      </p>
      {notice.detail ? <p className="kw-jr-notice-detail">{notice.detail}</p> : null}
      {notice.answer ? <p className="kw-jr-answer">Your answer: {notice.answer}</p> : null}
      {links.map((option) => (
        <a key={option.id} className="kw-link" href={option.url!} target="_blank" rel="noreferrer noopener">
          {option.label}
        </a>
      ))}
      {notice.source ? <p className="kw-jr-source">{notice.source}</p> : null}
    </div>
  );
}

function Stop({ stop }: { readonly stop: JourneyStopView }) {
  const chain = CHAINS[stop.network];
  return (
    <li className="kw-jr-stop" data-state={stop.state} data-here={stop.here ? "true" : undefined} data-kind={stop.kind}>
      <span className="kw-jr-ring" style={{ borderColor: chain?.color }} aria-hidden="true" />
      <div className="kw-jr-body">
        <h5 className="kw-jr-stop-h">
          <span className="kw-sr">{stop.heading}</span>
          <span aria-hidden="true">
            <span className="kw-jr-kind">{stop.kindLabel}</span> · {stop.networkName} · {stop.holderLabel}
          </span>
        </h5>
        {stop.accountShort ? (
          <span className="kw-jr-acct" title={stop.account ?? undefined} aria-hidden="true">
            {stop.accountShort}
          </span>
        ) : null}
        {stop.holdings.map((holding, index) => (
          <div key={`${holding.symbol}-${index}`} className="kw-jr-hold" aria-hidden="true">
            <span className="kw-jr-amt" title={holding.certaintyInfo.sentence}>
              <JourneyGlyph certainty={holding.certainty} /> {holding.expected}
              {holding.atLeast ? <span className="kw-muted"> expected</span> : null}
            </span>
            {holding.atLeast ? <span className="kw-plate kw-jr-plate">At least {holding.atLeast}</span> : null}
            <span className="kw-jr-usd">{holding.usd ? `${holding.usd} (${holding.usdSource})` : "price unavailable"}</span>
            {holding.roleText ? <span className="kw-jr-role">{holding.roleText}</span> : null}
            {holding.identity ? <span className="kw-jr-role">{holding.identity}</span> : null}
            {holding.basis ? <span className="kw-jr-role">{holding.basis}</span> : null}
          </div>
        ))}
        <span className="kw-jr-custody" aria-hidden="true">
          {stop.custodyLabel}
          {stop.eta ? ` · ${stop.eta}` : ""}
          {stop.reachedAt ? ` · reached ${stop.reachedAt}` : ""}
        </span>
        {stop.here ? <span className="kw-jr-here">You are here</span> : null}
        {stop.evidenceUrl ? (
          <a className="kw-link" href={stop.evidenceUrl} target="_blank" rel="noreferrer noopener">
            View on explorer
          </a>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The journey in the widget (journey 9.2-9.4, `kw-journey` slot): a vertical
 * route of stops (where the money is, who holds it, how much, how sure) with
 * the legs between them, the notices by severity (the rest folded under
 * "More about this route"), the one prompt to ask next as a question card,
 * and, once it is over, where the money is now. Not hideable by appearance.
 */
export function JourneyRoute(props: JourneyRouteProps) {
  const { journey, answered, onAnswer, holdPrompt = false, busy = false, pending = null, promptRef, autoFocusPrompt = false } = props;
  const headingId = useId();
  const model = journeyModel(journey, { answered });
  const promptId = holdPrompt ? null : model.prompts[0] ?? null;
  const consequence = promptId ? journey.consequences.find((entry) => entry.id === promptId) ?? null : null;
  const view = consequence ? journeyPromptView(consequence) : null;
  // The notice above the card already prints the sign, title, detail and facts.
  const card = view ? { ...view, why: undefined, note: undefined } : null;
  const expanded = model.notices.expanded;
  const folded = model.notices.folded.filter((notice) => notice.id !== card?.id);
  const promptCard = card ? (
    <div ref={promptRef} tabIndex={-1} className="kw-jr-prompt">
      <ClarifyCard
        question={card}
        pending={pending}
        disabled={busy}
        autoFocus={autoFocusPrompt}
        dismissible={false}
        onAnswer={(answer) => {
          if ("optionId" in answer) onAnswer(card.id, answer.optionId);
        }}
        onDismiss={() => undefined}
      />
    </div>
  ) : null;
  // A prompt of a folded notice (rare: an act past the first three) is shown on its own, before the fold.
  const promptPlaced = card !== null && expanded.some((notice) => notice.id === card.id);
  return (
    // Not a live region: the widget announces new blockers once; the route itself is read on demand.
    <section className="kw-journey" aria-labelledby={headingId} aria-live="off" data-stage={model.stage}>
      <div className="kw-jr-head">
        <h4 className="kw-jr-title" id={headingId}>
          {model.header.title}
        </h4>
        <span className="kw-jr-line">{model.header.line}</span>
      </div>
      {model.outcome && model.outcome.lines.length > 0 ? (
        <div className="kw-jr-outcome" role="note">
          <p className="kw-jr-outcome-title">{model.outcome.title}</p>
          <ul className="kw-jr-outcome-list">
            {model.outcome.lines.map((line, index) => (
              <li key={`${line.stopId}-${index}`}>
                <JourneyGlyph certainty={line.certainty} /> <span className="kw-sr">{line.certaintyInfo.spoken}: </span>
                {line.sentence}
                {line.usd ? ` · ${line.usd}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ol className="kw-jr-route">
        {model.route.map((item) =>
          item.type === "stop" ? (
            <Stop key={`stop-${item.stop.id}`} stop={item.stop} />
          ) : (
            <li key={`leg-${item.leg.id}`} className="kw-jr-leg" data-cross={item.leg.crossNetwork ? "true" : undefined}>
              <span className="kw-jr-track" aria-hidden="true" />
              <div className="kw-jr-body">
                <p className="kw-jr-leg-line">
                  <span className="kw-sr">Leg {item.leg.number}: </span>
                  {item.leg.line}
                  {item.leg.status ? <span className="kw-jr-status"> · {item.leg.status}</span> : null}
                </p>
                {item.leg.failure ? <p className="kw-jr-fail">{item.leg.failure}</p> : null}
                {item.leg.refund ? <p className="kw-jr-role">Refund: {item.leg.refund}</p> : null}
                {item.leg.gasTopup ? <p className="kw-jr-role">{item.leg.gasTopup}</p> : null}
                {item.leg.tracking ? (
                  <a className="kw-link" href={item.leg.tracking.url} target="_blank" rel="noreferrer noopener">
                    {item.leg.tracking.label}
                  </a>
                ) : null}
              </div>
            </li>
          ),
        )}
      </ol>
      <p className="kw-jr-now">{model.nowLine}</p>
      {expanded.map((notice) => (
        <Fragment key={notice.id}>
          <Notice notice={notice} />
          {notice.id === card?.id ? promptCard : null}
        </Fragment>
      ))}
      {promptPlaced ? null : promptCard}
      {folded.length > 0 ? (
        <details className="kw-jr-more">
          <summary>More about this route ({folded.length})</summary>
          {folded.map((notice) => (
            <Notice key={notice.id} notice={notice} />
          ))}
        </details>
      ) : null}
    </section>
  );
}

export default JourneyRoute;
