import assert from "node:assert/strict";
import test from "node:test";
import {
  AMBIGUOUS_VENUE_WORDS,
  CLARIFY_LIMITS,
  CLARIFY_POLICY_VERSION,
  CLARIFY_REASONS,
  NATIVE_FEE_RESERVE,
  NETWORK_KEYS,
  PREVIEW_ACCOUNT_IDS,
  PURPOSE_REASONS,
  THREAD_LIMITS,
  THREAD_SPEC,
  UNSUGGESTED_REASONS,
  classifyMessage,
  evmChecksumState,
  isPreviewAccount,
  isSolanaAddress,
  normalizeMessage,
  parseAccountId,
  parseFollowUp,
  validateIntentTurnRequest,
  validateThread,
} from "../dist/index.js";

const EVM = "eip155:8453:0x52908400098527886E0F7030069857D2E4169EE7";

function thread(overrides = {}) {
  return {
    spec: THREAD_SPEC,
    id: "th_abcdefghijklmnopqrstuvwx",
    rev: 1,
    status: "needs_input",
    policy: CLARIFY_POLICY_VERSION,
    steps: [{ kind: { v: "swap", by: "user" }, from: { v: "SOL", by: "user" }, to: { v: "USDC", by: "user" } }],
    open: ["actions[0].amount"],
    corrections: [],
    turns: [
      { role: "user", kind: "message", label: "Started the task" },
      { role: "kletia", kind: "question", label: "How much SOL?" },
    ],
    undo: [],
    ...overrides,
  };
}

const paths = (result) => (result.ok ? [] : result.issues.map((issue) => issue.path));

test("reasons: VENUE_AMBIGUOUS exists; purpose and suggestion sets follow the design", () => {
  assert.ok(CLARIFY_REASONS.includes("VENUE_AMBIGUOUS"));
  assert.equal(new Set(CLARIFY_REASONS).size, CLARIFY_REASONS.length);
  for (const means of ["VENUE_MISSING", "NETWORK_AMBIGUOUS", "VENUE_AMBIGUOUS"]) assert.ok(!PURPOSE_REASONS.has(means), means);
  assert.equal(PURPOSE_REASONS.size, CLARIFY_REASONS.length - 3);
  for (const purpose of ["RECIPIENT_MISSING", "AMOUNT_MISSING", "DESTINATION_MISSING", "NETWORK_HANDOFF", "RECIPIENT_CHECKSUM"]) {
    assert.ok(PURPOSE_REASONS.has(purpose), purpose);
    assert.ok(UNSUGGESTED_REASONS.has(purpose), purpose);
  }
  for (const suggesting of ["VENUE_MISSING", "VENUE_AMBIGUOUS", "FUNDS_ELSEWHERE", "ASSET_AMBIGUOUS", "ASSET_LOOKALIKE", "AMOUNT_FORMAT_AMBIGUOUS"]) {
    assert.ok(!UNSUGGESTED_REASONS.has(suggesting), suggesting);
  }
  assert.deepEqual(AMBIGUOUS_VENUE_WORDS.spark, ["spark-savings", "sparklend"], "bare spark: Spark Savings first");
});

test("fee reserves cover every network; preview accounts are never example recipients", () => {
  assert.deepEqual(Object.keys(NATIVE_FEE_RESERVE).sort(), [...NETWORK_KEYS].sort());
  assert.equal(NATIVE_FEE_RESERVE.solana, "0.01");
  assert.equal(NATIVE_FEE_RESERVE.ethereum, "0.003");
  assert.equal(NATIVE_FEE_RESERVE.polygon, "0.5");
  assert.equal(NATIVE_FEE_RESERVE.arc, "0.05");
  assert.equal(NATIVE_FEE_RESERVE.base, "0.0005");

  assert.equal(PREVIEW_ACCOUNT_IDS.length, 2);
  for (const id of PREVIEW_ACCOUNT_IDS) {
    const parsed = parseAccountId(id);
    assert.ok(parsed, id);
    if (parsed.chain.namespace === "eip155") assert.equal(evmChecksumState(parsed.address), "valid");
    else assert.ok(isSolanaAddress(parsed.address));
    assert.ok(isPreviewAccount(id));
  }
  // The old demo accounts are the recipients of grammar examples (SELF_TRANSFER, D-4).
  for (const example of [
    "eip155:8453:0x000000000000000000000000000000000000dEaD",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  ]) {
    assert.ok(!PREVIEW_ACCOUNT_IDS.includes(example), example);
    assert.ok(!isPreviewAccount(example), example);
  }
  // Same address on another network of its VM is still the preview account; junk is not.
  const evmPreview = parseAccountId(PREVIEW_ACCOUNT_IDS.find((id) => id.startsWith("eip155:")));
  assert.ok(isPreviewAccount(`eip155:42161:${evmPreview.address.toLowerCase()}`));
  assert.ok(!isPreviewAccount(EVM));
  assert.ok(!isPreviewAccount("not an account"));
  assert.ok(!isPreviewAccount(undefined));
});

test("turn requests: one input, one memory, remember on first turns, expectedRev with threadId", () => {
  const first = validateIntentTurnRequest({ text: "  swap SOL to USDC ", accounts: [EVM], sourceNetwork: "auto", remember: true });
  assert.equal(first.ok, true);
  assert.equal(first.value.text, "swap SOL to USDC");
  assert.equal(first.value.sourceNetwork, "auto");
  assert.equal(first.value.remember, true);

  assert.deepEqual(paths(validateIntentTurnRequest({ accounts: [EVM] })), ["text"], "a first turn needs text");
  assert.ok(paths(validateIntentTurnRequest({ text: "x" })).includes("accounts"), "accounts on a first turn");
  assert.ok(paths(validateIntentTurnRequest({ text: "x", accounts: [EVM], answer: { question: "q.actions.0.amount", option: "all" }, thread: thread() })).includes("answer"));
  assert.ok(paths(validateIntentTurnRequest({ text: "x", accounts: [EVM], thread: thread(), threadId: "th_abcdefghijklmnopqrstuvwx" })).includes("threadId"));
  assert.ok(paths(validateIntentTurnRequest({ text: "x", accounts: [EVM], thread: thread(), remember: true })).includes("remember"));
  assert.ok(paths(validateIntentTurnRequest({ text: "x", accounts: [EVM], expectedRev: 2 })).includes("expectedRev"));
  assert.ok(paths(validateIntentTurnRequest({ text: "x", accounts: [EVM], actions: [{ kind: "swap" }] })).includes("actions"), "no structured actions");
  assert.ok(paths(validateIntentTurnRequest({ text: "x", accounts: [EVM], bogus: 1 })).includes("bogus"));
  assert.ok(paths(validateIntentTurnRequest({ text: "x".repeat(1_001), accounts: [EVM] })).includes("text"));
  assert.ok(paths(validateIntentTurnRequest({ answer: { question: "q.actions.0.amount", option: "all" }, accounts: [EVM] })).includes("answer"), "answers need a thread");

  // A Kletia-held thread keeps the context: no accounts needed; expectedRev applies.
  const held = validateIntentTurnRequest({ threadId: "th_abcdefghijklmnopqrstuvwx", expectedRev: 3, answer: { question: "q.actions.0.amount", text: " 2 " } });
  assert.equal(held.ok, true);
  assert.deepEqual(held.value.answer, { question: "q.actions.0.amount", text: "2" });
  assert.ok(paths(validateIntentTurnRequest({ threadId: "th_ABC" })).includes("threadId"));

  // The commit turn: a client-held thread and no input.
  assert.equal(validateIntentTurnRequest({ thread: thread({ status: "ready", open: [] }), accounts: [EVM] }).ok, true);

  // Answer shapes.
  assert.ok(paths(validateIntentTurnRequest({ thread: thread(), accounts: [EVM], answer: { question: "q.actions.0.amount" } })).includes("answer"));
  assert.ok(paths(validateIntentTurnRequest({ thread: thread(), accounts: [EVM], answer: { question: "q.x", option: "a", text: "b" } })).includes("answer"));
  assert.ok(paths(validateIntentTurnRequest({ thread: thread(), accounts: [EVM], answer: { question: "actions.0", option: "all" } })).includes("answer.question"));
  assert.equal(validateIntentTurnRequest({ thread: thread(), accounts: [EVM], assumption: { id: "a.actions.0.network", option: "optimism" } }).ok, true);
  assert.ok(paths(validateIntentTurnRequest({ thread: thread(), accounts: [EVM], assumption: { id: "x", option: "optimism" } })).includes("assumption.id"));
});

test("turn requests: clientReference at most 72; context checks are the intent request's", () => {
  assert.equal(validateIntentTurnRequest({ text: "x", accounts: [EVM], clientReference: "a".repeat(CLARIFY_LIMITS.clientReference) }).ok, true);
  const long = validateIntentTurnRequest({ text: "x", accounts: [EVM], clientReference: "a".repeat(73) });
  assert.deepEqual(paths(long), ["clientReference"]);
  assert.match(long.issues[0].message, /\{1,72\}/u);
  assert.deepEqual(paths(validateIntentTurnRequest({ text: "x", accounts: [EVM], sourceNetwork: "mars" })), ["sourceNetwork"]);
  assert.deepEqual(paths(validateIntentTurnRequest({ text: "x", accounts: [EVM], defaultNetwork: "mars" })), ["defaultNetwork"]);
  // A broken mixed-case checksum is refused on accounts.
  assert.deepEqual(paths(validateIntentTurnRequest({ text: "x", accounts: ["eip155:8453:0x52908400098527886E0F7030069857D2E4169Ee7"] })), ["accounts[0]"]);
});

test("threads: spec, id, sizes, turns, undo and slot syntax", () => {
  assert.equal(validateThread(thread()).ok, true);
  const ready = thread({
    status: "ready",
    open: [],
    steps: [{
      kind: { v: "swap", by: "user" },
      amount: { v: { t: "balance", bps: 10_000 }, by: "user" },
      from: { v: "SOL", by: "user" },
      to: { v: "USDC", by: "user" },
      network: { v: "solana", by: "assumed", why: { source: "balance", code: "largest-balance" } },
    }],
    corrections: [{ field: "actions[0].kind", from: "swpa", to: "swap", material: true }],
    undo: [[{ kind: { v: "swap", by: "user" } }]],
  });
  assert.equal(validateThread(ready).ok, true);

  const cases = [
    [{ spec: "kletia.thread/v2" }, "spec"],
    [{ id: "th_short" }, "id"],
    [{ rev: -1 }, "rev"],
    [{ status: "planned" }, "status"],
    [{ policy: "latest" }, "policy"],
    [{ open: ["amount"] }, "open"],
    [{ status: "ready" }, "open"],
    [{ turns: Array.from({ length: THREAD_LIMITS.storedTurns + 1 }, () => ({ role: "user", kind: "message", label: "x" })) }, "turns"],
    [{ turns: [{ role: "system", kind: "message", label: "x" }] }, "turns"],
    [{ undo: [[], [], [], []] }, "undo"],
    [{ corrections: [{ field: "actions[0].kind", from: "x".repeat(17), to: "swap", material: true }] }, "corrections"],
    [{ steps: Array.from({ length: THREAD_LIMITS.maxSteps + 1 }, () => ({})) }, "steps"],
    [{ steps: [{ kind: { v: "borrow", by: "user" } }] }, "steps[0].kind.v"],
    [{ steps: [{ kind: { v: "swap", by: "kletia" } }] }, "steps[0].kind.by"],
    [{ steps: [{ network: { v: "solana", by: "user", why: { source: "balance", code: "x" } } }] }, "steps[0].network.why"],
    [{ steps: [{ network: { v: "solana", by: "assumed", why: { source: "guess", code: "x" } } }] }, "steps[0].network.why"],
    [{ steps: [{ network: { v: "mars", by: "user" } }] }, "steps[0].network.v"],
    [{ steps: [{ amount: { v: { t: "exact", value: "0" }, by: "user" } }] }, "steps[0].amount.v"],
    [{ steps: [{ amount: { v: { t: "previous", bps: 10_001 }, by: "user" } }] }, "steps[0].amount.v"],
    [{ steps: [{ amount: { v: { t: "exact", value: "1e3" }, by: "user" } }] }, "steps[0].amount.v"],
    [{ steps: [{ recipient: { v: "two words", by: "user" } }] }, "steps[0].recipient.v"],
    [{ steps: [{ contract: { v: "ct_0123456789abcdef01234567", by: "user" } }] }, "steps[0].contract.v"],
    [{ steps: [{ kindCandidates: ["send", "lend"] }] }, "steps[0].kindCandidates"],
    [{ steps: [{ secret: true }] }, "steps[0].secret"],
    [{ extra: 1 }, "extra"],
  ];
  for (const [overrides, path] of cases) {
    const result = validateThread(thread(overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides).slice(0, 80));
    assert.ok(paths(result).includes(path), `${path} in ${paths(result).join(", ")}`);
  }
  assert.equal(validateThread(thread({ steps: [{ contract: { v: "ct_0123456789abcdef01234567#deposit", by: "user" } }] })).ok, true);

  // Size: the serialised thread is at most 16 KB (UTF-8 bytes).
  const big = thread({ pendingEdit: { note: "é".repeat(8_200) } });
  assert.ok(JSON.stringify(big).length < THREAD_LIMITS.maxBytes);
  assert.deepEqual(paths(validateThread(big)), [""]);
  assert.equal(validateThread(null).ok, false);

  // Turn requests validate a client-held thread under `thread.`.
  assert.ok(paths(validateIntentTurnRequest({ thread: thread({ rev: "1" }), accounts: [EVM], text: "make it 2" })).includes("thread.rev"));
});

test("follow-up grammar reads the corpus follow-ups", () => {
  const cases = [
    ["make it 2", { op: "amount", amount: { t: "exact", value: "2", raw: "2" } }],
    ["actually make it 50 USDC", { op: "amount", amount: { t: "exact", value: "50", raw: "50" }, unit: "USDC" }],
    ["50%", { op: "amount", amount: { t: "balance", bps: 5_000 } }],
    ["change the amount to $20", { op: "amount", amount: { t: "usd", value: "20" } }],
    ["from arbitrum instead", { op: "network", dir: "from", network: "arbitrum" }],
    ["to base instead", { op: "network", dir: "to", network: "base" }],
    ["on arbitrum instead", { op: "network", dir: "on", network: "arbitrum" }],
    ["use arbitrum", { op: "network", dir: "use", network: "arbitrum" }],
    ["in op mainnet", { op: "network", dir: "on", network: "optimism" }],
    ["polygon", { op: "network", dir: "use", network: "polygon" }],
    ["send it to vitalik.eth instead", { op: "recipient", recipient: "vitalik.eth" }],
    ["to 0x1111111111111111111111111111111111111111 instead", { op: "recipient", recipient: "0x1111111111111111111111111111111111111111" }],
    ["actually make it USDT", { op: "asset", symbol: "USDT" }],
    ["with marinade", { op: "provider", provider: "marinade", symbol: "mSOL" }],
    ["with lido", { op: "provider", provider: "lido", symbol: "wstETH" }],
    ["via lifi", { op: "venue", protocol: "lifi", role: "bridge", word: "lifi" }],
    ["via across", { op: "venue", protocol: "across", role: "bridge", word: "across" }],
    ["into kamino", { op: "venue", protocol: "kamino", role: "lending", word: "kamino" }],
    ["into spark", { op: "venue", protocol: "spark-savings", role: "lending", word: "spark" }],
    ["into spark lend", { op: "venue", protocol: "sparklend", role: "lending", word: "spark lend" }],
    ["via orca", { op: "venue", protocol: "orca", role: "dex", word: "orca" }],
    ["and then stake it", { op: "append", text: "stake it" }],
    ["then deposit it into kamino", { op: "append", text: "deposit it into kamino" }],
    ["and swap it to USDT", { op: "append", text: "swap it to USDT" }],
  ];
  for (const [message, expected] of cases) assert.deepEqual(parseFollowUp(message), expected, message);
  assert.equal(parseFollowUp("double it"), "unsupported");
  assert.equal(parseFollowUp("make it 0"), "unsupported");
  assert.equal(parseFollowUp("bridge 25 USDC from base to solana"), null, "a complete sentence replaces the task");
  assert.equal(parseFollowUp("make it 5 bananas"), null);
  assert.equal(parseFollowUp("what is the weather"), null);
  assert.equal(normalizeMessage("Please swap one SOL -> USDC, thanks!"), "swap 1 SOL to USDC");
});

test("classifyMessage labels a message the way a turn reads it", () => {
  const open = { hasOpenQuestion: true, hasTask: true };
  const task = { hasOpenQuestion: false, hasTask: true };
  const none = { hasOpenQuestion: false, hasTask: false };
  const cases = [
    ["swap SOL to USDC", none, "sentence"],
    ["what can you do", none, "sentence"],
    ["50", open, "answer"],
    ["base", open, "answer"],
    ["yes", open, "answer"],
    ["actually 0.5", open, "answer"],
    ["from arbitrum", open, "answer"],
    ["vitalik.eth", open, "answer"],
    ["bridge 25 USDC from base to solana", open, "sentence"],
    ["cancel", open, "control"],
    ["undo", task, "control"],
    ["never mind", task, "control"],
    ["make it 2", task, "edit"],
    ["from arbitrum instead", task, "edit"],
    ["send it to vitalik.eth instead", task, "edit"],
    ["double it", task, "edit"],
    ["via lifi", task, "edit"],
    ["and then stake it", task, "append"],
    ["and then stake it", open, "append"],
    ["bridge 25 USDC from base to solana", task, "sentence"],
    ["yes", task, "unknown"],
    ["hello there", task, "unknown"],
    ["", task, "unknown"],
  ];
  for (const [message, context, expected] of cases) {
    assert.equal(classifyMessage(message, context), expected, `${message} ${JSON.stringify(context)}`);
  }
});
