/**
 * Activity: the shared, persisted activity feed of every network, as a
 * full view and as the rail's short peek (the last five).
 */
import { ActivityFeed } from "../../../shared/sync/ActivityFeed";
import { DESK_COPY } from "../content/copy";
import { ViewHeader } from "../shell/ViewParts";

const copy = DESK_COPY.activity;

export function ActivityView() {
  return (
    <section aria-labelledby="desk-activity-heading" className="flex flex-col gap-4 pb-8">
      <ViewHeader id="desk-activity-heading" title={copy.title} />
      <ActivityFeed compact limit={50} title={copy.title} emptyHint={copy.empty} />
    </section>
  );
}

export function ActivityPeek({ onOpenAll }: { readonly onOpenAll: () => void }) {
  return (
    <section aria-label={copy.peekLabel} className="flex flex-col gap-3">
      <h2 className="text-xs font-black uppercase tracking-[0.16em] text-muted">{copy.title}</h2>
      <ActivityFeed compact limit={5} title={copy.peekLabel} emptyHint={copy.empty} />
      <button
        type="button"
        onClick={onOpenAll}
        className="inline-flex min-h-11 items-center self-start text-xs font-black uppercase tracking-wider text-[var(--kl-accent-text)] underline underline-offset-4 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]"
      >
        {copy.all}
      </button>
    </section>
  );
}
