/**
 * Project logo checks: PNG and WebP only, read from their headers alone
 * (no image decoder runs on uploaded bytes).
 *
 * - PNG: the signature, then every chunk header up to IEND; IHDR first gives
 *   the size; `acTL` (APNG animation) is refused.
 * - WebP: `RIFF....WEBP` with one of `VP8 ` (lossy: frame start code and
 *   14-bit sizes), `VP8L` (lossless: signature 0x2f and 14-bit sizes) or
 *   `VP8X` (extended: canvas size; the animation flag and `ANIM`/`ANMF`
 *   chunks are refused).
 * - At most 64 KB, 32-512 px on each side, width / height between 1 and 4.
 *
 * SVG (scriptable), GIF, APNG, animated WebP and anything else are refused
 * with 422 PROJECT_LOGO_INVALID; the bytes are stored and served as they
 * came, under a fixed Content-Type, only when the checks pass.
 */
import { createHash } from "node:crypto";
import { PROJECT_LIMITS, type ProjectLogoType } from "@kletia/core";
import { PlatformError } from "../../errors.js";

export interface CheckedLogo {
  readonly contentType: ProjectLogoType;
  readonly width: number;
  readonly height: number;
  /** Lowercase hex SHA-256 of the bytes (the immutable URL's name). */
  readonly sha256: string;
  readonly bytes: Buffer;
}

export function logoInvalid(message: string): PlatformError {
  return new PlatformError("PROJECT_LOGO_INVALID", message, 422);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw logoInvalid("The file is not a PNG image.");
  let offset = 8;
  let size: { width: number; height: number } | null = null;
  let ended = false;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/u.test(type) || length > bytes.length || next > bytes.length) throw logoInvalid("The PNG chunk structure is broken.");
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) throw logoInvalid("The PNG does not start with its IHDR header.");
      size = { width: bytes.readUInt32BE(offset + 8), height: bytes.readUInt32BE(offset + 12) };
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") throw logoInvalid("Animated PNG (APNG) logos are not accepted.");
    offset = next;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!size || !ended) throw logoInvalid("The PNG is truncated (no IEND chunk).");
  return size;
}

function webpSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 30 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") {
    throw logoInvalid("The file is not a WebP image.");
  }
  const riffSize = bytes.readUInt32LE(4);
  if (riffSize + 8 !== bytes.length) throw logoInvalid("The WebP RIFF size does not match the file.");
  // Every chunk header is checked: an animation chunk anywhere refuses the file.
  let offset = 12;
  const chunks: { type: string; start: number; length: number }[] = [];
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("latin1", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const next = offset + 8 + length + (length % 2);
    if (!/^[A-Z0-9 ]{4}$/u.test(type) || offset + 8 + length > bytes.length) throw logoInvalid("The WebP chunk structure is broken.");
    chunks.push({ type, start: offset + 8, length });
    offset = next;
  }
  if (chunks.some((chunk) => chunk.type === "ANIM" || chunk.type === "ANMF")) throw logoInvalid("Animated WebP logos are not accepted.");
  const first = chunks[0];
  if (!first) throw logoInvalid("The WebP has no image chunk.");
  const data = bytes.subarray(first.start, first.start + first.length);
  if (first.type === "VP8X") {
    if (data.length < 10) throw logoInvalid("The WebP VP8X header is truncated.");
    if ((data[0] ?? 0) & 0x02) throw logoInvalid("Animated WebP logos are not accepted.");
    return { width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1 };
  }
  if (first.type === "VP8 ") {
    if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw logoInvalid("The WebP VP8 frame header is broken.");
    return { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
  }
  if (first.type === "VP8L") {
    if (data.length < 5 || data[0] !== 0x2f) throw logoInvalid("The WebP VP8L header is broken.");
    const bits = data.readUInt32LE(1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  throw logoInvalid("The WebP has no VP8, VP8L or VP8X image chunk first.");
}

/**
 * Checks an uploaded logo against its declared Content-Type (which must
 * match the bytes). Throws 422 PROJECT_LOGO_INVALID for anything else.
 */
export function checkLogo(bytes: Buffer, declaredType: string | undefined): CheckedLogo {
  const type = (declaredType ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "image/png" && type !== "image/webp") {
    throw logoInvalid("Upload the logo as image/png or image/webp (SVG, GIF and other formats are not accepted).");
  }
  if (bytes.length === 0) throw logoInvalid("The logo is empty.");
  if (bytes.length > PROJECT_LIMITS.logoBytes) throw logoInvalid(`The logo is ${bytes.length} bytes; the limit is ${PROJECT_LIMITS.logoBytes}.`);
  const { width, height } = type === "image/png" ? pngSize(bytes) : webpSize(bytes);
  const { logoMinPx: min, logoMaxPx: max, logoMaxAspect: aspect } = PROJECT_LIMITS;
  if (width < min || height < min || width > max || height > max) {
    throw logoInvalid(`The logo is ${width}x${height} px; each side must be ${min}-${max} px.`);
  }
  if (width < height || width > height * aspect) {
    throw logoInvalid(`The logo is ${width}x${height} px; the width must be 1 to ${aspect} times the height.`);
  }
  return { contentType: type, width, height, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
}

/** The file extension of a logo type. */
export function logoExtension(contentType: ProjectLogoType): "png" | "webp" {
  return contentType === "image/png" ? "png" : "webp";
}
