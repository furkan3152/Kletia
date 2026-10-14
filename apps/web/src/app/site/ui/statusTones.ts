/**
 * The status vocabulary of the site and the developer portal: one pure
 * table from every resource state to a tone, a glyph and a plain label,
 * so "unverified" or "active" reads the same on every page. `StatusPill`
 * renders an entry; list rows never use stamps.
 *
 * Rules the tests hold: an unverified publisher, source or domain is a
 * warning, never danger; a state the table does not know is neutral; a
 * label is never empty. Pure, no imports, so the node tests load it directly.
 */

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

/** Glyph drawn before the label: never colour alone. */
export type StatusGlyph = "dot" | "half" | "pause" | "cross" | "warn" | "check" | "ring" | "none";

export type StatusResource =
  | "contract"
  | "contract-source"
  | "contract-domain"
  | "link"
  | "link-publisher"
  | "key"
  | "webhook-delivery"
  | "rule-book-decision"
  | "receipt"
  | "api"
  | "journey-severity";

export interface StatusEntry {
  readonly tone: StatusTone;
  readonly glyph: StatusGlyph;
  readonly label: string;
}

const entry = (tone: StatusTone, glyph: StatusGlyph, label: string): StatusEntry => ({ tone, glyph, label });

const VERIFIED = entry("success", "check", "Verified");
const UNVERIFIED = entry("warning", "warn", "Not verified");

/** Every state each resource can be in, as the API names it plus the site's words for the same state. */
export const STATUS_TONES: Readonly<Record<StatusResource, Readonly<Record<string, StatusEntry>>>> = {
  contract: {
    active: entry("success", "dot", "Active"),
    pending: entry("info", "half", "Pending"),
    suspended: entry("danger", "cross", "Suspended"),
    deleted: entry("neutral", "ring", "Deleted"),
  },
  "contract-source": {
    verified: entry("success", "check", "Source verified"),
    exact_match: entry("success", "check", "Source verified"),
    match: entry("success", "check", "Source verified"),
    unverified: entry("warning", "warn", "Source not verified"),
    unknown: entry("warning", "warn", "Source unknown"),
  },
  "contract-domain": {
    verified: entry("success", "check", "Domain verified"),
    unverified: entry("warning", "warn", "Domain not verified"),
    unknown: entry("warning", "warn", "Domain not checked"),
  },
  link: {
    active: entry("success", "dot", "Active"),
    pending: entry("info", "half", "Pending"),
    paused: entry("warning", "pause", "Paused"),
    suspended: entry("danger", "cross", "Suspended"),
    exhausted: entry("neutral", "ring", "Used up"),
    expired: entry("neutral", "ring", "Expired"),
    withdrawn: entry("neutral", "ring", "Withdrawn"),
    // The API calls a withdrawn link "deleted".
    deleted: entry("neutral", "ring", "Withdrawn"),
  },
  "link-publisher": {
    verified: entry("success", "check", "Verified domain"),
    unverified: entry("warning", "warn", "Unverified"),
    unknown: entry("warning", "warn", "Unverified"),
  },
  key: {
    active: entry("success", "dot", "Active"),
    rotating: entry("info", "half", "Rotating"),
    expiring: entry("warning", "warn", "Expires soon"),
    revoked: entry("neutral", "ring", "Revoked"),
    expired: entry("neutral", "ring", "Expired"),
  },
  "webhook-delivery": {
    delivered: entry("success", "check", "Delivered"),
    succeeded: entry("success", "check", "Delivered"),
    retrying: entry("warning", "warn", "Retrying"),
    // A failure after the last attempt: the dispatcher gave up.
    failed: entry("danger", "cross", "Gave up"),
    dropped: entry("danger", "cross", "Dropped"),
  },
  "rule-book-decision": {
    cleared: entry("success", "check", "Cleared"),
    allow: entry("success", "check", "Cleared"),
    approved: entry("success", "check", "Approved"),
    observed: entry("info", "half", "Observed"),
    held: entry("warning", "pause", "Held"),
    confirm: entry("warning", "pause", "Held"),
    refused: entry("danger", "cross", "Refused"),
    deny: entry("danger", "cross", "Refused"),
    rejected: entry("danger", "cross", "Rejected"),
  },
  receipt: {
    verifies: entry("success", "check", "Verifies"),
    superseded: entry("info", "half", "Superseded"),
    revoked: entry("neutral", "ring", "Share revoked"),
    invalid: entry("danger", "cross", "Does not verify"),
  },
  // Journey notices: the widget's SEVERITY_SIGNS words, never colour alone. The signs themselves
  // (octagon, diamond, triangle, circle) are fixed safety signage, not tones.
  "journey-severity": {
    block: entry("danger", "cross", "Stop"),
    act: entry("warning", "warn", "Act"),
    warn: entry("warning", "warn", "Warning"),
    info: entry("info", "half", "Info"),
  },
  api: {
    ok: entry("success", "dot", "Operational"),
    slow: entry("warning", "warn", "Slow"),
    degraded: entry("warning", "warn", "Degraded"),
    down: entry("danger", "cross", "Down"),
    unreachable: entry("danger", "cross", "Unreachable"),
    checking: entry("neutral", "ring", "Checking"),
  },
};

/** The default glyph for a tone, when a caller has a tone but no table entry. */
export const TONE_GLYPHS: Readonly<Record<StatusTone, StatusGlyph>> = {
  success: "dot",
  info: "half",
  warning: "warn",
  danger: "cross",
  neutral: "ring",
};

/** "rate_limited" → "Rate limited"; "" → "Unknown". */
export function statusLabel(state: string): string {
  const words = String(state ?? "")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!words) return "Unknown";
  return `${words.charAt(0).toUpperCase()}${words.slice(1).toLowerCase()}`;
}

/** The entry for a resource state. Unknown states are neutral and keep a readable label. */
export function toneFor(resource: StatusResource, state: string | null | undefined): StatusEntry {
  const key = typeof state === "string" ? state.trim().toLowerCase() : "";
  const known = Object.prototype.hasOwnProperty.call(STATUS_TONES[resource], key) ? STATUS_TONES[resource][key] : undefined;
  return known ?? entry("neutral", "ring", statusLabel(key));
}

/** A verified or unverified fact (publisher, source, domain): never danger. */
export function verificationTone(verified: boolean): StatusEntry {
  return verified ? VERIFIED : UNVERIFIED;
}
