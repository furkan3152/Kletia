/**
 * The machine panel on the desk's right: the printer window (idle,
 * working, jam, from the tasks' real state), "Now" (the active task's legs as the executor and
 * the API report them), live balances per network from the holdings read (odometer digits,
 * proportion bars) and today on chain from `GET /v1/health`. Unknown values print "—".
 */
import type { ReactNode } from "react";

import { Eng, Icon, Led, MachineWindow, Module, Odometer, Vents, networkIcon, type IconName } from "../../../kit";
import { DESK_MORE_COPY } from "../deskCopy";
import { formatUsdFixed, type BalanceSummary, type MachineLeg, type PrinterState, type TodayRow } from "./machineModel";

const copy = DESK_MORE_COPY.machine;

export interface MachinePanelProps {
  readonly printer: PrinterState;
  readonly legs: readonly MachineLeg[] | null;
  readonly balances: BalanceSummary;
  /** Holdings are being read for the first time. */
  readonly balancesLoading: boolean;
  /** No wallet connected: nothing to read. */
  readonly noWallet: boolean;
  /** Networks the legs move between (lit in the balances). */
  readonly moving: ReadonlySet<string>;
  readonly today: readonly TodayRow[];
  /** Notices and peeks rendered under the modules (sub-agent notice, activity). */
  readonly children?: ReactNode;
}

const STATE_WORD: Record<PrinterState, string> = { idle: copy.ready, working: copy.working, jam: copy.attention };
const CAPTION: Record<PrinterState, string> = { idle: copy.idleCaption, working: copy.workingCaption, jam: copy.jamCaption };
const TODAY_ICON: Record<TodayRow["id"], IconName> = { live: "pulse", fastest: "gas", slowest: "clock" };

export function MachinePanel({ printer, legs, balances, balancesLoading, noWallet, moving, today, children }: MachinePanelProps) {
  return (
    <>
      <div className="kd-mp-head" data-boot-part="">
        <Eng as="h2">{copy.machine}</Eng>
        <Vents />
        <span className="kd-mp-state" role="status">
          <Led tone={printer === "jam" ? "magenta" : printer === "working" ? "blue" : "on"} />
          {STATE_WORD[printer]}
        </span>
      </div>
      <div data-boot-part="">
        <MachineWindow state={printer} caption={CAPTION[printer]} />
      </div>
      {legs && legs.length > 0 ? (
        <Module label={copy.now} data-boot-part="">
          <ol className="kd-legs" aria-live="polite">
            {legs.map((leg, index) => (
              <li key={leg.id} data-state={leg.state}>
                <span className="kd-leg-b" aria-hidden="true">
                  {leg.state === "done" ? <Icon name="check" /> : leg.state === "failed" ? <Icon name="x" /> : index + 1}
                </span>
                <div style={{ minWidth: 0 }}>
                  <b>{leg.title}</b>
                  <small>{leg.detail}</small>
                </div>
                <span className="kd-leg-s">{leg.word}</span>
              </li>
            ))}
          </ol>
        </Module>
      ) : null}
      <Module label={copy.balances} aside={balances.networks > 0 ? copy.networks(balances.networks) : undefined} data-boot-part="">
        {balances.total !== null ? <Odometer className="kd-total" value={formatUsdFixed(balances.total)} /> : <p className="kd-total k-num" aria-label={copy.unknown}>—</p>}
        {balances.rows.length > 0 ? (
          <ul className="kd-bals">
            {balances.rows.map((row) => (
              <li key={row.network} data-moving={moving.has(row.network) ? "" : undefined}>
                <Icon name={networkIcon(row.network)} />
                <span>
                  {row.name}
                  {row.stale ? <span className="k-muted"> · {copy.stale}</span> : null}
                </span>
                <Odometer value={formatUsdFixed(row.usd)} />
                <i aria-hidden="true">
                  <span style={{ width: `${Math.max(2, row.share * 100)}%` }} />
                </i>
              </li>
            ))}
          </ul>
        ) : (
          <p className="kd-panel-note">{noWallet ? copy.balancesNone : balancesLoading ? copy.balancesReading : copy.balancesEmpty}</p>
        )}
      </Module>
      <Module label={copy.today} data-boot-part="">
        <ul className="kd-today">
          {today.map((row) => (
            <li key={row.id}>
              <Icon name={TODAY_ICON[row.id]} />
              <span>{row.label}</span>
              <b>{row.value ?? "—"}</b>
            </li>
          ))}
        </ul>
      </Module>
      {children}
    </>
  );
}
