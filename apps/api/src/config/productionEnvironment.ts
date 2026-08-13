type RuntimeEnvironment = Record<string, string | undefined>;

const REQUIRED_PRODUCTION_FEATURE_KEYS = [
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

  const missing = REQUIRED_PRODUCTION_FEATURE_KEYS.filter(
    (key) => !environment[key]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `Production feature configuration is incomplete: ${missing.join(", ")}.`,
    );
  }
}

assertProductionFeatureConfiguration();
