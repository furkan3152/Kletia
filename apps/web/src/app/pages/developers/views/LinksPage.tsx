import LinksPanel from "../links/LinksPanel";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";

/** Intent links (`/developers/links`): today's links panel under the portal header and key gate. */
export default function LinksPage() {
  return (
    <>
      <PortalPageHeader
        title="Intent links"
        intro="Publish a page that does one fixed thing in the visitor's own wallet, from any network you allow. Pause it, read its counters and share its card. Counters never hold visitor data."
      />
      <KeyGate purpose="publish, pause and withdraw intent links and read their counters" agentKeys>
        <LinksPanel />
      </KeyGate>
    </>
  );
}
