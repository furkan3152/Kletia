/**
 * "One sentence. Four stops." The pinned scroll story: a sticky stage scrubbed by scroll
 * (3.2 viewports). One function draws the whole stage for a story time t in [0, 4] (say, plan,
 * sign, filed), so scrolling back simply draws an earlier t. Sounds fire only when scrolling
 * forward past a cue. No GSAP: a rAF loop eases the drawn time towards the scroll position, and
 * only while the story is on screen. Under reduced motion there is no pin: every step shows and
 * the stage is drawn once, settled.
 *
 * The stage is an EXAMPLE (amounts, hashes, serials); the text column is the real content.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { keyClass } from "../../kit/keyClass";
import { Led } from "../../kit/Parts";
import { playSound, type SoundName } from "../../kit/sound";
import { observeIntersection } from "../../site/motion/useInView";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { BinderStack, PlanCard } from "./HomeCard";
import { nodeXs, RAIL_Y, seedThumbs, type CardPhase, type ThumbData } from "./homeCardModel";
import { HERO_INTENTS, SEED_THUMBS } from "./homeData";
import { progress } from "./homeMotion";
import { Ico } from "./Ico";

const STORY = HERO_INTENTS[1]!;
const SERIAL = 42;
const SENTENCE = STORY.text;
const CUES: readonly (readonly [number, SoundName])[] = [
  [0.9, "send"], [1.12, "step"], [1.24, "step"], [1.36, "step"], [1.4, "motor"], [1.52, "step"], [1.64, "slide"], [1.78, "pen"],
  [1.8, "leg1"], [1.86, "leg2"], [1.91, "leg3"], [1.96, "leg3"], [2.02, "key"], [2.14, "request"], [2.42, "key"], [2.6, "hop"],
  [2.74, "stepok"], [2.85, "hop"], [3.0, "stepok"], [3.52, "slide"], [3.84, "drop"],
];
const STAGE_LABELS = ["Keyboard module · listening", "Planner · 14 routes compared", "Signing · your wallet, step by step", "Binder · filed with a signed receipt"];
const STATIC_T = 3.3;
const FILED_AT = 3.84;

const STEPS = [
  { n: "01 · say", h: "Say it.", p: "Plain English, any wallet, any network. “Move 1,500 USDC from Arbitrum to Base, half to ETH” is enough. Ask questions too." },
  { n: "02 · plan", h: "It prints.", p: "Kletia reads your balances, runs an auction across bridges and venues, simulates the winner and prints it: what you pay, the least you get, fees, time." },
  { n: "03 · sign", h: "You sign.", p: "The card latches the exact amounts it showed you. Your wallet signs each step; Kletia never holds keys or funds." },
  { n: "04 · settled", h: "It's filed.", p: "Settled on chain, stamped, and filed in your binder with a signed receipt and every transaction link." },
] as const;

const WORK = [
  ["Reading your balances", "0.3 s"],
  ["Comparing routes across bridges", "1.4 s"],
  ["Simulating the winner", "2.6 s"],
] as const;

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const backOut = (p: number, s = 1.6) => 1 + (s + 1) * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2);

function phaseAt(t: number): CardPhase {
  if (t < 2.06) return "printed";
  if (t < 2.12) return "sealed";
  if (t < 3.02) return "signing";
  return "settled";
}

export function StoryTrack() {
  const reduced = useReducedMotion();
  const story = useRef<HTMLDivElement>(null);
  const stepsList = useRef<HTMLDivElement>(null);
  const typed = useRef<HTMLSpanElement>(null);
  const send = useRef<HTMLSpanElement>(null);
  const work = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const cardBox = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const wallet = useRef<HTMLDivElement>(null);
  const receipt = useRef<HTMLDivElement>(null);
  const tray = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const token = useRef<HTMLSpanElement>(null);

  const [stage, setStage] = useState(reduced ? 3 : 0);
  const [phase, setPhase] = useState<CardPhase>(reduced ? phaseAt(STATIC_T) : "printed");
  const [filed, setFiled] = useState(false);
  const [thumbs, setThumbs] = useState<ThumbData[]>(() => seedThumbs(SEED_THUMBS, 41));
  const last = useRef({ stage: -1, phase: "" as CardPhase | "", filed: false, t: 0 });
  const draw = useRef<(t: number) => void>(() => undefined);

  useLayoutEffect(() => {
    draw.current = (t: number) => {
      const card = wrap.current;
      const svg = card?.querySelector("svg.route") ?? null;
      const nodes = svg ? [...svg.querySelectorAll<SVGGElement>(".node")] : [];
      const rail = svg?.querySelector<SVGPathElement>(".rail") ?? null;
      const railFill = svg?.querySelector<SVGPathElement>(".rail-f") ?? null;
      const coin = svg?.querySelector<SVGGElement>(".coin") ?? null;
      const xs = nodeXs(STORY);

      // say: typing, the send key
      if (typed.current) typed.current.textContent = SENTENCE.slice(0, Math.round(progress(t, 0.05, 0.83) * SENTENCE.length));
      send.current?.toggleAttribute("data-pressed", t > 0.9 && t < 0.98);

      // plan: work rows tick, the card prints from the slot, the route plots
      work.current?.querySelectorAll<HTMLElement>(".wrow").forEach((row, k) => {
        const p = progress(t, 1.0 + k * 0.12, 1.08 + k * 0.12);
        row.style.opacity = String(p);
        row.style.transform = `translateX(${(1 - p) * -10}px)`;
        row.classList.toggle("done", t >= 1.12 + k * 0.12);
      });
      let y = -104;
      if (t >= 1.4) y = lerp(-104, -70, progress(t, 1.4, 1.5));
      if (t >= 1.52) y = lerp(-70, -40, progress(t, 1.52, 1.62));
      if (t >= 1.64) y = lerp(-40, 0, backOut(progress(t, 1.64, 1.78), 1.3));
      if (rail) rail.style.strokeDashoffset = String(1 - progress(t, 1.78, 1.98));
      nodes.forEach((node, k) => {
        node.style.transform = `scale(${Math.max(0, backOut(progress(t, 1.78 + k * 0.055, 1.84 + k * 0.055), 2))})`;
      });

      // sign: key, latch (React phase), wallet sheet, the coin rides
      card?.querySelector(".sign")?.toggleAttribute("data-pressed", t > 2.02 && t < 2.08);
      if (wallet.current) {
        const p = t < 2.42 ? progress(t, 2.14, 2.24) : 1 - progress(t, 2.42, 2.5);
        wallet.current.style.opacity = String(p);
        wallet.current.style.transform = t < 2.42 ? `translateY(${(1 - p) * 20}px) scale(${0.95 + 0.05 * p})` : `translateY(${(1 - p) * 14}px)`;
      }
      const ride = progress(t, 2.5, 2.95);
      if (coin) {
        coin.setAttribute("opacity", t >= 2.5 && t < 2.96 ? "1" : "0");
        coin.setAttribute("transform", `translate(${xs[0]! + (xs[xs.length - 1]! - xs[0]!) * ride} ${RAIL_Y})`);
      }
      if (railFill) railFill.style.strokeDashoffset = String(1 - ride);
      const bars = card ? [...card.querySelectorAll<HTMLElement>(".pc-steps b")] : [];
      bars.forEach((bar, k) => {
        const seg = 1 / bars.length;
        bar.style.width = `${Math.max(0, Math.min(1, (ride - k * seg) / seg)) * 100}%`;
      });
      card?.querySelector(".k-latch")?.classList.toggle("ok", t >= 3.0);

      // settled: stamp (React phase), the card flies into the binder, the receipt prints
      if (card) {
        let x = 0;
        let fy = 0;
        let scale = 1;
        let rotate = 0;
        let opacity = 1;
        if (t >= 3.45) fy = -12 * progress(t, 3.45, 3.51);
        if (t >= 3.52 && cardBox.current && tray.current) {
          const a = cardBox.current.getBoundingClientRect();
          const b = tray.current.getBoundingClientRect();
          const s = a.width / (cardBox.current.offsetWidth || 1) || 1;
          const tx = (b.left + b.width / 2 - (a.left + a.width / 2)) / s;
          const ty = (b.top + 30 - (a.top + a.height / 2)) / s;
          const p = Math.pow(progress(t, 3.52, 3.82), 3);
          x = tx * p;
          fy = lerp(-12, ty, p);
          scale = lerp(1, 0.12, p);
          rotate = -14 * p;
        }
        if (t >= 3.8) opacity = 1 - progress(t, 3.8, 3.84);
        card.style.transform = `translate(${x}px, ${fy}px) translateY(${y}%) scale(${scale}) rotate(${rotate}deg)`;
        card.style.opacity = String(opacity);
      }
      if (receipt.current) {
        const p = progress(t, 3.86, 3.98);
        receipt.current.style.opacity = String(p);
        receipt.current.style.transform = `translateY(${(1 - backOut(p)) * -30}px) scaleY(${0.4 + 0.6 * p})`;
      }
      if (ghost.current) ghost.current.style.opacity = t < 1.36 || t >= FILED_AT ? "1" : "0";

      // the rail of steps and the $ token
      const p = t / 4;
      if (fill.current) fill.current.style.height = `calc(${p * 100}% - ${p * 20}px)`;
      if (token.current && stepsList.current) token.current.style.transform = `translateY(${p * (stepsList.current.offsetHeight - 24)}px)`;

      // React state only when it changes
      const nextStage = Math.min(3, Math.floor(t));
      const nextPhase = phaseAt(t);
      const nextFiled = t >= FILED_AT;
      if (nextStage !== last.current.stage) setStage(nextStage);
      if (nextPhase !== last.current.phase) setPhase(nextPhase);
      if (nextFiled !== last.current.filed) {
        setFiled(nextFiled);
        setThumbs(nextFiled ? [...seedThumbs(SEED_THUMBS, 41).slice(-2), { id: "story-42", kind: STORY.thumb[0], serial: SERIAL, title: STORY.thumb[1], sub: STORY.thumb[2] }] : seedThumbs(SEED_THUMBS, 41));
      }
      last.current = { stage: nextStage, phase: nextPhase, filed: nextFiled, t };
    };
  });

  useEffect(() => {
    const element = story.current;
    if (!element) return undefined;
    if (reduced) {
      draw.current(STATIC_T);
      return undefined;
    }
    draw.current(0);
    let raf = 0;
    let shown = 0;
    let lastFrame = performance.now();
    let active = false;
    const navHeight = () => (document.querySelector(".hm .nav") as HTMLElement | null)?.offsetHeight ?? 72;
    const target = () => {
      const rect = element.getBoundingClientRect();
      const distance = window.innerHeight * 3.2;
      return 4 * Math.max(0, Math.min(1, (navHeight() - rect.top) / distance));
    };
    const loop = (now: number) => {
      raf = 0;
      const goal = target();
      const dt = Math.min(64, now - lastFrame);
      lastFrame = now;
      const next = Math.abs(goal - shown) < 0.002 ? goal : shown + (goal - shown) * (1 - Math.exp(-dt / 150));
      if (next > shown) {
        for (const [at, name] of CUES) if (at > shown && at <= next) playSound(name);
        const before = Math.round(progress(shown, 0.05, 0.83) * SENTENCE.length);
        const after = Math.round(progress(next, 0.05, 0.83) * SENTENCE.length);
        if (after > before && next < 0.9) playSound("type", 0.45);
      }
      if (next !== shown) {
        shown = next;
        draw.current(shown);
      }
      if (active || shown !== goal) raf = window.requestAnimationFrame(loop);
    };
    const kick = () => {
      if (!raf) {
        lastFrame = performance.now();
        raf = window.requestAnimationFrame(loop);
      }
    };
    const stop = observeIntersection(element, (entry) => {
      active = entry.isIntersecting;
      if (active) kick();
    });
    window.addEventListener("scroll", kick, { passive: true });
    window.addEventListener("resize", kick);
    shown = target();
    draw.current(shown);
    return () => {
      stop();
      window.removeEventListener("scroll", kick);
      window.removeEventListener("resize", kick);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [reduced]);

  const shownStage = reduced ? 3 : stage;
  return (
    <section className="how" id="how-it-works" aria-labelledby="how-heading">
      <span id="product" className="anchor" />
      <div className="wrap">
        <div className="sec-h">
          <div>
            <div className="sec-k">
              <span className="led">01</span>
              <span className="silk">How it works</span>
            </div>
            <h2 className="sec-t" id="how-heading">
              One sentence. <em>Four stops.</em>
            </h2>
          </div>
          <p className="sec-p">Every request runs the same line: you say it, the machine plans and prints it, your wallet signs, and the card is stamped when it lands on chain.</p>
        </div>
        <div className={reduced ? "story is-static" : "story"} ref={story}>
          <div className="story-pin">
            <div className="steps" ref={stepsList}>
              <span className="fill" ref={fill} aria-hidden="true" />
              <span className="tok" ref={token} aria-hidden="true">
                $
              </span>
              <ol>
              {STEPS.map((step, index) => (
                <li key={step.n} className={reduced || index === shownStage ? "step on" : "step"}>
                  <span className="sn">{step.n}</span>
                  <h3>{step.h}</h3>
                  <p>{step.p}</p>
                </li>
              ))}
              </ol>
            </div>
            <div className="st-stage" aria-hidden="true">
              <span className="vent" />
              <div className="st-lbl">
                <Led tone={shownStage === 2 ? "blue" : "on"} />
                <span className="eng">Example · {STAGE_LABELS[shownStage]}</span>
              </div>
              <div className="sx-keyb">
                <div className="keyb">
                  <div className="scr">
                    <span ref={typed} />
                    <span className="caret" />
                  </div>
                  <span className={keyClass({ tone: "lime" })} ref={send}>
                    <Ico name="send" />
                  </span>
                </div>
              </div>
              <div className="sx-work" ref={work}>
                {WORK.map(([text, time]) => (
                  <div className="wrow" key={text} style={{ opacity: 0 }}>
                    <span className="ring" />
                    <span>{text}</span>
                    <span className="t">{time}</span>
                  </div>
                ))}
              </div>
              <span className="sx-slot" />
              <div className="sx-clip">
                <div className="sx-ghost" ref={ghost}>
                  <span>{filed ? `#00${SERIAL} filed · receipt signed` : "card prints here"}</span>
                </div>
                <div className="sx-card" ref={cardBox}>
                  <div className="pc-wrap" ref={wrap} style={{ transform: "translateY(-104%)" }}>
                    <PlanCard intent={STORY} serial={SERIAL} phase={phase} />
                  </div>
                </div>
              </div>
              <div className="sx-wallet">
                <div className="wreq" ref={wallet} style={{ opacity: 0 }}>
                  <div className="wh">
                    <span className="av" />
                    Wallet · 0x7a3f…c91e
                  </div>
                  <p>
                    Sign step 1 of 2
                    <br />
                    Bridge on Arbitrum
                  </p>
                  <span className={keyClass({ tone: "lime", size: "sm" })}>Approve</span>
                </div>
              </div>
              <div className="sx-binder">
                <BinderStack thumbs={thumbs} count={filed ? 42 : 41} trayRef={tray} />
              </div>
              <div className="sx-receipt" ref={receipt} style={{ opacity: 0 }}>
                <b>Receipt #00{SERIAL}</b> · signed (example)
                <br />
                digest 9f2c…41ab
                <br />
                Arbitrum 0x5e1d…77a0 · Base 0x0b3c…e912
                <br />
                landed 749.20 USDC + 0.2394 ETH
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
