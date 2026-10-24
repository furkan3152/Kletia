/**
 * What the portfolio read does not cover (`GET /v1/data/positions?extras=true`;
 * Kamino loans are part of the portfolio itself, lending.ts):
 *
 * - perps positions (perps service: GMX v2 and Hyperliquid per EVM address,
 *   Drift per Solana address; mainnet only);
 * - open native orders (orders service: CoW Protocol, Jupiter Trigger and
 *   Recurring);
 * - the caller's automations (wallet session or API key) and, for an API
 *   key, the 24 h / 7 d spend of every agent key below it.
 *
 * Each section is read on its own; a failed one keeps its rows empty with
 * the reason, never pretends there is nothing.
 */
import {
  CHAINS,
  formatAccountId,
  type AutomationOwner,
  type DataAgentSpendRow,
  type DataAutomationRow,
  type DataCoverageExtras,
  type DataOrderRow,
  type DataPerpRow,
  type DataSection,
  type DataWalletSet,
} from "@kletia/core";
import { listAutomations } from "../automation/service.js";
import { toPlatformError } from "../errors.js";
import type { AuthContext } from "../http/context.js";
import { subtreeUsage } from "../http/policies/usage.js";
import { listNativeOrders } from "../orders/service.js";
import { readPerpsPositions } from "../perps/service.js";

export interface ExtrasCaller {
  /** The automation owner: an API key or a desk wallet session; null for public reads. */
  readonly automationOwner: AutomationOwner | null;
  /** The API key's auth (agent spend of its subtree); null otherwise. */
  readonly keyAuth: AuthContext | null;
}

function section<T>(source: DataSection<T>["source"], rows: readonly T[], reason: string | null): DataSection<T> {
  return { rows, reason, source, asOf: new Date().toISOString() };
}

function failed<T>(source: DataSection<T>["source"], error: unknown, what: string): DataSection<T> {
  const platform = toPlatformError(error);
  return { rows: [], reason: `${what} could not be read (${platform.code}).`, source, asOf: null };
}

async function perpsSection(set: DataWalletSet): Promise<DataSection<DataPerpRow>> {
  if (set.lane !== "production") return section("perps", [], "Perps venues run on mainnet only.");
  const accounts = [...set.evm.map((address) => formatAccountId(CHAINS.arbitrum, address)), ...set.solana.map((address) => formatAccountId(CHAINS.solana, address))];
  const reads = await Promise.all(accounts.map((account) => readPerpsPositions(account).then((view) => ({ account, view }))));
  const rows = reads.flatMap(({ account, view }) => view.positions.map((position): DataPerpRow => ({ ...position, account })));
  const gaps = reads.flatMap(({ view }) => view.unavailable.map((entry) => `${entry.venue}: ${entry.message}`));
  const unsupported = reads.reduce((total, { view }) => total + view.unsupported, 0);
  const reasons = [...gaps, ...(unsupported > 0 ? [`${unsupported} GMX position(s) in markets Kletia does not list are not shown.`] : [])];
  return section("perps", rows, reasons.length > 0 ? reasons.join(" ") : null);
}

async function ordersSection(set: DataWalletSet): Promise<DataSection<DataOrderRow>> {
  if (set.lane !== "production") return section("orders", [], "Native orders run on mainnet only.");
  const { orders, failures } = await listNativeOrders([...set.evm, ...set.solana]);
  const rows = orders
    .filter((order) => order.status === "open")
    .map((order): DataOrderRow => ({
      id: order.id,
      protocol: order.protocol,
      network: order.network,
      owner: order.owner,
      status: order.status,
      sell: { symbol: order.sell.symbol, amount: order.sell.formatted },
      buy: order.buy ? { symbol: order.buy.symbol, amount: order.buy.formatted } : null,
      createdAt: order.createdAt,
    }));
  return section("orders", rows, failures.length > 0 ? failures.map((failure) => `${failure.protocol} on ${failure.network}: ${failure.message}`).join(" ") : null);
}

async function automationsSection(caller: ExtrasCaller): Promise<DataSection<DataAutomationRow>> {
  if (!caller.automationOwner) return section("automations", [], "Automations are listed for their owner only: an API key or a wallet signed in on the desk.");
  const views = await listAutomations(caller.automationOwner);
  return section("automations", views.map((view): DataAutomationRow => ({
    id: view.id,
    label: view.label,
    trigger: view.trigger.kind,
    status: view.status,
    runs: view.runs,
    spentUsd: view.spentUsd,
    lastRunAt: view.lastRunAt,
    nextRunAt: view.nextRunAt,
  })), null);
}

async function agentSpendSection(caller: ExtrasCaller): Promise<DataSection<DataAgentSpendRow>> {
  if (!caller.keyAuth) return section("policy", [], "Agent key spend is shown to API keys only.");
  const usage = await subtreeUsage(caller.keyAuth, "24h");
  const rows = usage.keys
    .filter((key) => key.kind === "agent")
    .map((key): DataAgentSpendRow => ({ keyId: key.keyId, name: key.name, kind: key.kind, dayUsd: key.notional.dayUsd, weekUsd: key.notional.weekUsd }));
  return section("policy", rows, usage.truncated ? "Only the 100 newest keys are listed." : null);
}

/** Every extra section of the set, each read independently. */
export async function readExtras(set: DataWalletSet, caller: ExtrasCaller): Promise<DataCoverageExtras> {
  const [perps, orders, automations, agentSpend] = await Promise.all([
    perpsSection(set).catch((error: unknown) => failed<DataPerpRow>("perps", error, "Perps positions")),
    ordersSection(set).catch((error: unknown) => failed<DataOrderRow>("orders", error, "Native orders")),
    automationsSection(caller).catch((error: unknown) => failed<DataAutomationRow>("automations", error, "Automations")),
    agentSpendSection(caller).catch((error: unknown) => failed<DataAgentSpendRow>("policy", error, "Agent key spend")),
  ]);
  return { perps, orders, automations, agentSpend };
}
