import "./kit.css";

import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";

import { keyClass, type KeyStyle } from "./keyClass";
import { playSound, type SoundName } from "./sound";

export type { KeyStyle };

export interface KeyProps extends KeyStyle, ButtonHTMLAttributes<HTMLButtonElement> {
  /** Sound on press (pointerdown or Enter/Space); null for none. Default "key". */
  readonly sound?: SoundName | null;
  readonly children?: ReactNode;
}

/**
 * A physical key: 4 px bottom edge, hover lifts 1 px, press travels 3 px in 60 ms (CSS), a
 * `key` click on press. `type="button"` unless you pass another type.
 */
export const Key = forwardRef<HTMLButtonElement, KeyProps>(function Key({ tone, size, square, sound = "key", className, type = "button", onPointerDown, onKeyDown, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={keyClass({ tone, size, square }, className)}
      onPointerDown={(event) => {
        if (sound && !rest.disabled) playSound(sound);
        onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        if (sound && !rest.disabled && !event.repeat && (event.key === "Enter" || event.key === " ")) playSound(sound);
        onKeyDown?.(event);
      }}
      {...rest}
    />
  );
});

export interface KeyAnchorProps extends KeyStyle, AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly sound?: SoundName | null;
}

/** A key that is a plain link (external or full navigation). For router links use `keyClass()` on <Link>. */
export function KeyAnchor({ tone, size, square, sound = "key", className, onPointerDown, ...rest }: KeyAnchorProps) {
  return (
    <a
      className={keyClass({ tone, size, square }, className)}
      onPointerDown={(event) => {
        if (sound) playSound(sound);
        onPointerDown?.(event);
      }}
      {...rest}
    />
  );
}

/** A text button with an underline ("Details", "Back to the card"), 44 px tall. */
export function LinkButton({ className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={className ? `k-linkbtn ${className}` : "k-linkbtn"} {...rest} />;
}
