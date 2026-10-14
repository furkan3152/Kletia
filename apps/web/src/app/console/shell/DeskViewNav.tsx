/** Views of the desk under 1024 px (console design 3.2): Desk, Tasks, Holdings, Tools, Activity; sticky, scrolls sideways. */
import { DESK_COPY } from "../content/copy";
import type { DeskView } from "../state/deskModel";

const copy = DESK_COPY.header;
const VIEWS: readonly DeskView[] = ["desk", "tasks", "holdings", "tools", "activity"];

export function DeskViewNav({ view, onView, taskCount }: { readonly view: DeskView; readonly onView: (view: DeskView) => void; readonly taskCount: number }) {
  return (
    <nav aria-label={copy.viewNavLabel} className="kd-viewnav">
      <ul className="flex h-full min-w-max items-stretch px-2">
        {VIEWS.map((entry) => (
          <li key={entry} className="flex">
            <button
              type="button"
              aria-current={view === entry ? "page" : undefined}
              onClick={() => onView(entry)}
              className="inline-flex min-h-11 items-center px-3 text-xs font-black uppercase tracking-[0.12em] text-fg focus-visible:outline focus-visible:outline-4 focus-visible:-outline-offset-4 focus-visible:outline-[var(--kl-focus)] aria-[current=page]:underline aria-[current=page]:decoration-[3px] aria-[current=page]:underline-offset-8"
            >
              {entry === "tasks" ? copy.tasksView(taskCount) : copy.views[entry]}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
