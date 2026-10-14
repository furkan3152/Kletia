import type { PortalPageProps } from "../shell/portalRoutes";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { NewWebhookPage } from "../webhooks/NewWebhookPage";
import { WebhookPage } from "../webhooks/WebhookPage";
import { WEBHOOK_ID } from "../webhooks/webhookModel";
import { WebhooksListPage } from "../webhooks/WebhooksListPage";
import { ButtonLink } from "../../../site/ui/Button";

/**
 * Webhooks (`/developers/webhooks`, `/new`, `/:webhookId`): the list, the
 * add form and one endpoint's page with its delivery log.
 */
export default function WebhooksPage({ param }: PortalPageProps) {
  if (param === null) return <WebhooksListPage />;
  if (param === "new") return <NewWebhookPage />;
  if (WEBHOOK_ID.test(param)) return <WebhookPage webhookId={param} />;
  return (
    <>
      <PortalPageHeader title="No webhook here" back={{ label: "Webhooks", to: "/developers/webhooks" }} />
      <p className="pb-4 text-sm">Webhook ids look like wh_ followed by 24 hex characters.</p>
      <ButtonLink to="/developers/webhooks" variant="secondary" size="sm" className="self-start">
        Back to the endpoints
      </ButtonLink>
    </>
  );
}
