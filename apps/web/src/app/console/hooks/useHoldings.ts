/**
 * The desk's holdings (console design 3.9 and 5.4): one
 * `GET /v1/portfolio?accounts=` per read for the lane's accounts (or one read
 * per account, at most six, on an API without the batch route), on wallet
 * and lane changes, after settled steps (`portfolio.invalidated`, coalesced
 * into one read) and on the refresh button. Nothing is read while a task
 * holds the signing lock; what waited reads once afterwards
 * (`HoldingsSchedule`). A failed account keeps its last reading, marked stale.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountId } from "@kletia/core";

import { getKletiaClient } from "../../../shared/platform/kletiaClient";
import { fetchPortfolios } from "../../../shared/platform/platformApi";
import { useKletiaEvent } from "../../../shared/sync/bus";
import type { Lane } from "../state/deskModel";
import { buildHoldingsSnapshot, type HoldingsSnapshot } from "../state/holdings";
import { HoldingsSchedule } from "./holdingsSchedule";

export interface HoldingsState {
  readonly snapshot: HoldingsSnapshot | null;
  readonly loading: boolean;
  /** The last read failed as a whole (the previous snapshot stays). */
  readonly failed: boolean;
  /** The API has no batch route: reads went one account at a time. */
  readonly perAccount: boolean;
  refresh(): void;
}

export function useHoldings(lane: Lane, accounts: readonly AccountId[], signing: boolean): HoldingsState {
  const [snapshot, setSnapshot] = useState<HoldingsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [perAccount, setPerAccount] = useState(false);
  const snapshotRef = useRef<HoldingsSnapshot | null>(null);
  const skipBatchRef = useRef(false);
  const targetRef = useRef({ lane, accounts });
  const controllerRef = useRef<AbortController | null>(null);
  const scheduleRef = useRef<HoldingsSchedule | null>(null);

  useEffect(() => {
    targetRef.current = { lane, accounts };
  });

  const read = useCallback(async () => {
    const { lane: readLane, accounts: readAccounts } = targetRef.current;
    controllerRef.current?.abort();
    if (readAccounts.length === 0) {
      snapshotRef.current = null;
      setSnapshot(null);
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const reads = await fetchPortfolios(getKletiaClient(), controller.signal, readAccounts, { skipBatch: skipBatchRef.current });
      if (controller.signal.aborted) return;
      if (reads.source === "per-account") {
        skipBatchRef.current = true;
        setPerAccount(true);
      }
      const next = buildHoldingsSnapshot({
        lane: readLane,
        portfolios: reads.portfolios,
        failures: reads.failures,
        previous: snapshotRef.current,
        observedAt: reads.observedAt,
      });
      snapshotRef.current = next;
      setSnapshot(next);
      setFailed(false);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const schedule = new HoldingsSchedule({ read });
    scheduleRef.current = schedule;
    return () => {
      schedule.dispose();
      scheduleRef.current = null;
      controllerRef.current?.abort();
    };
  }, [read]);

  useEffect(() => {
    scheduleRef.current?.setSigning(signing);
  }, [signing]);

  const accountsKey = accounts.join(",");
  const laneRef = useRef(lane);
  useEffect(() => {
    const laneChanged = laneRef.current !== lane;
    laneRef.current = lane;
    if (laneChanged) {
      snapshotRef.current = null;
      setSnapshot(null);
    }
    scheduleRef.current?.request(laneChanged ? "lane" : "accounts");
  }, [accountsKey, lane]);

  useKletiaEvent("portfolio.invalidated", (event) => {
    if (targetRef.current.accounts.some((account) => account.toLowerCase() === event.account.toLowerCase())) {
      scheduleRef.current?.request("invalidated");
    }
  });

  const refresh = useCallback(() => scheduleRef.current?.request("manual"), []);

  return { snapshot, loading, failed, perAccount, refresh };
}
