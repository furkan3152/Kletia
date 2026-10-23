/** "From your sentence": what a view's form was filled with by a hand-off (round 9), above the form, polite live region. */
import { cx, INK_BORDER, LABEL, SURFACE } from "../../site/ui/styles";

export function HandoffNote({ text }: { readonly text: string | null }) {
  if (!text) return null;
  return (
    <aside aria-live="polite" className={cx("p-3 text-sm", INK_BORDER, SURFACE)}>
      <p className={cx(LABEL, "mb-1 text-xs")}>From your sentence</p>
      <p>{text}</p>
    </aside>
  );
}
