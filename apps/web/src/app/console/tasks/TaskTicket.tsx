/**
 * The printed header of every task (console design 3.7): serial, "You asked
 * for" (the sentence as typed, from memory), From and To bullets, the line
 * that says where the money departs, the network-engine badge, the test-yard
 * ribbon and the state stamp. Built on the art system's die-cut ticket.
 */
import type { ReactNode } from "react";
import { CHAINS, type NetworkKey } from "@kletia/core";

import { LineBullet } from "../../site/art/LineBullet";
import { Stamp } from "../../site/art/Stamp";
import { TicketHead, TicketShell } from "../../site/art/TicketShell";
import { LINES } from "../../site/art/tokens";
import { DESK_COPY } from "../content/copy";
import type { DepartureLine } from "../state/deskModel";
import type { TaskRecord } from "../state/deskStore";
import { DepartureNotice } from "./DepartureNotice";
import { serialOf, taskStatusLabel, ticketStampOf, unstampedSentence } from "./taskModel";

const copy = DESK_COPY.ticket;

export interface TaskTicketProps {
  readonly task: TaskRecord;
  /** Where the plan starts and ends; falls back to the task's own record. */
  readonly ends: { readonly from: NetworkKey; readonly to: NetworkKey } | null;
  readonly departureLine: DepartureLine | null;
  /** "Change" (Auto picked a network) or "Start from X instead" (older API), when the task offers it. */
  readonly lineAction?: ReactNode;
  /** Extra lines under the route (the engine's reason, step progress). */
  readonly children?: ReactNode;
  readonly animateStamp?: boolean;
}

export function TaskTicket({ task, ends, departureLine, lineAction, children, animateStamp = false }: TaskTicketProps) {
  const serial = serialOf(task.intentId ?? task.id);
  const stamp = ticketStampOf(task);
  // The ticket's data-state follows the stamp it prints ("none" without one).
  const state = stamp?.state ?? "none";
  const route = ends ?? task.ends;
  const yard = task.lane === "testnet";
  const sentence = task.sentence || task.title;
  const engine = task.engine.kind === "network" ? task.engine.network : null;
  return (
    <TicketShell
      label={copy.articleLabel(serial, task.title)}
      kind="intent"
      state={state}
      main={
        <>
          <TicketHead icon="ticket" title={copy.kicker} serial={serial} />
          {engine || yard ? (
            <p className="mb-2 flex flex-wrap gap-2 text-[11px] font-black uppercase tracking-wider">
              {engine ? (
                <span className="inline-flex items-center gap-1.5 border-2 border-[#1A1A1A] px-1.5 py-0.5">
                  <LineBullet line={LINES[engine]} decorative />
                  {copy.engineBadge(CHAINS[engine].shortName)}
                </span>
              ) : null}
              {yard ? <span className="kd-yard-ribbon px-1.5 py-0.5">{copy.testYardRibbon}</span> : null}
            </p>
          ) : null}
          <p className="kla-ticket__eyebrow">{copy.youAskedFor}</p>
          <p className="kla-ticket__intent break-words">“{sentence}”</p>
          {route ? (
            <div className="kla-ticket__route">
              <span className="kla-ticket__end">
                <span className="kla-ticket__k">{copy.from}</span>
                <LineBullet line={LINES[route.from]} decorative />
                <span className="kla-ticket__place">{CHAINS[route.from].name}</span>
              </span>
              <span className="kla-ticket__track" aria-hidden="true" />
              <span className="kla-ticket__end">
                <span className="kla-ticket__k">{copy.to}</span>
                <LineBullet line={LINES[route.to]} decorative />
                <span className="kla-ticket__place">{CHAINS[route.to].name}</span>
              </span>
            </div>
          ) : null}
          {departureLine ? <DepartureNotice line={departureLine} action={lineAction} /> : null}
          {children}
        </>
      }
      stub={
        <>
          <p className="kla-ticket__stub-k">{taskStatusLabel(task)}</p>
          {stamp ? (
            <>
              <p className="kla-sr">{stamp.sentence}</p>
              <Stamp state={stamp.state} detail={stamp.detail} animate={animateStamp} className="kla-ticket__stamp" />
            </>
          ) : (
            <p className="kla-sr">{unstampedSentence(task.status, task.engine)}</p>
          )}
        </>
      }
    />
  );
}
