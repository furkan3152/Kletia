/**
 * A section's views as sub-tabs (state/deskNav.ts): Portfolio, Trade and More show
 * their views at the top of the main column, at every width, as segmented keys. The sections
 * themselves are the machine's mode dial (shell/machine).
 */
import { Segmented } from "../../kit";
import { DESK_COPY } from "../content/copy";
import type { DeskView } from "../state/deskModel";
import { sectionOf, siblingViews } from "../state/deskNav";

const copy = DESK_COPY.header;

/** The views of the current section as sub-tabs; nothing for a section of one view. */
export function DeskSubNav({ view, onView }: { readonly view: DeskView; readonly onView: (view: DeskView) => void }) {
  const views = siblingViews(view);
  if (views.length < 2) return null;
  return (
    <div className="kd-subnav">
      <Segmented mode="page" ariaLabel={copy.subNavLabel(copy.sections[sectionOf(view)])} value={view} onChange={onView} options={views.map((entry) => ({ id: entry, label: copy.views[entry] }))} />
    </div>
  );
}
