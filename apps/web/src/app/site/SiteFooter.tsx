import { CHAINS, PROTOCOLS } from "@kletia/core";
import { ArrowUpRight } from "lucide-react";

import { Link } from "../routes/Link";
import { Icon } from "./art/Icon";
import { LineRule } from "./art/Ornaments";
import { KletiaMark } from "./KletiaMark";
import { protocolCountLabel } from "./protocolCount";
import {
  API_DOC_URL,
  CONTRIBUTING_URL,
  GITHUB_URL,
  LICENSE_URL,
  SECURITY_POLICY_URL,
} from "./siteLinks";
import { CONTAINER, cx, LABEL } from "./ui/styles";

interface FooterLink {
  readonly label: string;
  readonly to: string;
  readonly external?: boolean;
}

const COLUMNS: readonly { title: string; links: readonly FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Console", to: "/app" },
      { label: "Intent Studio", to: "/studio" },
      { label: "Protocols", to: "/protocols" },
      { label: "Networks and status", to: "/networks" },
      { label: "How it works", to: "/#how-it-works" },
      { label: "Security model", to: "/#security" },
      { label: "FAQ", to: "/#faq" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Quickstart", to: "/developers#quickstart" },
      { label: "API explorer", to: "/developers#explorer" },
      { label: "Endpoint reference", to: "/developers#reference" },
      { label: "Events and webhooks", to: "/developers#events" },
      { label: "Embed and widget", to: "/developers#embed" },
      { label: "Agents", to: "/developers#agents" },
      { label: "API v1 spec", to: API_DOC_URL, external: true },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "GitHub", to: GITHUB_URL, external: true },
      { label: "Security policy", to: SECURITY_POLICY_URL, external: true },
      { label: "Contributing", to: CONTRIBUTING_URL, external: true },
      { label: "MIT License", to: LICENSE_URL, external: true },
    ],
  },
];

const LINK =
  "group/flink inline-flex min-h-9 items-center gap-1 text-sm text-white/75 transition-colors duration-150 hover:text-[#FFD60A] motion-reduce:transition-none";
/** The footer is always dark: a yellow focus ring in both themes. */
const FOCUS_ON_INK =
  "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#FFD60A]";
const CHAIN_LIST = Object.values(CHAINS);
const PRODUCTION = CHAIN_LIST.filter((chain) => chain.lane !== "testnet").length;
const TESTNETS = CHAIN_LIST.length - PRODUCTION;
const PROTOCOL_COUNT = protocolCountLabel(PROTOCOLS);

/** Site footer: product, developer and company links plus the custody statement. */
export function SiteFooter() {
  return (
    <footer className="relative overflow-hidden border-t-[3px] border-[#1A1A1A] bg-[#111318] text-white dark:border-[#4B5563] dark:bg-[#060A14]">
      <div className={cx(CONTAINER, "relative z-10 pb-10 pt-16")}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-12 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="col-span-2 max-w-sm lg:col-span-1">
            <Link to="/" className={cx("group inline-flex items-center gap-3", FOCUS_ON_INK)} aria-label="Kletia home">
              <KletiaMark className="!bg-[#0B1220] !shadow-[3px_3px_0_#FFD60A] [&>img]:invert-0" />
              <span className="font-display text-2xl font-bold uppercase tracking-[-0.02em]">Kletia</span>
            </Link>
            <p className="mt-5 text-sm leading-relaxed text-white/75">
              Intent routing for EVM networks and Solana: a console for people, and an API, SDK and widget for teams
              who want routes inside their own product.
            </p>
            <p className="mt-6 inline-flex items-center gap-2.5 text-balance border-2 border-[#FFD60A] px-3 py-2 font-code text-xs font-bold uppercase tracking-[0.12em] text-[#FFD60A] [--kla-plate:#0052FF]">
              <Icon name="key" size={18} />
              The API never signs
            </p>
          </div>
          {COLUMNS.map((column) => (
            <nav key={column.title} aria-label={`${column.title} links`}>
              <h2 className={cx(LABEL, "mb-4 text-[#FFD60A]")}>{column.title}</h2>
              <ul className="space-y-1">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a href={link.to} target="_blank" rel="noopener noreferrer" className={cx(LINK, FOCUS_ON_INK)}>
                        {link.label}
                        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <Link to={link.to} className={cx(LINK, FOCUS_ON_INK)}>
                        <span className="transition-transform duration-150 ease-kl-standard group-hover/flink:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover/flink:translate-x-0">
                          {link.label}
                        </span>
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-16 flex flex-col gap-3 border-t-2 border-dashed border-white/15 pt-6 text-xs text-white/70 sm:flex-row sm:items-center sm:justify-between">
          <p>
            Open source under the{" "}
            <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className={cx("underline decoration-2 underline-offset-2 hover:text-white", FOCUS_ON_INK)}>
              MIT License
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            . Kletia is in development and has not been audited.
          </p>
          <p className="font-code">
            {PRODUCTION} production networks · {TESTNETS} testnets · {PROTOCOL_COUNT} in @kletia/core
          </p>
        </div>
      </div>
      {/* The Kletia line runs out under the page: a signage-yellow rule with station ticks. */}
      <div aria-hidden="true" className="relative z-10 pb-6 [--kla-ink:#000000] [--kla-shadow:#000000]">
        <LineRule className="opacity-95" />
      </div>
    </footer>
  );
}
