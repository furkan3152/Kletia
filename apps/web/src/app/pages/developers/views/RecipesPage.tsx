import { RecipesSection } from "../RecipesSection";
import { AnchorScope } from "../shell/AnchorScope";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import type { PortalPageProps } from "../shell/portalRoutes";

/**
 * Recipes (`/developers/recipes`, `/developers/recipes/<id>`): copy-ready
 * integrations. The recipe picker still opens a recipe from its
 * `#recipe-` anchor, so the path's id is handed to it as one.
 */
export default function RecipesPage({ param }: PortalPageProps) {
  return (
    <>
      <PortalPageHeader
        title="Recipes"
        intro="Copy-ready integrations for the SDK, the React widget and hooks, the embed, the Rule Book, custom contracts, links, receipts, MCP clients and the CLI. Secrets always come from the environment."
      />
      <AnchorScope hash={param ? `#recipe-${param}` : null}>
        <RecipesSection />
      </AnchorScope>
    </>
  );
}
