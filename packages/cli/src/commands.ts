/**
 * Command table for `kletia`. Every command is read-only or manages your
 * own keys, agent keys, rule books, approvals, webhooks, contract
 * registrations, sessions, receipt shares and intent links: the CLI never
 * prepares, signs or submits a transaction, and never holds funds.
 */
import { readFile } from "node:fs/promises";
import { sameAddressAccount, signWebhookPayload, type AnyKletiaEvent, type IntentGraph, type IntentPreview, type ProtocolId } from "@kletia/core";
import {
  isKletiaError,
  KletiaApiError,
  MAX_RETRY_DELAY_MS,
  TERMINAL_INTENT_STATUSES,
  watchIntent,
  type KletiaClient,
  type QuoteRequest,
  type UsageWindow,
} from "@kletia/sdk";
import { constructWebhookEvent, KletiaWebhookError } from "@kletia/sdk/server";
import { integerOption, listOption, stringOption, UsageError, type OptionSpec } from "./args.js";
import {
  accountId,
  CONFIRM_OPTION,
  EXIT_ERROR,
  EXIT_NOT_COMPLETED,
  EXIT_OK,
  networkKey,
  positional,
  type Command,
  type CommandContext,
} from "./common.js";
import { CONTRACT_COMMANDS } from "./contracts.js";
import { LINK_COMMANDS } from "./links.js";
import { POLICY_COMMANDS } from "./policies.js";
import { formatFare, PREVIEW_COMMANDS } from "./preview.js";
import { RECEIPT_COMMANDS } from "./receipts.js";
import { abandonSecretSink, deliverSecret, openSecretSink, SECRET_OPTIONS } from "./secrets.js";
import { amount, table, when, type Printer } from "./output.js";

export { EXIT_ERROR, EXIT_INCONCLUSIVE, EXIT_INVALID, EXIT_MISMATCH, EXIT_NOT_COMPLETED, EXIT_OK, EXIT_USAGE } from "./common.js";
export type { Command, CommandContext } from "./common.js";

function formatAmount(value: { readonly formatted: string; readonly symbol: string } | undefined): string {
  return value ? `${amount(value.formatted)} ${value.symbol}` : "-";
}

function usd(value: number | undefined): string {
  return value === undefined ? "-" : `$${value.toFixed(2)}`;
}

function seconds(value: number | undefined): string {
  if (value === undefined) return "-";
  return value >= 90 ? `${Math.round(value / 60)}m` : `${Math.max(1, Math.round(value))}s`;
}

/**
 * Steps whose recipient is not one of the planning accounts (funds leave the
 * user's control). The user's own address on another network of the same VM
 * (a bridge's default recipient) is theirs, as in the planner.
 */
function externalRecipients(intent: IntentGraph): string[] {
  const own = intent.request.accounts;
  return intent.steps
    .filter((step) => step.recipient && !own.some((account) => sameAddressAccount(account, step.recipient as string)))
    .map((step) => `${step.id}: ${step.recipientName ? `${step.recipientName} → ` : ""}${step.recipient}`);
}

function printIntent(print: Printer, intent: IntentGraph): void {
  print.out(`${intent.summary.title}`);
  print.out(
    `id ${intent.id}  status ${intent.status}  signatures ${intent.summary.signaturesRequired}  fees ≈ ${usd(intent.summary.totalFeesUsd)}  eta ≈ ${seconds(intent.summary.estimatedSeconds)}`,
  );
  print.out("");
  print.out(
    table(
      intent.steps.map((step) => [
        step.id,
        step.status,
        step.settlement?.destinationNetwork ? `${step.network}→${step.settlement.destinationNetwork}` : step.network,
        step.protocol,
        formatAmount(step.input),
        step.expectedOutput ? `${formatAmount(step.expectedOutput)}${step.minimumOutput ? ` (min ${amount(step.minimumOutput.formatted)})` : ""}` : "-",
      ]),
      ["step", "status", "network", "venue", "in", "out"],
    ),
  );
  const external = externalRecipients(intent);
  if (external.length > 0) {
    print.out("");
    print.out("Sends to accounts that are not yours:");
    for (const line of external) print.out(`  ${line}`);
  }
  for (const warning of [...intent.warnings, ...intent.steps.flatMap((step) => step.warnings ?? [])]) print.out(`warning: ${warning}`);
  for (const step of intent.steps) if (step.failure) print.out(`${step.id} failed: ${step.failure.code} ${step.failure.message}`);
}

/* --------------------------------------------------------------- commands */

const health: Command = {
  name: "health",
  summary: "API and per-network RPC health.",
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const report = await context.client().health({ ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) {
      context.print.json(report);
      return EXIT_OK;
    }
    context.print.out(`status ${report.status}  version ${report.version}  uptime ${seconds(report.uptimeSeconds)}`);
    context.print.out(
      table(
        report.networks.map((network) => [network.network, network.ok ? "ok" : "down", `${network.latencyMs}ms`, network.height ?? "-", network.detail ?? ""]),
        ["network", "rpc", "latency", "height", "detail"],
      ),
    );
    return report.status === "down" ? EXIT_ERROR : EXIT_OK;
  },
};

const networks: Command = {
  name: "networks",
  summary: "Networks with their actions and venues.",
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const list = await context.client().networks({ ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(list);
    else {
      context.print.out(
        table(
          list.map((network) => [network.key, network.name, network.vm, network.environment, network.actions.join(","), network.protocols.join(",")]),
          ["network", "name", "vm", "environment", "actions", "venues"],
        ),
      );
    }
    return EXIT_OK;
  },
};

const protocols: Command = {
  name: "protocols",
  summary: "Protocol registry.",
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const list = await context.client().protocols({ ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(list);
    else {
      context.print.out(
        table(
          list.map((protocol) => [protocol.id, protocol.category, protocol.networks.join(","), (protocol.kinds ?? []).join(",")]),
          ["protocol", "category", "networks", "actions"],
        ),
      );
    }
    return EXIT_OK;
  },
};

const assets: Command = {
  name: "assets",
  summary: "Asset registry.",
  options: { network: { type: "string", value: "<network>", description: "Only this network." } },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const network = stringOption(context.values, "network");
    const list = await context.client().assets(network ? networkKey(network, context.usage) : undefined, { ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(list);
    else {
      context.print.out(
        table(
          list.map((asset) => [asset.network, asset.symbol, String(asset.decimals), asset.address ?? "native", asset.name]),
          ["network", "symbol", "decimals", "address", "name"],
        ),
      );
    }
    return EXIT_OK;
  },
};

const venues: Command = {
  name: "venues",
  summary: "EVM lending venues with supply APY, size and exit liquidity (advisory).",
  options: {
    network: { type: "string", value: "<network>", description: "Only this network." },
    protocol: { type: "string", value: "<protocol>", description: "Only this lending protocol (aave-v3, compound-v3, morpho, moonwell)." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const network = stringOption(context.values, "network");
    const protocol = stringOption(context.values, "protocol");
    const response = await context.client().venues(
      { ...(network ? { network: networkKey(network, context.usage) } : {}), ...(protocol ? { protocol: protocol as ProtocolId } : {}) },
      { ...(context.signal ? { signal: context.signal } : {}) },
    );
    if (context.json) context.print.json(response);
    else {
      const percent = (value: number | null) => (value === null ? "-" : `${(value * 100).toFixed(2)}%`);
      context.print.out(
        table(
          response.venues.map((venue) => [
            venue.venue,
            percent(venue.supplyApy),
            venue.totalSupplied ? `${amount(venue.totalSupplied.formatted)} ${venue.totalSupplied.symbol}` : "-",
            venue.exitLiquidity ? `${amount(venue.exitLiquidity.formatted)} ${venue.exitLiquidity.symbol}` : "-",
            percent(venue.utilization),
          ]),
          ["venue", "apy", "supplied", "exit liquidity", "utilization"],
        ),
      );
    }
    for (const miss of response.unavailable) context.print.err(`${miss.venue}: ${miss.code} ${miss.message}`);
    return EXIT_OK;
  },
};

const quote: Command = {
  name: "quote",
  summary: "Best routes for one movement, e.g. `kletia quote 25 USDC --from base --to solana`.",
  args: "<amount> <asset> [<to-asset>]",
  options: {
    from: { type: "string", value: "<network>", description: "Source network (required)." },
    to: { type: "string", value: "<network>", description: "Destination network (default: the source)." },
    account: { type: "string", value: "<account>", description: "Account that would sign (improves cross-network quotes)." },
    recipient: { type: "string", value: "<address>", description: "Destination address or account." },
    "slippage-bps": { type: "string", value: "<bps>", description: "Slippage limit in basis points." },
    "max-seconds": { type: "string", value: "<seconds>", description: "Longest acceptable settlement time (10-86400, default 600)." },
  },
  positionals: { min: 2, max: 3 },
  run: async (context) => {
    const from = stringOption(context.values, "from");
    if (!from) throw new UsageError("--from <network> is required.", context.usage);
    const fromNetwork = networkKey(from, context.usage);
    const toNetwork = networkKey(stringOption(context.values, "to") ?? from, context.usage);
    const value = positional(context, 0);
    if (!/^\d+(\.\d+)?$/u.test(value)) throw new UsageError(`"${value}" is not a decimal amount.`, context.usage);
    const asset = positional(context, 1);
    const toAsset = context.positionals[2] ?? asset;
    const account = stringOption(context.values, "account");
    const recipient = stringOption(context.values, "recipient");
    const slippage = integerOption(context.values, "slippage-bps", 1, 1000, context.usage);
    const maxSeconds = integerOption(context.values, "max-seconds", 10, 86_400, context.usage);
    const request: QuoteRequest = {
      from: { network: fromNetwork, asset, amount: value, ...(account ? { account: accountId(account, context.usage) } : {}) },
      to: { network: toNetwork, asset: toAsset, ...(recipient ? { recipient } : {}) },
      ...(slippage !== undefined ? { slippageBps: slippage } : {}),
      ...(maxSeconds !== undefined ? { maxSeconds } : {}),
    };
    const response = await context.client().quote(request, { ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) {
      context.print.json(response);
      return response.best ? EXIT_OK : EXIT_ERROR;
    }
    const best = response.best;
    const isBest = (route: (typeof response.routes)[number]) =>
      best !== null && route.protocol === best.protocol && route.toNetwork === best.toNetwork && route.output.amount === best.output.amount;
    if (response.routes.length === 0) context.print.out("No route.");
    else {
      context.print.out(
        table(
          response.routes.map((route) => [
            isBest(route) ? "*" : "",
            route.protocol,
            formatAmount(route.output),
            amount(route.minimumOutput.formatted),
            usd(route.feesUsd),
            seconds(route.estimatedSeconds),
            String(route.transactionCount),
          ]),
          ["", "venue", "out", "min", "fees", "eta", "txs"],
        ),
      );
      for (const warning of response.best?.warnings ?? []) context.print.out(`warning: ${warning}`);
    }
    for (const miss of response.unavailable) context.print.err(`${miss.protocol}: ${miss.code} ${miss.message}`);
    return response.best ? EXIT_OK : EXIT_ERROR;
  },
};

const plan: Command = {
  name: "plan",
  summary: "Plan an intent (a dry run unless --save), e.g. `kletia plan \"bridge 25 USDC from base to solana\" --account …`.",
  args: "\"<intent text>\"",
  options: {
    account: { type: "string", multiple: true, value: "<account>", description: "Your account, as CAIP-10 or <network>:<address> (repeatable)." },
    "max-slippage-bps": { type: "string", value: "<bps>", description: "Per-swap slippage ceiling." },
    "max-seconds": { type: "string", value: "<seconds>", description: "Longest settlement time a bridge step may take (10-86400, default 600)." },
    save: { type: "boolean", description: "Store the intent (to execute it later with the SDK, widget or Studio)." },
    preview: { type: "boolean", description: "Also print the asset-change preview (fare breakdown)." },
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const text = positional(context, 0).trim();
    if (!text) throw new UsageError("Describe the intent to plan.", context.usage);
    const accounts = listOption(context.values, "account").map((value) => accountId(value, context.usage));
    if (accounts.length === 0) throw new UsageError("Pass at least one --account.", context.usage);
    const slippage = integerOption(context.values, "max-slippage-bps", 1, 1000, context.usage);
    const maxSeconds = integerOption(context.values, "max-seconds", 10, 86_400, context.usage);
    const constraints = {
      ...(slippage !== undefined ? { maxSlippageBps: slippage } : {}),
      ...(maxSeconds !== undefined ? { maxSeconds } : {}),
    };
    const save = context.values.save === true;
    const request = { text, accounts, ...(Object.keys(constraints).length > 0 ? { constraints } : {}) };
    const options = { ...(save ? {} : { dryRun: true }), ...(context.signal ? { signal: context.signal } : {}) };
    let intent: IntentGraph;
    let fare: IntentPreview | null | undefined;
    if (context.values.preview === true) {
      const result = await context.client().intents.create(request, { ...options, preview: true });
      intent = result.intent;
      fare = result.preview;
    } else intent = await context.client().intents.create(request, options);
    if (context.json) context.print.json(fare === undefined ? intent : { intent, preview: fare });
    else {
      printIntent(context.print, intent);
      if (fare) {
        context.print.out("");
        context.print.out(formatFare(fare));
      } else if (fare === null) context.print.err("The API returned no preview for this plan.");
      context.print.err(save ? `Saved. Follow it with: kletia intents watch ${intent.id}` : "Dry run: nothing was stored. Pass --save to store the intent.");
    }
    return EXIT_OK;
  },
};

const intentsGet: Command = {
  name: "intents get",
  summary: "Show an intent.",
  args: "<intent id>",
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const intent = await context.client().intents.get(positional(context, 0), { ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(intent);
    else printIntent(context.print, intent);
    return EXIT_OK;
  },
};

const intentsList: Command = {
  name: "intents list",
  summary: "Intents created with your key.",
  key: true,
  options: { limit: { type: "string", value: "<1-100>", description: "How many (default 20)." } },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const limit = integerOption(context.values, "limit", 1, 100, context.usage) ?? 20;
    const list = await context.client().intents.list(limit, { ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(list);
    else {
      context.print.out(
        table(
          list.map((intent) => [intent.id, intent.status, when(intent.createdAt), intent.summary.title]),
          ["intent", "status", "created", "title"],
        ),
      );
    }
    return EXIT_OK;
  },
};

function describeEvent(event: AnyKletiaEvent): string {
  switch (event.type) {
    case "intent.created":
      return `created: ${event.data.summary.title}`;
    case "intent.status_changed":
      return `status ${event.data.previous} → ${event.data.status}`;
    case "intent.step_updated":
      return `step ${event.data.stepId} on ${event.data.network}: ${event.data.status}${event.data.evidence?.url ? ` ${event.data.evidence.url}` : ""}`;
    default:
      return event.type;
  }
}

function timeoutOption(context: CommandContext, fallbackSeconds: number): number {
  return (integerOption(context.values, "wait", 1, 86_400, context.usage) ?? fallbackSeconds) * 1000;
}

const intentsWatch: Command = {
  name: "intents watch",
  summary: "Follow an intent's events until it ends (exit 0 completed, 2 otherwise).",
  args: "<intent id>",
  options: { wait: { type: "string", value: "<seconds>", description: "Give up after this long (default 1800)." } },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const id = positional(context, 0);
    const final = await follow(context, id, timeoutOption(context, 1800), (event) => {
      if (context.json) context.print.jsonLine({ event });
      else context.print.out(`${when(event.at)}  ${describeEvent(event)}`);
    });
    if (context.json) context.print.jsonLine({ intent: final });
    else context.print.out(`${final.id} ${final.status}`);
    return final.status === "completed" ? EXIT_OK : EXIT_NOT_COMPLETED;
  },
};

/** Watches until terminal, `waitMs` or Ctrl-C. */
async function follow(context: CommandContext, id: string, waitMs: number, onEvent: (event: AnyKletiaEvent) => void): Promise<IntentGraph> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  context.signal?.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  let announced = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, waitMs);
  try {
    return await watchIntent(context.client(), id, {
      signal: controller.signal,
      onEvent,
      onTransport: (transport) => {
        // The first "poll" is the initial read; report later switches only.
        if (transport === "poll" && !announced) {
          announced = true;
          return;
        }
        announced = true;
        if (!context.json) context.print.err(transport === "stream" ? "Following the event stream…" : "Event stream unavailable; polling…");
      },
    });
  } catch (error) {
    if (timedOut) throw new Error(`The intent did not end within ${Math.round(waitMs / 1000)} s.`);
    throw error;
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", stop);
  }
}

/* -------------------------------------------------------------------- keys */

/** Id of the key in KLETIA_API_KEY (the one `keys list` marks current). */
async function currentKeyId(context: CommandContext): Promise<string | undefined> {
  const list = await context.client().keys.list({ ...(context.signal ? { signal: context.signal } : {}) });
  return list.find((key) => key.current)?.id;
}

const keysCreate: Command = {
  name: "keys create",
  summary: "Issue a developer key (a new project without KLETIA_API_KEY, a sibling key with it).",
  args: "<name>",
  options: SECRET_OPTIONS,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const sink = await openSecretSink(context);
    let issued;
    try {
      issued = await context.client().keys.create(positional(context, 0), { ...(context.signal ? { signal: context.signal } : {}) });
    } catch (error) {
      await abandonSecretSink(sink);
      throw error;
    }
    const { key: secret, ...record } = issued;
    if (!secret) {
      await abandonSecretSink(sink);
      throw new Error("The API did not return the new key.");
    }
    await deliverSecret(context, sink, secret, record, "key", `Created ${record.id} (${record.name}, ${record.tier}).`);
    return EXIT_OK;
  },
};

const keysList: Command = {
  name: "keys list",
  summary: "Keys of your project (never secrets).",
  key: true,
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const list = await context.client().keys.list({ ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(list);
    else {
      context.print.out(
        table(
          list.map((key) => [
            `${key.id}${key.current ? " *" : ""}`,
            key.name,
            key.last4 ? `…${key.last4}` : "-",
            key.revokedAt ? `revoked ${when(key.revokedAt)}` : key.previousExpiresAt ? `rotated; old secret until ${when(key.previousExpiresAt)}` : "active",
            when(key.lastUsedAt),
          ]),
          ["key", "name", "secret", "state", "last used"],
        ),
      );
    }
    return EXIT_OK;
  },
};

const keysRotate: Command = {
  name: "keys rotate",
  summary: "New secret for a key, same id; the old secret works for --grace-seconds (default 86400) but cannot manage keys.",
  args: "<key id>",
  key: true,
  options: {
    "grace-seconds": { type: "string", value: "<0-604800>", description: "How long the old secret keeps working (0 ends it now)." },
    ...SECRET_OPTIONS,
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const id = positional(context, 0);
    const graceSeconds = integerOption(context.values, "grace-seconds", 0, 604_800, context.usage);
    const sink = await openSecretSink(context);
    let rotated;
    try {
      if (graceSeconds === 0 && (await currentKeyId(context)) === id) {
        // Its secret would stop working at once: a lost response could not be replayed to it.
        throw new UsageError(
          `${id} is the key this command uses. With --grace-seconds 0 its secret stops working at once, so if the response were lost the new secret could not be recovered. Rotate it with another key of the project in KLETIA_API_KEY (\`kletia keys create <name>\` makes one), or keep a grace period.`,
          context.usage,
        );
      }
      rotated = await context.client().keys.rotate(id, {
        ...(graceSeconds !== undefined ? { graceSeconds } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      // OUTCOME_UNKNOWN (the response was lost) is reported as such; the file never held a secret.
      await abandonSecretSink(sink);
      throw error;
    }
    const { key: secret, ...record } = rotated;
    const grace = record.previousExpiresAt ? `the old secret works until ${when(record.previousExpiresAt)}` : "the old secret no longer works";
    await deliverSecret(context, sink, secret, record, "key", `Rotated ${record.id}; ${grace}.`);
    return EXIT_OK;
  },
};

const confirm = CONFIRM_OPTION;

const keysRevoke: Command = {
  name: "keys revoke",
  summary: "Revoke a key (stops working within 15 s everywhere).",
  args: "<key id> --yes",
  key: true,
  options: confirm,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    if (context.values.yes !== true) throw new UsageError("Revoking a key cannot be undone; pass --yes.", context.usage);
    const id = positional(context, 0);
    // Known before the call: once a key revoked itself, nothing can be read with it.
    const own = (await currentKeyId(context).catch(() => undefined)) === id;
    try {
      await context.client().keys.revoke(id, { ...(context.signal ? { signal: context.signal } : {}) });
    } catch (error) {
      // The key revoked itself, the response was lost and the retry was refused: its secret no longer works.
      if (!own || !isKletiaError(error, "OUTCOME_UNKNOWN")) throw error;
      if (!context.json) context.print.err("The response was lost; the retry was refused because this key no longer authenticates.");
    }
    if (context.json) context.print.json({ revoked: id });
    else context.print.out(`Revoked ${id}.`);
    return EXIT_OK;
  },
};

/* ---------------------------------------------------------------- webhooks */

const webhooksList: Command = {
  name: "webhooks list",
  summary: "Your webhooks.",
  key: true,
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const list = await context.client().webhooks.list({ ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(list);
    else context.print.out(table(list.map((hook) => [hook.id, hook.url, hook.events.join(","), when(hook.createdAt)]), ["webhook", "url", "events", "created"]));
    return EXIT_OK;
  },
};

const webhooksCreate: Command = {
  name: "webhooks create",
  summary: "Register a public HTTPS endpoint; its signing secret is shown once.",
  args: "<https url>",
  key: true,
  options: {
    event: { type: "string", multiple: true, value: "<type>", description: "Event type to send (repeatable; default all intent events)." },
    ...SECRET_OPTIONS,
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const url = positional(context, 0);
    const events = listOption(context.values, "event");
    const sink = await openSecretSink(context);
    let created;
    try {
      created = await context.client().webhooks.create(
        { url, ...(events.length > 0 ? { events } : {}) },
        { ...(context.signal ? { signal: context.signal } : {}) },
      );
    } catch (error) {
      await abandonSecretSink(sink);
      throw error;
    }
    const { secret, ...record } = created;
    if (!secret) {
      await abandonSecretSink(sink);
      throw new Error("The API did not return the signing secret.");
    }
    await deliverSecret(context, sink, secret, record, "secret", `Created ${record.id} for ${record.url}.`);
    return EXIT_OK;
  },
};

const webhooksDelete: Command = {
  name: "webhooks delete",
  summary: "Delete a webhook and its delivery log.",
  args: "<webhook id> --yes",
  key: true,
  options: confirm,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    if (context.values.yes !== true) throw new UsageError("Deleting a webhook cannot be undone; pass --yes.", context.usage);
    const id = positional(context, 0);
    await context.client().webhooks.delete(id, { ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json({ deleted: id });
    else context.print.out(`Deleted ${id}.`);
    return EXIT_OK;
  },
};

function deliveryRow(delivery: Awaited<ReturnType<KletiaClient["webhooks"]["test"]>>): string[] {
  return [
    when(delivery.at),
    delivery.eventType,
    delivery.status,
    delivery.httpStatus !== undefined ? String(delivery.httpStatus) : "-",
    delivery.durationMs !== undefined ? `${delivery.durationMs}ms` : "-",
    delivery.error ?? "",
    `${delivery.attempt}${delivery.test ? " (test)" : ""}`,
  ];
}

const DELIVERY_HEADER = ["at", "event", "status", "http", "time", "error", "attempt"];

const webhooksTest: Command = {
  name: "webhooks test",
  summary: "Send a signed webhook.test event now and show what the endpoint answered.",
  args: "<webhook id>",
  key: true,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const delivery = await context.client().webhooks.test(positional(context, 0), { ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(delivery);
    else context.print.out(table([deliveryRow(delivery)], DELIVERY_HEADER));
    return delivery.status === "succeeded" ? EXIT_OK : EXIT_ERROR;
  },
};

const webhooksDeliveries: Command = {
  name: "webhooks deliveries",
  summary: "Recent delivery attempts of a webhook.",
  args: "<webhook id>",
  key: true,
  options: { limit: { type: "string", value: "<1-100>", description: "How many (default 20)." } },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const limit = integerOption(context.values, "limit", 1, 100, context.usage);
    const list = await context.client().webhooks.deliveries(positional(context, 0), {
      ...(limit !== undefined ? { limit } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (context.json) context.print.json(list);
    else context.print.out(table(list.map(deliveryRow), DELIVERY_HEADER));
    return EXIT_OK;
  },
};

function webhookSecrets(context: CommandContext): string[] {
  const secrets = (context.io.env.KLETIA_WEBHOOK_SECRET ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (secrets.length === 0) {
    throw new UsageError("Set KLETIA_WEBHOOK_SECRET to the webhook's signing secret (comma-separated during a rotation).", context.usage);
  }
  return secrets;
}

const webhooksVerify: Command = {
  name: "webhooks verify",
  summary: "Check a delivery's Kletia-Signature against its raw body (stdin or --file), using KLETIA_WEBHOOK_SECRET.",
  args: "--signature \"t=…,v1=…\" [--file <body.json>]",
  options: {
    signature: { type: "string", value: "<header>", description: "The Kletia-Signature header value." },
    file: { type: "string", value: "<path>", description: "Raw body file (default: stdin)." },
    tolerance: { type: "string", value: "<seconds>", description: "Accepted signature age (default 300)." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const signature = stringOption(context.values, "signature");
    if (!signature) throw new UsageError("--signature is required.", context.usage);
    const secrets = webhookSecrets(context);
    const tolerance = integerOption(context.values, "tolerance", 0, 31_536_000, context.usage);
    const file = stringOption(context.values, "file");
    let body: Uint8Array | string;
    if (file) body = await readFile(file);
    else if (context.io.readStdin) body = await context.io.readStdin();
    else throw new UsageError("Pass --file <path> or pipe the body on stdin.", context.usage);
    try {
      const event = await constructWebhookEvent(body, signature, secrets, tolerance !== undefined ? { toleranceSeconds: tolerance } : {});
      if (context.json) context.print.json({ valid: true, event });
      else context.print.out(`valid: ${event.type} ${event.id}`);
      return EXIT_OK;
    } catch (error) {
      if (!(error instanceof KletiaWebhookError)) throw error;
      if (context.json) context.print.json({ valid: false, reason: error.reason });
      else context.print.err(`invalid (${error.reason}): ${error.message}`);
      return EXIT_ERROR;
    }
  },
};

function loopbackUrl(value: string, usage: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`"${value}" is not a URL.`, usage);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new UsageError("--to must be a local endpoint such as http://localhost:3000/webhooks/kletia (real deliveries go to public HTTPS).", usage);
  }
  return url;
}

const webhooksForward: Command = {
  name: "webhooks forward",
  summary: "Forward an intent's events to a local endpoint, signed like real deliveries with KLETIA_WEBHOOK_SECRET.",
  args: "--intent <id> --to http://localhost:3000/…",
  options: {
    intent: { type: "string", value: "<id>", description: "Intent whose events to forward." },
    to: { type: "string", value: "<url>", description: "Local endpoint (localhost or 127.0.0.1)." },
    wait: { type: "string", value: "<seconds>", description: "Give up after this long (default 1800)." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const id = stringOption(context.values, "intent");
    const to = stringOption(context.values, "to");
    if (!id || !to) throw new UsageError("--intent and --to are required.", context.usage);
    const target = loopbackUrl(to, context.usage);
    const [secret] = webhookSecrets(context);
    const deliver = async (event: AnyKletiaEvent): Promise<void> => {
      const body = JSON.stringify(event);
      const fetcher = context.io.fetch ?? fetch;
      let status = "error";
      try {
        const response = await fetcher(target.toString(), {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(5_000),
          headers: {
            "content-type": "application/json",
            "user-agent": "Kletia-CLI-Forward/0.1",
            "kletia-signature": await signWebhookPayload(secret as string, body),
            "kletia-event-id": event.id,
            "kletia-event-type": event.type,
            "kletia-webhook-id": "local-forward",
            "kletia-delivery-attempt": "1",
          },
          body,
        });
        await response.body?.cancel().catch(() => undefined);
        status = String(response.status);
      } catch (error) {
        status = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable";
      }
      if (context.json) context.print.jsonLine({ forwarded: event.id, type: event.type, status });
      else context.print.out(`${status}  ${event.type}  ${event.id}`);
    };
    // Deliver in order, one at a time, like the real dispatcher.
    let queue = Promise.resolve();
    const state: ForwardState = { forwarded: new Set(), lastEventId: undefined, finalForwarded: false };
    const forward = (event: AnyKletiaEvent) => {
      if (typeof event?.id !== "string" || state.forwarded.has(event.id)) return;
      state.forwarded.add(event.id);
      state.lastEventId = event.id;
      if (event.type === "intent.status_changed" && TERMINAL_INTENT_STATUSES.includes(event.data.status)) state.finalForwarded = true;
      queue = queue.then(() => deliver(event));
    };
    const waitMs = timeoutOption(context, 1800);
    const deadline = Date.now() + waitMs;
    const final = await follow(context, id, waitMs, forward);
    // A read can see the end before the stream delivered every event (the intent had already ended, or the
    // stream was unavailable): forward what the API still holds for it.
    const missing = state.finalForwarded ? null : await replayEndedIntent(context, id, deadline, state, forward);
    await queue;
    if (!context.json) context.print.err(`${final.id} ${final.status}`);
    if (missing) {
      const warning = `not every event of ${final.id} was forwarded (${state.forwarded.size} were): ${missing}. Run the command again to replay the events the API still holds.`;
      if (context.json) context.print.err(JSON.stringify({ warning, forwarded: state.forwarded.size }));
      else context.print.err(`warning: ${warning}`);
      return EXIT_ERROR;
    }
    return final.status === "completed" ? EXIT_OK : EXIT_NOT_COMPLETED;
  },
};

interface ForwardState {
  readonly forwarded: Set<string>;
  lastEventId: string | undefined;
  /** The intent's terminal `intent.status_changed` was forwarded. */
  finalForwarded: boolean;
}

/** How long a replay stream may stay quiet (the API sends what it holds as soon as the stream opens). */
const REPLAY_IDLE_MS = 2_000;

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * For an intent that has ended: opens its event stream after the last
 * forwarded event and forwards what the API replays, until the terminal
 * `intent.status_changed` or REPLAY_IDLE_MS of quiet. An unavailable stream
 * (e.g. 429 TOO_MANY_STREAMS) is retried until `deadline`. Resolves with null
 * once the terminal event was forwarded, else with why it was not.
 */
async function replayEndedIntent(
  context: CommandContext,
  id: string,
  deadline: number,
  state: ForwardState,
  forward: (event: AnyKletiaEvent) => void,
): Promise<string | null> {
  let announced = false;
  for (let failures = 1; ; failures += 1) {
    if (context.signal?.aborted) throw new Error("Interrupted.");
    const controller = new AbortController();
    const stopped: { by: "quiet" | "deadline" | null } = { by: null };
    const stop = (reason: "quiet" | "deadline" | null) => () => {
      if (!controller.signal.aborted) stopped.by = reason;
      controller.abort();
    };
    const interrupt = stop(null);
    context.signal?.addEventListener("abort", interrupt, { once: true });
    const cap = setTimeout(stop("deadline"), Math.max(0, deadline - Date.now()));
    let idle: ReturnType<typeof setTimeout> | undefined;
    const quiet = () => {
      clearTimeout(idle);
      idle = setTimeout(stop("quiet"), REPLAY_IDLE_MS);
    };
    let failure: unknown = null;
    try {
      const after = state.lastEventId;
      await context.client().intents.stream(
        id,
        (event) => {
          forward(event);
          if (state.finalForwarded) controller.abort();
          else quiet();
        },
        { signal: controller.signal, ...(after ? { lastEventId: after } : {}), onOpen: quiet },
      );
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(cap);
      clearTimeout(idle);
      context.signal?.removeEventListener("abort", interrupt);
    }
    if (state.finalForwarded) return null;
    if (context.signal?.aborted) throw failure ?? new Error("Interrupted.");
    if (stopped.by === "deadline") return "--wait ran out before the intent's final event arrived";
    if (failure === null) return "the API no longer holds the intent's final event";
    const reason = failure instanceof KletiaApiError ? failure.code : failure instanceof Error ? failure.message : String(failure);
    if (!(failure instanceof KletiaApiError) || !failure.retryable) return `the event stream could not be opened (${reason})`;
    const wait =
      failure.retryAfterSeconds !== null ? failure.retryAfterSeconds * 1000 : Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** failures);
    if (Date.now() + wait >= deadline) return `the event stream stayed unavailable within --wait (${reason})`;
    if (!announced && !context.json) context.print.err(`Event stream unavailable (${reason}); retrying to forward the intent's events…`);
    announced = true;
    await pause(wait, context.signal);
  }
}

/* ------------------------------------------------------------------ misc */

const usage: Command = {
  name: "usage",
  summary: "Requests, rate-limit window and intents of your key.",
  key: true,
  options: { window: { type: "string", value: "24h|7d", description: "Reporting window (default 24h)." } },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const window = stringOption(context.values, "window") ?? "24h";
    if (window !== "24h" && window !== "7d") throw new UsageError("--window must be 24h or 7d.", context.usage);
    const report = await context.client().usage({ window: window as UsageWindow, ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) {
      context.print.json(report);
      return EXIT_OK;
    }
    const classes = (counts: Readonly<Record<string, number>>) =>
      Object.entries(counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([status, count]) => `${status} ${count}`)
        .join("  ");
    context.print.out(`${report.keyId} (${report.tier}), last ${report.window}: ${report.totals.requests} requests  ${classes(report.totals.byStatusClass)}`.trimEnd());
    context.print.out(`rate limit: ${report.rateLimit.remaining}/${report.rateLimit.limit} left in this ${report.rateLimit.windowSeconds}s window`);
    context.print.out(`intents: ${report.intents.created} created  ${classes(report.intents.byStatus)}`.trimEnd());
    if (report.byRoute.length > 0) {
      context.print.out("");
      context.print.out(table(report.byRoute.map((route) => [route.route, String(route.requests), classes(route.byStatusClass)]), ["route", "requests", "status"]));
    }
    return EXIT_OK;
  },
};

const errors: Command = {
  name: "errors",
  summary: "The error catalog, or one code with its remedy.",
  args: "[<CODE>]",
  positionals: { min: 0, max: 1 },
  run: async (context) => {
    const catalog = await context.client().errors({ ...(context.signal ? { signal: context.signal } : {}) });
    const wanted = context.positionals[0]?.toUpperCase();
    if (wanted) {
      const family = catalog.families.find((entry) => wanted.endsWith(entry.pattern.replace("<PROVIDER>", "")));
      const entry = catalog.errors.find((row) => row.code === wanted) ?? catalog.errors.find((row) => row.code === family?.code);
      if (!entry) {
        context.print.err(`${wanted} is not in the catalog.`);
        return EXIT_ERROR;
      }
      if (context.json) context.print.json(entry);
      else {
        context.print.out(`${entry.code}${entry.code !== wanted ? ` (for ${wanted})` : ""}: ${entry.title}`);
        context.print.out(`status ${entry.status ?? "step failure"}  category ${entry.category}  retryable ${entry.retryable ? "yes" : "no"}`);
        context.print.out(entry.remedy);
        context.print.out(entry.docs);
      }
      return EXIT_OK;
    }
    if (context.json) context.print.json(catalog);
    else {
      context.print.out(
        table(
          catalog.errors.map((row) => [row.code, row.status === null ? "step" : String(row.status), row.retryable ? "retry" : "", row.title]),
          ["code", "status", "", "title"],
        ),
      );
    }
    return EXIT_OK;
  },
};

const openapi: Command = {
  name: "openapi",
  summary: "Print the OpenAPI 3.1 document.",
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    context.print.json(await context.client().openApi({ ...(context.signal ? { signal: context.signal } : {}) }));
    return EXIT_OK;
  },
};

export const COMMANDS: readonly Command[] = Object.freeze([
  health,
  networks,
  protocols,
  assets,
  venues,
  quote,
  plan,
  intentsGet,
  intentsList,
  intentsWatch,
  ...PREVIEW_COMMANDS,
  ...RECEIPT_COMMANDS,
  keysCreate,
  keysList,
  keysRotate,
  keysRevoke,
  ...POLICY_COMMANDS,
  webhooksList,
  webhooksCreate,
  webhooksDelete,
  webhooksTest,
  webhooksDeliveries,
  webhooksVerify,
  webhooksForward,
  ...CONTRACT_COMMANDS,
  ...LINK_COMMANDS,
  usage,
  errors,
  openapi,
]);
