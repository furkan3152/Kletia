/**
 * A read-only rate question on the desk ("compare yield", "show live Aave
 * rates"): answered from Kletia's venue list (`GET /v1/venues`) without a
 * wallet, an API key or a network engine. Nothing is planned and nothing can
 * be signed; "Plan a deposit" only fills the composer. Borrow rates are not
 * in the venue list: the note says so and, where a network engine reads
 * them, offers that engine (it needs an EVM wallet).
 */
import { useEffect, useRef, useState } from "react";
import { CHAINS } from "@kletia/core";

import { PLATFORM_ORIGIN } from "../../../shared/platform/kletiaClient";
import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
import { formatUtcMinutes } from "../../site/format/utcTime";
import { Button } from "../../site/ui/Button";
import { cx, INK_BORDER, LABEL, SURFACE } from "../../site/ui/styles";
import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import { getDeskStore, type TaskRecord } from "../state/deskStore";
import { PlanningSkeleton } from "./PlanningSkeleton";
import {
  borrowEngineFor,
  depositSentence,
  formatApy,
  formatSize,
  parseVenues,
  rateQueryOf,
  ratesFor,
  venuesPath,
  type VenueRate,
} from "./ratesModel";
import { TaskTicket } from "./TaskTicket";

const copy = DESK_COPY.rates;
const TIMEOUT_MS = 20_000;
const MAX_ROWS = 12;

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "done"; readonly rows: readonly VenueRate[]; readonly at: number };

/** Reads `GET /v1/venues`; never throws. */
async function readRates(path: string): Promise<Load> {
  try {
    const response = await fetch(`${PLATFORM_ORIGIN}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const rows = response.ok ? parseVenues(await response.json().catch(() => null)) : null;
    return rows ? { kind: "done", rows, at: Date.now() } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

export function RatesTaskBody({ task }: { readonly task: TaskRecord }) {
  const actions = useDeskActions();
  const query = rateQueryOf(task.sentence, task.departure);
  const path = venuesPath(query);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const aliveRef = useRef(true);

  /** The result of one read, applied to the view and the task (never after unmount). */
  const settle = (next: Load) => {
    if (!aliveRef.current) return;
    setLoad(next);
    getDeskStore().getState().patchTask(task.id, { status: next.kind === "done" ? "completed" : "failed" });
  };

  // One read per task (a restored task has no sentence left to read for).
  useEffect(() => {
    aliveRef.current = true;
    if (task.sentence && !task.restored) void readRates(path).then(settle);
    return () => {
      aliveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per task
  }, []);

  const retry = () => {
    setLoad({ kind: "loading" });
    getDeskStore().getState().patchTask(task.id, { status: "planning" });
    void readRates(path).then(settle);
  };

  const engine = query.borrow ? borrowEngineFor(query) : null;
  const ends = query.network ? { from: query.network, to: query.network } : null;

  let body: React.ReactNode;
  if (task.restored || !task.sentence) {
    body = <p className="text-sm font-semibold text-muted">{copy.sentenceForgotten}</p>;
  } else if (load.kind === "loading") {
    body = <PlanningSkeleton label={copy.loading} />;
  } else if (load.kind === "failed") {
    body = (
      <div role="alert" className="flex flex-col items-start gap-3 border-l-4 border-[var(--kl-danger)] bg-[var(--kl-danger-bg)] px-3 py-2">
        <p className="text-sm font-bold text-[var(--kl-danger)]">{copy.failed}</p>
        <Button size="sm" variant="secondary" onClick={retry}>
          {copy.retry}
        </Button>
      </div>
    );
  } else {
    const rows = ratesFor(load.rows, query).slice(0, MAX_ROWS);
    body = (
      <section aria-label={copy.heading} className={cx("flex flex-col gap-3 p-4", INK_BORDER, SURFACE)}>
        <div>
          <p className={LABEL}>{copy.heading}</p>
          <p className="mt-1 text-sm">{copy.lead}</p>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm font-semibold">{copy.none}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {rows.map((row) => {
              const sentence = depositSentence(row);
              return (
                <li key={row.venue} className="grid gap-x-4 gap-y-1 border-2 border-control bg-surface-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
                      <LineBullet line={LINES[row.network]} decorative />
                      <span className="break-words">{row.name}</span>
                      <span className="text-xs font-semibold text-muted">{CHAINS[row.network].shortName}</span>
                    </p>
                    <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                      {row.totalSupplied ? (
                        <div className="flex gap-1">
                          <dt>{copy.columns.supplied}</dt>
                          <dd className="font-code">
                            {formatSize(row.totalSupplied)} {row.asset}
                          </dd>
                        </div>
                      ) : null}
                      {row.exitLiquidity ? (
                        <div className="flex gap-1">
                          <dt>{copy.columns.exit}</dt>
                          <dd className="font-code">
                            {formatSize(row.exitLiquidity)} {row.asset}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                    <p className="font-code text-lg font-bold">
                      <span className="sr-only">{copy.columns.apy} </span>
                      {formatApy(row.supplyApy)}
                    </p>
                    {sentence ? (
                      <button
                        type="button"
                        className="inline-flex min-h-11 items-center border-2 border-control bg-surface px-3 text-xs font-black uppercase tracking-wider text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]"
                        aria-label={copy.planDepositLabel(sentence)}
                        onClick={() => actions.fill(sentence)}
                      >
                        {copy.planDeposit}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {query.borrow ? (
          <div className="flex flex-col items-start gap-2 border-l-4 border-[var(--kl-warning)] bg-[var(--kl-warning-bg)] px-3 py-2 text-sm">
            <p className="font-semibold">{copy.borrowNote}</p>
            {engine ? (
              <>
                <p>{copy.borrowEngine(CHAINS[engine].shortName)}</p>
                <Button size="sm" variant="secondary" onClick={() => actions.startEngineTask(task.sentence, engine, "offer")}>
                  {copy.askEngine(CHAINS[engine].shortName)}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {query.solana ? <p className="text-sm">{copy.solanaNote}</p> : null}
        <p className="text-xs text-muted">{copy.readAt(formatUtcMinutes(load.at) ?? "")}</p>
      </section>
    );
  }

  return (
    <>
      <TaskTicket task={task} ends={ends} departureLine={null} />
      {body}
    </>
  );
}
