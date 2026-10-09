import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSETS,
  BENEFICIARY_ARG_PATTERN,
  CHAINS,
  CONTRACT_EVENT_TYPES,
  CONTRACT_ID_PATTERN,
  CONTRACT_LIMITS,
  CONTRACT_REVIEW_NOTICE,
  FORBIDDEN_FUNCTION_NAMES,
  FORBIDDEN_NAME_PREFIXES,
  FORBIDDEN_SELECTORS,
  RESERVED_CONTRACT_PHRASES,
  SESSION_ID_PATTERN,
  SOLANA_ACTION_BUILTIN_PROGRAMS,
  VENUE_CONTRACTS,
  YIELD_VENUES,
  abiItemDisplaySignature,
  abiItemSignature,
  bindingReviewSource,
  canonicalJson,
  classifyAbiFunction,
  contractActionFunction,
  contractDefinitionHash,
  contractSecurityFields,
  contractTarget,
  deniedTargetReason,
  domainFileListsContract,
  eventTopic,
  forbiddenFunctionReason,
  functionSelector,
  getProtocol,
  isChecksumAddressValid,
  isContractId,
  isSecurityRelevantChange,
  isSessionId,
  isSolanaAddress,
  keccak256Hex,
  needsApprovalReset,
  normalizeWebOrigin,
  primaryContractIssueCode,
  protocolExecutesKind,
  reservedContractPhrase,
  reservedIntegratorName,
  resolveContractParams,
  toChecksumAddress,
  validateContractDefinition,
  validateContractTestRequest,
  validateIntentRequest,
  validateSessionCreateRequest,
  validateSessionIntentRequest,
} from "../dist/index.js";

/* ------------------------------------------------------------------ fixtures */

const VAULT = "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183";
const OTHER = "0x1111111111111111111111111111111111111111";
const DEPOSIT_FN = {
  type: "function",
  name: "deposit",
  stateMutability: "nonpayable",
  inputs: [
    { name: "assets", type: "uint256" },
    { name: "receiver", type: "address" },
  ],
  outputs: [{ name: "shares", type: "uint256" }],
};
const DEPOSIT_EVENT = {
  type: "event",
  name: "Deposit",
  anonymous: false,
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "owner", type: "address", indexed: true },
    { name: "assets", type: "uint256", indexed: false },
    { name: "shares", type: "uint256", indexed: false },
  ],
};
const DEPOSIT_ACTION = {
  id: "deposit",
  label: "Deposit into Acme USDC vault",
  function: "deposit(uint256,address)",
  args: ["$amount", "$account"],
  input: { token: "USDC", approval: { spender: "$self" } },
  output: { token: "$self", toleranceBps: 10 },
  events: [{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$amount" }, output: "shares" }],
  phrases: { verbs: ["deposit", "supply"], aliases: ["acme vault", "acme"] },
  limits: { maxAmount: "25000" },
};

/** The §3.1 body of the design (Steakhouse USDC on Base). */
function evmDefinition(overrides = {}, action = {}) {
  return {
    vm: "evm",
    network: "base",
    address: VAULT,
    integrator: { name: "Acme Yield", website: "https://acme.example" },
    visibility: "private",
    abi: [DEPOSIT_FN, DEPOSIT_EVENT],
    actions: [{ ...DEPOSIT_ACTION, ...action }],
    ...overrides,
  };
}

/** A one-function definition whose function takes `inputs` bound by `args`. */
function oneFunction(inputs, args, extra = {}) {
  const fn = { type: "function", name: "stake", stateMutability: "nonpayable", inputs, outputs: [] };
  return evmDefinition(
    { abi: [fn, DEPOSIT_EVENT] },
    { function: abiItemSignature(fn), args, output: undefined, events: [{ event: "Deposit", emitter: "$self", where: { owner: "$account" } }], ...extra },
  );
}

function issueCodes(result) {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

function expectRefused(result, code, pathPart) {
  assert.equal(result.ok, false, `expected ${code}`);
  const hit = result.issues.find((issue) => issue.code === code && (!pathPart || issue.path.includes(pathPart)));
  assert.ok(hit, `${code} at ${pathPart ?? "*"} in ${JSON.stringify(result.issues)}`);
  return hit;
}

const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const NOOP = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
const PAYEE = "nick6zJc6HpW3kfBm4xS2dmbuVRyb5F3AnUvj5ymzR5";

function svmDefinition(overrides = {}, action = {}) {
  return {
    vm: "svm",
    network: "solana",
    integrator: { name: "Acme Stake", website: "https://acme.example" },
    origin: "https://actions.acme.example",
    programs: [JUPITER, NOOP],
    payees: [{ label: "Acme fee", address: PAYEE, maxLamports: "5000000" }],
    actions: [
      {
        id: "stake",
        label: "Stake USDC with Acme",
        href: "https://actions.acme.example/api/actions/stake?amount={amount}&lock={lockDays}",
        primaryProgram: JUPITER,
        input: { token: "USDC" },
        output: { mint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", toleranceBps: 10 },
        params: [{ name: "lockDays", type: "uint", min: 1, max: 365, default: 30 }],
        phrases: { verbs: ["stake"], aliases: ["acme stake"] },
        limits: { maxAmount: "10000" },
        ...action,
      },
    ],
    ...overrides,
  };
}

/* -------------------------------------------------------------- hash helpers */

test("keccak-256, selectors, topics and EIP-55 checksums match Ethereum", () => {
  assert.equal(keccak256Hex(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256Hex(new Uint8Array(0)), keccak256Hex(""));
  // EIP-1967 implementation slot = keccak256("eip1967.proxy.implementation") - 1
  assert.equal(keccak256Hex("eip1967.proxy.implementation"), "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbd");
  assert.equal(keccak256Hex("org.zeppelinos.proxy.implementation"), "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3");
  // Multi-block inputs (rate is 136 bytes).
  assert.equal(keccak256Hex("a".repeat(136)), "0xa6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e");
  assert.equal(functionSelector("deposit(uint256,address)"), "0x6e553f65");
  assert.equal(eventTopic("Transfer(address,address,uint256)"), "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  for (const entry of FORBIDDEN_SELECTORS) assert.equal(functionSelector(entry.signature), entry.selector, entry.signature);
  assert.equal(toChecksumAddress(VAULT.toLowerCase()), VAULT);
  assert.equal(toChecksumAddress("0xcb7c0000ab88b473b1f5afd9ef808440eed33bf".padEnd(42, "0")), toChecksumAddress("0xCB7C0000AB88B473B1F5AFD9EF808440EED33BF0"));
  assert.ok(isChecksumAddressValid(VAULT));
  assert.ok(isChecksumAddressValid(VAULT.toLowerCase()));
  assert.ok(!isChecksumAddressValid("0xbeef010f9cb27031ad51e3333f9aF9C6B1228183"), "wrong mixed case is a typo");
  assert.throws(() => toChecksumAddress("0x123"));
});

test("ids, notices and limits", () => {
  assert.ok(isContractId("ct_5f1c2a9b7e3d4c6a8b0e1f23"));
  assert.ok(!isContractId("ct_5F1C2A9B7E3D4C6A8B0E1F23"));
  assert.ok(!isContractId("ct_5f1c2a9b7e3d4c6a8b0e1f2"));
  assert.ok(CONTRACT_ID_PATTERN.test("ct_000000000000000000000000"));
  assert.ok(isSessionId(`cs_${"a".repeat(32)}`));
  assert.ok(!isSessionId(`cs_${"a".repeat(31)}`));
  assert.ok(!SESSION_ID_PATTERN.test("ct_5f1c2a9b7e3d4c6a8b0e1f23"));
  assert.match(CONTRACT_REVIEW_NOTICE, /^Not audited by Kletia\./u);
  assert.equal(CONTRACT_LIMITS.registrationsPerKey, 25);
  assert.equal(CONTRACT_LIMITS.definitionBytes, 48 * 1024);
  assert.deepEqual(
    [CONTRACT_LIMITS.eventsPerAction, CONTRACT_LIMITS.paramsPerAction, CONTRACT_LIMITS.aliasesPerAction, CONTRACT_LIMITS.verbsPerAction],
    [3, 6, 4, 4],
  );
  assert.deepEqual([CONTRACT_LIMITS.extraAddresses, CONTRACT_LIMITS.programs, CONTRACT_LIMITS.payees], [4, 6, 2]);
  assert.deepEqual([CONTRACT_LIMITS.sessionMinTtlSeconds, CONTRACT_LIMITS.sessionMaxTtlSeconds, CONTRACT_LIMITS.sessionMaxIntents], [60, 3600, 100]);
  assert.deepEqual(CONTRACT_EVENT_TYPES, ["contract.registered", "contract.activated", "contract.suspended", "contract.reactivated"]);
});

/* -------------------------------------------------------- EVM: happy path */

test("the design's ERC-4626 registration validates and normalises", () => {
  const result = validateContractDefinition(evmDefinition({ address: VAULT.toLowerCase() }));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const value = result.value;
  assert.equal(value.address, VAULT, "checksummed on output");
  assert.equal(value.visibility, "private");
  const action = value.actions[0];
  assert.equal(action.recipient, "account", "default recipient mode");
  assert.equal(action.output.toleranceBps, 10);
  assert.equal(action.events[0].event, "Deposit(address,address,uint256,uint256)", "event references are normalised to signatures");
  assert.deepEqual(action.phrases, { verbs: ["deposit", "supply"], aliases: ["acme vault", "acme"] });
  assert.equal(contractTarget(value), VAULT.toLowerCase());
  assert.equal(contractActionFunction(value, action).name, "deposit");
  assert.equal(abiItemDisplaySignature(DEPOSIT_FN), "deposit(uint256 assets, address receiver)");
  // Extra ABI keys (internalType, gas, constant) are dropped; outputs are kept.
  const noisy = evmDefinition({
    abi: [{ ...DEPOSIT_FN, constant: false, gas: 100, inputs: DEPOSIT_FN.inputs.map((input) => ({ ...input, internalType: input.type })) }, DEPOSIT_EVENT],
  });
  const normalized = validateContractDefinition(noisy);
  assert.equal(normalized.ok, true, JSON.stringify(normalized.issues));
  assert.equal("gas" in normalized.value.abi[0], false);
  assert.equal(normalized.value.abi[0].inputs[0].internalType, "uint256");
});

test("definition hashes cover security fields only", async () => {
  const base = validateContractDefinition(evmDefinition()).value;
  const relabelled = validateContractDefinition(evmDefinition({}, { label: "Another label", phrases: { verbs: ["stash"], aliases: ["acme pot"] } })).value;
  const capped = validateContractDefinition(evmDefinition({}, { limits: { maxAmount: "100" } })).value;
  const hash = await contractDefinitionHash(base);
  assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.equal(await contractDefinitionHash(relabelled), hash, "label and phrases are not security relevant");
  assert.notEqual(await contractDefinitionHash(capped), hash);
  assert.equal(isSecurityRelevantChange(base, relabelled), false);
  assert.equal(isSecurityRelevantChange(base, capped), true);
  assert.equal("label" in contractSecurityFields(base).actions[0], false);
  assert.equal(canonicalJson({ b: 1, a: [true, null, { d: "x", c: undefined }] }), '{"a":[true,null,{"d":"x"}],"b":1}');
});

/* ---------------------------------------------------- forbidden functions */

test("every forbidden selector and name prefix is refused, whatever the ABI claims", () => {
  for (const entry of FORBIDDEN_SELECTORS) {
    const reason = forbiddenFunctionReason("harmlessLooking", entry.signature);
    assert.ok(reason?.includes(entry.selector), entry.signature);
  }
  for (const prefix of FORBIDDEN_NAME_PREFIXES) {
    assert.ok(forbiddenFunctionReason(`${prefix}Something`, `${prefix}Something(uint256)`), prefix);
    assert.ok(forbiddenFunctionReason(`_${prefix.toUpperCase()}`, `_${prefix.toUpperCase()}(uint256)`), `_${prefix} upper case`);
  }
  for (const name of FORBIDDEN_FUNCTION_NAMES) assert.ok(forbiddenFunctionReason(name, `${name}(uint256,bool)`), name);
  assert.equal(forbiddenFunctionReason("transferToVault", "transferToVault(uint256)"), null, "the transfer family is exact, not a prefix");
  assert.equal(forbiddenFunctionReason("deposit", "deposit(uint256,address)"), null);
  // A real 4-byte collision: many_msg_babbage(bytes1) is transfer(address,uint256) on the wire.
  const collision = { type: "function", name: "many_msg_babbage", stateMutability: "nonpayable", inputs: [{ name: "x", type: "bytes1" }], outputs: [] };
  assert.equal(functionSelector(abiItemSignature(collision)), "0xa9059cbb");
  const def = evmDefinition(
    { abi: [collision, DEPOSIT_EVENT] },
    { function: "many_msg_babbage(bytes1)", args: [{ literal: "0x01" }], input: undefined, output: undefined, limits: undefined, events: [{ event: "Deposit", emitter: "$self", where: { owner: "$account" } }] },
  );
  const refused = validateContractDefinition(def);
  expectRefused(refused, "CONTRACT_FUNCTION_FORBIDDEN", "abi[0]");
  assert.equal(refused.code, "CONTRACT_FUNCTION_FORBIDDEN");
  assert.equal(classifyAbiFunction(collision).allowed, false);
  const fromFn = { type: "function", name: "gasprice_bit_ether", stateMutability: "nonpayable", inputs: [{ name: "x", type: "int128" }] };
  assert.equal(classifyAbiFunction({ ...fromFn, outputs: [] }).code, "CONTRACT_FUNCTION_FORBIDDEN", "collides with transferFrom");
});

test("forbidden functions in the ABI refuse the registration with CONTRACT_FUNCTION_FORBIDDEN", () => {
  const approve = { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] };
  const result = validateContractDefinition(evmDefinition({ abi: [DEPOSIT_FN, DEPOSIT_EVENT, approve] }));
  const issue = expectRefused(result, "CONTRACT_FUNCTION_FORBIDDEN", "abi[2]");
  assert.match(issue.message, /0x095ea7b3/u);
  assert.equal(result.code, "CONTRACT_FUNCTION_FORBIDDEN", "the forbidden function outranks the unused-function issue");
  const multicall = { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [] };
  const mc = validateContractDefinition(evmDefinition({ abi: [DEPOSIT_FN, DEPOSIT_EVENT, multicall] }));
  expectRefused(mc, "CONTRACT_FUNCTION_FORBIDDEN", "abi[2]");
  assert.equal(classifyAbiFunction(multicall).allowed, false);
});

test("view and pure functions are refused; payable needs a capped value", () => {
  const view = { ...DEPOSIT_FN, stateMutability: "view" };
  expectRefused(validateContractDefinition(evmDefinition({ abi: [view, DEPOSIT_EVENT] })), "CONTRACT_FUNCTION_FORBIDDEN", "function");
  assert.equal(classifyAbiFunction(view).allowed, false);
  const pure = { ...DEPOSIT_FN, stateMutability: "pure" };
  expectRefused(validateContractDefinition(evmDefinition({ abi: [pure, DEPOSIT_EVENT] })), "CONTRACT_FUNCTION_FORBIDDEN", "function");

  const payable = { ...DEPOSIT_FN, stateMutability: "payable" };
  expectRefused(validateContractDefinition(evmDefinition({ abi: [payable, DEPOSIT_EVENT] })), "CONTRACT_BINDING_INVALID", "value");
  const withFee = validateContractDefinition(evmDefinition({ abi: [payable, DEPOSIT_EVENT] }, { value: { bind: "1000", max: "1000" } }));
  assert.equal(withFee.ok, true, JSON.stringify(withFee.issues));
  expectRefused(validateContractDefinition(evmDefinition({ abi: [payable, DEPOSIT_EVENT] }, { value: { bind: "1001", max: "1000" } })), "CONTRACT_BINDING_INVALID", "value.bind");
  expectRefused(validateContractDefinition(evmDefinition({ abi: [payable, DEPOSIT_EVENT] }, { value: { bind: "1000" } })), "CONTRACT_BINDING_INVALID", "value.max");
  expectRefused(validateContractDefinition(evmDefinition({}, { value: { bind: "0", max: "0" } })), "CONTRACT_BINDING_INVALID", "value");
  // $amount as value only with a native input; a native input needs payable + $amount.
  expectRefused(validateContractDefinition(evmDefinition({ abi: [payable, DEPOSIT_EVENT] }, { value: { bind: "$amount", max: "10" } })), "CONTRACT_BINDING_INVALID", "value.bind");
  const ethFn = { type: "function", name: "depositETH", stateMutability: "payable", inputs: [{ name: "onBehalfOf", type: "address" }], outputs: [] };
  const native = (action) =>
    validateContractDefinition(
      evmDefinition(
        { abi: [ethFn, DEPOSIT_EVENT] },
        { function: "depositETH(address)", args: ["$account"], input: { token: "native" }, output: undefined, events: [{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$amount" } }], limits: { maxAmount: "1" }, ...action },
      ),
    );
  assert.equal(native({ value: { bind: "$amount", max: "2000000000000000000" } }).ok, true);
  expectRefused(native({ value: { bind: "$amount", max: "500000000000000000" } }), "CONTRACT_BINDING_INVALID", "limits.maxAmount");
  expectRefused(native({ value: { bind: "100", max: "100" } }), "CONTRACT_BINDING_INVALID", "value.bind");
  expectRefused(native({}), "CONTRACT_BINDING_INVALID", "input.token");
  expectRefused(native({ value: { bind: "$amount", max: "2000000000000000000" }, input: { token: "native", approval: { spender: "$self" } } }), "CONTRACT_BINDING_INVALID", "input.approval");
});

/* ----------------------------------------------------- argument bindings */

test("bytes accept only the empty literal; bytes[] and function arguments are refused", () => {
  const ok = validateContractDefinition(oneFunction([{ name: "data", type: "bytes" }], [{ literal: "0x" }], { input: undefined, limits: undefined }));
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  expectRefused(validateContractDefinition(oneFunction([{ name: "data", type: "bytes" }], [{ literal: "0x00" }], { input: undefined, limits: undefined })), "CONTRACT_ARGUMENT_FORBIDDEN", "args[0]");
  expectRefused(validateContractDefinition(oneFunction([{ name: "data", type: "bytes" }], ["$param.x"], { input: undefined, limits: undefined, params: [{ name: "x", type: "uint" }] })), "CONTRACT_ARGUMENT_FORBIDDEN", "args[0]");
  expectRefused(validateContractDefinition(oneFunction([{ name: "calls", type: "bytes[]" }], [{ array: [] }], { input: undefined, limits: undefined })), "CONTRACT_ARGUMENT_FORBIDDEN", "args[0]");
  expectRefused(validateContractDefinition(oneFunction([{ name: "calls", type: "bytes[2]" }], [{ array: [{ literal: "0x" }, { literal: "0x" }] }], { input: undefined, limits: undefined })), "CONTRACT_ARGUMENT_FORBIDDEN", "args[0]");
  expectRefused(validateContractDefinition(oneFunction([{ name: "cb", type: "function" }], [{ literal: "0x" }], { input: undefined, limits: undefined })), "CONTRACT_ARGUMENT_FORBIDDEN", "args[0]");
  // bytes inside a tuple member follow the same rule.
  const tuple = [{ name: "order", type: "tuple", components: [{ name: "amount", type: "uint256" }, { name: "hook", type: "bytes" }] }];
  assert.equal(validateContractDefinition(oneFunction(tuple, [{ tuple: ["$amount", { literal: "0x" }] }])).ok, true);
  expectRefused(validateContractDefinition(oneFunction(tuple, [{ tuple: ["$amount", { literal: "0xdeadbeef" }] }])), "CONTRACT_ARGUMENT_FORBIDDEN", "tuple[1]");
  const classified = classifyAbiFunction({ type: "function", name: "zap", stateMutability: "nonpayable", inputs: [{ name: "data", type: "bytes" }], outputs: [] });
  assert.equal(classified.allowed, true);
  assert.match(classified.notes.join(" "), /0x/u);
  assert.equal(classifyAbiFunction({ type: "function", name: "zap", stateMutability: "nonpayable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [] }).code, "CONTRACT_ARGUMENT_FORBIDDEN");
});

test("receiver-like address arguments must bind to the user; other literals (a referrer) are allowed", () => {
  for (const name of ["receiver", "recipient", "to", "owner", "beneficiary", "onBehalfOf", "account", "user", "for", "dst", "destination", "_receiver", "Receiver", "ONBEHALFOF"]) {
    assert.ok(BENEFICIARY_ARG_PATTERN.test(name), name);
  }
  for (const name of ["referrer", "spender", "receivers", "tokenOwner", "delegatee"]) assert.ok(!BENEFICIARY_ARG_PATTERN.test(name), name);
  const literalReceiver = validateContractDefinition(evmDefinition({}, { args: ["$amount", { literal: OTHER }] }));
  expectRefused(literalReceiver, "CONTRACT_BINDING_INVALID", "args[1]");
  expectRefused(validateContractDefinition(evmDefinition({}, { args: ["$amount", { literal: "0x0000000000000000000000000000000000000000" }] })), "CONTRACT_BINDING_INVALID", "args[1]");
  expectRefused(validateContractDefinition(evmDefinition({}, { args: ["$amount", "$self"] })), "CONTRACT_BINDING_INVALID", "args[1]");
  expectRefused(validateContractDefinition(evmDefinition({}, { args: ["$amount", "$token"] })), "CONTRACT_BINDING_INVALID", "args[1]");
  assert.equal(validateContractDefinition(evmDefinition({}, { args: ["$amount", "$recipient"] })).ok, true);

  const withReferrer = (literal) =>
    validateContractDefinition(
      oneFunction(
        [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }, { name: "referrer", type: "address" }],
        ["$amount", "$account", { literal }],
      ),
    );
  assert.equal(withReferrer(OTHER).ok, true, "a fixed referrer is allowed (labelled in review)");
  assert.equal(withReferrer("0x0000000000000000000000000000000000000000").ok, true, "the zero address is always allowed");
  expectRefused(withReferrer("0x111111111111111111111111111111111111111G"), "CONTRACT_BINDING_INVALID", "args[2]");
  // Tuple members are checked by their own names.
  const tuple = [{ name: "params", type: "tuple", components: [{ name: "amount", type: "uint256" }, { name: "onBehalfOf", type: "address" }] }];
  assert.equal(validateContractDefinition(oneFunction(tuple, [{ tuple: ["$amount", "$account"] }])).ok, true);
  expectRefused(validateContractDefinition(oneFunction(tuple, [{ tuple: ["$amount", { literal: OTHER }] }])), "CONTRACT_BINDING_INVALID", "tuple[1]");
});

test("binding/type compatibility matrix", () => {
  const cases = [
    // [abi type, binding, ok]
    ["uint256", "$amount", true],
    ["uint128", "$amount", true],
    ["int256", "$amount", false],
    ["address", "$amount", false],
    ["uint256", "$minimumOutput", true],
    ["uint64", "$deadline", true],
    ["bytes32", "$deadline", false],
    ["uint256", "$previous.output.amount", true],
    ["address", "$previous.output.asset", true],
    ["uint256", "$previous.output.asset", false],
    ["address", "$account", true],
    ["address", "$recipient", true],
    ["address", "$token", true],
    ["address", "$self", true],
    ["uint256", "$account", false],
    ["bool", "$amount", false],
    ["string", "$account", false],
    ["uint256", "$unknown", false],
    ["uint256", "amount", false],
    ["uint256", { literal: "115792089237316195423570985008687907853269984665640564039457584007913129639935" }, true],
    ["uint256", { literal: "115792089237316195423570985008687907853269984665640564039457584007913129639936" }, false],
    ["uint8", { literal: "255" }, true],
    ["uint8", { literal: "256" }, false],
    ["uint256", { literal: "-1" }, false],
    ["uint256", { literal: 5 }, false],
    ["uint256", { literal: "01" }, false],
    ["int8", { literal: "-128" }, true],
    ["int8", { literal: "128" }, false],
    ["int256", { literal: "-0" }, false],
    ["bool", { literal: true }, true],
    ["bool", { literal: "true" }, false],
    ["bytes32", { literal: `0x${"ab".repeat(32)}` }, true],
    ["bytes32", { literal: `0x${"ab".repeat(31)}` }, false],
    ["bytes4", { literal: "0xdeadbeef" }, true],
    ["string", { literal: "kletia" }, true],
    ["string", { literal: "x".repeat(65) }, false],
    ["string", { literal: "line\nbreak" }, false],
    ["address", { literal: OTHER }, true],
    ["address", { literal: "0x123" }, false],
    ["uint256", { tuple: [] }, false],
    ["uint256", { literal: "1", extra: true }, false],
  ];
  for (const [type, binding, ok] of cases) {
    const extra = binding === "$minimumOutput" ? { output: { token: "$self" } } : {};
    const result = validateContractDefinition(oneFunction([{ name: "x", type }, { name: "assets", type: "uint256" }], [binding, "$amount"], extra));
    assert.equal(result.ok, ok, `${type} <- ${JSON.stringify(binding)}: ${JSON.stringify(result.issues)}`);
    if (!ok) assert.ok(issueCodes(result).includes("CONTRACT_BINDING_INVALID"), `${type} <- ${JSON.stringify(binding)} code`);
  }
});

test("$amount, $token and $minimumOutput need their declarations; ERC-20 inputs must bind $amount", () => {
  expectRefused(validateContractDefinition(evmDefinition({}, { input: undefined, limits: undefined })), "CONTRACT_BINDING_INVALID", "args[0]");
  const tokenArg = oneFunction([{ name: "token", type: "address" }, { name: "assets", type: "uint256" }], ["$token", "$amount"]);
  assert.equal(validateContractDefinition(tokenArg).ok, true);
  expectRefused(validateContractDefinition(oneFunction([{ name: "token", type: "address" }], ["$token"], { input: undefined, limits: undefined })), "CONTRACT_BINDING_INVALID", "args[0]");
  expectRefused(
    validateContractDefinition(oneFunction([{ name: "token", type: "address" }, { name: "assets", type: "uint256" }], ["$token", "$amount"], { input: { token: "ETH" }, value: { bind: "$amount", max: "1" } })),
    "CONTRACT_BINDING_INVALID",
    "args[0]",
  );
  const minOut = oneFunction([{ name: "assets", type: "uint256" }, { name: "minShares", type: "uint256" }], ["$amount", "$minimumOutput"]);
  expectRefused(validateContractDefinition(minOut), "CONTRACT_BINDING_INVALID", "args[1]");
  assert.equal(validateContractDefinition({ ...minOut, actions: [{ ...minOut.actions[0], output: { token: "$self" } }] }).ok, true);
  expectRefused(validateContractDefinition(oneFunction([{ name: "lockDays", type: "uint256" }], [{ literal: "30" }])), "CONTRACT_BINDING_INVALID", "args");
  // Non-spending call (claim) with no input and no limits.
  const claim = oneFunction([{ name: "account", type: "address" }], ["$account"], { input: undefined, limits: undefined });
  assert.equal(validateContractDefinition(claim).ok, true, JSON.stringify(validateContractDefinition(claim).issues));
});

test("tuples and literal arrays", () => {
  const tupleInputs = [{ name: "p", type: "tuple", components: [{ name: "assets", type: "uint256" }, { name: "lock", type: "uint32" }, { name: "inner", type: "tuple", components: [{ name: "flag", type: "bool" }] }] }];
  assert.equal(validateContractDefinition(oneFunction(tupleInputs, [{ tuple: ["$amount", { literal: "30" }, { tuple: [{ literal: true }] }] }])).ok, true);
  expectRefused(validateContractDefinition(oneFunction(tupleInputs, [{ tuple: ["$amount", { literal: "30" }] }])), "CONTRACT_BINDING_INVALID", "args[0]");
  expectRefused(validateContractDefinition(oneFunction(tupleInputs, ["$amount"])), "CONTRACT_BINDING_INVALID", "args[0]");
  assert.equal(abiItemSignature({ name: "f", inputs: tupleInputs }), "f((uint256,uint32,(bool)))");

  const arrays = [{ name: "assets", type: "uint256" }, { name: "ids", type: "uint256[]" }, { name: "pair", type: "address[2]" }];
  const bind = (ids, pair) => validateContractDefinition(oneFunction(arrays, ["$amount", { array: ids }, { array: pair }]));
  assert.equal(bind([{ literal: "1" }, { literal: "2" }], [{ literal: OTHER }, { literal: VAULT }]).ok, true);
  expectRefused(bind([{ literal: "1" }], [{ literal: OTHER }]), "CONTRACT_BINDING_INVALID", "args[2]");
  expectRefused(bind(Array.from({ length: 9 }, () => ({ literal: "1" })), [{ literal: OTHER }, { literal: OTHER }]), "CONTRACT_BINDING_INVALID", "args[1]");
  expectRefused(bind(["$amount"], [{ literal: OTHER }, { literal: OTHER }]), "CONTRACT_BINDING_INVALID", "array[0]");
  expectRefused(bind([{ literal: "1" }], ["$account", { literal: OTHER }]), "CONTRACT_BINDING_INVALID", "array[0]");
  // An address array named like a beneficiary cannot take literals.
  expectRefused(
    validateContractDefinition(oneFunction([{ name: "assets", type: "uint256" }, { name: "to", type: "address[]" }], ["$amount", { array: [{ literal: OTHER }] }])),
    "CONTRACT_BINDING_INVALID",
    "array[0]",
  );
  const tupleArray = [{ name: "assets", type: "uint256" }, { name: "legs", type: "tuple[]", components: [{ name: "id", type: "uint8" }, { name: "weight", type: "uint16" }] }];
  assert.equal(validateContractDefinition(oneFunction(tupleArray, ["$amount", { array: [{ tuple: [{ literal: "1" }, { literal: "5000" }] }] }])).ok, true);
  expectRefused(validateContractDefinition(oneFunction(tupleArray, ["$amount", { array: [{ tuple: [{ literal: "1" }, "$amount"] }] }])), "CONTRACT_BINDING_INVALID", "tuple[1]");
});

test("parameters: declared, typed, bounded and bound", () => {
  const lock = [{ name: "assets", type: "uint256" }, { name: "lockDays", type: "uint32" }];
  const def = (params, args = ["$amount", "$param.lockDays"]) => validateContractDefinition(oneFunction(lock, args, { params }));
  const ok = def([{ name: "lockDays", type: "uint", min: 1, max: 365, default: 30 }]);
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  assert.deepEqual(ok.value.actions[0].params, [{ name: "lockDays", type: "uint", min: "1", max: "365", default: "30" }]);
  expectRefused(def([]), "CONTRACT_BINDING_INVALID", "args[1]");
  expectRefused(def([{ name: "lockDays", type: "int" }]), "CONTRACT_BINDING_INVALID", "args[1]");
  expectRefused(def([{ name: "lockDays", type: "bool" }]), "CONTRACT_BINDING_INVALID", "args[1]");
  assert.equal(def([{ name: "lockDays", type: "enum", enum: ["short", "long"] }]).ok, true, "enums bind to uint (index)");
  expectRefused(def([{ name: "lockDays", type: "address" }]), "CONTRACT_DEFINITION_INVALID", "params[0].type");
  expectRefused(def([{ name: "lockDays", type: "uint", min: 10, max: 5 }]), "CONTRACT_DEFINITION_INVALID", "params[0].max");
  expectRefused(def([{ name: "lockDays", type: "uint", min: 1, max: 5, default: 9 }]), "CONTRACT_DEFINITION_INVALID", "params[0].default");
  expectRefused(def([{ name: "lockDays", type: "uint", min: -1 }]), "CONTRACT_DEFINITION_INVALID", "params[0].min");
  expectRefused(def([{ name: "amount", type: "uint" }], ["$amount", "$param.amount"]), "CONTRACT_DEFINITION_INVALID", "params[0].name");
  expectRefused(def([{ name: "lockDays", type: "uint" }, { name: "lockDays", type: "uint" }]), "CONTRACT_DEFINITION_INVALID", "params[1].name");
  expectRefused(def([{ name: "lockDays", type: "uint" }, { name: "unused", type: "bool" }]), "CONTRACT_DEFINITION_INVALID", "params");
  expectRefused(def([{ name: "lockDays", type: "enum", enum: [".."] }]), "CONTRACT_DEFINITION_INVALID", "params[0].enum");
  expectRefused(def(Array.from({ length: 7 }, (_, index) => ({ name: `p${index}`, type: "uint" }))), "CONTRACT_DEFINITION_INVALID", "params");

  const declared = ok.value.actions[0].params;
  assert.deepEqual(resolveContractParams(declared, undefined), { ok: true, values: { lockDays: "30" } });
  assert.deepEqual(resolveContractParams(declared, { lockDays: 90 }), { ok: true, values: { lockDays: "90" } });
  assert.deepEqual(resolveContractParams(declared, { lockDays: "90", portionBps: 5000 }), { ok: true, values: { lockDays: "90" } });
  assert.equal(resolveContractParams(declared, { lockDays: 366 }).ok, false);
  assert.equal(resolveContractParams(declared, { lockDays: 1.5 }).ok, false);
  assert.equal(resolveContractParams(declared, { other: 1 }).ok, false);
  assert.equal(resolveContractParams([{ name: "flag", type: "bool", required: true }], {}).ok, false);
  assert.deepEqual(resolveContractParams([{ name: "flag", type: "bool" }], { flag: "true" }), { ok: true, values: { flag: true } });
  assert.deepEqual(resolveContractParams([{ name: "tier", type: "enum", enum: ["a", "b"] }], { tier: "b" }), { ok: true, values: { tier: "b" } });
  assert.deepEqual(resolveContractParams([{ name: "constructor", type: "bool", default: true }], {}), { ok: true, values: { constructor: true } }, "inherited keys are not values");
  assert.equal(resolveContractParams([{ name: "tier", type: "enum", enum: ["a", "b"] }], { tier: "c" }).ok, false);
});

test("events prove success from the pinned emitter and must bind the user", () => {
  const withEvents = (events, extra = {}) => validateContractDefinition(evmDefinition(extra, { events }));
  expectRefused(withEvents([]), "CONTRACT_BINDING_INVALID", "events");
  expectRefused(withEvents([{ event: "Deposit", emitter: "$self", where: { assets: "$amount" } }]), "CONTRACT_BINDING_INVALID", "where");
  expectRefused(withEvents([{ event: "Withdraw", emitter: "$self", where: { owner: "$account" } }]), "CONTRACT_BINDING_INVALID", "events[0].event");
  expectRefused(withEvents([{ event: "Deposit", emitter: "vault", where: { owner: "$account" } }]), "CONTRACT_BINDING_INVALID", "emitter");
  expectRefused(withEvents([{ event: "Deposit", emitter: "$self", where: { nobody: "$account" } }]), "CONTRACT_BINDING_INVALID", "where.nobody");
  expectRefused(withEvents([{ event: "Deposit", emitter: "$self", where: { owner: "$amount" } }]), "CONTRACT_BINDING_INVALID", "where.owner");
  expectRefused(withEvents([{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$minimumOutput" } }]), "CONTRACT_BINDING_INVALID", "where.assets");
  expectRefused(withEvents([{ event: "Deposit", emitter: "$self", where: { owner: "$account" }, output: "sender" }]), "CONTRACT_BINDING_INVALID", "output");
  assert.equal(withEvents([{ event: "Deposit(address,address,uint256,uint256)", emitter: "$self", where: { owner: "$recipient", assets: { literal: "5" } } }]).ok, true);
  const fourEvents = Array.from({ length: 4 }, () => ({ event: "Deposit", emitter: "$self", where: { owner: "$account" } }));
  expectRefused(withEvents(fourEvents), "CONTRACT_BINDING_INVALID", "events");
  // Labelled emitters come from addresses.
  const labelled = withEvents([{ event: "Deposit", emitter: "vault", where: { owner: "$account" } }], { addresses: [{ label: "vault", address: OTHER }] });
  assert.equal(labelled.ok, true, JSON.stringify(labelled.issues));
  // Anonymous and ambiguous events.
  const anonymous = { ...DEPOSIT_EVENT, anonymous: true };
  expectRefused(validateContractDefinition(evmDefinition({ abi: [DEPOSIT_FN, anonymous] })), "CONTRACT_BINDING_INVALID", "events[0].event");
  const overloaded = { type: "event", name: "Deposit", inputs: [{ name: "owner", type: "address", indexed: true }] };
  const ambiguous = validateContractDefinition(evmDefinition({ abi: [DEPOSIT_FN, DEPOSIT_EVENT, overloaded] }));
  expectRefused(ambiguous, "CONTRACT_BINDING_INVALID", "events[0].event");
  const bySignature = validateContractDefinition(
    evmDefinition({ abi: [DEPOSIT_FN, DEPOSIT_EVENT, overloaded] }, { events: [{ event: "Deposit(address)", emitter: "$self", where: { owner: "$account" } }] }),
  );
  assert.equal(bySignature.ok, true, JSON.stringify(bySignature.issues));
  // An input named __proto__ can never make a where binding vanish.
  const proto = JSON.parse('{"type":"event","name":"Proto","inputs":[{"name":"__proto__","type":"address","indexed":true}]}');
  const protoDef = JSON.parse(JSON.stringify(evmDefinition({ abi: [DEPOSIT_FN, DEPOSIT_EVENT, proto] })));
  protoDef.actions[0].events = [JSON.parse('{"event":"Proto","emitter":"$self","where":{"__proto__":"$account"}}')];
  expectRefused(validateContractDefinition(protoDef), "CONTRACT_DEFINITION_INVALID", "abi[2]");
  // Indexed dynamic values cannot be compared.
  const named = { type: "event", name: "Named", inputs: [{ name: "owner", type: "address", indexed: true }, { name: "tag", type: "string", indexed: true }] };
  expectRefused(
    validateContractDefinition(evmDefinition({ abi: [DEPOSIT_FN, DEPOSIT_EVENT, named] }, { events: [{ event: "Named", emitter: "$self", where: { owner: "$account", tag: { literal: "x" } } }] })),
    "CONTRACT_BINDING_INVALID",
    "where.tag",
  );
});

test("inputs, approvals and outputs", () => {
  expectRefused(validateContractDefinition(evmDefinition({}, { input: { token: "NOTATOKEN" } })), "CONTRACT_DEFINITION_INVALID", "input.token");
  expectRefused(validateContractDefinition(evmDefinition({}, { input: { token: "SOL" } })), "CONTRACT_DEFINITION_INVALID", "input.token");
  assert.equal(validateContractDefinition(evmDefinition({}, { input: { token: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } })).ok, true);
  expectRefused(validateContractDefinition(evmDefinition({}, { input: { token: "eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831" } })), "CONTRACT_DEFINITION_INVALID", "input.token");
  expectRefused(validateContractDefinition(evmDefinition({}, { input: { token: "USDC", approval: { spender: "router" } } })), "CONTRACT_BINDING_INVALID", "spender");
  assert.equal(
    validateContractDefinition(evmDefinition({ addresses: [{ label: "router", address: OTHER }] }, { input: { token: "USDC", approval: { spender: "router" } } })).ok,
    true,
  );
  assert.equal(validateContractDefinition(evmDefinition({}, { input: { token: "USDC" } })).ok, true, "no approval: allowed (simulation decides)");
  expectRefused(validateContractDefinition(evmDefinition({}, { output: { token: "native" } })), "CONTRACT_DEFINITION_INVALID", "output.token");
  expectRefused(validateContractDefinition(evmDefinition({}, { output: { token: "USDC" } })), "CONTRACT_DEFINITION_INVALID", "output.token");
  expectRefused(validateContractDefinition(evmDefinition({}, { output: { token: "$self", toleranceBps: 101 } })), "CONTRACT_DEFINITION_INVALID", "toleranceBps");
  assert.equal(validateContractDefinition(evmDefinition({}, { output: { token: OTHER.toLowerCase() } })).value.actions[0].output.token, OTHER);
  expectRefused(validateContractDefinition(evmDefinition({}, { output: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } })), "CONTRACT_DEFINITION_INVALID", "output.token");
  // Limits: required on mainnet for spending actions, within the token's precision.
  expectRefused(validateContractDefinition(evmDefinition({}, { limits: undefined })), "CONTRACT_DEFINITION_INVALID", "maxAmount");
  assert.equal(validateContractDefinition(evmDefinition({ network: "arbitrum-sepolia", address: OTHER, integrator: { name: "Acme Yield" } }, { limits: undefined })).ok, true, "testnets need no cap or website");
  expectRefused(validateContractDefinition(evmDefinition({}, { limits: { maxAmount: "1.0000001" } })), "CONTRACT_DEFINITION_INVALID", "maxAmount");
  expectRefused(validateContractDefinition(evmDefinition({}, { limits: { maxAmount: "10", minAmount: "20" } })), "CONTRACT_DEFINITION_INVALID", "minAmount");
  expectRefused(validateContractDefinition(evmDefinition({}, { limits: { maxAmount: "0" } })), "CONTRACT_DEFINITION_INVALID", "maxAmount");
  expectRefused(validateContractDefinition(evmDefinition({}, { recipient: "anyone" })), "CONTRACT_DEFINITION_INVALID", "recipient");
  assert.equal(validateContractDefinition(evmDefinition({}, { recipient: "any" })).value.actions[0].recipient, "any");
});

test("reserved aliases: networks, assets, venue words, kletia and keywords", () => {
  for (const alias of ["base", "arbitrum one", "arb sepolia", "solana devnet", "op", "matic", "mainnet-beta", "usdc", "jitosol", "weth", "aave", "aave v3", "aavev3", "aave-v3", "compoundv3", "kamino-lend", "jup earn", "debridge dln", "morpho vaults", "jupiter lend", "li.fi", "dln", "kletia", "all", "max", "it", "vault", "custom-call", "10"]) {
    assert.ok(reservedContractPhrase(alias), alias);
  }
  for (const alias of ["acme aave", "kletia yield", "acme on base", "base vault", "my vault", "vault to", "jito pool"]) assert.ok(reservedContractPhrase(alias), `${alias} contains a reserved word`);
  for (const alias of ["acme vault", "acme", "hy vault", "acme stake", "acme usdc vault", "steak.house"]) assert.equal(reservedContractPhrase(alias), null, alias);
  for (const word of ["aave", "compound", "comet", "morpho", "moonwell", "jupiter", "jup", "kamino", "lifi", "li.fi", "debridge", "dln", "relay", "jito", "marinade", "sanctum", "msol", "jitosol", "jupsol", "kletia"]) {
    assert.ok(RESERVED_CONTRACT_PHRASES.includes(word), word);
  }
  for (const symbol of new Set(ASSETS.map((asset) => asset.symbol.toLowerCase()))) assert.ok(RESERVED_CONTRACT_PHRASES.includes(symbol), symbol);
  for (const network of Object.keys(CHAINS)) assert.ok(RESERVED_CONTRACT_PHRASES.includes(network), network);
  assert.deepEqual([...RESERVED_CONTRACT_PHRASES], [...RESERVED_CONTRACT_PHRASES].sort());

  const aliased = (phrases) => validateContractDefinition(evmDefinition({}, { phrases }));
  expectRefused(aliased({ verbs: ["deposit"], aliases: ["aave"] }), "CONTRACT_DEFINITION_INVALID", "aliases[0]");
  expectRefused(aliased({ verbs: ["deposit"], aliases: ["USDC Vault"] }), "CONTRACT_DEFINITION_INVALID", "aliases[0]");
  expectRefused(aliased({ verbs: ["deposit"], aliases: ["acme  vault"] }), "CONTRACT_DEFINITION_INVALID", "aliases[0]");
  expectRefused(aliased({ verbs: ["Deposit"], aliases: ["acme"] }), "CONTRACT_DEFINITION_INVALID", "verbs[0]");
  expectRefused(aliased({ verbs: ["into"], aliases: ["acme"] }), "CONTRACT_DEFINITION_INVALID", "verbs[0]");
  expectRefused(aliased({ verbs: ["a", "b", "c", "d", "e"].map((x) => `${x}${x}`), aliases: ["acme"] }), "CONTRACT_DEFINITION_INVALID", "verbs");
  expectRefused(aliased({ verbs: ["deposit"], aliases: ["one", "two", "three", "four", "five"].map((x) => `acme ${x}`) }), "CONTRACT_DEFINITION_INVALID", "aliases");
  expectRefused(aliased({ aliases: ["acme"] }), "CONTRACT_DEFINITION_INVALID", "verbs");
  // Two actions of one registration cannot share a (verb, alias) pair.
  const twice = evmDefinition();
  twice.actions = [twice.actions[0], { ...twice.actions[0], id: "deposit-again" }];
  expectRefused(validateContractDefinition(twice), "CONTRACT_DEFINITION_INVALID", "actions[1].phrases");
});

test("integrator names: charset, length and reserved brands", () => {
  const named = (name, website = "https://acme.example") => validateContractDefinition(evmDefinition({ integrator: { name, website } }));
  assert.equal(named("Acme & Co. (Yield)").ok, true);
  for (const name of ["A", "x".repeat(41), "Acme‮Yield", "Acme  Yield", " Acme", "Acme <script>", "12345", "Αcme"]) {
    expectRefused(named(name), "CONTRACT_DEFINITION_INVALID", "integrator.name");
  }
  for (const [name, word] of [["Kletia", "kletia"], ["Aave", "aave"], ["AaveYield", "aave"], ["The Kletia Fund", "kletia"], ["Uniswap Labs", "uniswap"], ["Relay Finance", "relay"], ["LI.FI", "lifi"], ["Jupiter Exchange", "jupiter"]]) {
    assert.equal(reservedIntegratorName(name)?.word, word, name);
    expectRefused(named(name), "CONTRACT_DEFINITION_INVALID", "integrator.name");
  }
  for (const name of ["Relayer Labs", "Polymorphic Labs", "Amplifier", "Encompass", "Acme Yield"]) assert.equal(reservedIntegratorName(name), null, name);
  assert.equal(named("Aave", "https://app.aave.com").ok, true, "the brand's own domain may use it (domain verification still applies)");
  expectRefused(named("Aave", "https://aave.com.evil.example"), "CONTRACT_DEFINITION_INVALID", "integrator.name");
  // Website: https origin, required on mainnet.
  for (const website of ["http://acme.example", "https://acme.example/path", "https://user@acme.example", "https://10.0.0.1", "https://localhost", "https://acme.example:8443", "https://acme.local"]) {
    expectRefused(named("Acme Yield", website), "CONTRACT_DEFINITION_INVALID", "integrator.website");
  }
  assert.equal(validateContractDefinition(evmDefinition({ integrator: { name: "Acme Yield", website: "https://Acme.Example/" } })).value.integrator.website, "https://acme.example");
  expectRefused(validateContractDefinition(evmDefinition({ integrator: { name: "Acme Yield" } })), "CONTRACT_DEFINITION_INVALID", "integrator.website");
});

test("schema, sizes and counts", () => {
  expectRefused(validateContractDefinition(null), "CONTRACT_DEFINITION_INVALID");
  expectRefused(validateContractDefinition(evmDefinition({ vm: "wasm" })), "CONTRACT_DEFINITION_INVALID", "vm");
  expectRefused(validateContractDefinition(evmDefinition({ network: "solana" })), "CONTRACT_DEFINITION_INVALID", "network");
  expectRefused(validateContractDefinition(evmDefinition({ network: "toString" })), "CONTRACT_DEFINITION_INVALID", "network");
  expectRefused(validateContractDefinition(evmDefinition({ visibility: "public" })), "CONTRACT_DEFINITION_INVALID", "visibility");
  assert.equal(validateContractDefinition(evmDefinition({ visibility: "project" })).value.visibility, "project");
  expectRefused(validateContractDefinition(evmDefinition({ owner: "me" })), "CONTRACT_DEFINITION_INVALID", "owner");
  expectRefused(validateContractDefinition(evmDefinition({}, { approvals: [] })), "CONTRACT_DEFINITION_INVALID", "actions[0].approvals");
  expectRefused(validateContractDefinition(evmDefinition({ address: "0xbeef010f9cb27031ad51e3333f9aF9C6B1228183" })), "CONTRACT_DEFINITION_INVALID", "address");
  expectRefused(validateContractDefinition(evmDefinition({}, { id: "Deposit" })), "CONTRACT_DEFINITION_INVALID", "actions[0].id");
  expectRefused(validateContractDefinition(evmDefinition({}, { label: "x".repeat(81) })), "CONTRACT_DEFINITION_INVALID", "actions[0].label");
  expectRefused(validateContractDefinition(evmDefinition({}, { function: "deposit(uint,address)" })), "CONTRACT_DEFINITION_INVALID", "function");
  expectRefused(validateContractDefinition(evmDefinition({}, { args: ["$amount"] })), "CONTRACT_BINDING_INVALID", "args");
  // ABI: allowlist, item types, canonical types, counts.
  const unused = { ...DEPOSIT_FN, name: "mint" };
  expectRefused(validateContractDefinition(evmDefinition({ abi: [DEPOSIT_FN, DEPOSIT_EVENT, unused] })), "CONTRACT_DEFINITION_INVALID", "abi[2]");
  expectRefused(validateContractDefinition(evmDefinition({ abi: [DEPOSIT_FN, DEPOSIT_EVENT, { type: "constructor", inputs: [] }] })), "CONTRACT_DEFINITION_INVALID", "abi[2].type");
  expectRefused(validateContractDefinition(evmDefinition({ abi: [{ ...DEPOSIT_FN, inputs: [{ name: "assets", type: "uint" }, DEPOSIT_FN.inputs[1]] }, DEPOSIT_EVENT] })), "CONTRACT_DEFINITION_INVALID", "type");
  expectRefused(validateContractDefinition(evmDefinition({ abi: [{ ...DEPOSIT_FN, inputs: [{ name: "assets", type: "fixed128x18" }, DEPOSIT_FN.inputs[1]] }, DEPOSIT_EVENT] })), "CONTRACT_DEFINITION_INVALID", "type");
  expectRefused(validateContractDefinition(evmDefinition({ abi: [DEPOSIT_FN, DEPOSIT_FN, DEPOSIT_EVENT] })), "CONTRACT_DEFINITION_INVALID", "abi[1]");
  const errors = Array.from({ length: 39 }, (_, index) => ({ type: "error", name: `E${index}`, inputs: [] }));
  expectRefused(validateContractDefinition(evmDefinition({ abi: [DEPOSIT_FN, DEPOSIT_EVENT, ...errors] })), "CONTRACT_DEFINITION_INVALID", "abi");
  assert.equal(validateContractDefinition(evmDefinition({ abi: [DEPOSIT_FN, DEPOSIT_EVENT, ...errors.slice(0, 38)] })).ok, true, "40 ABI items fit");
  const eleven = evmDefinition();
  eleven.actions = Array.from({ length: 11 }, (_, index) => ({ ...DEPOSIT_ACTION, id: `deposit-${index}`, phrases: undefined }));
  expectRefused(validateContractDefinition(eleven), "CONTRACT_DEFINITION_INVALID", "actions");
  const five = evmDefinition({ addresses: Array.from({ length: 5 }, (_, index) => ({ label: `a${index}`, address: `0x${String(index + 2).repeat(40)}` })) });
  expectRefused(validateContractDefinition(five), "CONTRACT_DEFINITION_INVALID", "addresses");
  expectRefused(validateContractDefinition(evmDefinition({ addresses: [{ label: "self", address: OTHER }] })), "CONTRACT_DEFINITION_INVALID", "label");
  expectRefused(validateContractDefinition(evmDefinition({ addresses: [{ label: "vault", address: VAULT }] })), "CONTRACT_DEFINITION_INVALID", "addresses[0].address");
  // Size: a definition above 48 KB of canonical JSON is refused.
  const bigTuple = { name: "p", type: "tuple", components: Array.from({ length: 32 }, (_, index) => ({ name: `m${index}`, type: "uint256", internalType: "x".repeat(120) })) };
  const bigErrors = Array.from({ length: 37 }, (_, index) => ({ type: "error", name: `Big${index}`, inputs: [bigTuple] }));
  const big = validateContractDefinition(evmDefinition({ abi: [DEPOSIT_FN, DEPOSIT_EVENT, ...bigErrors] }));
  const sizeIssue = expectRefused(big, "CONTRACT_DEFINITION_INVALID", "");
  assert.match(sizeIssue.message, /bytes/u);
  assert.equal(primaryContractIssueCode([{ code: "CONTRACT_BINDING_INVALID" }, { code: "CONTRACT_DENIED" }]), "CONTRACT_DENIED");
});

test("denied targets: tokens, venue routers, Permit2, Multicall3, precompiles and system contracts", () => {
  const denied = (network, address) => {
    const reason = deniedTargetReason(network, address);
    assert.ok(reason, `${network}:${address} is denied`);
    return reason;
  };
  for (const asset of ASSETS.filter((entry) => entry.address && CHAINS[entry.network].vm === "evm")) {
    assert.match(denied(asset.network, asset.address), new RegExp(asset.symbol, "u"));
    assert.ok(deniedTargetReason(asset.network, asset.address.toLowerCase()), "case-insensitive");
  }
  for (const venue of VENUE_CONTRACTS.filter((entry) => CHAINS[entry.network].vm === "evm")) denied(venue.network, venue.address);
  for (const network of ["base", "arbitrum", "ethereum", "optimism", "polygon", "arc", "arbitrum-sepolia"]) {
    assert.match(denied(network, "0x000000000022D473030F116dDEE9F6B43aC78BA3"), /Permit2/u);
    assert.match(denied(network, "0xcA11bde05977b3631167028862bE2a173976CA11"), /Multicall3/u);
    assert.match(denied(network, "0x0000000000000000000000000000000000000000"), /zero/u);
    assert.match(denied(network, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"), /placeholder/u);
    for (let index = 1; index <= 0x11; index += 1) assert.match(denied(network, `0x${index.toString(16).padStart(40, "0")}`), /precompile/u);
    assert.match(denied(network, `0x${"100".padStart(40, "0")}`), /P-256/u);
    assert.ok(denied(network, `0x${"ffff".padStart(40, "0")}`));
    assert.match(denied(network, "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"), /system/u);
    assert.match(denied(network, "0x0000000071727De22E5E9d8BAf0edAc6f37da032"), /EntryPoint/u);
  }
  for (const network of ["base", "optimism"]) {
    assert.match(denied(network, "0x4200000000000000000000000000000000000016"), /OP-stack/u);
    assert.match(denied(network, "0x42000000000000000000000000000000000000ff"), /OP-stack/u);
  }
  assert.equal(deniedTargetReason("base", "0x4200000000000000000000000000000000000100"), null, "beyond the predeploy range");
  for (const network of ["arbitrum", "arbitrum-sepolia"]) {
    for (const value of [0x64, 0x6b, 0x6f, 0xc8]) assert.match(denied(network, `0x${value.toString(16).padStart(40, "0")}`), /Arbitrum precompile/u);
  }
  assert.match(denied("polygon", "0x0000000000000000000000000000000000001010"), /POL/u);
  // Curated vaults are not denied: registering one as a custom contract is harmless.
  for (const venue of YIELD_VENUES.filter((entry) => entry.kind === "erc4626")) assert.equal(deniedTargetReason(venue.network, venue.target), null, venue.id);
  assert.equal(deniedTargetReason("base", VAULT), null);
  // Configured entries.
  assert.equal(deniedTargetReason("base", VAULT, [`base:${VAULT.toLowerCase()}`]), "on this deployment's deny list");
  assert.equal(deniedTargetReason("arbitrum", VAULT, [`base:${VAULT}`]), null);
  // The validator applies the deny list to the target and to extra addresses.
  expectRefused(validateContractDefinition(evmDefinition({ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })), "CONTRACT_DENIED", "address");
  expectRefused(validateContractDefinition(evmDefinition({ address: "0x000000000022D473030F116dDEE9F6B43aC78BA3" })), "CONTRACT_DENIED", "address");
  expectRefused(validateContractDefinition(evmDefinition({ addresses: [{ label: "router", address: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" }] })), "CONTRACT_DENIED", "addresses[0]");
  expectRefused(validateContractDefinition(evmDefinition(), { denylist: [`base:${VAULT}`] }), "CONTRACT_DENIED", "address");
  assert.equal(validateContractDefinition(evmDefinition({ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })).code, "CONTRACT_DENIED");
  // Solana: built-in, native, venue programs and mints.
  for (const program of Object.keys(SOLANA_ACTION_BUILTIN_PROGRAMS)) {
    assert.ok(isSolanaAddress(program), program);
    assert.match(denied("solana", program), /built-in/u);
  }
  for (const program of ["BPFLoaderUpgradeab1e11111111111111111111111", "Stake11111111111111111111111111111111111111", "Vote111111111111111111111111111111111111111"]) {
    assert.ok(isSolanaAddress(program), program);
    denied("solana", program);
  }
  denied("solana", "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  denied("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(deniedTargetReason("solana", JUPITER), null, "the live dry run allowlists Jupiter v6");
  assert.equal(deniedTargetReason("solana", "constructor"), null, "prototype keys are not programs");
  assert.ok(needsApprovalReset("ethereum", "0xdac17f958d2ee523a2206206994597c13d831ec7"));
  assert.ok(!needsApprovalReset("base", "0xdac17f958d2ee523a2206206994597c13d831ec7"));
});

/* ------------------------------------------------------------------- Solana */

test("the design's Solana Action registration validates", () => {
  const result = validateContractDefinition(svmDefinition());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.value.origin, "https://actions.acme.example");
  assert.deepEqual(result.value.actions[0].params, [{ name: "lockDays", type: "uint", min: "1", max: "365", default: "30" }]);
  assert.equal(contractTarget(result.value), "https://actions.acme.example");
  // The live dry run's Jupiter blink (§10.7) and transfer-sol (§10.8).
  const jupiter = validateContractDefinition({
    vm: "svm",
    network: "solana",
    integrator: { name: "Blink Demo", website: "https://dial.example" },
    origin: "https://jupiter.dial.to",
    programs: [JUPITER, NOOP],
    actions: [{ id: "swap", label: "Swap SOL to USDC", href: "https://jupiter.dial.to/api/v0/swap/SOL-USDC/{amount}", primaryProgram: JUPITER, input: { token: "native" }, output: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, limits: { maxAmount: "1" } }],
  });
  assert.equal(jupiter.ok, true, JSON.stringify(jupiter.issues));
  const transferSol = validateContractDefinition(
    svmDefinition(
      { origin: "https://solana-actions.vercel.app", programs: [NOOP], payees: undefined },
      { href: `https://solana-actions.vercel.app/api/actions/transfer-sol?to=${PAYEE}&amount={amount}`, primaryProgram: NOOP, input: { token: "SOL" }, output: undefined, params: undefined, limits: { maxAmount: "0.01" } },
    ),
  );
  assert.equal(transferSol.ok, true, JSON.stringify(transferSol.issues));
});

test("Solana href placeholders, origin match and URL safety", () => {
  const withHref = (href, action = {}) => validateContractDefinition(svmDefinition({}, { href, ...action }));
  assert.equal(withHref("https://actions.acme.example/api/stake/{amountBaseUnits}/{lockDays}").ok, true);
  expectRefused(withHref("https://actions.acme.example/api/stake?amount={amount}&x={other}"), "ACTION_URL_FORBIDDEN", "href");
  expectRefused(withHref("https://evil.example/api/stake?amount={amount}"), "ACTION_URL_FORBIDDEN", "href");
  expectRefused(withHref("https://actions.acme.example.evil.example/api?amount={amount}"), "ACTION_URL_FORBIDDEN", "href");
  expectRefused(withHref("https://actions.acme.example@evil.example/api?amount={amount}"), "ACTION_URL_FORBIDDEN", "href");
  expectRefused(withHref("https://actions.acme.example/api/stake?amount={amount}#frag"), "ACTION_URL_FORBIDDEN", "href");
  expectRefused(withHref("https://actions.acme.example/api/../admin?amount={amount}"), "ACTION_URL_FORBIDDEN", "href");
  expectRefused(withHref("https://actions.acme.example/api/%2e%2e/admin?amount={amount}"), "ACTION_URL_FORBIDDEN", "href");
  expectRefused(withHref("https://actions.acme.example/api\\stake?amount={amount}"), "ACTION_URL_FORBIDDEN", "href");
  expectRefused(withHref("https://actions.acme.example/api/{amount"), "ACTION_URL_FORBIDDEN", "href");
  expectRefused(withHref("http://actions.acme.example/api?amount={amount}"), "ACTION_URL_FORBIDDEN", "href");
  expectRefused(withHref("https://actions.acme.example/api/stake"), "CONTRACT_DEFINITION_INVALID", "href");
  expectRefused(withHref("https://actions.acme.example/api/claim?amount={amount}", { input: undefined, limits: undefined }), "CONTRACT_DEFINITION_INVALID", "href");
  expectRefused(withHref(`https://actions.acme.example/${"a".repeat(512)}?amount={amount}`), "ACTION_URL_FORBIDDEN", "href");
  // A placeholder can never reach the host part.
  expectRefused(
    validateContractDefinition(svmDefinition({ origin: "https://a0.example" }, { href: "https://a{amount}.example/api" })),
    "ACTION_URL_FORBIDDEN",
    "href",
  );
  // Origins: https, public host, port 443 or 1024+, nothing else.
  for (const origin of ["http://actions.acme.example", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://intranet", "https://actions.acme.example/path", "https://actions.acme.example:80", "https://u:p@actions.acme.example", "https://svc.internal"]) {
    expectRefused(validateContractDefinition(svmDefinition({ origin })), "ACTION_URL_FORBIDDEN", "origin");
  }
  assert.equal(validateContractDefinition(svmDefinition({ origin: "https://actions.acme.example:8443" }, { href: "https://actions.acme.example:8443/api?amount={amount}&lock={lockDays}" })).ok, true);
});

test("Solana programs, primary program, payees, input and output", () => {
  expectRefused(validateContractDefinition(svmDefinition({ programs: [] })), "PROGRAM_NOT_ALLOWED", "programs");
  expectRefused(validateContractDefinition(svmDefinition({ programs: [JUPITER, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] })), "PROGRAM_NOT_ALLOWED", "programs[1]");
  expectRefused(validateContractDefinition(svmDefinition({ programs: [JUPITER, "11111111111111111111111111111111"] })), "PROGRAM_NOT_ALLOWED", "programs[1]");
  expectRefused(validateContractDefinition(svmDefinition({ programs: [JUPITER, "Stake11111111111111111111111111111111111111"] })), "PROGRAM_NOT_ALLOWED", "programs[1]");
  expectRefused(validateContractDefinition(svmDefinition({ programs: [JUPITER, JUPITER] })), "PROGRAM_NOT_ALLOWED", "programs[1]");
  expectRefused(validateContractDefinition(svmDefinition({ programs: [JUPITER, "not-a-key"] })), "PROGRAM_NOT_ALLOWED", "programs[1]");
  const seven = Array.from({ length: 7 }, (_, index) => `${String.fromCharCode(65 + index)}${"1".repeat(43)}`);
  expectRefused(validateContractDefinition(svmDefinition({ programs: seven })), "PROGRAM_NOT_ALLOWED", "programs");
  expectRefused(validateContractDefinition(svmDefinition({}, { primaryProgram: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD" })), "PROGRAM_NOT_ALLOWED", "primaryProgram");
  expectRefused(validateContractDefinition(svmDefinition({ programs: [JUPITER, NOOP] }, {}), { denylist: [`solana:${NOOP}`] }), "PROGRAM_NOT_ALLOWED", "programs[1]");
  expectRefused(validateContractDefinition(svmDefinition({ payees: [{ label: "fee", address: JUPITER, maxLamports: "1" }] })), "CONTRACT_DEFINITION_INVALID", "payees[0].address");
  expectRefused(validateContractDefinition(svmDefinition({ payees: [{ label: "fee", address: PAYEE, maxLamports: "0" }] })), "CONTRACT_DEFINITION_INVALID", "maxLamports");
  expectRefused(validateContractDefinition(svmDefinition({ payees: [1, 2, 3].map(() => ({ label: "fee", address: PAYEE, maxLamports: "1" })) })), "CONTRACT_DEFINITION_INVALID", "payees");
  expectRefused(validateContractDefinition(svmDefinition({}, { input: { token: "WETH" } })), "CONTRACT_DEFINITION_INVALID", "input.token");
  expectRefused(validateContractDefinition(svmDefinition({}, { output: { mint: "0xabc" } })), "CONTRACT_DEFINITION_INVALID", "output.mint");
  expectRefused(validateContractDefinition(svmDefinition({}, { output: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } })), "CONTRACT_DEFINITION_INVALID", "output.mint");
  expectRefused(validateContractDefinition(svmDefinition({ network: "base" })), "CONTRACT_DEFINITION_INVALID", "network");
  expectRefused(validateContractDefinition(svmDefinition({}, { limits: undefined })), "CONTRACT_DEFINITION_INVALID", "maxAmount");
  assert.equal(validateContractDefinition(svmDefinition({ network: "solana-devnet", integrator: { name: "Acme Stake" } }, { input: { token: "SOL" }, limits: undefined })).ok, true);
  assert.equal(validateContractDefinition(svmDefinition({}, { phrases: { verbs: ["stake"], aliases: ["solana stake"] } })).ok, false);
});

/* ------------------------------------------------------------------ helpers */

test("web origins, domain files and binding review sources", () => {
  assert.equal(normalizeWebOrigin("https://Acme.Example/"), "https://acme.example");
  assert.equal(normalizeWebOrigin("https://acme.example:443"), "https://acme.example");
  assert.equal(normalizeWebOrigin("https://acme.example:8443"), null);
  assert.equal(normalizeWebOrigin("https://acme.example:8443", { allowPort: true }), "https://acme.example:8443");
  assert.equal(normalizeWebOrigin("http://localhost:5173"), null);
  assert.equal(normalizeWebOrigin("http://localhost:5173", { allowLocalhost: true }), "http://localhost:5173");
  assert.equal(normalizeWebOrigin("https://acme.example?x=1"), null);
  assert.equal(normalizeWebOrigin(42), null);
  assert.ok(domainFileListsContract({ contracts: ["ct_5f1c2a9b7e3d4c6a8b0e1f23"] }, "ct_5f1c2a9b7e3d4c6a8b0e1f23"));
  assert.ok(!domainFileListsContract({ contracts: "ct_5f1c2a9b7e3d4c6a8b0e1f23" }, "ct_5f1c2a9b7e3d4c6a8b0e1f23"));
  assert.ok(!domainFileListsContract(null, "ct_5f1c2a9b7e3d4c6a8b0e1f23"));
  assert.equal(bindingReviewSource("$amount"), "amount");
  assert.equal(bindingReviewSource("$previous.output.asset"), "previousOutput");
  assert.equal(bindingReviewSource("$param.lockDays"), "param");
  assert.equal(bindingReviewSource({ literal: "1" }), "literal");
});

/* ---------------------------------------------------------- core integration */

test("protocols: custom-call executes call on EVM networks, solana-actions executes action on Solana", () => {
  const call = getProtocol("custom-call");
  const action = getProtocol("solana-actions");
  assert.equal(call.category, "custom");
  assert.equal(action.category, "custom");
  assert.ok(protocolExecutesKind("custom-call", "call"));
  assert.ok(protocolExecutesKind("solana-actions", "action"));
  assert.ok(!protocolExecutesKind("custom-call", "action"));
  assert.ok(call.networks.every((network) => CHAINS[network].vm === "evm"));
  assert.ok(action.networks.every((network) => CHAINS[network].vm === "svm"));
  assert.deepEqual(new Set(call.networks), new Set(Object.keys(CHAINS).filter((network) => CHAINS[network].vm === "evm")));
});

test("intent requests: call and action steps need contract and entry; others refuse them", () => {
  const accounts = ["eip155:8453:0x000000000000000000000000000000000000dEaD"];
  const call = { kind: "call", network: "base", contract: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entry: "deposit", amount: "100" };
  assert.equal(validateIntentRequest({ actions: [call], accounts }).ok, true);
  assert.equal(validateIntentRequest({ actions: [{ ...call, contract: "Acme Vault" }], accounts }).ok, true, "aliases are accepted");
  assert.equal(validateIntentRequest({ actions: [{ ...call, kind: "action", network: "solana" }], accounts }).ok, true);
  assert.equal(validateIntentRequest({ actions: [{ ...call, amount: undefined }], accounts }).ok, true, "non-spending entries need no amount");
  const missing = validateIntentRequest({ actions: [{ kind: "call", network: "base" }], accounts });
  assert.deepEqual(missing.issues.map((issue) => issue.path), ["actions[0].contract", "actions[0].entry"]);
  for (const contract of ["", "x".repeat(65), "<script>", 42]) {
    assert.equal(validateIntentRequest({ actions: [{ ...call, contract }], accounts }).issues?.[0].path, "actions[0].contract", String(contract));
  }
  assert.equal(validateIntentRequest({ actions: [{ ...call, entry: "Deposit" }], accounts }).issues?.[0].path, "actions[0].entry");
  const swap = validateIntentRequest({ actions: [{ kind: "swap", network: "base", from: "ETH", to: "USDC", amount: "1", contract: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entry: "x" }], accounts });
  assert.deepEqual(swap.issues.map((issue) => issue.path), ["actions[0].contract", "actions[0].entry"]);
});

test("session requests: structured template, origins, bounds, TTL and uses", () => {
  const actions = [
    { kind: "bridge", network: "base", from: "USDC", toNetwork: "arbitrum", amount: "100" },
    { kind: "call", network: "arbitrum", contract: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entry: "deposit", amount: "max" },
  ];
  const body = { actions, amount: { action: 0, min: "10", max: "1000" }, allowedOrigins: ["https://Acme.example/"], expiresInSeconds: 900, maxIntents: 1, metadata: { orderId: "A-1029" }, clientReference: "order-A-1029" };
  const ok = validateSessionCreateRequest(body);
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  assert.deepEqual(ok.value.allowedOrigins, ["https://acme.example"]);
  const defaults = validateSessionCreateRequest({ actions, allowedOrigins: ["http://localhost:5173"] });
  assert.equal(defaults.value.expiresInSeconds, 900);
  assert.equal(defaults.value.maxIntents, 1);
  const refused = (patch, path) => {
    const result = validateSessionCreateRequest({ ...body, ...patch });
    assert.equal(result.ok, false, path);
    assert.ok(result.issues.some((issue) => issue.path.startsWith(path)), `${path}: ${JSON.stringify(result.issues)}`);
  };
  refused({ text: "bridge 100 USDC" }, "text");
  refused({ actions: [] }, "actions");
  refused({ allowedOrigins: [] }, "allowedOrigins");
  refused({ allowedOrigins: ["http://acme.example"] }, "allowedOrigins[0]");
  refused({ allowedOrigins: ["https://acme.example/checkout"] }, "allowedOrigins[0]");
  refused({ allowedOrigins: Array.from({ length: 11 }, (_, index) => `https://a${index}.example`) }, "allowedOrigins");
  refused({ expiresInSeconds: 59 }, "expiresInSeconds");
  refused({ expiresInSeconds: 3601 }, "expiresInSeconds");
  refused({ maxIntents: 0 }, "maxIntents");
  refused({ maxIntents: 101 }, "maxIntents");
  refused({ amount: { action: 1, min: "10", max: "1000" } }, "actions[1].amount");
  refused({ amount: { action: 5, min: "10", max: "1000" } }, "amount.action");
  refused({ amount: { action: 0, min: "1000", max: "10" } }, "amount.min");
  refused({ amount: { action: 0, min: "200", max: "1000" } }, "actions[0].amount");
  refused({ amount: { action: 0, min: "10" } }, "amount.max");
  refused({ accounts: ["eip155:8453:0x000000000000000000000000000000000000dEaD"] }, "accounts");

  const accounts = ["eip155:42161:0x000000000000000000000000000000000000dEaD"];
  const intent = validateSessionIntentRequest({ accounts, amount: "50", hostOrigin: "https://acme.example" });
  assert.equal(intent.ok, true, JSON.stringify(intent.issues));
  assert.equal(validateSessionIntentRequest({ accounts, hostOrigin: "https://acme.example/page" }).ok, false);
  assert.equal(validateSessionIntentRequest({ accounts }).ok, false);
  assert.equal(validateSessionIntentRequest({ accounts: [], hostOrigin: "https://acme.example" }).ok, false);
  assert.equal(validateSessionIntentRequest({ accounts, amount: "0", hostOrigin: "https://acme.example" }).ok, false);
});

test("contract test requests", () => {
  const ok = validateContractTestRequest({ entry: "deposit", account: "eip155:8453:0x000000000000000000000000000000000000dEaD", amount: "100", params: { lockDays: 30 } });
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  assert.equal(validateContractTestRequest({ entry: "deposit", account: "0x000000000000000000000000000000000000dEaD" }).ok, false, "CAIP-10 only");
  assert.equal(validateContractTestRequest({ entry: "Deposit", account: "eip155:8453:0x000000000000000000000000000000000000dEaD" }).ok, false);
  assert.equal(validateContractTestRequest({ entry: "deposit", account: "eip155:8453:0x000000000000000000000000000000000000dEaD", amount: "-1" }).ok, false);
  assert.equal(validateContractTestRequest({ entry: "deposit", account: "eip155:8453:0x000000000000000000000000000000000000dEaD", calldata: "0x" }).ok, false, "no calldata field exists");
});
