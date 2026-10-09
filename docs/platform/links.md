# Intent links (`kletiaai.xyz/go/lk_…`)

An **intent link** is a public page that does one fixed thing in the
visitor's own wallet: "pay 25 USDC to Acme on Base", "deposit into our vault
on Base from any network", "tip the team 10 to 500 USDC". The publisher
fixes the destination (the actions, recipients and contracts) and the
bounds; the visitor chooses where the money comes from (one of the link's
networks and assets, and an amount within its bounds), reviews the plan and
signs every step in their own wallet. Kletia plans the route (through the
bridge auction when the money starts on another network), hands out
unsigned transactions and verifies settlement. Kletia never holds funds or
keys, and never signs.

- Shareable everywhere: the page carries per-link Open Graph and X card tags
  and a PNG share card, so a pasted link unfurls as a ticket.
- Solana-only flows can also be a **blink** (Solana Actions).
- Counters, never visitor data: Kletia stores day-level counts, no
  addresses, IPs or user agents.
- Reference: `validateLinkDefinition`, `expandLink` and `blinkEligibility` in
  `@kletia/core`; endpoints in [api-v1.md](api-v1.md#intent-links); OpenAPI
  tags `Links` and `Blinks`.

## Publishing a link

```http
POST /v1/links
Authorization: Bearer kl_dev_…
Idempotency-Key: 6c0f…

{
  "title": "Pay 25 USDC to Acme",
  "description": "Invoice A-1029",
  "publisher": { "name": "Acme Store", "website": "https://shop.acme.example" },
  "destination": { "actions": [
    { "kind": "transfer", "network": "base", "from": "USDC", "amount": "25", "recipient": "acme.base.eth" }
  ] },
  "funding": { "networks": ["base", "arbitrum", "optimism", "solana"], "assets": ["USDC"], "amount": { "mode": "deliver" } },
  "expiresAt": "2026-11-30T23:59:59Z",
  "maxUses": 1,
  "blink": true,
  "metadata": { "invoice": "A-1029" }
}
```

| Field | Rules |
|---|---|
| `title`, `description` | 3 to 80 and up to 280 printable characters. |
| `publisher` | `name` (2 to 40 characters) and `website` (https; required on the production lane). Reserved names (protocols, Kletia) need a verified domain. |
| `destination.actions` | 1 to 6 structured actions (`transfer`, `swap`, `bridge`, `stake`, `deposit`, `call`, `action`), fixed by the publisher. The first action's amount is fixed, or `$amount` (the visitor's amount). Recipient names (ENS, Basenames, SNS) are resolved and **pinned** at creation; custom contracts are pinned at their active revision. |
| `funding.networks`, `funding.assets` | Where the visitor may start (up to 9 networks, 6 registry symbols). Every combination must reach the destination, or creation fails with `422 LINK_SOURCE_NOT_ALLOWED`. |
| `funding.amount` | `{ "mode": "input", "bounds": { "USDC": { "min": "10", "max": "500", "default": "100" } } }`: the visitor picks the amount; `{ "mode": "deliver" }`: the recipient receives at least the destination's fixed amount and Kletia sizes the input (up to 3 quotes, within 50 bps of the target). |
| `constraints` | `maxSlippageBps` (up to 300), `maxSeconds`, `avoidProtocols`, `preferProtocols`. |
| `expiresAt` | Default 30 days, at most 365. |
| `maxUses`, `perAccount.maxUses` | Total uses (up to 1,000,000) and uses per source account (up to 100). |
| `blink` | Offer a Solana Action when eligible. |
| `allowHolds` | Publish even if the key's rule book holds the intents for approval (the page says so). |
| `metadata` | Up to 19 string entries copied to every intent (`linkId` is added). Never shown publicly. |

On creation Kletia validates the definition, pins names and contracts,
checks that every funding choice expands, checks the publishing key's
[rule book](policies.md) (a link can never widen it: `422 LINK_POLICY_CONFLICT`
names the rules; holds need `allowHolds`), dry-runs a representative intent,
and checks the domain. Agent keys need `permissions.links`. A key holds at
most 200 active links and creates at most 60 an hour.

The response is the **owner view**: the public view plus the definition,
pins, owner key, reasons and 7-day counters. `GET /v1/links/{id}` returns it
to the owning key, its ancestors and the project's project keys; everyone
else gets the public view.

### Activation delay

A link on the production lane that pays a fixed third party or calls a
custom contract is `pending` for 15 minutes
(`KLETIA_LINK_ACTIVATION_DELAY_SECONDS`), with `link.created` at once and
`link.activated` when it activates: a stolen publisher key cannot publish a
"pay the attacker" link without the publisher's webhook hearing about it
first. Visitors get `409 LINK_PENDING` with `Retry-After` meanwhile. Links
that only move money between the visitor's own accounts activate at once.

### Publisher verification

`https://<website>/.well-known/kletia.json` verifies the publisher when it
lists the link or the key:

```json
{ "links": ["lk_5f1c2a9b7e3d4c6a8b0e1f23"], "keys": ["key_0123456789abcdef01234567"] }
```

It is checked at creation, when a self-paused link resumes and daily by the
link watcher; a link whose file stops listing it turns unverified
(`link.updated` with `reason: "domain_unverified"`). "Verified" means the
domain published a file that authorizes the link, nothing about its
honesty. Unverified publishers get a red seal, a $1,000 cap per intent of
priced input (`KLETIA_LINK_UNVERIFIED_MAX_USD`; an unpriced input is
refused) and no blink.

## The promise only tightens

`PATCH /v1/links/{id}` may only narrow what visitors can do: lower
`maxUses` or `perAccount.maxUses`, raise a minimum or lower a maximum,
remove funding networks or assets, expire earlier, turn the blink off, edit
the title and description. Anything else is `422 LINK_IMMUTABLE_FIELD`
(the destination, publisher and recipients never change; create a new link).
Each change is a new `revision` (`link.updated`).

`{ "status": "paused" }` pauses a link (`link.paused`); `{ "status": "active" }`
resumes it. When a pinned recipient name resolves elsewhere, or a pinned
contract registration gets a newer revision, the link **pauses itself**
(`link.paused` with `recipient_changed` or `contract_changed`); it resumes
only with `{ "status": "active", "accept": ["recipient_changed"] }`, which
re-pins (a new revision, and on mainnet the activation delay again).
`DELETE /v1/links/{id}` withdraws it: visitors get `410 LINK_EXPIRED`;
intents already started can finish.

## Visitors

| Call | What it does |
|---|---|
| `POST /v1/links/{id}/quote` `{ source: { network, asset }, amount?, accounts? }` | The dry-run intent and its [preview](preview.md) for one funding choice; indicative without accounts. Cached 20 s (`Kletia-Quote-Cache: hit`). 20 per minute per IP, 300 per link. |
| `POST /v1/links/{id}/intents` `{ source, amount?, accounts, clientReference? }` | Plans and stores the visitor's intent, **owned by the publisher's key** (its rule book applies). One account per virtual machine the route signs on (`422 LINK_ACCOUNTS_REQUIRED` otherwise). 10 per minute per IP, 120 per link, 5 per 10 minutes per account. |

Then the visitor prepares, signs and submits each step through the normal
[step execution](api-v1.md#step-execution) routes. The planned intent must
stay inside the link's envelope (only the link's networks, pinned recipients
and contracts, and exactly the chosen input), or nothing is stored
(`500 LINK_PLAN_OUT_OF_BOUNDS`). Link intents are always simulated before a
payload is returned.

### Uses

A use is **reserved at the first prepare** of a link intent (atomically:
concurrent prepares never exceed `maxUses` or `perAccount.maxUses`),
**consumed at the first submit**, and **released** when the prepare fails or
the intent is cancelled or expires without a submit (a sweeper releases
reservations of intents that vanished). Creating an intent reserves nothing,
so abandoned quotes never lock a link. When every use is reserved or taken,
new visitors get `409 LINK_EXHAUSTED` (retryable: abandoned uses come back);
`409 LINK_ACCOUNT_LIMIT` when the account reached its own limit. A visitor
whose first leg already landed can always finish, even if the link was
paused or expired since; a suspended link refuses every prepare.

## The page and the share card

`kletiaai.xyz/go/{id}` is served by the web origin, which rewrites it to
`GET /v1/links/{id}/page`: the web app's HTML shell (`go-shell.html`) with
the link's title, description, canonical URL and card image injected
between `<!--kletia:head-->` and `<!--/kletia:head-->` (every value
HTML-escaped; nothing else in the shell changes; every link is `noindex`).
Unknown links answer 404 and withdrawn, expired or suspended ones 410 with a
neutral "no longer available" block; `503 LINK_PAGE_UNAVAILABLE` (HTML) when
no shell was ever loaded. The page is framed by nobody
(`frame-ancestors 'none'`) and sends no referrer.

`kletiaai.xyz/go/{id}/card.png` (rewritten to `GET /v1/links/{id}/card.png`)
is a PNG ticket in the departure-board face: the title, the route from the
funding networks to the destination, the publisher, the domain line, a round
VERIFIED or UNVERIFIED seal, and the amount bounds (or the delivered amount
and payee) and expiry on the stub. `?variant=square` gives 600x600 (the blink
icon); the default is 1200x600. Cards never show live counters; they are
cached per revision (ETag, immutable with `?v=<revision>`). Unusable links
get a VOID bar.

The page and the card are exempt from the per-IP rate limit (through the
rewrite every request comes from the static host) and limited to 600 per
minute per link.

## Blinks (Solana Actions)

A link is blink-eligible when every Solana funding choice signs only on
Solana, in at most 3 steps of one transaction each, the publisher's domain
is verified, the link is active with `blink: true`, blinks are enabled, and,
on mainnet, an operator approved it (`POST /v1/links/{id}/blink-approval`;
`KLETIA_LINK_BLINK_REQUIRE_APPROVAL`).

| Route | Spec role |
|---|---|
| `GET /v1/blinks/{id}` | Action metadata (icon = the square card, title = the publisher, one button per Solana funding asset, an amount field for input links). A link that cannot be a blink now answers `disabled: true` with the page URL. |
| `POST /v1/blinks/{id}?asset=&amount=` `{ account }` | Creates the visitor's link intent and returns its first step as an unsigned Solana transaction, with `links.next` for action chaining. |
| `POST /v1/blinks/{id}/next?intent=&step=&t=` `{ account, signature }` | Records the signature as the step's reference and returns the next step as an action, or `completed`. `t` is an HMAC binding link, intent, step and account. |

These routes answer every origin (`Access-Control-Allow-Origin: *`) with
`X-Action-Version: 2.4` and `X-Blockchain-Ids`; errors are
`{ "message": "…" }`. `actions.json` is served by the web origin. Every
transaction is signed by the visitor's wallet; nothing is signed by Kletia.

## Counters

`GET /v1/links/{id}/stats?window=7d|30d|90d` (owner) returns totals, a daily
series and a per-source breakdown of page views, unfurls, blink views,
quotes, intents, prepares, submits, completions, failures, expirations,
cancellations, reports and the priced volume of completed intents, plus two
conversion ratios. Counts are additive per day and source (`network:asset`);
no address, IP or user agent is stored, and visitors' accounts appear only
as a per-link salted hash when the link sets `perAccount`. Counters are
kept 90 days, use rows 30 days after a link expires.

`POST /v1/links/{id}/report` `{ "reason": "phishing" | "impersonation" | "broken" | "other" }`
counts a report (5 per hour per IP). The operator can suspend a link
(`POST /v1/links/{id}/suspend`, `link.suspended`): every prepare is refused
(`409 LINK_SUSPENDED`).

## Webhooks

`link.created`, `link.activated`, `link.updated`, `link.paused`,
`link.suspended`, `link.exhausted`, `link.expired` and `link.deleted`, with
`{ linkId, ownerKeyId, revision, reason? }`, go to the owning key's
webhooks, and to `scope: "subtree"` webhooks of its ancestors. Intent events
of link intents go to the publisher key's webhooks like any intent it owns
(`data.metadata.linkId` names the link).

## MCP

`list_links`, `get_link` and `quote_link` are read-only; `create_link`
publishes a link (agent keys need `permissions.links`) and returns its page
URL for a human. See [mcp.md](mcp.md#intent-link-tools).

## Safety notes

- The page always shows the publisher, the domain seal, every fixed
  recipient and contract, and two notices: Kletia does not vouch for
  publishers, and the publisher can see the wallet addresses of intents
  created from the link.
- A link cannot widen the publishing key's rule book; its visitors' intents
  are evaluated against it at plan and prepare like any other intent of the
  key, and count against its caps.
- Pinned names and contracts never change silently: drift pauses the link.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `KLETIA_LINKS_ENABLED` | `true` | `false` refuses every link route with `503 LINKS_DISABLED`. |
| `KLETIA_BLINKS_ENABLED` | `true` | `false` disables every blink. |
| `KLETIA_LINK_ACTIVATION_DELAY_SECONDS` | `900` | Activation delay of production links paying a third party or calling a contract. |
| `KLETIA_LINK_UNVERIFIED_MAX_USD` | `1000` | Per-intent cap of unverified publishers. |
| `KLETIA_LINK_BLINK_REQUIRE_APPROVAL` | mainnet `true` | Operator approval of blinks. |
| `KLETIA_API_ORIGIN` | `https://api.kletiaai.xyz` | Origin printed in Actions links. |
| `KLETIA_WEB_ORIGIN` | `https://kletiaai.xyz` | Origin of pages, cards and the page shell. |
