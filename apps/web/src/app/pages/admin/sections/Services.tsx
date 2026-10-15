/**
 * Render services (admin design F.1): the API and the site, their last
 * deploys on a departure-board strip, and Redeploy. The panel never edits
 * env vars or secrets; redeploying the API ends this request processing for
 * about 30 s, then the panel checks the session again.
 */
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, RotateCw } from "lucide-react";
import { useState } from "react";

import { ButtonLink, Button } from "../../../site/ui/Button";
import { Skeleton } from "../../../site/ui/Skeleton";
import { StatusPill, type StatusTone } from "../../../site/ui/StatusPill";
import { Switch } from "../../../site/ui/Switch";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { toast } from "../../../site/ui/toast";
import { useAdmin, useAdminQuery } from "../api/useAdmin";
import { errorText } from "../api/errors";
import { AdminError } from "../components/AdminError";
import { ConfirmSheet } from "../components/ConfirmSheet";
import { GateCard } from "../components/GateCard";
import { SectionHeader } from "../components/SectionHeader";
import type { AdminRenderDeploy, AdminRenderService } from "../model/types";

export const REDEPLOY_WARNING = "Redeploy builds the latest commit on main even if CI has not passed yet (auto-deploy waits for checks).";

function deployTone(status: string): StatusTone {
  if (status === "live") return "success";
  if (/fail|canceled|cancelled|deactivated/u.test(status)) return /fail/u.test(status) ? "danger" : "neutral";
  if (/progress|created|pending|queued/u.test(status)) return "info";
  return "neutral";
}

function clock(iso: string | null): string {
  return iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : "--";
}

function DeployStrip({ deploys }: { readonly deploys: readonly AdminRenderDeploy[] }) {
  if (deploys.length === 0) return <p className={cx("px-4 py-3 text-sm", TEXT_MUTED)}>No deploys yet.</p>;
  return (
    <table className="w-full border-collapse bg-[#111318] text-left font-code text-[13px] text-[#F4F1EA]">
      <caption className="sr-only">Last deploys</caption>
      <thead>
        <tr className="text-[#FFD60A]">
          <th scope="col" className="px-3 py-2 font-extrabold uppercase tracking-[0.14em]">
            Started
          </th>
          <th scope="col" className="px-3 py-2 font-extrabold uppercase tracking-[0.14em]">
            Commit
          </th>
          <th scope="col" className="hidden px-3 py-2 font-extrabold uppercase tracking-[0.14em] md:table-cell">
            Trigger
          </th>
          <th scope="col" className="px-3 py-2 text-right font-extrabold uppercase tracking-[0.14em]">
            Status
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-white/10">
        {deploys.map((deploy) => (
          <tr key={deploy.id}>
            <td className="whitespace-nowrap px-3 py-2">{clock(deploy.createdAt)}</td>
            <td className="max-w-[18rem] truncate px-3 py-2" title={deploy.commit?.message ?? undefined}>
              {deploy.commit ? `${deploy.commit.id.slice(0, 7)} ${deploy.commit.message.split("\n")[0]}` : "--"}
            </td>
            <td className="hidden px-3 py-2 md:table-cell">{deploy.trigger ?? "--"}</td>
            <td className="px-3 py-2 text-right">
              <StatusPill tone={deployTone(deploy.status)} className="!bg-transparent">
                {deploy.status.replace(/_/gu, " ")}
              </StatusPill>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ServicesSection() {
  const services = useAdminQuery(["services"], (api) => api.services());
  const view = services.data;
  return (
    <div className="flex flex-col gap-8">
      <SectionHeader icon="sdk" eyebrow="Services" title="Render deploys" intro={REDEPLOY_WARNING} />
      {services.error ? <AdminError error={services.error} title="Services could not load" onRetry={() => void services.refetch()} /> : null}
      {services.isLoading ? <Skeleton className="h-64" surface="card" /> : null}
      {view && !view.configured ? (
        <GateCard icon="key" eyebrow="No key" title="Render is not connected" code="RENDER_API_KEY=rnd_…" className="!mx-0">
          <p>Create an API key in Render (Account settings → API keys), add it as RENDER_API_KEY on the Kletia API service, then redeploy.</p>
          <p>The panel only reads service status and starts deploys with it. It never changes env vars or secrets.</p>
        </GateCard>
      ) : null}
      {view?.configured ? (
        <>
          <p className={cx("text-sm", TEXT_MUTED)}>
            This API process runs commit <code className="font-code text-fg">{view.runningCommit ? view.runningCommit.slice(0, 7) : "unknown"}</code>.
          </p>
          <div className="grid gap-6 xl:grid-cols-2">
            {view.services.map((service) => (
              <ServiceCard key={service.key} service={service} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ServiceCard({ service }: { readonly service: AdminRenderService }) {
  const { client, reportGateError } = useAdmin();
  const queryClient = useQueryClient();
  const [sheet, setSheet] = useState(false);
  const [clearCache, setClearCache] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = service.key === "api" ? "Kletia API" : "Kletia site";

  const redeploy = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.redeploy(service.key, clearCache);
      setSheet(false);
      toast.success(`${title} deploy started`, { description: service.key === "api" ? "The API restarts in about 30 seconds; the panel reconnects when it answers." : undefined });
      void queryClient.invalidateQueries({ queryKey: ["admin", "services"] });
      if (service.key === "api") {
        // Poll the session until the new API answers (admin design F.1).
        const started = Date.now();
        const poll = async () => {
          try {
            await client.session();
            void queryClient.invalidateQueries({ queryKey: ["admin"] });
          } catch (failure) {
            if (Date.now() - started < 10 * 60_000) window.setTimeout(() => void poll(), 15_000);
            else reportGateError(failure);
          }
        };
        window.setTimeout(() => void poll(), 30_000);
      }
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={cx("flex min-w-0 flex-col overflow-hidden", INK_BORDER, HARD_SHADOW, SURFACE)} aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-3 p-5">
        <div className="min-w-0">
          <p className={cx(LABEL, TEXT_MUTED)}>{service.serviceId}</p>
          <h2 className="font-display text-2xl font-bold">{service.name ?? title}</h2>
          {service.url ? (
            <a href={service.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-bold underline underline-offset-4">
              {service.url.replace(/^https?:\/\//u, "")}
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          {service.suspended ? <StatusPill tone="danger">Suspended</StatusPill> : <StatusPill tone="success">Active</StatusPill>}
          <Button variant="primary" size="sm" onClick={() => setSheet(true)}>
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            Redeploy
          </Button>
        </div>
      </div>
      <DeployStrip deploys={service.deploys} />
      <div className="p-4">
        <ButtonLink to={`https://dashboard.render.com/web/${service.serviceId}`} variant="ghost" size="sm">
          Open in Render
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </ButtonLink>
      </div>
      <ConfirmSheet open={sheet} onClose={() => setSheet(false)} title={`Redeploy ${title}`} warning={REDEPLOY_WARNING} confirmLabel="Start the deploy" onConfirm={() => void redeploy()} busy={busy}>
        <Switch checked={clearCache} onChange={setClearCache} label="Clear the build cache" description="Slower; use it when a dependency change did not take." />
        {service.key === "api" ? <p>The API stops answering for about 30 seconds while the new version starts.</p> : null}
        {error ? (
          <p role="alert" className="font-bold text-danger">
            {error}
          </p>
        ) : null}
      </ConfirmSheet>
    </section>
  );
}
