/**
 * Coverage: the cartridge bay (one cartridge per registry network, readouts from GET /v1/health)
 * and the station index (every real protocol in the registry, filterable by category).
 */
import type { NetworkKey, ProtocolDescriptor } from "@kletia/core";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { Segmented } from "../../kit/Controls";
import { keyClass } from "../../kit/keyClass";
import { animate, EASE, tilt } from "../../kit/motion";
import { Odometer } from "../../kit/Parts";
import { playSound } from "../../kit/sound";
import { Link } from "../../routes/Link";
import { observeIntersection } from "../../site/motion/useInView";
import { prefersReducedMotion } from "../../site/motion/useReducedMotion";
import { countWordTitle, NETWORK_COUNT, PRODUCTION_NETWORK_COUNT, TEST_NETWORK_COUNT, countWord } from "../../site/networkCount";
import { realProtocols } from "../../site/protocolCount";
import { numberWord, CATEGORY_FILTER, CATEGORY_ICON, isTestNetwork, NET_COLOR, NET_ICON, NET_ORDER, netName, PROTOCOL_ICON, protocolsOn, STATION_FILTERS, type StationFilter } from "./homeData";
import { cartridgeReadout, readingsByKey, utcClock } from "./homeLive";
import type { HomeLive } from "./homeLive";
import { Ico } from "./Ico";

const PHONE_LIMIT = 12;


export function Coverage({ live, protocols }: { readonly live: HomeLive; readonly protocols: readonly ProtocolDescriptor[] }) {
  const stations = useMemo(() => realProtocols(protocols), [protocols]);
  return (
    <section className="sec" id="coverage" aria-labelledby="coverage-heading">
      <div className="wrap">
        <div className="sec-h">
          <div>
            <div className="sec-k">
              <span className="led">02</span>
              <span className="silk">Coverage</span>
            </div>
            <h2 className="sec-t" id="coverage-heading">
              {countWordTitle(NETWORK_COUNT)} cartridges. <em>{numberWord(stations.length)}</em> stations.
            </h2>
          </div>
          <p className="sec-p">
            Each network is a cartridge in the bay: {countWord(PRODUCTION_NETWORK_COUNT)} mainnets and {countWord(TEST_NETWORK_COUNT)} test networks, EVM and Solana wallets at the same time. Protocols are the stations on the track. Hover a cartridge to eject it.
          </p>
        </div>
        <CartridgeBay live={live} stations={stations} />
        <StationIndex stations={stations} />
      </div>
    </section>
  );
}

function CartridgeBay({ live, stations }: { readonly live: HomeLive; readonly stations: readonly ProtocolDescriptor[] }) {
  const root = useRef<HTMLDivElement>(null);
  const [seated, setSeated] = useState(prefersReducedMotion());
  const readings = readingsByKey(live.report);
  const clock = utcClock(live.report?.time ?? live.at);

  useEffect(() => {
    const element = root.current;
    if (!element || seated) return undefined;
    const carts = [...element.querySelectorAll<HTMLElement>(".xcart")];
    carts.forEach((cart) => {
      cart.style.opacity = "0";
      cart.style.translate = "0 -300px";
    });
    const stop = observeIntersection(
      element,
      (entry) => {
        if (!entry.isIntersecting) return;
        stop();
        carts.forEach((cart, index) => {
          cart.style.opacity = "";
          cart.style.translate = "";
          animate(cart, [{ translate: "0 -300px", opacity: 0 }, { translate: "0 0", opacity: 1 }], { duration: 550, delay: index * 90, easing: EASE.back(1.4) });
          window.setTimeout(() => playSound("swap", 0.7), 450 + index * 90);
        });
        window.setTimeout(() => setSeated(true), 450 + carts.length * 90);
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    return stop;
  }, [seated]);

  const status = live.state === "live" ? `Readouts: GET /v1/health${clock ? ` at ${clock}` : ""}` : live.state === "loading" ? "Reading GET /v1/health…" : "Status unavailable: the API did not answer from this browser";
  return (
    <div className="baywrap rv" ref={root}>
      <div className="bw-h">
        <span className="ledot on" />
        <span>Cartridge bay</span>
        <span className="sp" />
        <span>{seated ? `all ${NETWORK_COUNT} seated` : "seating…"}</span>
      </div>
      <ul className="slots" aria-label="Networks">
        {NET_ORDER.map((key) => (
          <Cartridge key={key} netKey={key} protocols={protocolsOn(key, stations)} readout={cartridgeReadout(key, readings.get(key), live.state)} />
        ))}
      </ul>
      <div className="bay-foot">
        <span role="status">{status}</span>
        <Link to="/networks">EVM · SVM · one text box · network status →</Link>
      </div>
    </div>
  );
}

function Cartridge({ netKey, protocols, readout }: { readonly netKey: NetworkKey; readonly protocols: number; readonly readout: ReturnType<typeof cartridgeReadout> }) {
  const test = isTestNetwork(netKey);
  const name = netName(netKey);
  return (
    <li className="bslot" onPointerEnter={() => playSound("slide", 0.5)}>
      <div
        className={test ? "xcart test" : "xcart"}
        style={{ "--nc": NET_COLOR[netKey] } as CSSProperties}
        tabIndex={0}
        aria-label={`${name}${test ? ", test network" : ""}: ${protocols} protocols, ${readout.status}${readout.lines[0] && readout.lamp === "on" ? `, ${readout.lines.filter(Boolean).join(", ")}` : ""}`}
      >
        <span className="grip" />
        <div className="lab">
          <Ico name={NET_ICON[netKey]} />
          <b>{name}</b>
        </div>
        <div className="rd num" aria-hidden="true">
          {readout.lines[0]}
          <br />
          {readout.lines[1] || " "}
          <br />
          {protocols} protocols
        </div>
        <div className="led-row" aria-hidden="true">
          <span>{test ? "test" : "mainnet"}</span>
          <span className="ledot" data-lamp={readout.lamp} />
        </div>
      </div>
    </li>
  );
}

function StationIndex({ stations }: { readonly stations: readonly ProtocolDescriptor[] }) {
  const root = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<StationFilter>("all");
  const [expanded, setExpanded] = useState(false);
  const [shownCount, setShownCount] = useState(prefersReducedMotion() ? stations.length : 0);
  const matches = (protocol: ProtocolDescriptor) => filter === "all" || CATEGORY_FILTER[protocol.category] === filter;
  const count = stations.filter(matches).length;

  // The count rolls up and the tiles flip in the first time the index shows.
  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    if (prefersReducedMotion()) return undefined;
    const stop = observeIntersection(
      element,
      (entry) => {
        if (!entry.isIntersecting) return;
        stop();
        setShownCount(stations.length);
        element.querySelectorAll<HTMLElement>(".pt").forEach((tile, index) => {
          animate(tile, [{ opacity: 0, transform: "translateY(18px) rotateX(-30deg)" }, { opacity: 1, transform: "none" }], { duration: 500, delay: index * 12, easing: EASE.outPow(3) });
        });
      },
      { rootMargin: "0px 0px -15% 0px" },
    );
    return stop;
  }, [stations.length]);

  // Pointer tilt with the foil band.
  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const cleanups = [...element.querySelectorAll<HTMLElement>(".pt")].map((tile) => tilt(tile, 14));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [stations]);

  const extras = new Set<string>();
  stations.filter(matches).slice(PHONE_LIMIT).forEach((protocol) => extras.add(protocol.id));
  return (
    <div className="pindex" ref={root}>
      <div className="pi-h">
        <h3>
          <Odometer value={String(shownCount > 0 ? count : 0)} /> stations, one index.
        </h3>
        <Segmented
          className="seg-lime"
          ariaLabel="Filter protocols by category"
          options={STATION_FILTERS.map((option) => ({ id: option.id, label: option.label }))}
          value={filter}
          onChange={(next) => {
            setFilter(next);
            playSound("chip");
            if (prefersReducedMotion()) return;
            window.requestAnimationFrame(() => {
              root.current?.querySelectorAll<HTMLElement>(".pt:not(.dim)").forEach((tile, index) => {
                animate(tile, [{ translate: "0 8px" }, { translate: "0 0" }], { duration: 350, delay: (index % 12) * 12, easing: EASE.back(2) });
              });
            });
          }}
        />
      </div>
      <ul className={expanded ? "ptiles" : "ptiles collapsed"} aria-label={`${count} protocols`}>
        {stations.map((protocol, index) => {
          const on = matches(protocol);
          const extra = extras.has(protocol.id);
          const nets = protocol.networks.filter((key) => !isTestNetwork(key));
          const icon = PROTOCOL_ICON[protocol.id] ?? CATEGORY_ICON[protocol.category];
          return (
            <li key={protocol.id} className={["pt", on ? "" : "dim", extra ? "extra" : ""].filter(Boolean).join(" ")} tabIndex={on ? 0 : -1} aria-hidden={on ? undefined : true} aria-label={`${protocol.name}: ${nets.length ? nets.map((key) => netName(key)).join(", ") : protocol.networks.map((key) => netName(key)).join(", ")}`}>
              <span className="foil" aria-hidden="true" />
              <span className="pg" aria-hidden="true">
                <Ico name={icon} />
              </span>
              <b aria-hidden="true">{protocol.name}</b>
              <small aria-hidden="true">
                <span className="dots">
                  {(nets.length ? nets : protocol.networks).map((key) => (
                    <i key={key} style={{ "--c": NET_COLOR[key] } as CSSProperties} />
                  ))}
                </span>
                {(nets.length ? nets : protocol.networks).length} net{(nets.length ? nets : protocol.networks).length > 1 ? "s" : ""}
              </small>
              <span className="no" aria-hidden="true">
                P·{String(index + 1).padStart(2, "0")}
              </span>
            </li>
          );
        })}
      </ul>
      {!expanded && count > PHONE_LIMIT ? (
        <button type="button" className={keyClass({}, "pi-more")} onClick={() => setExpanded(true)}>
          Show all {count} stations
        </button>
      ) : null}
      <p className="pi-foot">
        From the @kletia/core registry: {stations.length} protocols, plus your own contracts.{" "}
        <Link to="/protocols">Every protocol, its networks and actions →</Link>
      </p>
    </div>
  );
}
