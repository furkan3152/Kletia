/**
 * `kletia plan` with clarifying questions (clarify design 7.2): it asks in a
 * terminal, exits 6 (EXIT_NEEDS_INPUT) with the needs_input JSON without
 * one or with --json, continues with --thread and --answer, and keeps the
 * strict path with --no-clarify.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { EXIT_NEEDS_INPUT } from "../dist/commands.js";
import { cli, send, stubServer } from "./helpers.mjs";

const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ACCOUNT = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`;
const THREAD_ID = "th_abcdefghijklmnopqrstuvwx";

const thread = (rev, status = "needs_input") => ({
  spec: "kletia.thread/v1",
  id: THREAD_ID,
  rev,
  status,
  policy: "2026-10.1",
  steps: [{ kind: { v: "swap", by: "user" }, from: { v: "SOL", by: "user" }, to: { v: "USDC", by: "user" } }],
  open: status === "needs_input" ? ["actions[0].amount"] : [],
  corrections: [],
  turns: [{ role: "user", kind: "message", label: "Started the task" }],
  undo: [],
});

const question = {
  id: "q.actions.0.amount",
  field: "actions[0].amount",
  kind: "amount",
  reason: "AMOUNT_MISSING",
  purpose: true,
  prompt: "How much SOL?",
  why: "You hold 2.5 SOL on Solana.",
  options: [
    { id: "all", label: "All · 2.49 SOL", detail: "Keeps 0.01 SOL for network fees", sentence: "swap 2.49 SOL to USDC on solana" },
    { id: "half", label: "Half · 1.25 SOL", sentence: "swap 1.25 SOL to USDC on solana" },
  ],
  allowsText: true,
  placeholder: "Amount in SOL",
};

const intent = (amount) => ({
  id: "int_dry",
  status: "planned",
  request: { accounts: [ACCOUNT] },
  summary: { title: `Swap ${amount} SOL to USDC`, signaturesRequired: 1, totalFeesUsd: 0.01, estimatedSeconds: 10 },
  warnings: [],
  steps: [{ id: "s1", status: "ready", network: "solana", protocol: "jupiter", input: { formatted: amount, symbol: "SOL" }, expectedOutput: { formatted: "390.1", symbol: "USDC" } }],
});

let api;

before(async () => {
  api = await stubServer((req, res) => {
    if (req.method !== "POST" || req.path !== "/v1/intents") return false;
    if (req.url.searchParams.get("clarify") !== "true") {
      // Strict path: an incomplete sentence is refused as today.
      return send(res, 422, { error: { code: "AMOUNT_REQUIRED", message: "Say how much." } });
    }
    const body = req.body;
    if (body.text === "cancel") return send(res, 200, { status: "cancelled", turn: "control", thread: thread(2, "cancelled") });
    if (body.text) return send(res, 200, { status: "needs_input", turn: "message", questions: [question], assumptions: [], draft: { summary: "Swap SOL to USDC on Solana", sentence: null, missing: ["actions[0].amount"], steps: [] }, thread: thread(1) });
    if (body.answer?.option === "all" || body.answer?.text === "2.49") {
      return send(res, 200, {
        status: "planned",
        turn: "answer",
        sentence: "swap 2.49 SOL to USDC on solana",
        assumptions: [{ id: "a.actions.0.amount", field: "actions[0].amount", label: "All your SOL: 2.49", reason: "You hold 2.5 SOL on Solana; 0.01 SOL stays for network fees.", source: "balance", material: true, alternatives: [] }],
        intent: intent("2.49"),
        thread: thread(2, "ready"),
      });
    }
    return send(res, 422, { error: { code: "ANSWER_INVALID", message: "Answer does not fit." } });
  });
});

after(() => api.close());

const turns = () => api.requests.filter((request) => request.path === "/v1/intents");

test("in a terminal, plan asks inline, sends the answer with the thread and prints what Kletia assumed", async () => {
  const start = turns().length;
  const result = await cli(["plan", "swap SOL to USDC", "--account", `solana:${SOL}`], { base: api.base, tty: true, answers: ["1"] });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /How much SOL\?  You hold 2\.5 SOL on Solana\./u);
  assert.match(result.stderr, /1\) All · 2\.49 SOL   Keeps 0\.01 SOL for network fees/u);
  assert.match(result.stderr, /2\) Half · 1\.25 SOL/u);
  assert.match(result.stderr, /or type amount in sol/u);
  assert.match(result.stdout, /^Planned: swap 2\.49 SOL to USDC on solana$/mu);
  assert.match(result.stdout, /Kletia assumed: All your SOL: 2\.49 \(You hold 2\.5 SOL on Solana; 0\.01 SOL stays for network fees\.\)/u);
  assert.match(result.stdout, /Swap 2\.49 SOL to USDC/u);
  const sent = turns().slice(start);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url.search, "?clarify=true&dryRun=true");
  assert.deepEqual(sent[0].body, { text: "swap SOL to USDC", accounts: [ACCOUNT] });
  assert.deepEqual(sent[1].body.answer, { question: "q.actions.0.amount", option: "all" });
  assert.equal(sent[1].body.thread.id, THREAD_ID, "the client-held thread goes back as returned");
  assert.deepEqual(sent[1].body.accounts, [ACCOUNT]);
});

test("a typed answer goes as text; an unusable line is asked again", async () => {
  const start = turns().length;
  const result = await cli(["plan", "swap SOL to USDC", "--account", `solana:${SOL}`], { base: api.base, tty: true, answers: ["", "2.49"] });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Pick 1-2 or type an answer\./u);
  assert.deepEqual(turns().slice(start)[1].body.answer, { question: "q.actions.0.amount", text: "2.49" });
});

test("without a terminal, plan prints the needs_input response as JSON and exits 6", async () => {
  assert.equal(EXIT_NEEDS_INPUT, 6);
  const piped = await cli(["plan", "swap SOL to USDC", "--account", `solana:${SOL}`], { base: api.base });
  assert.equal(piped.code, 6);
  const parsed = JSON.parse(piped.stdout);
  assert.equal(parsed.status, "needs_input");
  assert.equal(parsed.questions[0].id, "q.actions.0.amount");
  assert.match(piped.stderr, /kletia plan --thread <file> --answer q\.actions\.0\.amount=all/u);
  // --json never asks, even in a terminal.
  const json = await cli(["plan", "swap SOL to USDC", "--account", `solana:${SOL}`, "--json"], { base: api.base, tty: true, answers: ["1"] });
  assert.equal(json.code, 6);
  assert.equal(JSON.parse(json.stdout).status, "needs_input");
  // End of input at the prompt: the same hand-over.
  const eof = await cli(["plan", "swap SOL to USDC", "--account", `solana:${SOL}`], { base: api.base, tty: true, answers: [] });
  assert.equal(eof.code, 6);
});

test("--thread <file> --answer continues the task without a terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kletia-thread-"));
  const file = join(dir, "thread.json");
  // The whole needs_input response is accepted (its .thread is used).
  await writeFile(file, JSON.stringify({ status: "needs_input", thread: thread(1) }));
  const start = turns().length;
  const result = await cli(["plan", "--thread", file, "--answer", "q.actions.0.amount=all", "--account", `solana:${SOL}`, "--json"], { base: api.base });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "planned");
  const sent = turns().slice(start);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.answer, { question: "q.actions.0.amount", option: "all" });
  assert.equal(sent[0].body.thread.rev, 1);
  const typed = await cli(["plan", "--thread", file, "--answer", "q.actions.0.amount=text:2.49", "--account", `solana:${SOL}`], { base: api.base });
  assert.equal(typed.code, 0, typed.stderr);
  assert.deepEqual(turns().at(-1).body.answer, { question: "q.actions.0.amount", text: "2.49" });

  await writeFile(join(dir, "bad.json"), JSON.stringify({ spec: "nope" }));
  const bad = await cli(["plan", "--thread", join(dir, "bad.json"), "--answer", "q.actions.0.amount=all", "--account", `solana:${SOL}`], { base: api.base });
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /is not a Kletia thread/u);
  const noThread = await cli(["plan", "--answer", "q.actions.0.amount=all", "--account", `solana:${SOL}`], { base: api.base });
  assert.equal(noThread.code, 64);
  const badAnswer = await cli(["plan", "--thread", file, "--answer", "amount", "--account", `solana:${SOL}`], { base: api.base });
  assert.equal(badAnswer.code, 64);
});

test("--no-clarify keeps the strict path: no clarify flag, an incomplete sentence is refused", async () => {
  const start = turns().length;
  const strict = await cli(["plan", "swap SOL to USDC", "--account", `solana:${SOL}`, "--no-clarify"], { base: api.base, tty: true, answers: ["1"] });
  assert.equal(strict.code, 1);
  assert.match(strict.stderr, /AMOUNT_REQUIRED/u);
  const sent = turns().slice(start);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url.searchParams.has("clarify"), false);
  const mixed = await cli(["plan", "--thread", "x.json", "--no-clarify", "--account", `solana:${SOL}`], { base: api.base });
  assert.equal(mixed.code, 64);
});

test("a cancelled task ends without a plan", async () => {
  const result = await cli(["plan", "cancel", "--account", `solana:${SOL}`], { base: api.base });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /Cancelled: nothing was planned\./u);
});
