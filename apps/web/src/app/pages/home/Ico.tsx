import { HOME_ICONS, type HomeIconName } from "./homeIcons";

/** A home line icon (decorative: the text next to it carries the meaning). */
export function Ico({ name, className = "i" }: { readonly name: HomeIconName; readonly className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: HOME_ICONS[name] }} />;
}

/** The same icon as an SVG group inside a larger drawing (the route art), scaled from the 24 grid. */
export function IcoGroup({ name, x, y, scale = 0.75, ink }: { readonly name: HomeIconName; readonly x: number; readonly y: number; readonly scale?: number; readonly ink?: string }) {
  return (
    <g
      className="n-ico"
      transform={`translate(${x} ${y}) scale(${scale})`}
      style={ink ? { stroke: ink } : undefined}
      dangerouslySetInnerHTML={{ __html: HOME_ICONS[name] }}
    />
  );
}
