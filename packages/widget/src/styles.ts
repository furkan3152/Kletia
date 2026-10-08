/** Scoped widget styles, injected once per document. Every class is prefixed `kw-`. */
export const WIDGET_STYLE_ID = "kletia-widget-styles";

export const WIDGET_CSS = `
.kw-root{--kw-ink:#141414;--kw-paper:#fffdf8;--kw-muted:#5b5b5b;--kw-line:#141414;--kw-accent:#0052ff;--kw-accent-ink:#fff;--kw-ok:#0e9f6e;--kw-warn:#b45309;--kw-bad:#d92d20;--kw-chip:#f1eee6;--kw-shadow:4px 4px 0 var(--kw-line);
  box-sizing:border-box;font-family:Inter,"Inter Variable",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--kw-ink);background:var(--kw-paper);border:3px solid var(--kw-line);box-shadow:var(--kw-shadow);padding:16px;width:100%;max-width:480px;line-height:1.4}
.kw-root *,.kw-root *::before,.kw-root *::after{box-sizing:inherit}
.kw-root[data-theme="dark"]{--kw-ink:#f4f4f5;--kw-paper:#111827;--kw-muted:#a1a1aa;--kw-line:#4b5563;--kw-chip:#1f2937;--kw-shadow:4px 4px 0 #475569}
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
.kw-link{color:var(--kw-accent);font-weight:700;font-size:12px}
.kw-error{margin-top:10px;border:2px solid var(--kw-bad);color:var(--kw-bad);padding:8px;font-size:13px;font-weight:600}
.kw-warn{font-size:12px;color:var(--kw-warn)}
.kw-foot{margin-top:12px;font-size:11px;color:var(--kw-muted);display:flex;justify-content:space-between;gap:8px}
@media (prefers-reduced-motion:reduce){.kw-btn{transition:none}}
`;

export function ensureWidgetStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc || doc.getElementById(WIDGET_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = WIDGET_STYLE_ID;
  style.textContent = WIDGET_CSS;
  doc.head.appendChild(style);
}
