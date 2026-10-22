/**
 * The Airdrop check's failure state, kept pure so node tests load it. A scan
 * reads several public providers at once (Blockscout lists, Coinbase spot
 * price); when one of them fails or times out the whole scan stops, and the
 * panel shows what failed and a retry instead of a browser alert (which a
 * blocked or dismissed dialog hid, leaving the button silently idle).
 */

/** Provider error text with URLs, credentials and long payloads removed. */
export function safeProviderErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const sanitized = error.message
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(/\b(?:authorization|signature|api[-_ ]?key)\b\s*[:=]\s*[^\s,;]+/giu, "[redacted-credential]")
    .replace(/\b0x[a-f\d]{96,}\b/giu, "[redacted-payload]")
    .replace(/\b[A-Za-z\d+/_-]{80,}={0,2}\b/gu, "[redacted-payload]")
    .trim();
  return sanitized || fallback;
}

export interface ScanFailure {
  readonly title: string;
  /** The provider's own (sanitized) reason. */
  readonly detail: string;
  /** What the person can do about it. */
  readonly hint: string;
  /** False for an input problem: retrying the same address cannot help. */
  readonly retryable: boolean;
}

/** The failure shown for an address that is not a checksummed or lower-case EVM address. */
export const INVALID_ADDRESS_FAILURE: ScanFailure = Object.freeze({
  title: "That is not an EVM address",
  detail: "Enter a 0x address of 40 hexadecimal characters.",
  hint: "Mixed-case addresses must pass their checksum; paste the address exactly as your wallet shows it.",
  retryable: false,
});

/** The failure shown when a provider read failed or timed out. */
export function scanFailure(error: unknown): ScanFailure {
  const detail = safeProviderErrorMessage(error, "A live provider did not answer.");
  const busy = /timed out|HTTP (?:429|5\d\d)|aborted|Failed to fetch|NetworkError|did not return a valid live result/iu.test(detail);
  return {
    title: "The Base activity check did not finish",
    detail,
    hint: busy
      ? "Blockscout and the price source are public services and sometimes drop or time out long histories. Nothing was sent or signed; try again in a minute."
      : "Nothing was sent or signed. Try again; if it keeps failing, the provider may have changed its answer format.",
    retryable: true,
  };
}
