import "./base.css";
import "./sign.css";

import type { ProtocolDescriptor } from "@kletia/core";
import type { ReactNode } from "react";

import { cx } from "../ui/styles";
import { Icon } from "./Icon";
import { categoryIcon, categoryWord, type IconName } from "./icons";
import { LineBullet } from "./LineBullet";
import { lineFor, type Line } from "./tokens";

/*
 * A protocol as a platform sign: an ink header with the platform number and
 * the category pictogram, then the venue, the networks it calls at (as line
 * bullets, testnets with a dashed edge) and what Kletia does there. Every
 * fact comes from the registry entry. No third-party marks are drawn.
 */

export type Service = "Execute" | "Quote" | "Discover";

const SERVICE_WORDS: Readonly<Record<string, Service>> = { execute: "Execute", quote: "Quote", discover: "Discover" };

export interface PlatformSignProps {
  /** Platform number on the sign (1-99), e.g. the protocol's position in the list. */
  readonly platform: number;
  /** The registry entry: name, id, category, networks and capabilities are read from it. */
  readonly protocol: ProtocolDescriptor;
  /** Replaces the registry summary. */
  readonly description?: string;
  /** Replaces the category pictogram. */
  readonly icon?: IconName;
  /** A plain link at the foot of the sign. */
  readonly action?: { readonly label: string; readonly href: string };
  /** Or any element (e.g. the router's <Link>); it is styled as the sign's call to action. */
  readonly cta?: ReactNode;
  readonly headingLevel?: 2 | 3 | 4;
  readonly className?: string;
}

export function PlatformSign({
  platform,
  protocol,
  description,
  icon,
  action,
  cta,
  headingLevel = 3,
  className,
}: PlatformSignProps) {
  const Heading = `h${headingLevel}` as const;
  const lines = protocol.networks.map((network) => lineFor(network)).filter((line): line is Line => line !== null);
  const services = protocol.capabilities.map((capability) => SERVICE_WORDS[capability]).filter(Boolean);
  return (
    <article className={cx("kla-psign", className)}>
      <header className="kla-psign__board">
        <span className="kla-psign__no" aria-hidden="true">
          <span className="kla-psign__no-k">Platform</span>
          {String(platform).padStart(2, "0")}
        </span>
        <span className="kla-psign__cat">
          {categoryWord(protocol.category)}
          <Icon name={icon ?? categoryIcon(protocol.category)} size={26} />
        </span>
      </header>
      <div className="kla-psign__body">
        <Heading className="kla-psign__name">{protocol.name}</Heading>
        <p className="kla-psign__id">{protocol.id}</p>
        <p className="kla-psign__desc">{description ?? protocol.summary}</p>
        {lines.length ? (
          <>
            <p className="kla-psign__k">Calls at</p>
            <ul className="kla-psign__lines">
              {lines.map((line) => (
                <li key={line.key}>
                  <LineBullet line={line} className={line.yard ? "kla-bullet--yard" : undefined} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {services.length ? (
          <ul className="kla-psign__services" aria-label="What Kletia does here">
            {services.map((service) => (
              <li key={service} data-service={service.toLowerCase()}>
                {service}
              </li>
            ))}
          </ul>
        ) : null}
        {cta ? (
          <div className="kla-psign__cta">{cta}</div>
        ) : action ? (
          <div className="kla-psign__cta">
            <a href={action.href}>
              {action.label}
              <span aria-hidden="true"> →</span>
            </a>
          </div>
        ) : null}
      </div>
    </article>
  );
}
