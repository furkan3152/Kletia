/**
 * The network on the landing page: Kletia is the Interchange, and the lines
 * built from its engine leave it. A departure board (Kletia from the tape's
 * own GET /v1/health, Lykia live through Kletia's relay), the line map, and
 * one card per line with its mascot drawn in the line's own art. The pixel
 * fonts stay on /network: here the art is canvas only.
 */
import "../network/network.css";
import "./networkSection.css";

import { useCallback, useMemo } from "react";

import { keyClass } from "../../kit/keyClass";
import { Link } from "../../routes/Link";
import { ArtCanvas } from "../network/ArtCanvas";
import { FamilyBoard } from "../network/FamilyBoard";
import { LineMap } from "../network/LineMap";
import { boardClock, boardNote } from "../network/boardText";
import { DEPARTURES, familyBoard, type FamilyLine, type KletiaReading } from "../network/networkData";
import { ELY_CLIMB, ELY_PALETTE, grid, LYKO_PALETTE, LYKO_TROT, MOSAIC, paintPixels, paintTesserae, stamp, SURVEY } from "../network/pixelArt";
import { useLykiaLive } from "../network/useLykiaLive";
import { Ico } from "./Ico";
import type { HomeLive } from "./homeLive";

function ElyBadge() {
  const paint = useCallback((ctx: CanvasRenderingContext2D, seconds: number, still: boolean) => {
    const g = grid(22, 16, SURVEY.card);
    for (let x = 0; x < 22; x += 1) g[15]![x] = x % 2 ? "#8A5A2B" : "#B07A44";
    stamp(g, ELY_CLIMB[still ? 0 : Math.floor(Math.max(0, seconds) * 4) % 2]!, 2, 1, ELY_PALETTE);
    paintPixels(ctx, g, 4);
  }, []);
  return <ArtCanvas width={88} height={64} paint={paint} fps={4} pixelated label="Ely the goat, in Elyia's Pixel Survey pixels." className="nsec-art" />;
}

function LykoBadge() {
  const paint = useCallback((ctx: CanvasRenderingContext2D, seconds: number, still: boolean) => {
    const g = grid(36, 23, MOSAIC.cream);
    for (let x = 0; x < 36; x += 1) g[22]![x] = x % 3 ? MOSAIC.sand : MOSAIC.ochre;
    stamp(g, LYKO_TROT[still ? 0 : Math.floor(Math.max(0, seconds) * 4) % 2]!, 2, 2, LYKO_PALETTE);
    paintTesserae(ctx, g, { tile: 4, gap: 1, grout: MOSAIC.grout });
  }, []);
  return <ArtCanvas width={144} height={92} paint={paint} fps={4} label="Lyko the Anatolian shepherd dog, laid in Lykia's Mosaic tesserae." className="nsec-art" />;
}

function LineCard({ line }: { readonly line: FamilyLine }) {
  return (
    <Link to={line.page ?? "/network"} className="nsec-card" style={{ ["--nsec-line" as string]: line.color }}>
      <span className="nsec-badge" data-line={line.id}>
        {line.id === "elyia" ? <ElyBadge /> : <LykoBadge />}
      </span>
      <span className="nsec-body">
        <span className="nsec-code" style={{ background: line.color, color: line.on }}>
          {line.code}
        </span>
        <b>
          {line.name} · {line.line}
        </b>
        <span className="nsec-sum">{line.summary}</span>
        <span className="nsec-meta">
          {line.networks.join(" · ")} — {line.status}
        </span>
      </span>
      <span className="nsec-go" aria-hidden="true">
        <Ico name="arr" />
      </span>
    </Link>
  );
}

export function NetworkSection({ live }: { readonly live: HomeLive }) {
  const lykia = useLykiaLive();
  const answer = live.report && Array.isArray(live.report.networks) ? { ok: live.report.networks.filter((entry) => entry.ok).length, total: live.report.networks.length } : null;
  const kletia: KletiaReading = answer ? { state: "live", ...answer } : { state: live.state === "loading" ? "loading" : "offline" };
  const rows = useMemo(() => familyBoard(kletia, lykia), [kletia.state, kletia.ok, kletia.total, lykia]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="sec nsec" id="network" aria-labelledby="network-heading">
      <div className="wrap">
        <div className="sec-h">
          <div>
            <div className="sec-k">
              <span className="led">05</span>
              <span className="silk">The network</span>
            </div>
            <h2 className="sec-t" id="network-heading">
              One interchange. <em>Two lines.</em>
            </h2>
          </div>
          <p className="sec-p">Kletia is the Interchange: the central station of its intent engine. Elyia and Lykia are lines built from it, each in its own design, each live on the board.</p>
        </div>
        <FamilyBoard rows={rows} clock={boardClock(lykia)} busy={lykia.state === "loading"} note={boardNote(lykia)} />
        <div className="nsec-grid">
          <LineMap caption={false} />
          <div className="nsec-cards">
            {DEPARTURES.map((line) => (
              <LineCard key={line.id} line={line} />
            ))}
            <Link to="/network" className={keyClass({ tone: "lime" }, "nsec-cta")}>
              See the network
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
