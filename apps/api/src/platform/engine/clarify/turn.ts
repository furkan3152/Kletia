/**
 * The thread reducer: one turn (a message, an answer, a chip change, or
 * nothing) applied to the working state, then the policy. Controls first
 * ("cancel", "undo"), then an answer to an open question, then a follow-up
 * edit or appended step, else a new sentence that replaces the task (undo
 * keeps the old one).
 *
 * Pure and synchronous over (thread, input, context, facts). Refusals throw
 * PlatformError and leave the given state untouched (the reducer works on a
 * copy). Turn labels are Kletia's own words, never the user's message.
 */
import {
  CONFIRM_NO_PATTERN,
  CONFIRM_YES_PATTERN,
  CONTROL_CANCEL_PATTERN,
  CONTROL_UNDO_PATTERN,
  normalizeMessage,
  THREAD_LIMITS,
  type ThreadAmount,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { NAME, resolveNetworkName } from "../grammar.js";
import { knownSymbol } from "./catalog.js";
import { applyEdit, applyEditTo, editLabel, parseIndex, readFollowUp } from "./edits.js";
import { analyze } from "./policy.js";
import { parseAmountText, parseSentence } from "./slots.js";
import type { Analysis, FactsView, Option, Question, TurnContext, TurnInput, TurnKindName, WorkState, WorkStep } from "./types.js";

const ADDRESS = new RegExp(`^(?:0x[0-9a-fA-F]{40}|(?:eip155|solana):\\S+|${NAME}|[1-9A-HJ-NP-Za-km-z]{32,44})$`, "iu");

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function emptyState(id: string): WorkState {
  return { id, rev: 0, status: "needs_input", steps: [], open: [], corrections: [], turns: [], undo: [] };
}

export interface ReduceOutcome {
  readonly status: "ready" | "needs_input" | "cancelled";
  readonly turn: TurnKindName;
  readonly state: WorkState;
  readonly analysis: Analysis;
}

function editUnsupported(message: string): PlatformError {
  return new PlatformError("EDIT_UNSUPPORTED", message, 422, [{ path: "text", message: "Not a change Kletia can apply to this task." }]);
}

function answerInvalid(message: string, path = "answer"): PlatformError {
  return new PlatformError("ANSWER_INVALID", message, 422, [{ path, message: "Does not fit the question." }]);
}

function questionNotOpen(): PlatformError {
  return new PlatformError("QUESTION_NOT_OPEN", "That question is not open any more. Read the thread again and answer one of its open questions.", 409, [
    { path: "answer.question", message: "Not an open question of this thread." },
  ]);
}

/** Applies a chosen option to the slot it belongs to (questions and chips). */
export function applyOption(state: WorkState, q: { field: string; reason?: string }, option: Option): void {
  if (q.reason === "EDIT_TARGET_AMBIGUOUS") {
    const edit = state.pendingEdit;
    delete state.pendingEdit;
    if (edit && option.value.target) applyEditTo(state, edit, option.value.target);
    return;
  }
  const { index, name } = parseIndex(q.field);
  const step = state.steps[index] as WorkStep;
  const value = option.value;
  if (q.reason === "FUNDS_ELSEWHERE" && value.network && value.source) {
    const bridge: WorkStep = {
      kind: { v: "bridge", by: "answer" },
      ...(step.amount ? { amount: clone(step.amount) } : {}),
      ...(step.from ? { from: clone(step.from) } : {}),
      network: { v: value.source, by: "answer" },
      toNetwork: { v: value.network, by: "answer" },
    };
    step.network = { v: value.network, by: "answer" };
    step.amount = { v: { t: "previous", bps: 10_000 }, by: "answer" };
    state.steps.splice(index, 0, bridge);
    return;
  }
  if (q.reason === "NETWORK_HANDOFF" && value.network) {
    // The payment becomes one bridge leg that pays the recipient where they receive (departure rules).
    const previous = state.steps[index - 1] as WorkStep | undefined;
    const prevDest = previous?.kind?.v === "bridge" ? previous.toNetwork?.v : previous?.network?.v;
    step.kind = { v: "bridge", by: "answer" };
    if (prevDest) step.network = { v: prevDest, by: "derived" };
    step.toNetwork = { v: value.network, by: "answer" };
    return;
  }
  if (value.network) {
    if (name === "toNetwork") step.toNetwork = { v: value.network, by: "answer" };
    else step.network = { v: value.network, by: "answer" };
  }
  if (value.asset) {
    if (name === "to") {
      step.to = { v: value.asset, by: "answer" };
      step.usdTo = false;
    } else {
      step.from = { v: value.asset, by: "answer" };
      step.usdFrom = false;
    }
  }
  if (value.amount) step.amount = { v: value.amount, by: "answer" };
  if (value.recipient) {
    step.recipient = { v: value.recipient, by: "answer" };
    delete step.nickname;
  }
  if (value.protocol) step.protocol = { v: value.protocol, by: "answer" };
  if (value.venue) step.vault = { v: value.venue, by: "answer" };
  if (value.provider) step.provider = { v: value.provider, by: "answer" };
  if (value.kind) step.kind = { v: value.kind, by: "answer" };
}

function amountAnswer(text: string, step: WorkStep): ThreadAmount | null {
  const match = /^(?<amt>\$?\d[\d,]*(?:\.\d+)?|\.\d+|\d{1,3}(?:\.\d{1,2})?%|all|max|everything|half)(?:\s+(?<unit>[a-z][a-z0-9]{1,9}))?$/iu.exec(text);
  if (!match?.groups?.amt) return null;
  const unit = match.groups.unit;
  if (unit && step.from && unit.toUpperCase() !== step.from.v.toUpperCase()) return null;
  let amount: ThreadAmount & { usd?: boolean };
  try {
    amount = parseAmountText(match.groups.amt, false);
  } catch {
    return null;
  }
  const { usd: _usd, ...plain } = amount;
  if (step.kind?.v === "withdraw" && plain.t === "balance") return { t: "position", bps: plain.bps };
  return plain;
}

/** Free text as the answer to one question; false when it does not fit. */
function answerQuestionText(state: WorkState, q: Question, raw: string): boolean {
  const text = normalizeMessage(raw)
    .replace(/^(?:make\s+it|actually|about|use|send\s+(?:it\s+)?to|to|from|on|via|with|its|it\s+is)\s+/iu, "")
    .replace(/\s+instead$/iu, "")
    .trim();
  if (!text) return false;
  if (q.kind === "confirm" && CONFIRM_YES_PATTERN.test(text) && q.options[0]) {
    applyOption(state, q, q.options[0]);
    return true;
  }
  const lower = text.toLowerCase();
  const byOption = q.options.find((option) =>
    option.id.toLowerCase() === lower || option.label.toLowerCase() === lower ||
    (option.value.network !== undefined && resolveNetworkName(text) === option.value.network) ||
    (option.value.asset !== undefined && option.value.asset.toLowerCase() === lower));
  if (byOption) {
    applyOption(state, q, byOption);
    return true;
  }
  const { index } = parseIndex(q.field);
  const step = state.steps[index] as WorkStep | undefined;
  if (!step) return false;
  if (q.kind === "amount") {
    const amount = amountAnswer(text, step);
    if (!amount) return false;
    step.amount = { v: amount, by: "answer" };
    return true;
  }
  if (q.kind === "address") {
    if (!ADDRESS.test(text)) return false;
    step.recipient = { v: text, by: "answer" };
    delete step.nickname;
    if (step.network?.by === "assumed") delete step.network;
    return true;
  }
  if (q.kind === "choice" && q.allowsText) {
    const network = resolveNetworkName(text);
    if (network && /network/iu.test(q.field.split(".").pop() ?? "")) {
      applyOption(state, q, { id: network, label: network, value: { network } });
      return true;
    }
    if ((q.field.endsWith(".to") || q.field.endsWith(".from")) && /^[A-Za-z][\w.-]{1,15}$/u.test(text) && knownSymbol(text)) {
      applyOption(state, q, { id: text, label: text, value: { asset: text } });
      return true;
    }
  }
  return false;
}

/** A message while questions are open: does it answer one of them? */
function answerFromText(state: WorkState, analysis: Analysis, text: string): boolean {
  for (const q of analysis.questions) {
    const trial = clone(state);
    if (answerQuestionText(trial, q, text)) {
      answerQuestionText(state, q, text);
      return true;
    }
  }
  return false;
}

function pushTurn(state: WorkState, role: "user" | "kletia", kind: string, label: string): void {
  state.turns = [...state.turns, { role, kind, label: label.slice(0, 160) }].slice(-THREAD_LIMITS.storedTurns);
}

function snapshot(state: WorkState, before: WorkStep[]): void {
  if (before.length > 0) state.undo = [...state.undo, clone(before)].slice(-THREAD_LIMITS.undoSnapshots);
}

/**
 * Applies one turn to a copy of `previous` and analyses the result. Throws
 * PlatformError (INTENT_UNSUPPORTED, EDIT_UNSUPPORTED, QUESTION_NOT_OPEN,
 * ANSWER_INVALID and the policy's refusals) without touching `previous`.
 */
export function reduceTurn(previous: WorkState | null, input: TurnInput, ctx: TurnContext, facts: FactsView, newId: () => string): ReduceOutcome {
  const state = previous ? clone(previous) : emptyState(newId());
  const before = clone(state.steps);
  let turn: TurnKindName = "message";
  if ("text" in input) {
    const text = normalizeMessage(input.text);
    let label = "Started the task";
    if (previous && CONTROL_CANCEL_PATTERN.test(text)) {
      state.status = "cancelled";
      state.open = [];
      delete state.pendingEdit;
      state.rev += 1;
      pushTurn(state, "user", "control", "Cancelled the task");
      return { status: "cancelled", turn: "control", state, analysis: { questions: [], assumptions: [], resolved: null } };
    }
    if (previous && CONTROL_UNDO_PATTERN.test(text)) {
      const last = state.undo.pop();
      if (!last) throw editUnsupported("There is nothing to undo.");
      state.steps = last;
      state.corrections = [];
      delete state.pendingEdit;
      turn = "control";
      label = "Undid the last change";
    } else if (previous && previous.open.length > 0 && answerFromText(state, analyze(clone(state), ctx, facts), input.text)) {
      snapshot(state, before);
      turn = "answer";
      label = "Answered the open question";
    } else if (previous && state.steps.length > 0 && (CONFIRM_YES_PATTERN.test(text) || CONFIRM_NO_PATTERN.test(text))) {
      throw editUnsupported("There is nothing to confirm right now.");
    } else {
      const edit = previous && state.steps.length > 0 ? readFollowUp(input.text) : null;
      if (edit === "unsupported") throw editUnsupported("Say the new amount, for example \"make it 50\".");
      if (edit) {
        snapshot(state, before);
        delete state.pendingEdit;
        if (edit.op === "append") {
          const added = parseSentence(edit.text, ctx.contracts, true, state.steps.length).steps;
          if (state.steps.length + added.length > THREAD_LIMITS.maxSteps) throw editUnsupported(`A task has at most ${THREAD_LIMITS.maxSteps} steps.`);
          state.steps = [...state.steps, ...added];
          turn = "append";
        } else {
          if (!applyEdit(state, edit)) throw editUnsupported("That change does not fit this task.");
          turn = "edit";
        }
        label = editLabel(edit);
      } else {
        let parsed;
        try {
          parsed = parseSentence(input.text, ctx.contracts);
        } catch (error) {
          // On a task, a message that is neither a follow-up nor a sentence changes nothing (R11).
          if (previous && state.steps.length > 0 && error instanceof PlatformError && error.code === "INTENT_UNSUPPORTED") {
            throw editUnsupported("Kletia could not read that change. Say it like \"make it 50\" or \"from arbitrum instead\", or send a complete new sentence.");
          }
          throw error;
        }
        if (previous && state.steps.length > 0) {
          snapshot(state, before);
          turn = "replace";
          label = "Replaced the task with a new sentence";
        }
        state.steps = parsed.steps;
        state.corrections = parsed.corrections;
        delete state.pendingEdit;
      }
    }
    pushTurn(state, "user", turn, label);
  } else if ("answer" in input) {
    if (!previous) throw questionNotOpen();
    const open = analyze(clone(state), ctx, facts);
    const q = open.questions.find((entry) => entry.id === input.answer.question);
    if (!q || !previous.open.includes(q.field)) throw questionNotOpen();
    let label = "Answered the open question";
    if (input.answer.option !== undefined) {
      const option = q.options.find((entry) => entry.id === input.answer.option);
      if (!option) throw answerInvalid("That option is not one of the question's choices.", "answer.option");
      applyOption(state, q, option);
      label = `Chose: ${option.label}`;
    } else if (input.answer.text === undefined || !answerQuestionText(state, q, input.answer.text)) {
      throw answerInvalid(q.allowsText ? "That answer does not fit the question." : "Pick one of the question's options.", "answer.text");
    }
    snapshot(state, before);
    turn = "answer";
    pushTurn(state, "user", "answer", label);
  } else if ("assumption" in input) {
    if (!previous) throw answerInvalid("There is no assumption to change.", "assumption");
    const current = analyze(clone(state), ctx, facts);
    const chip = current.assumptions.find((entry) => entry.id === input.assumption.id);
    const option = chip?.alternatives.find((entry) => entry.id === input.assumption.option);
    if (!chip || !option) throw answerInvalid("That assumption or alternative is not offered on this thread.", "assumption");
    applyOption(state, { field: chip.field }, option);
    snapshot(state, before);
    turn = "answer";
    pushTurn(state, "user", "answer", `Changed: ${chip.label} to ${option.label}`);
  } else {
    if (!previous) throw new PlatformError("INVALID_REQUEST", "A first turn needs text.", 400, [{ path: "text", message: "Required." }]);
    turn = "none";
  }
  state.rev += 1;
  const analysis = analyze(state, ctx, facts);
  state.open = analysis.questions.map((entry) => entry.field);
  state.status = analysis.questions.length > 0 ? "needs_input" : "ready";
  pushTurn(state, "kletia", state.status === "ready" ? "plan" : "question", state.status === "ready" ? "Ready to plan" : analysis.questions[0]?.prompt ?? "Asked a question");
  return { status: state.status, turn, state, analysis };
}
