export function parseStrictRiskScore(value: unknown): number | null {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" ||
      value.trim() === "" ||
      !/^(?:\d{1,2}(?:\.\d+)?|100(?:\.0+)?)$/.test(value.trim()))
  ) {
    return null;
  }
  const score = typeof value === "number" ? value : Number(value.trim());
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
}
