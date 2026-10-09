import { ArrowRight, RefreshCw } from "lucide-react";

import { PLATFORM_ORIGIN } from "../../../shared/platform/kletiaClient";
import { Link } from "../../routes/Link";
import { DepartureBoard } from "../../site/art/DepartureBoard";
import { DELAYED_ABOVE_MS, formatBoardClock } from "../../site/art";
import { Button } from "../../site/ui/Button";
import { Section } from "../../site/ui/Section";
import { cx, FOCUS_RING, TEXT_MUTED } from "../../site/ui/styles";
import { boardData } from "../networks/boardRows";
import type { HomeData } from "./useHomeData";

/** How to read the board: the lamp colours, as printed on the board. */
const KEY: readonly { readonly lamp: string; readonly label: string; readonly body: string }[] = [
  { lamp: "#4ADE80", label: "Running", body: "The network's RPC answered." },
  { lamp: "#FFD60A", label: "Delayed", body: `It answered, but slower than ${DELAYED_ABOVE_MS / 1000} s.` },
  { lamp: "#FF5A5F", label: "No service", body: "It did not answer the last check." },
  { lamp: "#4B5563", label: "No reading", body: "The API has not reported this network." },
];

function originHost(): string {
  try {
    return new URL(PLATFORM_ORIGIN).host;
  } catch {
    return PLATFORM_ORIGIN;
  }
}

/**
 * Live status on the home page: one departure board read from GET /v1/health
 * (the only place the home page shows health). Falls back to the registry,
 * with no timings, when the API cannot be reached.
 */
export function StatusBoard({ data }: { readonly data: HomeData }) {
  const { health } = data;
  const board = boardData(health);
  const offline = health.status === "error" && !board.live;
  const clock = board.live && health.updatedAt ? formatBoardClock(new Date(health.updatedAt)) : board.loading ? "--:-- UTC" : "OFFLINE";

  return (
    <Section
      id="status"
      platform={1}
      eyebrow="Live status"
      tone="paper"
      bordered
      reveal
      title="Every network, checked from your browser."
      intro={
        <>
          This board calls <code className="font-code text-[0.9em]">GET /v1/health</code> on the public API through{" "}
          <code className="font-code text-[0.9em]">@kletia/sdk</code> while you read it.
        </>
      }
      containerClassName="grid gap-10 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] lg:items-start lg:gap-14 [&>header]:mb-0"
    >
      <dl className="order-3 grid gap-3 border-t-2 border-dashed border-[#1A1A1A]/25 pt-6 dark:border-white/15 lg:order-none lg:col-start-1 lg:row-start-2 lg:-mt-2">
        {KEY.map((item) => (
          <div key={item.label} className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-baseline gap-x-2 text-sm">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 translate-y-[1px] rounded-full shadow-[0_0_0_2px_#1A1A1A]"
              style={{ backgroundColor: item.lamp }}
            />
            <dt className="inline font-code text-[11px] font-bold uppercase tracking-[0.14em]">{item.label}</dt>
            <dd className="col-start-2 text-[#45464B] dark:text-[#A9B6C8]">{item.body}</dd>
          </div>
        ))}
      </dl>
      <div className="order-2 min-w-0 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <div aria-live="polite" className="sr-only">
          {offline ? "The API did not answer. The board shows the registry with no timings." : ""}
        </div>
        <DepartureBoard
          rows={board.rows}
          clock={clock}
          busy={health.status === "loading"}
          note={
            offline ? (
              <>
                The API did not answer from this browser, so the board shows the registry compiled into @kletia/core and no
                timings.
              </>
            ) : (
              <>RPC round trips measured by {originHost()} and read from your browser when this page loaded.</>
            )
          }
        />
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Button variant="secondary" size="sm" onClick={health.reload} disabled={health.status === "loading"}>
            <RefreshCw className={cx("h-3.5 w-3.5", health.status === "loading" && "kl-loop animate-spin motion-reduce:animate-none")} aria-hidden="true" />
            Check again
          </Button>
          <Link
            to="/networks"
            className={cx(
              "group inline-flex min-h-11 items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-[#0047E0] underline decoration-2 underline-offset-4 dark:text-[#7EA6FF]",
              FOCUS_RING,
            )}
          >
            Capabilities and venues
            <ArrowRight className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-1 motion-reduce:transition-none" aria-hidden="true" />
          </Link>
        </div>
        {board.unknown.length ? (
          <p className={cx("mt-4 text-sm", TEXT_MUTED)}>
            The API also reports {board.unknown.map((entry) => `${entry.name || entry.network} (${entry.ok ? "running" : "no service"})`).join(", ")}.
          </p>
        ) : null}
      </div>
    </Section>
  );
}
