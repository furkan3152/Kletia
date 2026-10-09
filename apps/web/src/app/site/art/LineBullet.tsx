import "./base.css";

import { cx } from "../ui/styles";
import type { Line } from "./tokens";

export interface LineBulletProps {
  readonly line: Line;
  /** "lg" for boards and signs. */
  readonly size?: "md" | "lg";
  /**
   * When the network name is already printed next to the bullet, set this so
   * the bullet is hidden from assistive tech. Otherwise the code is hidden
   * and the full network name is read instead ("Base", never "BASE").
   */
  readonly decorative?: boolean;
  readonly className?: string;
}

/** A network's line bullet: its code on the registry colour, with sleepers for the SVM gauge. */
export function LineBullet({ line, size = "md", decorative = false, className }: LineBulletProps) {
  return (
    <span
      className={cx("kla-bullet", line.gauge === "svm" && "kla-bullet--svm", size === "lg" && "kla-bullet--lg", className)}
      style={{ backgroundColor: line.color, color: line.on }}
      aria-hidden={decorative || undefined}
    >
      <span aria-hidden="true">{line.code}</span>
      {decorative ? null : <span className="kla-sr">{line.name}</span>}
    </span>
  );
}
