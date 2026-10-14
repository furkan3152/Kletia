import { FileCode2, Radio, Webhook } from "lucide-react";
import React from "react";

import { Link } from "../../../routes/Link";
import type { IconName } from "../../../site/art";
import { Icon } from "../../../site/art/Icon";
import { BASE_MCP_DOC_URL } from "../../../site/siteLinks";
import { AGENT_REST_SNIPPET, MCP_CONTEXT_SNIPPET, MCP_URL } from "../../../site/snippets";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { PortalPageHeader } from "../shell/PortalPageHeader";

const LINK = cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING);

function InfoCard({ icon, title, children }: { readonly icon: IconName; readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className={cx("flex flex-col gap-3 p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <span className="flex h-11 w-11 items-center justify-center border-[3px] border-[#1A1A1A] bg-white dark:border-[#4B5563] dark:bg-[#0B1120]">
        <Icon name={icon} size={26} />
      </span>
      <h2 className="font-display text-xl font-bold tracking-[-0.01em]">{title}</h2>
      <div className={cx("text-sm leading-relaxed", TEXT_MUTED)}>{children}</div>
    </div>
  );
}

const TOOL_FLOW: readonly (readonly [string, string])[] = [
  ["get_policy", "Learn what the rule book allows this key, and what is left today."],
  ["check_intent / plan_intent", "Check before acting; confirm every externalRecipients address with the user."],
  ["create_signing_link / create_intent", "Hand the user a Studio link, or store an intent your signer runs; a held one comes with an approval link for a human."],
  ["get_intent / get_receipt", "Follow settlement, then read the signed receipt."],
];

/** Agents and MCP (`/developers/agents`): the MCP server, agent keys under rule books, x402 and the four-step tool flow. */
export default function AgentsPage() {
  return (
    <>
      <PortalPageHeader
        title="Agents and MCP"
        intro="Agents plan with the same deterministic API, under a rule book, and hand every value-moving step to a wallet they do not control. Agents never sign."
      />
      <div className="grid gap-5 md:grid-cols-3">
        <InfoCard icon="board" title="MCP server">
          Tools at <code className="break-all font-code text-xs">{MCP_URL}</code>: networks, quotes, dry-run plans with their fare, intents,
          receipts, rule books, contracts and links. Only create_intent and create_link store anything.{" "}
          <Link to="/developers/recipes/mcp" className={LINK}>
            Connect a client
          </Link>
          .
        </InfoCard>
        <InfoCard icon="shield" title="Agent keys and rule books">
          Give each agent a <code className="font-code text-xs">kl_agt_</code> key with its own rule book: caps, recipients, a timetable and
          approvals a human gives on the approval page.{" "}
          <Link to="/developers/recipes/mcp-agent" className={LINK}>
            Set one up
          </Link>
          .
        </InfoCard>
        <InfoCard icon="transfer" title="x402 pay-per-call">
          HTTP 402 payments in USDC on Base for paid resources. Kletia prepares capped, public-HTTPS payment plans; the agent&apos;s wallet
          settles them.
        </InfoCard>
      </div>
      <section aria-labelledby="tool-flow" className="mt-8 flex min-w-0 flex-col gap-3">
        <h2 id="tool-flow" className="font-display text-display-s font-bold">
          The tool flow
        </h2>
        <ol className={cx("grid gap-3 p-4 text-sm md:grid-cols-4", INK_BORDER, SURFACE)}>
          {TOOL_FLOW.map(([tool, text], index) => (
            <li key={tool} className="flex min-w-0 gap-2">
              <span className="font-display text-xl font-bold leading-none" aria-hidden="true">
                {index + 1}
              </span>
              <span className="min-w-0">
                <code className="block break-words font-code text-xs font-bold">{tool}</code>
                <span className={TEXT_MUTED}>{text}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <CodeBlock code={AGENT_REST_SNIPPET} language="bash" label="Agent planning call" filename="agent.sh" />
        <CodeBlock code={MCP_CONTEXT_SNIPPET} language="http" label="Base MCP context endpoints" filename="/api/base-mcp" />
      </div>
      <p className={cx("mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm", TEXT_MUTED)}>
        <a href={BASE_MCP_DOC_URL} target="_blank" rel="noopener noreferrer" className={cx("inline-flex items-center gap-1", LINK)}>
          <FileCode2 className="h-4 w-4" aria-hidden="true" />
          Base MCP runbook
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        <span className="inline-flex items-center gap-1">
          <Radio className="h-4 w-4" aria-hidden="true" /> SSE: GET /v1/intents/{"{id}"}/events
        </span>
        <Link to="/developers/webhooks" className={cx("inline-flex items-center gap-1", LINK)}>
          <Webhook className="h-4 w-4" aria-hidden="true" /> Signed webhooks
        </Link>
      </p>
    </>
  );
}
