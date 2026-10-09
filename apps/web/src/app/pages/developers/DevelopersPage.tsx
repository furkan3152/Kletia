import { ArrowUpRight, Bot, Coins, FileCode2, Plug, Radio, Webhook } from "lucide-react";
import React, { useEffect, useState } from "react";

import { PLATFORM_ORIGIN } from "../../../shared/platform/kletiaClient";
import { Link } from "../../routes/Link";
import { API_DOC_URL, BASE_MCP_DOC_URL, SDK_PACKAGE_URL } from "../../site/siteLinks";
import {
  AGENT_REST_SNIPPET,
  EMBED_PARAMS,
  EMBED_PATH,
  EVENT_ENVELOPE,
  IFRAME_SNIPPET,
  MCP_CONTEXT_SNIPPET,
  REST_STRUCTURED,
  SDK_INSTALL,
  SDK_PLAN_AND_EXECUTE,
  SDK_QUICKSTART,
  SSE_SNIPPET,
  WEBHOOK_REGISTER,
  WEBHOOK_VERIFY,
  WIDGET_SNIPPET,
} from "../../site/snippets";
import { Badge } from "../../site/ui/Badge";
import { ButtonLink } from "../../site/ui/Button";
import { CodeBlock } from "../../site/ui/CodeBlock";
import { CONTAINER, cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { ApiExplorer } from "./ApiExplorer";
import { AUTH_TIERS, EVENT_TYPES, TOC } from "./devContent";
import { DocSection } from "./DocSection";
import { EndpointReference } from "./EndpointReference";
import { KeyRequestForm } from "./KeyRequestForm";

function useActiveSection(ids: readonly string[]): string {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-120px 0px -55% 0px", threshold: 0 },
    );
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

const TOC_IDS = TOC.map((item) => item.id);

function InfoCard({
  icon,
  title,
  children,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  accent: string;
}) {
  return (
    <div className={cx("flex flex-col gap-3 p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <span
        className="flex h-10 w-10 items-center justify-center border-[3px] border-[#1A1A1A] dark:border-[#4B5563]"
        style={{ backgroundColor: accent, color: accent === "#FFD60A" || accent === "#14F195" ? "#1A1A1A" : "#FFFFFF" }}
      >
        {icon}
      </span>
      <h3 className="font-display text-xl font-bold tracking-[-0.01em]">{title}</h3>
      <div className={cx("text-sm leading-relaxed", TEXT_MUTED)}>{children}</div>
    </div>
  );
}

/** Developer portal: quickstart, keys, live explorer, reference, events, embeds and agents. */
export default function DevelopersPage() {
  const active = useActiveSection(TOC_IDS);

  return (
    <>
      <header className="kl-grid-backdrop border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "grid gap-10 py-14 sm:py-20 lg:grid-cols-[1.2fr_0.8fr] lg:items-end")}>
          <div>
            <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>Developers · Platform API v1</p>
            <h1 className="mt-4 text-balance font-display text-[clamp(2.5rem,7vw,4.75rem)] font-bold leading-[0.95] tracking-[-0.045em]">
              Build with <span className="bg-[#FFD60A] px-2 text-[#1A1A1A]">Kletia</span>
            </h1>
            <p className={cx("mt-6 max-w-2xl text-lg leading-relaxed", TEXT_MUTED)}>
              One REST API, a typed SDK, a React widget and an iframe embed for cross-network intents across EVM
              networks and Solana. Your users keep their keys; your product gets verified, wallet-signed execution.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink to="/developers#quickstart">Quickstart</ButtonLink>
              <ButtonLink to="/developers#explorer" variant="secondary">
                API explorer
              </ButtonLink>
              <ButtonLink to={API_DOC_URL} variant="ghost">
                API v1 spec
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </ButtonLink>
            </div>
          </div>
          <dl className={cx("grid grid-cols-2 gap-[3px] bg-[#1A1A1A] dark:bg-[#4B5563]", INK_BORDER, HARD_SHADOW)}>
            {[
              ["Base URL", `${PLATFORM_ORIGIN.replace(/^https?:\/\//u, "")}/v1`],
              ["Spec", "OpenAPI 3.1"],
              ["Identities", "CAIP-2 · 10 · 19"],
              ["Events", "SSE + webhooks"],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 bg-white p-4 dark:bg-[#131E32]">
                <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>{label}</dt>
                <dd className="mt-1 break-words font-code text-sm font-bold">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      <div className={cx(CONTAINER, "grid gap-10 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14")}>
        <nav aria-label="On this page" className="hidden lg:block">
          <div className="sticky top-28 py-14">
            <p className={cx(LABEL, "mb-4", TEXT_MUTED)}>On this page</p>
            <ol className="space-y-1 border-l-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
              {TOC.map((item, index) => {
                const current = item.id === active;
                return (
                  <li key={item.id}>
                    <Link
                      to={`/developers#${item.id}`}
                      aria-current={current ? "location" : undefined}
                      className={cx(
                        "-ml-[3px] flex min-h-9 items-center gap-2 border-l-[3px] px-3 text-sm font-bold transition-colors",
                        current
                          ? "border-[#0052FF] text-[#0052FF] dark:border-[#FFD60A] dark:text-[#FFD60A]"
                          : "border-transparent text-[#45464B] hover:text-[#1A1A1A] dark:text-[#A9B6C8] dark:hover:text-white",
                        FOCUS_RING,
                      )}
                    >
                      <span className="font-code text-[10px]">{String(index + 1).padStart(2, "0")}</span>
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ol>
          </div>
        </nav>

        <div className="min-w-0 py-6 lg:py-8">
          <DocSection
            id="quickstart"
            index={1}
            title="Quickstart"
            intro={
              <>
                Install the SDK, list networks and plan your first intent as a dry run. No key is needed on the public
                tier. Source: <a className="font-bold underline decoration-2 underline-offset-2" href={SDK_PACKAGE_URL} target="_blank" rel="noopener noreferrer">packages/sdk</a>.
              </>
            }
          >
            <div className="grid gap-6">
              <CodeBlock code={SDK_INSTALL} language="bash" label="Install" filename="terminal" />
              <CodeBlock code={SDK_QUICKSTART} language="ts" label="First dry run" filename="quickstart.ts" />
              <CodeBlock
                code={SDK_PLAN_AND_EXECUTE}
                language="ts"
                label="Plan and execute"
                filename="execute.ts"
                footer={
                  <>
                    <code className="font-code">executeIntent</code> prepares each ready step, asks the wallet bound to
                    that step to sign, submits references for on-chain verification and waits for settlement before
                    unlocking dependent steps.
                  </>
                }
              />
              <div className="grid gap-4 md:grid-cols-2">
                <CodeBlock code={REST_STRUCTURED} language="json" label="Structured actions" filename="structured-intent.json" />
                <div className={cx("flex flex-col justify-center gap-3 p-5", INK_BORDER, SURFACE)}>
                  <p className={LABEL}>Prefer a UI?</p>
                  <p className={cx("text-sm", TEXT_MUTED)}>
                    Intent Studio sends the same dry-run request and renders the returned graph step by step.
                  </p>
                  <ButtonLink to="/studio" variant="accent" size="sm" className="self-start">
                    Open Intent Studio
                  </ButtonLink>
                </div>
              </div>
            </div>
          </DocSection>

          <DocSection
            id="auth"
            index={2}
            title="Authentication"
            intro="Three tiers share one API. Every response carries X-Request-Id; errors use stable UPPER_SNAKE_CASE codes."
          >
            <ul className="grid gap-5 md:grid-cols-3">
              {AUTH_TIERS.map((tier) => (
                <li key={tier.name} className={cx("flex flex-col", INK_BORDER, HARD_SHADOW, SURFACE)}>
                  <div className="h-2.5 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]" style={{ backgroundColor: tier.accent }} aria-hidden="true" />
                  <div className="flex flex-1 flex-col gap-3 p-5">
                    <h3 className="font-display text-2xl font-bold">{tier.name}</h3>
                    <p className="break-words font-code text-xs">{tier.how}</p>
                    <p className="font-bold">{tier.limit}</p>
                    <p className={cx("text-sm", TEXT_MUTED)}>{tier.capabilities}</p>
                  </div>
                </li>
              ))}
            </ul>
          </DocSection>

          <DocSection
            id="keys"
            index={3}
            title="Get a developer key"
            intro="Calls POST /v1/keys through @kletia/sdk. The raw key is returned once and never stored in plain text."
          >
            <KeyRequestForm />
          </DocSection>

          <DocSection
            id="explorer"
            index={4}
            title="API explorer"
            badge={<Badge tone="green">Live</Badge>}
            intro="Send real requests to the public API from your browser. Planning is a dry run: nothing is persisted and nothing is signed."
          >
            <ApiExplorer />
          </DocSection>

          <DocSection id="reference" index={5} title="Endpoint reference" intro="Rendered from the OpenAPI document the API serves.">
            <EndpointReference />
          </DocSection>

          <DocSection
            id="events"
            index={6}
            title="Events & webhooks"
            intro="Follow an intent live over Server-Sent Events, or register a webhook and verify each delivery's HMAC signature."
          >
            <div className="grid gap-6">
              <ul className="grid gap-4 md:grid-cols-3">
                {EVENT_TYPES.map((event) => (
                  <li key={event.type} className={cx("flex flex-col gap-2 p-4", INK_BORDER, SURFACE)}>
                    <code className="font-code text-sm font-bold text-[#0052FF] dark:text-[#7EA6FF]">{event.type}</code>
                    <p className="text-sm">{event.description}</p>
                    <p className={cx("font-code text-[11px]", TEXT_MUTED)}>data: {event.fields}</p>
                  </li>
                ))}
              </ul>
              <div className={cx("flex flex-col gap-2 border-[3px] border-[#1A1A1A] bg-[#FFD60A] p-4 text-[#1A1A1A] dark:border-[#4B5563]")}>
                <p className={LABEL}>Signature header</p>
                <code className="break-all font-code text-sm font-bold">
                  Kletia-Signature: t=&lt;unix&gt;,v1=&lt;hex HMAC-SHA256(secret, &quot;&lt;t&gt;.&lt;raw body&gt;&quot;)&gt;
                </code>
                <p className="text-sm">
                  Deliveries are POST requests to public HTTPS URLs, retried up to 3 times with backoff. Reject
                  signatures older than your tolerance (default 300 s).
                </p>
              </div>
              <div className="grid gap-6 xl:grid-cols-2">
                <CodeBlock code={WEBHOOK_VERIFY} language="ts" label="Verify a webhook" filename="app/api/kletia/route.ts" />
                <div className="grid gap-6">
                  <CodeBlock code={WEBHOOK_REGISTER} language="ts" label="Register a webhook" filename="webhooks.ts" />
                  <CodeBlock code={SSE_SNIPPET} language="ts" label="Stream events" filename="stream.ts" />
                  <CodeBlock code={EVENT_ENVELOPE} language="json" label="Event envelope" filename="event.json" />
                </div>
              </div>
            </div>
          </DocSection>

          <DocSection
            id="embed"
            index={7}
            title="Widget & embed"
            intro="Drop the React widget into your app, or embed the hosted page in an iframe. Both plan, review and, once the visitor connects wallets, execute intents with their own signatures. Without wallets they are read-only planners."
          >
            <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <CodeBlock code={WIDGET_SNIPPET} language="tsx" label="React widget" filename="IntentPanel.tsx" />
              <div className="flex min-w-0 flex-col gap-6">
                <CodeBlock code={IFRAME_SNIPPET} language="text" label="Iframe embed" filename="index.html" />
                <div className={cx("p-4", INK_BORDER, SURFACE)}>
                  <p className={LABEL}>/embed parameters</p>
                  <dl className="mt-3 flex flex-col gap-3 text-sm">
                    {EMBED_PARAMS.map((param) => (
                      <div key={param.name} className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                        <dt className="font-code text-[13px] font-bold">{param.name}</dt>
                        <dd className={TEXT_MUTED}>
                          <span className="font-code text-xs text-[#1A1A1A] dark:text-white">{param.values}</span>
                          <span className="block">{param.description}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className={cx("mt-4 text-sm", TEXT_MUTED)}>
                    The embed never reads an API key from its URL: it always uses the public tier. Visitors connect
                    their own EVM and Solana wallets inside the frame; nothing is signed without their confirmation.
                  </p>
                  <ButtonLink to={EMBED_PATH} external size="sm" variant="secondary" className="mt-4">
                    Open the embed
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </ButtonLink>
                </div>
              </div>
            </div>
          </DocSection>

          <DocSection
            id="agents"
            index={8}
            title="Agents"
            intro="Autonomous agents plan with the same deterministic API, pay for premium calls over HTTP, and hand every value-moving step to a human-controlled wallet."
          >
            <div className="grid gap-5 md:grid-cols-3">
              <InfoCard icon={<Coins className="h-5 w-5" aria-hidden="true" />} title="x402 pay-per-call" accent="#0052FF">
                HTTP 402 payments in USDC on Base for paid resources. Kletia prepares capped, public-HTTPS payment
                plans; the agent's wallet settles them.
              </InfoCard>
              <InfoCard icon={<Plug className="h-5 w-5" aria-hidden="true" />} title="MCP context" accent="#FFD60A">
                Read-only context endpoints bind a Base MCP wallet to Base Mainnet policy and discover x402 resources.
                No endpoint signs or submits anything.
              </InfoCard>
              <InfoCard icon={<Bot className="h-5 w-5" aria-hidden="true" />} title="v1 API for agents" accent="#9945FF">
                Plan with POST /v1/intents, follow progress over SSE and react to webhooks. Grammar-compiled plans make
                agent behaviour reproducible and auditable.
              </InfoCard>
            </div>
            <div className="mt-6 grid gap-6 xl:grid-cols-2">
              <CodeBlock code={MCP_CONTEXT_SNIPPET} language="http" label="MCP context endpoints" filename="/api/base-mcp" />
              <CodeBlock code={AGENT_REST_SNIPPET} language="bash" label="Agent planning call" filename="agent.sh" />
            </div>
            <p className={cx("mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm", TEXT_MUTED)}>
              <a href={BASE_MCP_DOC_URL} target="_blank" rel="noopener noreferrer" className={cx("inline-flex items-center gap-1 font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                <FileCode2 className="h-4 w-4" aria-hidden="true" />
                Base MCP runbook
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              <span className="inline-flex items-center gap-1">
                <Radio className="h-4 w-4" aria-hidden="true" /> SSE: GET /v1/intents/{"{id}"}/events
              </span>
              <span className="inline-flex items-center gap-1">
                <Webhook className="h-4 w-4" aria-hidden="true" /> Signed webhooks
              </span>
            </p>
          </DocSection>
        </div>
      </div>
    </>
  );
}
