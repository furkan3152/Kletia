#!/usr/bin/env node

/**
 * Executable measurement gate for registered WorkflowPlanV2 private fields.
 *
 * Every other gate in this repository checks that the *source* is shaped
 * correctly. This one exercises EgressGuardV1 as a running program and asserts
 * that a registered private value genuinely cannot leave through a wrapped
 * surface. This converts an observed-session claim into executable evidence; it
 * does not prove non-interference for legacy intents, separate browser realms or
 * code paths that were not exercised.
 *
 * Node is used as the host deliberately. `fetch`, `console`, `btoa` and `crypto`
 * exist here, while `XMLHttpRequest`, `WebSocket`, `navigator` and the storages
 * do not. The guard skips absent surfaces by design, so a Node run verifies the
 * blocking logic and the surfaces Node provides; the browser-only surfaces are
 * verified by the same shared `assertNoEgress` path they all funnel through.
 */

import { pathToFileURL } from "node:url";

const guardModuleUrl = pathToFileURL(
  new URL("../apps/web/src/shared/privacy/egressGuard.ts", import.meta.url)
    .pathname,
);

let guard;
try {
  guard = await import(guardModuleUrl.href);
} catch (error) {
  console.error(
    "Egress guard gate failed: the guard module could not be loaded. Node must support TypeScript type stripping (Node 22.6+ with --experimental-strip-types, or Node 24+).",
  );
  console.error(error);
  process.exit(1);
}

const {
  installEgressGuard,
  registerPrivateField,
  readEgressGuardReport,
  resetEgressGuardStateForTests,
  fetchWithRouteHydrationDisclosure,
  PrivateFieldEgressBlockedError,
} = guard;

const { redactSemanticContext } = await import(
  pathToFileURL(
    new URL(
      "../apps/web/src/shared/privacy/semanticRedaction.ts",
      import.meta.url,
    ).pathname,
  ).href
);

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

/** Runs `operation` and reports whether the guard blocked it. */
const wasBlocked = async (operation) => {
  try {
    await operation();
    return false;
  } catch (error) {
    return error instanceof PrivateFieldEgressBlockedError;
  }
};

// Capture a deterministic transport before installing the guard. The gate is
// about browser-boundary enforcement, not external network availability.
globalThis.fetch = async () => new Response("{}", { status: 200 });
installEgressGuard();
expect(readEgressGuardReport().installed, "the guard did not report itself installed");

const RAW_CONTEXT =
  "Move 12.345678 USDC from 0x1111111111111111111111111111111111111111 to GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 via Aave V3.";
const REDACTED_CONTEXT = redactSemanticContext(RAW_CONTEXT);
expect(
  !REDACTED_CONTEXT.includes("12.345678") &&
    !REDACTED_CONTEXT.includes("0x1111111111111111111111111111111111111111") &&
    !REDACTED_CONTEXT.includes("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5") &&
    !/\p{Number}/u.test(REDACTED_CONTEXT) &&
    REDACTED_CONTEXT.includes("[[redacted:number]]") &&
    REDACTED_CONTEXT.includes("[[redacted:evm_address]]") &&
    REDACTED_CONTEXT.includes("[[redacted:stellar_address]]"),
  "natural-language context did not remove every numeric and wallet identity before semantic planning",
);

// A second install must be a no-op. Double-wrapping would nest the guard inside
// itself and make a violation report attribute the leak to the wrong surface.
installEgressGuard();

// The private amount is registered in its normalized decimal form, which is what
// the browser holds in the private slot. It is long enough to be distinguishable
// from ordinary protocol traffic.
const PRIVATE_AMOUNT = "1234.567890";
const PRIVATE_HYDRATION_AMOUNT = "9876.543210";
const PRIVATE_OPENING = `0x${"ab".repeat(32)}`;
// An unrelated value that must never be treated as private, so a passing test
// cannot be explained by the guard blocking everything.
const PUBLIC_VALUE = "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply";

resetEgressGuardStateForTests();
expect(
  registerPrivateField("amount", PRIVATE_AMOUNT) === "guarded",
  "the normalized private amount was not accepted as guardable",
);
expect(
  registerPrivateField("opening", PRIVATE_OPENING) === "guarded",
  "the commitment opening salt was not accepted as guardable",
);
// Re-registering the same value must not grow the needle set, otherwise a UI that
// re-renders on every keystroke would degrade the scan without adding coverage.
expect(
  registerPrivateField("amount", PRIVATE_AMOUNT) === "duplicate",
  "a repeated registration was not recognised as a duplicate",
);
// A bare short value collides with chain IDs and decimals. Claiming to protect it
// would be dishonest, so the guard must say so instead of silently accepting it.
expect(
  registerPrivateField("amount", "5") === "unguardable_low_entropy",
  "a low-entropy value was accepted as if it could be protected",
);
// Reporting must stay honest after that: the field keeps its earlier guarded
// needle, but the latest value is unwatched, so it appears in both lists and the
// caller is expected to treat it as unprotected.
expect(
  readEgressGuardReport().unguardableFields.includes("amount"),
  "the report hid that the most recently registered amount was unguardable",
);
// A subsequent guardable value must clear the flag, otherwise a keystroke-driven
// input would stay permanently marked unprotected once a short prefix was seen.
expect(
  registerPrivateField("amount", PRIVATE_HYDRATION_AMOUNT) === "guarded" &&
    !readEgressGuardReport().unguardableFields.includes("amount"),
  "a later guardable value did not clear the unguardable flag",
);

const ORIGIN = "https://api.kletia.invalid";
const approvedHydration = await fetchWithRouteHydrationDisclosure({
  url: `${ORIGIN}/api/workflows/v3/8ab4ac15-9f8d-4b35-bcfe-4dc0c6d72347/routes/arc-arbitrum-direct-cctp/hydrate`,
  workflowId: "8ab4ac15-9f8d-4b35-bcfe-4dc0c6d72347",
  routeId: "arc-arbitrum-direct-cctp",
  requestId: "12d6e887-92ce-49b0-a0b7-b3d37f62561d",
  body: {
    amount: PRIVATE_HYDRATION_AMOUNT,
    amountSalt: PRIVATE_OPENING,
    acknowledgePublicExecution: true,
  },
  headers: {
    Authorization: `Bearer ${"v3."}${"a".repeat(120)}`,
    "Content-Type": "application/json",
  },
});
expect(approvedHydration.ok, "the exact reviewed V3 hydration disclosure was blocked");
expect(
  readEgressGuardReport().approvedDisclosures.filter(
    (entry) => entry.kind === "public_route_hydration_opening",
  ).length === 2,
  "the approved V3 amount and opening disclosures were not recorded without their values",
);

// Each case names the exact channel a private value could realistically escape
// through. `location` covers query strings, referrers and server access logs.
const blockedCases = [
  {
    label: "fetch URL query string",
    operation: () => fetch(`${ORIGIN}/plan?amount=${PRIVATE_AMOUNT}`),
  },
  {
    label: "fetch JSON body",
    operation: () =>
      fetch(`${ORIGIN}/plan`, {
        method: "POST",
        body: JSON.stringify({ amount: PRIVATE_AMOUNT }),
      }),
  },
  {
    label: "fetch nested JSON body",
    operation: () =>
      fetch(`${ORIGIN}/plan`, {
        method: "POST",
        body: JSON.stringify({ goal: { slots: [{ value: PRIVATE_AMOUNT }] } }),
      }),
  },
  {
    label: "fetch header",
    operation: () =>
      fetch(`${ORIGIN}/plan`, {
        method: "POST",
        headers: { "X-Kletia-Debug": PRIVATE_AMOUNT },
      }),
  },
  {
    label: "commitment opening salt in a fetch body",
    operation: () =>
      fetch(`${ORIGIN}/plan`, {
        method: "POST",
        body: JSON.stringify({ salt: PRIVATE_OPENING }),
      }),
  },
  {
    label: "URI-encoded private amount",
    operation: () =>
      fetch(`${ORIGIN}/plan`, {
        method: "POST",
        body: `amount=${encodeURIComponent(PRIVATE_AMOUNT)}`,
      }),
  },
  {
    label: "base64-encoded private amount",
    operation: () =>
      fetch(`${ORIGIN}/plan`, {
        method: "POST",
        body: JSON.stringify({ payload: btoa(PRIVATE_AMOUNT) }),
      }),
  },
  {
    label: "console log",
    operation: () => console.log("planning amount", PRIVATE_AMOUNT),
  },
  {
    label: "console error object",
    operation: () => console.error({ amount: PRIVATE_AMOUNT }),
  },
];

for (const testCase of blockedCases) {
  expect(
    await wasBlocked(testCase.operation),
    `a private value escaped through: ${testCase.label}`,
  );
}

// The guard must not be a blanket denial. If it blocked ordinary traffic, the
// blocked cases above would prove nothing about private-field isolation.
expect(
  !(await wasBlocked(() => console.log("scenario", PUBLIC_VALUE))),
  "the guard blocked a public value, so its blocking is indiscriminate rather than private-field specific",
);
expect(
  !(await wasBlocked(() =>
    fetch(`${ORIGIN}/plan`, {
      method: "POST",
      body: JSON.stringify({
        prompt: [
          "KLETIA_WORKFLOW_SEMANTIC_V2",
          `scenario=${PUBLIC_VALUE}`,
          "amount_slot=[[private:amount]]",
        ].join("\n"),
      }),
    }),
  )),
  "the guard blocked the redacted semantic envelope, which contains no private value",
);

const report = readEgressGuardReport();
expect(
  report.violations.length === blockedCases.length,
  `expected ${blockedCases.length} recorded violations but found ${report.violations.length}`,
);
expect(
  report.zeroPrivateFieldEgress === false,
  "the report claimed zero egress while violations were recorded",
);
// A violation record that echoed the private value would itself be a leak.
const serializedReport = JSON.stringify(report);
expect(
  !serializedReport.includes(PRIVATE_AMOUNT) &&
    !serializedReport.includes(PRIVATE_OPENING),
  "the violation report echoed the private value it was reporting on",
);
expect(
  report.guardedFields.includes("amount") && report.guardedFields.includes("opening"),
  "the report did not list both guarded private fields",
);

// After a reset the same traffic must pass, proving needles are cleared when a
// workflow is abandoned and cannot be attributed to an unrelated later plan.
resetEgressGuardStateForTests();
expect(
  !(await wasBlocked(() => console.log("post-reset", PRIVATE_AMOUNT))),
  "a stale needle survived the reset and blocked unrelated traffic",
);
const cleanReport = readEgressGuardReport();
expect(
  cleanReport.coverage === "inactive" &&
    cleanReport.observedNoViolation === true &&
    cleanReport.zeroPrivateFieldEgress === false &&
    cleanReport.violations.length === 0,
  "the reset did not restore a clean inactive report",
);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`Egress guard gate failed: ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Private-field egress guard verified: ${blockedCases.length} leak channels blocked, public traffic unaffected.`,
);
