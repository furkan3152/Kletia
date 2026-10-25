/**
 * The desk's question slot: the task's one open clarify question as
 * `ClarifyCard`, inline under its ticket (no modal), four chips then
 * "Other…" (every network for network questions), free text in the card or
 * through the composer's Answering chip, Esc or "Not now" to leave it for
 * later. The chosen chip stays pressed with "Sending…" until the task's
 * next turn answers (the task card remounts the slot for every answer
 * Kletia gives, so a refusal frees it).
 *
 * Clarify questions only: journey prompts render once, inside the journey
 * panel. Registered as the desk's Question slot (`registerSlots.ts`).
 */
import "../../site/art/journey.css";

import { useState } from "react";
import { ClarifyCard } from "@kletia/widget";

import { Button } from "../../site/ui/Button";
import { DESK_COPY } from "../content/copy";
import { OTHER_OPTION_ID, questionCard } from "./questionModel";
import type { QuestionSlotProps } from "./slots";

export function QuestionSlot({ question, onAnswer, onDismiss, onAskAgain }: QuestionSlotProps) {
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const [pendingFor, setPendingFor] = useState<{ readonly question: string; readonly answer: string } | null>(null);
  const expanded = expandedFor === question.id;
  const pending = pendingFor?.question === question.id ? pendingFor.answer : null;
  const card = questionCard(question, expanded);

  return (
    <div className="kla-qcard" data-kind="clarify" data-question-id={question.id}>
      {question.expired ? (
        <div role="status" className="mb-2 flex flex-wrap items-center gap-3 border-l-4 border-[var(--kl-warning)] bg-[var(--kl-warning-bg)] px-3 py-2 text-sm font-bold text-fg">
          <span>{DESK_COPY.tasks.questionExpired}</span>
          {onAskAgain ? (
            <Button size="sm" onClick={onAskAgain}>
              {DESK_COPY.tasks.askAgain}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ClarifyCard
        question={card}
        pending={pending}
        disabled={question.expired === true}
        autoFocus={!question.expired}
        onAnswer={(answer) => {
          if ("optionId" in answer && answer.optionId === OTHER_OPTION_ID) {
            setExpandedFor(question.id);
            return;
          }
          setPendingFor({ question: question.id, answer: "optionId" in answer ? answer.optionId : "text" });
          if ("optionId" in answer) {
            const options = [...card.options, ...(card.questions ?? []).flatMap((entry) => entry.options)];
            const label = options.find((option) => option.id === answer.optionId)?.label;
            onAnswer({ optionId: answer.optionId, ...(answer.questionId ? { questionId: answer.questionId } : {}), ...(label ? { label } : {}) });
          } else {
            onAnswer({ text: answer.text, ...(answer.questionId ? { questionId: answer.questionId } : {}) });
          }
        }}
        onDismiss={onDismiss}
      />
    </div>
  );
}
