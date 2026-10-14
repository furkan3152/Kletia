import { ArrowRight } from "lucide-react";

import { Link } from "../../../routes/Link";
import type { IconName } from "../../../site/art/icons";
import { Icon } from "../../../site/art/Icon";
import { cx, FOCUS_RING, INK_BORDER, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";

const SURFACES: readonly { readonly icon: IconName; readonly title: string; readonly line: string; readonly to: string }[] = [
  { icon: "embed", title: "Embed", line: "One script tag on any page", to: "/developers/recipes/web-component" },
  { icon: "sdk", title: "Node SDK", line: "Plan and execute from your server", to: "/developers/recipes/nextjs" },
  { icon: "embed", title: "React widget", line: "A drop-in panel for React apps", to: "/developers/recipes/react-widget" },
  { icon: "route", title: "OpenAPI", line: "Every operation, live", to: "/developers/api" },
  { icon: "board", title: "MCP for agents", line: "Tools for AI agents under a rule book", to: "/developers/agents" },
  { icon: "ticket", title: "Intent links", line: "One-action pages you publish", to: "/developers/recipes/links" },
  { icon: "contract", title: "Your contracts", line: "Your own functions, reviewed before signing", to: "/developers/recipes/contracts" },
  { icon: "route", title: "Journey", line: "Where the money is after every step", to: "/developers/recipes/journey" },
  { icon: "name", title: "Questions", line: "Ask before guessing a missing amount", to: "/developers/recipes/questions" },
  { icon: "verify", title: "Receipts", line: "Check one yourself, without trusting us", to: "/developers/receipts" },
];

/** "Build with": every surface and platform feature, one line each. */
export function BuildWithGrid() {
  return (
    <section aria-labelledby="build-with-heading" className="flex min-w-0 flex-col gap-4 pt-12">
      <h2 id="build-with-heading" className="font-display text-display-s font-bold">
        Build with
      </h2>
      <ul className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SURFACES.map((surface) => (
          <li key={surface.title} className="min-w-0">
            <Link to={surface.to} className={cx("group flex h-full min-h-11 min-w-0 items-center gap-3 p-3 hover:bg-surface-2", INK_BORDER, SURFACE, FOCUS_RING)}>
              <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-line bg-paper">
                <Icon name={surface.icon} size={24} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-bold group-hover:underline">{surface.title}</span>
                <span className={cx("text-sm", TEXT_MUTED)}>{surface.line}</span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
