import { ErrorsReference } from "../ErrorsReference";
import { PortalPageHeader } from "../shell/PortalPageHeader";

/** Errors (`/developers/errors`, anchors `#error-<CODE>`): the error catalog with search and filters. */
export default function ErrorsPage() {
  return (
    <>
      <PortalPageHeader
        title="Errors"
        intro={
          <>
            Every <code className="font-code">error.code</code> the API returns, and every step failure code, with whether a retry can help
            and what to do. The <code className="font-code">error.docs</code> link in an API error opens this page at its code.
          </>
        }
      />
      <ErrorsReference />
    </>
  );
}
