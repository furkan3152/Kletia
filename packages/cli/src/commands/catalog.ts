/**
 * Read-only catalog commands: health, networks, protocols, assets, venues
 * and quote.
 */
import type { ProtocolId } from "@kletia/core";
import type { QuoteRequest } from "@kletia/sdk";
import { integerOption, stringOption, UsageError } from "../args.js";
import {
  accountId,
  EXIT_ERROR,
  EXIT_OK,
  networkKey,
  positional,
  type Command,
} from "../common.js";
import { amount, table } from "../output.js";
import { formatAmount, seconds, usd } from "./shared.js";

/* --------------------------------------------------------------- commands */

export const health: Command = {
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

export const networks: Command = {
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

export const protocols: Command = {
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

export const assets: Command = {
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

export const venues: Command = {
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

export const quote: Command = {
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
