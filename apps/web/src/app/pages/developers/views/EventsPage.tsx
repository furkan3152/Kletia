import React from "react";

import { Link } from "../../../routes/Link";
import { EVENT_ENVELOPE, SSE_SNIPPET, WEBHOOK_REGISTER, WEBHOOK_VERIFY } from "../../../site/snippets";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { DELIVERY_HEADERS, EVENT_FAMILIES, EVENT_TYPES } from "../devContent";
import { PortalPageHeader } from "../shell/PortalPageHeader";

const LINK = cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING);

/** Events (`/developers/events`): intent events, the other families, delivery headers, retries and the verify code. */
export default function EventsPage() {
  return (
    <>
      <PortalPageHeader
        title="Events"
        intro="Follow an intent live over Server-Sent Events, or register a webhook, send it a signed test and read its delivery log. Rule Book, key, contract and link events go to the owning key's webhooks."
      />
      <div className="grid min-w-0 gap-8">
        <section aria-labelledby="intent-events" className="flex min-w-0 flex-col gap-4">
          <h2 id="intent-events" className="font-display text-display-s font-bold">
            Intent events
          </h2>
          <ul className="grid gap-4 md:grid-cols-2">
            {EVENT_TYPES.map((event) => (
              <li key={event.type} className={cx("flex flex-col gap-2 p-4", INK_BORDER, SURFACE)}>
                <code className="font-code text-sm font-bold text-accent-text">{event.type}</code>
                <p className="text-sm">{event.description}</p>
                <p className={cx("font-code text-xs", TEXT_MUTED)}>data: {event.fields}</p>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="event-families" className="flex min-w-0 flex-col gap-4">
          <h2 id="event-families" className="font-display text-display-s font-bold">
            Other event families
          </h2>
          <ul className="grid gap-4 md:grid-cols-2">
            {EVENT_FAMILIES.map((family) => (
              <li key={family.title} className={cx("flex min-w-0 flex-col gap-2 p-4", INK_BORDER, SURFACE)}>
                <h3 className="font-display text-lg font-bold">{family.title}</h3>
                <p className="flex min-w-0 flex-wrap gap-1.5">
                  {family.types.map((type) => (
                    <code
                      key={type}
                      className="border-2 border-[#1A1A1A]/20 px-1.5 py-0.5 font-code text-xs font-bold text-accent-text dark:border-white/15"
                    >
                      {type}
                    </code>
                  ))}
                </p>
                <p className={cx("font-code text-xs", TEXT_MUTED)}>data: {family.fields}</p>
                <p className="text-sm">{family.note}</p>
              </li>
            ))}
          </ul>
          <p className={cx("text-sm", TEXT_MUTED)}>
            A webhook created without <code className="font-code">events</code> gets the types that existed when it was created; list new
            types explicitly, or create the webhook with <code className="font-code">{'"scope": "subtree"'}</code> to also hear a key&apos;s
            agent keys.
          </p>
        </section>
        <section aria-labelledby="delivery-headers" className="flex flex-col gap-3 border-[3px] border-[#1A1A1A] bg-[#FFD60A] p-4 text-[#1A1A1A] dark:border-[#4B5563]">
          <h2 id="delivery-headers" className={LABEL}>
            Delivery headers
          </h2>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[13rem_minmax(0,1fr)]">
            {DELIVERY_HEADERS.map((header) => (
              <React.Fragment key={header.name}>
                <dt className="font-code font-bold">{header.name}</dt>
                <dd className="min-w-0 break-words font-code text-xs">{header.description}</dd>
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
          . Developing locally? <code className="font-code">kletia webhooks forward</code> signs an intent&apos;s events for your localhost
          receiver.
        </p>
      </div>
    </>
  );
}
