import { PROTOCOLS } from "@kletia/core";
import { ArrowUpRight } from "lucide-react";

import { BACKEND_URL } from "../../shared/config/runtime";
import { Icon, Nameplate, Vents } from "../kit";
import { Link } from "../routes/Link";
import { MotionToggle } from "./MotionToggle";
import { NETWORK_COUNT, PRODUCTION_NETWORK_COUNT, TEST_NETWORK_COUNT } from "./networkCount";
import { protocolCountLabel } from "./protocolCount";
import {
  CONTRIBUTING_URL,
  GITHUB_URL,
  LICENSE_URL,
  SECURITY_POLICY_URL,
} from "./siteLinks";
import { CONTAINER, cx } from "./ui/styles";

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
      { label: "Help", to: "/help" },
      { label: "Privacy & data", to: "/privacy" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Overview", to: "/developers" },
      { label: "API explorer", to: "/developers/api" },
      { label: "Embed builder", to: "/developers/embed" },
      { label: "Webhooks", to: "/developers/webhooks" },
      { label: "Errors", to: "/developers/errors" },
      { label: "Agents and MCP", to: "/developers/agents" },
      { label: "OpenAPI JSON", to: `${BACKEND_URL}/v1/openapi.json`, external: true },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Changelog", to: "/changelog" },
      { label: "GitHub", to: GITHUB_URL, external: true },
      { label: "Security policy", to: SECURITY_POLICY_URL, external: true },
      { label: "Contributing", to: CONTRIBUTING_URL, external: true },
      { label: "MIT License", to: LICENSE_URL, external: true },
    ],
  },
];

/** The footer is the machine's base plate, always night (chrome.css): links, lime focus ring. */
const LINK = "ks-flink";
const FOCUS_ON_INK = "";
const PROTOCOL_COUNT = protocolCountLabel(PROTOCOLS);

/** Site footer: product, developer and company links plus the custody statement. */
export function SiteFooter() {
  return (
    <footer className="ks-footer">
      <div className={cx(CONTAINER, "ks-foot-in")}>
        <div className="ks-foot-grid">
          <div className="ks-foot-brand">
            <Nameplate className="ks-foot-plate" model="K-01 intent machine" serial="MIT" />
            <p className="ks-foot-lede">
              Intent routing across {NETWORK_COUNT} networks, from one sentence: a console for people, and an API,
              SDK and widget for teams who want routes inside their own product.
            </p>
            <p className="ks-foot-seal">
              <Icon name="lock" />
              The API never signs
            </p>
          </div>
          {COLUMNS.map((column) => (
            <nav key={column.title} aria-label={`${column.title} links`}>
              <h2 className="ks-foot-h">{column.title}</h2>
              <ul className="ks-foot-list">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a href={link.to} target="_blank" rel="noopener noreferrer" className={cx(LINK, FOCUS_ON_INK)}>
                        {link.label}
                        <ArrowUpRight aria-hidden="true" />
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <Link to={link.to} className={cx(LINK, FOCUS_ON_INK)}>
                        <span>{link.label}</span>
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="ks-foot-base">
          <Vents className="ks-foot-vents" />
          <p>
            Open source under the{" "}
            <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className="ks-flink ks-flink--inline">
              MIT License
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            . Kletia is in development and has not been audited.
          </p>
          <p className="ks-foot-counts">
            {PRODUCTION_NETWORK_COUNT} production networks · {TEST_NETWORK_COUNT} test networks · {PROTOCOL_COUNT} in @kletia/core
          </p>
          {/* The footer is always night: the switch reads night control tokens and a lime focus ring here. */}
          <MotionToggle className="shrink-0 text-white [--kl-control:#94A3B8] [--kl-focus:#C6FF3A] [--kl-muted:#CBD5E1] [--kl-surface:#19191C]" />
        </div>
      </div>
    </footer>
  );
}
