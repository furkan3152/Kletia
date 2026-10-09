import { ArrowUpRight, Bot, Coins, FileCode2, Plug, Radio, Webhook } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

import { errorCatalogRows } from "@kletia/core";
import { PLATFORM_ORIGIN, sdkSignal } from "../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../shared/platform/useApiResource";
import { Link } from "../../routes/Link";
import { AnimatedNumber } from "../../site/motion/AnimatedNumber";
import { prefersReducedMotion } from "../../site/motion/useReducedMotion";
import { API_DOC_URL, BASE_MCP_DOC_URL, SDK_PACKAGE_URL } from "../../site/siteLinks";
import {
  AGENT_REST_SNIPPET,
  EVENT_ENVELOPE,
  MCP_CONTEXT_SNIPPET,
  MCP_URL,
  REST_STRUCTURED,
  SDK_INSTALL,
  SDK_PLAN_AND_EXECUTE,
  SDK_QUICKSTART,
  SSE_SNIPPET,
  WEBHOOK_REGISTER,
  WEBHOOK_VERIFY,
} from "../../site/snippets";
import { Badge } from "../../site/ui/Badge";
import { ButtonLink } from "../../site/ui/Button";
import { CodeBlock } from "../../site/ui/CodeBlock";
import { CONTAINER, cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { BridgeAuction } from "./BridgeAuction";
import { AUTH_TIERS, DELIVERY_HEADERS, EVENT_TYPES, TOC } from "./devContent";
import { DocSection } from "./DocSection";
import { ErrorsReference } from "./ErrorsReference";
import { ApiExplorer, type SpecSource } from "./explorer/ApiExplorer";
import { operationsFromOpenApi } from "./explorer/operations";
import type { OpenApiDoc } from "./explorer/schema";
import { STATIC_OPERATIONS } from "./explorer/staticOperations";
import { KeyManager } from "./keys/KeyManager";
import { SessionKeyProvider } from "./keys/SessionKeyProvider";
import { RecipesSection } from "./RecipesSection";
import { VenuesPanel } from "./VenuesPanel";

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
      { rootMargin: "-140px 0px -55% 0px", threshold: 0 },
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
const BUNDLED_ERROR_COUNT = errorCatalogRows().length;

function InfoCard({ icon, title, children, accent }: { icon: React.ReactNode; title: string; children: React.ReactNode; accent: string }) {
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

/** Sticky section bar for small screens (the desktop table of contents is the left rail). */
function MobileSectionBar({ active }: { active: string }) {
  const listRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    const list = listRef.current;
    const chip = list?.querySelector<HTMLElement>(`[data-section="${active}"]`);
    if (!list || !chip) return;
    const left = chip.offsetLeft - list.clientWidth / 2 + chip.offsetWidth / 2;
    list.scrollTo({ left: Math.max(0, left), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [active]);
  return (
    <nav
      aria-label="Sections"
      className="sticky top-[75px] z-30 border-b-[3px] border-[#1A1A1A] bg-[#F4F1EA]/95 backdrop-blur-sm dark:border-[#4B5563] dark:bg-[#0B1120]/95 lg:hidden"
    >
      <ol ref={listRef} className="flex gap-1.5 overflow-x-auto px-4 py-2 sm:px-6 [scrollbar-width:none]">
        {TOC.map((item) => {
          const current = item.id === active;
          return (
            <li key={item.id} className="shrink-0">
              <Link
                to={`/developers#${item.id}`}
                data-section={item.id}
                aria-current={current ? "location" : undefined}
                className={cx(
                  "inline-flex min-h-9 items-center border-2 px-3 text-[12px] font-black uppercase tracking-[0.1em] transition-colors",
                  current
                    ? "border-[#1A1A1A] bg-[#1A1A1A] text-white dark:border-[#FFD60A] dark:bg-[#FFD60A] dark:text-[#1A1A1A]"
                    : "border-transparent text-[#1A1A1A] hover:border-[#1A1A1A] dark:text-[#E2E8F0] dark:hover:border-[#4B5563]",
                  FOCUS_RING,
                )}
              >
                {item.short}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Developer portal: quickstart, keys, the OpenAPI explorer, recipes, events, venues, errors and agents. */
export default function DevelopersPage() {
  const active = useActiveSection(TOC_IDS);
  const spec = useApiResource<OpenApiDoc>("openapi", (client, signal) =>
    client.request<OpenApiDoc>("GET", "/openapi.json", undefined, { signal: sdkSignal(signal) }),
  );
  const liveOperations = useMemo(() => (spec.data ? operationsFromOpenApi(spec.data) : []), [spec.data]);
  const operations = liveOperations.length > 0 ? liveOperations : STATIC_OPERATIONS;
  const source: SpecSource =
    liveOperations.length > 0
      ? { state: "live", version: spec.data?.info?.version ?? null }
      : spec.status === "loading"
        ? { state: "loading" }
        : { state: "fallback", error: spec.error };

  return (
    <SessionKeyProvider>
      <header className="kl-grid-backdrop border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "grid gap-10 py-14 sm:py-20 lg:grid-cols-[1.2fr_0.8fr] lg:items-end")}>
          <div>
            <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>Developers · Platform API v1</p>
            <h1 className="mt-4 text-balance font-display text-[clamp(2.5rem,7vw,4.75rem)] font-bold leading-[0.95] tracking-[-0.045em]">
              Build with <span className="bg-[#FFD60A] px-2 text-[#1A1A1A]">Kletia</span>
            </h1>
            <p className={cx("mt-6 max-w-2xl text-lg leading-relaxed", TEXT_MUTED)}>
              One REST API, a typed SDK, React components, an embeddable element and a read-only MCP server for cross-network
              intents across EVM networks and Solana. Your users keep their keys; your product gets verified, wallet-signed
              execution.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink to="/developers#quickstart">Quickstart</ButtonLink>
              <ButtonLink to="/developers#explorer" variant="secondary">
                API explorer
              </ButtonLink>
              <ButtonLink to="/developers#recipes" variant="secondary">
                Recipes
              </ButtonLink>
              <ButtonLink to={API_DOC_URL} variant="ghost">
                API v1 spec
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </ButtonLink>
            </div>
          </div>
          <dl className={cx("grid grid-cols-2 gap-[3px] bg-[#1A1A1A] dark:bg-[#4B5563]", INK_BORDER, HARD_SHADOW)}>
            <div className="col-span-2 min-w-0 bg-white p-4 dark:bg-[#131E32]">
              <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Base URL</dt>
              <dd className="mt-1 break-words font-code text-sm font-bold">{PLATFORM_ORIGIN.replace(/^https?:\/\//u, "")}/v1</dd>
            </div>
            <div className="min-w-0 bg-white p-4 dark:bg-[#131E32]">
              <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Operations</dt>
              <dd className="mt-1 font-code text-sm font-bold">
                <AnimatedNumber value={operations.length} /> · OpenAPI 3.1
              </dd>
            </div>
            <div className="min-w-0 bg-white p-4 dark:bg-[#131E32]">
              <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Error codes</dt>
              <dd className="mt-1 font-code text-sm font-bold">
                <AnimatedNumber value={BUNDLED_ERROR_COUNT} /> · stable
              </dd>
            </div>
            <div className="min-w-0 bg-white p-4 dark:bg-[#131E32]">
              <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Identities</dt>
              <dd className="mt-1 font-code text-sm font-bold">CAIP-2 · 10 · 19</dd>
            </div>
            <div className="min-w-0 bg-white p-4 dark:bg-[#131E32]">
              <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Agents</dt>
              <dd className="mt-1 font-code text-sm font-bold">MCP · /v1/mcp</dd>
            </div>
          </dl>
        </div>
      </header>

      <MobileSectionBar active={active} />

      <div className={cx(CONTAINER, "grid gap-10 lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:gap-12")}>
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
                Install the SDK, list networks and plan your first intent as a dry run. No key is needed on the public tier. Source:{" "}
                <a
                  className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}
                  href={SDK_PACKAGE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  packages/sdk
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                .
              </>
            }
          >
            <div className="grid gap-6">
              <CodeBlock code={SDK_INSTALL} language="bash" label="Install" filename="terminal" />
              <CodeBlock code={SDK_QUICKSTART} language="ts" label="First dry run" filename="quickstart.ts" reveal="lines" />
              <CodeBlock
                code={SDK_PLAN_AND_EXECUTE}
                language="ts"
                label="Plan and execute"
                filename="execute.ts"
                footer={
                  <>
                    <code className="font-code">executeIntent</code> prepares each ready step, asks the wallet bound to that step to
                    sign, submits references for on-chain verification and waits for settlement before unlocking dependent steps.
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
            id="keys"
            index={2}
            title="Keys & authentication"
            intro="Three tiers share one API. Every response carries X-Request-Id and RateLimit headers; errors use stable UPPER_SNAKE_CASE codes."
          >
            <div className="flex flex-col gap-8">
              <ul id="auth" className="grid scroll-mt-36 gap-4 md:grid-cols-3 lg:scroll-mt-28">
                {AUTH_TIERS.map((tier) => (
                  <li key={tier.name} className={cx("flex flex-col", INK_BORDER, HARD_SHADOW, SURFACE)}>
                    <div className="h-2.5 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]" style={{ backgroundColor: tier.accent }} aria-hidden="true" />
                    <div className="flex flex-1 flex-col gap-2 p-4">
                      <h3 className="font-display text-2xl font-bold">{tier.name}</h3>
                      <p className="break-words font-code text-xs">{tier.how}</p>
                      <p className="font-bold">{tier.limit}</p>
                      <p className={cx("text-sm", TEXT_MUTED)}>{tier.capabilities}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <KeyManager />
            </div>
          </DocSection>

          <DocSection
            id="explorer"
            index={3}
            title="API explorer"
            badge={<Badge tone={source.state === "live" ? "green" : source.state === "loading" ? "neutral" : "yellow"}>{source.state === "live" ? "Live" : source.state === "loading" ? "Loading" : "Offline"}</Badge>}
            intro="Every operation of Platform API v1, generated from the OpenAPI document the API serves. Requests go to the real API; planning defaults to a dry run, and nothing is ever signed here."
          >
            <ApiExplorer operations={operations} source={source} onReloadSpec={spec.reload} />
          </DocSection>

          <DocSection
            id="recipes"
            index={4}
            title="Recipes"
            intro={
              <>
                Copy-ready integrations for the SDK, the React widget and hooks, the embed, MCP clients and the CLI. Secrets always come
                from the environment. Link to one with <code className="font-code [font-variant-ligatures:none]">#recipe-&lt;name&gt;</code>.
              </>
            }
          >
            <RecipesSection />
          </DocSection>

          <DocSection
            id="events"
            index={5}
            title="Events & webhooks"
            intro="Follow an intent live over Server-Sent Events, or register a webhook, send it a signed test and read its delivery log."
          >
            <div className="grid gap-6">
              <ul className="grid gap-4 md:grid-cols-2">
                {EVENT_TYPES.map((event) => (
                  <li key={event.type} className={cx("flex flex-col gap-2 p-4", INK_BORDER, SURFACE)}>
                    <code className="font-code text-sm font-bold text-[#0052FF] dark:text-[#7EA6FF]">{event.type}</code>
                    <p className="text-sm">{event.description}</p>
                    <p className={cx("font-code text-[11px]", TEXT_MUTED)}>data: {event.fields}</p>
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-3 border-[3px] border-[#1A1A1A] bg-[#FFD60A] p-4 text-[#1A1A1A] dark:border-[#4B5563]">
                <p className={LABEL}>Delivery headers</p>
                <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[13rem_minmax(0,1fr)]">
                  {DELIVERY_HEADERS.map((header) => (
                    <React.Fragment key={header.name}>
                      <dt className="font-code font-bold">{header.name}</dt>
                      <dd className="min-w-0 break-words font-code text-[12px]">{header.description}</dd>
                    </React.Fragment>
                  ))}
                </dl>
                <p className="text-sm">
                  POST to public HTTPS URLs only, retried up to 3 times (1 s, 5 s, 25 s), redirects never followed. Reject signatures
                  older than your tolerance (default 300 s) and de-duplicate by event id.
                </p>
              </div>
              <div className="grid gap-6 xl:grid-cols-2">
                <CodeBlock code={WEBHOOK_VERIFY} language="ts" label="Verify a webhook" filename="app/api/kletia/webhook/route.ts" />
                <CodeBlock code={WEBHOOK_REGISTER} language="ts" label="Register and test a webhook" filename="webhooks.ts" />
                <CodeBlock code={SSE_SNIPPET} language="ts" label="Stream events" filename="stream.ts" />
                <CodeBlock code={EVENT_ENVELOPE} language="json" label="Event envelope" filename="event.json" />
              </div>
              <p className={cx("text-sm", TEXT_MUTED)}>
                More servers in the recipes:{" "}
                <Link to="/developers#recipe-nextjs" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                  Next.js
                </Link>
                ,{" "}
                <Link to="/developers#recipe-express" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                  Express
                </Link>{" "}
                and{" "}
                <Link to="/developers#recipe-hono" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                  Hono
                </Link>
                . Developing locally? <code className="font-code">kletia webhooks forward</code> signs an intent&apos;s events for
                your localhost receiver.
              </p>
            </div>
          </DocSection>

          <DocSection
            id="venues"
            index={6}
            title="Venues & bridge auction"
            intro="Pick a lending venue by id for deposits and withdrawals, and see how the planner chooses a bridge for every cross-network step."
          >
            <div className="flex flex-col gap-10">
              <VenuesPanel />
              <div className="flex flex-col gap-4">
                <h3 className="font-display text-2xl font-bold tracking-[-0.02em]">The bridge auction</h3>
                <BridgeAuction />
              </div>
            </div>
          </DocSection>

          <DocSection
            id="errors"
            index={7}
            title="Errors"
            intro={
              <>
                Every <code className="font-code">error.code</code> the API returns, and every step failure code, with whether a retry
                can help and what to do. <code className="font-code">error.docs</code> links here as{" "}
                <code className="font-code [font-variant-ligatures:none]">#error-&lt;CODE&gt;</code>.
              </>
            }
          >
            <ErrorsReference />
          </DocSection>

          <DocSection
            id="agents"
            index={8}
            title="Agents"
            intro="Agents plan with the same deterministic API and hand every value-moving step to a human-controlled wallet. Agents never sign."
          >
            <div className="grid gap-5 md:grid-cols-3">
              <InfoCard icon={<Plug className="h-5 w-5" aria-hidden="true" />} title="MCP server" accent="#FFD60A">
                Read-only tools at <code className="break-all font-code text-[12px]">{MCP_URL}</code>: networks, quotes, dry-run
                plans, intents, balances and a Studio signing link.{" "}
                <Link to="/developers#recipe-mcp" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                  Connect a client
                </Link>
                .
              </InfoCard>
              <InfoCard icon={<Bot className="h-5 w-5" aria-hidden="true" />} title="v1 API for agents" accent="#9945FF">
                Plan with POST /v1/intents, follow progress over SSE and react to webhooks. Grammar-compiled plans make agent behaviour
                reproducible; INTENT_UNSUPPORTED returns phrases the grammar understands.
              </InfoCard>
              <InfoCard icon={<Coins className="h-5 w-5" aria-hidden="true" />} title="x402 pay-per-call" accent="#0052FF">
                HTTP 402 payments in USDC on Base for paid resources. Kletia prepares capped, public-HTTPS payment plans; the
                agent&apos;s wallet settles them.
              </InfoCard>
            </div>
            <ol className={cx("mt-6 grid gap-3 p-4 text-sm md:grid-cols-4", INK_BORDER, SURFACE)}>
              {[
                ["list_networks", "Learn valid networks and actions."],
                ["get_quote / plan_intent", "Show the plan; confirm every externalRecipients address with the user."],
                ["create_signing_link", "Hand the user a Studio link: their wallet re-plans, reviews and signs."],
                ["get_intent", "Follow settlement with the id Studio shows."],
              ].map(([tool, text], index) => (
                <li key={tool} className="flex min-w-0 gap-2">
                  <span className="font-display text-xl font-bold leading-none">{index + 1}</span>
                  <span className="min-w-0">
                    <code className="block break-words font-code text-[12px] font-bold">{tool}</code>
                    <span className={TEXT_MUTED}>{text}</span>
                  </span>
                </li>
              ))}
            </ol>
            <div className="mt-6 grid gap-6 xl:grid-cols-2">
              <CodeBlock code={AGENT_REST_SNIPPET} language="bash" label="Agent planning call" filename="agent.sh" />
              <CodeBlock code={MCP_CONTEXT_SNIPPET} language="http" label="Base MCP context endpoints" filename="/api/base-mcp" />
            </div>
            <p className={cx("mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm", TEXT_MUTED)}>
              <a
                href={BASE_MCP_DOC_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={cx("inline-flex items-center gap-1 font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}
              >
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
    </SessionKeyProvider>
  );
}
