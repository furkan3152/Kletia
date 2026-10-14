import { CHAINS, PROTOCOLS, type ProtocolDescriptor } from "@kletia/core";
import React, { useEffect, useState } from "react";

import { countProtocols, protocolCountLabel } from "../../site/protocolCount";
import { cx } from "../../site/ui/styles";
import { HeroSection } from "./HeroSection";
import type { FaqProps } from "./Faq";
import type { NetworkStripProps } from "./NetworkStrip";
import type { HomeData } from "./useHomeData";

/*
 * First paint is the hero alone. The hero paints from the registry
 * compiled into @kletia/core; after it has painted, two groups load in
 * parallel: the live data (the API client, its three requests and the
 * departure board) and the sections below the fold. Neither competes with
 * the hero for the network or the main thread, and both arrive below the
 * fold, so nothing in view moves.
 */
type HomeDataHook = () => HomeData;

interface LiveModules {
  readonly useHomeData: HomeDataHook;
  readonly StatusBoard: React.ComponentType<{ readonly data: HomeData }>;
}

interface BelowFoldModules {
  readonly NetworkStrip: React.ComponentType<NetworkStripProps>;
  readonly HowItWorks: React.ComponentType;
  readonly Pillars: React.ComponentType;
  readonly CodeShowcase: React.ComponentType;
  readonly FeatureGrid: React.ComponentType;
  readonly UseCases: React.ComponentType;
  readonly SecuritySection: React.ComponentType;
  readonly Faq: React.ComponentType<FaqProps>;
  readonly FinalCta: React.ComponentType;
}

const loadLiveModules = (): Promise<LiveModules> =>
  Promise.all([import("./useHomeData"), import("./StatusBoard")]).then(([data, board]) => ({
    useHomeData: data.useHomeData,
    StatusBoard: board.StatusBoard,
  }));

const loadBelowFold = (): Promise<BelowFoldModules> =>
  Promise.all([
    import("./NetworkStrip"),
    import("./HowItWorks"),
    import("./Pillars"),
    import("./CodeShowcase"),
    import("./FeatureGrid"),
    import("./UseCases"),
    import("./SecuritySection"),
    import("./Faq"),
    import("./FinalCta"),
  ]).then(([strip, how, pillars, code, features, cases, security, faq, cta]) => ({
    NetworkStrip: strip.NetworkStrip,
    HowItWorks: how.HowItWorks,
    Pillars: pillars.Pillars,
    CodeShowcase: code.CodeShowcase,
    FeatureGrid: features.FeatureGrid,
    UseCases: cases.UseCases,
    SecuritySection: security.SecuritySection,
    Faq: faq.Faq,
    FinalCta: cta.FinalCta,
  }));

/** Runs `start` after the first paint: the next idle period, or soon after a frame where idle callbacks do not exist. */
function afterFirstPaint(start: () => void): () => void {
  let idle = 0;
  let timer = 0;
  const frame = window.requestAnimationFrame(() => {
    if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(start, { timeout: 1200 });
    else timer = window.setTimeout(start, 200);
  });
  return () => {
    window.cancelAnimationFrame(frame);
    if (idle && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
    window.clearTimeout(timer);
  };
}

/** Loads a module group once the page has painted; null until then (and if the download fails: the page keeps what it has). */
function useAfterPaint<T>(load: () => Promise<T>): T | null {
  const [modules, setModules] = useState<T | null>(null);
  useEffect(() => {
    let active = true;
    const cancel = afterFirstPaint(() => {
      load().then(
        (loaded) => {
          if (active) setModules(() => loaded);
        },
        () => undefined,
      );
    });
    return () => {
      active = false;
      cancel();
    };
  }, [load]);
  return modules;
}

/** Calls the live data hook and hands each new answer to the page (renders nothing itself). */
function LiveData({ useData, onData }: { readonly useData: HomeDataHook; readonly onData: (data: HomeData) => void }) {
  const data = useData();
  const { health, networks, protocols } = data;
  useEffect(() => {
    onData(data);
    // A new answer (or a new request state) of any resource, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health.status, health.updatedAt, networks.status, networks.updatedAt, protocols.status, protocols.updatedAt, onData]);
  return null;
}

/** Below-the-fold sections skip layout and paint until they near the viewport (`contain-intrinsic-size` keeps the scrollbar honest). */
function Deferred({ size, children }: { readonly size: string; readonly children: React.ReactNode }) {
  return <div className={cx("[content-visibility:auto]", size)}>{children}</div>;
}

/** The departure board's place while the live modules load: its own height, so nothing below it moves. */
function StatusBoardSlot() {
  return <div aria-hidden="true" className="min-h-[46rem] border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] sm:min-h-[40rem]" />;
}

/**
 * Home: the route map and its ticket, the departure board, the line index,
 * how a route runs, the ways in, the house rules and the security model.
 * Sections are numbered as platforms (01 to 09).
 */
export default function HomePage() {
  const live = useAfterPaint(loadLiveModules);
  const below = useAfterPaint(loadBelowFold);
  const [data, setData] = useState<HomeData | null>(null);
  const protocols: readonly ProtocolDescriptor[] = data?.liveProtocols ? data.protocols.data! : PROTOCOLS;
  const networkCount = data?.liveNetworks ? data.networks.data!.length : Object.keys(CHAINS).length;
  // Real protocols only: the "custom" entries are the doors for your own contracts and are named separately.
  const counted = countProtocols(protocols);
  const StatusBoard = live?.StatusBoard;
  return (
    <>
      {live ? <LiveData useData={live.useHomeData} onData={setData} /> : null}
      <HeroSection protocols={protocolCountLabel(protocols)} />
      {StatusBoard && data ? <StatusBoard data={data} /> : <StatusBoardSlot />}
      {below ? (
        <>
          <below.NetworkStrip protocols={protocols} />
          <Deferred size="[contain-intrinsic-size:auto_1400px]">
            <below.HowItWorks />
          </Deferred>
          <Deferred size="[contain-intrinsic-size:auto_1300px]">
            <below.Pillars />
          </Deferred>
          <Deferred size="[contain-intrinsic-size:auto_1100px]">
            <below.CodeShowcase />
          </Deferred>
          <Deferred size="[contain-intrinsic-size:auto_1100px]">
            <below.FeatureGrid />
          </Deferred>
          <Deferred size="[contain-intrinsic-size:auto_1100px]">
            <below.UseCases />
          </Deferred>
          <Deferred size="[contain-intrinsic-size:auto_1200px]">
            <below.SecuritySection />
          </Deferred>
          <Deferred size="[contain-intrinsic-size:auto_1300px]">
            <below.Faq networks={networkCount} protocols={counted.protocols} ownContracts={counted.ownContracts} />
          </Deferred>
          <below.FinalCta />
        </>
      ) : (
        // The sections' place until they arrive: at least a screen, so the footer never rises into view and drops.
        <div aria-hidden="true" className="min-h-[100vh]" />
      )}
    </>
  );
}
