/**
 * Views of the desk under 1024 px (console design 3.2): Desk, Tasks,
 * Holdings, Tools, Orders, Activity; sticky. The six share the width, so all of
 * them fit a 360 px phone without scrolling (it still scrolls sideways if a
 * larger text setting needs it).
 */
import { DESK_COPY } from "../content/copy";
import type { DeskView } from "../state/deskModel";

const copy = DESK_COPY.header;
const VIEWS: readonly DeskView[] = ["desk", "tasks", "holdings", "tools", "orders", "activity"];

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
              {entry === "tasks" ? copy.tasksView(taskCount) : copy.views[entry]}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
