/**
 * Views of the desk under 1024 px: Desk, Tasks, Holdings, Tools,
 * Holdings, Tools, Activity, Dashboard ("Data"), Automations ("Automate"); sticky.
 * The views share the width; the nav itself scrolls sideways when they do not
 * fit (narrow phones, larger text settings), never the page.
 */
import { DESK_COPY } from "../content/copy";
import type { DeskView } from "../state/deskModel";

const copy = DESK_COPY.header;
const VIEWS: readonly DeskView[] = ["desk", "tasks", "holdings", "tools", "activity", "dashboard", "automations"];

export function DeskViewNav({ view, onView, taskCount }: { readonly view: DeskView; readonly onView: (view: DeskView) => void; readonly taskCount: number }) {
  return (
    <nav aria-label={copy.viewNavLabel} className="kd-viewnav">
      <ul className="flex h-full w-full min-w-max items-stretch px-1">
        {VIEWS.map((entry) => (
          <li key={entry} className="flex flex-1">
            <button
              type="button"
              aria-current={view === entry ? "page" : undefined}
              onClick={() => onView(entry)}
              className="inline-flex min-h-11 w-full items-center justify-center whitespace-nowrap px-1.5 text-[11px] font-black uppercase tracking-[0.06em] text-fg sm:px-3 sm:text-xs sm:tracking-[0.12em] focus-visible:outline focus-visible:outline-4 focus-visible:-outline-offset-4 focus-visible:outline-[var(--kl-focus)] aria-[current=page]:underline aria-[current=page]:decoration-[3px] aria-[current=page]:underline-offset-8"
            >
              {entry === "tasks" ? copy.tasksView(taskCount) : copy.viewNavShort[entry] ?? copy.views[entry]}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
