/**
 * Dependency-free raster for share cards (links design §5.3): an RGB canvas
 * drawn at 2× (rectangles, discs, rings), the 5×7 dot-matrix face of the
 * departure board for core's `BOARD_ALPHABET` (text folded with core
 * `boardText`; anything else draws "?"), a box-filter downsample and a PNG
 * encoder (IHDR 8-bit RGB, one IDAT from `zlib.deflateSync` level 9,
 * CRC-32). Deterministic: the same input gives the same bytes.
 */
import { deflateSync } from "node:zlib";
import { boardText } from "@kletia/core";

/* ------------------------------------------------------------- PNG */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 8-bit truecolour PNG of `rgb` (width × height × 3 bytes). */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

/* ---------------------------------------------------------- raster */

type Rgb = readonly [number, number, number];

function rgbOf(hex: string): Rgb {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

export class Canvas {
  readonly width: number;
  readonly height: number;
  private readonly pixels: Buffer;

  /** A canvas of `width × height` logical pixels drawn at `scale` (supersampling). */
  constructor(width: number, height: number, private readonly scale: number) {
    this.width = width * scale;
    this.height = height * scale;
    this.pixels = Buffer.alloc(this.width * this.height * 3);
  }

  private set(x: number, y: number, color: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 3;
    this.pixels[index] = color[0];
    this.pixels[index + 1] = color[1];
    this.pixels[index + 2] = color[2];
  }

  rect(x: number, y: number, w: number, h: number, hex: string): void {
    const color = rgbOf(hex);
    const s = this.scale;
    for (let j = Math.round(y * s); j < Math.round((y + h) * s); j += 1) {
      for (let i = Math.round(x * s); i < Math.round((x + w) * s); i += 1) this.set(i, j, color);
    }
  }

  disc(cx: number, cy: number, r: number, hex: string): void {
    const color = rgbOf(hex);
    const s = this.scale;
    const R = r * s;
    const X = cx * s;
    const Y = cy * s;
    for (let j = Math.floor(Y - R); j <= Math.ceil(Y + R); j += 1) {
      for (let i = Math.floor(X - R); i <= Math.ceil(X + R); i += 1) if ((i + 0.5 - X) ** 2 + (j + 0.5 - Y) ** 2 <= R * R) this.set(i, j, color);
    }
  }

  ring(cx: number, cy: number, r: number, thickness: number, hex: string): void {
    const color = rgbOf(hex);
    const s = this.scale;
    const R = r * s;
    const T = thickness * s;
    const X = cx * s;
    const Y = cy * s;
    for (let j = Math.floor(Y - R); j <= Math.ceil(Y + R); j += 1) {
      for (let i = Math.floor(X - R); i <= Math.ceil(X + R); i += 1) {
        const distance = Math.hypot(i + 0.5 - X, j + 0.5 - Y);
        if (distance <= R && distance >= R - T) this.set(i, j, color);
      }
    }
  }

  /** Box filter scale × scale → 1 pixel. */
  downsample(): { readonly width: number; readonly height: number; readonly rgb: Buffer } {
    const s = this.scale;
    const width = this.width / s;
    const height = this.height / s;
    const out = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        for (let k = 0; k < 3; k += 1) {
          let sum = 0;
          for (let j = 0; j < s; j += 1) for (let i = 0; i < s; i += 1) sum += this.pixels[((y * s + j) * this.width + (x * s + i)) * 3 + k] as number;
          out[(y * width + x) * 3 + k] = Math.round(sum / (s * s));
        }
      }
    }
    return { width, height, rgb: out };
  }

  png(): Buffer {
    const { width, height, rgb } = this.downsample();
    return encodePng(width, height, rgb);
  }
}

/* ------------------------------------------------------ 5×7 face */

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"], B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"], D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"], F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"], H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"], J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"], L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"], N: ["10001", "10001", "11001", "10101", "10011", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"], P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"], R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"], T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"], V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"], X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"], Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"], "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"], "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"], "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"], "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"], "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"], ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"], ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"], "/": ["00001", "00001", "00010", "00100", "01000", "10000", "10000"],
  ">": ["01000", "00100", "00010", "00001", "00010", "00100", "01000"], $: ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  "%": ["11000", "11001", "00010", "00100", "01000", "10011", "00011"], "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"], "'": ["01100", "00100", "01000", "00000", "00000", "00000", "00000"],
  "&": ["01100", "10010", "10100", "01000", "10101", "10010", "01101"], "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"], "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"], "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "@": ["01110", "10001", "10111", "10101", "10111", "10000", "01111"], "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
  "~": ["00000", "00000", "01000", "10101", "00010", "00000", "00000"],
};

/** Every character the face can draw (tests: the face covers core's alphabet). */
export const FACE_CHARACTERS = Object.freeze(Object.keys(GLYPHS));

/** Width in logical pixels of `text` at dot pitch `pitch`. */
export function textWidth(text: string, pitch: number): number {
  const length = [...boardText(text)].length;
  return length === 0 ? 0 : length * 6 * pitch - pitch;
}

/** The largest pitch ≤ `pitch` that fits `text` in `max` pixels. */
export function fitPitch(text: string, pitch: number, max: number): number {
  return Math.min(pitch, max / Math.max(1, [...boardText(text)].length * 6 - 1));
}

/** Draws folded `text` at (x, y) with dot pitch `pitch`; returns the x after it. */
export function drawText(canvas: Canvas, text: string, x: number, y: number, pitch: number, hex: string): number {
  let cursor = x;
  for (const char of boardText(text)) {
    const glyph = GLYPHS[char] ?? (GLYPHS["?"] as readonly string[]);
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (glyph[row]?.[column] === "1") canvas.disc(cursor + column * pitch + pitch / 2, y + row * pitch + pitch / 2, pitch * 0.42, hex);
      }
    }
    cursor += 6 * pitch;
  }
  return cursor;
}

/** Word-wraps folded text into at most `lines` lines of `max` pixels (an ellipsis on overflow). */
export function wrapText(text: string, pitch: number, max: number, lines: number): string[] {
  const words = boardText(text).split(" ");
  const out: string[] = [""];
  for (const word of words) {
    const current = out[out.length - 1] as string;
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, pitch) <= max) out[out.length - 1] = candidate;
    else if (out.length < lines) out.push(word);
    else {
      out[out.length - 1] = `${current.replace(/.{0,3}$/u, "")}...`;
      break;
    }
  }
  return out.filter((line) => line.length > 0);
}
