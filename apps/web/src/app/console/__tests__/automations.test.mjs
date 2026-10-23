// The desk's Automations view model: templates become the same drafts the
// API validates (UTC start from the local time, the wallet's own account),
// list rows (next and last run, signature or native execution), the inbox
// diff behind browser notifications, inbox runs opening as paused desk tasks
// that resume through the normal sign flow, and the /app/automations path.
import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATION_TEMPLATES,
  automationRow,
  draftFromTemplate,
  inboxTaskTitle,
  newInboxRuns,
  relativeTime,
  triggerSummary,
  walletAccountOn,
} from "../automations/automationModel.ts";
import { deskLocationOf, deskPathOf } from "../hooks/deskUrl.ts";
import { composerVerdict } from "../state/deskModel.ts";
import { deskIntentSessionKey, readTaskIndex } from "../state/deskSession.ts";
import { createDeskStore } from "../state/deskStore.ts";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const EVM = { walletKind: "evm", address: "0x4f183e308f24c81c05303821AD025812fBFd807D" };
const SOL = { walletKind: "solana", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" };
const context = { now: NOW, wallet: EVM, timezone: "Europe/Istanbul" };

function memoryStorage() {
  const items = new Map();
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, String(value)), removeItem: (key) => void items.delete(key) };
}

test("every template with its defaults is a valid draft (pay monthly needs a recipient)", () => {
  for (const template of AUTOMATION_TEMPLATES) {
    const values = template.id === "pay-monthly" ? { ...template.defaults, recipient: "vitalik.eth" } : template.defaults;
    const wallet = template.defaults.network === "solana" ? SOL : EVM;
    const draft = draftFromTemplate(template.id, values, { ...context, wallet });
    assert.equal(draft.ok, true, `${template.id}: ${JSON.stringify(draft.issues)}`);
  }
  const missing = draftFromTemplate("pay-monthly", AUTOMATION_TEMPLATES.find((entry) => entry.id === "pay-monthly").defaults, context);
  assert.deepEqual(missing.issues.map((issue) => issue.path), ["recipient"]);
});

test("the weekly buy starts at the local time once, in UTC, capped at its amount, from the wallet's own account", () => {
  const draft = draftFromTemplate("dca", { asset: "ETH", amountUsd: "50", network: "base", weekday: "mon", at: "09:00" }, context);
  assert.equal(draft.draft.trigger.startAt, "2026-10-26T06:00:00.000Z");
  assert.equal(draft.draft.trigger.timezone, "Europe/Istanbul");
  assert.deepEqual(draft.draft.action.accounts, ["eip155:8453:0x4f183e308f24c81c05303821AD025812fBFd807D"]);
  assert.equal(draft.draft.action.text, "buy $50 of ETH on base");
  assert.equal(draft.draft.limits.maxUsdPerRun, "50");
});

test("a wallet cannot automate a network of the other VM", () => {
  assert.equal(walletAccountOn(EVM, "solana"), null);
  assert.equal(walletAccountOn(SOL, "solana")?.startsWith("solana:"), true);
  const draft = draftFromTemplate("price-exit", AUTOMATION_TEMPLATES[1].defaults, context);
  assert.deepEqual(draft.issues.map((issue) => issue.path), ["network"]);
});

test("rows say when it runs next, when it ran, and who executes it", () => {
  const view = {
    id: "au_000000000000000000000001",
    label: null,
    trigger: { kind: "price", asset: "SOL", network: "solana", direction: "below", priceUsd: "120" },
    action: { kind: "intent", text: "sell half of my SOL for USDC", accounts: [] },
    status: "active",
    execution: { mode: "signature" },
    nextRunAt: null,
    lastRunAt: new Date(NOW - 3 * 3_600_000).toISOString(),
  };
  const row = automationRow(view, NOW);
  assert.deepEqual([row.title, row.trigger, row.next, row.last, row.execution, row.canPause, row.canResume], [
    "sell half of my SOL for USDC", "When SOL goes below $120", null, "Last run 3 h ago", "Each run needs your signature", true, false,
  ]);
  const native = automationRow({ ...view, status: "paused", execution: { mode: "native", provider: "jupiter-trigger" }, nextRunAt: new Date(NOW + 2 * 86_400_000).toISOString() }, NOW);
  assert.deepEqual([native.next, native.execution, native.canResume], ["Next run in 2 days", "Runs through jupiter-trigger without you online", true]);
  assert.equal(triggerSummary({ kind: "schedule", every: { unit: "week", count: 2 }, startAt: "x", maxRuns: 4 }), "Every 2 weeks, 4 times");
  assert.equal(relativeTime(new Date(NOW + 5 * 86_400_000).toISOString(), NOW), "in 5 days");
});

test("only runs not seen before notify, and never on the first load", () => {
  const run = (id) => ({ id, title: null, automationLabel: "Weekly ETH" });
  assert.deepEqual(newInboxRuns(null, [run("a")]), []);
  assert.deepEqual(newInboxRuns(new Set(["a"]), [run("a"), run("b")]).map((entry) => entry.id), ["b"]);
  assert.equal(inboxTaskTitle(run("a")), "Weekly ETH");
});

test("an inbox run opens as a paused desk task that resumes its intent, once", () => {
  const storage = memoryStorage();
  const store = createDeskStore({ storage, departureStorage: { read: () => null, write: () => undefined }, now: () => NOW });
  const task = store.getState().adoptIntent({ intentId: "int_abc", title: "Buy $50 of ETH" });
  assert.deepEqual([task.status, task.origin, task.restored, task.intentId], ["paused", "automation", true, "int_abc"]);
  assert.equal(JSON.parse(storage.getItem(deskIntentSessionKey(task.id))).intentId, "int_abc");
  assert.equal(store.getState().adoptIntent({ intentId: "int_abc", title: "again" }).id, task.id, "the same intent is focused, not added twice");
  assert.equal(store.getState().tasks.length, 1);
  assert.equal(readTaskIndex(storage)[0]?.origin, "automation", "the origin survives a reload");
});

test("/app/automations is a desk view, and a command opens it", () => {
  assert.deepEqual(deskLocationOf("/app/automations"), { view: "automations", toolId: null });
  assert.equal(deskPathOf({ view: "automations", toolId: null }), "/app/automations");
  assert.deepEqual(composerVerdict("show my automations"), { kind: "command", view: "automations" });
});
