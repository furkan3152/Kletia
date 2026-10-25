import { FileCode2, Radio, Webhook } from "lucide-react";
import React from "react";

import { Link } from "../../../routes/Link";
import type { IconName } from "../../../site/art";
import { Icon } from "../../../site/art/Icon";
import { BASE_MCP_DOC_URL } from "../../../site/siteLinks";
import { AGENT_REST_SNIPPET, MCP_CONTEXT_SNIPPET, MCP_TOOLS, MCP_URL } from "../../../site/snippets";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { DataTable } from "../../../site/ui/DataTable";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { PortalPageHeader } from "../shell/PortalPageHeader";

const LINK = cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING);

function InfoCard({ icon, title, children }: { readonly icon: IconName; readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className={cx("flex flex-col gap-3 p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <span className="flex h-11 w-11 items-center justify-center border-[3px] border-[#121212] bg-[#FBFAF6] dark:border-[#4A4A52] dark:bg-[#0E0E10]">
        <Icon name={icon} size={26} />
      </span>
      <h2 className="font-display text-xl font-bold tracking-[-0.01em]">{title}</h2>
      <div className={cx("text-sm leading-relaxed", TEXT_MUTED)}>{children}</div>
    </div>
  );
}

const TOOL_FLOW: readonly (readonly [string, string])[] = [
  ["get_policy", "Learn what the rule book allows this key, and what is left today."],
  [
    "check_intent / plan_intent",
    "Check before acting. When plan_intent answers needs_input, ask the person: never answer a question about amounts or recipients yourself.",
  ],
  ["create_signing_link / create_intent", "Hand the user a Studio link, or store an intent your signer runs; a held one comes with an approval link for a human."],
  ["get_journey / get_receipt", "Follow where the money is and what needs an answer before the next signature, then read the signed receipt."],
];

type ToolRow = (typeof MCP_TOOLS)[number];

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
          receipts, rule books, contracts, links and sub-agents. Only create_intent, create_link and the sub-agent tools store anything.{" "}
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
          . An agent can ask for sub-agents inside its own rule book; you approve them on the{" "}
          <Link to="/developers/agent-tree" className={LINK}>
            Agents
          </Link>{" "}
          page.
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
      <section aria-labelledby="mcp-tools" className="mt-10 flex min-w-0 flex-col gap-3">
        <h2 id="mcp-tools" className="font-display text-display-s font-bold">
          MCP tools
        </h2>
        <p className={cx("max-w-3xl text-sm", TEXT_MUTED)}>
          {MCP_TOOLS.length} tools. Every one is read-only except the {MCP_TOOLS.filter((tool) => tool.writes).length} that store; none prepares,
          submits or signs. Tools marked key need an API key.
        </p>
        <DataTable<ToolRow>
          caption="MCP tools"
          columns={[
            { key: "name", header: "Tool", phone: "primary", cell: (tool) => <code className="break-all font-code text-code font-bold">{tool.name}</code> },
            { key: "input", header: "Input", cell: (tool) => <span className="break-words font-code text-code-s">{tool.input}</span> },
            { key: "output", header: "Returns", cell: (tool) => tool.output },
            {
              key: "access",
              header: "Access",
              cell: (tool) => (
                <span className={cx(LABEL, "whitespace-nowrap", TEXT_MUTED)}>
                  {[tool.key ? "key" : "public", tool.writes ? "stores" : "read-only"].join(" · ")}
                </span>
              ),
            },
          ]}
          rows={MCP_TOOLS}
          rowKey={(tool) => tool.name}
        />
      </section>
      <div className="mt-8 grid gap-6 xl:grid-cols-2">
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
