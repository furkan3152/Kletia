import RuleBookPanel from "../rulebook/RuleBookPanel";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";

/** Rule Book (`/developers/rule-book`): today's Rule Book panel under the portal header and key gate. */
export default function RuleBookPage() {
  return (
    <>
      <PortalPageHeader
        title="Rule Book"
        intro={
          <>
            Bound what Kletia plans and prepares for each key: networks, assets, recipients, caps per step, intent, day and week, a timetable
            and approvals. Give an agent its own <code className="font-code">kl_agt_</code> key with its own rule book. Tightening applies at
            once; loosening waits the delay you set. Kletia still never signs.
          </>
        }
      />
      <KeyGate purpose="read and edit rule books, run the simulator, read the decision log and issue agent keys" agentKeys>
        <RuleBookPanel />
      </KeyGate>
    </>
  );
}
