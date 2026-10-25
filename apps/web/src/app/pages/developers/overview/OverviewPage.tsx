import { PROTOCOLS } from "@kletia/core";
import { ArrowUpRight } from "lucide-react";
import { useCallback, useState } from "react";

import { PLATFORM_ORIGIN } from "../../../../shared/platform/kletiaClient";
import { Icon } from "../../../site/art/Icon";
import { SpecSheet } from "../../../site/art/SpecSheet";
import { API_DOC_URL } from "../../../site/siteLinks";
import { ButtonLink } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { StatusPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { usePortal } from "../shell/portalContext";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { GET_KEY_HREF } from "../shell/portalRoutes";
import { StartHere } from "../start/StartHere";
import { BuildWithGrid } from "./BuildWithGrid";
import { ProjectGlance } from "./ProjectGlance";

/** The drawing shows "your contract" only while the registry has bring-your-own-contract venues; the caption follows it. */
const HAS_CONTRACTS = PROTOCOLS.some((protocol) => protocol.category === "custom");

const SPEC_LINK = cx("inline-flex min-h-11 items-center gap-1 text-sm font-bold underline decoration-2 underline-offset-4", FOCUS_RING);

/** The API status line under the hero (GET /v1/health, read once by the portal shell). */
function StatusLine() {
  const { health } = usePortal();
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <StatusPill tone={health?.tone ?? "neutral"} title={health?.detail}>
        {health?.label ?? "Checking API"}
      </StatusPill>
      <span className={TEXT_MUTED}>{health?.detail ?? "Checking whether the Kletia API answers."} Platform API v1.</span>
    </p>
  );
}

/**
 * Overview (`/developers`): what the API is with its status and base
 * URL, Start here (a key, a surface, the first call, the files), the
 * caller's project at a glance when a key is loaded, every surface to
 * build with, and how it fits.
 */
export default function OverviewPage() {
  const { key } = useSessionKey();
  const kind = portalKeyKind(key);
  const [lane, setLane] = useState<"testnet" | "production" | "any" | null>(null);
  const onLane = useCallback((next: "testnet" | "production" | "any" | null) => setLane(next), []);

  return (
    <>
      <PortalPageHeader
        eyebrow={<p className="ku-eyebrow">Developers · Platform API v1</p>}
        title={
          <>
            Put <span className="whitespace-nowrap">cross-network</span> routes inside your own product.
          </>
        }
        meta={<StatusLine />}
        intro="Plan, quote and prepare unsigned transactions on 9 networks; your users sign in their own wallets, Kletia tells your server when each leg lands and signs a receipt you can check without trusting us."
      >
        <div className="flex flex-wrap gap-3">
          <ButtonLink to={GET_KEY_HREF} className="[--kla-plate:#FFD60A]">
            <Icon name="key" size={18} />
            Get a key
          </ButtonLink>
          <ButtonLink to="/developers/api" variant="secondary">
            Open the API explorer
          </ButtonLink>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-6">
          <div className="flex w-full min-w-0 max-w-md flex-col gap-1.5">
            <p className={cx(LABEL, TEXT_MUTED)}>Base URL</p>
            <CodeBlock variant="inline" code={`${PLATFORM_ORIGIN}/v1`} label="the base URL" />
          </div>
          <p className="flex flex-wrap gap-x-5">
            <a href={`${PLATFORM_ORIGIN}/v1/openapi.json`} target="_blank" rel="noopener noreferrer" className={SPEC_LINK}>
              OpenAPI JSON
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a href={API_DOC_URL} target="_blank" rel="noopener noreferrer" className={SPEC_LINK}>
              Reference (Markdown)
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        </div>
      </PortalPageHeader>

      <StartHere keyLane={kind ? lane : null} />

      {kind ? <ProjectGlance apiKey={key} onLane={onLane} /> : null}

      <BuildWithGrid />

      <section aria-labelledby="fits-heading" className="flex min-w-0 flex-col gap-4 pt-12">
        <h2 id="fits-heading" className="font-display text-display-s font-bold">
          How it fits
        </h2>
        <figure className="m-0 min-w-0 max-w-[720px] [container-type:inline-size]">
          <SpecSheet />
          <figcaption className={cx("mt-5 max-w-2xl font-code text-xs font-medium leading-relaxed", TEXT_MUTED)}>
            Drawing KL-INT-01. Yellow boxes are yours: your site, your server
            {HAS_CONTRACTS ? " and, when you need it, your contract" : ""}. Kletia never sits between the user and their keys.
          </figcaption>
        </figure>
      </section>
    </>
  );
}
