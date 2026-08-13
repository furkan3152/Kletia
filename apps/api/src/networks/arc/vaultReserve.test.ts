import { describe, expect, it } from "vitest";

import { assertArcVaultReserveForPlan } from "./handlers.js";

describe("Arc Vault plan reserve boundary", () => {
  it("accepts a withdrawal only when aggregate principal and user interest remain covered", () => {
    expect(() =>
      assertArcVaultReserveForPlan(117n, 120n, 2n),
    ).not.toThrow();
  });

  it("rejects aggregate principal underfunding", () => {
    expect(() => assertArcVaultReserveForPlan(117n, 116n)).toThrow(
      /total user principal/u,
    );
  });

  it("rejects a withdrawal that could consume another depositor's principal", () => {
    expect(() => assertArcVaultReserveForPlan(117n, 118n, 2n)).toThrow(
      /other users' principal/u,
    );
  });
});
