import { Link } from "../../../routes/Link";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { PortalPageHeader } from "./PortalPageHeader";
import { PORTAL_GROUPS, PORTAL_PAGES } from "./portalRoutes";

/** The portal's "No page here" state: an unknown /developers path, inside the shell and never indexed. */
export default function PortalMissing() {
  return (
    <>
      <PortalPageHeader
        title="No page here"
        intro="This developer portal page does not exist, or it moved when the portal got a page per tool. Every section is listed below and in the sidebar."
      />
      <section aria-labelledby="missing-sections" className={cx("p-5 sm:p-6", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <h2 id="missing-sections" className="font-display text-title font-bold">
          Portal sections
        </h2>
        <div className="mt-4 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {PORTAL_GROUPS.map((group) => (
            <div key={group.id} className="flex min-w-0 flex-col gap-2">
              <h3 className={cx(LABEL, TEXT_MUTED)}>{group.label}</h3>
              <ul className="flex flex-col gap-1">
                {PORTAL_PAGES.filter((page) => page.group === group.id).map((page) => (
                  <li key={page.id}>
                    <Link to={page.path} className={cx("inline-flex min-h-10 items-center font-bold underline decoration-2 underline-offset-4", FOCUS_RING)}>
                      {page.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
