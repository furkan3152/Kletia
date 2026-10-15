import { ArrowRight, LogOut } from "lucide-react";
import { useState } from "react";

import { LineBullet } from "../../../site/art/LineBullet";
import { lineFor } from "../../../site/art/tokens";
import { Button } from "../../../site/ui/Button";
import { Card } from "../../../site/ui/Card";
import { Skeleton } from "../../../site/ui/Skeleton";
import { Stat } from "../../../site/ui/Stat";
import { StatusPill } from "../../../site/ui/StatusPill";
import { cx, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { toast } from "../../../site/ui/toast";
import { AdminApiError } from "../api/adminClient";
import { useAdmin, useAdminQuery } from "../api/useAdmin";
import { AdminError } from "../components/AdminError";
import { SectionHeader } from "../components/SectionHeader";
import { ADMIN_NO_PROGRAM_NETWORKS, isTestnet, networkName } from "../model/plan";
import { countdownText, sessionEndsAt, sessionKind, walletErrorText } from "../model/session";

/** The status board: networks × counts and warnings, the Safe queue and the services key. */
export function OverviewSection() {
  const { client, session, goTo, reportGateError } = useAdmin();
  const overview = useAdminQuery(["overview"], (api) => api.overview());
  const [leaving, setLeaving] = useState(false);
  const [openedAt] = useState(() => Date.now());
  const kind = sessionKind(session);
  const data = overview.data;
  const totals = data
    ? data.networks.reduce((sum, row) => ({ pinned: sum.pinned + row.pinned, verified: sum.verified + row.verified, deployable: sum.deployable + row.deployable }), { pinned: 0, verified: 0, deployable: 0 })
    : null;

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        icon="board"
        eyebrow="Overview"
        title="Every network at a glance"
        intro="Pinned contracts the product uses, new deployments verified from this panel, and what can still be deployed. Solana networks carry no Kletia programs."
      />
      {overview.error ? <AdminError error={overview.error} title="The overview could not load" onRetry={() => void overview.refetch()} /> : null}
      <dl className="grid gap-6 sm:grid-cols-3">
        <Stat label="Pinned contracts" value={totals ? totals.pinned : "…"} accent="#0B5E3A" />
        <Stat label="Verified new deployments" value={totals ? totals.verified : "…"} accent="#FFD60A" />
        <Stat label="Deployable targets" value={totals ? totals.deployable : "…"} accent="#0052FF" />
      </dl>

      <section aria-labelledby="admin-board-title" className={cx("min-w-0 overflow-x-auto", INK_BORDER, SURFACE, "shadow-hard")}>
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[#111318] px-4 py-3 text-white">
          <h2 id="admin-board-title" className="font-code text-sm font-extrabold uppercase tracking-[0.2em]">
            Deployment board
          </h2>
          <span className="font-code text-xs uppercase tracking-[0.16em] text-[#FFD60A]">{data ? `${data.networks.length + ADMIN_NO_PROGRAM_NETWORKS.length} networks` : "Reading"}</span>
        </div>
        {!data && !overview.error ? (
          <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading the board">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-10" surface="card" />
            ))}
          </div>
        ) : null}
        {data ? (
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">Contracts per network</caption>
            <thead className="bg-surface-2">
              <tr className="border-b-2 border-[#1A1A1A]/10 dark:border-white/10">
                <th scope="col" className={cx(LABEL, "px-4 py-2.5", TEXT_MUTED)}>
                  Network
                </th>
                <th scope="col" className={cx(LABEL, "px-3 py-2.5 text-right", TEXT_MUTED)}>
                  Pinned
                </th>
                <th scope="col" className={cx(LABEL, "px-3 py-2.5 text-right", TEXT_MUTED)}>
                  Verified
                </th>
                <th scope="col" className={cx(LABEL, "hidden px-3 py-2.5 text-right sm:table-cell", TEXT_MUTED)}>
                  Deployable
                </th>
                <th scope="col" className={cx(LABEL, "hidden px-4 py-2.5 md:table-cell", TEXT_MUTED)}>
                  Notes
                </th>
              </tr>
            </thead>
            <tbody className="divide-y-2 divide-[#1A1A1A]/10 dark:divide-white/10">
              {data.networks.map((row) => {
                const line = lineFor(row.network);
                return (
                  <tr key={row.network} className="h-14">
                    <th scope="row" className="px-4 py-2 font-bold">
                      <button type="button" onClick={() => goTo("deploy", row.network)} className="flex items-center gap-2.5 text-left underline-offset-4 hover:underline">
                        {line ? <LineBullet line={line} decorative /> : null}
                        {networkName(row.network)}
                        {isTestnet(row.network) ? <StatusPill tone="neutral" className="hidden sm:inline-flex">Testnet</StatusPill> : null}
                      </button>
                    </th>
                    <td className="px-3 py-2 text-right font-code text-base font-bold">{row.pinned}</td>
                    <td className="px-3 py-2 text-right font-code text-base font-bold">{row.verified}</td>
                    <td className="hidden px-3 py-2 text-right font-code text-base font-bold sm:table-cell">{row.deployable}</td>
                    <td className={cx("hidden px-4 py-2 md:table-cell", TEXT_MUTED)}>
                      {row.warnings.length > 0 ? (
                        <ul className="flex flex-col gap-1">
                          {row.warnings.map((warning) => (
                            <li key={warning}>
                              <StatusPill tone="warning" className="max-w-[28rem]">
                                {warning}
                              </StatusPill>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        "No warnings."
                      )}
                    </td>
                  </tr>
                );
              })}
              {ADMIN_NO_PROGRAM_NETWORKS.map((network) => {
                const line = lineFor(network);
                return (
                  <tr key={network} className="h-14 bg-surface-2">
                    <th scope="row" className="px-4 py-2 font-bold">
                      <span className="flex items-center gap-2.5">
                        {line ? <LineBullet line={line} decorative /> : null}
                        {networkName(network)}
                      </span>
                    </th>
                    <td colSpan={4} className={cx("px-3 py-2", TEXT_MUTED)}>
                      No Kletia programs. Nothing to deploy.
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </section>

      <div className="grid gap-5 md:grid-cols-3">
        <Card className="flex flex-col gap-3" tone="surface">
          <p className={cx(LABEL, TEXT_MUTED)}>Safe queue</p>
          <p className="font-display text-3xl font-bold">{data ? data.safeQueue : "…"}</p>
          <p className={cx("text-sm", TEXT_MUTED)}>Proposals collecting signatures or ready to execute.</p>
          <Button variant="secondary" size="sm" className="mt-auto self-start" onClick={() => goTo("safe")}>
            Open the queue
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </Card>
        <Card className="flex flex-col gap-3" tone="surface">
          <p className={cx(LABEL, TEXT_MUTED)}>Render</p>
          <p className="font-display text-3xl font-bold">{data ? (data.servicesConfigured ? "Connected" : "No key") : "…"}</p>
          <p className={cx("text-sm", TEXT_MUTED)}>{data?.servicesConfigured ? "Deploy status and redeploys for the API and the site." : "Add RENDER_API_KEY on the API service to see deploys here."}</p>
          <Button variant="secondary" size="sm" className="mt-auto self-start" onClick={() => goTo("services")}>
            Services
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </Card>
        <Card className="flex flex-col gap-3" tone="yellow">
          <p className={cx(LABEL)}>This session</p>
          <p className="font-display text-xl font-bold">Signed in with the {kind === "solana" ? "Solana" : "EVM"} admin wallet</p>
          <p className="break-all font-code text-[13px]">{session.address}</p>
          <p className="text-sm font-semibold">Ends in {countdownText(sessionEndsAt(session), openedAt)}, or after 30 minutes without activity.</p>
          <Button
            variant="ink"
            size="sm"
            className="mt-auto self-start"
            loading={leaving}
            onClick={async () => {
              setLeaving(true);
              try {
                await client.logoutAll();
                toast.success("Every admin session of this wallet is signed out", { id: "admin-session" });
                reportGateError(new AdminApiError("ADMIN_SESSION_REQUIRED", "Signed out.", 401));
              } catch (error) {
                toast.error("Could not sign out everywhere", { description: walletErrorText(error) });
              } finally {
                setLeaving(false);
              }
            }}
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Sign out everywhere
          </Button>
        </Card>
      </div>
    </div>
  );
}
