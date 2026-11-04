import "./network.css";

import { ArrowRight } from "lucide-react";
import { useMemo } from "react";

import { keyClass } from "../../kit/keyClass";
import "../../kit/kit.css";
import { fetchHealth } from "../../../shared/platform/platformApi";
import { useApiResource } from "../../../shared/platform/useApiResource";
import { Link } from "../../routes/Link";
import { Eyebrow } from "../../site/ui/Eyebrow";
import { FamilyBoard } from "./FamilyBoard";
import { ElyiaTicket, LykiaTicket } from "./LineTickets";
import { LineMap } from "./LineMap";
import { boardClock, boardNote, kletiaReading } from "./boardText";
import { LiveFigures } from "./LiveFigures";
import { familyBoard, LINEAGE, LINES } from "./networkData";
import { TicketPrinter } from "./TicketPrinter";
import { TransferStations } from "./TransferStations";
import { useLykiaLive } from "./useLykiaLive";

function SectionHead({ index, kicker, title, children, id }: { readonly index: string; readonly kicker: string; readonly title: React.ReactNode; readonly children: React.ReactNode; readonly id: string }) {
  return (
    <div className="knet-sec-h">
      <div>
        <p className="knet-k">
          <b>{index}</b>
          {kicker}
        </p>
        <h2 className="knet-h2" id={id}>
          {title}
        </h2>
      </div>
      <p className="knet-p">{children}</p>
    </div>
  );
}

/** THE NETWORK: Kletia as the Interchange, and the lines that leave it. */
export default function NetworkPage() {
  const health = useApiResource("health", fetchHealth);
  const live = useLykiaLive();
  const kletia = kletiaReading(health);
  const rows = useMemo(() => familyBoard(kletia, live), [kletia.state, kletia.ok, kletia.total, live]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="knet">
      <header className="knet-hero">
        <div className="knet-wrap">
          <div className="knet-hero-grid">
            <div>
              <Eyebrow>The network</Eyebrow>
              <h1 className="knet-h1">
                One interchange. <em>Two lines.</em>
              </h1>
            </div>
            <p className="knet-lede">
              Kletia is the <strong>Interchange</strong>: its intent engine is the central station. Two products built from that engine leave it as lines:{" "}
              <strong>Elyia</strong>, the Summit Line to Elysium, HyperEVM and HyperCore, and <strong>Lykia</strong>, the Coast Line to Arc.
            </p>
          </div>
          <div style={{ marginTop: 36 }}>
            <FamilyBoard rows={rows} clock={boardClock(live)} busy={live.state === "loading"} note={boardNote(live)} />
            <LiveFigures live={live} />
          </div>
        </div>
      </header>

      <section className="knet-sec" aria-labelledby="map-heading">
        <div className="knet-wrap">
          <SectionHead index="01" kicker="Line map" title={<>Where the lines <em>come from.</em></>} id="map-heading">
            The lineage, drawn as it happened: Kletia&apos;s engine first, Elyia porting its concepts, Lykia building on that lineage for Arc.
          </SectionHead>
          <LineMap />
          <ol className="knm-lineage">
            <li>
              <b>01 · Interchange</b>
              Kletia&apos;s intent engine: the intent graph, the planner, the Rule Book and the developer platform.
            </li>
            {LINEAGE.map((step, index) => (
              <li key={step.to}>
                <b>
                  0{index + 2} · {LINES[step.to].line}
                </b>
                {step.verb}.
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="knet-sec" aria-labelledby="tickets-heading">
        <div className="knet-wrap">
          <SectionHead index="02" kicker="Tickets" title={<>Issued here. <em>Printed in their own ink.</em></>} id="tickets-heading">
            Each line keeps its own design: Elyia&apos;s Pixel Survey and Lykia&apos;s Mosaic. Kletia&apos;s printer issues the ticket and stamps it.
          </SectionHead>
          <div className="knet-tickets">
            <TicketPrinter
              label="Summit Line · Elyia"
              color={LINES.elyia.color}
              stamp="Issued"
              stampDetail="KLETIA INTERCHANGE"
              footer={
                <Link to="/network/elyia" className="knet-cta">
                  Elyia, the Summit Line <ArrowRight size={16} aria-hidden="true" />
                </Link>
              }
            >
              {(ready, stamp) => <ElyiaTicket ready={ready} stamp={stamp} />}
            </TicketPrinter>
            <TicketPrinter
              label="Coast Line · Lykia"
              color={LINES.lykia.color}
              stamp="Issued"
              stampDetail="KLETIA INTERCHANGE"
              footer={
                <Link to="/network/lykia" className="knet-cta">
                  Lykia, the Coast Line <ArrowRight size={16} aria-hidden="true" />
                </Link>
              }
            >
              {(ready, stamp) => <LykiaTicket ready={ready} stamp={stamp} />}
            </TicketPrinter>
          </div>
        </div>
      </section>

      <section className="knet-sec" aria-labelledby="transfer-heading">
        <div className="knet-wrap">
          <SectionHead index="03" kicker="Transfer stations" title={<>Same idea, <em>three names.</em></>} id="transfer-heading">
            Where the lines meet. Change trains here: each concept from Kletia&apos;s engine and what it is called on the Summit Line and the Coast Line.
          </SectionHead>
          <TransferStations />
          <div className="knet-keys">
            <Link to="/app" className={keyClass({ tone: "lime" })}>
              Open the desk
            </Link>
            <Link to="/developers" className={keyClass({})}>
              Build on the Interchange
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
