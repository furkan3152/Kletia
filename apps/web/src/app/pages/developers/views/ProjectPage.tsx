import { ProjectPanel } from "../project/ProjectPanel";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";

/**
 * Project settings (`/developers/project`): brand and domain proof,
 * allowed origins, widget defaults, publishable keys, stored flows
 * and the logo. Agent keys read it; developer keys change it.
 */
export default function ProjectPage() {
  return (
    <>
      <PortalPageHeader
        title="Project settings"
        intro="Your project's brand and domain, the origins allowed to use its publishable keys, widget defaults, stored flows and the logo. A static site can then run Kletia with a browser-safe publishable key alone."
      />
      <KeyGate purpose="read and change your project's settings" agentKeys>
        <ProjectPanel />
      </KeyGate>
    </>
  );
}
