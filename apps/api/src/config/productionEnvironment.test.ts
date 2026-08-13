import { describe, expect, it } from "vitest";

import { assertProductionFeatureConfiguration } from "./productionEnvironment.js";

const complete = {
  NODE_ENV: "production",
  OPENROUTER_API_KEY: "configured",
  WEBACY_API_KEY: "configured",
  ALLORA_API_KEY: "configured",
  ALCHEMY_API_KEY: "configured",
  CDP_API_KEY_NAME: "configured",
  CDP_API_KEY_PRIVATE_KEY: "configured",
};

describe("production feature configuration", () => {
  it("accepts a complete production feature set", () => {
    expect(() => assertProductionFeatureConfiguration(complete)).not.toThrow();
  });

  it("fails closed when a public feature would start unavailable", () => {
    expect(() =>
      assertProductionFeatureConfiguration({
        ...complete,
        WEBACY_API_KEY: "",
      }),
    ).toThrow(/WEBACY_API_KEY/u);
  });

  it("allows partial local development configuration", () => {
    expect(() =>
      assertProductionFeatureConfiguration({ NODE_ENV: "development" }),
    ).not.toThrow();
  });
});
