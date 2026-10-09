import { LoaderCircle } from "lucide-react";
import React from "react";

import { Link } from "../../routes/Link";
import { buttonClasses, cx, type ButtonSize, type ButtonVariant } from "./styles";

interface CommonProps {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly className?: string;
  readonly children: React.ReactNode;
}

export type ButtonProps = CommonProps & {
  /**
   * Busy state: sets `aria-busy`, disables the button and swaps the leading
   * icon for a spinner. The label and the width stay the same.
   */
  readonly loading?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

const SPINNER = "kl-loop animate-spin motion-reduce:animate-none";

/** Replaces the first element child (the leading icon) with a same-sized spinner. */
function withSpinner(children: React.ReactNode): React.ReactNode {
  const items = React.Children.toArray(children);
  const first = items[0];
  if (React.isValidElement<{ className?: string }>(first) && typeof first.type !== "string") {
    return [
      <LoaderCircle key="kl-spinner" className={cx(first.props.className ?? "h-4 w-4", SPINNER)} aria-hidden="true" />,
      ...items.slice(1),
    ];
  }
  // No leading icon: keep the label in place (and in the accessible name) and overlay the spinner.
  return (
    <>
      <span className="inline-flex items-center gap-[inherit] opacity-0">{children}</span>
      <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
        <LoaderCircle className={cx("h-4 w-4", SPINNER)} />
      </span>
    </>
  );
}

/** Neo-brutalist button with press physics. */
export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  loading = false,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, loading ? cx("relative", className) : className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? withSpinner(children) : children}
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
