import React from "react";

import { Link } from "../../../routes/Link";
import { EVENT_ENVELOPE, SSE_SNIPPET, WEBHOOK_REGISTER, WEBHOOK_VERIFY } from "../../../site/snippets";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { DataTable } from "../../../site/ui/DataTable";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { DELIVERY_HEADERS, EVENT_FAMILIES, EVENT_TYPES } from "../devContent";
import { PortalPageHeader } from "../shell/PortalPageHeader";

const LINK = cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING);

type EventRow = (typeof EVENT_TYPES)[number];
type FamilyRow = (typeof EVENT_FAMILIES)[number];

/** Events (`/developers/events`): intent events, the other families, delivery headers, retries and the verify code. */
export default function EventsPage() {
  return (
    <>
      <PortalPageHeader
        title="Events"
        intro="Follow an intent live over Server-Sent Events, or register a webhook, send it a signed test and read its delivery log. Rule Book, key, contract and link events go to the owning key's webhooks."
      />
      <div className="grid min-w-0 gap-10">
        <section aria-labelledby="intent-events" className="flex min-w-0 flex-col gap-4">
          <h2 id="intent-events" className="font-display text-display-s font-bold">
            Intent events
          </h2>
          <DataTable<EventRow>
            caption="Intent events"
            columns={[
              { key: "type", header: "Type", phone: "primary", cell: (row) => <code className="break-all font-code text-code font-bold text-accent-text">{row.type}</code> },
              { key: "when", header: "Sent when", cell: (row) => row.description },
              { key: "data", header: "data", cell: (row) => <span className="break-words font-code text-code-s">{row.fields}</span> },
            ]}
            rows={EVENT_TYPES}
            rowKey={(row) => row.type}
          />
          <p className={cx("max-w-3xl text-sm", TEXT_MUTED)}>
            Journeys need no event of their own: fetch <code className="font-code">GET /v1/intents/{"{id}"}/journey</code> when{" "}
            <code className="font-code">intent.step_updated</code> or <code className="font-code">intent.status_changed</code> arrives. Stopping an
            intent sends <code className="font-code">step_updated</code> (skipped) and <code className="font-code">status_changed</code>.{" "}
            <Link to="/developers/recipes/journey" className={LINK}>
              Journey recipe
            </Link>
            .
          </p>
        </section>

        <section aria-labelledby="event-families" className="flex min-w-0 flex-col gap-4">
          <h2 id="event-families" className="font-display text-display-s font-bold">
            Other event families
          </h2>
          <DataTable<FamilyRow>
            caption="Event families beyond intents"
            columns={[
              { key: "family", header: "Family", phone: "primary", cell: (row) => <span className="font-bold">{row.title}</span> },
              {
                key: "types",
                header: "Types",
                cell: (row) => (
                  <span className="flex min-w-0 flex-wrap gap-1.5">
                    {row.types.map((type) => (
                      <code key={type} className="border-2 border-line px-1.5 py-0.5 font-code text-code-s font-bold text-accent-text">
                        {type}
                      </code>
                    ))}
                  </span>
                ),
              },
              {
                key: "note",
                header: "data and notes",
                cell: (row) => (
                  <span className="flex flex-col gap-1">
                    <span className="break-words font-code text-code-s">{row.fields}</span>
                    <span className={TEXT_MUTED}>{row.note}</span>
                  </span>
                ),
              },
            ]}
            rows={EVENT_FAMILIES}
            rowKey={(row) => row.title}
          />
          <p className={cx("max-w-3xl text-sm", TEXT_MUTED)}>
            A webhook created without <code className="font-code">events</code> gets the types that existed when it was created; list new types
            explicitly, or create the webhook with <code className="font-code">{'"scope": "subtree"'}</code> to also hear a key&apos;s agent keys.
          </p>
        </section>

        <section aria-labelledby="delivery-headers" className={cx("flex min-w-0 flex-col gap-3 p-4 sm:p-5", INK_BORDER, SURFACE)}>
          <h2 id="delivery-headers" className={LABEL}>
            Delivery headers
          </h2>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[13rem_minmax(0,1fr)]">
            {DELIVERY_HEADERS.map((header) => (
              <React.Fragment key={header.name}>
                <dt className="font-code font-bold">{header.name}</dt>
                <dd className="min-w-0 break-words font-code text-code-s">{header.description}</dd>
              </React.Fragment>
            ))}
          </dl>
          <p className="text-sm">
            POST to public HTTPS URLs only, retried up to 3 times (1 s, 5 s, 25 s), redirects never followed. Reject signatures older than your
            tolerance (default 300 s) and de-duplicate by event id.
          </p>
        </section>

        <div className="grid min-w-0 gap-6 xl:grid-cols-2">
          <CodeBlock code={WEBHOOK_VERIFY} language="ts" label="Verify a webhook" filename="app/api/kletia/webhook/route.ts" />
          <CodeBlock code={WEBHOOK_REGISTER} language="ts" label="Register and test a webhook" filename="webhooks.ts" />
          <CodeBlock code={SSE_SNIPPET} language="ts" label="Stream events" filename="stream.ts" />
          <CodeBlock code={EVENT_ENVELOPE} language="json" label="Event envelope" filename="event.json" />
        </div>
        <p className={cx("text-sm", TEXT_MUTED)}>
          Your endpoints are on{" "}
          <Link to="/developers/webhooks" className={LINK}>
            Webhooks
          </Link>
          . More servers in the recipes:{" "}
          <Link to="/developers/recipes/nextjs" className={LINK}>
            Next.js
          </Link>
          ,{" "}
          <Link to="/developers/recipes/express" className={LINK}>
            Express
          </Link>{" "}
          and{" "}
          <Link to="/developers/recipes/hono" className={LINK}>
            Hono
          </Link>
          . Developing locally? <code className="font-code">kletia webhooks forward</code> signs an intent&apos;s events for your localhost receiver.
        </p>
      </div>
    </>
  );
}
