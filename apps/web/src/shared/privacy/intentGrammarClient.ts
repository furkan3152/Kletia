/**
 * IntentGrammarClientV1 — the device-side mirror of the server scenario registry.
 *
 * The envelope must be generated on the device, because the whole privacy claim
 * rests on free-form text never crossing the boundary. That means the device
 * needs to know the exact shape of every scenario. This module holds that
 * knowledge as data rather than as a hand-written string in a component.
 *
 * The obvious risk is drift: if this table and
 * `apps/api/src/cross-chain/v2/intentGrammar.ts` disagree, the device would emit
 * envelopes the server rejects, and the failure would look like a privacy bug
 * rather than a versioning bug. `tooling/verify-stellar-mvp.mjs` therefore
 * asserts that both registries declare the same scenario identifiers, the same
 * private slots and the same toggle keys. Drift fails CI instead of production.
 *
 * Deliberately excluded: no scenario here carries a confidential claim. The
 * confidential entry exists in the server registry as
 * `integration_incomplete` so it is reviewable, and the device never offers it.
 */

export type ClientIntentSlot = "amount" | "recipient" | "budget";

export interface ClientIntentScenarioV1 {
  readonly id: string;
  readonly label: string;
  readonly privateSlots: readonly ClientIntentSlot[];
  /** Envelope key → default value. Order matters; it defines the envelope. */
  readonly toggles: readonly { readonly key: string; readonly field: string }[];
  /** Human-readable guidance shown before the user commits private values. */
  readonly discloses: readonly string[];
}

const ENVELOPE_DOMAIN = "KLETIA_WORKFLOW_SEMANTIC_V2";

export const CLIENT_INTENT_SCENARIOS: readonly ClientIntentScenarioV1[] = [
  {
    id: "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply",
    label: "Arc USDC → Arbitrum Sepolia Aave supply",
    privateSlots: ["amount", "recipient"],
    toggles: [
      { key: "stellar_policy_center", field: "stellarPolicyCenter" },
      { key: "include_borrow_capacity", field: "includeBorrowCapacity" },
    ],
    discloses: [
      "The amount, both wallets and the timing become public on Arc and Arbitrum.",
      "Only a salted commitment of the amount leaves this device during planning.",
    ],
  },
  {
    id: "stellar_testnet_usdc_policy_anchored_transfer",
    label: "Stellar USDC transfer with an anchored policy",
    privateSlots: ["amount", "recipient", "budget"],
    toggles: [{ key: "anchor_policy_onchain", field: "anchorPolicyOnchain" }],
    discloses: [
      "The transfer amount is public on the Stellar ledger; anchoring a policy does not hide it.",
      "The disclosure budget is committed as a hash, so the budget values themselves stay on this device.",
    ],
  },
  {
    id: "stellar_testnet_usdc_path_payment",
    label: "Stellar USDC path payment (strict send)",
    privateSlots: ["amount", "recipient"],
    toggles: [{ key: "compare_router_quote", field: "compareRouterQuote" }],
    discloses: [
      "Path payment amounts and the destination are public on the Stellar ledger.",
      "A router quote comparison is advisory; it is not a best-execution guarantee.",
    ],
  },
] as const;

export function findClientIntentScenario(
  id: string,
): ClientIntentScenarioV1 | undefined {
  return CLIENT_INTENT_SCENARIOS.find((scenario) => scenario.id === id);
}

/**
 * Builds the byte-exact envelope for a scenario.
 *
 * Line order is fixed by the registry entry, so the string the device produces
 * is the string the server's anchored pattern expects.
 */
export function buildClientIntentEnvelope(input: {
  scenarioId: string;
  toggles?: Readonly<Record<string, boolean>>;
}): string {
  const scenario = findClientIntentScenario(input.scenarioId);
  if (!scenario) {
    throw new Error(
      "This intent is not part of the reviewed scenario registry, so no envelope can be created for it.",
    );
  }
  const toggles = input.toggles ?? {};
  const lines: string[] = [
    ENVELOPE_DOMAIN,
    `scenario=${scenario.id}`,
    "private_field_isolation=true",
    // No client-generated scenario requests ledger confidentiality. The
    // confidential lane stays integration-incomplete and is never offered here.
    "ledger_confidentiality_requested=false",
  ];
  for (const toggle of scenario.toggles) {
    lines.push(`${toggle.key}=${toggles[toggle.field] ? "true" : "false"}`);
  }
  for (const slot of scenario.privateSlots) {
    lines.push(`${slot}_slot=[[private:${slot}]]`);
  }
  return lines.join("\n");
}

export function clientIntentPrivateMarkers(scenarioId: string): readonly string[] {
  return (
    findClientIntentScenario(scenarioId)?.privateSlots.map(
      (slot) => `[[private:${slot}]]`,
    ) ?? []
  );
}
