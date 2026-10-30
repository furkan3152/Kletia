/**
 * The printed card: the Card machine's hero object. A holo-foiled
 * card of print stock with a lime top band (type + Doto serial), an art window (the route goes
 * here), a title, three facts and one key; the back holds legs and assumptions. It is printed
 * into a tray (recessed, grained, vents, engraved status) and filed into the binder as a Thumb.
 *
 *   <CardTray status="printing card #0042">
 *     <PrintedCard serial="0042" type="Bridge + swap" flipped={flipped} label="Plan card 0042"
 *       front={<>
 *         <CardArt><svg .../></CardArt>
 *         <CardBody from="1,500 USDC on Arbitrum becomes" title="749.60 USDC + 0.2391 ETH" />
 *         <Facts rows={[["You pay", "1,500.00 USDC"], ...]} />
 *         <CardActions><LinkButton onClick={flip}>Details</LinkButton><Key tone="lime" size="sm">Sign</Key></CardActions>
 *       </>}
 *       back={<>...</>}
 *       latch={sealed ? "SEALED" : null} stamp={settled ? "Settled" : null} />
 *   </CardTray>
 *
 * The desk's PlanCard (console/tasks) owns the choreography (print, plot, latch, stamp, file);
 * this file is the shell.
 */
import "./kit.css";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

import { Eng, Vents } from "./Parts";
import { Icon } from "./icons";
import { animate, EASE, sealShake, tilt as attachTilt } from "./motion";
import { playSound } from "./sound";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
/** `inert` for React 18 (its types predate the attribute): hidden faces take no focus. */
const inert = (on: boolean): Record<string, string> => (on ? { inert: "" } : {});

export interface PrintedCardProps {
  /** The card's accessible name ("Plan card 0042: bridge and swap"). */
  readonly label: string;
  /** Type on the band ("Bridge + swap"). */
  readonly type: ReactNode;
  /** Serial without "#" ("0042"), printed in Doto. */
  readonly serial: string;
  /** The front face below the band: CardArt, CardBody, Facts, CardActions... */
  readonly front: ReactNode;
  /** The back face below its band (legs, assumptions); omit for a one-sided card. */
  readonly back?: ReactNode;
  /** Band label of the back ("Details"). */
  readonly backType?: ReactNode;
  readonly flipped?: boolean;
  /** Latch plate text while sealed ("SEALED"); null hides it. Appearing slams it down. */
  readonly latch?: string | null;
  /** Stamp text once settled ("Settled"); null hides it. Appearing slams it from 2.4x / -30 deg. */
  readonly stamp?: ReactNode | null;
  /** Pointer tilt with the foil following (default true; never under reduced motion or touch). */
  readonly tilt?: boolean;
  /** Element whose 2 px "seal shake" accompanies the latch and the stamp (the thread). */
  readonly shakeTarget?: () => Element | null;
  readonly className?: string;
}

export function PrintedCard({ label, type, serial, front, back, backType = "Details", flipped = false, latch = null, stamp = null, tilt = true, shakeTarget, className }: PrintedCardProps) {
  const card = useRef<HTMLElement>(null);
  const latchRef = useRef<HTMLDivElement>(null);
  const stampRef = useRef<HTMLDivElement>(null);
  const hadLatch = useRef(Boolean(latch));
  const hadStamp = useRef(Boolean(stamp));

  useEffect(() => (tilt ? attachTilt(card.current, 9) : undefined), [tilt]);

  useEffect(() => {
    if (latch && !hadLatch.current) {
      animate(latchRef.current, [{ transform: "translateY(-40px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 280, easing: EASE.slam });
      animate(card.current, [{ translate: "0 0" }, { translate: "0 5px" }, { translate: "0 0" }], { duration: 360, delay: 200, easing: EASE.out });
      window.setTimeout(() => sealShake(shakeTarget?.() ?? null), 220);
      playSound("latch");
    }
    hadLatch.current = Boolean(latch);
  }, [latch, shakeTarget]);

  useEffect(() => {
    if (stamp && !hadStamp.current) {
      animate(stampRef.current, [{ transform: "scale(2.4) rotate(-30deg)", opacity: 0 }, { transform: "rotate(-9deg)", opacity: 1 }], { duration: 420, easing: EASE.slam });
      window.setTimeout(() => sealShake(shakeTarget?.() ?? null), 300);
      playSound("confirm");
    }
    hadStamp.current = Boolean(stamp);
  }, [stamp, shakeTarget]);

  return (
    <article ref={card} className={cx("k-card", className)} aria-label={label} data-flipped={flipped ? "" : undefined}>
      <div className="k-card-face" aria-hidden={flipped ? true : undefined} {...inert(flipped)}>
        <div className="k-card-top">
          <span className="k-card-type">{type}</span>
          <span className="k-card-serial">#{serial}</span>
        </div>
        {front}
      </div>
      {back ? (
        <div className="k-card-face k-card-face--back" aria-hidden={flipped ? undefined : true} {...inert(!flipped)}>
          <div className="k-card-top">
            <span className="k-card-type">{backType}</span>
            <span className="k-card-serial">#{serial}</span>
          </div>
          {back}
        </div>
      ) : null}
      <div className="k-sheen" aria-hidden="true" />
      {latch ? (
        <div ref={latchRef} className="k-latch" aria-hidden="true">
          <div className="k-latch-plate">
            <b>{latch}</b>
          </div>
        </div>
      ) : null}
      {stamp ? (
        <div ref={stampRef} className="k-stamp" role="status">
          {stamp}
        </div>
      ) : null}
    </article>
  );
}

/** The art window: dot-matrix ground, your SVG (route), the diffraction foil on top. */
export function CardArt({ children, label, className }: { readonly children?: ReactNode; readonly label?: string; readonly className?: string }) {
  return (
    <div className={cx("k-card-art", className)} role={label ? "img" : undefined} aria-label={label}>
      {children}
      <div className="k-foil" aria-hidden="true" />
    </div>
  );
}

/** "1,500 USDC on Arbitrum becomes" over the title (what you end up with). */
export function CardBody({ from, title }: { readonly from?: ReactNode; readonly title: ReactNode }) {
  return (
    <div className="k-card-body">
      {from ? <p className="k-card-from">{from}</p> : null}
      <p className="k-card-title">{title}</p>
    </div>
  );
}

/** The facts (three on a front): label left, mono value right. */
export function Facts({ rows, className }: { readonly rows: readonly (readonly [ReactNode, ReactNode])[]; readonly className?: string }) {
  return (
    <dl className={cx("k-facts", className)}>
      {rows.map(([term, value], index) => (
        <div key={index}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The action row of a face (Details link left, the key right). */
export function CardActions({ children }: { readonly children: ReactNode }) {
  return <div className="k-card-act">{children}</div>;
}

export interface CardTrayProps {
  /** Engraved label ("Tray"). */
  readonly label?: string;
  /** Muted status on the right ("printing card #0042", "card #0042 · 09:41"). */
  readonly status?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** The printer tray the card is printed into: grained recess, vents, the slot, the eject area. */
export function CardTray({ label = "Tray", status, children, className }: CardTrayProps) {
  return (
    <div className={cx("k-tray", className)}>
      <div className="k-tray-h">
        <Eng as="span">{label}</Eng>
        <Vents />
        {status ? <span className="k-muted">{status}</span> : null}
      </div>
      <div className="k-slot" aria-hidden="true" />
      <div className="k-eject">{children}</div>
    </div>
  );
}

/** The empty sleeve left in the tray once a card is filed (or a binder slot with no card). */
export function Sleeve({ title, children }: { readonly title: ReactNode; readonly children?: ReactNode }) {
  return (
    <div className="k-sleeve">
      <Icon name="binder" />
      <div>
        <b>{title}</b>
        {children}
      </div>
    </div>
  );
}

export interface ThumbProps {
  /** Band label ("Bridge"). */
  readonly kind: string;
  readonly serial: string;
  readonly title: string;
  readonly sub?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/** A mini card for the binder stack (150 x 112). Decorative inside a labelled control. */
export function Thumb({ kind, serial, title, sub, className, style }: ThumbProps) {
  return (
    <span className={cx("k-thumb", className)} style={style} aria-hidden="true">
      <span className="k-thumb-top">
        <span>{kind}</span>
        <span>#{serial}</span>
      </span>
      <b>{title}</b>
      {sub ? <small>{sub}</small> : null}
    </span>
  );
}
