/**
 * Kletia kit: the Card machine design system for apps/web. Import from "src/app/kit" (or a file
 * inside it).
 *
 * TOKENS (light on :root, night on .dark; Tailwind names in tailwind.config.js). The base palette is in
 * styles.css (every page); the kit-only ones (--k-well, --k-slot, --k-lime-tint, --k-magenta*, --k-blue,
 * --k-up/--k-down, --k-led-*, --k-engrave, --k-r-*) load with kit.css, i.e. with any kit import.
 *   --k-chassis #D6D2C8/#0E0E10  page    --k-chassis-2 rail     --k-panel / --k-panel-2 wells
 *   --k-raised  modules          --k-stock / --k-screen card stock, composer screen
 *   --k-ink / -2 / -3 text       --k-line / --k-line-2 hairlines   --k-key / --k-key-edge keycaps
 *   --k-slab-line / --k-slab-shadow  the slab (card, composer, ticket only)
 *   --k-lime (+ -edge, -tint) the ONE accent, always under ink   --k-magenta short/errors
 *   --k-up / --k-down P&L        --k-led-on / --k-led-off lamps   --k-well, --k-slot recesses
 *   --k-grain (7 % noise, as a background layer)  --k-engrave (label text-shadow)  --k-obj (object shadow)
 *   --k-f-display Funnel Display · --k-f-ui Funnel Sans · --k-f-mono Geist Mono · --k-f-led Doto (serial + LCD only)
 *   --k-r-key 10 · --k-r-card 16 · --k-r-module 20
 *   Tailwind: bg-k-chassis, text-k-ink-3, border-k-line, bg-lime, text-magenta, shadow-slab / slab-sm / obj / key,
 *   rounded-key / card / module, ease-mech, duration-60, font-display / body / code / led.
 *   Semantic --kl-* tokens (bg-paper, bg-surface, text-fg, text-muted, border-control...) map onto
 *   the same palette, so older screens follow both themes.
 *
 * COMPONENTS
 *   Key({tone: default|lime|ink|magenta|flat, size: md|sm, square, sound}) · keyClass() · KeyAnchor · LinkButton
 *   Led({tone: off|on|magenta|blue, blink}) · Eng (engraved label) · Vents · Module({label, aside}) · Well
 *   StatusDisplay({rows: [{label, value|null, spoken?}]})   null prints "—", never a made-up number
 *   Odometer({value})   changed digits roll up (550 ms back.out 1.6, 30 ms/position)
 *   Toggle({checked, onChange, label})   hardware slide switch, role="switch"
 *   Nameplate({model, serial, sweep}) · MiniPlate   the brushed KLETIA plate (phone: mini plate)
 *   Dial({options, value, onChange, label, boot})   rotary selector, detents -66/-22/22/66, arrows move a detent
 *   Segmented({options, value, onChange, mode: pressed|page, fill})   sliding key on a spring
 *   OptionKey({title, detail, selected, dim, onSelect}) inside OptionKeys · Chip · Field({label, unit, hint, error})
 *   PrintedCard({label, type, serial, front, back, flipped, latch, stamp, tilt}) · CardArt · CardBody · Facts ·
 *     CardActions · CardTray({status}) · Sleeve · Thumb   (holo card shell; the desk's PlanCard drives its choreography)
 *   MachineWindow({state: idle|working|jam, caption}) · EmptyState({title, action}) · PaperJam({children, actionLabel, onAction}) · ToastPlate
 *   Icon({name, label?}) · ICON_PATHS · networkIcon(key) · KletiaGlyph
 *
 * MOTION (motion.ts, WAAPI, no library; GSAP eases reproduced as CSS linear())
 *   DUR, D(ms), reducedMotion(), EASE.{mech, slam, out, back(s), elastic(a,p), in(n), outPow(n), inOut(n)},
 *   animate(el, keyframes, {duration, delay, easing, fill: backwards|persist}), settled(), timeline().add().call().play(),
 *   popIn, swapOut, swapIn, shake, sealShake, jamShake, squash, checkPop, riffle, countUp, tilt.
 *   Reduced motion (OS or html[data-motion="off"]): durations collapse to 1 ms, timelines become state changes.
 *
 * SOUND (sound.ts, WebAudio synthesis, no audio files)
 *   playSound(name, vol) · playSoundAt(name, ms) · useSoundEnabled() · setSoundEnabled() · unlockSound()
 *   names: type key send chip tick motor step slide leg1 leg2 leg3 question request latch stepok confirm drop
 *          swap toggle boot pen hop riffle jam error
 *   Silent until the first gesture; the switch is remembered ("kletia-sound"); off by default under reduced motion.
 */
export { Key, KeyAnchor, LinkButton, type KeyProps } from "./Key";
export { keyClass, type KeyStyle, type KeyTone, type KeySize } from "./keyClass";
export { Led, Eng, Vents, Module, Well, StatusDisplay, Odometer, Toggle, Nameplate, MiniPlate, type LedTone, type StatusRow } from "./Parts";
export { Dial, Segmented, OptionKey, OptionKeys, Chip, Field, type DialOption, type SegmentedOption } from "./Controls";
export { PrintedCard, CardArt, CardBody, Facts, CardActions, CardTray, Sleeve, Thumb } from "./Card";
export { MachineWindow, EmptyState, PaperJam, ToastPlate, type MachineState } from "./Machine";
export { Icon, KletiaGlyph } from "./icons";
export { ICON_PATHS, networkIcon, type IconName } from "./iconPaths";
export * as motion from "./motion";
export { playSound, playSoundAt, useSoundEnabled, setSoundEnabled, isSoundEnabled, unlockSound, type SoundName } from "./sound";
