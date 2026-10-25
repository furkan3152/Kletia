/**
 * The end of the home page: the engraved trust plates and the receipt strip, the FAQ (kept for
 * search and for the questions teams ask), the lime call-to-action slab and the base plate
 * (the footer, drawn as the machine's underside).
 */
import { useEffect, useRef, useState } from "react";

import { CHAINS } from "@kletia/core";

import { keyClass } from "../../kit/keyClass";
import { animate, EASE, tilt } from "../../kit/motion";
import { Toggle } from "../../kit/Parts";
import { playSound } from "../../kit/sound";
import { Link } from "../../routes/Link";
import { observeIntersection } from "../../site/motion/useInView";
import { prefersReducedMotion, setMotionSetting, useMotionSetting, useReducedMotion } from "../../site/motion/useReducedMotion";
import { NETWORK_COUNT, TEST_NETWORK_COUNT, countWord } from "../../site/networkCount";
import { GITHUB_URL, LICENSE_URL, SECURITY_POLICY_URL } from "../../site/siteLinks";
import { INTENT_EXAMPLES } from "../../site/snippets";
import { CTA_DITHER } from "./dither";
import { FAQ_ITEMS, fillCounts } from "./faqContent";
import { deskHref } from "./homeData";
import { useDither } from "./homeMotion";
import { Ico } from "./Ico";
import type { HomeIconName } from "./homeIcons";

const PLATES: readonly { readonly icon: HomeIconName; readonly title: string; readonly body: string; readonly foot: string; readonly href?: string; readonly to?: string }[] = [
  { icon: "shield", title: "No custody", body: "Your wallet signs every step. Kletia never holds your keys or your funds, and the server never signs for you.", foot: "non-custodial · EVM + Solana wallets", href: SECURITY_POLICY_URL },
  { icon: "refresh", title: "Simulated first", body: "Every plan is simulated before you sign. The card shows the least you get, and that minimum is enforced on chain.", foot: "quotes are live, not guaranteed" },
  { icon: "sig", title: "Signed receipts", body: "Each settled intent gets a receipt signed by Kletia, with its digest and every transaction, that anyone can verify offline.", foot: "kletia.receipt.v1 · digest + signature", to: "/developers/receipts" },
  { icon: "open", title: "Open checks", body: "The code, the contracts and the CI that checks them are on GitHub. Read what the machine does before you trust it.", foot: "github.com/furkan3152/Kletia", href: GITHUB_URL },
];

export function TrustPlates() {
  const root = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const cleanups = [...element.querySelectorAll<HTMLElement>(".plate")].map((plate) => tilt(plate, 8));
    const stop = observeIntersection(
      element,
      (entry) => {
        if (!entry.isIntersecting) return;
        stop();
        PLATES.forEach((_, index) => window.setTimeout(() => playSound("latch", 0.5), 200 + index * 110));
      },
      { rootMargin: "0px 0px -20% 0px" },
    );
    return () => {
      stop();
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);
  return (
    <section className="sec" id="security" aria-labelledby="trust-heading">
      <div className="wrap">
        <div className="sec-h">
          <div>
            <div className="sec-k">
              <span className="led">05</span>
              <span className="silk">Trust</span>
            </div>
            <h2 className="sec-t" id="trust-heading">
              Engraved, <em>not promised.</em>
            </h2>
          </div>
          <p className="sec-p">The rules the machine runs by, stamped into the chassis. They hold on the desk, in the API and for every agent key.</p>
        </div>
        <ul className="plates" ref={root}>
          {PLATES.map((plate, index) => (
            <li className="plate rv" key={plate.title}>
              <span className="sweep" aria-hidden="true" />
              <span className="sc2 a" aria-hidden="true" />
              <span className="sc2 b" aria-hidden="true" />
              <span className="pn">Plate 0{index + 1}</span>
              <span className="pic" aria-hidden="true">
                <Ico name={plate.icon} />
              </span>
              <h3>{plate.title}</h3>
              <p>{plate.body}</p>
              {plate.href ? (
                <a className="pf" href={plate.href} target="_blank" rel="noopener noreferrer">
                  {plate.foot}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : plate.to ? (
                <Link className="pf" to={plate.to}>
                  {plate.foot}
                </Link>
              ) : (
                <span className="pf">{plate.foot}</span>
              )}
            </li>
          ))}
        </ul>
        <div className="receipt-strip rv">
          <span>
            <b>Receipt #0042</b> · settled 19 s
          </span>
          <span>
            digest <b>9f2c…41ab</b>
          </span>
          <span>
            signer <b>kletia.receipt.v1</b>
          </span>
          <span>
            Arbitrum <b>0x5e1d…77a0</b>
          </span>
          <span>
            Base <b>0x0b3c…e912</b>
          </span>
          <span className="sp" />
          <Link to="/developers/receipts">example receipt · how to verify one →</Link>
        </div>
      </div>
    </section>
  );
}

export function HomeFaq({ protocols, ownContracts }: { readonly protocols: number; readonly ownContracts: boolean }) {
  return (
    <section className="sec" id="faq" aria-labelledby="faq-heading">
      <div className="wrap faq">
        <div>
          <div className="sec-k">
            <span className="led">06</span>
            <span className="silk">FAQ</span>
          </div>
          <h2 className="faq-t" id="faq-heading">
            Questions teams ask before they integrate.
          </h2>
          <p className="sec-p">
            Custody, coverage, failure handling and what we have not done yet. The <Link to="/developers">developer docs</Link> cover every endpoint, and the{" "}
            <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener noreferrer">
              issue tracker<span className="sr-only"> (opens in a new tab)</span>
            </a>{" "}
            is open.
          </p>
        </div>
        <div className="faq-list">
          {FAQ_ITEMS.map((item) => (
            <details key={item.id} id={`faq-${item.id}`} className="faq-item rv">
              <summary>
                {item.question}
                <span className="faq-x" aria-hidden="true" />
              </summary>
              <div className="faq-a">
                {item.answer.map((paragraph, index) => (
                  <p key={index}>{fillCounts(paragraph, { networks: NETWORK_COUNT, protocols, ownContracts })}</p>
                ))}
                {item.links?.length ? (
                  <p className="faq-links">
                    {item.links.map((link) => (
                      <Link key={link.to} to={link.to}>
                        {link.label} →
                      </Link>
                    ))}
                  </p>
                ) : null}
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

const SUGGESTIONS: readonly string[] = INTENT_EXAMPLES.length ? INTENT_EXAMPLES : ["swap 1 SOL to USDC"];

export function CtaSlab() {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(SUGGESTIONS[0]!);
  useDither(canvas, CTA_DITHER, 0.004);

  // The composer types the grammar's examples, erases them, types the next.
  useEffect(() => {
    if (reduced) return undefined;
    const sentence = SUGGESTIONS[index % SUGGESTIONS.length]!;
    let chars = 0;
    let timer = 0;
    const type = () => {
      chars += 1;
      setShown(sentence.slice(0, chars));
      timer = window.setTimeout(chars < sentence.length ? type : erase, chars < sentence.length ? 38 : 2200);
    };
    const erase = () => {
      chars -= 1;
      setShown(sentence.slice(0, chars));
      timer = chars > 0 ? window.setTimeout(erase, 14) : window.setTimeout(() => setIndex((value) => value + 1), 300);
    };
    timer = window.setTimeout(type, 300);
    return () => window.clearTimeout(timer);
  }, [index, reduced]);

  useEffect(() => {
    const element = box.current;
    if (!element || prefersReducedMotion()) return undefined;
    const stop = observeIntersection(
      element,
      (entry) => {
        if (!entry.isIntersecting) return;
        stop();
        animate(element, [{ transform: "rotate(-1.5deg) scale(.97)" }, { transform: "none" }], { duration: 1000, easing: EASE.elastic(1, 0.5) });
        playSound("confirm", 0.6);
      },
      { rootMargin: "0px 0px -30% 0px" },
    );
    return stop;
  }, []);

  const sentence = SUGGESTIONS[index % SUGGESTIONS.length]!;
  return (
    <section className="cta" aria-labelledby="cta-heading">
      <div className="wrap">
        <div className="cta-box" ref={box}>
          <canvas ref={canvas} aria-hidden="true" />
          <h2 className="cta-t" id="cta-heading">
            What should your money do?
          </h2>
          <div className="cta-row">
            <div className="keyb">
              <div className="scr" aria-hidden="true">
                <span>{reduced ? sentence : shown}</span>
                <span className="caret" />
              </div>
              <Link to={deskHref(sentence)} className={keyClass({ tone: "ink", square: true })} aria-label={`Open the desk with “${sentence}”`}>
                <Ico name="send" />
              </Link>
            </div>
            <span className="mag">
              <Link to="/app" className={keyClass({ tone: "ink" }, "k-key--xl")}>
                Open the desk
                <Ico name="arr" />
              </Link>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

const COLUMNS: readonly { readonly title: string; readonly links: readonly { readonly label: string; readonly to: string; readonly external?: boolean }[] }[] = [
  { title: "Desk", links: [{ label: "Open the desk", to: "/app" }, { label: "Trade", to: "/app/perps" }, { label: "Portfolio", to: "/app/dashboard" }, { label: "Automate", to: "/app/automations" }, { label: "Studio", to: "/studio" }] },
  { title: "Developers", links: [{ label: "Portal", to: "/developers" }, { label: "REST API", to: "/developers/api" }, { label: "Agents and MCP", to: "/developers/agents" }, { label: "Webhooks", to: "/developers/webhooks" }, { label: "Widget", to: "/developers/embed" }] },
  { title: "Coverage", links: [{ label: "Networks", to: "/networks" }, { label: "Protocols", to: "/protocols" }, { label: "Changelog", to: "/changelog" }, { label: "Help", to: "/help" }] },
  { title: "Open", links: [{ label: "GitHub", to: GITHUB_URL, external: true }, { label: "Security", to: SECURITY_POLICY_URL, external: true }, { label: "License", to: LICENSE_URL, external: true }] },
];

const MAINNET_NAMES = Object.values(CHAINS)
  .filter((chain) => chain.lane !== "testnet")
  .map((chain) => chain.name);

export function BasePlate({ protocols }: { readonly protocols: number }) {
  const setting = useMotionSetting();
  const reduced = useReducedMotion();
  const systemReduced = reduced && setting === "on";
  return (
    <footer className="base">
      <div className="wrap">
        <div className="base-grid">
          <div>
            <div className="speclabel">
              <div className="sh">
                <b>K-01</b>
                <span className="silk">Intent machine · spec label</span>
              </div>
              <dl>
                <dt>Custody</dt>
                <dd>None. Your wallet signs every step</dd>
                <dt>Networks</dt>
                <dd>
                  {MAINNET_NAMES.join(", ")} + {countWord(TEST_NETWORK_COUNT)} test networks ({NETWORK_COUNT} in all)
                </dd>
                <dt>Protocols</dt>
                <dd>{protocols}, plus your own contracts</dd>
                <dt>Quotes</dt>
                <dd>Live, not guaranteed; minimums enforced on chain</dd>
              </dl>
              <div className="barcode" aria-hidden="true" />
            </div>
          </div>
          {COLUMNS.map((column) => (
            <nav className="fcol" key={column.title} aria-label={`${column.title} links`}>
              <h2>{column.title}</h2>
              {column.links.map((link) =>
                link.external ? (
                  <a key={link.label} href={link.to} target="_blank" rel="noopener noreferrer">
                    {link.label}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <Link key={link.label} to={link.to}>
                    {link.label}
                  </Link>
                ),
              )}
            </nav>
          ))}
        </div>
        <div className="vents" aria-hidden="true" />
        <div className="base-row">
          <span>Kletia is non-custodial. Quotes are live, not guaranteed; minimum amounts are enforced on chain.</span>
          <Toggle checked={setting === "on" && !systemReduced} onChange={(next) => (systemReduced ? undefined : setMotionSetting(next ? "on" : "off"))} label={systemReduced ? "Animations: off, your device asks for reduced motion" : "Animations"} className="base-motion">
            Animations
          </Toggle>
          <span>K-01 · made for people, signed by wallets · MIT</span>
        </div>
        <div className="base-word" aria-hidden="true">
          KLETIA
        </div>
      </div>
      <div className="feet" aria-hidden="true">
        <i />
        <i />
      </div>
    </footer>
  );
}
