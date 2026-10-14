import { LinkDetailPage } from "../links/LinkDetailPage";
import { LINK_ID } from "../links/linkRows";
import { LinksListPage } from "../links/LinksListPage";
import { NewLinkPage } from "../links/NewLinkPage";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import type { PortalPageProps } from "../shell/portalRoutes";
import { ButtonLink } from "../../../site/ui/Button";

/**
 * Intent links (`/developers/links`, `/new`, `/:linkId`): the links as table
 * rows, the builder and one link's page (portal design 4.4.6).
 */
export default function LinksPage({ param, search }: PortalPageProps) {
  if (param === null) return <LinksListPage search={search} />;
  if (param === "new") return <NewLinkPage />;
  if (LINK_ID.test(param)) return <LinkDetailPage key={param} linkId={param} />;
  return (
    <>
      <PortalPageHeader title="No link here" back={{ label: "Links", to: "/developers/links" }} />
      <p className="pb-4 text-sm">Link ids look like lk_ followed by 24 hex characters.</p>
      <ButtonLink to="/developers/links" variant="secondary" size="sm" className="self-start">
        Back to the links
      </ButtonLink>
    </>
  );
}
