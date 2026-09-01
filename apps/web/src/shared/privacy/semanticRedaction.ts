/**
 * Device-side semantic-context minimizer.
 *
 * The workflow envelope remains authoritative. This helper only produces an
 * optional natural-language hint for the constrained model, and therefore
 * removes every numeric value and reviewed wallet-address family before any
 * request can be made.
 */
const EVM_ADDRESS_PATTERN = /0x[a-f\d]{40}/giu;
const STELLAR_ADDRESS_PATTERN = /\b[GC][A-Z2-7]{55}\b/gu;
const NUMERIC_VALUE_PATTERN = /\p{Number}+(?:[.,]\p{Number}+)?/gu;

export function redactSemanticContext(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(EVM_ADDRESS_PATTERN, "[[redacted:evm_address]]")
    .replace(STELLAR_ADDRESS_PATTERN, "[[redacted:stellar_address]]")
    .replace(NUMERIC_VALUE_PATTERN, "[[redacted:number]]")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    throw new Error(
      "Describe the intended outcome without relying only on private values.",
    );
  }
  return normalized.slice(0, 1_200);
}
