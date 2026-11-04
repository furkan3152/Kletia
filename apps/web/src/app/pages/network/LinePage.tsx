import "./network.css";

import { ArrowLeft, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

import { keyClass } from "../../kit/keyClass";
import "../../kit/kit.css";
import { Link } from "../../routes/Link";
import { Eyebrow } from "../../site/ui/Eyebrow";
import { ELYIA_LAYERS, ELYIA_PUBLIC, LINE_DETAILS, LINES, LYKIA_CONTRACTS, type LineId } from "./networkData";
import { ElyiaTicket, LykiaTicket } from "./LineTickets";
import { LiveFigures } from "./LiveFigures";
import { TicketPrinter } from "./TicketPrinter";
import { TransferStations } from "./TransferStations";
import { useLykiaLive } from "./useLykiaLive";

type ProductId = Exclude<LineId, "kletia">;

function Facts({ id }: { readonly id: ProductId }) {
  const line = LINES[id];
  const rows: readonly [string, ReactNode][] = [
    ["Line", `${line.line} · ${line.code}`],
    ["Networks", line.networks.join(", ")],
    ["Status", line.status],
    ["Policy layer", id === "lykia" ? `The ${line.policy}` : line.policy],
    ["Ask", line.ask],
    ["Guide", line.mascot ? `${line.mascot.name}, ${line.mascot.kind}` : "—"],
    ["Design", line.design],
  ];
  return (
    <dl className="knd-facts">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Links({ id }: { readonly id: ProductId }) {
  const line = LINES[id];
  if (id === "elyia" && !ELYIA_PUBLIC) {
    return (
      <p className="knd-note">
        <span aria-hidden="true">⛰</span>
        <span>
          <b>In development.</b> Elyia runs on testnets and has no public repository or API host yet. This page will link to them when they open.
        </span>
      </p>
    );
  }
  return (
    <div className="knet-keys" style={{ marginTop: 0 }}>
      {line.links.map((link, index) => (
        <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className={keyClass({ tone: index === 0 ? "lime" : "default" })}>
          {link.label}
          <ArrowUpRight size={16} aria-hidden="true" />
          <span className="kla-sr"> (opens in a new tab)</span>
        </a>
      ))}
    </div>
  );
}

function LykiaLiveSection() {
  const live = useLykiaLive();
  return <LiveFigures live={live} />;
}

/** A line's detail page: its ticket, what it does, what it shares with Kletia, and where to go. */
export function LinePage({ id }: { readonly id: ProductId }) {
  const line = LINES[id];
  const detail = LINE_DETAILS[id];
  return (
    <div className="knet">
      <header className="knet-hero">
        <div className="knet-wrap">
          <Link to="/network" className="knd-back">
            <ArrowLeft size={16} aria-hidden="true" /> The network
          </Link>
          <div className="knd-grid" style={{ marginTop: 18 }}>
            <div>
              <Eyebrow>
                {line.line} · {line.status}
              </Eyebrow>
              <h1 className="knet-h1">
                {line.name}, <em>the {line.line}.</em>
              </h1>
              <p className="knet-lede" style={{ marginTop: 18 }}>
                {line.summary}
              </p>
              <div style={{ marginTop: 26 }}>
                <Facts id={id} />
              </div>
            </div>
            <TicketPrinter label={`${line.line} · ${line.name}`} color={line.color} stamp="Issued" stampDetail="KLETIA INTERCHANGE">
              {(ready, stamp) => (id === "elyia" ? <ElyiaTicket ready={ready} stamp={stamp} /> : <LykiaTicket ready={ready} stamp={stamp} />)}
            </TicketPrinter>
          </div>
        </div>
      </header>

      <section className="knet-sec" aria-labelledby="does-heading">
        <div className="knet-wrap">
          <div className="knet-sec-h">
            <div>
              <p className="knet-k">
                <b>01</b>What it does
              </p>
              <h2 className="knet-h2" id="does-heading">
                {detail.headline}
              </h2>
            </div>
            <Links id={id} />
          </div>
          <ul className="knd-list">
            {detail.does.map((item) => (
              <li key={item.title}>
                <b>{item.title}</b>
                {item.text}
              </li>
            ))}
          </ul>
          {id === "elyia" ? (
            <ol className="knd-layers" style={{ marginTop: 24 }} aria-label="Elyia's altitude layers, top to bottom">
              {ELYIA_LAYERS.map((layer) => (
                <li key={layer.band}>
                  <i style={{ background: layer.color }} aria-hidden="true" />
                  <span>
                    <b>
                      {layer.band} · {layer.network}
                    </b>{" "}
                    {layer.role}.
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <div style={{ marginTop: 8 }}>
              <LykiaLiveSection />
            </div>
          )}
        </div>
      </section>

      <section className="knet-sec" aria-labelledby="shares-heading">
        <div className="knet-wrap">
          <div className="knet-sec-h">
            <div>
              <p className="knet-k">
                <b>02</b>Transfer stations
              </p>
              <h2 className="knet-h2" id="shares-heading">
                What it shares <em>with Kletia.</em>
              </h2>
            </div>
            <p className="knet-p">{detail.shares}</p>
          </div>
          <TransferStations only={id} />
        </div>
      </section>

      {id === "lykia" ? (
        <section className="knet-sec" aria-labelledby="contracts-heading">
          <div className="knet-wrap">
            <div className="knet-sec-h">
              <div>
                <p className="knet-k">
                  <b>03</b>On chain
                </p>
                <h2 className="knet-h2" id="contracts-heading">
                  Mainnet contracts on Arc.
                </h2>
              </div>
              <p className="knet-p">The three contracts Lykia runs on Arc mainnet, as its own stats endpoint reports them.</p>
            </div>
            <ul className="knd-contracts">
              {LYKIA_CONTRACTS.map((contract) => (
                <li key={contract.address}>
                  <b>{contract.name}</b>
                  <code>{contract.address}</code>
                  <span>{contract.role}.</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </div>
  );
}
