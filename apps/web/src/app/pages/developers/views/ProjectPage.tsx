import { ArrowRight } from "lucide-react";

import { Link } from "../../../routes/Link";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";

const TODAY: readonly { readonly label: string; readonly to: string; readonly text: string }[] = [
  { label: "Keys and usage", to: "/developers/keys", text: "The project's developer and agent keys, and what they used." },
  { label: "Rule Book", to: "/developers/rule-book", text: "The project rule book and one per key." },
  { label: "Webhooks", to: "/developers/webhooks", text: "Where the project's events are delivered." },
  { label: "Contracts", to: "/developers/contracts", text: "Your own contract functions and Solana Actions." },
  { label: "Links", to: "/developers/links", text: "Intent links the project publishes." },
];

/** Placeholder until the projects API and its page land: what a project is today, one link per part. */
function ProjectToday() {
  return (
    <section aria-labelledby="project-today" className={cx("flex min-w-0 flex-col gap-4 p-5 sm:p-6", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <h2 id="project-today" className="font-display text-title font-bold">
        Your project today
      </h2>
      <p className={cx("max-w-2xl text-sm", TEXT_MUTED)}>
        This page will hold the project&apos;s brand and domain, the origins allowed to use its publishable keys, widget defaults and
        stored flows. Everything the project owns now is one page away:
      </p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {TODAY.map((item) => (
          <li key={item.to} className="min-w-0">
            <Link to={item.to} className={cx("inline-flex min-h-10 items-center gap-1.5 font-bold underline decoration-2 underline-offset-4", FOCUS_RING)}>
              {item.label}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <p className={cx("text-sm", TEXT_MUTED)}>{item.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Project settings (`/developers/project`): a thin wrapper until the project page is built. */
export default function ProjectPage() {
  return (
    <>
      <PortalPageHeader
        title="Project settings"
        intro="Your project's brand and domain, allowed origins, widget defaults, stored flows and browser-safe publishable keys."
      />
      <KeyGate purpose="read and change your project's settings">
        <ProjectToday />
      </KeyGate>
    </>
  );
}
