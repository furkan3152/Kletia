import { PageHeader, type PageHeaderProps } from "../../../site/ui/PageHeader";
import { usePortal } from "./portalContext";

/**
 * The page header every portal page uses: `PageHeader` whose H1 takes focus
 * after each client-side navigation inside the portal (the router announces
 * the page title; focus lands on the heading it names).
 */
export function PortalPageHeader(props: Omit<PageHeaderProps, "focusKey">) {
  const { headingFocusKey } = usePortal();
  return <PageHeader {...props} focusKey={headingFocusKey} />;
}
