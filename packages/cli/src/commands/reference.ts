/**
 * usage, errors and openapi.
 */
import type { UsageWindow } from "@kletia/sdk";
import { stringOption, UsageError } from "../args.js";
import { EXIT_ERROR, EXIT_OK, type Command } from "../common.js";
import { table } from "../output.js";

/* ------------------------------------------------------------------ misc */

export const usage: Command = {
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

export const errors: Command = {
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

export const openapi: Command = {
  name: "openapi",
  summary: "Print the OpenAPI 3.1 document.",
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    context.print.json(await context.client().openApi({ ...(context.signal ? { signal: context.signal } : {}) }));
    return EXIT_OK;
  },
};
