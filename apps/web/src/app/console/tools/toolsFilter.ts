/**
 * The Tools view's filter and its honest note for a network no tool is built
 * for (Ethereum, OP Mainnet and Polygon today): the network still works from
 * the composer, and the tools for every network stay listed below the note.
 */
import type { NetworkKey } from "@kletia/core";

import type { DeskTool, ToolKind } from "./catalogue";

export interface ToolsFilter {
  readonly network: NetworkKey | "all";
  readonly kind: ToolKind | "all";
  readonly query: string;
}

/** The tools a filter shows: tools without networks work on every network. */
export function filterTools(tools: readonly DeskTool[], filter: ToolsFilter): DeskTool[] {
  const needle = filter.query.trim().toLowerCase();
  return tools.filter(
    (tool) =>
      (filter.network === "all" || tool.networks.length === 0 || tool.networks.includes(filter.network)) &&
      (filter.kind === "all" || tool.kind === filter.kind) &&
      (!needle || `${tool.title} ${tool.summary}`.toLowerCase().includes(needle)),
  );
}

/**
 * "general" when only the every-network tools are left for the chosen network,
 * "none" when nothing is left at all, null when a tool is built for it or the
 * kind or search filters (not the network) explain the result.
 */
export function networkToolNote(visible: readonly DeskTool[], filter: ToolsFilter): "general" | "none" | null {
  if (filter.network === "all" || filter.kind !== "all" || filter.query.trim()) return null;
  const network = filter.network;
  if (visible.some((tool) => tool.networks.includes(network))) return null;
  return visible.length > 0 ? "general" : "none";
}
