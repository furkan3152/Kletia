import { ArrowRight } from "lucide-react";

import { Link } from "../../../routes/Link";
import { EMBED_ATTRIBUTES, EMBED_EVENTS, RECIPES } from "../../../site/snippets";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { DataTable } from "../../../site/ui/DataTable";
import { cx, FOCUS_RING, TEXT_MUTED } from "../../../site/ui/styles";
import { PortalPageHeader } from "../shell/PortalPageHeader";

const ELEMENT = RECIPES.find((recipe) => recipe.id === "web-component");
const LINK = cx("inline-flex min-h-10 items-center gap-1.5 font-bold underline decoration-2 underline-offset-4", FOCUS_RING);

/**
 * Embed builder (`/developers/embed`, alias `/developers/embed-builder`).
 * Until the builder lands here, the page is the `<kletia-intent>` element's
 * reference: the snippet, its attributes and the events it reports. The
 * key in memory is never read on this page.
 */
export default function EmbedBuilderView() {
  return (
    <div className="mx-auto w-full max-w-[1040px]">
      <PortalPageHeader
        title="Embed builder"
        intro="Put the Kletia widget on any page with one script and one element. It frames the hosted widget, your visitors sign in their own wallets, and it reports progress to your page as DOM events."
      />
      <div className="flex min-w-0 flex-col gap-10">
        {ELEMENT ? (
          <section aria-labelledby="embed-snippet" className="flex min-w-0 flex-col gap-4">
            <h2 id="embed-snippet" className="font-display text-display-s font-bold">
              {ELEMENT.title}
            </h2>
            <p className={cx("max-w-3xl text-body", TEXT_MUTED)}>{ELEMENT.summary}</p>
            <CodeBlock
              label="The kletia-intent element"
              tabs={ELEMENT.files.map((file) => ({ id: file.id, label: file.label, language: file.language, code: file.code, filename: file.filename }))}
            />
            {ELEMENT.notes.length > 0 ? (
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
                {ELEMENT.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
        <section aria-labelledby="embed-attributes" className="flex min-w-0 flex-col gap-4">
          <h2 id="embed-attributes" className="font-display text-display-s font-bold">
            Attributes
          </h2>
          <DataTable
            caption="Attributes of the kletia-intent element"
            rows={EMBED_ATTRIBUTES}
            rowKey={(row) => row.name}
            columns={[
              { key: "name", header: "Attribute", phone: "primary", cell: (row) => <code className="whitespace-nowrap font-code font-bold">{row.name}</code> },
              { key: "values", header: "Values", cell: (row) => <span className="break-words font-code text-xs">{row.values}</span> },
              { key: "description", header: "What it does", cell: (row) => row.description },
            ]}
          />
        </section>
        <section aria-labelledby="embed-events" className="flex min-w-0 flex-col gap-4">
          <h2 id="embed-events" className="font-display text-display-s font-bold">
            Events
          </h2>
          <DataTable
            caption="DOM events of the kletia-intent element"
            rows={EMBED_EVENTS}
            rowKey={(row) => row.name}
            columns={[
              { key: "name", header: "Event", phone: "primary", cell: (row) => <code className="whitespace-nowrap font-code font-bold">{row.name}</code> },
              { key: "detail", header: "Detail", cell: (row) => <span className="break-words font-code text-xs">{row.detail}</span> },
              { key: "description", header: "When", cell: (row) => row.description },
            ]}
          />
        </section>
        <p className={cx("flex flex-wrap gap-x-6 text-sm", TEXT_MUTED)}>
          <Link to="/developers/recipes/react-widget" className={LINK}>
            React widget recipe
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <Link to="/developers/recipes/iframe" className={LINK}>
            Plain iframe recipe
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </p>
      </div>
    </div>
  );
}
