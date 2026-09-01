/**
 * Circle assigns the CCTP V2 nonce offchain and writes the executed finality
 * threshold into the attested message. The source-chain MessageSent event is
 * therefore a template: every economic and address field must stay identical,
 * while bytes 12..44 (nonce) and 144..148 (executed finality) may be completed
 * by Iris.
 */

function messageBytes(value: unknown): Buffer | null {
  const text = String(value ?? "").trim();
  if (!/^0x(?:[a-f\d]{2})+$/iu.test(text)) return null;
  return Buffer.from(text.slice(2), "hex");
}

export function cctpV2AttestedMessageMatchesSourceEvent(
  sourceEventMessage: unknown,
  attestedMessage: unknown,
): boolean {
  const source = messageBytes(sourceEventMessage);
  const attested = messageBytes(attestedMessage);
  if (!source || !attested || source.length < 148 || source.length !== attested.length) {
    return false;
  }
  return (
    source.subarray(0, 12).equals(attested.subarray(0, 12)) &&
    source.subarray(44, 144).equals(attested.subarray(44, 144)) &&
    source.subarray(148).equals(attested.subarray(148))
  );
}

export function cctpV2NonceMatches(value: unknown, nonceHex: string): boolean {
  const text = String(value ?? "").trim();
  if (!/^(?:0x[a-f\d]+|\d+)$/iu.test(text) || !/^0x[a-f\d]{64}$/iu.test(nonceHex)) {
    return false;
  }
  try {
    return BigInt(text) === BigInt(nonceHex);
  } catch {
    return false;
  }
}

export function cctpV2MessageMatchesDomains(
  message: {
    readonly sourceDomain?: unknown;
    readonly destinationDomain?: unknown;
    readonly decodedMessage?: {
      readonly sourceDomain?: unknown;
      readonly destinationDomain?: unknown;
    };
  },
  sourceDomain: number,
  destinationDomain: number,
): boolean {
  const observedSource = message.sourceDomain ?? message.decodedMessage?.sourceDomain;
  const observedDestination =
    message.destinationDomain ?? message.decodedMessage?.destinationDomain;
  return (
    Number(observedSource) === sourceDomain &&
    Number(observedDestination) === destinationDomain
  );
}
