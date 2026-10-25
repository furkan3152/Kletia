/**
 * Hero: "Say it. Sign it. Done." and the K-01 print bed. The machine on the bed loops four
 * EXAMPLE intents (type, plan, print, plot, sign, ride, settle, file), driven by a tiny async
 * script of WAAPI animations and CSS classes, paused off screen and in background tabs. Under
 * reduced motion it shows the settled bridge card and never moves.
 *
 * Copy and stats are real: network and protocol counts from the @kletia/core registry, and the
 * "answering now" count from GET /v1/health once it arrives (an em dash until then).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { keyClass } from "../../kit/keyClass";
import { animate, EASE } from "../../kit/motion";
import { Odometer } from "../../kit/Parts";
import { playSound, type SoundName } from "../../kit/sound";
import { Link } from "../../routes/Link";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { NETWORK_COUNT } from "../../site/networkCount";
import { BED_DITHER } from "./dither";
import { BinderStack, PlanCard } from "./HomeCard";
import { nodeXs, RAIL_Y, seedThumbs, serialOf, type CardPhase, type ThumbData } from "./homeCardModel";
import { deskHref, HERO_INTENTS, NET_COLOR, NET_ICON, netName, SEED_THUMBS, type HeroIntent } from "./homeData";
import { isPhone, pausableClock, useDither, useOnScreen } from "./homeMotion";
import { Ico } from "./Ico";
import type { NetworkKey } from "@kletia/core";

const BAY: readonly NetworkKey[] = ["arbitrum", "base", "solana", "polygon"];
const STILL = 1; // the bridge + swap card, shown settled under reduced motion

export interface HeroMachineProps {
  /** Real protocols in the registry (or the live /v1/protocols answer). */
  readonly protocols: number;
  /** "8/9" networks answering GET /v1/health; null until the first answer (or when it fails). */
  readonly answering: string | null;
}

interface Cycle {
  readonly index: number;
  readonly phase: CardPhase;
  readonly plotted: boolean;
}

export function HeroMachine({ protocols, answering }: HeroMachineProps) {
  const reduced = useReducedMotion();
  const root = useRef<HTMLElement>(null);
  const bed = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mach = useRef<HTMLDivElement>(null);
  const typed = useRef<HTMLSpanElement>(null);
  const keyb = useRef<HTMLDivElement>(null);
  const send = useRef<HTMLSpanElement>(null);
  const lcd = useRef<HTMLDivElement>(null);
  const lcdR = useRef<HTMLSpanElement>(null);
  const mouth = useRef<HTMLSpanElement>(null);
  const out = useRef<HTMLDivElement>(null);
  const wreq = useRef<HTMLDivElement>(null);
  const wreqP = useRef<HTMLParagraphElement>(null);
  const wreqK = useRef<HTMLSpanElement>(null);
  const tray = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const bay = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(bed, 0.15);

  const [cycle, setCycle] = useState<Cycle>({ index: STILL, phase: "settled", plotted: true });
  const [thumbs, setThumbs] = useState<ThumbData[]>(() => seedThumbs(SEED_THUMBS, 41));
  const [count, setCount] = useState(41);
  const [rolled, setRolled] = useState(false);
  const stats: readonly [string, string] = reduced || rolled ? [String(NETWORK_COUNT), String(protocols)] : ["0", "0"];
  const intent = HERO_INTENTS[cycle.index]!;

  useDither(canvas, BED_DITHER);

  // Stats count up once (odometers roll from 0 to the registry values).
  useEffect(() => {
    const timer = window.setTimeout(() => setRolled(true), 400);
    return () => window.clearTimeout(timer);
  }, []);

  // Headline entrance: the lines are visible from the first frame (LCP), they settle 0.25 em; the slab springs.
  useLayoutEffect(() => {
    if (reduced || !root.current) return;
    root.current.querySelectorAll(".hero-h .ln > span").forEach((line, index) => {
      animate(line, [{ transform: "translateY(0.22em)" }, { transform: "none" }], { duration: 900, delay: 60 + index * 90, easing: EASE.outPow(4) });
    });
    animate(root.current.querySelector(".hero-h .done"), [{ transform: "rotate(-6deg) scale(.9)" }, { transform: "none" }], { duration: 1000, delay: 380, easing: EASE.elastic(1, 0.45) });
    root.current.querySelectorAll(".bed .stk").forEach((sticker, index) => {
      animate(sticker, [{ scale: "0", rotate: "30deg" }, { scale: "1", rotate: "0deg" }], { duration: 600, delay: 800 + index * 120, easing: EASE.back(2.2) });
    });
  }, [reduced]);

  const label$ = useCallback((text: string) => {
    if (label.current) label.current.textContent = text;
  }, []);

  // The loop.
  useEffect(() => {
    if (reduced) return undefined;
    const clock = pausableClock(() => onScreen.current === true && !document.hidden);
    const { sleep } = clock;
    const frame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const play = (name: SoundName, volume = 1) => {
      if (!clock.stopped && onScreen.current) playSound(name, volume);
    };
    const set = (element: HTMLElement | null, text: string) => {
      if (element) element.textContent = text;
    };
    const press = async (element: Element | null, ms = 140) => {
      element?.setAttribute("data-pressed", "");
      await sleep(ms);
      element?.removeAttribute("data-pressed");
    };
    const lightBay = (nets: readonly NetworkKey[] | null) => {
      bay.current?.querySelectorAll<HTMLElement>(".cart").forEach((cart) => {
        cart.classList.toggle("is-on", Boolean(nets?.includes(cart.dataset.n as NetworkKey)));
      });
    };

    async function run(index: number) {
      const it = HERO_INTENTS[index]!;
      setCycle({ index, phase: "printed", plotted: false });
      await frame();
      await frame();
      const wrap = out.current?.querySelector<HTMLElement>(".pc-wrap") ?? null;
      const card = wrap?.querySelector<HTMLElement>(".k-card") ?? null;
      const svg = wrap?.querySelector<SVGSVGElement>("svg.route") ?? null;
      const nodes = svg ? [...svg.querySelectorAll<SVGGElement>(".node")] : [];
      const rail = svg?.querySelector<SVGPathElement>(".rail") ?? null;
      const fill = svg?.querySelector<SVGPathElement>(".rail-f") ?? null;
      const coin = svg?.querySelector<SVGGElement>(".coin") ?? null;
      const xs = nodeXs(it);
      if (wrap) wrap.style.transform = "translateY(-104%)";
      if (wreq.current) wreq.current.style.opacity = "0";
      set(typed.current, "");
      set(lcd.current, "SAY SOMETHING");
      set(lcdR.current, "ready");
      lightBay(null);
      label$("Example · K-01 print bed · listening");

      // 1 · type
      await sleep(500);
      for (let i = 0; i < it.text.length; i += 1) {
        const ch = it.text[i]!;
        set(typed.current, it.text.slice(0, i + 1));
        if (ch !== " ") play("type", 0.45);
        if (i % 2) animate(keyb.current, [{ transform: "none" }, { transform: "translateY(1.5px)" }], { duration: 35, direction: "alternate", iterations: 2 });
        await sleep(ch === " " ? 50 : 34 + (i % 5 === 0 ? 30 : 0));
      }
      await sleep(350);

      // 2 · send: the LCD takes the intent, routes are counted, the touched networks light up
      play("send");
      label$("Example · K-01 print bed · planning");
      void press(send.current);
      animate(typed.current, [{ transform: "none", opacity: 1 }, { transform: "translateY(-14px)", opacity: 0 }], { duration: 300, delay: 100, easing: EASE.in(2), fill: "forwards" });
      await sleep(420);
      set(typed.current, "");
      typed.current?.getAnimations().forEach((animation) => animation.cancel());
      mach.current?.classList.add("is-working");
      set(lcd.current, it.lcd);
      set(lcdR.current, "planning");
      for (let k = 1; k <= 7; k += 1) {
        await sleep(90);
        set(lcdR.current, `${k * 2} routes`);
        play("tick", 0.5);
        if (k === 1 || k === 3) {
          const net = it.nets[k === 1 ? 0 : 1];
          if (net) {
            lightBay(it.nets.slice(0, k === 1 ? 1 : 2));
            play("step", 0.8);
          }
        }
      }
      await sleep(200);

      // 3 · print: stepped feed, then the card releases with a spring
      play("motor", 0.9);
      set(lcdR.current, "printing");
      animate(mouth.current, [{ transform: "scaleY(1)" }, { transform: "scaleY(1.6)" }], { duration: 150, easing: EASE.back(2), fill: "forwards" });
      let y = -104;
      for (const next of [-80, -56, -32, -10]) {
        await sleep(100);
        play("step");
        animate(wrap, [{ transform: `translateY(${y}%)` }, { transform: `translateY(${next}%)` }], { duration: 130, easing: EASE.inOut(2), fill: "forwards" });
        y = next;
        await sleep(130);
      }
      await sleep(80);
      play("slide", 0.8);
      animate(wrap, [{ transform: `translateY(${y}%)` }, { transform: "translateY(0)" }], { duration: 550, easing: EASE.back(1.5), fill: "forwards" });
      animate(mouth.current, [{ transform: "scaleY(1.6)" }, { transform: "scaleY(1)" }], { duration: 200, fill: "forwards" });
      animate(card, [{ rotate: "-1.6deg" }, { rotate: "0deg" }], { duration: 900, delay: 200, easing: EASE.elastic(1, 0.4) });
      card?.style.setProperty("--sx", "-60%");
      await sleep(500);

      // 4 · plot the route
      play("pen", 0.7);
      label$("Example · K-01 print bed · plotting the route");
      animate(rail, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 700, easing: "linear", fill: "forwards" });
      const span = xs[xs.length - 1]! - xs[0]!;
      nodes.forEach((node, k) => {
        const delay = ((xs[k]! - xs[0]!) / span) * 650;
        animate(node, [{ transform: "scale(0)" }, { transform: "scale(1)" }], { duration: 380, delay, easing: EASE.back(2.6), fill: "forwards" });
        window.setTimeout(() => play(`leg${Math.min(3, k + 1)}` as SoundName), delay);
      });
      await sleep(1000);
      set(lcdR.current, "waiting for you");
      mach.current?.classList.remove("is-working");
      await sleep(900);

      // 5 · sign: the key, the latch, the wallet request
      const sign = wrap?.querySelector(".sign") ?? null;
      play("key");
      void press(sign, 150);
      await sleep(150);
      setCycle({ index, phase: "sealed", plotted: true });
      await sleep(150);
      animate(wrap, [{ translate: "0 0" }, { translate: "2px 5px", offset: 0.3 }, { translate: "-2px 0", offset: 0.6 }, { translate: "1px 0", offset: 0.8 }, { translate: "0 0" }], { duration: 240 });
      await sleep(150);
      setCycle({ index, phase: "signing", plotted: true });
      set(lcdR.current, "signing");
      label$("Example · K-01 print bed · your wallet signs");
      set(wreqP.current, it.wallet);
      await sleep(100);
      play("request");
      animate(wreq.current, [{ opacity: 0, transform: "scale(.9) rotate(-4deg)" }, { opacity: 1, transform: "none" }], { duration: 500, easing: EASE.back(1.7), fill: "forwards" });
      await sleep(800);
      play("key");
      void press(wreqK.current, 150);
      await sleep(250);
      animate(wreq.current, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(14px) scale(.96)" }], { duration: 300, easing: EASE.in(2), fill: "forwards" });
      await sleep(200);

      // 6 · the coin rides the rail
      const bars = wrap ? [...wrap.querySelectorAll<HTMLElement>(".pc-steps b")] : [];
      coin?.setAttribute("opacity", "1");
      const hopped = new Set<number>();
      const ride = (p: number) => {
        const x = xs[0]! + span * p;
        coin?.setAttribute("transform", `translate(${x} ${RAIL_Y})`);
        if (fill) fill.style.strokeDashoffset = String(1 - p);
        xs.forEach((nx, k) => {
          if (k > 0 && x >= nx - 2 && !hopped.has(k)) {
            hopped.add(k);
            play("hop", 0.8);
            animate(nodes[k], [{ transform: "scale(1.25)" }, { transform: "scale(1)" }], { duration: 350, easing: EASE.back(3), fill: "forwards" });
          }
        });
        bars.forEach((bar, k) => {
          const seg = 1 / bars.length;
          bar.style.width = `${Math.max(0, Math.min(1, (p - k * seg) / seg)) * 100}%`;
        });
      };
      const rideFor = 1700;
      let elapsed = 0;
      let stepOk = bars.length < 2;
      while (elapsed < rideFor) {
        const before = performance.now();
        await frame();
        if (onScreen.current && !document.hidden) elapsed += performance.now() - before;
        if (clock.stopped) throw new Error("stopped");
        const t = Math.min(1, elapsed / rideFor);
        ride(t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
        if (!stepOk && t > 0.5) {
          stepOk = true;
          play("stepok");
        }
      }
      await sleep(100);

      // 7 · settled: stamp, LCD, label
      coin?.setAttribute("opacity", "0");
      wrap?.querySelector(".k-latch")?.classList.add("ok");
      play("stepok");
      set(lcd.current, `SETTLED ${it.stamp.split(" · ")[0]!.toUpperCase()}`);
      set(lcdR.current, "settled");
      label$("Example · K-01 print bed · settled on chain");
      await sleep(100);
      setCycle({ index, phase: "settled", plotted: true });
      card?.style.setProperty("--sx", "120%");
      await sleep(1500);

      // 8 · file into the binder (phone: the card drops back out of the window)
      if (!isPhone() && tray.current && wrap) {
        animate(wrap, [{ translate: "0 0" }, { translate: "0 -14px" }], { duration: 250, easing: EASE.outPow(2), fill: "forwards" });
        await sleep(250);
        const a = wrap.getBoundingClientRect();
        const b = tray.current.getBoundingClientRect();
        const dx = b.left + b.width / 2 - (a.left + a.width / 2);
        const dy = b.top + 40 - (a.top + a.height / 2) - 14;
        play("slide");
        animate(wrap, [{ translate: "0 -14px", scale: "1", rotate: "0deg", opacity: 1 }, { translate: `${dx}px ${dy}px`, scale: "0.12", rotate: "-14deg", opacity: 1, offset: 0.86 }, { translate: `${dx}px ${dy}px`, scale: "0.12", rotate: "-14deg", opacity: 0 }], { duration: 870, easing: EASE.in(3), fill: "forwards" });
        await sleep(950);
        play("drop");
        play("riffle", 0.8);
        setThumbs((list) => [...list.slice(-2), { id: `hero-${it.serial}-${Date.now()}`, kind: it.thumb[0], serial: it.serial, title: it.thumb[1], sub: it.thumb[2] }]);
        setCount((value) => value + 1);
      } else {
        play("slide");
        animate(wrap, [{ transform: "translateY(0)" }, { transform: "translateY(115%)" }], { duration: 700, easing: EASE.in(3), fill: "forwards" });
        await sleep(700);
        play("drop");
        set(lcd.current, `FILED #${serialOf(it.serial)}`);
        play("riffle", 0.7);
      }
      label$("Example · K-01 print bed · filed in your binder");
      await sleep(1600);
    }

    let index = 0;
    void (async () => {
      try {
        for (;;) {
          await run(index % HERO_INTENTS.length);
          index += 1;
        }
      } catch {
        /* stopped */
      }
    })();
    return () => clock.stop();
  }, [reduced, onScreen, label$]);

  return (
    <section className="hero" aria-labelledby="hero-heading" ref={root}>
      <div className="wrap hero-in">
        <div className="hero-copy">
          <span className="hero-tag">
            <span className="ledot on" />
            The ChatGPT of blockchain
          </span>
          <h1 className="hero-h" id="hero-heading">
            <span className="ln">
              <span>Say it.</span>
            </span>{" "}
            <span className="ln">
              <span>Sign it.</span>
            </span>{" "}
            <span className="ln">
              <span className="done">Done.</span>
            </span>
          </h1>
          <p className="hero-p">
            Type what you want your money to do. Kletia knows{" "}
            <b>
              {NETWORK_COUNT} networks and {protocols} protocols
            </b>
            , compares the routes that can carry out your request, prints the best one as a card you can read, and <b>your wallet signs</b> every step. Nothing moves until you do.
          </p>
          <div className="hero-cta">
            <span className="mag">
              <Link to="/app" className={keyClass({ tone: "lime" }, "k-key--xl")}>
                Open the desk
                <Ico name="arr" />
              </Link>
            </span>
            <span className="mag">
              <Link to="/developers" className={keyClass({ tone: "ink" }, "k-key--xl")}>
                Build with the API
              </Link>
            </span>
          </div>
          <dl className="hero-stats">
            <div className="hstat">
              <dt>networks</dt>
              <dd>
                <Odometer value={stats[0]} sound={false} />
              </dd>
            </div>
            <div className="hstat">
              <dt>protocols</dt>
              <dd>
                <Odometer value={stats[1]} sound={false} />
              </dd>
            </div>
            <div className="hstat">
              <dt>keys held</dt>
              <dd>
                <Odometer value="0" sound={false} />
              </dd>
            </div>
            <div className="hstat" title="Networks that answered GET /v1/health from this browser">
              <dt>answering now</dt>
              <dd>
                <Odometer value={answering ?? "—"} sound={false} />
              </dd>
            </div>
          </dl>
        </div>

        <div className="bed-col">
          <div
            className="bed"
            ref={bed}
            role="img"
            aria-label="An example run of the Kletia card machine: a sentence is typed, a plan card prints with the route on it, the wallet signs, the card is stamped settled and filed into the binder."
          >
            <canvas className="dither" ref={canvas} aria-hidden="true" />
            <span className="stk mg hide-m" style={{ left: 20, bottom: 46, transform: "rotate(-5deg)" }}>
              Non-custodial
            </span>
            <span className="stk hide-m" style={{ right: 22, top: 58, transform: "rotate(5deg)" }}>
              {NETWORK_COUNT} networks
            </span>
            <span className="stk bl hide-m" style={{ right: 30, top: 178, transform: "rotate(4deg)" }}>
              <span className="ledot on" />
              Example run
            </span>
            <div className="stage" aria-hidden="true">
              <div className="mach" ref={mach}>
                <div className="mbody">
                  <div className="bay" ref={bay}>
                    {BAY.map((key) => (
                      <div key={key} className={intent.nets.includes(key) && cycle.phase === "settled" && reduced ? "cart is-on" : "cart"} data-n={key} style={{ "--nc": NET_COLOR[key] } as CSSProperties}>
                        <Ico name={NET_ICON[key]} />
                        <span>{netName(key)}</span>
                        <i className="ledot" />
                      </div>
                    ))}
                    <div className="cart more">+{NETWORK_COUNT - BAY.length}</div>
                  </div>
                  <div className="keyb" ref={keyb}>
                    <div className="scr">
                      <span ref={typed} />
                      <span className="caret" />
                    </div>
                    <span className={keyClass({ tone: "lime" })} ref={send}>
                      <Ico name="send" />
                    </span>
                  </div>
                  <div className="printer">
                    <div className="lcd">
                      <div className="l1">
                        <span>K-01 status</span>
                        <span ref={lcdR}>{reduced ? "settled" : "ready"}</span>
                      </div>
                      <div className="l2" ref={lcd}>
                        {reduced ? "SETTLED 19 S" : "SAY SOMETHING"}
                      </div>
                    </div>
                    <div className="pwin">
                      <span className="rod" />
                      <span className="head" />
                      <span className="paper" />
                      <span className="roll a" />
                      <span className="roll b" />
                    </div>
                  </div>
                  <div className="slot">
                    <span className="ledot on" />
                    <span className="mouth" ref={mouth} />
                    <span className="ser">#{serialOf(intent.serial)}</span>
                  </div>
                </div>
                <div className="out">
                  <div className="out-in" ref={out}>
                    <div className="pc-wrap" key={cycle.index} style={reduced ? undefined : { transform: "translateY(-104%)" }}>
                      <PlanCard intent={intent} serial={intent.serial} phase={cycle.phase} plotted={cycle.plotted} />
                    </div>
                  </div>
                </div>
              </div>
              <div className="wreq" ref={wreq}>
                <div className="wh">
                  <span className="av" />
                  Wallet request
                </div>
                <p ref={wreqP}>{intent.wallet}</p>
                <span className={keyClass({ tone: "lime", size: "sm" })} ref={wreqK}>
                  Approve
                </span>
              </div>
              <BinderStack className="hero-stack" thumbs={thumbs} count={count} trayRef={tray} />
            </div>
            <div className="bed-lbl">
              <span className="ledot on" />
              <span ref={label}>{reduced ? "Example · K-01 print bed · settled on chain" : "Example · K-01 print bed"}</span>
            </div>
          </div>
          <TrySentence intent={intent} />
        </div>
      </div>
    </section>
  );
}

/** The sentence on the machine, as a real link: the desk plans it (nothing is signed until your wallet does). */
function TrySentence({ intent }: { readonly intent: HeroIntent }) {
  return (
    <p className="bed-try">
      <span className="bed-try-k">Example</span>
      <Link to={deskHref(intent.text)}>
        Try “{intent.text}” in the desk
        <Ico name="arr" />
      </Link>
    </p>
  );
}
