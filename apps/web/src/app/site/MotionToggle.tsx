import { setMotionSetting, useMotionSetting, useReducedMotion } from "./motion/useReducedMotion";
import { Switch } from "./ui/Switch";

/**
 * The footer's "Animations" switch (portal design S-09). Off stores
 * `kletia-site-motion` and marks `html[data-motion="off"]`, which every
 * motion primitive and the CSS treat as reduced motion. When the operating
 * system already asks for reduced motion the switch says so: the site never
 * turns animations on against that setting.
 */
export function MotionToggle({ className }: { readonly className?: string }) {
  const setting = useMotionSetting();
  const reduced = useReducedMotion();
  const systemReduced = reduced && setting === "on";
  return (
    <Switch
      checked={setting === "on" && !systemReduced}
      onChange={(checked) => setMotionSetting(checked ? "on" : "off")}
      disabled={systemReduced}
      label="Animations"
      description={systemReduced ? "Off: your device asks for reduced motion" : setting === "on" ? "On" : "Off on this site"}
      className={className}
    />
  );
}
