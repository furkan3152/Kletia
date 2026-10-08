import React from "react";

import { Link } from "../../routes/Link";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./styles";

interface CommonProps {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly className?: string;
  readonly children: React.ReactNode;
}

export type ButtonProps = CommonProps &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

/** Neo-brutalist button. */
export function Button({ variant = "primary", size = "md", className, type = "button", children, ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClasses(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

export type ButtonLinkProps = CommonProps & {
  /** Internal path (router link) or absolute URL (opens in a new tab). */
  readonly to: string;
  readonly external?: boolean;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children" | "href">;

/** A link styled as a button. Absolute URLs open in a new tab with `noopener`. */
export function ButtonLink({ variant = "primary", size = "md", className, to, external, children, ...rest }: ButtonLinkProps) {
  const classes = buttonClasses(variant, size, className);
  const isExternal = external ?? /^https?:\/\//u.test(to);
  if (isExternal) {
    return (
      <a href={to} target="_blank" rel="noopener noreferrer" className={classes} {...rest}>
        {children}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <Link to={to} className={classes} {...rest}>
      {children}
    </Link>
  );
}
