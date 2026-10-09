/**
 * `kletia links …`: intent links (`lk_…`, served at `<web>/go/<id>`), a
 * fixed destination anyone can fund from the networks and assets you allow.
 * Definitions are checked locally with `validateLinkDefinition` before
 * anything is sent; `create --dry-run` stops after the local check and a
 * representative dry-run plan (nothing is stored). Visitors sign on the page;
 * the CLI never prepares, signs or submits anything.
 */
import { open } from "node:fs/promises";
import {
  CHAINS,
  LinkExpansionError,
  expandLink,
  isLinkId,
  linkDestinationAsset,
  linkFundingOptions,
  type AccountId,
  type IntentActionSpec,
  type LinkDefinition,
  type LinkOwnerView,
  type LinkPins,
  type LinkView,
  validateLinkDefinition,
} from "@kletia/core";
import { listOption, stringOption, UsageError, type OptionSpec } from "./args.js";
import { accountId, CONFIRM_OPTION, EXIT_OK, positional, signalOption, type Command, type CommandContext } from "./common.js";
import { readJson, refusedLocally } from "./contracts.js";
import { amount, table, when } from "./output.js";
import { formatFare } from "./preview.js";

function linkId(context: CommandContext): string {
  const id = positional(context, 0);
  if (!isLinkId(id)) throw new UsageError(`"${id}" is not a link id (lk_ followed by 24 hex characters).`, context.usage);
  return id;
}

function isOwnerView(view: LinkView | LinkOwnerView): view is LinkOwnerView {
  return "definition" in view;
}

function boundsText(view: LinkView): string {
  const funding = view.funding.amount;
  if (funding.mode === "deliver") return "deliver (fixed amount)";
  return Object.entries(funding.bounds).map(([symbol, bounds]) => `${symbol} ${amount(bounds.min)}-${amount(bounds.max)}`).join(", ");
}

function printLink(context: CommandContext, view: LinkView | LinkOwnerView): void {
  const status = view.status === "pending" && view.activatesAt ? `pending until ${when(view.activatesAt)}` : view.status;
  context.print.out(`${view.id}  ${status}  revision ${view.revision}  "${view.title}"`);
  context.print.out(`publisher ${view.publisher.name}${view.publisher.domain ? ` (${view.publisher.domain}, ${view.publisher.domainVerified ? "domain verified" : "domain not verified"})` : ""}`);
  context.print.out(`destination ${view.destination.actions.map((action) => `${action.label} on ${action.network}`).join(", ")} → ${view.destination.asset.symbol} on ${view.destination.network}`);
  for (const recipient of view.fixed.recipients) context.print.out(`fixed recipient ${recipient.name ? `${recipient.name} = ` : ""}${recipient.address} on ${recipient.network}`);
  for (const contract of view.fixed.contracts) context.print.out(`fixed contract ${contract.label} ${contract.address} on ${contract.network}`);
  context.print.out(`funding ${view.funding.networks.join(", ")} with ${view.funding.assets.join(", ")}: ${boundsText(view)}`);
  context.print.out(`uses ${view.uses.max === null ? "unlimited" : `${view.uses.left ?? "?"} of ${view.uses.max} left`}${view.perAccount ? `, ${view.perAccount.maxUses} per account` : ""}  expires ${when(view.expiresAt)}`);
  context.print.out(`blink ${view.blink.enabled ? "enabled" : `off${view.blink.reason ? ` (${view.blink.reason})` : ""}`}`);
  context.print.out(`page ${view.urls.page}`);
  context.print.out(`card ${view.urls.card}`);
  if (isOwnerView(view)) {
    if (view.pausedReason) context.print.out(`paused: ${view.pausedReason}`);
    if (view.suspendedReason) context.print.out(`suspended: ${view.suspendedReason}`);
    if (view.stats) context.print.out(`last 7 days: ${Object.entries(view.stats).map(([metric, value]) => `${metric} ${value}`).join("  ") || "no activity"}`);
  }
  for (const notice of view.notices) context.print.err(`notice: ${notice}`);
}

/**
 * Pins as the API would make them, without resolving anything: recipients
 * as written (names stay names; the planner resolves them in the dry run) and
 * contract references as written. Only for the local dry run.
 */
function localPins(definition: LinkDefinition): LinkPins | null {
  const destinationAsset = linkDestinationAsset(definition);
  if (!destinationAsset) return null;
  const recipients: { action: number; account: AccountId }[] = [];
  const contracts: LinkPins["contracts"][number][] = [];
  definition.destination.actions.forEach((action, index) => {
    if (action.recipient !== undefined) recipients.push({ action: index, account: action.recipient as AccountId });
    if ((action.kind === "call" || action.kind === "action") && action.contract) contracts.push({ action: index, contract: action.contract, revision: 0, definitionHash: "", entry: action.entry ?? "", target: "" });
  });
  return { recipients, contracts, destinationAsset };
}

/** Placeholder accounts for a dry run (one per VM), as the API's representative plan uses. */
function placeholders(actions: readonly IntentActionSpec[]): AccountId[] {
  const networks = actions.flatMap((action) => [action.network, ...(action.toNetwork ? [action.toNetwork] : [])]);
  const evm = networks.find((network) => CHAINS[network].vm === "evm");
  const svm = networks.find((network) => CHAINS[network].vm === "svm");
  return [
    ...(evm ? [`${CHAINS[evm].id}:0x000000000000000000000000000000000000c0de` as AccountId] : []),
    ...(svm ? [`${CHAINS[svm].id}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId] : []),
  ];
}

const linksCreate: Command = {
  name: "links create",
  summary: "Create an intent link from a JSON definition (checked locally first); --dry-run plans a representative intent and stores nothing.",
  args: "--file <link.json> [--dry-run]",
  options: {
    file: { type: "string", value: "<path>", description: "The link definition (JSON; `-` reads stdin)." },
    "dry-run": { type: "boolean", description: "Validate and plan one representative intent; nothing is created." },
    account: { type: "string", multiple: true, value: "<account>", description: "Dry run: plan for these accounts instead of placeholders (repeatable)." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const input = await readJson(context, stringOption(context.values, "file"));
    const checked = validateLinkDefinition(input);
    if (!checked.ok) throw refusedLocally(checked.code, "The link definition is invalid", checked.issues);
    const definition = checked.value;
    if (context.values["dry-run"] === true) {
      const pins = localPins(definition);
      const option = linkFundingOptions(definition.funding)[0];
      if (!pins || !option) {
        context.print.out("The definition is valid. A custom-contract destination is pinned by the API at creation, so no local dry run is planned.");
        return EXIT_OK;
      }
      const bounds = definition.funding.amount.mode === "input" ? definition.funding.amount.bounds[option.symbol] : undefined;
      let expansion;
      try {
        expansion = expandLink({ definition, pins }, { network: option.network, asset: option.symbol, ...(bounds ? { amount: bounds.default ?? bounds.min } : {}) });
      } catch (error) {
        if (error instanceof LinkExpansionError) throw refusedLocally(error.code, error.message, error.issues);
        throw error;
      }
      const accounts = listOption(context.values, "account").map((value) => accountId(value, context.usage));
      const result = await context.client().intents.create(
        { actions: [...expansion.actions], accounts: accounts.length > 0 ? accounts : placeholders(expansion.actions), ...(definition.constraints ? { constraints: definition.constraints } : {}) },
        { dryRun: true, preview: true, ...signalOption(context) },
      );
      if (context.json) context.print.json({ valid: true, definition, expansion: { case: expansion.case, actions: expansion.actions }, intent: result.intent, preview: result.preview });
      else {
        context.print.out(`valid; representative choice ${option.symbol} on ${option.network} (${expansion.case}): ${result.intent.summary.title}`);
        if (result.preview) context.print.out(formatFare(result.preview));
        context.print.err("Dry run: nothing was created. Run without --dry-run to publish the link.");
      }
      return EXIT_OK;
    }
    if (!context.hasApiKey) throw new UsageError("kletia links create needs an API key: set KLETIA_API_KEY.", context.usage);
    const { link } = await context.client().links.create(input, signalOption(context));
    if (context.json) context.print.json(link);
    else {
      printLink(context, link);
      context.print.err(`Verify the domain by listing this link in ${link.publisher.website ?? "your website"}/.well-known/kletia.json ({ "links": ["${link.id}"] }).`);
    }
    return EXIT_OK;
  },
};

const linksList: Command = {
  name: "links list",
  summary: "Your links.",
  key: true,
  options: { status: { type: "string", value: "<status>", description: "pending, active, paused, suspended or deleted." } },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const status = stringOption(context.values, "status");
    if (status !== undefined && !["pending", "active", "paused", "suspended", "deleted"].includes(status)) throw new UsageError("--status must be pending, active, paused, suspended or deleted.", context.usage);
    const links = await context.client().links.list(status ? { status: status as "active" } : {}, signalOption(context));
    if (context.json) context.print.json(links);
    else context.print.out(table(links.map((link) => [link.id, link.status, link.uses.max === null ? "-" : `${link.uses.left ?? "?"}/${link.uses.max}`, when(link.expiresAt), link.title]), ["link", "status", "uses left", "expires", "title"]));
    return EXIT_OK;
  },
};

const linksGet: Command = {
  name: "links get",
  summary: "A link (the owner view with your key: definition, pins, 7-day stats).",
  args: "<link id>",
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const view = await context.client().links.get(linkId(context), signalOption(context));
    if (context.json) context.print.json(view);
    else printLink(context, view);
    return EXIT_OK;
  },
};

const linksPause: Command = {
  name: "links pause",
  summary: "Pause a link (visitors who already funded a step can still finish).",
  args: "<link id>",
  key: true,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const view = await context.client().links.pause(linkId(context), signalOption(context));
    if (context.json) context.print.json(view);
    else context.print.out(`${view.id} ${view.status}.`);
    return EXIT_OK;
  },
};

const linksResume: Command = {
  name: "links resume",
  summary: "Resume a paused link; --accept re-pins a changed recipient or contract (a new revision).",
  args: "<link id> [--accept recipient_changed|contract_changed]",
  key: true,
  options: { accept: { type: "string", multiple: true, value: "<reason>", description: "recipient_changed or contract_changed (repeatable)." } },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const accept = listOption(context.values, "accept");
    for (const reason of accept) if (reason !== "recipient_changed" && reason !== "contract_changed") throw new UsageError("--accept takes recipient_changed or contract_changed.", context.usage);
    const view = await context.client().links.resume(linkId(context), { accept: accept as ("recipient_changed" | "contract_changed")[] }, signalOption(context));
    if (context.json) context.print.json(view);
    else context.print.out(`${view.id} ${view.status === "pending" && view.activatesAt ? `pending until ${when(view.activatesAt)}` : view.status} (revision ${view.revision}).`);
    return EXIT_OK;
  },
};

const linksDelete: Command = {
  name: "links delete",
  summary: "Withdraw a link (its page answers 410).",
  args: "<link id> --yes",
  key: true,
  options: CONFIRM_OPTION,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    if (context.values.yes !== true) throw new UsageError("A withdrawn link cannot be restored; pass --yes.", context.usage);
    const id = linkId(context);
    await context.client().links.delete(id, signalOption(context));
    if (context.json) context.print.json({ deleted: id });
    else context.print.out(`Withdrew ${id}.`);
    return EXIT_OK;
  },
};

const linksStats: Command = {
  name: "links stats",
  summary: "Additive counters of a link (nothing per visitor).",
  args: "<link id> [--window 7d|30d|90d]",
  key: true,
  options: { window: { type: "string", value: "7d|30d|90d", description: "Default 7d." } },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const window = stringOption(context.values, "window");
    if (window !== undefined && !["7d", "30d", "90d"].includes(window)) throw new UsageError("--window must be 7d, 30d or 90d.", context.usage);
    const stats = await context.client().links.stats(linkId(context), window ? { window: window as "7d" } : {}, signalOption(context));
    if (context.json) context.print.json(stats);
    else {
      context.print.out(`${stats.linkId}, last ${stats.window}: ${Object.entries(stats.totals).map(([metric, value]) => `${metric} ${value}`).join("  ") || "no activity"}`);
      const rate = (value: number | null) => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
      context.print.out(`intents per page view ${rate(stats.conversion.intentPerPageView)}, completed per intent ${rate(stats.conversion.completedPerIntent)}`);
      if (stats.bySource.length > 0) context.print.out(table(stats.bySource.map((row) => [row.source, String(row.intent ?? 0), String(row.completed ?? 0), row.volumeUsd ?? "-"]), ["source", "intents", "completed", "volume usd"]));
    }
    return EXIT_OK;
  },
};

const linksCard: Command = {
  name: "links card",
  summary: "Save a link's share card as PNG.",
  args: "<link id> --out <card.png> [--variant square]",
  options: {
    out: { type: "string", value: "<path>", description: "PNG file to write (must not exist)." },
    variant: { type: "string", value: "wide|square", description: "1200×600 (default) or 600×600." },
  } satisfies Record<string, OptionSpec>,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const out = stringOption(context.values, "out");
    if (!out) throw new UsageError("--out <card.png> is required.", context.usage);
    const variant = stringOption(context.values, "variant") ?? "wide";
    if (variant !== "wide" && variant !== "square") throw new UsageError("--variant must be wide or square.", context.usage);
    const id = linkId(context);
    const png = await context.client().links.card(id, { variant }, signalOption(context));
    let handle;
    try {
      handle = await open(out, "wx", 0o644);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new UsageError(code === "EEXIST" ? `${out} already exists; choose a new file.` : `Cannot create ${out} (${code ?? "error"}).`, context.usage);
    }
    try {
      await handle.writeFile(png);
    } finally {
      await handle.close();
    }
    if (context.json) context.print.json({ written: out, bytes: png.length, variant });
    else context.print.out(`Wrote ${out} (${png.length} bytes, ${variant}).`);
    return EXIT_OK;
  },
};

const linksOpen: Command = {
  name: "links open",
  summary: "Print a link's page URL.",
  args: "<link id>",
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const url = context.client().links.pageUrl(linkId(context));
    if (context.json) context.print.json({ url });
    else context.print.out(url);
    return EXIT_OK;
  },
};

export const LINK_COMMANDS: readonly Command[] = Object.freeze([linksCreate, linksList, linksGet, linksPause, linksResume, linksDelete, linksStats, linksCard, linksOpen]);
