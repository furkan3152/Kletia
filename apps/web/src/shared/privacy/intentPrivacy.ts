const PRIVACY_LANGUAGE = [
  "confidential",
  "private intent",
  "private amount",
  "private balance",
  "hide my",
  "hide the",
  "do not show",
  "don't show",
  "from the ai",
  "from ai",
  "gizli",
  "gizlilik",
  "bakiyemi gizle",
  "miktarı gizle",
  "ai görmesin",
] as const;

const FINANCIAL_LANGUAGE = [
  "amount",
  "balance",
  "budget",
  "portfolio",
  "recipient",
  "payment",
  "transfer",
  "swap",
  "lend",
  "borrow",
  "stake",
  "vault",
  "bakiye",
  "bütçe",
  "miktar",
  "alıcı",
  "ödeme",
  "transfer",
  "portföy",
] as const;

export function requestsFinancialPrivacy(value: string): boolean {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  return (
    PRIVACY_LANGUAGE.some((phrase) => normalized.includes(phrase)) &&
    FINANCIAL_LANGUAGE.some((phrase) => normalized.includes(phrase))
  );
}

