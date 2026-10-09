/**
 * Share cards of intent links (links design §5.3): an Interchange ticket in
 * the departure-board dot-matrix face, PNG, no new dependency. `wide`
 * 1200×600 (og:image, X `summary_large_image`), `square` 600×600 (the blink
 * icon). A fixed "KLETIA INTENT LINK" plate, the title, the route strip
 * (funding networks → destination), the publisher, the domain line and a
 * round VERIFIED / UNVERIFIED seal; the stub prints the amount bounds (or
 * the delivered amount and payee) and the expiry. Unusable links get the
 * `void` variant. No live counters: cards are cached per revision (memory
 * LRU of 500 PNGs, ETag `"lk_…-r<rev>-<variant>-<state>"`).
 */
import { CHAINS, type NetworkKey } from "@kletia/core";
import { Canvas, drawText, fitPitch, textWidth, wrapText } from "./dotMatrix.js";
import { effectiveLinkStatus } from "./service.js";
import type { LinkRecord } from "./store.js";

export type CardVariant = "wide" | "square";
export type CardState = "ok" | "void";

const INK = "#1A1A1A";
const PAPER = "#F4F1EA";
const STOCK = "#FFFCF2";
const YELLOW = "#FFD60A";
const STAMP = "#0B7A4B";
const WARN = "#C8102E";
const MUTED = "#45464B";

/** Line bullet code, colour and text colour per network. */
const LINES: Readonly<Record<NetworkKey, readonly [string, string, string]>> = {
  ethereum: ["ETH", "#627EEA", "#0B1120"],
  base: ["BASE", "#0052FF", "#FFFFFF"],
  arbitrum: ["ARB", "#28A0F0", "#0B1120"],
  optimism: ["OP", "#FF0420", "#0B1120"],
  polygon: ["POL", "#8247E5", "#FFFFFF"],
  solana: ["SOL", "#9945FF", "#FFFFFF"],
  arc: ["ARC", "#1A1A1A", "#FFFFFF"],
  "arbitrum-sepolia": ["ARBT", "#28A0F0", "#0B1120"],
  "solana-devnet": ["SOLD", "#9945FF", "#FFFFFF"],
} as Readonly<Record<NetworkKey, readonly [string, string, string]>>;

function line(network: NetworkKey): readonly [string, string, string] {
  return LINES[network] ?? [network.slice(0, 4).toUpperCase(), INK, "#FFFFFF"];
}

function dateText(iso: string): string {
  const date = new Date(iso);
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function grouped(value: string): string {
  const [whole = "0", fraction] = value.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",")}${fraction ? `.${fraction}` : ""}`;
}

/** What the stub prints (two or three rows). */
export function stubRows(record: LinkRecord): [string, string][] {
  const { definition, pins } = record;
  const rows: [string, string][] = [];
  const first = definition.destination.actions[0];
  if (definition.funding.amount.mode === "deliver") {
    rows.push(["AMOUNT", `${grouped(String(first?.amount ?? ""))} ${pins.destinationAsset.symbol}`]);
    const payee = pins.recipients[0];
    if (payee) rows.push(["TO", payee.name ?? `${payee.account.split(":").pop()?.slice(0, 6)}...${payee.account.slice(-4)}`]);
  } else {
    const [symbol, bounds] = Object.entries(definition.funding.amount.bounds)[0] ?? [];
    if (symbol && bounds) rows.push(["AMOUNT", `${grouped(bounds.min)}-${grouped(bounds.max)} ${symbol}`]);
    const last = definition.destination.actions[definition.destination.actions.length - 1];
    rows.push(["ARRIVES AS", String(last?.to ?? pins.destinationAsset.symbol)]);
  }
  rows.push(record.maxUses !== null ? ["USES LEFT", String(Math.max(0, record.maxUses - record.used))] : ["VALID TO", dateText(definition.expiresAt)]);
  return rows.slice(0, 3);
}

export function cardState(record: LinkRecord, now: number): CardState {
  return ["deleted", "suspended", "expired"].includes(effectiveLinkStatus(record, now)) ? "void" : "ok";
}

/** Renders the card PNG (deterministic for a given record, variant, state and web host). */
export function renderLinkCard(record: LinkRecord, variant: CardVariant, state: CardState, host: string): Buffer {
  const square = variant === "square";
  const W = square ? 600 : 1200;
  const H = 600;
  const canvas = new Canvas(W, H, 2);
  canvas.rect(0, 0, W, H, PAPER);
  const tx = 36;
  const ty = 40;
  const tw = W - 72;
  const th = H - 92;
  const stubX = square ? null : tx + tw - 300;
  const edge = stubX ?? tx + tw;
  canvas.rect(tx + 12, ty + 12, tw, th, INK);
  canvas.rect(tx, ty, tw, th, INK);
  canvas.rect(tx + 4, ty + 4, tw - 8, th - 8, STOCK);
  for (const x of [tx, tx + tw]) {
    canvas.disc(x, ty + th / 2, 22, PAPER);
    canvas.ring(x, ty + th / 2, 22, 4, INK);
  }
  if (stubX) for (let y = ty + 18; y < ty + th - 18; y += 16) canvas.disc(stubX, y, 3.2, INK);
  canvas.rect(tx + 4, ty + 4, edge - tx - 4, 46, YELLOW);
  canvas.rect(tx + 4, ty + 50, edge - tx - 4, 4, INK);
  drawText(canvas, "KLETIA INTENT LINK", tx + 24, ty + 16, 3.2, INK);

  const { definition, publisher } = record;
  const left = tx + 30;
  const titlePitch = square ? 5.4 : 6.6;
  const maxWidth = edge - left - 30;
  const lines = wrapText(definition.title, titlePitch, maxWidth, square ? 3 : 2);
  lines.forEach((text, index) => drawText(canvas, text, left, ty + 84 + index * titlePitch * 9.5, titlePitch, INK));
  let y = ty + 84 + lines.length * titlePitch * 9.5 + 18;

  // Route strip: funding networks → destination network.
  let x = left;
  const destination = definition.destination.actions[0]?.network ?? "base";
  const sources = definition.funding.networks.filter((network) => network !== destination).slice(0, square ? 2 : 5);
  for (const network of sources) {
    const [code, color, on] = line(network);
    const width = textWidth(code, 3.4) + 20;
    canvas.rect(x, y, width, 40, INK);
    canvas.rect(x + 3, y + 3, width - 6, 34, color);
    drawText(canvas, code, x + 11, y + 8, 3.4, on);
    x += width + 8;
  }
  if (sources.length > 0) {
    drawText(canvas, ">", x + 6, y + 8, 3.4, INK);
    x += 40;
  }
  {
    const [code, color, on] = line(destination);
    const width = textWidth(code, 3.4) + 20;
    canvas.rect(x, y, width, 40, INK);
    canvas.rect(x + 3, y + 3, width - 6, 34, color);
    drawText(canvas, code, x + 11, y + 8, 3.4, on);
  }
  y += 62;
  drawText(canvas, `BY ${publisher.name}`, left, y, fitPitch(`BY ${publisher.name}`, 3.6, maxWidth), INK);
  y += 36;
  const domainLine = publisher.domain ? `${publisher.domain} ${publisher.domainVerified ? "VERIFIED" : "NOT VERIFIED"}` : "DOMAIN NOT VERIFIED";
  drawText(canvas, domainLine, left, y, fitPitch(domainLine, 3.6, maxWidth), publisher.domainVerified ? STAMP : WARN);

  // The seal: state reads by shape and word, not colour alone.
  // Square cards stack three title lines, so the seal sits smaller in the bottom corner, clear of the domain line.
  const sealRadius = square ? 46 : 62;
  const sealX = square ? W - 36 - 20 - sealRadius : (stubX as number) - 110;
  const sealY = square ? ty + th - 18 - sealRadius : ty + th - 90;
  const sealColor = publisher.domainVerified ? STAMP : WARN;
  canvas.ring(sealX, sealY, sealRadius, square ? 5 : 6, sealColor);
  canvas.ring(sealX, sealY, sealRadius - 12, 2.5, sealColor);
  const word = publisher.domainVerified ? "VERIFIED" : "UNVERIFIED";
  const wordPitch = fitPitch(word, 2.4, square ? 62 : 84);
  drawText(canvas, word, sealX - textWidth(word, wordPitch) / 2, sealY - 3.5 * wordPitch, wordPitch, sealColor);

  if (stubX) {
    let rowY = ty + 30;
    for (const [label, value] of stubRows(record)) {
      drawText(canvas, label, stubX + 28, rowY, 2.6, MUTED);
      drawText(canvas, value, stubX + 28, rowY + 26, fitPitch(value, 4.2, 300 - 56), INK);
      rowY += 92;
    }
  }
  drawText(canvas, `${host}/go/${record.id}`, tx + 4, H - 34, fitPitch(`${host}/go/${record.id}`, 2.6, W - tx - 8), MUTED);

  if (state === "void") {
    // A red bar across the ticket: this link takes no visitors.
    canvas.rect(tx, ty + th / 2 - 34, tw, 68, WARN);
    drawText(canvas, "VOID", tx + tw / 2 - textWidth("VOID", 6) / 2, ty + th / 2 - 21, 6, "#FFFFFF");
  }
  return canvas.png();
}

/* ---------------------------------------------------------- cache */

const MAX_CACHED = 500;
const cache = new Map<string, Buffer>();

export function cardEtag(record: LinkRecord, variant: CardVariant, state: CardState): string {
  return `"${record.id}-r${record.revision}-${variant}-${state}"`;
}

/** The card PNG, rendered once per (link, revision, variant, state). */
export function linkCard(record: LinkRecord, variant: CardVariant, now: number, host: string): { readonly png: Buffer; readonly etag: string; readonly state: CardState } {
  const state = cardState(record, now);
  const etag = cardEtag(record, variant, state);
  const key = `${etag}|${host}`;
  let png = cache.get(key);
  if (png) {
    cache.delete(key);
    cache.set(key, png);
  } else {
    png = renderLinkCard(record, variant, state, host);
    cache.set(key, png);
    while (cache.size > MAX_CACHED) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return { png, etag, state };
}

/** Host printed on cards (the web origin without the scheme). */
export function cardHost(origin: string): string {
  return origin.replace(/^https?:\/\//u, "");
}

/** Every network has a line bullet (tests). */
export function cardLines(): readonly NetworkKey[] {
  return (Object.keys(CHAINS) as NetworkKey[]).filter((network) => LINES[network] !== undefined);
}
