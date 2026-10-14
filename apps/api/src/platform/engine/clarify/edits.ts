/**
 * Follow-ups on a task that already has steps (R11): the core follow-up
 * grammar (`parseFollowUp`, shared with the composer) reads the
 * message, this module decides which slot it changes. An edit whose
 * target is ambiguous waits in `thread.pendingEdit` behind an
 * EDIT_TARGET_AMBIGUOUS question.
 */
import { AMBIGUOUS_VENUE_WORDS, parseFollowUp, type FollowUp } from "@kletia/core";
import { family, networkName, recipientFamily, isUsdWord } from "./catalog.js";
import { question } from "./copy.js";
import type { EditOp, Question, WorkState, WorkStep } from "./types.js";

export const field = (index: number, name: string) => `actions[${index}].${name}`;

export function parseIndex(path: string): { index: number; name: string } {
  const match = /^actions\[(\d+)\]\.(\w+)$/u.exec(path);
  return match ? { index: Number(match[1]), name: match[2] as string } : { index: 0, name: path };
}

/** The message as an edit, "append" text, "unsupported" (a recognised but unsupported edit), or null. */
export function readFollowUp(message: string): EditOp | { op: "append"; text: string } | "unsupported" | null {
  const followUp: FollowUp | "unsupported" | null = parseFollowUp(message);
  if (followUp === null || followUp === "unsupported") return followUp;
  switch (followUp.op) {
    case "append":
      return { op: "append", text: followUp.text };
    case "amount":
      return { op: "amount", amount: followUp.amount, ...(followUp.unit ? { unit: followUp.unit } : {}) };
    case "network":
      return { op: "network", dir: followUp.dir, network: followUp.network };
    case "recipient":
      return { op: "recipient", recipient: followUp.recipient };
    case "asset":
      return { op: "asset", symbol: followUp.symbol };
    case "provider":
      return { op: "provider", provider: followUp.provider };
    case "venue": {
      const protocol = Object.hasOwn(AMBIGUOUS_VENUE_WORDS, followUp.word) ? followUp.word : followUp.protocol;
      return followUp.role === "bridge" ? { op: "bridgeVenue", protocol } : followUp.role === "lending" ? { op: "lending", protocol } : { op: "dex", protocol };
    }
  }
}

function amountText(edit: Extract<EditOp, { op: "amount" }>): string {
  const amount = edit.amount;
  if (amount.t === "exact") return amount.value;
  if (amount.t === "usd") return `$${amount.value}`;
  return amount.bps === 10_000 ? "all" : `${amount.bps / 100}%`;
}

/** Kletia's own description of an edit, stored in the thread instead of the user's words. */
export function editLabel(edit: EditOp | { op: "append" }): string {
  switch (edit.op) {
    case "amount":
      return `Changed the amount to ${amountText(edit)}${edit.unit ? ` ${edit.unit.toUpperCase()}` : ""}`.slice(0, 160);
    case "network":
      return `${edit.dir === "from" ? "Changed where it starts to" : edit.dir === "to" ? "Changed where it arrives to" : "Moved it to"} ${networkName(edit.network)}`;
    case "recipient":
      return `Changed the recipient to ${edit.recipient.length > 20 ? `${edit.recipient.slice(0, 6)}…${edit.recipient.slice(-4)}` : edit.recipient}`;
    case "asset":
      return `Changed the token to ${edit.symbol.toUpperCase().slice(0, 16)}`;
    case "provider":
      return `Changed the staking provider to ${edit.provider}`;
    case "bridgeVenue":
      return `Pinned the bridge to ${edit.protocol}`;
    case "lending":
    case "dex":
      return `Changed the venue to ${edit.protocol}`;
    case "append":
      return "Added a step";
  }
}

/** Slot paths an edit may change ("append" for a recipient on a task without a transfer). */
export function editTargets(state: WorkState, edit: EditOp): string[] {
  const indexed = state.steps.map((step, index) => ({ step, index }));
  switch (edit.op) {
    case "amount":
      return indexed.filter(({ step }) => step.amount === undefined || step.amount.v.t !== "previous").map(({ index }) => field(index, "amount"));
    case "network": {
      const bridges = indexed.filter(({ step }) => step.kind?.v === "bridge");
      if (edit.dir === "from") return [field(bridges[0]?.index ?? 0, "network")];
      if (edit.dir === "to") {
        if (bridges.length > 0) return [field(bridges[bridges.length - 1]!.index, "toNetwork")];
        return state.steps[0]?.kind?.v === "swap" ? [field(0, "toNetwork")] : [];
      }
      if (bridges.length > 0) {
        const { step, index } = bridges[0]!;
        const out: string[] = [];
        if (step.network?.v !== edit.network) out.push(field(index, "network"));
        if (step.toNetwork?.v !== edit.network) out.push(field(index, "toNetwork"));
        return out;
      }
      return [field(0, "network")];
    }
    case "recipient": {
      const transfers = indexed.filter(({ step }) => step.kind?.v === "transfer" || (step.kind?.v === "bridge" && step.recipient));
      return transfers.length > 0 ? [field(transfers[transfers.length - 1]!.index, "recipient")] : ["append"];
    }
    case "asset": {
      const swaps = indexed.filter(({ step }) => step.kind?.v === "swap" || (step.kind?.v === "bridge" && step.to));
      return swaps.length > 0 ? [field(swaps[swaps.length - 1]!.index, "to")] : [];
    }
    case "provider":
      return indexed.filter(({ step }) => step.kind?.v === "stake").map(({ index }) => field(index, "provider")).slice(-1);
    case "bridgeVenue":
      return indexed.filter(({ step }) => step.kind?.v === "bridge").map(({ index }) => field(index, "protocol")).slice(0, 1);
    case "lending":
      return indexed.filter(({ step }) => step.kind?.v === "deposit" || step.kind?.v === "withdraw").map(({ index }) => field(index, "protocol")).slice(-1);
    case "dex":
      return indexed.filter(({ step }) => step.kind?.v === "swap").map(({ index }) => field(index, "protocol")).slice(-1);
  }
}

export function applyEditTo(state: WorkState, edit: EditOp, target: string): void {
  if (target === "append" && edit.op === "recipient") {
    state.steps.push({ kind: { v: "transfer", by: "user" }, amount: { v: { t: "previous", bps: 10_000 }, by: "user" }, recipient: { v: edit.recipient, by: "user" } });
    return;
  }
  const { index, name } = parseIndex(target);
  const step = state.steps[index] as WorkStep;
  switch (edit.op) {
    case "amount":
      step.amount = { v: edit.amount, by: "user" };
      return;
    case "network":
      if (name === "toNetwork" && step.kind?.v === "swap") step.kind = { v: "bridge", by: "user" };
      if (name === "toNetwork") step.toNetwork = { v: edit.network, by: "user" };
      else step.network = { v: edit.network, by: "user" };
      return;
    case "recipient": {
      step.recipient = { v: edit.recipient, by: "user" };
      delete step.nickname;
      const kind = recipientFamily(edit.recipient);
      // The network stays when the user said it and it still fits the new recipient (R0).
      if (step.kind?.v === "transfer" && step.network && (step.network.by === "assumed" || (kind && kind !== "caip" && kind !== family(step.network.v)))) delete step.network;
      return;
    }
    case "asset":
      step.to = { v: edit.symbol, by: "user" };
      step.usdTo = isUsdWord(edit.symbol);
      return;
    case "provider":
      step.provider = { v: edit.provider, by: "user" };
      return;
    case "bridgeVenue":
    case "lending":
    case "dex":
      step.protocol = { v: edit.protocol, by: "user" };
      delete step.vault;
      return;
  }
}

/** Applies an edit, or parks it behind EDIT_TARGET_AMBIGUOUS; false when nothing in the task fits it. */
export function applyEdit(state: WorkState, edit: EditOp): boolean {
  const targets = editTargets(state, edit);
  if (targets.length === 0) return false;
  if (targets.length > 1) {
    state.pendingEdit = edit;
    return true;
  }
  applyEditTo(state, edit, targets[0] as string);
  return true;
}

function stepPhrase(step: WorkStep): string {
  const amount = step.amount?.v;
  const value = amount?.t === "exact" ? ` ${amount.value}` : "";
  return `${step.kind?.v ?? "step"}${value}${step.from ? ` ${step.from.v}` : ""}`;
}

/** R11: the open question for an edit whose target is ambiguous. */
export function pendingEditQuestion(state: WorkState): Question | null {
  const edit = state.pendingEdit;
  if (!edit) return null;
  const network = edit.op === "network" ? edit.network : undefined;
  const options = editTargets(state, edit).map((target) => {
    const { index, name } = parseIndex(target);
    const step = state.steps[index] as WorkStep;
    const label = name === "amount" ? `Step ${index + 1}: ${stepPhrase(step)}`
      : name === "network" ? `From ${network ? networkName(network) : "?"} (where it starts)`
        : name === "toNetwork" ? `To ${network ? networkName(network) : "?"} (where it arrives)` : `Step ${index + 1}`;
    return { id: target, label, value: { target } };
  });
  return question("edit", "choice", "EDIT_TARGET_AMBIGUOUS", "Which part should change?", "The change could apply to more than one place in this task.", options, false);
}
