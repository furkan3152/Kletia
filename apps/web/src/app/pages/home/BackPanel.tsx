/**
 * "The machine has a back panel." The terminal module with the real snippets of the developer
 * portal (site/snippets.ts): Copy copies the exact text, Run prints an EXAMPLE response (labelled
 * so; nothing is sent). Beside it the rule book booklet and the sub-agent chain, and a row of
 * jacks, one per way in, each a link into the portal.
 */
import { useEffect, useRef, useState } from "react";

import { Segmented } from "../../kit/Controls";
import { keyClass } from "../../kit/keyClass";
import { animate, EASE } from "../../kit/motion";
import { playSound } from "../../kit/sound";
import { Link } from "../../routes/Link";
import { prefersReducedMotion } from "../../site/motion/useReducedMotion";
import { MCP_AGENT_KEY, REST_CREATE_INTENT, SDK_PLAN_AND_EXECUTE, WEBHOOK_VERIFY } from "../../site/snippets";
import { copyText } from "../../site/ui/clipboard";
import { highlightCode, type CodeLanguage } from "../../site/ui/highlight";
import { toast } from "../../site/ui/toast";
import { Ico } from "./Ico";
import type { HomeIconName } from "./homeIcons";

type SampleId = "curl" | "sdk" | "mcp" | "hooks";

interface Sample {
  readonly id: SampleId;
  readonly label: string;
  readonly language: CodeLanguage;
  readonly code: string;
  readonly note: string;
  readonly output: readonly string[];
}

const SAMPLES: readonly Sample[] = [
  {
    id: "curl",
    label: "curl",
    language: "bash",
    code: REST_CREATE_INTENT,
    note: "POST /v1/intents · plans it; nothing is signed",
    output: ["201 Created · intent int_7f3a…c21e · planned", "steps: 2", "  1  bridge  25 USDC  base → solana   via Relay     ≥ 24.97 USDC", "  2  swap    12.48 USDC → JitoSOL     via Jupiter   ≥ 0.0571 JitoSOL", "unsigned transactions only · your wallet signs each step"],
  },
  {
    id: "sdk",
    label: "SDK",
    language: "ts",
    code: SDK_PLAN_AND_EXECUTE,
    note: "@kletia/sdk · plan, then every step signs in the user's wallet",
    output: ["intent int_7f3a…c21e · planned", "  step 1  bridge 50 USDC base → solana · Relay", "  step 2  swap 24.96 USDC → JitoSOL · Jupiter", "wallet: sign step 1 of 2 …  signed · settled", "wallet: sign step 2 of 2 …  signed · settled", "status settled · receipt kletia.receipt.v1"],
  },
  {
    id: "mcp",
    label: "MCP",
    language: "bash",
    code: MCP_AGENT_KEY,
    note: "MCP · Streamable HTTP · an agent key bound by a rule book",
    output: ["kletia · connected · streamable http", "tools: get_policy · check_intent · create_intent · get_approval · get_intent · get_receipt", '> check_intent "pay 300 USDC to base:0xVendor"', "  cap pass · recipients pass · timetable pass · approval trigger (> 200 USDC)", "  held: approval link sent to base:0xYou"],
  },
  {
    id: "hooks",
    label: "Webhooks",
    language: "ts",
    code: WEBHOOK_VERIFY,
    note: "Signed webhooks · intent.status_changed, intent.step_updated",
    output: ["webhook.test → https://example.com/kletia/webhooks", "  signature verified · 200", "intent.step_updated  step 1 · base · settled", "intent.status_changed  settled"],
  },
];

const JACKS: readonly (readonly [HomeIconName, string, string])[] = [
  ["api", "REST API", "/developers/api"],
  ["sdk", "SDK", "/developers"],
  ["mcp", "MCP server", "/developers/agents"],
  ["agent", "Sub-agents", "/developers/agent-tree"],
  ["widget", "Widget", "/developers/embed"],
  ["hook", "Webhooks", "/developers/webhooks"],
  ["sig", "Signed receipts", "/developers/receipts"],
];

const RULES: readonly (readonly [string, string, "pass" | "trig" | "fail", string])[] = [
  ["Spend cap", "500 USDC a day · 212 left", "pass", "pass"],
  ["Recipients", "base:0xVendor only", "pass", "pass"],
  ["Timetable", "Mon–Fri, 09:00–18:00 UTC", "pass", "pass"],
  ["Human approval", "over 200 USDC · base:0xYou", "trig", "trigger"],
  ["Networks", "Base, Solana", "fail", "fail · OP"],
];

export function BackPanel() {
  const [sampleId, setSampleId] = useState<SampleId>("curl");
  const [output, setOutput] = useState<string | null>(null);
  const timer = useRef(0);
  const pre = useRef<HTMLPreElement>(null);
  const sample = SAMPLES.find((entry) => entry.id === sampleId)!;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const choose = (next: SampleId) => {
    window.clearTimeout(timer.current);
    setSampleId(next);
    setOutput(null);
    playSound("swap", 0.7);
    window.requestAnimationFrame(() => animate(pre.current, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: EASE.outPow(2) }));
  };

  const run = () => {
    window.clearTimeout(timer.current);
    const lines = sample.output;
    if (prefersReducedMotion()) {
      setOutput(lines.join("\n"));
      return;
    }
    playSound("send", 0.8);
    let line = 0;
    let chars = 0;
    const next = () => {
      if (line >= lines.length) {
        playSound("confirm", 0.7);
        return;
      }
      const current = lines[line]!;
      chars += 3;
      setOutput(lines.slice(0, line).join("\n") + (line ? "\n" : "") + current.slice(0, chars));
      if (chars % 6 === 0) playSound("type", 0.3);
      if (chars >= current.length) {
        line += 1;
        chars = 0;
        playSound("step", 0.6);
        timer.current = window.setTimeout(next, 160);
      } else timer.current = window.setTimeout(next, 12);
    };
    next();
  };

  const copy = async () => {
    const ok = await copyText(sample.code);
    playSound("chip");
    if (ok) toast.success(`Copied the ${sample.label} sample`, { id: "home-copy" });
    else toast.error("Your browser blocked the clipboard", { id: "home-copy" });
  };

  return (
    <section className="sec" id="build" aria-labelledby="build-heading">
      <div className="wrap">
        <div className="sec-h">
          <div>
            <div className="sec-k">
              <span className="led">04</span>
              <span className="silk">For builders</span>
            </div>
            <h2 className="sec-t" id="build-heading">
              The machine has <em>a back panel.</em>
            </h2>
          </div>
          <p className="sec-p">The same planner behind the desk, as a REST API, a TypeScript SDK, an MCP server for AI agents, an embeddable widget and signed webhooks. Agents get keys bound by a rule book.</p>
        </div>
        <div className="build">
          <div className="rv">
            <div className="term">
              <div className="term-top">
                <Segmented className="seg-lime" ariaLabel="Code samples" options={SAMPLES.map((entry) => ({ id: entry.id, label: entry.label }))} value={sampleId} onChange={choose} />
                <button type="button" className={keyClass({ size: "sm" })} onClick={() => void copy()}>
                  <Ico name="copy" />
                  Copy
                </button>
              </div>
              <div className="term-scr">
                <pre ref={pre} tabIndex={0} aria-label={`${sample.label} sample`}>
                  <code>{highlightCode(sample.code, sample.language)}</code>
                </pre>
                <div className="term-out" aria-live="polite">
                  {output === null ? <span className="dim">{"// press Run to see an example response"}</span> : <>
                    <span className="dim">{"// example response (nothing was sent)\n"}</span>
                    {output}
                  </>}
                </div>
              </div>
              <div className="term-foot">
                <span className="eng">{sample.note}</span>
                <button type="button" className={keyClass({ tone: "lime", size: "sm" })} onClick={run}>
                  <Ico name="play" />
                  Run
                </button>
              </div>
            </div>
          </div>
          <div className="rv">
            <div className="rbook">
              <div className="rb-h">
                <h3>Rule book</h3>
                <span>example · agent key research-bot</span>
              </div>
              <ol className="rules">
                {RULES.map(([title, detail, verdict, text]) => (
                  <li key={title}>
                    <span>
                      {title}
                      <small>{detail}</small>
                    </span>
                    <span className={`verdict ${verdict}`}>{text}</span>
                  </li>
                ))}
              </ol>
              <div className="rb-f">
                check_intent → every rule with the observed value and the limit.
                <br />
                Held intents wait for a human's approval link.
              </div>
            </div>
            <div className="subtree" aria-label="Sub-agent chain (example)">
              <span className="node">
                <span className="av" />
                <span>
                  treasury<small>project key</small>
                </span>
              </span>
              <span className="arr" aria-hidden="true" />
              <span className="node">
                <span className="av" />
                <span>
                  research-bot<small>agent · 7 d</small>
                </span>
              </span>
              <span className="arr" aria-hidden="true" />
              <span className="node">
                <span className="av" />
                <span>
                  payouts<small>sub-agent</small>
                </span>
              </span>
            </div>
          </div>
          <nav className="ports rv" aria-label="Ways in">
            {JACKS.map(([icon, label, to]) => (
              <Link key={label} to={to} className="port">
                <span className="jack" aria-hidden="true">
                  <Ico name={icon} />
                </span>
                <span className="eng">{label}</span>
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </section>
  );
}
