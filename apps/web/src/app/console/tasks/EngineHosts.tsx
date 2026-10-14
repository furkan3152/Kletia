/**
 * Mounts one network engine per network that has an engine task (and the
 * stored-workflow resume when one exists), inside the lazily loaded legacy
 * chunk, and publishes each engine to the task bodies (`engineRegistry`).
 * Renders nothing itself.
 */
import { lazy, Suspense, useLayoutEffect } from "react";

import type { LegacyEngine } from "../legacy";
import type { LegacyNetwork } from "../state/deskModel";
import { publishEngine } from "./engineRegistry";

const LegacyEngineHost = lazy(() => import("../legacy"));
const LegacyWorkflowResume = lazy(() => import("../legacy").then((module) => ({ default: module.LegacyWorkflowResume })));

function Publish({ network, engine }: { readonly network: LegacyNetwork; readonly engine: LegacyEngine }) {
  // Every render: the engine object changes with its state, and its task bodies read it.
  useLayoutEffect(() => {
    publishEngine(network, engine);
  });
  useLayoutEffect(() => () => publishEngine(network, null), [network]);
  return null;
}

export interface EngineHostsProps {
  readonly networks: readonly LegacyNetwork[];
  readonly resumeWorkflow: boolean;
  /** The engine asked to edit the sentence instead of allowing AI interpretation. */
  readonly onEditPrompt: (prompt: string, network: LegacyNetwork) => void;
  /** The engine asked to open one of its modules (a tool in the desk). */
  readonly onOpenTool: (toolId: string) => void;
}

/** The old console's module tabs and the desk tool that replaces each. */
const TOOL_FOR_TAB: Readonly<Record<string, string>> = Object.freeze({
  x402: "x402",
  allora: "allora",
  basename: "basenames",
  airdrop: "airdrop-check",
  webacy: "address-risk",
  arc: "arc-contracts",
  lending: "arc-lending",
});

export function EngineHosts({ networks, resumeWorkflow, onEditPrompt, onOpenTool }: EngineHostsProps) {
  return (
    <Suspense fallback={null}>
      {networks.map((network) => (
        <LegacyEngineHost
          key={network}
          network={network}
          onEditPrompt={(prompt) => onEditPrompt(prompt, network)}
          onOpenWidget={(tab) => {
            const toolId = TOOL_FOR_TAB[tab];
            if (toolId) onOpenTool(toolId);
          }}
        >
          {(engine) => <Publish network={network} engine={engine} />}
        </LegacyEngineHost>
      ))}
      {resumeWorkflow ? <LegacyWorkflowResume /> : null}
    </Suspense>
  );
}
