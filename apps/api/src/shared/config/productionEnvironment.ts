type RuntimeEnvironment = Record<string, string | undefined>;

/**
 * Integration keys that unlock optional features. Missing keys never weaken a
 * safety check: the affected feature fails closed and is reported as
 * `needs_configuration` by GET /api/capabilities.
 */
const PRODUCTION_FEATURE_KEYS = [
  "OPENROUTER_API_KEY",
  "WEBACY_API_KEY",
  "ALLORA_API_KEY",
  "ALCHEMY_API_KEY",
  "CDP_API_KEY_NAME",
  "CDP_API_KEY_PRIVATE_KEY",
] as const;

export function assertProductionFeatureConfiguration(
  environment: RuntimeEnvironment = process.env,
) {
  if (environment.NODE_ENV !== "production") return;

  const missing = PRODUCTION_FEATURE_KEYS.filter(
    (key) => !environment[key]?.trim(),
  );
  if (missing.length === 0) return;
  // Hosted deployments that promise every feature opt into a hard stop.
  if (environment.KLETIA_REQUIRE_ALL_FEATURES?.trim() === "true") {
    throw new Error(
      `Production feature configuration is incomplete: ${missing.join(", ")}.`,
    );
  }
  console.warn(
    `[config] Optional integrations not configured (features report needs_configuration): ${missing.join(", ")}.`,
  );
}

assertProductionFeatureConfiguration();
