/**
 * Env readiness: which variables the API has set, as booleans only (values
 * never leave the server), the admin origins and the store, plus the
 * site's own build env read from import.meta.env presence.
 */
import { Skeleton } from "../../../site/ui/Skeleton";
import { StatusPill } from "../../../site/ui/StatusPill";
import { cx, INK_BORDER_THIN, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { useAdminQuery } from "../api/useAdmin";
import { AdminError } from "../components/AdminError";
import { Panel, SectionHeader } from "../components/SectionHeader";
import type { AdminEnvItem } from "../model/types";
import { walletConnectProjectId } from "../../../../shared/platform/walletConnectProjectId";

/** The site's build env, as presence only. */
const SITE_ENV: readonly { readonly name: string; readonly set: boolean; readonly required: boolean }[] = [
  { name: "VITE_BACKEND_URL", set: Boolean(import.meta.env.VITE_BACKEND_URL), required: true },
  // A placeholder or malformed id counts as not set: the build hides WalletConnect then.
  { name: "VITE_WALLETCONNECT_PROJECT_ID", set: walletConnectProjectId(import.meta.env.VITE_WALLETCONNECT_PROJECT_ID) !== null, required: false },
  { name: "VITE_BASE_RPC_URL", set: Boolean(import.meta.env.VITE_BASE_RPC_URL), required: false },
  { name: "VITE_ARBITRUM_RPC_URL", set: Boolean(import.meta.env.VITE_ARBITRUM_RPC_URL), required: false },
  { name: "VITE_ARC_RPC_URL", set: Boolean(import.meta.env.VITE_ARC_RPC_URL), required: false },
];

function EnvList({ items }: { readonly items: readonly Pick<AdminEnvItem, "name" | "set" | "required">[] }) {
  return (
    <ul className={cx("divide-y-2 divide-[#121212]/10 dark:divide-white/10", INK_BORDER_THIN, SURFACE)}>
      {items.map((item) => (
        <li key={item.name} className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-4 py-2">
          <code className="break-all font-code text-[13px] font-bold">{item.name}</code>
          <span className="flex items-center gap-2">
            {item.required ? <span className={cx(LABEL, TEXT_MUTED)}>Required</span> : null}
            <StatusPill tone={item.set ? "success" : item.required ? "danger" : "neutral"}>{item.set ? "Set" : "Not set"}</StatusPill>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function EnvironmentSection() {
  const env = useAdminQuery(["env"], (api) => api.env());
  const groups = new Map<string, AdminEnvItem[]>();
  for (const item of env.data?.items ?? []) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  const missing = (env.data?.items ?? []).filter((item) => item.required && !item.set).length;
  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        icon="verify"
        eyebrow="Environment"
        title="Is everything set?"
        intro="Whether each variable is set on the API service, never its value. Change them in Render; the panel cannot, on purpose."
      />
      {env.error ? <AdminError error={env.error} title="The environment could not load" onRetry={() => void env.refetch()} /> : null}
      {env.isLoading ? <Skeleton className="h-64" surface="card" /> : null}
      {env.data ? (
        <>
          <div className="flex flex-wrap gap-3">
            <StatusPill tone={missing === 0 ? "success" : "danger"}>{missing === 0 ? "Every required variable is set" : `${missing} required variable${missing === 1 ? "" : "s"} missing`}</StatusPill>
            <StatusPill tone={env.data.store === "postgres" ? "success" : "warning"}>{env.data.store === "postgres" ? "Store: Postgres" : "Store: memory (development only)"}</StatusPill>
          </div>
          <Panel title="Admin origins">
            <ul className="flex flex-wrap gap-2">
              {env.data.adminOrigins.map((origin) => (
                <li key={origin}>
                  <code className="border-2 border-control bg-surface px-2 py-1 font-code text-[13px]">{origin}</code>
                </li>
              ))}
            </ul>
          </Panel>
          <div className="grid gap-8 xl:grid-cols-2">
            {[...groups.entries()].map(([group, items]) => (
              <Panel key={group} title={group}>
                <EnvList items={items} />
              </Panel>
            ))}
            <Panel title="Site build (this page)">
              <EnvList items={SITE_ENV} />
            </Panel>
          </div>
        </>
      ) : null}
    </div>
  );
}
