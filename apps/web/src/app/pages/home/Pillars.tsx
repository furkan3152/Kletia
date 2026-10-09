import { ArrowRight, Bot, Boxes, LayoutDashboard } from "lucide-react";
import React from "react";

import { Link } from "../../routes/Link";
import { Reveal } from "../../site/motion/Reveal";
import { useSpotlight } from "../../site/motion/useSpotlight";
import { Section } from "../../site/ui/Section";
import { cx, FOCUS_RING, INK_BORDER, LABEL, LIFT, SHADOW_HARD, SPOTLIGHT } from "../../site/ui/styles";

interface Pillar {
  readonly audience: string;
  readonly title: string;
  readonly body: string;
  readonly points: readonly string[];
  readonly cta: string;
  readonly to: string;
  readonly icon: React.ReactNode;
  readonly className: string;
  readonly muted: string;
  /** Spotlight colour and strength (ink at 8% on yellow so the light reads). */
  readonly spot: string;
  readonly spotStrength?: string;
}

const PILLARS: readonly Pillar[] = [
  {
    audience: "For users",
    title: "Console",
    body: "Connect an EVM wallet and a Solana wallet, type what you want, review every step, sign each one yourself.",
    points: ["Portfolio across networks", "Swap, bridge, stake, deposit", "Step timeline with evidence"],
    cta: "Launch app",
    to: "/app",
    icon: <LayoutDashboard className="h-7 w-7" aria-hidden="true" />,
    className: "bg-white text-[#1A1A1A] dark:bg-[#131E32] dark:text-[#F1F5F9]",
    muted: "text-[#45464B] dark:text-[#A9B6C8]",
    spot: "#0052FF",
  },
  {
    audience: "For builders",
    title: "Platform API, SDK & widget",
    body: "Put cross-network intents in your own product. One REST API, a typed TypeScript SDK, a drop-in React widget and an iframe embed.",
    points: ["/v1 REST + OpenAPI 3.1", "@kletia/sdk with executeIntent", "SSE streams + signed webhooks"],
    cta: "Read the docs",
    to: "/developers",
    icon: <Boxes className="h-7 w-7" aria-hidden="true" />,
    className: "bg-[#FFD60A] text-[#1A1A1A]",
    muted: "text-[#1A1A1A]/80",
    spot: "#1A1A1A",
    spotStrength: "8%",
  },
  {
    audience: "For autonomous agents",
    title: "Agents",
    body: "Agents plan with the same public API and pay for premium calls over HTTP. Signing stays with a human-controlled wallet.",
    points: ["x402 pay-per-call (USDC on Base)", "MCP context endpoints", "Deterministic REST planning"],
    cta: "Agent integration",
    to: "/developers#agents",
    icon: <Bot className="h-7 w-7" aria-hidden="true" />,
    className: "bg-[#111318] text-white dark:bg-[#060A14]",
    muted: "text-white/75",
    spot: "#FFD60A",
  },
];

function PillarCard({ pillar }: { readonly pillar: Pillar }) {
  const { ref, handlers, style } = useSpotlight<HTMLLIElement>({ color: pillar.spot });
  return (
    <li
      ref={ref}
      {...handlers}
      data-reveal-item
      style={{ ...style, ...(pillar.spotStrength ? ({ "--kl-spot-strength": pillar.spotStrength } as React.CSSProperties) : null) }}
      className={cx("group relative flex flex-col p-6 sm:p-8", INK_BORDER, SHADOW_HARD, LIFT, SPOTLIGHT, pillar.className)}
    >
      <div className="flex items-center justify-between">
        <p className={cx(LABEL, pillar.muted)}>{pillar.audience}</p>
        <span className="transition-transform duration-240 ease-kl-snap group-hover:-rotate-6 motion-reduce:transition-none motion-reduce:group-hover:rotate-0">
          {pillar.icon}
        </span>
      </div>
      <h3 className="mt-8 font-display text-3xl font-bold leading-[1.05] tracking-[-0.03em] sm:text-4xl">{pillar.title}</h3>
      <p className={cx("mt-4 text-[15px] leading-relaxed", pillar.muted)}>{pillar.body}</p>
      <ul className="mt-6 flex-1 space-y-2.5">
        {pillar.points.map((point) => (
          <li key={point} className="flex items-start gap-2.5 text-sm font-semibold">
            <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 bg-current" />
            {point}
          </li>
        ))}
      </ul>
      <Link
        to={pillar.to}
        className={cx(
          "mt-8 inline-flex items-center gap-2 self-start border-b-[3px] border-current pb-1 text-sm font-black uppercase tracking-[0.14em] after:absolute after:inset-0",
          FOCUS_RING,
        )}
      >
        {pillar.cta}
        <ArrowRight className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-1 motion-reduce:transition-none" aria-hidden="true" />
      </Link>
    </li>
  );
}

export function Pillars() {
  return (
    <Section
      id="product"
      tone="paper"
      bordered
      reveal
      eyebrow="Product"
      title="One engine. Three ways in."
      intro="The first-party console runs on the same /v1 platform API that partners integrate. What works for our users works in your product."
    >
      <Reveal as="ul" stagger className="grid gap-6 lg:grid-cols-3">
        {PILLARS.map((pillar) => (
          <PillarCard key={pillar.title} pillar={pillar} />
        ))}
      </Reveal>
    </Section>
  );
}
