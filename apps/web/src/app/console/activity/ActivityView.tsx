/**
 * Activity: the shared, persisted activity feed of every network, as a
 * full view and as the rail's short peek (the last five).
 */
import { ActivityFeed } from "../../../shared/sync/ActivityFeed";
import { DESK_COPY } from "../content/copy";
import { ViewHeader } from "../shell/ViewParts";

const copy = { ...DESK_COPY.activity, intro: "Every transaction this browser sent, on every network: pending, confirmed or failed, newest first. It lives in this browser only." } as const;

export function ActivityView() {
  return (
    <section aria-labelledby="desk-activity-heading" className="flex flex-col gap-6 pb-8">
      <ViewHeader id="desk-activity-heading" title={copy.title} intro={copy.intro} />
      <div className="kv-panel">
        <ActivityFeed compact limit={50} title={copy.title} emptyHint={copy.empty} />
      </div>
    </section>
  );
}

export function ActivityPeek({ onOpenAll }: { readonly onOpenAll: () => void }) {
  return (
    <section aria-label={copy.peekLabel} className="k-mod">
      <h2 className="k-eng">{copy.title}</h2>
      <ActivityFeed compact limit={5} title={copy.peekLabel} emptyHint={copy.empty} />
      <button
        type="button"
        onClick={onOpenAll}
        className="k-linkbtn justify-self-start"
      >
        {copy.all}
      </button>
    </section>
  );
}
