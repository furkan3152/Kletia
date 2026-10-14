import { BridgeAuction } from "../BridgeAuction";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { VenuesPanel } from "../VenuesPanel";

/** Venues and auction (`/developers/venues`): lending venues by id and how the planner picks a bridge. */
export default function VenuesPage() {
  return (
    <>
      <PortalPageHeader
        title="Venues and auction"
        intro="Pick a lending venue by id for deposits and withdrawals, and see how the planner chooses a bridge for every cross-network step."
      />
      <div className="flex min-w-0 flex-col gap-12">
        <VenuesPanel />
        <section aria-labelledby="auction-heading" className="flex min-w-0 flex-col gap-4">
          <h2 id="auction-heading" className="font-display text-display-s font-bold">
            The bridge auction
          </h2>
          <BridgeAuction />
        </section>
      </div>
    </>
  );
}
