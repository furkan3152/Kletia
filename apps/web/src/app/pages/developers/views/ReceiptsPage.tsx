import ReceiptsGuide from "../receipts/ReceiptsGuide";
import { PortalPageHeader } from "../shell/PortalPageHeader";

/** Receipts (`/developers/receipts`): how to check a receipt, the public keys and the transparency log. No key needed. */
export default function ReceiptsPage() {
  return (
    <>
      <PortalPageHeader
        title="Receipts"
        intro="Every finished intent gets a receipt Kletia signs once its transactions are final. Check it offline, re-read the chain yourself, and trust a key only when two origins agree."
      />
      <ReceiptsGuide />
    </>
  );
}
