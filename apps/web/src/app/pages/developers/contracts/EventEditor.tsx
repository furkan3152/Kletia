import { abiItemSignature, type AbiEventItem } from "@kletia/core";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "../../../site/ui/Button";
import { SelectField, TextField } from "../../../site/ui/Field";
import { cx, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { WHERE_SOURCES } from "./abi";
import type { EventDraft, EvmEntryDraft } from "./contractModel";

export interface EventEditorProps {
  readonly entry: EvmEntryDraft;
  readonly events: readonly AbiEventItem[];
  readonly labels: readonly string[];
  readonly index: number;
  readonly issues: readonly { path: string; message: string }[];
  readonly onChange: (entry: EvmEntryDraft) => void;
}

function emptyEvent(event: AbiEventItem | undefined): EventDraft {
  const where: Record<string, string> = {};
  for (const input of event?.inputs ?? []) if (input.name) where[input.name] = "";
  return { event: event ? abiItemSignature(event) : "", emitter: "$self", where, output: "" };
}

/**
 * The proof of success: 1 to 3 events the landed call must emit from a
 * pinned address, with at least one field bound to the user so an
 * unrelated emission never counts.
 */
export function EventEditor({ entry, events, labels, index, issues, onChange }: EventEditorProps) {
  const at = `actions[${index}].events`;
  const setEvents = (next: readonly EventDraft[]) => onChange({ ...entry, events: next });
  const eventOptions = events.map((event) => ({ value: abiItemSignature(event), label: abiItemSignature(event) }));
  const errors = issues.filter((issue) => issue.path.startsWith(at));
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {events.length === 0 ? (
        <p className="border-l-[6px] border-[#B91C1C] bg-[#FFE4E4] px-3 py-2 text-sm text-[#1A1A1A]">
          The ABI has no (non-anonymous) event. Add the event your function emits to the ABI in step 2: Kletia needs one to prove success.
        </p>
      ) : null}
      {entry.events.map((draft, eventIndex) => {
        const item = events.find((event) => abiItemSignature(event) === draft.event);
        const update = (patch: Partial<EventDraft>) => setEvents(entry.events.map((current, position) => (position === eventIndex ? { ...current, ...patch } : current)));
        return (
          <div key={eventIndex} className={cx("flex min-w-0 flex-col gap-4 p-3 sm:p-4", INK_BORDER_THIN)}>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              <SelectField
                label="Event"
                value={draft.event}
                onChange={(event) => {
                  const next = events.find((candidate) => abiItemSignature(candidate) === event.target.value);
                  update({ ...emptyEvent(next), emitter: draft.emitter });
                }}
                options={[{ value: "", label: "Choose…" }, ...eventOptions]}
              />
              <SelectField
                label="Emitted by"
                value={draft.emitter}
                onChange={(event) => update({ emitter: event.target.value })}
                options={[{ value: "$self", label: "This contract" }, ...labels.map((label) => ({ value: label, label: `Other contract "${label}"` }))]}
                hint="A proxy's logs carry the proxy address."
              />
            </div>
            {item ? (
              <fieldset className="flex min-w-0 flex-col gap-2">
                <legend className={cx(LABEL, "mb-1 !text-[10px]")}>Fields that must match</legend>
                {item.inputs.map((input) => {
                  const name = input.name ?? "";
                  if (!name) return null;
                  const value = draft.where[name] ?? "";
                  const literal = value.startsWith("literal:");
                  return (
                    <div key={name} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:items-center">
                      <p className="min-w-0 break-words font-code text-[12.5px] font-bold">
                        {name} <span className={cx("font-normal", TEXT_MUTED)}>{input.type}{input.indexed ? " indexed" : ""}</span>
                      </p>
                      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                        <SelectField
                          label={`${name} must be`}
                          value={literal ? "literal" : value}
                          onChange={(event) => update({ where: { ...draft.where, [name]: event.target.value === "literal" ? "literal:" : event.target.value } })}
                          options={[{ value: "", label: "Not checked" }, ...WHERE_SOURCES, { value: "literal", label: "A fixed value" }]}
                        />
                        {literal ? (
                          <TextField
                            label="Fixed value"
                            mono
                            value={value.slice("literal:".length)}
                            onChange={(event) => update({ where: { ...draft.where, [name]: `literal:${event.target.value}` } })}
                          />
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                <SelectField
                  label="Field that reports the output amount (optional)"
                  value={draft.output}
                  onChange={(event) => update({ output: event.target.value })}
                  options={[{ value: "", label: "None" }, ...item.inputs.filter((input) => input.name && /^u?int/u.test(input.type)).map((input) => ({ value: input.name!, label: input.name! }))]}
                  hint="Needs a declared output token; must equal what the user is credited."
                />
              </fieldset>
            ) : null}
            <Button size="sm" variant="ghost" className="self-start" onClick={() => setEvents(entry.events.filter((_, position) => position !== eventIndex))}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Remove this event
            </Button>
          </div>
        );
      })}
      {errors.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {errors.map((issue, position) => (
            <li key={`${issue.path}-${position}`} className="text-xs font-bold text-[#B91C1C] dark:text-[#FCA5A5]">
              {issue.path.replace(`actions[${index}].`, "")}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {entry.events.length < 3 && events.length > 0 ? (
        <Button size="sm" variant="secondary" className="self-start" onClick={() => setEvents([...entry.events, emptyEvent(events[0])])}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {entry.events.length === 0 ? "Add the proof event" : "Add another event"}
        </Button>
      ) : null}
    </div>
  );
}
