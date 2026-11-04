import "./tickets.css";

import { useCallback, useEffect, type ReactNode } from "react";

import { ArtCanvas } from "./ArtCanvas";
import { LINES } from "./networkData";
import { loadNetworkFonts } from "./networkFonts";
import {
  ELYIA_H,
  ELYIA_W,
  elyiaScene,
  LYKIA_ASSEMBLE_S,
  LYKIA_H,
  LYKIA_W,
  lykiaScene,
  MOSAIC,
  paintPixels,
  paintTesserae,
} from "./pixelArt";

/*
 * The two line tickets. Each is printed in its product's own design language
 * (and keeps it in both of Kletia's themes: printed stock keeps its ink at
 * night); Kletia's frame around them is the ticket printer.
 */

export interface LineTicketProps {
  /** The ticket has left the printer: start the art (contours draw, stones set). */
  readonly ready?: boolean;
  /** Kletia's stamp, placed on the art where the mascot never goes. */
  readonly stamp?: ReactNode;
  /** Compact stub-less variant for narrow places. */
  readonly className?: string;
}

const ELY_SCALE = 4;
const LYK_TILE = 6;

export function ElyiaTicket({ ready = true, stamp, className }: LineTicketProps) {
  useEffect(() => loadNetworkFonts(), []);
  const paint = useCallback((ctx: CanvasRenderingContext2D, seconds: number, still: boolean) => {
    paintPixels(ctx, elyiaScene(seconds, still), ELY_SCALE);
  }, []);
  const line = LINES.elyia;
  return (
    <article className={className ? `elt ${className}` : "elt"} aria-label="Elyia ticket: Summit Line, from the Interchange to Elysium, HyperEVM and HyperCore. Testnet, in development.">
      <header className="elt-band">
        <span className="elt-tag">Summit Line</span>
        <span className="elt-admit">Admit one · ELY</span>
      </header>
      <div className="elt-art">
        <ArtCanvas
          width={ELYIA_W * ELY_SCALE}
          height={ELYIA_H * ELY_SCALE}
          paint={paint}
          fps={8}
          play={ready}
          pixelated
          label="Pixel art: a mountain in three altitude bands, HyperCore at the floor, HyperEVM on the ridge and Elysium at the summit, with Ely the goat climbing a trail to the flag."
        />
        {stamp}
        <ol className="elt-layers" aria-label="Altitude layers">
          <li data-band="summit">Summit · Elysium</li>
          <li data-band="ridge">Ridge · HyperEVM</li>
          <li data-band="floor">Floor · HyperCore</li>
        </ol>
      </div>
      <div className="elt-body">
        <p className="elt-name">
          {line.name}
          <span className="elt-guide">with Ely</span>
        </p>
        <p className="elt-sub">Intent, trading and portfolio deck</p>
        <dl className="elt-facts">
          <div>
            <dt>From</dt>
            <dd>Interchange</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>Summit · Elysium</dd>
          </div>
          <div>
            <dt>Rules</dt>
            <dd>{line.policy}</dd>
          </div>
          <div>
            <dt>Class</dt>
            <dd>Testnet</dd>
          </div>
        </dl>
      </div>
      <footer className="elt-stub">
        <span>No. ELY-0001</span>
        <span className="elt-status">In development</span>
      </footer>
    </article>
  );
}

export function LykiaTicket({ ready = true, stamp, className }: LineTicketProps) {
  useEffect(() => loadNetworkFonts(), []);
  const paint = useCallback((ctx: CanvasRenderingContext2D, seconds: number, still: boolean) => {
    paintTesserae(ctx, lykiaScene(seconds, still), {
      tile: LYK_TILE,
      gap: 1,
      grout: MOSAIC.grout,
      assemble: still ? 1 : Math.min(1, seconds / LYKIA_ASSEMBLE_S),
    });
  }, []);
  const line = LINES.lykia;
  return (
    <article className={className ? `lyt ${className}` : "lyt"} aria-label="Lykia ticket: Coast Line, from the Interchange to Arc mainnet. Live.">
      <header className="lyt-band">
        <span className="lyt-tag">Coast Line</span>
        <span className="lyt-admit">Arc · 5042</span>
      </header>
      <div className="lyt-edge" aria-hidden="true" />
      <div className="lyt-art" style={{ position: "relative" }}>
        <ArtCanvas
          width={LYKIA_W * LYK_TILE}
          height={LYKIA_H * LYK_TILE}
          paint={paint}
          fps={8}
          play={ready}
          label="Mosaic of tesserae: a Lycian coast with the sea, an olive tree and a rock tomb in the cliff, and Lyko the Anatolian shepherd dog trotting along the shore."
        />
        {stamp}
      </div>
      <div className="lyt-body">
        <p className="lyt-name">
          {line.name}
          <span className="lyt-guide">with Lyko</span>
        </p>
        <p className="lyt-sub">Policy-bound agents and stablecoin routing</p>
        <dl className="lyt-facts">
          <div>
            <dt>From</dt>
            <dd>Interchange</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>Arc mainnet</dd>
          </div>
          <div>
            <dt>Rules</dt>
            <dd>The {line.policy}</dd>
          </div>
          <div>
            <dt>Agents</dt>
            <dd>ERC-8004 Tags</dd>
          </div>
        </dl>
      </div>
      <footer className="lyt-stub">
        <span>No. LYK-5042</span>
        <span className="lyt-status">Live</span>
      </footer>
    </article>
  );
}
