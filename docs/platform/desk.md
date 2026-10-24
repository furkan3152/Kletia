# Desk navigation

The desk at `/app` has nine views. They are grouped into six sections so the
nav is one readable row on a 360 px phone and a short row in the desktop
header (`apps/web/src/app/console/state/deskNav.ts`):

| Section | Views (sub-tabs) | Paths |
|---|---|---|
| Desk | desk | `/app` |
| Tasks | tasks (phones and tablets; the left rail shows the list from 1280 px, a header popover from 1024 px) | `/app/tasks` |
| Portfolio | Dashboard, Holdings | `/app/dashboard`, `/app/holdings` |
| Trade | Perps, Orders | `/app/perps`, `/app/orders` |
| Automate | Automations | `/app/automations` |
| More | Tools, Activity | `/app/tools`, `/app/tools/<id>`, `/app/activity` |

- Every view keeps its own path, so old links, the pre-rendered pages and the
  desk commands ("show my holdings", "show my orders", "show my dashboard",
  "show my automations", "show my activity", "open tools") open the same view
  as before, now inside its section.
- A section tab opens the view already shown when it belongs to the section,
  else the view last opened in that section, else the first one.
- Sections with more than one view show their views as sub-tabs at the top of
  the main column at every width.
- Under 1024 px the six sections are a sticky bar under the header; from
  1024 px the header shows Desk, Portfolio, Trade, Automate and More.

## Questions in the composer

A question about your own data ("how much did I spend on fees last month?",
"what's my biggest position?") or a portfolio request ("rebalance my
portfolio to 60/40 ETH/USDC") typed in the composer is answered in the thread
by the [portfolio assistant](assistant.md), from the signed-in wallet's data
(sign in with the wallet first; the answer is never stored). The answer card
lists the facts it used with their sources, shows a small table or chart when
useful, offers follow-up questions (they fill the composer), and for a
request the sentences it computed: "Plan it" starts a normal task for each,
which you review and confirm before anything is signed. The exact desk
commands above still open their views; instructions still go to the planner.

## View conventions

The views share `shell/ViewParts.tsx` and `shell/viewStyles.ts`: one heading
(`ViewHeader`), one bordered panel, one form field (the control border and the
site focus ring), and one look for notes (`ViewNote`: neutral, info, warning,
danger), empty states (`ViewEmpty`, a dashed box) and reads in flight
(`ViewLoading`). Colours come from the semantic `--kl-*` tokens, so both
themes follow. Nothing readable in the desk views is under 12 px (the type
floor test scans them). A venue that is off (Drift v2) is listed with its
reason; nothing not confirmed on-chain is shown as confirmed.
