import type { ApiKeySummary } from "@kletia/sdk";

import { SelectField } from "../../../site/ui/Field";
import type { TreeNode } from "./policyModel";

export interface KeyPickerProps {
  /** The key tree (project keys with their agent keys under them). */
  readonly nodes: readonly TreeNode<ApiKeySummary>[];
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  readonly className?: string;
}

function flatten(nodes: readonly TreeNode<ApiKeySummary>[], depth = 0): { readonly id: string; readonly label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.key.id, label: `${" ".repeat(depth)}${node.key.name}${node.key.kind === "agent" ? " (agent key)" : ""}${node.key.current ? " (loaded)" : ""}` },
    ...flatten(node.children, depth + 1),
  ]);
}

/**
 * "Editing: payouts-bot" on narrow screens: the same choice as the key
 * tree, as one select, so the tree does not stack above the book. Agent
 * keys are indented under their parent.
 */
export function KeyPicker({ nodes, selected, onSelect, className }: KeyPickerProps) {
  const options = [{ value: "project", label: "The project (bounds every key)" }, ...flatten(nodes).map((entry) => ({ value: entry.id, label: entry.label }))];
  return (
    <SelectField
      label="Editing"
      value={selected}
      onChange={(event) => onSelect(event.target.value)}
      options={options}
      containerClassName={className}
    />
  );
}
