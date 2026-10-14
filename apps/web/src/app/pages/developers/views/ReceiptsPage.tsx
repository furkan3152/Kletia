import { CheckReceipt } from "../receipts/CheckReceipt";
import ReceiptsGuide from "../receipts/ReceiptsGuide";
import { PortalPageHeader } from "../shell/PortalPageHeader";

/** Receipts (`/developers/receipts`): check a receipt, how verification works, the public keys and the transparency log. No key needed. */
export default function ReceiptsPage() {
  return (
    <>
      <PortalPageHeader
        title="Receipts"
        intro="Every finished intent gets a receipt Kletia signs once its transactions are final. Check it yourself: offline, against the chain, and with a key two origins agree on."
      />
      <div className="flex min-w-0 flex-col gap-10">
        <CheckReceipt />
        <ReceiptsGuide />
      </div>
    </>
  );
}
