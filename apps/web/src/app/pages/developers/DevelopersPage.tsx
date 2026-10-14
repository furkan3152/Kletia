import PortalShell from "./shell/PortalShell";

/**
 * The developer portal: one `developers` route for every /developers path.
 * The shell (bar, sidebar, key menu, legacy redirects) stays mounted and
 * swaps one lazy page per path; pages live in ./views and mount there, so
 * this file never changes again.
 */
export default function DevelopersPage() {
  return <PortalShell />;
}
