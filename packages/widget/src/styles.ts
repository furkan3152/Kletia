/** Scoped widget styles, injected once per document. Every class is prefixed `kw-`. */
export const WIDGET_STYLE_ID = "kletia-widget-styles";

export const WIDGET_CSS = `
.kw-root{--kw-ink:#141414;--kw-paper:#fffdf8;--kw-muted:#5b5b5b;--kw-line:#141414;--kw-accent:#0052ff;--kw-accent-ink:#fff;--kw-ok:#0e9f6e;--kw-warn:#b45309;--kw-bad:#d92d20;--kw-chip:#f1eee6;--kw-shadow:4px 4px 0 var(--kw-line);
  box-sizing:border-box;font-family:Inter,"Inter Variable",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--kw-ink);background:var(--kw-paper);border:3px solid var(--kw-line);box-shadow:var(--kw-shadow);padding:16px;width:100%;max-width:480px;line-height:1.4}
.kw-root *,.kw-root *::before,.kw-root *::after{box-sizing:inherit}
.kw-root{container:kw/inline-size;--kw-bad-ink:#b42318;--kw-warn-ink:#92400e;--kw-ok-ink:#067647;--kw-stock:#fffcf2;--kw-stock-ink:#1a1a1a;--kw-stock-muted:#55565b;--kw-plate:#ffd60a;--kw-plate-ink:#141414}
.kw-root[data-theme="dark"]{--kw-ink:#f4f4f5;--kw-paper:#111827;--kw-muted:#a1a1aa;--kw-line:#4b5563;--kw-chip:#1f2937;--kw-shadow:4px 4px 0 #475569;--kw-warn:#fbbf24;--kw-bad-ink:#fca5a5;--kw-warn-ink:#fcd34d;--kw-ok-ink:#6ee7b7;--kw-accent-text:#7ea6ff}
.kw-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.kw-brand{font-weight:900;letter-spacing:.08em;text-transform:uppercase;font-size:13px}
.kw-brand b{color:var(--kw-accent)}
.kw-lane{font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--kw-muted)}
.kw-label{display:block;font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.kw-textarea{width:100%;min-height:72px;resize:vertical;border:2px solid var(--kw-line);background:transparent;color:inherit;padding:10px;font:inherit;font-size:15px}
.kw-textarea:focus,.kw-btn:focus-visible,.kw-chip:focus-visible{outline:3px solid var(--kw-accent);outline-offset:2px}
.kw-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 12px}
.kw-chip{border:2px solid var(--kw-line);background:var(--kw-chip);color:inherit;font:600 12px/1.2 inherit;padding:5px 8px;cursor:pointer;text-align:left}
.kw-row{display:flex;gap:8px;flex-wrap:wrap}
.kw-btn{flex:1;min-height:44px;border:3px solid var(--kw-line);background:var(--kw-paper);color:inherit;font-weight:900;text-transform:uppercase;letter-spacing:.05em;cursor:pointer;box-shadow:3px 3px 0 var(--kw-line);transition:transform .08s ease,box-shadow .08s ease}
.kw-btn:hover:not(:disabled){transform:translate(-1px,-1px);box-shadow:5px 5px 0 var(--kw-line)}
.kw-btn:active:not(:disabled){transform:translate(2px,2px);box-shadow:none}
.kw-btn:disabled{opacity:.5;cursor:not-allowed}
.kw-primary{background:var(--kw-accent);color:var(--kw-accent-ink)}
.kw-summary{margin:14px 0 8px;padding:10px;border:2px dashed var(--kw-line)}
.kw-summary h3{margin:0 0 4px;font-size:15px;font-weight:900}
.kw-meta{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--kw-muted)}
.kw-steps{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.kw-step{border:2px solid var(--kw-line);padding:10px;display:grid;gap:4px}
.kw-step-top{display:flex;justify-content:space-between;gap:8px;align-items:center}
.kw-step-title{font-weight:800;font-size:14px}
.kw-net{display:inline-flex;align-items:center;gap:6px;font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}
.kw-dot{width:10px;height:10px;border:2px solid var(--kw-line);border-radius:50%}
.kw-status{font:800 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;padding:3px 6px;border:2px solid var(--kw-line)}
.kw-status[data-tone="ok"]{background:var(--kw-ok);color:#fff}
.kw-status[data-tone="bad"]{background:var(--kw-bad);color:#fff}
.kw-status[data-tone="live"]{background:#ffd60a;color:#141414}
.kw-io{font-size:13px;color:var(--kw-muted)}
.kw-io strong{color:var(--kw-ink)}
.kw-link{color:var(--kw-accent-text,var(--kw-accent));font-weight:700;font-size:12px}
.kw-link:focus-visible,.kw-root input:focus-visible,.kw-root summary:focus-visible{outline:3px solid var(--kw-accent);outline-offset:2px}
.kw-error{margin-top:10px;border:2px solid var(--kw-bad);color:var(--kw-bad-ink);padding:8px;font-size:13px;font-weight:600}
.kw-warn{font-size:12px;color:var(--kw-warn)}
.kw-foot{margin-top:12px;font-size:11px;color:var(--kw-muted);display:flex;justify-content:space-between;gap:8px}
.kw-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.kw-muted{color:var(--kw-muted)}
.kw-block{display:block}
.kw-break{overflow-wrap:anywhere;word-break:break-word}
.kw-code,.kw-root code{font:600 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.kw-code{display:block;overflow-wrap:anywhere}
.kw-btn-sm{flex:0 0 auto;min-height:36px;padding:4px 10px;font-size:11px}
.kw-input{width:100%;min-height:44px;border:2px solid var(--kw-line);background:transparent;color:inherit;padding:8px 10px;font:inherit;font-size:15px;margin-bottom:8px}
.kw-input:focus{outline:3px solid var(--kw-accent);outline-offset:2px}
.kw-glyph{flex:none;vertical-align:-1px}
.kw-fare{margin:12px 0;border:2px solid var(--kw-line);border-top-width:4px;background:var(--kw-stock);color:var(--kw-stock-ink);padding:10px 12px;font-size:13px;--kw-muted:var(--kw-stock-muted)}
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
.kw-fare-vals{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;min-width:0}
.kw-fare-money{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:6px}
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
.kw-review{margin:12px 0;border:3px solid var(--kw-line);padding:10px 12px;display:grid;gap:8px;font-size:13px}
.kw-review-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;align-items:center}
.kw-review-title{margin:0;font-weight:900;text-transform:uppercase;letter-spacing:.06em;font-size:12px}
.kw-stamps{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px}
.kw-stamp{display:inline-block;border:2px solid currentColor;padding:2px 6px;font:800 10.5px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--kw-ok-ink);transform:rotate(-1.5deg);margin-left:6px}
.kw-stamps .kw-stamp{margin-left:0}
.kw-stamp-warn{color:var(--kw-warn-ink)}
.kw-stamp-bad{color:var(--kw-bad-ink)}
.kw-stamp-receipt{color:var(--kw-accent-text,var(--kw-accent));transform:rotate(-2deg)}
.kw-review-dl{margin:0;display:grid;grid-template-columns:minmax(80px,26%) minmax(0,1fr);gap:6px 10px}
.kw-review-dl dt{font:800 10.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.1em}
.kw-review-dl dd{margin:0;min-width:0;overflow-wrap:anywhere}
.kw-review-args{margin:4px 0 0;padding-left:18px;display:grid;gap:2px}
.kw-review-notice{border:2px dashed var(--kw-bad);padding:6px 8px;font-weight:600;color:var(--kw-bad-ink)}
.kw-review-notice p{margin:0}
.kw-ack{display:flex;gap:8px;align-items:flex-start;font-size:13px;font-weight:600}
.kw-ack input{width:20px;height:20px;flex:none;margin-top:1px;accent-color:var(--kw-accent)}
.kw-gate{margin:12px 0;border:3px solid var(--kw-line);box-shadow:var(--kw-shadow);padding:10px 12px;background:var(--kw-paper)}
.kw-gate-title{margin:0 0 4px;font-weight:900}
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
.kw-share{border:2px solid var(--kw-line);padding:8px 10px;margin:0;display:grid;gap:6px}
.kw-share legend{font-weight:800;font-size:12px;padding:0 4px}
.kw-share-opt{display:flex;gap:8px;align-items:flex-start;font-size:13px}
.kw-share-opt input{width:18px;height:18px;flex:none;margin-top:2px;accent-color:var(--kw-accent)}
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
