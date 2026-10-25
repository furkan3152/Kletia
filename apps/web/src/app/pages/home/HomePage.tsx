import "./home.css";

import { PROTOCOLS, type ProtocolDescriptor } from "@kletia/core";
import React, { useEffect, useMemo, useRef, useState } from "react";

import { countProtocols } from "../../site/protocolCount";
import { HomeNav, SkipLink, Tape } from "./HomeChrome";
import { NET_ORDER, netName } from "./homeData";
import { answering, tapeItems, type HealthLike, type HomeLive } from "./homeLive";
import { afterPaint, useMagnetic, useReveal } from "./homeMotion";
import { HeroMachine } from "./HeroMachine";
import type { BelowFoldProps } from "./BelowFold";
import type { HomeData } from "./useHomeData";

/*
 * The home page, "the machine at full size". First paint is the tape,
 * the header and the hero alone: the hero paints from the registry compiled into @kletia/core.
 * After it has painted, two groups load in parallel: the live data (the API client and its
 * three requests) and the sections below the fold (with their own stylesheet). Live readouts
 * keep their width while they load, so nothing in view moves.
 */
type HomeDataHook = () => HomeData;

const loadLive = (): Promise<HomeDataHook> => import("./useHomeData").then((module) => module.useHomeData);
interface BelowModules {
  readonly Sections: React.ComponentType<BelowFoldProps>;
  readonly BasePlate: React.ComponentType<{ readonly protocols: number }>;
}
const loadBelow = (): Promise<BelowModules> => import("./BelowFold").then((module) => ({ Sections: module.BelowFold, BasePlate: module.BasePlate }));

/** Loads a module once the page has painted; null until then (and if the download fails: the page keeps what it has). */
function useAfterPaint<T>(load: () => Promise<T>): T | null {
  const [loaded, setLoaded] = useState<T | null>(null);
  useEffect(() => {
    let active = true;
    const cancel = afterPaint(() => {
      load().then(
        (value) => {
          if (active) setLoaded(() => value);
        },
        () => undefined,
      );
    });
    return () => {
      active = false;
      cancel();
    };
  }, [load]);
  return loaded;
}

/** Calls the live data hook, re-reads health every minute while the tab is visible, and hands each answer up. */
function LiveData({ useData, onData }: { readonly useData: HomeDataHook; readonly onData: (data: HomeData) => void }) {
  const data = useData();
  const { health } = data;
  useEffect(() => {
    onData(data);
    // A new answer (or a new request state), not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health.status, health.updatedAt, onData]);
  const reload = health.reload;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) reload();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  return null;
}

function liveFrom(data: HomeData | null): HomeLive {
  if (!data) return { state: "loading", report: null, at: null };
  const { health } = data;
  const report = (health.data as HealthLike | undefined) ?? null;
  if (report) return { state: "live", report, at: health.updatedAt };
  if (health.status === "error") return { state: "unavailable", report: null, at: health.updatedAt };
  return { state: "loading", report: null, at: null };
}

const TAPE_ORDER = NET_ORDER.map((key) => ({ key, name: netName(key) }));

/** Below-the-fold place holder: at least a screen, so the footer never rises into view and drops. */
function BelowSlot() {
  return <div aria-hidden="true" style={{ minHeight: "100vh" }} />;
}

export default function HomePage() {
  const root = useRef<HTMLDivElement>(null);
  const useData = useAfterPaint(loadLive);
  const Below = useAfterPaint(loadBelow);
  const [data, setData] = useState<HomeData | null>(null);
  // Registry counts (what this build plans against), never shifted by a live answer.
  const protocols: readonly ProtocolDescriptor[] = PROTOCOLS;
  const counted = countProtocols(protocols);
  const live = liveFrom(data);
  const items = useMemo(() => tapeItems(live.report, live.state, TAPE_ORDER), [live.report, live.state]);
  const answer = answering(live.report, NET_ORDER);

  useMagnetic(root);
  useReveal(root);

  return (
    <div className="hm" ref={root}>
      {useData ? <LiveData useData={useData} onData={setData} /> : null}
      <SkipLink />
      <Tape items={items} label="Live network status from GET /v1/health" />
      <HomeNav />
      <main id="main-content" tabIndex={-1} className="hm-main">
        <HeroMachine protocols={counted.protocols} answering={answer ? `${answer.ok}/${answer.total}` : null} />
        {Below ? <Below.Sections live={live} protocols={protocols} counted={counted} /> : <BelowSlot />}
      </main>
      {Below ? <Below.BasePlate protocols={counted.protocols} /> : null}
    </div>
  );
}
