import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_ALPHABET,
  LINK_ID_PATTERN,
  LINK_LIMITS,
  LinkExpansionError,
  blinkEligibility,
  boardText,
  domainFileListsContract,
  domainFileListsLink,
  expandLink,
  findAssetBySymbol,
  isLinkId,
  linkDeliverAccepts,
  linkDeliverFirstGuess,
  linkDeliverRescale,
  linkDestinationAsset,
  linkFundingOptions,
  linkNotices,
  validateLinkDefinition,
  validateLinkIntentRequest,
} from "../dist/index.js";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const MERCHANT = "eip155:8453:0x5eed00000000000000000000000000000000c0de";
const ref = (network, symbol) => {
  const asset = findAssetBySymbol(network, symbol);
  return { asset: asset.id, symbol: asset.symbol, decimals: asset.decimals };
};

/** The design's three reference links (§3.2). */
const VAULT = {
  title: "Deposit USDC into Acme Vault",
  description: "From any network. Arrives as steakUSDC in your wallet on Base.",
  publisher: { name: "Acme Yield", website: "https://acme.example" },
  destination: { actions: [{ kind: "call", network: "base", contract: "acme vault", entry: "deposit", amount: "$amount" }] },
  funding: {
    networks: ["base", "arbitrum", "optimism", "ethereum", "polygon", "solana"],
    assets: ["USDC"],
    amount: { mode: "input", bounds: { USDC: { min: "10", max: "5000", default: "100" } } },
  },
  constraints: { maxSlippageBps: 50, maxSeconds: 600 },
  expiresAt: "2026-12-31T23:59:59Z",
  maxUses: 1000,
  perAccount: { maxUses: 3 },
  blink: false,
  metadata: { campaign: "launch" },
};
const JITO = {
  title: "Bridge to Solana and stake as JitoSOL",
  // The design names this publisher "Jito Fans", which BYOC's reserved integrator words refuse ("jito" belongs to jito.network).
  publisher: { name: "Stake Fans", website: "https://stakefans.example" },
  destination: { actions: [{ kind: "stake", network: "solana", from: "SOL", to: "JitoSOL", amount: "$amount" }] },
  funding: {
    networks: ["ethereum", "base", "arbitrum", "optimism", "polygon", "solana"],
    assets: ["ETH", "USDC", "SOL"],
    amount: { mode: "input", bounds: { ETH: { min: "0.005", max: "2" }, USDC: { min: "10", max: "5000" }, SOL: { min: "0.05", max: "25" } } },
  },
  expiresAt: "2027-03-31T00:00:00Z",
  blink: true,
};
const PAY = {
  title: "Pay 25 USDC to acme.base.eth",
  publisher: { name: "Acme Store", website: "https://shop.acme.example" },
  destination: { actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "25", recipient: "acme.base.eth" }] },
  funding: { networks: ["base", "arbitrum", "optimism", "ethereum", "polygon", "solana"], assets: ["USDC"], amount: { mode: "deliver" } },
  maxUses: 1,
  expiresAt: "2026-10-16T00:00:00Z",
  blink: true,
  metadata: { invoice: "A-1029" },
};

const validate = (definition) => validateLinkDefinition(definition, { now: NOW });
const valid = (definition) => {
  const result = validate(definition);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  return result.value;
};
const issues = (definition) => {
  const result = validate(definition);
  assert.equal(result.ok, false, "expected issues");
  return result.issues.map((issue) => issue.path);
};
const stored = (definition, pins) => ({ definition: valid(definition), pins });
const VAULT_PINS = {
  recipients: [],
  contracts: [{ action: 0, contract: "ct_5f1c2a9b7e3d4c6a8b0e1f23", revision: 3, definitionHash: "a".repeat(64), entry: "deposit", target: "0xbeef010f9cb27031ad51e3333f9af9c6b1228183" }],
  destinationAsset: ref("base", "USDC"),
};
const JITO_PINS = { recipients: [], contracts: [], destinationAsset: ref("solana", "SOL") };
const PAY_PINS = { recipients: [{ action: 0, account: MERCHANT, name: "acme.base.eth" }], contracts: [], destinationAsset: ref("base", "USDC") };

test("ids, limits and notices", () => {
  assert.match("lk_5f1c2a9b7e3d4c6a8b0e1f23", LINK_ID_PATTERN);
  assert.equal(isLinkId("lk_5F1C2A9B7E3D4C6A8B0E1F23"), false);
  assert.equal(LINK_LIMITS.activeLinksPerKey, 200);
  assert.equal(LINK_LIMITS.metadataEntries, 19);
  assert.deepEqual(linkNotices("Acme Yield")[1], "Acme Yield can see the wallet addresses of intents created from this link.");
});

test("the three reference links validate and normalise", () => {
  assert.deepEqual(issues({ ...JITO, publisher: { name: "Jito Fans", website: "https://jitofans.example" } }), ["publisher.name"], "reserved brand word");
  const vault = valid(VAULT);
  assert.equal(vault.expiresAt, "2026-12-31T23:59:59.000Z");
  assert.deepEqual(vault.funding.amount, { mode: "input", bounds: { USDC: { min: "10", max: "5000", default: "100" } } });
  assert.equal(vault.blink, false);
  const jito = valid(JITO);
  assert.deepEqual(jito.funding.assets, ["ETH", "USDC", "SOL"]);
  const pay = valid(PAY);
  assert.deepEqual(pay.funding.amount, { mode: "deliver" });
  const noExpiry = valid({ ...PAY, expiresAt: undefined });
  assert.equal(noExpiry.expiresAt, new Date(NOW + 30 * 86_400_000).toISOString(), "30 days by default");
  assert.deepEqual(linkDestinationAsset(pay), ref("base", "USDC"));
  assert.equal(linkDestinationAsset(vault), null, "call/action destinations are pinned from the registration");
  assert.deepEqual(linkFundingOptions(jito.funding).filter((option) => option.network === "polygon").map((option) => option.symbol), ["USDC"], "ETH is not an option on Polygon");
});

test("title and description: length after NFKC, no controls or bidi, no em or en dashes, no Kletia in the title", () => {
  assert.deepEqual(issues({ ...VAULT, title: "Hi" }), ["title"]);
  assert.deepEqual(issues({ ...VAULT, title: "x".repeat(81) }), ["title"]);
  assert.deepEqual(issues({ ...VAULT, title: "Deposit ‮USDC" }), ["title"], "bidi override");
  assert.deepEqual(issues({ ...VAULT, title: "Deposit​USDC" }), ["title"], "zero-width space");
  assert.deepEqual(issues({ ...VAULT, title: "Deposit — USDC" }), ["title"], "em dash");
  assert.deepEqual(issues({ ...VAULT, title: "Deposit – USDC" }), ["title"], "en dash");
  assert.deepEqual(issues({ ...VAULT, title: "Official Kletia vault" }), ["title"]);
  assert.deepEqual(issues({ ...VAULT, title: "Official K-l-é-t-i-a vault" }), ["title"], "folded and stripped");
  assert.equal(valid({ ...VAULT, title: "  Ｄｅｐｏｓｉｔ USDC  " }).title, "Deposit USDC", "NFKC");
  assert.deepEqual(issues({ ...VAULT, description: "a\nb" }), ["description"]);
  assert.deepEqual(issues({ ...VAULT, description: "x".repeat(281) }), ["description"]);
});

test("publisher: integrator name rules, reserved names need the reserved host, website required on the production lane", () => {
  assert.deepEqual(issues({ ...VAULT, publisher: { name: "A", website: "https://acme.example" } }), ["publisher.name"]);
  assert.deepEqual(issues({ ...VAULT, publisher: { name: "Acme <script>", website: "https://acme.example" } }), ["publisher.name"]);
  assert.deepEqual(issues({ ...VAULT, publisher: { name: "Aave Yield", website: "https://acme.example" } }), ["publisher.name"]);
  valid({ ...VAULT, publisher: { name: "Aave Yield", website: "https://app.aave.com" } });
  assert.deepEqual(issues({ ...VAULT, publisher: { name: "Acme Yield" } }), ["publisher.website"]);
  assert.deepEqual(issues({ ...VAULT, publisher: { name: "Acme Yield", website: "http://acme.example" } }), ["publisher.website"]);
  const testnet = {
    ...PAY,
    publisher: { name: "Acme Test" },
    destination: { actions: [{ kind: "transfer", network: "arbitrum-sepolia", from: "USDC", amount: "1", recipient: "0x1111111111111111111111111111111111111111" }] },
    funding: { networks: ["arbitrum-sepolia", "solana-devnet"], assets: ["USDC"], amount: { mode: "deliver" } },
  };
  valid(testnet);
});

test("actions: kinds, recipients only on transfers and contract entries, later actions never fixed, first action spends $amount", () => {
  const actions = (list) => ({ ...JITO, destination: { actions: list } });
  assert.deepEqual(issues(actions([{ kind: "borrow", network: "solana", from: "SOL", amount: "$amount" }])), ["destination.actions[0].kind"]);
  assert.deepEqual(issues(actions([{ kind: "stake", network: "solana", from: "SOL", to: "JitoSOL", amount: "1" }])), ["destination.actions[0].amount"]);
  assert.deepEqual(issues(actions([{ kind: "stake", network: "solana", from: "SOL", to: "JitoSOL", amount: "$amount", recipient: "acme.sol" }])), ["destination.actions[0].recipient"]);
  assert.deepEqual(
    issues(actions([{ kind: "stake", network: "solana", from: "SOL", to: "JitoSOL", amount: "$amount" }, { kind: "transfer", network: "solana", from: "JitoSOL", amount: "1", recipient: "acme.sol" }])),
    ["destination.actions[1].amount"],
    "a link cannot ask for funds it did not route",
  );
  valid(actions([{ kind: "stake", network: "solana", from: "SOL", to: "JitoSOL", amount: "$amount" }, { kind: "transfer", network: "solana", from: "JitoSOL", amount: "max", recipient: "acme.sol" }]));
  valid(actions([{ kind: "stake", network: "solana", from: "SOL", to: "JitoSOL", amount: "$amount" }, { kind: "transfer", network: "solana", from: "JitoSOL", params: { portionBps: 5000 }, recipient: "acme.sol" }]));
  assert.deepEqual(issues(actions([{ kind: "transfer", network: "solana", from: "SOL", amount: "$amount" }])), ["destination.actions[0].recipient"]);
  assert.deepEqual(issues(actions([{ kind: "transfer", network: "solana", from: "SOL", amount: "$amount", recipient: "0x1111111111111111111111111111111111111111" }])), ["destination.actions[0].recipient"], "an EVM address on Solana");
  assert.deepEqual(issues(actions([{ kind: "call", network: "solana", amount: "$amount" }])), ["destination.actions[0].contract", "destination.actions[0].entry"]);
  assert.deepEqual(issues(actions([{ kind: "stake", network: "solana", from: "SOL", to: "JitoSOL", amount: "$amount", contract: "ct_5f1c2a9b7e3d4c6a8b0e1f23" }])), ["destination.actions[0].contract"]);
  assert.deepEqual(issues(actions(Array.from({ length: 7 }, () => ({ kind: "stake", network: "solana", from: "SOL", to: "JitoSOL", amount: "max" })))), ["destination.actions"]);
});

test("funding: lanes, pairs that resolve, bounds per asset and their decimals on every network", () => {
  assert.deepEqual(issues({ ...VAULT, funding: { ...VAULT.funding, networks: ["base", "arbitrum-sepolia"] } }), ["funding.networks"], "one capital lane");
  const bad = validate({ ...VAULT, funding: { ...VAULT.funding, networks: ["base"], assets: ["USDC", "JitoSOL"], amount: { mode: "input", bounds: { USDC: { min: "10", max: "20" }, JitoSOL: { min: "1", max: "2" } } } } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "LINK_SOURCE_NOT_ALLOWED", "JitoSOL exists on none of the funding networks");
  assert.deepEqual(issues({ ...VAULT, funding: { ...VAULT.funding, amount: { mode: "input", bounds: {} } } }), ["funding.amount.bounds.USDC"]);
  assert.deepEqual(issues({ ...VAULT, funding: { ...VAULT.funding, amount: { mode: "input", bounds: { USDC: { min: "10", max: "5", default: "7" } } } } }), ["funding.amount.bounds.USDC"]);
  assert.deepEqual(issues({ ...VAULT, funding: { ...VAULT.funding, amount: { mode: "input", bounds: { USDC: { min: "0.0000001", max: "5" } } } } }), ["funding.amount.bounds.USDC"], "USDC has 6 decimals");
  assert.deepEqual(issues({ ...VAULT, funding: { ...VAULT.funding, amount: { mode: "input", bounds: { USDC: { min: "1", max: "5" }, SOL: { min: "1", max: "2" } } } } }), ["funding.amount.bounds.SOL"]);
  assert.deepEqual(issues({ ...VAULT, funding: { ...VAULT.funding, assets: ["DOGE"] } }), ["funding.assets[0]", "funding.amount.bounds.USDC"]);
  assert.deepEqual(issues({ ...VAULT, constraints: { maxSlippageBps: 301 } }), ["constraints.maxSlippageBps"]);
  assert.deepEqual(issues({ ...VAULT, constraints: { maxFeeUsd: 1 } }), ["constraints.maxFeeUsd"]);
  assert.deepEqual(issues({ ...VAULT, expiresAt: "2027-10-10T00:00:00Z" }), ["expiresAt"], "at most 365 days ahead");
  assert.deepEqual(issues({ ...VAULT, expiresAt: "2026-10-01T00:00:00Z" }), ["expiresAt"]);
  assert.deepEqual(issues({ ...VAULT, maxUses: 0 }), ["maxUses"]);
  assert.deepEqual(issues({ ...VAULT, perAccount: { maxUses: 101 } }), ["perAccount"]);
  assert.deepEqual(issues({ ...VAULT, metadata: { linkId: "x" } }), ["metadata"], "Kletia sets linkId");
  assert.deepEqual(issues({ ...VAULT, surprise: true }), ["surprise"]);
});

test("deliver mode: one fixed transfer, funding assets of the delivered group, and only the delivered asset on the destination network", () => {
  assert.deepEqual(issues({ ...PAY, destination: { actions: [{ ...PAY.destination.actions[0], amount: "$amount" }] } }), ["destination.actions[0].amount"]);
  assert.deepEqual(issues({ ...PAY, destination: { actions: [{ kind: "stake", network: "solana", from: "SOL", to: "JitoSOL", amount: "1" }] } }), ["destination.actions"]);
  assert.deepEqual(issues({ ...PAY, destination: { actions: [{ ...PAY.destination.actions[0], amount: "25.0000001" }] } }), ["destination.actions[0].amount"]);
  const group = validate({ ...PAY, funding: { ...PAY.funding, assets: ["USDC", "SOL"] } });
  assert.equal(group.code, "LINK_SOURCE_NOT_ALLOWED", "SOL is not in the USDC group");
  const eth = {
    ...PAY,
    destination: { actions: [{ kind: "transfer", network: "base", from: "ETH", amount: "0.01", recipient: "acme.base.eth" }] },
    funding: { networks: ["base", "arbitrum"], assets: ["ETH", "WETH"], amount: { mode: "deliver" } },
  };
  const result = validate(eth);
  assert.equal(result.code, "LINK_SOURCE_NOT_ALLOWED");
  assert.ok(result.issues.some((issue) => /only ETH itself/u.test(issue.message)));
});

test("expandLink, input mode: direct, swap on the destination network, bridge from another network", () => {
  const vault = stored(VAULT, VAULT_PINS);
  const direct = expandLink(vault, { network: "base", asset: "USDC", amount: "250" });
  assert.equal(direct.case, "direct");
  assert.deepEqual(direct.actions, [{ kind: "call", network: "base", contract: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entry: "deposit", amount: "250" }], "alias replaced by the pinned registration");
  assert.deepEqual(direct.requiredVms, ["evm"]);
  assert.deepEqual(direct.envelope, { networks: ["base"], recipients: [], contracts: [{ contract: "ct_5f1c2a9b7e3d4c6a8b0e1f23", revision: 3, definitionHash: "a".repeat(64) }], root: { network: "base", asset: ref("base", "USDC").asset, amount: "250" } });

  const bridged = expandLink(vault, { network: "arbitrum", asset: "usdc", amount: "250" });
  assert.equal(bridged.case, "bridge");
  assert.deepEqual(bridged.actions, [
    { kind: "bridge", network: "arbitrum", from: ref("arbitrum", "USDC").asset, to: ref("base", "USDC").asset, toNetwork: "base", amount: "250" },
    { kind: "call", network: "base", contract: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entry: "deposit", amount: "max" },
  ]);
  assert.deepEqual(bridged.envelope.networks, ["arbitrum", "base"]);
  assert.deepEqual(expandLink(vault, { network: "solana", asset: "USDC", amount: "250" }).requiredVms, ["evm", "svm"]);
  assert.equal(expandLink(vault, { network: "base", asset: "USDC" }).envelope.root.amount, "100", "the default amount");

  const jito = stored(JITO, JITO_PINS);
  const swap = expandLink(jito, { network: "solana", asset: "USDC", amount: "50" });
  assert.equal(swap.case, "swap");
  assert.deepEqual(swap.actions, [
    { kind: "swap", network: "solana", from: ref("solana", "USDC").asset, to: ref("solana", "SOL").asset, amount: "50" },
    { kind: "stake", network: "solana", from: "SOL", to: "JitoSOL", amount: "max" },
  ]);
  assert.deepEqual(swap.requiredVms, ["svm"]);
  assert.deepEqual(expandLink(jito, { network: "base", asset: "ETH", amount: "0.1" }).requiredVms, ["evm", "svm"]);
});

test("expandLink, deliver mode: direct transfer, absorbed bridge to the pinned recipient, sized input, refusals", () => {
  const pay = stored(PAY, PAY_PINS);
  const direct = expandLink(pay, { network: "base", asset: "USDC" });
  assert.equal(direct.case, "deliver-direct");
  assert.deepEqual(direct.actions, [{ kind: "transfer", network: "base", from: "USDC", amount: "25", recipient: MERCHANT }], "the name is replaced by the pinned address");
  assert.deepEqual(direct.envelope.recipients, [MERCHANT]);
  const bridged = expandLink(pay, { network: "solana", asset: "USDC" });
  assert.equal(bridged.case, "deliver-bridge");
  assert.deepEqual(bridged.actions, [
    { kind: "bridge", network: "solana", from: ref("solana", "USDC").asset, to: ref("base", "USDC").asset, toNetwork: "base", recipient: MERCHANT, amount: "25.075226" },
  ]);
  assert.deepEqual(bridged.requiredVms, ["svm"], "the transfer is absorbed: one signature on Solana");
  assert.equal(expandLink(pay, { network: "solana", asset: "USDC" }, { deliverInput: "25.157732" }).actions[0].amount, "25.157732");
  const refuse = (choice, code, options) => assert.throws(() => expandLink(pay, choice, options), (error) => error instanceof LinkExpansionError && error.code === code);
  refuse({ network: "base", asset: "USDC", amount: "30" }, "LINK_INPUT_OUT_OF_BOUNDS");
  refuse({ network: "solana-devnet", asset: "USDC" }, "LINK_SOURCE_NOT_ALLOWED");
  refuse({ network: "solana", asset: "SOL" }, "LINK_SOURCE_NOT_ALLOWED");
  refuse({ network: "solana", asset: "USDC" }, "LINK_PLAN_OUT_OF_BOUNDS", { deliverInput: "1.0000001" });
  const eth = {
    definition: {
      ...valid(PAY),
      destination: { actions: [{ kind: "transfer", network: "base", from: "ETH", amount: "0.01", recipient: "acme.base.eth" }] },
      funding: { networks: ["base"], assets: ["ETH", "WETH"], amount: { mode: "deliver" } },
    },
    pins: { ...PAY_PINS, destinationAsset: ref("base", "ETH") },
  };
  assert.throws(() => expandLink(eth, { network: "base", asset: "WETH" }), (error) => error.code === "LINK_SOURCE_NOT_ALLOWED", "deliver: on the destination only the delivered asset");
  assert.throws(() => expandLink({ ...pay, pins: { ...PAY_PINS, recipients: [] } }, { network: "base", asset: "USDC" }), (error) => error.code === "LINK_PLAN_OUT_OF_BOUNDS", "an unpinned recipient is a bug");
});

test("expandLink, input bounds: below min, above max, too many decimals", () => {
  const vault = stored(VAULT, VAULT_PINS);
  for (const amount of ["9.99", "5000.01", "10.0000001"]) {
    assert.throws(() => expandLink(vault, { network: "base", asset: "USDC", amount }), (error) => error.code === "LINK_INPUT_OUT_OF_BOUNDS", amount);
  }
  assert.equal(expandLink(vault, { network: "base", asset: "USDC", amount: "5000" }).envelope.root.amount, "5000");
});

test("deliver sizing reproduces the live Relay Solana → Base sequence (25.075 short, 25.157732 delivers ≥ 25)", () => {
  assert.equal(linkDeliverFirstGuess(25_000_000n, 6, 6), 25_075_226n);
  assert.equal(linkDeliverFirstGuess(25_000_000n, 6, 18), 25_075_225_677_031_093_280n, "scaled to the funding asset's decimals");
  assert.equal(linkDeliverAccepts(24_922_771n, 25_000_000n), false, "x0 = 25.075 → minimum 24.922771 is short");
  const x1 = linkDeliverRescale(25_075_000n, 25_000_000n, 24_922_771n, LINK_LIMITS.deliverSecondMarginBps);
  assert.equal(x1, 25_157_732n);
  assert.equal(linkDeliverAccepts(25_005_071n, 25_000_000n), true, "x1 = 25.157732 → minimum 25.005071");
  assert.equal(linkDeliverAccepts(25_200_000n, 25_000_000n), false, "surplus above 50 bps");
  assert.throws(() => linkDeliverRescale(1n, 1n, 0n, 2));
});

test("blink eligibility of the three reference links", () => {
  const ready = { domainVerified: true, status: "active", blinksEnabled: true };
  const vault = blinkEligibility(stored(VAULT, VAULT_PINS), ready);
  assert.equal(vault.eligible, false);
  assert.match(vault.reason, /also sign on Base/u);
  const jito = blinkEligibility(stored(JITO, JITO_PINS), ready);
  assert.deepEqual({ eligible: jito.eligible, enabled: jito.enabled, assets: jito.assets, chain: jito.chain }, { eligible: true, enabled: true, assets: ["USDC", "SOL"], chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
  assert.equal(blinkEligibility(stored(JITO, JITO_PINS), { ...ready, domainVerified: false }).enabled, false);
  assert.equal(blinkEligibility(stored(JITO, JITO_PINS)).reason, "The publisher's domain is not verified.");
  const pay = blinkEligibility(stored(PAY, PAY_PINS), ready);
  assert.equal(pay.eligible, true, "the transfer is absorbed into one Solana transaction");
  assert.equal(pay.enabled, false);
  assert.match(pay.reason, /operator approval/u);
  assert.equal(blinkEligibility(stored(PAY, PAY_PINS), { ...ready, operatorApproved: true }).enabled, true);
  assert.equal(blinkEligibility(stored({ ...JITO, blink: false }, JITO_PINS), ready).reason, "The publisher did not enable the blink.");
  assert.equal(blinkEligibility(stored(JITO, JITO_PINS), { ...ready, status: "paused" }).reason, "The link is paused.");
});

test("boardText folds to the departure-board alphabet", () => {
  assert.equal(boardText("Pay 25 USDC to acme.base.eth"), "PAY 25 USDC TO ACME.BASE.ETH");
  assert.equal(boardText("İstanbul ıslak şehir"), "ISTANBUL ISLAK SEHIR");
  assert.equal(boardText("Café 🚆 — ok"), "CAFE ? ? OK");
  assert.equal(boardText("zero​width  and\ttabs"), "ZEROWIDTH AND TABS");
  assert.equal(boardText("A very long title that goes on", { maxLength: 12 }), "A VERY LO...");
  for (const char of boardText("@#$%&'()+-./:=>?_~!,")) assert.ok(char === " " || BOARD_ALPHABET.includes(char));
});

test("domain verification file lists a link or its owner key; visitor intent bodies are validated", () => {
  assert.equal(domainFileListsLink({ links: ["lk_5f1c2a9b7e3d4c6a8b0e1f23"] }, "lk_5f1c2a9b7e3d4c6a8b0e1f23", "key_0123456789abcdef01234567"), true);
  assert.equal(domainFileListsLink({ keys: ["key_0123456789abcdef01234567"] }, "lk_000000000000000000000000", "key_0123456789abcdef01234567"), true);
  assert.equal(domainFileListsLink({ contracts: ["lk_5f1c2a9b7e3d4c6a8b0e1f23"] }, "lk_5f1c2a9b7e3d4c6a8b0e1f23", "key_x"), false);
  assert.equal(domainFileListsLink("lk_5f1c2a9b7e3d4c6a8b0e1f23", "lk_5f1c2a9b7e3d4c6a8b0e1f23", "key_x"), false);
  assert.equal(domainFileListsContract({ contracts: ["ct_1"], links: ["lk_1"] }, "ct_1"), true, "one file serves both");
  const body = { accounts: ["eip155:42161:0x1111111111111111111111111111111111111111"], source: { network: "arbitrum", asset: "USDC" }, amount: "250" };
  assert.deepEqual(validateLinkIntentRequest(body), { ok: true, value: body });
  assert.equal(validateLinkIntentRequest({ ...body, recipient: "x" }).ok, false, "visitors cannot set recipients");
  assert.equal(validateLinkIntentRequest({ ...body, amount: "-1" }).ok, false);
  assert.equal(validateLinkIntentRequest({ ...body, accounts: [] }).ok, false);
  assert.equal(validateLinkIntentRequest({ source: body.source }, { accountsOptional: true }).ok, true);
});

test("oversized decimal amounts are refused without throwing", () => {
  const huge = `1.${"0".repeat(50)}1`;
  assert.deepEqual(issues({ ...VAULT, funding: { ...VAULT.funding, amount: { mode: "input", bounds: { USDC: { min: huge, max: "5000" } } } } }), ["funding.amount.bounds.USDC"]);
  assert.equal(validateLinkIntentRequest({ accounts: ["eip155:8453:0x1111111111111111111111111111111111111111"], source: { network: "base", asset: "USDC" }, amount: "9".repeat(60) }).ok, false);
  assert.throws(() => expandLink(stored(VAULT, VAULT_PINS), { network: "base", asset: "USDC", amount: huge }), (error) => error.code === "LINK_INPUT_OUT_OF_BOUNDS");
});
