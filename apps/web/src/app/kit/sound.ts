/**
 * Kit sound engine: the Card machine's sound palette, synthesised with WebAudio from the
 * design prototype's recipes. One family: every sound is a "click" (band-passed
 * noise) and/or a "body" (a short tone), tuned to E major pentatonic, through one master gain
 * (0.42) and a compressor. No audio files.
 *
 * Rules:
 * - Nothing plays before a user gesture: the AudioContext is created lazily on the first
 *   pointerdown/keydown after this module loads (or on `unlockSound()` from a click handler).
 * - The mute switch is remembered (localStorage "kletia-sound": "on" | "off").
 * - With no stored choice, sound is off under reduced motion and on otherwise.
 *
 *   import { playSound, useSoundEnabled, setSoundEnabled } from "../kit/sound";
 *   playSound("key");               // a key press
 *   const [on, setOn] = useSoundEnabled();
 */
import { useSyncExternalStore } from "react";

type Voice = readonly [kind: "click" | "tone" | "motor", start: number, duration: number, gain: number, options: VoiceOptions];
interface VoiceOptions {
  readonly f: number;
  readonly f2?: number;
  readonly q?: number;
  readonly a?: number;
  readonly w?: OscillatorType;
  readonly lp?: number;
  readonly am?: number;
}

const E5 = 659.26,
  Gs5 = 830.61,
  B5 = 987.77,
  Cs6 = 1108.73,
  E6 = 1318.51,
  Gs6 = 1661.22,
  B6 = 1975.53;

export const SOUNDS = {
  /** a light mechanical key (each typed character) */
  type: [["click", 0, 0.016, 0.1, { f: 4200, q: 1.1 }], ["tone", 0, 0.022, 0.035, { w: "sine", f: 240, f2: 120 }]],
  /** a key / button press: click + thock */
  key: [["click", 0, 0.02, 0.2, { f: 3400, q: 1.2 }], ["tone", 0, 0.045, 0.12, { w: "sine", f: 190, f2: 85 }]],
  /** send: the big key bottoms out, then a small rising E5 to B5 */
  send: [
    ["click", 0, 0.026, 0.26, { f: 2600, q: 1.1 }],
    ["tone", 0, 0.07, 0.22, { w: "sine", f: 150, f2: 62 }],
    ["tone", 0.05, 0.06, 0.045, { w: "triangle", f: E5 }],
    ["tone", 0.1, 0.07, 0.04, { w: "triangle", f: B5 }],
  ],
  /** an option key in a question */
  chip: [["click", 0, 0.014, 0.16, { f: 4600, q: 1.4 }], ["tone", 0, 0.06, 0.05, { w: "triangle", f: Gs6 }]],
  /** digit flip, dial detent, chart hover */
  tick: [["click", 0, 0.008, 0.09, { f: 6200, q: 2 }]],
  /** print motor whirr (the one long sound, ~0.9 s, very low) */
  motor: [["motor", 0, 0.92, 0.05, { f: 92, f2: 124, am: 34, lp: 1100 }], ["click", 0, 0.92, 0.03, { f: 1900, f2: 2600, q: 3, a: 0.08 }]],
  /** stepper motor advancing the card one line; a work step */
  step: [["click", 0, 0.012, 0.12, { f: 5200, q: 2.2 }], ["tone", 0, 0.02, 0.03, { w: "square", f: 880, lp: 2400 }]],
  /** the card slides out of the slot / flies */
  slide: [["click", 0, 0.24, 0.1, { f: 1300, f2: 3400, q: 0.8, a: 0.05 }], ["tone", 0.2, 0.04, 0.06, { w: "sine", f: 300, f2: 140 }]],
  /** route legs lock in, rising through the pentatonic */
  leg1: [["click", 0, 0.012, 0.12, { f: 4000, q: 2 }], ["tone", 0, 0.07, 0.05, { w: "triangle", f: E6 }]],
  leg2: [["click", 0, 0.012, 0.12, { f: 4000, q: 2 }], ["tone", 0, 0.07, 0.05, { w: "triangle", f: Gs6 }]],
  leg3: [["click", 0, 0.012, 0.12, { f: 4000, q: 2 }], ["tone", 0, 0.07, 0.05, { w: "triangle", f: B6 }]],
  /** a clarifying question arrives: a soft rising "hm?" */
  question: [["tone", 0, 0.06, 0.05, { w: "triangle", f: Gs5 }], ["tone", 0.075, 0.1, 0.055, { w: "triangle", f: Cs6 }], ["click", 0, 0.01, 0.06, { f: 4400, q: 2 }]],
  /** the wallet asks for a signature: two soft pulses */
  request: [["tone", 0, 0.07, 0.07, { w: "sine", f: B5 }], ["tone", 0.12, 0.09, 0.07, { w: "sine", f: B5 }], ["click", 0, 0.01, 0.06, { f: 5000, q: 2 }]],
  /** latch on sign: two metal clicks, a deep thunk and a short ring */
  latch: [
    ["click", 0, 0.02, 0.28, { f: 3000, q: 2.2 }],
    ["click", 0.06, 0.026, 0.34, { f: 2300, q: 2.4 }],
    ["tone", 0.06, 0.1, 0.3, { w: "sine", f: 118, f2: 52 }],
    ["tone", 0.06, 0.14, 0.022, { w: "triangle", f: 2637 }],
  ],
  /** a signing step confirmed on chain */
  stepok: [["click", 0, 0.012, 0.1, { f: 4600, q: 2 }], ["tone", 0, 0.09, 0.055, { w: "triangle", f: Cs6 }], ["tone", 0, 0.09, 0.015, { w: "sine", f: Cs6 * 2 }]],
  /** settled: a bright two-note confirm (E6 to B6) */
  confirm: [
    ["tone", 0, 0.13, 0.09, { w: "triangle", f: E6 }],
    ["tone", 0, 0.13, 0.02, { w: "sine", f: E6 * 2 }],
    ["tone", 0.11, 0.34, 0.1, { w: "triangle", f: B6 }],
    ["tone", 0.11, 0.34, 0.022, { w: "sine", f: B6 * 2 }],
  ],
  /** the card drops into the binder */
  drop: [["click", 0, 0.09, 0.07, { f: 900, q: 0.7, a: 0.01 }], ["tone", 0, 0.12, 0.18, { w: "sine", f: 165, f2: 70 }], ["click", 0.1, 0.01, 0.12, { f: 3800, q: 2 }]],
  /** cartridge swap (view change): short slide + seat click */
  swap: [["click", 0, 0.13, 0.07, { f: 2600, f2: 1200, q: 0.9, a: 0.03 }], ["click", 0.13, 0.016, 0.2, { f: 3200, q: 1.6 }], ["tone", 0.13, 0.05, 0.1, { w: "sine", f: 170, f2: 80 }]],
  /** slide switch (sound/theme) */
  toggle: [["click", 0, 0.014, 0.18, { f: 2900, q: 1.6 }], ["click", 0.028, 0.012, 0.13, { f: 3800, q: 1.6 }]],
  /** power-on: a hum rises, two relays click, one soft note */
  boot: [["tone", 0, 0.55, 0.05, { w: "sine", f: 110, f2: 440 }], ["click", 0.12, 0.02, 0.16, { f: 2600, q: 2 }], ["click", 0.36, 0.02, 0.18, { f: 3200, q: 2 }], ["tone", 0.5, 0.25, 0.035, { w: "triangle", f: E5 }]],
  /** pen plotter scratching the route */
  pen: [["click", 0, 0.5, 0.035, { f: 6200, f2: 5200, q: 3, a: 0.04 }]],
  /** a coin hops a station */
  hop: [["tone", 0, 0.06, 0.04, { w: "sine", f: 900, f2: 1400 }]],
  /** the binder stack riffles: six rising clicks */
  riffle: [0, 0.035, 0.07, 0.105, 0.14, 0.18].map((t) => ["click", t, 0.012, 0.12, { f: 3400 + t * 4000, q: 1.6 }] as const),
  /** paper jam: the motor stalls and grinds */
  jam: [
    ["motor", 0, 0.55, 0.06, { f: 96, f2: 60, am: 18, lp: 900 }],
    ["click", 0.1, 0.02, 0.2, { f: 1800, q: 1 }],
    ["click", 0.22, 0.02, 0.2, { f: 1600, q: 1 }],
    ["click", 0.34, 0.02, 0.2, { f: 1400, q: 1 }],
    ["tone", 0.5, 0.12, 0.06, { w: "square", f: 156, lp: 800 }],
  ],
  /** failure: two low, dull falling buzzes */
  error: [["tone", 0, 0.09, 0.06, { w: "square", f: 196, lp: 900 }], ["tone", 0.12, 0.13, 0.06, { w: "square", f: 156, lp: 800 }], ["click", 0, 0.02, 0.1, { f: 1200, q: 1 }]],
} as const satisfies Record<string, readonly Voice[]>;

export type SoundName = keyof typeof SOUNDS;

export const MASTER_GAIN = 0.42;
export const SOUND_STORAGE_KEY = "kletia-sound";

/* ---------- synthesis ---------- */
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseBuffers.get(ctx);
  if (cached) return cached;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.2), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 7;
  for (let i = 0; i < data.length; i += 1) {
    seed = (seed * 16807) % 2147483647;
    data[i] = (seed / 2147483647) * 2 - 1;
  }
  noiseBuffers.set(ctx, buffer);
  return buffer;
}

function envelope(gain: GainNode, t: number, duration: number, peak: number, attack: number) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(duration, attack + 0.005));
}

/** Schedules one recipe on any (Offline)AudioContext at time `at`. Exported for offline renders and tests. */
export function renderSound(ctx: BaseAudioContext, destination: AudioNode, name: SoundName, at: number, volume = 1): void {
  const recipe = SOUNDS[name] as readonly Voice[];
  for (const [kind, start, duration, gainValue, o] of recipe) {
    const t = at + start;
    const attack = o.a ?? 0.002;
    const peak = Math.max(0.0002, gainValue * volume);
    const gain = ctx.createGain();
    gain.connect(destination);
    if (kind === "click") {
      const source = ctx.createBufferSource();
      source.buffer = noiseBuffer(ctx);
      const bandpass = ctx.createBiquadFilter();
      bandpass.type = "bandpass";
      bandpass.Q.value = o.q ?? 1;
      bandpass.frequency.setValueAtTime(o.f, t);
      if (o.f2) bandpass.frequency.exponentialRampToValueAtTime(o.f2, t + duration);
      source.connect(bandpass).connect(gain);
      envelope(gain, t, duration, peak, attack);
      source.start(t, (start * 9.7) % 0.5);
      source.stop(t + duration + 0.03);
    } else if (kind === "tone") {
      const osc = ctx.createOscillator();
      osc.type = o.w ?? "sine";
      osc.frequency.setValueAtTime(o.f, t);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + duration);
      let node: AudioNode = osc;
      if (o.lp) {
        const lowpass = ctx.createBiquadFilter();
        lowpass.type = "lowpass";
        lowpass.frequency.value = o.lp;
        osc.connect(lowpass);
        node = lowpass;
      }
      node.connect(gain);
      envelope(gain, t, duration, peak, attack);
      osc.start(t);
      osc.stop(t + duration + 0.03);
    } else {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(o.f, t);
      osc.frequency.linearRampToValueAtTime(o.f2 ?? o.f, t + duration * 0.3);
      osc.frequency.linearRampToValueAtTime(o.f * 1.1, t + duration);
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = o.lp ?? 1000;
      const am = ctx.createGain();
      am.gain.value = 0.6;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = o.am ?? 30;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.4;
      lfo.connect(lfoGain).connect(am.gain);
      osc.connect(lowpass).connect(am).connect(gain);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.06);
      gain.gain.setValueAtTime(peak, t + duration - 0.12);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.start(t);
      lfo.start(t);
      osc.stop(t + duration + 0.02);
      lfo.stop(t + duration + 0.02);
    }
  }
}

/** The master chain: gain 0.42 into a compressor (threshold -16, ratio 4, attack 2 ms, release 120 ms). */
export function masterChain(ctx: BaseAudioContext): GainNode {
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.12;
  master.connect(compressor).connect(ctx.destination);
  return master;
}

/* ---------- runtime: lazy context, gesture unlock, remembered mute ---------- */
let context: AudioContext | null = null;
let master: GainNode | null = null;
const listeners = new Set<() => void>();

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.getAttribute("data-motion") === "off";
  } catch {
    return false;
  }
}

function readStored(): boolean | null {
  try {
    const value = window.localStorage.getItem(SOUND_STORAGE_KEY);
    return value === "on" ? true : value === "off" ? false : null;
  } catch {
    return null;
  }
}

let enabled: boolean = typeof window === "undefined" ? false : (readStored() ?? !prefersReducedMotion());

/** Creates the AudioContext (only ever from a user gesture). Safe to call repeatedly. */
export function unlockSound(): void {
  if (context || typeof window === "undefined") return;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  try {
    context = new Ctor();
    master = masterChain(context);
  } catch {
    context = null;
    master = null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", unlockSound, { once: true, capture: true });
  window.addEventListener("keydown", unlockSound, { once: true, capture: true });
}

/** Plays a sound now (no-op while muted or before the first gesture). */
export function playSound(name: SoundName, volume = 1): void {
  if (!enabled || !context || !master) return;
  if (context.state === "suspended") void context.resume().catch(() => undefined);
  renderSound(context, master, name, context.currentTime + 0.005, volume);
}

/** Plays a sound after `ms` (choreographies); returns a cancel function. */
export function playSoundAt(name: SoundName, ms: number, volume = 1): () => void {
  if (ms <= 0) {
    playSound(name, volume);
    return () => undefined;
  }
  const timer = window.setTimeout(() => playSound(name, volume), ms);
  return () => window.clearTimeout(timer);
}

export function isSoundEnabled(): boolean {
  return enabled;
}

/** Turns sound on or off and remembers it. Turning it on from a click also unlocks the context. */
export function setSoundEnabled(next: boolean): void {
  enabled = next;
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, next ? "on" : "off");
  } catch {
    /* storage blocked: the choice lasts for this page */
  }
  if (next) unlockSound();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** [enabled, setEnabled] for a mute switch. */
export function useSoundEnabled(): readonly [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, isSoundEnabled, () => false);
  return [value, setSoundEnabled] as const;
}
