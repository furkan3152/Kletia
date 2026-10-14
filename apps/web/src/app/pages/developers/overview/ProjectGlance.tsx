import type { WebhookDelivery } from "@kletia/sdk";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { useEffect, useMemo } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource, type ApiResource } from "../../../../shared/platform/useApiResource";
import { Link } from "../../../routes/Link";
import { Skeleton } from "../../../site/ui/Skeleton";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey } from "../keys/sessionKey";
import { currentKeyLane, DELIVERY_ENDPOINTS, projectGlance, type GlanceSources, type GlanceTile, type TileSource } from "./overviewModel";

function asSource<T>(resource: ApiResource<T>): TileSource<T> {
  return {
    status: resource.status,
    data: resource.status === "success" ? resource.data : undefined,
    error: resource.error ? { status: resource.error.status, code: resource.error.code, message: resource.error.message } : null,
  };
}

/**
 * Up to three endpoints' newest deliveries: a fixed number of hooks, so the
 * reads never change shape between renders.
 */
function useDeliveries(key: string, ids: readonly string[]): GlanceSources["deliveries"] {
  const tag = maskKey(key);
  const read = (id: string | undefined) => (_client: unknown, signal: AbortSignal) =>
    keyedClient(key).webhooks.deliveries(id ?? "", { limit: 20, signal: sdkSignal(signal) });
  const first = useApiResource(ids[0] ? `glance:${tag}:deliveries:${ids[0]}` : null, read(ids[0]));
  const second = useApiResource(ids[1] ? `glance:${tag}:deliveries:${ids[1]}` : null, read(ids[1]));
  const third = useApiResource(ids[2] ? `glance:${tag}:deliveries:${ids[2]}` : null, read(ids[2]));
  const results = [first, second, third];
  const out: Record<string, TileSource<readonly WebhookDelivery[]>> = {};
  ids.slice(0, DELIVERY_ENDPOINTS).forEach((id, index) => {
    out[id] = asSource(results[index]!);
  });
  return out;
}

function Tile({ tile }: { readonly tile: GlanceTile }) {
  return (
    <li className={cx("flex min-w-0 flex-col gap-3 p-4", INK_BORDER, SURFACE)}>
      <h3 className={cx(LABEL, TEXT_MUTED)}>{tile.title}</h3>
      {tile.state === "loading" ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-5 w-32" />
        </div>
      ) : (
        <dl className="flex flex-col gap-1">
          {tile.lines.map((line) => (
            <div key={line.label} className="flex items-baseline gap-2">
              <dt className="sr-only">{line.label}</dt>
              <dd className="font-display text-title font-bold tabular-nums">{line.value}</dd>
              <dd aria-hidden="true" className={cx("text-sm", TEXT_MUTED)}>
                {line.label}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {tile.state === "loading" ? <span className="sr-only">Loading {tile.title}</span> : null}
      {tile.error ? (
        <p className="text-xs font-bold text-danger">Could not read: {tile.error}</p>
      ) : tile.attention ? (
        <p className="flex items-start gap-1.5 text-xs font-bold text-warning">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {tile.attention}
        </p>
      ) : null}
      <Link to={tile.href} className={cx("mt-auto inline-flex min-h-11 items-center gap-1 self-start text-sm font-bold underline decoration-2 underline-offset-4", FOCUS_RING)}>
        {tile.action}
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </li>
  );
}

/**
 * "Your project" (portal design 4.4.1): six tiles from 6 to 9 reads made
 * with the key in this tab. Each tile has its own loading and error; a tile
 * never shows a number it did not read.
 */
export function ProjectGlance({
  apiKey,
  onLane,
}: {
  readonly apiKey: string;
  /** The lane of the key in this tab once GET /v1/keys says it (Start here runs sandbox keys on the public tier). */
  readonly onLane?: (lane: "testnet" | "production" | "any" | null) => void;
}) {
  const tag = maskKey(apiKey);
  const client = useMemo(() => keyedClient(apiKey), [apiKey]);
  const keys = useApiResource(`glance:${tag}:keys`, (_client, signal) => client.keys.list({ signal: sdkSignal(signal) }));
  const usage = useApiResource(`glance:${tag}:usage`, (_client, signal) => client.usage({ window: "7d", signal: sdkSignal(signal) }));
  const webhooks = useApiResource(`glance:${tag}:webhooks`, (_client, signal) => client.webhooks.list({ signal: sdkSignal(signal) }));
  const contracts = useApiResource(`glance:${tag}:contracts`, (_client, signal) => client.contracts.list({}, { signal: sdkSignal(signal) }));
  const links = useApiResource(`glance:${tag}:links`, (_client, signal) => client.links.list({ limit: 50 }, { signal: sdkSignal(signal) }));
  const approvals = useApiResource(`glance:${tag}:approvals`, (_client, signal) => client.approvals.list({ status: "pending" }, { signal: sdkSignal(signal) }));
  const hookIds = useMemo(() => (webhooks.status === "success" ? (webhooks.data ?? []).slice(0, DELIVERY_ENDPOINTS).map((hook) => hook.id) : []), [webhooks.status, webhooks.data]);
  const deliveries = useDeliveries(apiKey, hookIds);

  const lane = currentKeyLane(asSource(keys));
  useEffect(() => onLane?.(lane), [lane, onLane]);

  const tiles = projectGlance({
    keys: asSource(keys),
    usage: asSource(usage),
    webhooks: asSource(webhooks),
    deliveries,
    contracts: asSource(contracts),
    links: asSource(links),
    approvals: asSource(approvals),
  });

  return (
    <section aria-labelledby="project-heading" className="flex min-w-0 flex-col gap-4 pt-12">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h2 id="project-heading" className="font-display text-display-s font-bold">
          Your project
        </h2>
        <p className={cx("font-code text-code-s", TEXT_MUTED)}>{tag}</p>
      </div>
      <ul className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((tile) => (
          <Tile key={tile.id} tile={tile} />
        ))}
      </ul>
    </section>
  );
}
