import { ScanSearch } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { PLATFORM_ORIGIN } from "../../../../shared/platform/kletiaClient";
import { navigate } from "../../../routes/history";
import { Link } from "../../../routes/Link";
import { Button } from "../../../site/ui/Button";
import { TextAreaField } from "../../../site/ui/Field";
import { StatusEntryPill } from "../../../site/ui/StatusPill";
import { toneFor } from "../../../site/ui/statusTones";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { classifyReceiptInput, type ReceiptJson } from "./checkReceipt";

type Outcome =
  | { readonly kind: "idle" }
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "checking" }
  | { readonly kind: "verdict"; readonly verified: boolean; readonly sentence: string; readonly problems: readonly string[]; readonly receiptId: string | null; readonly keyNotes: readonly string[] };

/**
 * Verifies receipt JSON here, in the browser: the same `verifyReceipt` and
 * reading of its problems as the receipt page, with the key set both Kletia
 * origins publish. The modules load on first use.
 */
async function verifyJson(document: ReceiptJson, receiptId: string | null): Promise<Outcome> {
  const [{ verifyReceipt }, { fetchReceiptKeys }, { offlineVerdict }] = await Promise.all([
    import("@kletia/core"),
    import("@kletia/sdk/receipts"),
    import("../../receipt/receiptModel"),
  ]);
  const keySet = await fetchReceiptKeys({ baseUrl: PLATFORM_ORIGIN, webOrigin: window.location.origin }).catch(() => ({
    keys: [],
    dropped: [] as string[],
    errors: ["The key set could not be read from both origins."],
  }));
  const verification = await verifyReceipt(document as never, { keys: keySet.keys });
  const verdict = offlineVerdict(verification);
  return {
    kind: "verdict",
    verified: verdict.kind === "verified",
    sentence: verdict.sentence,
    problems: verdict.problems,
    receiptId,
    keyNotes: [...keySet.errors, ...(keySet.dropped.length > 0 ? [`Not confirmed by both origins, so not trusted: ${keySet.dropped.join(", ")}.`] : [])],
  };
}

/**
 * "Check a receipt": a link opens the receipt page in this tab (its
 * share key stays in the fragment, which never reaches a server); JSON
 * is verified here; anything else gets a message.
 */
export function CheckReceipt() {
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const run = useRef(0);
  const resultId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const input = classifyReceiptInput(text);
    const attempt = ++run.current;
    if (input.kind === "empty") {
      setOutcome({ kind: "message", text: "Paste a receipt link or the receipt JSON first." });
      return;
    }
    if (input.kind === "junk") {
      setOutcome({ kind: "message", text: input.message });
      return;
    }
    if (input.kind === "link") {
      // Client-side navigation: the fragment (the share key) only ever lives in this tab.
      setText("");
      navigate(`${input.path}${input.fragment}`);
      return;
    }
    setOutcome({ kind: "checking" });
    try {
      const next = await verifyJson(input.document, input.receiptId);
      if (attempt === run.current) setOutcome(next);
    } catch {
      if (attempt === run.current) setOutcome({ kind: "message", text: "The receipt could not be checked in this browser. Try the CLI: npx @kletia/cli receipt verify receipt.json" });
    }
  };

  return (
    <section aria-labelledby="check-receipt" className={cx("flex min-w-0 flex-col gap-4 p-5 sm:p-6", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <h2 id="check-receipt" className="font-display text-title font-bold">
        Check a receipt
      </h2>
      <form onSubmit={(event) => void submit(event)} className="flex min-w-0 flex-col gap-3" noValidate>
        <TextAreaField
          label="Receipt link or receipt JSON"
          mono
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={"https://kletiaai.xyz/r/rcpt_…#s=…&k=…\nor { \"payload\": …, \"digest\": …, \"signature\": … }"}
          spellCheck={false}
          autoComplete="off"
          hint="Links open the receipt page in this tab; their share key stays in the link's #fragment, which is never sent to a server. JSON is verified here, in your browser."
        />
        <Button type="submit" className="self-start" loading={outcome.kind === "checking"}>
          <ScanSearch className="h-4 w-4" aria-hidden="true" />
          Check
        </Button>
      </form>
      <div id={resultId} aria-live="polite" className="min-w-0">
        {outcome.kind === "message" ? <p className="text-sm font-semibold">{outcome.text}</p> : null}
        {outcome.kind === "verdict" ? (
          <div className="flex min-w-0 flex-col gap-2 border-t-2 border-[#121212]/10 pt-3 dark:border-white/10">
            <p className="flex flex-wrap items-center gap-2">
              <StatusEntryPill entry={toneFor("receipt", outcome.verified ? "verifies" : "invalid")} />
              <span className="text-sm font-semibold">{outcome.sentence}</span>
            </p>
            {outcome.problems.length > 0 ? (
              <ul className="list-disc pl-5 text-sm">
                {outcome.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : null}
            {outcome.keyNotes.map((note) => (
              <p key={note} className={cx("text-[13px]", TEXT_MUTED)}>
                {note}
              </p>
            ))}
            {outcome.receiptId ? (
              <p className="text-sm">
                <span className={cx(LABEL, TEXT_MUTED)}>Receipt</span>{" "}
                <Link to={`/r/${outcome.receiptId}`} className={cx("break-all font-code font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                  {outcome.receiptId}
                </Link>{" "}
                <span className={TEXT_MUTED}>(its page re-reads the chain too)</span>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
