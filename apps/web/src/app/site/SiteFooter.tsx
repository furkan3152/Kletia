import { ArrowUpRight, KeyRound } from "lucide-react";

import { Link } from "../routes/Link";
import { KletiaMark } from "./KletiaMark";
import {
  API_DOC_URL,
  CONTRIBUTING_URL,
  GITHUB_URL,
  LICENSE_URL,
  SECURITY_POLICY_URL,
} from "./siteLinks";
import { CONTAINER, cx, FOCUS_RING, LABEL } from "./ui/styles";

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
      { label: "Networks & status", to: "/networks" },
      { label: "How it works", to: "/#how-it-works" },
      { label: "Security model", to: "/#security" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Quickstart", to: "/developers#quickstart" },
      { label: "API explorer", to: "/developers#explorer" },
      { label: "Endpoint reference", to: "/developers#reference" },
      { label: "Events & webhooks", to: "/developers#events" },
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

const LINK = "inline-flex min-h-9 items-center gap-1 text-sm text-white/75 transition-colors hover:text-[#FFD60A]";

/** Site footer: product, developer and company links plus the custody statement. */
export function SiteFooter() {
  return (
    <footer className="relative overflow-hidden border-t-[3px] border-[#1A1A1A] bg-[#111318] text-white dark:border-[#4B5563] dark:bg-[#060A14]">
      <div className={cx(CONTAINER, "relative z-10 pb-10 pt-16")}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-12 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="col-span-2 max-w-sm lg:col-span-1">
            <Link to="/" className={cx("inline-flex items-center gap-3", FOCUS_RING)} aria-label="Kletia home">
              <KletiaMark className="!bg-[#0B1220] !shadow-[3px_3px_0_#FFD60A] [&>img]:invert-0" />
              <span className="font-display text-2xl font-bold uppercase tracking-[-0.02em]">Kletia</span>
            </Link>
            <p className="mt-5 text-sm leading-relaxed text-white/75">
              Intent infrastructure for EVM networks and Solana: a console for users and an API, SDK
              and widget for teams that want intents in their own product.
            </p>
            <p className="mt-6 inline-flex items-start gap-2 border-2 border-[#FFD60A] px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-[#FFD60A]">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Non-custodial. Your keys sign every transaction.
            </p>
          </div>
          {COLUMNS.map((column) => (
            <nav key={column.title} aria-label={`${column.title} links`}>
              <h2 className={cx(LABEL, "mb-4 text-[#FFD60A]")}>{column.title}</h2>
              <ul className="space-y-1">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a href={link.to} target="_blank" rel="noopener noreferrer" className={cx(LINK, FOCUS_RING)}>
                        {link.label}
                        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <Link to={link.to} className={cx(LINK, FOCUS_RING)}>
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-16 flex flex-col gap-3 border-t-2 border-dashed border-white/15 pt-6 text-xs text-white/60 sm:flex-row sm:items-center sm:justify-between">
          <p>
            Open source under the{" "}
            <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className={cx("underline decoration-2 underline-offset-2 hover:text-white", FOCUS_RING)}>
              MIT License
            </a>
            . Development-stage software; not audited.
          </p>
          <p className="font-code">EVM · SVM · CAIP-2 / 10 / 19</p>
        </div>
      </div>
      <p
        aria-hidden="true"
        className="pointer-events-none select-none whitespace-nowrap px-4 pb-2 text-center font-display text-[22vw] font-bold uppercase leading-[0.8] tracking-[-0.01em] text-transparent [-webkit-text-stroke:2px_rgba(255,255,255,0.12)] lg:text-[16rem]"
      >
        Kletia
      </p>
    </footer>
  );
}
