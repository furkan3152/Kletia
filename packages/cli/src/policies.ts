/**
 * `kletia keys create-agent|tree`, `kletia policy …` and `kletia approvals …`:
 * agent keys, Rule Books (tighten now, loosen later), the simulator, the
 * decision log, spend windows and key approvals. Wallet approvals happen on
 * the approval page. Like every command, none of these prepares, signs or
 * submits a transaction; rule books are validated locally (core) before
 * anything is sent.
 */
import {
  POLICY_TEMPLATES,
  approvalDigest,
  comparePolicies,
  policyFromTemplate,
  policyHash,
  validatePolicy,
  verifyDecisionChain,
  type PolicyDefaults,
  type PolicyDocument,
  type PolicyTemplateFill,
  type PolicyTemplateId,
  type PolicyWarning,
} from "@kletia/core";
import type { ApiKeySummary, PolicyApprovalView, PolicyReadResponse } from "@kletia/sdk";
import { integerOption, listOption, stringOption, UsageError, type OptionSpec } from "./args.js";
import {
  accountId,
  CONFIRM_OPTION,
  durationSeconds,
  EXIT_ERROR,
  EXIT_INVALID,
  EXIT_OK,
  positional,
  signalOption,
  type Command,
  type CommandContext,
} from "./common.js";
import { readJson, refusedLocally } from "./contracts.js";
import { table, when } from "./output.js";
import { abandonSecretSink, deliverSecret, openSecretSink, SECRET_OPTIONS } from "./secrets.js";

const TEMPLATE_IDS = Object.keys(POLICY_TEMPLATES) as PolicyTemplateId[];

function keyIdArgument(context: CommandContext, index = 0): string {
  const id = positional(context, index);
  if (!/^key_[0-9a-f]{24}$/u.test(id)) throw new UsageError(`"${id}" is not a key id (key_ followed by 24 hex characters).`, context.usage);
  return id;
}

function printWarnings(context: CommandContext, warnings: readonly PolicyWarning[]): void {
  for (const warning of warnings) context.print.err(`warning ${warning.code} (${warning.path}): ${warning.message}`);
}

function fillOf(context: CommandContext): PolicyTemplateFill {
  const accounts = listOption(context.values, "account").map((value) => (value.includes("*") ? value : accountId(value, context.usage)));
  const recipients = listOption(context.values, "recipient");
  const approverWallets = listOption(context.values, "approver-wallet");
  const contracts = listOption(context.values, "contract").map((entry) => {
    const [id = "", entries] = entry.split(":", 2);
    return { id, ...(entries ? { entries: entries.split("+").filter(Boolean) } : {}) };
  });
  return {
    ...(accounts.length > 0 ? { accounts } : {}),
    ...(recipients.length > 0 ? { recipients } : {}),
    ...(approverWallets.length > 0 ? { approverWallets } : {}),
    ...(contracts.length > 0 ? { contracts } : {}),
  };
}

const FILL_OPTIONS = {
  account: { type: "string", multiple: true, value: "<pattern>", description: "Template fill accounts.allow (CAIP-10, eip155:*:0x…; repeatable)." },
  recipient: { type: "string", multiple: true, value: "<pattern|name>", description: "Template fill recipients.allow (repeatable)." },
  "approver-wallet": { type: "string", multiple: true, value: "<pattern>", description: "Template fill confirm.approvers.wallets (repeatable)." },
  contract: { type: "string", multiple: true, value: "<ct_…[:entry+entry]>", description: "Template fill contracts.allow (repeatable)." },
} as const satisfies Record<string, OptionSpec>;

/** The local document of --file (validated) or --template (filled, validated). */
async function documentFrom(context: CommandContext, defaults: PolicyDefaults): Promise<{ document: PolicyDocument; warnings: readonly PolicyWarning[]; template?: PolicyTemplateId; fill?: PolicyTemplateFill }> {
  const file = stringOption(context.values, "file") ?? stringOption(context.values, "policy");
  const template = stringOption(context.values, "template");
  if (file && template) throw new UsageError("Pass a rule book file or --template, not both.", context.usage);
  if (template) {
    if (!(TEMPLATE_IDS as string[]).includes(template)) throw new UsageError(`--template must be one of ${TEMPLATE_IDS.join(", ")}.`, context.usage);
    const fill = fillOf(context);
    const result = policyFromTemplate(template as PolicyTemplateId, fill);
    if (!result.ok || !result.value) {
      const needs = POLICY_TEMPLATES[template as PolicyTemplateId].fill;
      throw refusedLocally("POLICY_INVALID", `The ${template} template needs ${needs.join(", ")} (--account, --recipient, --approver-wallet, --contract)`, result.issues);
    }
    return { document: result.value, warnings: result.warnings, template: template as PolicyTemplateId, fill };
  }
  if (!file) throw new UsageError("Pass the rule book as --file <policy.json> (or --template <name>).", context.usage);
  const input = await readJson(context, file);
  const result = validatePolicy(input, { defaults });
  if (!result.ok || !result.value) throw refusedLocally("POLICY_INVALID", "The rule book is invalid", result.issues);
  return { document: result.value, warnings: result.warnings };
}

function changeLines(tightened: readonly string[], loosened: readonly string[]): string[] {
  return [
    `tightens: ${tightened.length > 0 ? tightened.join(", ") : "nothing"}`,
    `loosens: ${loosened.length > 0 ? loosened.join(", ") : "nothing"}`,
  ];
}

/* -------------------------------------------------------------- agent keys */

const keysCreateAgent: Command = {
  name: "keys create-agent",
  summary: "Create an agent key under a key, bound by a rule book (its secret is shown once).",
  args: "--parent <key id> --name <name> (--policy <file> | --template <name>) [--expires 30d]",
  key: true,
  options: {
    parent: { type: "string", value: "<key id>", description: "Parent key (yours, or one of your agent keys)." },
    name: { type: "string", value: "<name>", description: "1-64 printable characters." },
    policy: { type: "string", value: "<file>", description: "The agent's first rule book (JSON; `-` reads stdin)." },
    template: { type: "string", value: "<name>", description: `A template: ${TEMPLATE_IDS.join(", ")}.` },
    expires: { type: "string", value: "<duration>", description: "Lifetime, 1h to 365d (default 30d); never past the parent's expiry." },
    ...FILL_OPTIONS,
    ...SECRET_OPTIONS,
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const parent = stringOption(context.values, "parent");
    const name = stringOption(context.values, "name")?.trim();
    if (!parent || !/^key_[0-9a-f]{24}$/u.test(parent)) throw new UsageError("--parent <key id> is required (key_ followed by 24 hex characters).", context.usage);
    if (!name) throw new UsageError("--name is required.", context.usage);
    const expires = stringOption(context.values, "expires");
    const expiresInSeconds = expires === undefined ? undefined : durationSeconds(expires, "expires", context.usage);
    if (expiresInSeconds !== undefined && (expiresInSeconds < 3_600 || expiresInSeconds > 31_536_000)) throw new UsageError("--expires must be between 1h and 365d.", context.usage);
    const hasRuleBook = stringOption(context.values, "policy") !== undefined || stringOption(context.values, "template") !== undefined;
    const local = hasRuleBook ? await documentFrom(context, "agent") : null;
    if (local) printWarnings(context, local.warnings);
    const sink = await openSecretSink(context);
    let created;
    try {
      created = await context.client().keys.createChild(
        parent,
        {
          name,
          ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
          ...(local?.template ? { template: local.template, fill: local.fill ?? {} } : local ? { policy: local.document } : {}),
        },
        signalOption(context),
      );
    } catch (error) {
      await abandonSecretSink(sink);
      throw error;
    }
    const { key: secret, ...key } = created.key;
    if (!secret) {
      await abandonSecretSink(sink);
      throw new Error("The API did not return the agent key.");
    }
    const policy = created.policy;
    if (local && policy.hash && policy.hash !== policyHash(local.document)) context.print.err(`note: the stored rule book hash ${policy.hash} differs from the local one; read it back with kletia policy get ${key.id}.`);
    const summary = `Created agent key ${key.id} (${key.name}) under ${key.parentId}, depth ${key.depth}, expires ${when(key.expiresAt)}; rule book v${policy.version} ${policy.hash ?? "(observer)"}. Pin that hash in the agent's signer (createPolicyGuard pinnedHash).`;
    await deliverSecret(context, sink, secret, { key, policy }, "key", summary);
    return EXIT_OK;
  },
};

function treeLines(keys: readonly ApiKeySummary[]): string[] {
  const byParent = new Map<string | null, ApiKeySummary[]>();
  for (const key of keys) {
    const parent = key.kind === "agent" && key.parentId && keys.some((candidate) => candidate.id === key.parentId) ? key.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), key]);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, prefix: string) => {
    const children = byParent.get(parent) ?? [];
    children.forEach((key, index) => {
      const lastChild = index === children.length - 1;
      const branch = parent === null ? "" : lastChild ? "└─ " : "├─ ";
      const state = key.revokedAt ? `revoked ${when(key.revokedAt)}` : key.expiresAt ? `expires ${when(key.expiresAt)}` : "no expiry";
      const policy = key.policyVersion === null || key.policyVersion === undefined ? (key.kind === "agent" ? "observer" : "no rule book") : `rule book v${key.policyVersion}`;
      lines.push(`${prefix}${branch}${key.id}${key.current ? " *" : ""}  ${key.name}  ${key.kind ?? "project"}  ${policy}  ${state}`);
      walk(key.id, parent === null ? prefix : `${prefix}${lastChild ? "   " : "│  "}`);
    });
  };
  walk(null, "");
  return lines;
}

const keysTree: Command = {
  name: "keys tree",
  summary: "Project keys and their agent keys, with rule book versions and expiry.",
  key: true,
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const keys = await context.client().keys.list(signalOption(context));
    if (context.json) context.print.json(keys);
    else context.print.out(treeLines(keys).join("\n"));
    return EXIT_OK;
  },
};

/* --------------------------------------------------------------- rule books */

const policyTemplate: Command = {
  name: "policy template",
  summary: "Print a rule book template (or list them).",
  args: "[<name>]",
  positionals: { min: 0, max: 1 },
  run: async (context) => {
    const name = context.positionals[0];
    if (!name) {
      if (context.json) context.print.json(Object.values(POLICY_TEMPLATES));
      else context.print.out(table(Object.values(POLICY_TEMPLATES).map((template) => [template.id, template.fill.join(",") || "-", template.summary]), ["template", "fill", "summary"]));
      return EXIT_OK;
    }
    const template = POLICY_TEMPLATES[name as PolicyTemplateId];
    if (!template) throw new UsageError(`Unknown template "${name}". Templates: ${TEMPLATE_IDS.join(", ")}.`, context.usage);
    if (context.json) context.print.json(template);
    else {
      context.print.out(JSON.stringify(template.document, null, 2));
      if (template.fill.length > 0) context.print.err(`Fill before use: ${template.fill.join(", ")}.`);
    }
    return EXIT_OK;
  },
};

async function keyDefaults(context: CommandContext, keyId: string): Promise<{ read: PolicyReadResponse; defaults: PolicyDefaults }> {
  const read = await context.client().policies.get(keyId, signalOption(context));
  return { read, defaults: read.effective?.defaults ?? "project" };
}

const policyValidate: Command = {
  name: "policy validate",
  summary: "Validate a rule book locally (no request); --against <key id> shows what it tightens and loosens.",
  args: "--file <policy.json> [--against <key id> | --project]",
  options: {
    file: { type: "string", value: "<path>", description: "The rule book (JSON; `-` reads stdin)." },
    against: { type: "string", value: "<key id>", description: "Compare with this key's active rule book (needs KLETIA_API_KEY)." },
    defaults: { type: "string", value: "agent|project", description: "Defaults to validate with (default agent with --against an agent key, else project)." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const file = stringOption(context.values, "file");
    if (!file) throw new UsageError("--file <policy.json> is required.", context.usage);
    const against = stringOption(context.values, "against");
    let defaults: PolicyDefaults = stringOption(context.values, "defaults") === "agent" ? "agent" : "project";
    let active: PolicyDocument | null = null;
    if (against) {
      if (!context.hasApiKey) throw new UsageError("--against needs an API key: set KLETIA_API_KEY.", context.usage);
      const { read, defaults: keyKind } = await keyDefaults(context, against);
      if (stringOption(context.values, "defaults") === undefined) defaults = keyKind;
      active = read.policy?.document ?? null;
    }
    const result = validatePolicy(await readJson(context, file), { defaults });
    const comparison = result.ok && result.value && against ? comparePolicies(active, result.value, { defaults }) : null;
    const hash = result.ok && result.value ? policyHash(result.value) : null;
    if (context.json) context.print.json({ valid: result.ok, issues: result.issues, warnings: result.warnings, hash, ...(comparison ? { comparison } : {}) });
    else {
      context.print.out(result.ok ? `valid  ${hash}` : "INVALID");
      for (const issue of result.issues) context.print.out(`  ${issue.path || "policy"}: ${issue.message}`);
      for (const warning of result.warnings) context.print.out(`  warning ${warning.code} (${warning.path}): ${warning.message}`);
      if (comparison) for (const line of changeLines(comparison.tightened, comparison.loosened)) context.print.out(line);
      if (comparison && comparison.loosened.length > 0 && active?.amendments?.delaySeconds) {
        context.print.out(`Loosening waits ${active.amendments.delaySeconds}s after it is set (the active version's amendment delay).`);
      }
    }
    return result.ok ? EXIT_OK : EXIT_ERROR;
  },
};

function printPolicyRead(context: CommandContext, read: PolicyReadResponse): void {
  const head = read.policy;
  if (!head || head.status === "none") context.print.out("No active rule book.");
  else context.print.out(`v${head.version}  ${head.status}  ${head.hash}${head.document?.label ? `  "${head.document.label}"` : ""}`);
  if (head?.pending) {
    context.print.out(`pending v${head.pending.version}${head.pending.removal ? " (removal)" : ""} until ${when(head.pending.activatesAt)}; loosens ${head.pending.loosened.join(", ") || "nothing"}`);
  }
  if (read.effective) {
    context.print.out(`effective chain (${read.effective.defaults} defaults, key ${read.effective.keyActive ? "active" : "REVOKED OR EXPIRED"}):`);
    context.print.out(table(read.effective.levels.map((level) => [level.scope, level.id, level.version === null ? "-" : `v${level.version}`, level.hash ?? (level.defaults === "agent" ? "observer" : "none")]), ["scope", "id", "version", "hash"]));
  }
  if (head?.document) {
    context.print.out("");
    context.print.out(JSON.stringify(head.document, null, 2));
  }
}

const PROJECT_OPTION = { project: { type: "boolean", description: "The project rule book instead of a key's." } } as const satisfies Record<string, OptionSpec>;

function target(context: CommandContext): { project: true } | { project: false; keyId: string } {
  if (context.values.project === true) {
    if (context.positionals.length > 0) throw new UsageError("Pass a key id or --project, not both.", context.usage);
    return { project: true };
  }
  if (context.positionals.length === 0) throw new UsageError("Pass a key id, or --project.", context.usage);
  return { project: false, keyId: keyIdArgument(context) };
}

const policyGet: Command = {
  name: "policy get",
  summary: "A key's rule book (active, pending, effective chain), or the project's.",
  args: "<key id> | --project",
  key: true,
  options: PROJECT_OPTION,
  positionals: { min: 0, max: 1 },
  run: async (context) => {
    const which = target(context);
    const read = which.project ? await context.client().policies.project.get(signalOption(context)) : await context.client().policies.get(which.keyId, signalOption(context));
    if (context.json) context.print.json(read);
    else printPolicyRead(context, read);
    return EXIT_OK;
  },
};

const policySet: Command = {
  name: "policy set",
  summary: "New rule book version: shows what it tightens (applies now) and loosens (pending for the amendment delay).",
  args: "<key id> | --project --file <policy.json> [--if-match sha256:…]",
  key: true,
  options: {
    ...PROJECT_OPTION,
    file: { type: "string", value: "<path>", description: "The rule book (JSON; `-` reads stdin)." },
    "if-match": { type: "string", value: "<hash|none>", description: "Refuse (POLICY_CONFLICT) unless the active hash is this one." },
  },
  positionals: { min: 0, max: 1 },
  run: async (context) => {
    const which = target(context);
    const client = context.client();
    const current = which.project ? { read: await client.policies.project.get(signalOption(context)), defaults: "project" as PolicyDefaults } : await keyDefaults(context, which.keyId);
    const { document, warnings } = await documentFrom(context, current.defaults);
    const comparison = comparePolicies(current.read.policy?.document ?? null, document, { defaults: current.defaults });
    printWarnings(context, warnings);
    if (!context.json) for (const line of changeLines(comparison.tightened, comparison.loosened)) context.print.err(line);
    const ifMatch = stringOption(context.values, "if-match");
    const options = { ...(ifMatch ? { ifMatch } : {}), ...signalOption(context) };
    const written = which.project ? await client.policies.project.put(document, options) : await client.policies.put(which.keyId, document, options);
    if (context.json) context.print.json(written);
    else {
      const version = written.policy;
      context.print.out(
        written.applied === "now"
          ? `v${version.version} applies now (${version.hash}).`
          : `v${version.version} is pending until ${when(version.activatesAt)} (${version.hash}); cancel with kletia policy cancel-pending ${which.project ? "--project" : which.keyId}.`,
      );
      if (written.supersededPending) context.print.out(`It replaces the pending v${written.supersededPending.version}.`);
    }
    return EXIT_OK;
  },
};

const policyCancelPending: Command = {
  name: "policy cancel-pending",
  summary: "Cancel a pending (loosening) rule book amendment.",
  args: "<key id> | --project",
  key: true,
  options: PROJECT_OPTION,
  positionals: { min: 0, max: 1 },
  run: async (context) => {
    const which = target(context);
    const cancelled = which.project ? await context.client().policies.project.cancelPending(signalOption(context)) : await context.client().policies.cancelPending(which.keyId, signalOption(context));
    if (context.json) context.print.json(cancelled);
    else context.print.out(`Cancelled pending v${cancelled.version}.`);
    return EXIT_OK;
  },
};

const policyEvaluate: Command = {
  name: "policy evaluate",
  summary: "The simulator: plan a request as a dry run under a key's rule books and list every rule (exit 1 on deny).",
  args: "<key id> --text \"…\" --account <account> [--at <time>]",
  key: true,
  options: {
    text: { type: "string", value: "<intent text>", description: "The request to evaluate." },
    account: { type: "string", multiple: true, value: "<account>", description: "Request account (CAIP-10 or <network>:<address>; repeatable)." },
    at: { type: "string", value: "<ISO time>", description: "Evaluate the schedule at this time." },
    stage: { type: "string", value: "plan|prepare", description: "prepare also quotes fresh step amounts (default plan)." },
    file: { type: "string", value: "<path>", description: "A draft rule book replacing the key's own for this evaluation." },
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const keyId = keyIdArgument(context);
    const text = stringOption(context.values, "text")?.trim();
    if (!text) throw new UsageError("--text is required.", context.usage);
    const accounts = listOption(context.values, "account").map((value) => accountId(value, context.usage));
    if (accounts.length === 0) throw new UsageError("Pass at least one --account.", context.usage);
    const stage = stringOption(context.values, "stage") ?? "plan";
    if (stage !== "plan" && stage !== "prepare") throw new UsageError("--stage must be plan or prepare.", context.usage);
    const at = stringOption(context.values, "at");
    if (at !== undefined && Number.isNaN(Date.parse(at))) throw new UsageError("--at must be an ISO time.", context.usage);
    const draftFile = stringOption(context.values, "file");
    let draft: PolicyDocument | undefined;
    if (draftFile) {
      const result = validatePolicy(await readJson(context, draftFile), { defaults: "agent" });
      if (!result.ok || !result.value) throw refusedLocally("POLICY_INVALID", "The draft rule book is invalid", result.issues);
      draft = result.value;
    }
    const response = await context.client().policies.evaluate(
      { keyId, request: { text, accounts }, stage, ...(at ? { at: new Date(Date.parse(at)).toISOString() } : {}), ...(draft ? { policy: draft } : {}) },
      signalOption(context),
    );
    const evaluation = response.evaluation;
    if (context.json) context.print.json(response);
    else {
      context.print.out(`${evaluation.outcome.toUpperCase()}${evaluation.code ? ` (${evaluation.code})` : ""}  notional ${evaluation.notionalUsd === null ? "n/p" : `$${evaluation.notionalUsd}`}${evaluation.complete ? "" : "  (planning failed: request-level rules only)"}`);
      context.print.out(table(evaluation.rules.map((rule) => [rule.status, rule.rule, rule.scope === "project" ? "project" : (rule.keyId ?? "key"), rule.observed ?? "", rule.limit ?? "", rule.path ?? ""]), ["status", "rule", "rule book", "observed", "limit", "path"]));
      for (const window of evaluation.schedule ?? []) context.print.out(`schedule ${window.scope}: ${window.open ? "open" : "closed"} (${window.timezone}), next change ${when(window.nextChange)}`);
      for (const warning of evaluation.warnings) context.print.err(`warning: ${warning}`);
      if (response.planError) context.print.err(`plan failed: ${response.planError.code} ${response.planError.message}`);
    }
    return evaluation.outcome === "deny" ? EXIT_ERROR : EXIT_OK;
  },
};

const policyDecisions: Command = {
  name: "policy decisions",
  summary: "The Rule Book decision log of your subtree; --verify-chain recomputes its hash chain (exit 3 when broken).",
  key: true,
  options: {
    key: { type: "string", value: "<key id>", description: "Only this key." },
    intent: { type: "string", value: "<intent id>", description: "Only this intent." },
    outcome: { type: "string", value: "<outcome>", description: "allow, confirm, deny, approved, rejected or observed." },
    stage: { type: "string", value: "<stage>", description: "plan, prepare, submit, evaluate, approval, amendment or key." },
    limit: { type: "string", value: "<1-200>", description: "How many (default 50)." },
    "verify-chain": { type: "boolean", description: "Recompute the hash chain of the page." },
    head: { type: "string", value: "<seq>:<0x…>", description: "A chain head you stored earlier; it must reappear unchanged." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const outcome = stringOption(context.values, "outcome");
    const stage = stringOption(context.values, "stage");
    const limit = integerOption(context.values, "limit", 1, 200, context.usage);
    const key = stringOption(context.values, "key");
    const intent = stringOption(context.values, "intent");
    const list = await context.client().policies.decisions(
      {
        ...(key ? { keyId: key } : {}),
        ...(intent ? { intentId: intent } : {}),
        ...(outcome ? { outcome: outcome as "deny" } : {}),
        ...(stage ? { stage: stage as "plan" } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
      signalOption(context),
    );
    let chain: ReturnType<typeof verifyDecisionChain> | null = null;
    if (context.values["verify-chain"] === true) {
      const headText = stringOption(context.values, "head");
      let known: { seq: number; chainHash: string } | undefined;
      if (headText) {
        const match = /^(\d{1,15}):(0x[0-9a-f]{64})$/u.exec(headText);
        if (!match) throw new UsageError("--head takes <seq>:<0x chain hash>.", context.usage);
        known = { seq: Number(match[1]), chainHash: match[2] as string };
      }
      chain = verifyDecisionChain(list.decisions, known);
    }
    if (context.json) context.print.json({ ...list, ...(chain ? { chain } : {}) });
    else {
      context.print.out(
        table(
          list.decisions.map((decision) => [String(decision.seq), when(decision.at), decision.stage, decision.outcome, decision.keyId ?? "-", decision.intentId ?? "-", [...decision.violations, ...decision.triggers].map((violation) => violation.rule).join(",") || "-"]),
          ["seq", "at", "stage", "outcome", "key", "intent", "rules"],
        ),
      );
      if (list.head) context.print.out(`head ${list.head.seq}:${list.head.chainHash}`);
      if (chain) {
        context.print.out(chain.valid ? `chain valid${chain.head ? ` up to ${chain.head.seq}` : ""}` : "chain BROKEN");
        for (const problem of chain.problems) context.print.out(`  ${problem}`);
      }
    }
    return chain && !chain.valid ? EXIT_INVALID : EXIT_OK;
  },
};

const policySpend: Command = {
  name: "policy spend",
  summary: "Rolling 24 h and 7 d usage and what remains, for every rule book of a key's chain (default: your key).",
  args: "[<key id>]",
  key: true,
  positionals: { min: 0, max: 1 },
  run: async (context) => {
    const keyId = context.positionals.length > 0 ? keyIdArgument(context) : undefined;
    const report = await context.client().policies.spend(keyId, signalOption(context));
    if (context.json) context.print.json(report);
    else {
      const dollars = (value: string | null) => (value === null ? "-" : `$${value}`);
      context.print.out(`${report.keyId} at ${when(report.at)}`);
      context.print.out(
        table(
          report.scopes.map((scope) => [scope.scope, `${dollars(scope.usedDailyUsd)} / ${dollars(scope.capDailyUsd)}`, dollars(scope.remainingDailyUsd), `${dollars(scope.usedWeeklyUsd)} / ${dollars(scope.capWeeklyUsd)}`, dollars(scope.remainingWeeklyUsd), dollars(scope.perIntentUsd)]),
          ["rule book", "24h used / cap", "24h left", "7d used / cap", "7d left", "per intent"],
        ),
      );
    }
    return EXIT_OK;
  },
};

/* --------------------------------------------------------------- approvals */

function approvalId(context: CommandContext): string {
  const id = positional(context, 0);
  if (!/^apr_[0-9a-f]{32}$/u.test(id)) throw new UsageError(`"${id}" is not an approval id (apr_ followed by 32 hex characters).`, context.usage);
  return id;
}

function printApproval(context: CommandContext, approval: PolicyApprovalView): void {
  context.print.out(`${approval.id}  ${approval.status}  ${approval.title ?? approval.intentId}`);
  context.print.out(`intent ${approval.intentId}  requested by ${approval.keyId}  notional ${approval.notionalUsd === null ? "n/p" : `$${approval.notionalUsd}`}  up to $${approval.ceilingUsd}  expires ${when(approval.expiresAt)}`);
  context.print.out(`triggers ${approval.triggers.join(", ")}  digest ${approval.digest}`);
  if (approval.steps.length > 0) {
    context.print.out(
      table(
        approval.steps.map((step) => [step.id, step.kind, step.destinationNetwork ? `${step.network}→${step.destinationNetwork}` : step.network, step.protocol, step.input ?? "-", step.output ?? "-", step.recipientName ? `${step.recipientName} (${step.recipient})` : step.recipient]),
        ["step", "kind", "network", "venue", "in", "out", "recipient"],
      ),
    );
  }
  const approvers = approval.approvers;
  context.print.out(`approvers: ${approvers.requireWallet ? "a listed wallet only" : "a project key or a listed wallet"}${approvers.wallets.length > 0 ? ` (${approvers.wallets.join(", ")})` : ""}`);
  if (approval.decidedBy) context.print.out(`decided by ${approval.decidedBy.kind} ${approval.decidedBy.id} at ${when(approval.decidedAt)}`);
}

const approvalsList: Command = {
  name: "approvals list",
  summary: "Approvals you may decide (--role approver) or your subtree's requests.",
  key: true,
  options: {
    role: { type: "string", value: "approver|requester", description: "Default requester." },
    status: { type: "string", value: "<status>", description: "pending, approved, rejected or expired." },
    limit: { type: "string", value: "<1-100>", description: "How many (default 20)." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const role = stringOption(context.values, "role");
    if (role !== undefined && role !== "approver" && role !== "requester") throw new UsageError("--role must be approver or requester.", context.usage);
    const status = stringOption(context.values, "status");
    const limit = integerOption(context.values, "limit", 1, 100, context.usage);
    const list = await context.client().approvals.list({ ...(role ? { role } : {}), ...(status ? { status: status as "pending" } : {}), ...(limit !== undefined ? { limit } : {}) }, signalOption(context));
    if (context.json) context.print.json(list);
    else context.print.out(table(list.map((approval) => [approval.id, approval.status, approval.keyId, approval.notionalUsd === null ? "n/p" : `$${approval.notionalUsd}`, `$${approval.ceilingUsd}`, when(approval.expiresAt), approval.title ?? approval.intentId]), ["approval", "status", "requester", "notional", "ceiling", "expires", "intent"]));
    return EXIT_OK;
  },
};

const approvalsShow: Command = {
  name: "approvals show",
  summary: "One approval (public: reading is not approving).",
  args: "<approval id>",
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const approval = await context.client().approvals.get(approvalId(context), signalOption(context));
    if (context.json) context.print.json(approval);
    else printApproval(context, approval);
    return EXIT_OK;
  },
};

/** Approve or reject with this key, after showing the approval and checking its digest against the intent. */
function decide(decision: "approve" | "reject"): Command {
  return {
    name: `approvals ${decision}`,
    summary: decision === "approve" ? "Approve a held intent with this project key (shows it first; needs --yes)." : "Reject a held intent with this project key; the intent is cancelled (needs --yes).",
    args: "<approval id> --yes",
    key: true,
    options: CONFIRM_OPTION,
    positionals: { min: 1, max: 1 },
    run: async (context) => {
      const id = approvalId(context);
      const client = context.client();
      const approval = await client.approvals.get(id, signalOption(context));
      if (!context.json) printApproval(context, approval);
      const intent = await client.intents.get(approval.intentId, signalOption(context));
      if (approvalDigest(intent, approval.keyId) !== approval.digest) {
        throw refusedLocally("APPROVAL_SIGNATURE_INVALID", "The approval's digest is not the digest of the intent it names; nothing was decided", []);
      }
      if (context.values.yes !== true) {
        throw new UsageError(`Check the intent above, then pass --yes to ${decision} it.`, context.usage);
      }
      const decided = decision === "approve" ? await client.approvals.approve(id, signalOption(context)) : await client.approvals.reject(id, signalOption(context));
      if (context.json) context.print.json(decided);
      else context.print.out(`${decided.id} ${decided.status}.`);
      return EXIT_OK;
    },
  };
}

export const POLICY_COMMANDS: readonly Command[] = Object.freeze([
  keysCreateAgent,
  keysTree,
  policyTemplate,
  policyValidate,
  policyGet,
  policySet,
  policyCancelPending,
  policyEvaluate,
  policyDecisions,
  policySpend,
  approvalsList,
  approvalsShow,
  decide("approve"),
  decide("reject"),
]);
