import "./base.css";
import "./spec.css";

import { PROTOCOLS } from "@kletia/core";
import { useId } from "react";

import { cx } from "../ui/styles";
import { PRODUCTION_LINES } from "./tokens";

/*
 * Developers page drawing: how a team's own site, server and contract sit
 * around the Kletia API, as a blueprint with a title block. role="img" with a
 * text description; the same flow should also be written out in the page
 * copy. Two sheets: landscape from 560 px of width, portrait below it.
 */

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly title: string;
  readonly sub: readonly string[];
  readonly yours?: boolean;
}

interface Note {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly anchor?: "start" | "middle" | "end";
  /** Rotated -90 degrees about its own point. */
  readonly vertical?: boolean;
  /** Set a size smaller, for a note squeezed between two boxes. */
  readonly tight?: boolean;
}

interface Sheet {
  readonly width: number;
  readonly height: number;
  readonly boxHeight: number;
  readonly boxes: readonly Box[];
  readonly flows: readonly { readonly d: string; readonly dashed?: boolean }[];
  readonly notes: readonly Note[];
  readonly block: { readonly x: number; readonly y: number; readonly cells: readonly { readonly w: number; readonly text: string }[] };
}

/** Custom contract calls are in the registry (bring your own contract), so the drawing shows your contract. */
const HAS_CONTRACTS = PROTOCOLS.some((protocol) => protocol.category === "custom");

/** "Base, Solana" and "and 4 more", from the registry's production lines. */
function networkSub(): readonly [string, string] {
  const names = PRODUCTION_LINES.map((line) => line.shortName);
  if (names.length <= 2) return [names.join(" and "), ""];
  const second = PRODUCTION_LINES.find((line) => line.gauge === "svm")?.shortName ?? names[1];
  return [`${names[0]}, ${second}`, `and ${names.length - 2} more`];
}

function landscape(): Sheet {
  const boxes: Box[] = [
    { x: 30, y: 56, w: 160, title: "YOUR SITE", sub: ["browser · widget · embed"], yours: true },
    { x: 300, y: 56, w: 160, title: "KLETIA API v1", sub: ["plan · quote · verify"] },
    { x: 570, y: 56, w: 160, title: "USER'S WALLET", sub: ["signs every leg"] },
    { x: 30, y: 252, w: 160, title: "YOUR SERVER", sub: ["API key · webhooks"], yours: true },
    { x: 300, y: 252, w: 160, title: "NETWORK", sub: [networkSub().filter(Boolean).join(" ")] },
  ];
  const flows: { d: string; dashed?: boolean }[] = [
    { d: "M190 82H297" },
    { d: "M300 108H193" },
    { d: "M110 56V30H650V53" },
    { d: "M650 132V196H420V249" },
    { d: "M340 252V135" },
    { d: "M318 132V216H110V249" },
  ];
  const notes: Note[] = [
    { x: 245, y: 74, text: "POST /v1/intents", anchor: "middle", tight: true },
    { x: 245, y: 125, text: "unsigned tx", anchor: "middle", tight: true },
    { x: 380, y: 23, text: "sign request · EIP-1193 · Wallet Standard", anchor: "middle" },
    { x: 535, y: 189, text: "signed tx", anchor: "middle" },
    { x: 348, y: 176, text: "evidence" },
    { x: 214, y: 209, text: "webhook · HMAC-SHA256", anchor: "middle" },
  ];
  if (HAS_CONTRACTS) {
    boxes.push({ x: 570, y: 252, w: 160, title: "YOUR CONTRACT", sub: ["called as one leg"], yours: true });
    flows.push({ d: "M460 290H567", dashed: true });
    notes.push({ x: 514, y: 282, text: "ABI call", anchor: "middle" });
  }
  return { width: 760, height: 390, boxHeight: 76, boxes, flows, notes, block: {
      x: 450,
      y: 340,
      cells: [
        { w: 110, text: "DWG KL-INT-01" },
        { w: 90, text: "INTEGRATION" },
        { w: 50, text: "REV 4" },
        { w: 40, text: "NTS" },
      ],
    },
  };
}

function portrait(): Sheet {
  const boxes: Box[] = [
    { x: 30, y: 40, w: 144, title: "YOUR SITE", sub: ["browser · widget", "or embed"], yours: true },
    { x: 30, y: 196, w: 144, title: "KLETIA API v1", sub: ["plan · quote · verify"] },
    { x: 30, y: 352, w: 144, title: "USER'S WALLET", sub: ["signs every leg"] },
    { x: 30, y: 508, w: 144, title: "NETWORK", sub: networkSub().filter(Boolean) },
    { x: 226, y: 196, w: 118, title: "YOUR SERVER", sub: ["API key,", "webhooks"], yours: true },
  ];
  const flows: { d: string; dashed?: boolean }[] = [
    { d: "M50 112V193" },
    { d: "M150 196V115" },
    { d: "M30 76H18V388H27" },
    { d: "M102 424V505" },
    { d: "M150 508V488H200V250H177" },
    { d: "M174 226H223" },
  ];
  const notes: Note[] = [
    { x: 58, y: 150, text: "POST /v1/intents" },
    { x: 158, y: 172, text: "unsigned tx" },
    { x: 18, y: 250, text: "sign request", anchor: "middle", vertical: true },
    { x: 110, y: 470, text: "signed tx" },
    { x: 200, y: 372, text: "evidence", anchor: "middle", vertical: true },
    { x: 200, y: 216, text: "webhook", anchor: "middle", tight: true },
  ];
  if (HAS_CONTRACTS) {
    boxes.push({ x: 226, y: 508, w: 118, title: "YOUR CONTRACT", sub: ["called as", "one leg"], yours: true });
    flows.push({ d: "M174 552H223", dashed: true });
    notes.push({ x: 200, y: 544, text: "ABI call", anchor: "middle", tight: true });
  }
  return { width: 360, height: 640, boxHeight: 72, boxes, flows, notes, block: {
      x: 150,
      y: 596,
      cells: [
        { w: 104, text: "DWG KL-INT-01" },
        { w: 52, text: "REV 4" },
        { w: 38, text: "NTS" },
      ],
    },
  };
}

const LANDSCAPE = landscape();
const PORTRAIT = portrait();

function Drawing({ sheet, id, orientation }: { readonly sheet: Sheet; readonly id: string; readonly orientation: string }) {
  const arrow = `${id}-a`;
  const grid = `${id}-g`;
  const major = `${id}-m`;
  const titleId = `${id}-t`;
  const descId = `${id}-d`;
  const cellX = sheet.block.cells.map((_, index) =>
    sheet.block.cells.slice(0, index).reduce((sum, cell) => sum + cell.w, sheet.block.x),
  );
  const blockWidth = sheet.block.cells.reduce((sum, cell) => sum + cell.w, 0);
  return (
    <svg
      viewBox={`0 0 ${sheet.width} ${sheet.height}`}
      className={cx("kla-spec", `kla-spec--${orientation}`)}
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
      focusable="false"
    >
      <title id={titleId}>Integration drawing</title>
      <desc id={descId}>
        {`Your site posts an intent to the Kletia API and gets back a plan with unsigned transactions. The user's wallet signs each leg and sends it to the network${
          HAS_CONTRACTS ? ", which can call your own contract as one leg" : ""
        }. Kletia reads the evidence on-chain and sends a signed webhook to your server.`}
      </desc>
      <defs>
        <pattern id={grid} width={16} height={16} patternUnits="userSpaceOnUse">
          <path d="M16 0H0V16" fill="none" className="kla-spec__grid" />
        </pattern>
        <pattern id={major} width={80} height={80} patternUnits="userSpaceOnUse">
          <path d="M80 0H0V80" fill="none" className="kla-spec__grid kla-spec__grid--major" />
        </pattern>
        <marker id={arrow} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" className="kla-spec__head" />
        </marker>
      </defs>
      <rect width={sheet.width} height={sheet.height} className="kla-spec__paper" />
      <rect width={sheet.width} height={sheet.height} fill={`url(#${grid})`} />
      <rect width={sheet.width} height={sheet.height} fill={`url(#${major})`} />
      <rect x={10} y={10} width={sheet.width - 20} height={sheet.height - 20} className="kla-spec__frame" />

      {sheet.boxes.map((box) => (
        <g key={box.title}>
          <rect
            x={box.x}
            y={box.y}
            width={box.w}
            height={sheet.boxHeight}
            className={box.yours ? "kla-spec__box kla-spec__box--yours" : "kla-spec__box"}
          />
          {box.yours ? (
            <text x={box.x + box.w - 8} y={box.y + 16} textAnchor="end" className="kla-spec__tag">
              YOURS
            </text>
          ) : null}
          <text x={box.x + 12} y={box.y + 36} className="kla-spec__title">
            {box.title}
          </text>
          {box.sub.map((line, index) => (
            <text key={line} x={box.x + 12} y={box.y + 54 + index * 13} className="kla-spec__sub">
              {line}
            </text>
          ))}
        </g>
      ))}

      <g className="kla-spec__flow">
        {sheet.flows.map((flow) => (
          <path key={flow.d} d={flow.d} className={flow.dashed ? "kla-spec__dashed" : undefined} markerEnd={`url(#${arrow})`} />
        ))}
      </g>

      {sheet.notes.map((note) => (
        <text
          key={note.text}
          x={note.x}
          y={note.y}
          textAnchor={note.anchor ?? "start"}
          dominantBaseline={note.vertical ? "middle" : undefined}
          transform={note.vertical ? `rotate(-90 ${note.x} ${note.y})` : undefined}
          className={cx("kla-spec__note", note.tight && "kla-spec__note--tight")}
        >
          {note.text}
        </text>
      ))}

      {/* Title block. */}
      <g className="kla-spec__block">
        <rect x={sheet.block.x} y={sheet.block.y} width={blockWidth} height={32} />
        <path d={cellX.slice(1).map((x) => `M${x} ${sheet.block.y}V${sheet.block.y + 32}`).join("")} />
      </g>
      {sheet.block.cells.map((cell, index) => (
        <text key={cell.text} x={cellX[index]! + 10} y={sheet.block.y + 20} className="kla-spec__note kla-spec__note--block">
          {cell.text}
        </text>
      ))}
    </svg>
  );
}

export function SpecSheet({ className }: { readonly className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <div className={cx("kla-spec-host", className)}>
      <Drawing sheet={LANDSCAPE} id={`${id}-l`} orientation="landscape" />
      <Drawing sheet={PORTRAIT} id={`${id}-p`} orientation="portrait" />
    </div>
  );
}
