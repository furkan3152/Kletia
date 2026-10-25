/**
 * "Everything it does, filed." A binder: index tabs on the left page (a tablist, arrow keys),
 * a deck of five printed feature cards on the right. Tabs, arrows, swipe or drag riffle the
 * deck; it riffles by itself every 4.2 s while in view until touched. The art windows are
 * EXAMPLES of the desk's screens, labelled so on each card.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { animate, EASE } from "../../kit/motion";
import { playSound } from "../../kit/sound";
import { Link } from "../../routes/Link";
import { observeIntersection } from "../../site/motion/useInView";
import { prefersReducedMotion } from "../../site/motion/useReducedMotion";
import { NETWORK_COUNT } from "../../site/networkCount";
import { BinderStack } from "./HomeCard";
import { seedThumbs } from "./homeCardModel";
import { SEED_THUMBS } from "./homeData";
import { Ico } from "./Ico";
import type { HomeIconName } from "./homeIcons";

interface Feature {
  readonly id: string;
  readonly icon: HomeIconName;
  readonly title: string;
  readonly sub: string;
  readonly band: "lime" | "ink" | "blue";
  readonly serial: string;
  readonly art: ReactNode;
  readonly heading: string;
  readonly body: string;
  readonly chips: readonly (readonly [string, boolean?])[];
  readonly link: string;
  readonly to: string;
}

const MOVES = [3, -6, 8, 5, -4, 9, 7, -3, 10, -5, 6, 8, -2, 9, 4, -7, 11, 6, -3, 8];

/** Example candles (static drawing data for the Trade card). */
const CANDLES = MOVES.reduce<{ readonly x: number; readonly open: number; readonly close: number; readonly index: number }[]>((list, move, index) => {
  const previous = list[list.length - 1];
  const open = previous ? previous.close : 120;
  list.push({ x: 14 + index * 17, open, close: open - move, index });
  return list;
}, []);

function Candles() {
  return (
    <g>
      {CANDLES.map(({ x, open, close, index }) => {
        const high = Math.min(open, close) - 6 - (index % 3) * 3;
        const low = Math.max(open, close) + 5 + (index % 4) * 2;
        const up = close < open;
        return (
          <g key={index} className={up ? "k-up" : "k-dn"}>
            <line x1={x + 4} x2={x + 4} y1={high} y2={low} strokeWidth="1.2" style={{ stroke: up ? "var(--up)" : "var(--down)" }} />
            <rect x={x} y={Math.min(open, close)} width="8" height={Math.max(2, Math.abs(open - close))} rx="1.5" />
          </g>
        );
      })}
    </g>
  );
}

const FEATURES: readonly Feature[] = [
  {
    id: "trade",
    icon: "trade",
    title: "Trade",
    sub: "Perps, limit and DCA orders",
    band: "lime",
    serial: "T-01",
    art: (
      <svg viewBox="0 0 380 200" preserveAspectRatio="none">
        <Candles />
        <line className="ln" x1="0" x2="380" y1="70" y2="70" />
        <line className="ln" x1="0" x2="380" y1="160" y2="160" style={{ stroke: "var(--down)" }} />
        <text className="tx" x="8" y="64">
          entry 3,128.40
        </text>
        <text className="tx" x="8" y="154" style={{ fill: "var(--down)" }}>
          liq 2,741.10
        </text>
        <text className="tx2" x="300" y="22">
          ETH-PERP
        </text>
      </svg>
    ),
    heading: "Long, short, limit, DCA.",
    body: "Perps on Hyperliquid, GMX v2 and Drift with one ticket: side, collateral, leverage, one risk sentence. Native limit and recurring orders through Jupiter and CoW.",
    chips: [["Hyperliquid"], ["GMX v2"], ["Drift v2"], ["Limit + DCA", true]],
    link: "Open Trade",
    to: "/app/perps",
  },
  {
    id: "predict",
    icon: "poly",
    title: "Predict",
    sub: "Prediction markets",
    band: "blue",
    serial: "P-01",
    art: (
      <div className="yesno">
        <div className="q">Will ETH close above $3,500 on Oct 31?</div>
        <div className="bar">
          <span className="y" style={{ width: "42%" }}>
            YES 42¢
          </span>
          <span className="n">NO 58¢</span>
        </div>
        <div className="meta">
          <span>Polymarket · Polygon</span>
          <span>example market</span>
        </div>
      </div>
    ),
    heading: "Bet on a sentence.",
    body: "Polymarket from any wallet you already use: Kletia bridges the USDC, buys the shares and files the position. Your Polymarket wallet stays yours.",
    chips: [["Polymarket"], ["Funding from any network", true]],
    link: "Open Predict",
    to: "/app/predict",
  },
  {
    id: "automate",
    icon: "auto",
    title: "Automate",
    sub: "Rules that run while you sleep",
    band: "ink",
    serial: "A-01",
    art: (
      <div className="ttable">
        {(
          [
            ["clock", "Every Friday 09:00", "DCA 100 USDC → ETH on Base", "armed"],
            ["perp", "If ETH < $3,000", "buy 0.1 ETH · limit", "waiting"],
            ["earn", "Idle USDC > 500", "supply to Aave V3", "armed"],
          ] as const
        ).map(([icon, title, sub, state]) => (
          <div className="trow" key={title}>
            <span className="ti">
              <Ico name={icon} />
            </span>
            <span>
              <b>{title}</b>
              <small>{sub}</small>
            </span>
            <span className={state === "armed" ? "st on" : "st"}>{state}</span>
          </div>
        ))}
      </div>
    ),
    heading: "Say it once.",
    body: "Recurring buys, price triggers and idle-cash sweeps, written in plain English. Each run prints a card and asks your wallet, or runs inside an agent's rule book.",
    chips: [["Schedules"], ["Price triggers"], ["Sweeps", true]],
    link: "Open Automate",
    to: "/app/automations",
  },
  {
    id: "portfolio",
    icon: "port",
    title: "Portfolio",
    sub: "Every network, full history, an assistant",
    band: "lime",
    serial: "F-01",
    art: (
      <>
        <svg viewBox="0 0 380 200" preserveAspectRatio="none">
          <path d="M0 150 C40 140 60 120 90 126 S150 96 180 104 240 70 270 78 330 40 380 46" fill="none" stroke="var(--ink)" strokeWidth="2.5" />
          <path d="M0 150 C40 140 60 120 90 126 S150 96 180 104 240 70 270 78 330 40 380 46 V200 H0Z" fill="var(--lime)" opacity=".35" />
          <text className="tx" x="14" y="28" style={{ fontSize: 22 }}>
            $24,815.40
          </text>
          <text className="tx2" x="14" y="46">
            net worth · {NETWORK_COUNT} networks · example
          </text>
        </svg>
        <div className="bub">
          You paid <b>$14.82</b> in fees last month, 61% of it on Ethereum. Want Base by default?
        </div>
      </>
    ),
    heading: "Your money, one page.",
    body: "Net worth across every network, holdings, full history and a binder of every card. Ask the assistant anything: it answers from your own data, and shows its sources.",
    chips: [["History"], ["Holdings"], ["Assistant", true]],
    link: "Open Portfolio",
    to: "/app/dashboard",
  },
  {
    id: "agents",
    icon: "agent",
    title: "Agents",
    sub: "Your AI, with a rule book",
    band: "ink",
    serial: "G-01",
    art: (
      <div className="tree">
        <div className="node" style={{ left: "4%", top: "12%" }}>
          <span className="av" />
          <span>
            you<small>approver</small>
          </span>
        </div>
        <div className="node" style={{ left: "36%", top: "40%" }}>
          <span className="av" />
          <span>
            research-bot<small>500 USDC/day</small>
          </span>
        </div>
        <div className="node" style={{ left: "58%", top: "74%" }}>
          <span className="av" />
          <span>
            payouts<small>sub-agent</small>
          </span>
        </div>
        <svg className="tree-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d="M18 30 C 18 46, 36 44, 40 52" />
          <path d="M52 60 C 54 72, 60 70, 62 80" />
        </svg>
      </div>
    ),
    heading: "Hand it to an agent.",
    body: "Connect Claude, Cursor or your own bot over MCP. Agent keys carry a rule book: caps, recipients, timetable, human approval over a limit. Sub-agents inherit less, never more.",
    chips: [["MCP server"], ["Rule books"], ["Sub-agents", true]],
    link: "Read the agent guide",
    to: "/developers/agents",
  },
];

export function FeatureBinder() {
  const binder = useRef<HTMLDivElement>(null);
  const deck = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLUListElement>(null);
  const [order, setOrder] = useState<number[]>(() => FEATURES.map((_, index) => index));
  const busy = useRef(false);
  const touched = useRef(false);
  const front = order[0]!;

  // Lay the stack out: the front card flat, the ones behind offset, tilted and smaller.
  useEffect(() => {
    const cards = deck.current?.querySelectorAll<HTMLElement>(".fcard");
    if (!cards) return;
    order.forEach((cardIndex, depth) => {
      const card = cards[cardIndex];
      if (!card) return;
      card.style.zIndex = String(20 - depth);
      card.style.opacity = depth < 3 ? "1" : "0";
      const transform = `translate(${depth === 0 ? 0 : depth % 2 ? 10 : -8}px, ${depth * 14}px) rotate(${depth === 0 ? 0 : depth % 2 ? 2.4 : -2}deg) scale(${1 - depth * 0.025})`;
      if (!prefersReducedMotion() && card.style.transform && card.style.transform !== transform) {
        animate(card, [{ transform: card.style.transform }, { transform }], { duration: 450, easing: EASE.back(1.4) });
      }
      card.style.transform = transform;
    });
  }, [order]);

  const riffleTo = useCallback(
    (target: number) => {
      if (busy.current || target === order[0]) return;
      const count = FEATURES.length;
      const forward = (target - order[0]! + count) % count <= count / 2;
      const cards = deck.current?.querySelectorAll<HTMLElement>(".fcard");
      const next = order.slice();
      while (next[0] !== target) {
        if (forward) next.push(next.shift()!);
        else next.unshift(next.pop()!);
      }
      playSound("riffle", 0.6);
      if (prefersReducedMotion() || !cards) {
        setOrder(next);
        return;
      }
      busy.current = true;
      if (forward) {
        const leaving = cards[order[0]!];
        animate(leaving, [{ transform: leaving?.style.transform ?? "none", opacity: 1 }, { transform: "perspective(1400px) translateY(-40px) rotateX(-105deg)", opacity: 0 }], { duration: 320, easing: EASE.in(2) });
        window.setTimeout(() => {
          setOrder(next);
          busy.current = false;
        }, 300);
      } else {
        setOrder(next);
        window.requestAnimationFrame(() => {
          const arriving = cards[target];
          animate(arriving, [{ transform: "perspective(1400px) translateY(-40px) rotateX(-105deg)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 380, easing: EASE.back(1.3) });
          busy.current = false;
        });
      }
    },
    [order],
  );

  const riffleRef = useRef(riffleTo);
  const orderRef = useRef(order);
  useEffect(() => {
    riffleRef.current = riffleTo;
    orderRef.current = order;
  });

  // Auto-riffle every 4.2 s while half the binder is in view, until someone touches it.
  useEffect(() => {
    const element = binder.current;
    if (!element || prefersReducedMotion()) return undefined;
    let timer = 0;
    const stop = observeIntersection(
      element,
      (entry) => {
        window.clearInterval(timer);
        if (entry.isIntersecting && !touched.current) {
          timer = window.setInterval(() => {
            if (!touched.current && !document.hidden) riffleRef.current((orderRef.current[0]! + 1) % FEATURES.length);
          }, 4200);
        }
      },
      { threshold: 0.5 },
    );
    return () => {
      stop();
      window.clearInterval(timer);
    };
  }, []);
  const touch = () => {
    touched.current = true;
  };
  const startX = useRef<number | null>(null);

  return (
    <section className="sec" id="features" aria-labelledby="features-heading">
      <div className="wrap">
        <div className="sec-h">
          <div>
            <div className="sec-k">
              <span className="led">03</span>
              <span className="silk">What the desk does</span>
            </div>
            <h2 className="sec-t" id="features-heading">
              Everything it does, <em>filed.</em>
            </h2>
          </div>
          <p className="sec-p">Trade, predict, automate, keep track and hand it to agents. Riffle the binder: each card is a part of the desk you can open today.</p>
        </div>
        <div className="binder rv" ref={binder} onPointerDown={touch}>
          <div className="bpage l">
            <span className="silk">Index</span>
            <ul className="tabs" role="tablist" aria-label="Features" ref={tabs}>
              {FEATURES.map((feature, index) => (
                <li role="presentation" key={feature.id}>
                  <button
                    type="button"
                    role="tab"
                    id={`feature-tab-${feature.id}`}
                    aria-selected={index === front}
                    aria-controls="feature-deck"
                    tabIndex={index === front ? 0 : -1}
                    onClick={() => {
                      touch();
                      playSound("key", 0.8);
                      riffleTo(index);
                    }}
                    onKeyDown={(event) => {
                      if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                      event.preventDefault();
                      touch();
                      const n = FEATURES.length;
                      const next = event.key === "Home" ? 0 : event.key === "End" ? n - 1 : (front + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + n) % n;
                      riffleTo(next);
                      window.setTimeout(() => tabs.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus(), 10);
                    }}
                  >
                    <span className="tg" aria-hidden="true">
                      <Ico name={feature.icon} />
                    </span>
                    <span>
                      <b>{feature.title}</b>
                      <small>{feature.sub}</small>
                    </span>
                    <span className="ix" aria-hidden="true">
                      0{index + 1}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="bnote">
              <BinderStack label="Your binder" thumbs={seedThumbs(SEED_THUMBS, 41)} count={41} className="bnote-stack" />
              <p>Your own binder fills as you sign: every settled move becomes a card with its route, amounts, links and signed receipt.</p>
            </div>
            <div className="riffle-hint" aria-hidden="true">
              <kbd>←</kbd>
              <kbd>→</kbd> riffle · or drag the card
            </div>
          </div>
          <div className="rings" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="bpage r">
            <div
              className="deck"
              id="feature-deck"
              role="tabpanel"
              aria-labelledby={`feature-tab-${FEATURES[front]!.id}`}
              ref={deck}
              onPointerDown={(event) => {
                startX.current = event.clientX;
              }}
              onPointerUp={(event) => {
                if (startX.current === null) return;
                const distance = event.clientX - startX.current;
                startX.current = null;
                if (Math.abs(distance) > 40) riffleTo((front + (distance < 0 ? 1 : -1) + FEATURES.length) % FEATURES.length);
              }}
            >
              {FEATURES.map((feature, index) => (
                <article
                  key={feature.id}
                  className="fcard"
                  aria-hidden={index !== front}
                  {...(index !== front ? { inert: "" } : {})}
                  onPointerMove={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    event.currentTarget.style.setProperty("--mx", `${((event.clientX - rect.left) / rect.width) * 100}%`);
                  }}
                >
                  <div className={`pc-top band-${feature.band}`}>
                    <span>{feature.title}</span>
                    <span className="ser">{feature.serial}</span>
                  </div>
                  <div className="pc-art">
                    <span className="foil" aria-hidden="true" />
                    <div className="fart" aria-hidden="true">
                      {feature.art}
                    </div>
                    <span className="fart-k">Example</span>
                  </div>
                  <div className="fbody">
                    <h3>{feature.heading}</h3>
                    <p>{feature.body}</p>
                    <div className="chips">
                      {feature.chips.map(([chip, lime]) => (
                        <span key={chip} className={lime ? "chip l" : "chip"}>
                          {chip}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="ffoot">
                    <span>
                      card {index + 1} of {FEATURES.length}
                    </span>
                    <Link to={feature.to}>
                      {feature.link}
                      <Ico name="arr" />
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
