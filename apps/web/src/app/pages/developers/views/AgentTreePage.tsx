import AgentTreePanel from "../agents/AgentTreePanel";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";

/** Agents (`/developers/agent-tree`): sub-agent requests to decide, the agent tree with caps and use, revoke and pause. */
export default function AgentTreePage() {
  return (
    <>
      <PortalPageHeader
        title="Agents"
        intro={
          <>
            An agent whose rule book grants <code className="font-code">createChildKeys</code> can ask for sub-agents. Nothing is minted until you
            approve: with this project key, or by signing with the wallet that owns the project. A sub-agent never gets more than its parent, and
            its spending counts against every parent's caps.
          </>
        }
      />
      <KeyGate purpose="decide sub-agent requests, see every agent's caps and use, and pause or revoke agents" agentKeys>
        <AgentTreePanel />
      </KeyGate>
    </>
  );
}
