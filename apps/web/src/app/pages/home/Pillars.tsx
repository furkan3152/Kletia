import { errorCatalogRows } from "@kletia/core";
import { ArrowRight, ArrowUpRight } from "lucide-react";

import { Link } from "../../routes/Link";
import type { IconName } from "../../site/art";
import { Icon } from "../../site/art/Icon";
import { Reveal } from "../../site/motion/Reveal";
import { CONTRACTS_DOC_URL } from "../../site/siteLinks";
import { Section } from "../../site/ui/Section";
import { cx, FOCUS_RING } from "../../site/ui/styles";

interface Way {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
  readonly points: readonly string[];
  readonly cta: string;
  readonly to: string;
  readonly external?: boolean;
  readonly icon: IconName;
  /** Grid span on the 12-column layout (7/5, then 5/7). */
  readonly span: string;
  /** The one signage card: yellow stock, ink text. */
  readonly signage?: boolean;
}

const ERROR_CODES = errorCatalogRows().length;

const WAYS: readonly Way[] = [
  {
    kicker: "For your backend",
    title: "Platform API and SDK",
    body: "REST with an OpenAPI 3.1 spec, a typed TypeScript SDK and HMAC-signed webhooks. Plan on your server and let the user sign in the browser.",
    points: ["GET /v1/openapi.json", `${ERROR_CODES} stable error codes`, "Server-Sent Events per intent"],
    cta: "Read the API reference",
    to: "/developers#explorer",
    icon: "sdk",
    span: "lg:col-span-7",
  },
  {
    kicker: "For your page",
    title: "Widget and iframe",
    body: "Drop the React widget or the /embed iframe into your page. It runs the whole route; your users sign with the wallet they already use.",
    points: ["React 18 component", "Iframe with postMessage events", "Light, dark or transparent background"],
    cta: "Open the embed guide",
    to: "/developers#embed",
    icon: "embed",
    span: "lg:col-span-5",
  },
  {
    kicker: "For your own contract",
    title: "Your contract as a leg",
    body: "Register a contract you deployed and add a call to it as one leg of the route, after a bridge or a swap. The user still signs it and Kletia still checks it on-chain.",
    points: ["EVM ABI calls", "Solana Actions", "Same evidence rules as every leg"],
    cta: "Read the contract guide",
    to: CONTRACTS_DOC_URL,
    external: true,
    icon: "contract",
    span: "lg:col-span-5",
    signage: true,
  },
  {
    kicker: "For people",
    title: "The console",
    body: "Connect an EVM wallet and a Solana wallet, type a route, read every leg and sign each one yourself.",
    points: ["Portfolio across networks", "Step timeline with evidence"],
    cta: "Open the console",
    to: "/app",
    icon: "board",
    span: "lg:col-span-7",
  },
];

/** A station entrance sign over each way in: the letter plate, then where it leads. */
function EntranceHead({ way, letter }: { readonly way: Way; readonly letter: string }) {
  return (
    <div className="-mx-6 -mt-6 mb-6 flex items-center justify-between gap-3 border-b-[3px] border-[#1A1A1A] bg-[#1A1A1A] px-4 py-2.5 text-[#F4F1EA] [--kla-plate:#FFD60A] dark:bg-[#060A14] sm:-mx-7 sm:-mt-7 sm:px-5">
      <p className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center bg-[#F4F1EA] font-display text-xl font-bold leading-none text-[#1A1A1A]"
        >
          {letter}
        </span>
        <span className="font-code text-[10.5px] font-bold uppercase leading-snug tracking-[0.16em]">
          Entrance {letter} · {way.kicker}
        </span>
      </p>
      <Icon name={way.icon} size={26} />
    </div>
  );
}

function WayCard({ way, letter }: { readonly way: Way; readonly letter: string }) {
  const muted = way.signage ? "text-[#1A1A1A]/85" : "text-[#45464B] dark:text-[#A9B6C8]";
  const linkClass = cx(
    "group/cta mt-auto inline-flex min-h-11 items-center gap-2 self-start pt-6 text-xs font-black uppercase tracking-[0.12em] underline decoration-2 underline-offset-4",
    way.signage ? "text-[#1A1A1A]" : "text-[#0047E0] dark:text-[#7EA6FF]",
    FOCUS_RING,
    way.signage && "focus-visible:!outline-[#1A1A1A]",
  );
  return (
    <li
      data-reveal-item
      className={cx(
        "flex min-w-0 flex-col border-[3px] p-6 shadow-hard-md sm:p-7",
        way.signage
          ? "border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] [--kla-plate:#FFFFFF] dark:shadow-[5px_5px_0_#475569]"
          : "border-[#1A1A1A] bg-[#FBFAF7] dark:border-[#4B5563] dark:bg-[#131E32]",
        way.span,
      )}
    >
      <EntranceHead way={way} letter={letter} />
      <h3 className="font-display text-2xl font-bold leading-tight tracking-[-0.02em]">{way.title}</h3>
      <p className={cx("mt-3 text-[15px] leading-relaxed", muted)}>{way.body}</p>
      <ul className="mt-4 space-y-1 font-code text-[13px] font-semibold leading-snug">
        {way.points.map((point) => (
          <li key={point} className="flex gap-2">
            <span aria-hidden="true" className={way.signage ? "text-[#1A1A1A]" : "text-[#0047E0] dark:text-[#7EA6FF]"}>
              →
            </span>
            {point}
          </li>
        ))}
      </ul>
      {way.external ? (
        <a href={way.to} target="_blank" rel="noopener noreferrer" className={linkClass}>
          {way.cta}
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <Link to={way.to} className={linkClass}>
          {way.cta}
          <ArrowRight className="h-4 w-4 transition-transform duration-150 group-hover/cta:translate-x-1 motion-reduce:transition-none" aria-hidden="true" />
        </Link>
      )}
    </li>
  );
}

/** Integrations: the four ways in, signed like station entrances A to D, on an asymmetric 7/5 grid. */
export function Pillars() {
  return (
    <Section
      id="product"
      platform={4}
      eyebrow="Ways in"
      reveal
      title="Use Kletia as an API, a widget or a finished app."
      intro="The console you can open today runs on the same /v1 API you would call from your own product."
    >
      <Reveal as="ul" stagger className="grid gap-6 md:grid-cols-2 lg:grid-cols-12">
        {WAYS.map((way, index) => (
          <WayCard key={way.title} way={way} letter={String.fromCharCode(65 + index)} />
        ))}
      </Reveal>
    </Section>
  );
}
