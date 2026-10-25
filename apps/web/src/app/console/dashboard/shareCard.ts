/**
 * The binder's share export: a settled card drawn at 1080 x 1350 on a canvas in this browser and
 * saved as a PNG. Only what the card already shows: kind, serial, title, route, date and the stamp;
 * never an address, a balance or a hash. Nothing is uploaded.
 */
import { CHAINS, isNetworkKey } from "@kletia/core";

import type { BinderEntry } from "./binderModel";
import { shareFileName } from "./binderModel";

export const SHARE_WIDTH = 1080;
export const SHARE_HEIGHT = 1350;

const PALETTE = {
  light: { chassis: "#D6D2C8", stock: "#FBFAF6", ink: "#121212", ink3: "#5C5850", line: "#B3AEA2", dot: "rgba(18,18,18,0.16)", panel: "#E8E5DD", shadow: "#121212" },
  dark: { chassis: "#0E0E10", stock: "#19191C", ink: "#F2F0EA", ink3: "#9A968C", line: "#3A3A40", dot: "rgba(242,240,234,0.14)", panel: "#1C1C1F", shadow: "#2A2A30" },
} as const;
const LIME = "#C6FF3A";

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

/** Lines of `text` that fit `width` at the context's font (at most `max`, the last one ellipsed). */
function wrap(context: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const words = text.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > max) {
    const kept = lines.slice(0, max);
    let last = kept[max - 1]!;
    while (last.length > 1 && context.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    kept[max - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

/** Draws the card; returns the canvas (exported for a test page or a preview). */
export async function drawShareCard(entry: BinderEntry, theme: "light" | "dark"): Promise<HTMLCanvasElement> {
  const colors = PALETTE[theme];
  if (typeof document !== "undefined" && document.fonts) {
    await Promise.allSettled([document.fonts.load('700 64px "Funnel Display"'), document.fonts.load('500 30px "Geist Mono"'), document.fonts.load('600 30px "Funnel Sans"')]);
  }
  const canvas = document.createElement("canvas");
  canvas.width = SHARE_WIDTH;
  canvas.height = SHARE_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) return canvas;

  // Chassis with a faint grain of dots.
  context.fillStyle = colors.chassis;
  context.fillRect(0, 0, SHARE_WIDTH, SHARE_HEIGHT);
  context.fillStyle = colors.dot;
  for (let y = 12; y < SHARE_HEIGHT; y += 24) for (let x = 12; x < SHARE_WIDTH; x += 24) context.fillRect(x, y, 2, 2);

  // The card: slab border and hard offset shadow.
  const cx = 140;
  const cy = 150;
  const cw = 800;
  const ch = 960;
  context.fillStyle = colors.shadow;
  roundRect(context, cx + 16, cy + 16, cw, ch, 40);
  context.fill();
  context.fillStyle = colors.stock;
  roundRect(context, cx, cy, cw, ch, 40);
  context.fill();
  context.lineWidth = 6;
  context.strokeStyle = colors.ink === "#121212" ? "#121212" : "#4A4A52";
  context.stroke();

  // Lime band: kind and serial.
  context.save();
  roundRect(context, cx, cy, cw, ch, 40);
  context.clip();
  context.fillStyle = LIME;
  context.fillRect(cx, cy, cw, 104);
  context.fillStyle = "#121212";
  context.fillRect(cx, cy + 104, cw, 5);
  context.font = '700 34px "Funnel Sans", sans-serif';
  context.textBaseline = "middle";
  context.fillText(entry.kind.toUpperCase(), cx + 44, cy + 54);
  context.font = '600 34px "Geist Mono", monospace';
  context.textAlign = "right";
  context.fillText(`#${entry.serial}`, cx + cw - 44, cy + 54);
  context.textAlign = "left";

  // Art window: dot matrix with the route as cartridges on a rail.
  const ay = cy + 109;
  const ah = 300;
  context.fillStyle = colors.panel;
  context.fillRect(cx, ay, cw, ah);
  context.fillStyle = colors.dot;
  for (let y = ay + 10; y < ay + ah; y += 16) for (let x = cx + 10; x < cx + cw; x += 16) context.fillRect(x, y, 3, 3);
  if (entry.foil === "holo") {
    const foil = context.createLinearGradient(cx, ay, cx + cw, ay + ah);
    foil.addColorStop(0.2, "rgba(255,209,232,0)");
    foil.addColorStop(0.35, "rgba(255,209,232,0.45)");
    foil.addColorStop(0.5, "rgba(200,240,255,0.45)");
    foil.addColorStop(0.65, "rgba(230,255,196,0.45)");
    foil.addColorStop(0.8, "rgba(255,227,184,0)");
    context.fillStyle = foil;
    context.fillRect(cx, ay, cw, ah);
  }
  const stops = entry.route.length > 0 ? entry.route : ["kletia"];
  const node = 128;
  const gap = stops.length > 1 ? (cw - 120 - node) / (stops.length - 1) : 0;
  const midY = ay + ah / 2;
  const startX = stops.length > 1 ? cx + 60 : cx + cw / 2 - node / 2;
  if (stops.length > 1) {
    context.fillStyle = colors.ink;
    context.fillRect(startX + node / 2, midY - 5, gap * (stops.length - 1), 10);
  }
  stops.forEach((stop, index) => {
    const x = startX + index * gap;
    context.fillStyle = colors.stock;
    roundRect(context, x, midY - node / 2, node, node, 26);
    context.fill();
    context.lineWidth = 6;
    context.strokeStyle = colors.ink;
    context.stroke();
    const label = isNetworkKey(stop) ? CHAINS[stop].shortName : "Kletia";
    context.fillStyle = colors.ink;
    context.font = '700 26px "Funnel Sans", sans-serif';
    context.textAlign = "center";
    context.fillText(label.length > 9 ? `${label.slice(0, 8)}…` : label, x + node / 2, midY + 2);
    context.textAlign = "left";
  });
  context.fillStyle = colors.line;
  context.fillRect(cx, ay + ah, cw, 2);

  // Title, sub, facts.
  context.fillStyle = colors.ink;
  context.textBaseline = "alphabetic";
  context.font = '700 66px "Funnel Display", sans-serif';
  const lines = wrap(context, entry.title, cw - 88, 3);
  lines.forEach((line, index) => context.fillText(line, cx + 44, ay + ah + 100 + index * 76));
  const afterTitle = ay + ah + 100 + (lines.length - 1) * 76;
  context.fillStyle = colors.ink3;
  context.font = '500 32px "Geist Mono", monospace';
  if (entry.sub) context.fillText(entry.sub, cx + 44, afterTitle + 64);

  // Footer rule: date left, tag right.
  const fy = cy + ch - 92;
  context.strokeStyle = colors.line;
  context.lineWidth = 2;
  context.setLineDash([10, 8]);
  context.beginPath();
  context.moveTo(cx + 44, fy);
  context.lineTo(cx + cw - 44, fy);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = colors.ink3;
  context.font = '500 30px "Geist Mono", monospace';
  context.fillText(entry.date, cx + 44, fy + 52);
  context.textAlign = "right";
  context.fillText(entry.tag, cx + cw - 44, fy + 52);
  context.textAlign = "left";
  context.restore();

  // The settled stamp.
  context.save();
  context.translate(cx + cw - 210, cy + 600);
  context.rotate((-9 * Math.PI) / 180);
  context.strokeStyle = colors.ink;
  context.lineWidth = 6;
  roundRect(context, -150, -48, 300, 96, 14);
  context.stroke();
  context.fillStyle = colors.ink;
  context.font = '800 46px "Funnel Sans", sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("SETTLED", 0, 3);
  context.restore();

  // Nameplate line under the card.
  context.fillStyle = colors.ink;
  context.font = '800 40px "Funnel Display", sans-serif';
  context.textBaseline = "alphabetic";
  context.fillText("KLETIA", cx, SHARE_HEIGHT - 110);
  context.fillStyle = colors.ink3;
  context.font = '500 26px "Geist Mono", monospace';
  context.fillText("K-01 intent machine", cx + 196, SHARE_HEIGHT - 114);
  context.textAlign = "right";
  context.fillText("kletiaai.xyz", cx + cw, SHARE_HEIGHT - 114);
  return canvas;
}

/** Draws the card and saves it as a PNG in this browser (nothing leaves the device). */
export async function downloadShareCard(entry: BinderEntry, theme: "light" | "dark"): Promise<void> {
  const canvas = await drawShareCard(entry, theme);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = shareFileName(entry);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
