/**
 * Scoped widget styles, injected once per document. Every class is prefixed `kw-`.
 *
 * Borders, padding, gaps, the body font, the corner radius and the shadow read
 * variables, so the appearance tokens of `@kletia/core` (`resolveAppearance`)
 * can restyle the widget without touching a rule; the defaults below are the
 * stock widget, pixel for pixel. The public variables are listed in
 * `APPEARANCE_PUBLIC_VARIABLES`; every other `--kw-*` variable is internal.
 * Safety surfaces (status colours, the fare's ticket stock and plates, stamps,
 * the contract-review notice, policy holds) use fixed colours that no
 * appearance token can reach.
 */
export const WIDGET_STYLE_ID = "kletia-widget-styles";

export const WIDGET_CSS = `
.kw-root{--kw-ink:#141414;--kw-paper:#fffdf8;--kw-muted:#5b5b5b;--kw-line:#141414;--kw-accent:#0052ff;--kw-accent-ink:#fff;--kw-ok:#0e9f6e;--kw-warn:#b45309;--kw-bad:#d92d20;--kw-chip:#f1eee6;--kw-shadow:4px 4px 0 var(--kw-line);
  --kw-radius:0px;--kw-border:3px;--kw-border-inner:2px;--kw-pad:16px;--kw-gap:8px;--kw-text:15px;--kw-pad-field:10px;--kw-pad-chip:5px 8px;--kw-pad-card:10px;--kw-pad-tight:8px;--kw-pad-wide:12px;--kw-gap-sm:6px;
  --kw-font:Inter,"Inter Variable",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--kw-btn-shadow:3px 3px 0 var(--kw-line);--kw-btn-shadow-hover:5px 5px 0 var(--kw-line);--kw-receipt-ink:#0052ff;
  box-sizing:border-box;font-family:var(--kw-font);color:var(--kw-ink);background:var(--kw-paper);border:var(--kw-border) solid var(--kw-line);border-radius:var(--kw-radius);box-shadow:var(--kw-shadow);padding:var(--kw-pad);width:100%;max-width:480px;line-height:1.4}
.kw-root *,.kw-root *::before,.kw-root *::after{box-sizing:inherit}
.kw-root{container:kw/inline-size;--kw-bad-ink:#b42318;--kw-warn-ink:#92400e;--kw-ok-ink:#067647;--kw-stock:#fffcf2;--kw-stock-ink:#1a1a1a;--kw-stock-muted:#55565b;--kw-plate:#ffd60a;--kw-plate-ink:#141414}
.kw-root[data-theme="dark"]{--kw-ink:#f4f4f5;--kw-paper:#111827;--kw-muted:#a1a1aa;--kw-line:#4b5563;--kw-chip:#1f2937;--kw-shadow:4px 4px 0 #475569;--kw-warn:#fbbf24;--kw-bad-ink:#fca5a5;--kw-warn-ink:#fcd34d;--kw-ok-ink:#6ee7b7;--kw-accent-text:#7ea6ff;--kw-receipt-ink:#7ea6ff}
.kw-root[data-density="compact"]{--kw-pad:12px;--kw-gap:6px;--kw-text:14px;--kw-pad-field:8px;--kw-pad-chip:4px 6px;--kw-pad-card:8px;--kw-pad-tight:6px;--kw-pad-wide:10px;--kw-gap-sm:4px}
.kw-root[data-shadow="soft"],.kw-root[data-shadow="none"]{--kw-btn-shadow:none;--kw-btn-shadow-hover:none}
.kw-head{display:flex;align-items:center;justify-content:space-between;gap:var(--kw-gap);margin-bottom:12px}
.kw-brand{font-weight:900;letter-spacing:.08em;text-transform:uppercase;font-size:13px}
.kw-brand b{color:var(--kw-accent)}
.kw-lane{font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--kw-muted)}
.kw-label{display:block;font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.kw-textarea{width:100%;min-height:72px;resize:vertical;border:var(--kw-border-inner) solid var(--kw-line);border-radius:var(--kw-radius);background:transparent;color:inherit;padding:var(--kw-pad-field);font:inherit;font-size:var(--kw-text)}
.kw-textarea:focus,.kw-btn:focus-visible,.kw-chip:focus-visible{outline:3px solid var(--kw-focus,var(--kw-accent));outline-offset:2px}
.kw-chips{display:flex;flex-wrap:wrap;gap:var(--kw-gap-sm);margin:8px 0 12px}
.kw-chip{border:var(--kw-border-inner) solid var(--kw-line);border-radius:var(--kw-radius);background:var(--kw-chip);color:inherit;font:600 12px/1.2 inherit;padding:var(--kw-pad-chip);cursor:pointer;text-align:left}
.kw-row{display:flex;gap:var(--kw-gap);flex-wrap:wrap}
.kw-btn{flex:1;min-height:44px;border:var(--kw-border) solid var(--kw-line);border-radius:var(--kw-radius);background:var(--kw-paper);color:inherit;font-weight:900;text-transform:uppercase;letter-spacing:.05em;cursor:pointer;box-shadow:var(--kw-btn-shadow);transition:transform .08s ease,box-shadow .08s ease}
.kw-btn:hover:not(:disabled){transform:translate(-1px,-1px);box-shadow:var(--kw-btn-shadow-hover)}
.kw-btn:active:not(:disabled){transform:translate(2px,2px);box-shadow:none}
.kw-btn:disabled{opacity:.5;cursor:not-allowed}
.kw-primary{background:var(--kw-accent);color:var(--kw-accent-ink)}
.kw-summary{margin:14px 0 8px;padding:var(--kw-pad-card);border:var(--kw-border-inner) dashed var(--kw-line);border-radius:var(--kw-radius)}
.kw-summary h3{margin:0 0 4px;font-size:var(--kw-text);font-weight:900}
.kw-meta{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--kw-muted)}
.kw-steps{list-style:none;margin:0;padding:0;display:grid;gap:var(--kw-gap)}
.kw-step{border:var(--kw-border-inner) solid var(--kw-line);border-radius:var(--kw-radius);padding:var(--kw-pad-card);display:grid;gap:4px}
.kw-step-top{display:flex;justify-content:space-between;gap:var(--kw-gap);align-items:center}
.kw-step-title{font-weight:800;font-size:14px}
.kw-net{display:inline-flex;align-items:center;gap:6px;font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}
.kw-dot{width:10px;height:10px;border:2px solid var(--kw-line);border-radius:50%}
.kw-status{font:800 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;padding:3px 6px;border:2px solid var(--kw-line)}
.kw-status[data-tone="ok"]{background:#067647;color:#fff}
.kw-status[data-tone="bad"]{background:var(--kw-bad);color:#fff}
.kw-status[data-tone="live"]{background:#ffd60a;color:#141414}
.kw-io{font-size:13px;color:var(--kw-muted)}
.kw-io strong{color:var(--kw-ink)}
.kw-link{color:var(--kw-accent-text,var(--kw-accent));font-weight:700;font-size:12px}
.kw-link:focus-visible,.kw-root input:focus-visible,.kw-root summary:focus-visible{outline:3px solid var(--kw-focus,var(--kw-accent));outline-offset:2px}
.kw-error{margin-top:10px;border:2px solid var(--kw-bad);color:var(--kw-bad-ink);padding:8px;font-size:13px;font-weight:600}
.kw-warn{font-size:12px;color:var(--kw-warn)}
.kw-foot{margin-top:12px;font-size:11px;color:var(--kw-muted);display:flex;justify-content:space-between;gap:var(--kw-gap)}
.kw-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.kw-muted{color:var(--kw-muted)}
.kw-block{display:block}
.kw-break{overflow-wrap:anywhere;word-break:break-word}
.kw-code,.kw-root code{font:600 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.kw-code{display:block;overflow-wrap:anywhere}
.kw-btn-sm{flex:0 0 auto;min-height:36px;padding:4px 10px;font-size:11px}
.kw-input{width:100%;min-height:44px;border:var(--kw-border-inner) solid var(--kw-line);border-radius:var(--kw-radius);background:transparent;color:inherit;padding:var(--kw-pad-tight) var(--kw-pad-field);font:inherit;font-size:var(--kw-text);margin-bottom:8px}
.kw-input:focus{outline:3px solid var(--kw-focus,var(--kw-accent));outline-offset:2px}
.kw-glyph{display:inline-block;flex:none;vertical-align:-1px}
.kw-fare{margin:12px 0;border:2px solid var(--kw-line);border-top-width:4px;border-radius:var(--kw-radius);background:var(--kw-stock);color:var(--kw-stock-ink);padding:10px 12px;font-size:13px;--kw-muted:var(--kw-stock-muted)}
.kw-fare .kw-warn{color:#92400e}
.kw-fare .kw-error{color:#b42318}
.kw-fare .kw-link{color:#0047e0}
.kw-fare-head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font:800 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;padding-bottom:6px;border-bottom:2px solid currentColor;margin-bottom:6px}
.kw-fare-sec{padding:6px 0;border-bottom:1px dashed rgba(26,26,26,.35)}
.kw-fare-sec:last-of-type{border-bottom:0}
.kw-fare-k{margin:0 0 4px;font:800 10.5px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}
.kw-fare-rows,.kw-fare-list,.kw-fare-legend{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.kw-fare-list li{margin:2px 0}
.kw-fare-row{display:grid;grid-template-columns:minmax(72px,30%) minmax(0,1fr);gap:8px;align-items:baseline}
.kw-fare-net{font:700 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;overflow-wrap:anywhere}
.kw-fare-acct{text-transform:none;font-weight:600}
.kw-fare-vals{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;min-width:0}
.kw-fare-money{display:inline-flex;flex-wrap:nowrap;align-items:baseline;gap:6px;min-width:0;max-width:100%}
.kw-fare-body{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:6px;min-width:0}
.kw-fare-money>.kw-plate,.kw-fare-money>.kw-fare-body{flex:0 1 auto;min-width:0}
.kw-fare-amt{font:700 13px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.kw-fare-usd{font:600 12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace}
.kw-fare-note{font-size:11.5px;color:var(--kw-muted)}
.kw-fare-addr{flex-basis:100%;font-size:12px;overflow-wrap:anywhere}
.kw-fare-basis{margin:4px 0;font-size:12px;font-weight:600}
.kw-fare-line{margin:6px 0 0;font-size:12.5px}
.kw-fare-line .kw-fare-k{display:inline;margin-right:6px}
.kw-fare-need{font-weight:700;color:#92400e}
.kw-fare-transit summary{cursor:pointer;list-style:revert}
.kw-fare-changed{margin:4px 0 8px;padding:8px;border:2px solid #b42318;background:#fff1f0}
.kw-fare-old s{text-decoration-color:#b42318;text-decoration-thickness:2px}
.kw-fare-legend{grid-template-columns:repeat(auto-fit,minmax(130px,1fr));margin-top:8px;padding-top:6px;border-top:1px solid rgba(26,26,26,.35);font-size:11px;color:var(--kw-muted)}
.kw-plate{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:6px;background:var(--kw-plate);color:var(--kw-plate-ink);border:2px solid #1a1a1a;padding:1px 6px;font-weight:800}
.kw-plate .kw-fare-usd{color:var(--kw-plate-ink)}
.kw-review{margin:12px 0;border:var(--kw-border) solid var(--kw-line);border-radius:var(--kw-radius);padding:var(--kw-pad-card) var(--kw-pad-wide);display:grid;gap:8px;font-size:13px}
.kw-review-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;align-items:center}
.kw-review-title{margin:0;font-weight:900;text-transform:uppercase;letter-spacing:.06em;font-size:12px}
.kw-stamps{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px}
.kw-stamp{display:inline-block;border:2px solid currentColor;padding:2px 6px;font:800 10.5px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--kw-ok-ink);transform:rotate(-1.5deg);margin-left:6px}
.kw-stamps .kw-stamp{margin-left:0}
.kw-stamp-warn{color:var(--kw-warn-ink)}
.kw-stamp-bad{color:var(--kw-bad-ink)}
.kw-stamp-receipt{color:var(--kw-receipt-ink);transform:rotate(-2deg)}
.kw-review-dl{margin:0;display:grid;grid-template-columns:minmax(80px,26%) minmax(0,1fr);gap:6px 10px}
.kw-review-dl dt{font:800 10.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.1em}
.kw-review-dl dd{margin:0;min-width:0;overflow-wrap:anywhere}
.kw-review-args{margin:4px 0 0;padding-left:18px;display:grid;gap:2px}
.kw-review-notice{border:2px dashed var(--kw-bad);padding:6px 8px;font-weight:600;color:var(--kw-bad-ink)}
.kw-review-notice p{margin:0}
.kw-ack{display:flex;gap:8px;align-items:flex-start;font-size:13px;font-weight:600}
.kw-ack input{width:20px;height:20px;flex:none;margin-top:1px;accent-color:var(--kw-accent)}
.kw-gate{margin:12px 0;border:var(--kw-border) solid var(--kw-line);border-radius:var(--kw-radius);box-shadow:var(--kw-shadow);padding:var(--kw-pad-card) var(--kw-pad-wide);background:var(--kw-paper)}
.kw-gate:focus{outline:none}
.kw-gate:focus-visible{outline:3px solid var(--kw-focus,var(--kw-accent));outline-offset:2px}
.kw-gate-title{margin:0 0 4px;font-weight:900}
.kw-hint{margin:6px 0 0;font-size:12px;font-weight:600}
.kw-stopped{margin:10px 0 0;border:var(--kw-border-inner) dashed var(--kw-line);border-radius:var(--kw-radius);padding:var(--kw-pad-tight);font-size:13px;font-weight:600}
.kw-policy{margin-top:10px;border:3px solid var(--kw-line);padding:8px 10px;font-size:13px;display:grid;gap:6px}
.kw-policy p{margin:0}
.kw-policy-held{border-color:#b45309}
.kw-policy-refused{border-color:var(--kw-bad)}
.kw-policy-title{font-weight:900}
.kw-policy-tag{display:inline-block;border:2px solid currentColor;padding:0 5px;margin-right:4px;font:800 10.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.1em}
.kw-policy-held .kw-policy-tag{color:var(--kw-warn-ink)}
.kw-policy-refused .kw-policy-tag{color:var(--kw-bad-ink)}
.kw-session{display:grid;gap:6px;margin-bottom:12px;font-size:13px}
.kw-session p{margin:0}
.kw-receipt{margin-top:10px;display:grid;gap:6px;font-size:13px}
.kw-receipt p{margin:0}
.kw-receipt-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.kw-receipt-head .kw-stamp{margin-left:0}
.kw-receipt-link{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.kw-share{border:var(--kw-border-inner) solid var(--kw-line);border-radius:var(--kw-radius);padding:var(--kw-pad-tight) var(--kw-pad-field);margin:0;display:grid;gap:6px}
.kw-share legend{font-weight:800;font-size:12px;padding:0 4px}
.kw-share-opt{display:flex;gap:8px;align-items:flex-start;font-size:13px}
.kw-share-opt input{width:18px;height:18px;flex:none;margin-top:2px;accent-color:var(--kw-accent)}
.kw-scope p{margin:0 0 4px}
.kw-scope p:last-child{margin:0}
.kw-scope-title{font-weight:900;text-transform:uppercase;letter-spacing:.06em;font-size:12px}
.kw-clarify{margin:0 0 12px;display:grid;gap:var(--kw-gap)}
.kw-journey{margin:12px 0;border:var(--kw-border-inner) solid var(--kw-line);border-radius:var(--kw-radius);padding:var(--kw-pad-card);display:grid;gap:var(--kw-gap-sm);font-size:13px}
.kw-root[data-theme="dark"] .kw-fare-changed{background:#fff1f0}
@container kw (max-width:400px){.kw-fare-row,.kw-review-dl{grid-template-columns:minmax(0,1fr)}.kw-fare-row{gap:2px}}
@media (prefers-reduced-motion:reduce){.kw-btn{transition:none}}
`;

export function ensureWidgetStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc || doc.getElementById(WIDGET_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = WIDGET_STYLE_ID;
  style.textContent = WIDGET_CSS;
  doc.head.appendChild(style);
}
