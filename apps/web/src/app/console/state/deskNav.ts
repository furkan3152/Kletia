/**
 * The desk's information architecture (round 9): the nine views are grouped
 * into six sections, so the nav stays one readable row on a 360 px phone.
 *
 *   Desk        desk
 *   Tasks       tasks            (phones and tablets; the rail shows it wider)
 *   Portfolio   dashboard, history, holdings
 *   Trade       perps, orders, predictions (Predict)
 *   Automate    automations
 *   More        tools, activity
 *
 * Views keep their own paths (/app/dashboard, /app/orders ...): a section is
 * only a group of views, so every old link and "show my ..." command opens
 * the same view as before, now inside its section. No React here: node --test
 * loads it.
 */
import type { DeskView } from "./deskModel.ts";

export type DeskSection = "desk" | "tasks" | "portfolio" | "trade" | "automate" | "more";

/** Each section's views, the first one is where the section opens. */
export const DESK_SECTION_VIEWS: Readonly<Record<DeskSection, readonly DeskView[]>> = Object.freeze({
  desk: ["desk"],
  tasks: ["tasks"],
  portfolio: ["dashboard", "history", "holdings"],
  trade: ["perps", "orders", "predictions"],
  automate: ["automations"],
  more: ["tools", "activity"],
});

/** The view nav under 1024 px: every section. */
export const PHONE_SECTIONS: readonly DeskSection[] = Object.freeze(["desk", "tasks", "portfolio", "trade", "automate", "more"]);

/** The header nav from 1024 px: Tasks is the rail (1280 px) or the header's popover instead. */
export const WIDE_SECTIONS: readonly DeskSection[] = Object.freeze(PHONE_SECTIONS.filter((section) => section !== "tasks"));

/** The last view opened in each section, so a section reopens where the user left it. */
export type SectionMemory = Readonly<Partial<Record<DeskSection, DeskView>>>;

export function sectionOf(view: DeskView): DeskSection {
  for (const section of PHONE_SECTIONS) if (DESK_SECTION_VIEWS[section].includes(view)) return section;
  return "desk";
}

/** The views beside this one in its section (itself included); one entry means no sub-tabs. */
export function siblingViews(view: DeskView): readonly DeskView[] {
  return DESK_SECTION_VIEWS[sectionOf(view)];
}

/** The view a section tab opens: the current view when already there, else the remembered one, else the first. */
export function sectionTarget(section: DeskSection, current: DeskView, memory: SectionMemory = {}): DeskView {
  const views = DESK_SECTION_VIEWS[section];
  if (views.includes(current)) return current;
  const remembered = memory[section];
  return remembered && views.includes(remembered) ? remembered : views[0]!;
}

export function rememberView(memory: SectionMemory, view: DeskView): SectionMemory {
  const section = sectionOf(view);
  return memory[section] === view ? memory : { ...memory, [section]: view };
}
