# Projects, publishable keys and flows

A static site can run Kletia with only a key: store your project's settings
once, issue a **publishable key** (`kl_pub_…`) for browser code, and let it
run your stored **flows**. Server keys (`kl_dev_`, `kl_agt_`) stay on your
server; a publishable key is safe in a page because it can only do what this
page lists, from the origins you allow.

Every write needs a project key with its current secret. Agent keys read the
settings but never change them (`AGENT_KEY_FORBIDDEN`).

## Settings (`kletia.project/v1`)

```json
{
  "schema": "kletia.project/v1",
  "brand": { "name": "Acme Store", "website": "https://acme.example" },
  "allowedOrigins": ["https://acme.example", "https://staging.acme.example", "http://localhost:3000"],
  "defaults": {
    "lane": "production",
    "networks": ["base", "arbitrum", "solana"],
    "sourceNetwork": "auto",
    "actions": ["swap", "bridge", "deposit"],
    "examples": ["swap 10 USDC to ETH on Base"],
    "appearance": { "light": { "accent": "#0E7C66" }, "radius": 10 }
  },
  "flows": [
    {
      "id": "deposit",
      "label": "Deposit into Acme vault",
      "actions": [{ "kind": "call", "network": "arbitrum-sepolia", "contract": "ct_10a2…", "entry": "supply", "amount": "10" }],
      "amount": { "action": 0, "min": "1", "max": "100" }
    }
  ]
}
```

| Field | Rules |
|---|---|
| `brand.name` | 2-40 characters, the same rules as a registration's `integrator.name`; reserved brand names (Kletia, venues, bridges) only with their own website |
| `brand.website` | An https origin on the default port (no `:8443`), with no path; its domain file proves the brand (below). The proof counts only for that exact origin, so changing the website starts unverified |
| `allowedOrigins` | At most 20: https origins (any port), or `http://localhost:<port>` for development |
| `defaults.lane` | `production` or `testnet`; every default network must be on it |
| `defaults.networks` | Network keys the widget offers |
| `defaults.sourceNetwork` | One of `defaults.networks`, or `auto` |
| `defaults.actions` | Any of `swap`, `bridge`, `transfer`, `stake`, `deposit`, `withdraw` |
| `defaults.examples` | At most 6, each at most 120 characters |
| `defaults.appearance` | Appearance tokens (docs/platform/theming.md), checked by `validateAppearance` |
| `flows` | At most 20 stored session templates (below) |

Invalid settings answer `400 PROJECT_SETTINGS_INVALID` with `error.issues`
(paths such as `allowedOrigins[0]` or `flows[1].amount.min`).

### Reading and changing them

```bash
curl -s https://api.kletiaai.xyz/v1/projects/current -H "Authorization: Bearer $KLETIA_API_KEY"
# { "project": { "id": "prj_key_2dce…", "version": 3, "hash": "sha256:…", "settings": { … }, "domain": { … }, "logo": null, … } }

curl -s -X PATCH https://api.kletiaai.xyz/v1/projects/current \
  -H "Authorization: Bearer $KLETIA_API_KEY" -H 'Content-Type: application/json' \
  -H 'If-Match: "sha256:…"' \
  -d '{ "allowedOrigins": ["https://acme.example"], "brand": null }'
```

`PATCH` is a JSON merge patch: objects merge, `null` removes a field, arrays
replace. `If-Match` (the `hash` you read) is required; when the project
changed meanwhile the answer is `409 PROJECT_CONFLICT`: read it again and
resend. The SDK (`projects.get`, `projects.update(patch, { ifMatch })`) and
the CLI (`kletia project get`, `kletia project set --file patch.json`) do the
same.

## Domain proof

Publish the `domain.file` of the project view at
`https://<brand.website>/.well-known/kletia.json`:

```json
{ "projects": ["prj_key_2dce…"] }
```

then `POST /v1/projects/current/domain/verify` (`kletia project verify-domain`).
Kletia fetches it with the same guarded fetcher as contract registrations
(16 KB at most, no redirects, public hosts only) and re-checks it daily. Until
the domain is verified the brand name, header and logo are never shown; a
project whose file stops listing it loses them again. A new website starts
unverified.

## Publishable keys

```bash
curl -s -X POST https://api.kletiaai.xyz/v1/projects/current/publishable-keys \
  -H "Authorization: Bearer $KLETIA_API_KEY" -H 'Content-Type: application/json' -d '{ "label": "website" }'
# { "key": { "id": "key_…", "key": "kl_pub_…", "label": "website", "kind": "publishable", "parentId": "key_…", "createdAt": "…" } }
```

- Shown once and stored as a SHA-256 hash, like every key. At most 5 active
  per project (`409 KEY_LIMIT_REACHED`). It is a child of the issuing project
  key: revoking that key (or the publishable key itself, `DELETE
  /v1/keys/{id}`) stops it at once, and `GET /v1/keys` lists it with
  `kind: "publishable"`.
- Its first rule book is derived from the project defaults:
  `kinds.allow` from `defaults.actions`, `networks.allow` from
  `defaults.networks`, `networks.lanes` from `defaults.lane`, and
  `permissions.storeIntents`. The flows stored at that moment are added (their
  kinds, networks and registrations in `contracts.allow`). Change it with
  `PUT /v1/keys/{id}/policy` like any key's; the project's rule book above it
  still applies (a pause or deny of the project stops it too).
- **What it may call**: the public tier (registry, quotes, portfolio, intent
  reads, prepare and submit, receipts, link and session visitor routes), `POST
  /v1/intents` (stored or dry run, clarify turns included) owned by the
  publishable key, `POST /v1/sessions` with `{ flow, hostOrigin }` only, and
  `GET /v1/publishable/profile`. Everything else answers `403
  PUBLISHABLE_KEY_FORBIDDEN`.
- **Never contracts by itself**: a publishable key's own intents can never
  contain `call` or `action` steps (`422 CONTRACT_UNKNOWN`), whatever the
  project registered. Only stored flows reach your registrations.
- **Origins**: every request must come from a page the project allows: the
  `Origin` header is in `allowedOrigins`, or it is a Kletia origin (the
  `/embed` frame) and the `Kletia-Host-Origin` header, which the frame sets to
  the host page origin its bridge proved, is in `allowedOrigins`. Anything
  else, a missing `Origin` included, is `403 PUBLISHABLE_ORIGIN_FORBIDDEN`.
  Non-browser clients can forge these headers; that only gets them the public
  tier plus your fixed flows, with their own wallets and funds.
- **Rate limits**: 120 requests per minute per publishable key, and every
  request also counts against the public limit of its address (30 per
  minute), so one visitor cannot use up the key.
- **Spend windows**: its intents count in the publishable key's own rule
  book windows only, under the chain's smallest caps (see
  docs/platform/policies.md, exposure scope): strangers can never use up the
  daily caps of your server keys or of the project; a cap on the publishable
  key bounds the whole widget.
- **Your server still sees everything**: its intents fire the parent key's
  `scope: "subtree"` webhooks and event streams, and `GET
  /v1/intents?owner=key_…` lists them for the parent (project keys: any agent
  or publishable key of the project; agent keys: their own descendants).

In code: `new KletiaClient({ publishableKey: "kl_pub_…" })` (server-only
methods are refused before anything is sent), the widget's `publishableKey`
prop, or the embed's `key` attribute.

## The profile

`GET /v1/publishable/profile` (with the publishable key) is what a page may
learn about the project:

```json
{
  "profile": {
    "projectId": "prj_key_2dce…",
    "brand": { "name": "Acme Store", "host": "acme.example", "verified": true, "logo": { "url": "/v1/projects/prj_key_2dce…/logo/9f2c….png", "sha256": "9f2c…", "contentType": "image/png", "width": 256, "height": 64 } },
    "allowedOrigins": ["https://acme.example"],
    "lane": "production",
    "defaults": { "networks": ["base", "arbitrum", "solana"], "sourceNetwork": "auto", "actions": ["swap", "bridge", "deposit"] },
    "flows": [{ "id": "deposit", "label": "Deposit into Acme vault", "networks": ["arbitrum-sepolia"] }]
  }
}
```

Show the brand only when `verified` is true; `logo` is present only then.
Never keys, flow contents or who saved a flow.

## Flows

A flow is a stored session template: structured actions only, an optional
visitor-chosen amount within bounds, optional constraints. Saving one (`PATCH`)
validates it like `POST /v1/sessions` and dry-runs it with placeholder
accounts as the calling key, which becomes the flow's **saver**
(`flows[].ownerKeyId` in the project view). An unchanged flow keeps its
saver when someone else patches other fields; a changed one is saved by the
caller. A flow that cannot run answers `400 PROJECT_SETTINGS_INVALID` with
the reason (for example `flows[0].actions[0].contract: CONTRACT_UNKNOWN …`).

In the browser, the publishable key starts one session per visitor:

```bash
curl -s -X POST https://api.kletiaai.xyz/v1/sessions \
  -H "Authorization: Bearer kl_pub_…" -H 'Origin: https://acme.example' -H 'Content-Type: application/json' \
  -d '{ "flow": "deposit", "hostOrigin": "https://acme.example" }'
```

- The body is exactly `{ flow, hostOrigin }`; anything else is `403
  PUBLISHABLE_KEY_FORBIDDEN`, an unknown flow `404 FLOW_UNKNOWN`, a host
  origin outside `allowedOrigins` `403 PUBLISHABLE_ORIGIN_FORBIDDEN`.
- The session is single use, lives 600 s, allows the project's origins and
  is owned by the publishable key (its webhooks, listing and spend windows).
- **Contract authority**: its call and action steps use the registrations of
  the flow's saver, at session creation, at plan and at every prepare. When
  the saver may no longer use a registration (revoked, the registration
  deleted or made private), the flow stops working. The daily custom-contract
  notional is counted against the publishable key, never the saver.

The embed runs it with `<kletia-intent key="kl_pub_…" flow="deposit">`
(docs/platform/embed.md); examples/own-contract `flow.mjs` sets it all up.

## Logo

`PUT /v1/projects/current/logo` with the raw bytes and `Content-Type:
image/png` or `image/webp`: at most 64 KB, 32-512 px per side, width 1 to 4
times the height. Kletia reads only the PNG `IHDR` and WebP `VP8 `/`VP8L`/
`VP8X` headers (no image decoder); SVG, GIF, APNG and animated WebP are
refused with `422 PROJECT_LOGO_INVALID`. `DELETE` removes it.

It is served at `GET /v1/projects/{projectId}/logo/{sha256}.{png|webp}` with a
fixed `Content-Type`, `Cache-Control: public, max-age=31536000, immutable`,
`Content-Security-Policy: default-src 'none'; sandbox`,
`X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy:
cross-origin`, and only while the domain is verified (404 otherwise). The
frame shows it 20 px high in its header next to the verified name, never in
the fare, the review, a notice or a button, and never from a URL parameter or
an element attribute.

## Errors

| Code | Status | When |
|---|---|---|
| `PROJECT_SETTINGS_INVALID` | 400 | The merged settings, or a flow's dry run, are invalid (`error.issues`) |
| `PROJECT_CONFLICT` | 409 | `If-Match` is not the current hash |
| `PUBLISHABLE_KEY_FORBIDDEN` | 403 | A publishable key called a server-only operation |
| `PUBLISHABLE_ORIGIN_FORBIDDEN` | 403 | The request (or `hostOrigin`) is not from an allowed origin |
| `FLOW_UNKNOWN` | 404 | No stored flow with this id |
| `PROJECT_LOGO_INVALID` | 422 | Not an accepted PNG or WebP logo |

The full catalog is docs/platform/errors.md.
