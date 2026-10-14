import { useState } from "react";

import RuleBookPanel from "../rulebook/RuleBookPanel";
import { parseRuleBookQuery, serializeRuleBookQuery, type RuleBookQuery } from "../rulebook/ruleBookQuery";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import type { PortalPageProps } from "../shell/portalRoutes";

/**
 * Writes `?key=&view=` back to the address without a router navigation:
 * no history entry per click and no focus jump to the page heading.
 */
function replaceQuery(query: RuleBookQuery): void {
  const search = serializeRuleBookQuery(query);
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
}

/** Rule Book (`/developers/rule-book?key=&view=`): the key tree, each key's rules, the simulator, the decision log and agent keys. */
export default function RuleBookPage({ search }: PortalPageProps) {
  // Read once: the panel owns the choice afterwards and writes it back.
  const [initial] = useState(() => parseRuleBookQuery(search));
  return (
    <>
      <PortalPageHeader
        title="Rule Book"
        intro={
          <>
            Bound what Kletia plans and prepares for each key: networks, assets, recipients, caps per step, intent, day and week, a timetable
            and approvals. Give an agent its own <code className="font-code">kl_agt_</code> key with its own rule book. Tightening applies at
            once; loosening waits the delay you set.
          </>
        }
      />
      <KeyGate purpose="read and edit rule books, simulate requests, read the decision log and issue agent keys" agentKeys>
        <RuleBookPanel initialKey={initial.key} initialView={initial.view} onQueryChange={replaceQuery} />
      </KeyGate>
    </>
  );
}
