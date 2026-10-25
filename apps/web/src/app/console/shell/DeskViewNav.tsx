/**
 * The desk's navigation (round 9, state/deskNav.ts). Under 1024 px a sticky
 * bar of the six sections (Desk, Tasks, Portfolio, Trade, Automate, More),
 * one row that fits a 360 px phone; from 1024 px the header carries the same
 * sections. A section with more than one view (Portfolio, Trade, More) shows
 * its views as sub-tabs at the top of the main column, at every width.
 */
import { cx, FOCUS_RING } from "../../site/ui/styles";
import { DESK_COPY } from "../content/copy";
import type { DeskView } from "../state/deskModel";
import { PHONE_SECTIONS, sectionOf, siblingViews, type DeskSection } from "../state/deskNav";

const copy = DESK_COPY.header;

export interface DeskViewNavProps {
  readonly view: DeskView;
  readonly onSection: (section: DeskSection) => void;
  readonly taskCount: number;
}

export function DeskViewNav({ view, onSection, taskCount }: DeskViewNavProps) {
  const current = sectionOf(view);
  return (
    <nav aria-label={copy.viewNavLabel} className="kd-viewnav">
      <ul className="flex h-full w-full min-w-max items-stretch">
        {PHONE_SECTIONS.map((section) => (
          <li key={section} className="flex flex-1">
            <button
              type="button"
              aria-current={current === section ? "page" : undefined}
              onClick={() => onSection(section)}
              className={cx(
                "kd-viewnav-tab relative inline-flex min-h-11 w-full items-center justify-center whitespace-nowrap px-1.5 text-xs font-extrabold text-muted aria-[current=page]:text-fg",
                "focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-focus",
              )}
            >
              {section === "tasks" ? copy.tasksView(taskCount) : copy.sections[section]}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The views of the current section as sub-tabs; nothing for a section of one view. */
export function DeskSubNav({ view, onView }: { readonly view: DeskView; readonly onView: (view: DeskView) => void }) {
  const views = siblingViews(view);
  if (views.length < 2) return null;
  return (
    <nav aria-label={copy.subNavLabel(copy.sections[sectionOf(view)])} className="kd-subnav">
      <ul className="flex flex-wrap gap-2">
        {views.map((entry) => (
          <li key={entry}>
            <button
              type="button"
              aria-current={view === entry ? "page" : undefined}
              onClick={() => onView(entry)}
              className={cx(
                "inline-flex min-h-11 items-center border-[3px] border-control bg-surface px-4 text-xs font-black uppercase tracking-[0.12em] text-fg hover:bg-neutral-bg aria-[current=page]:bg-[#121212] aria-[current=page]:text-white dark:aria-[current=page]:bg-white dark:aria-[current=page]:text-[#0E0E10]",
                FOCUS_RING,
              )}
            >
              {copy.views[entry]}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
