# @kletia/cli

The Kletia intent API from your terminal: list networks and venues, quote a
movement, plan an intent and see what it moves, follow it live, verify and
re-verify its receipt, manage your API keys, agent keys, rule books, webhooks
and intent links, and register your own contracts. Built on
[`@kletia/sdk`](../sdk/README.md).

The CLI never prepares, signs or submits a transaction and never holds funds.
Execution happens in your users' wallets (SDK, widget or Studio).

```bash
npx @kletia/cli networks
npx @kletia/cli quote 25 USDC --from base --to solana
npx @kletia/cli plan "bridge 25 USDC from base to solana then swap half to JitoSOL" \
  --account base:0xYourEvmAddress --account solana:YourSolanaAddress
```

Install it globally with `npm install -g @kletia/cli` to get the `kletia`
command. Node 20 or newer. The packages are released together from a
`packages-v*` tag of this repository; before a version is on npm, run it
from a checkout of that tag: `npm ci`, then `node packages/cli/dist/bin.js`
(for example as `alias kletia="node $PWD/packages/cli/dist/bin.js"`).

## Configuration

| Variable | Purpose |
|---|---|
| `KLETIA_API_KEY` | Developer key (`kl_dev_…`), or an agent key (`kl_agt_…`), for keyed commands and higher limits |
| `KLETIA_BASE_URL` | API origin (default `https://api.kletiaai.xyz`; `http://` only for localhost) |
| `KLETIA_WEBHOOK_SECRET` | Signing secret for `webhooks verify`, `webhooks forward` and `listen` (comma-separated during a rotation) |

Secrets are read from the environment only. `--api-key` and similar flags are
refused, because flags end up in shell history and process lists.

## Commands

| Command | What it does |
|---|---|
| `health` | API and per-network RPC health |
| `networks`, `protocols`, `assets [--network <key>]` | Registries |
| `venues [--network <key>] [--protocol <id>]` | EVM lending venues with supply APY, size and exit liquidity |
| `quote <amount> <asset> [<to-asset>] --from <network> [--to <network>]` | Best routes for one movement; the best is marked `*`. `--max-seconds` sets the bridge time limit (default 600) |
| `plan "<text>" --account <account>…` | Plans an intent as a dry run; `--save` stores it. `--max-slippage-bps` and `--max-seconds` set constraints; `--preview` adds the fare breakdown, `--journey` the journey. Asks what is missing ([below](#questions)); `--no-clarify` refuses an incomplete sentence instead |
| `plan --thread <file> --answer <question>=<option> --account <account>…` | Continues a task that asked a question (`=text:<words>` for a typed answer) |
| `journey <intent id> [--refresh] [--reads none]` | Where the money is after every step: stops (network, holder, custody, amount and at-least, USD and its source), legs (venue, ETA) and consequences by severity with their options |
| `stop <intent id>` | Ends an intent at its current stop: nothing further is signed; prints where the money is |
| `preview <intent id> [--refresh-quotes] [--last]` | The asset-change preview ("fare breakdown"): per account and asset expected and worst case, payments to others, fees, approvals and needs, with the certainty of each number (`n/p` = not priced). Simulations only |
| `intents get <id>`, `intents list [--limit N] [--owner <key>]` | Read intents (`list` needs a key; `--owner` lists an agent or publishable key below yours) |
| `intents watch <id>` | Follows the event stream until the intent ends |
| `keys create <name> [--sandbox]`, `keys list`, `keys rotate <id> [--grace-seconds N]`, `keys revoke <id> --yes` | Key management; `--sandbox` keeps the key on the testnet lane (Arbitrum Sepolia, Arc Testnet, Solana Devnet), `keys list` shows each key's lane |
| `keys create-publishable [--label <label>]` | A publishable key (`kl_pub_…`) for browsers, shown once |
| `project get`, `project set --file patch.json [--if-match <hash>]`, `project verify-domain` | Project settings (brand, allowed origins, defaults, flows): `set` merge-patches and is refused when the project changed since `--if-match` (default: the hash read first); `verify-domain` checks `/.well-known/kletia.json` now |
| `keys create-agent --parent <key> --name <name> (--policy <file> \| --template <name> [--account …] [--recipient …] [--approver-wallet …]) [--expires 30d]` | Agent key bound by a rule book (validated locally first); its `kl_agt_` secret is shown once |
| `keys tree` | Project keys and their agent keys, with rule book versions and expiry |
| `policy template [<name>]`, `policy validate --file <policy.json> [--against <key>]` | Templates; local validation with the canonical hash and what tightens or loosens |
| `policy get <key> \| --project`, `policy set <key> \| --project --file <policy.json> [--if-match sha256:…]`, `policy cancel-pending <key> \| --project` | Rule books: tightening applies now, loosening waits the amendment delay (`set` shows which) |
| `policy evaluate <key> --text "…" --account <account> [--at <time>] [--file draft.json]` | The simulator: every rule with pass, trigger, warn or fail; exit 1 on deny |
| `policy decisions [--key] [--intent] [--outcome] [--verify-chain [--head <seq>:<hash>]]`, `policy spend [<key>]` | The hash-chained decision log (exit 3 when the chain is broken); rolling spend and what remains |
| `approvals list [--role approver]`, `approvals show <apr>`, `approvals approve <apr> --yes`, `approvals reject <apr> --yes` | Key approvals of held intents (the digest is checked against the intent first); wallet approvals happen on the approval page |
| `receipt get <intent> [--sequence N] [--wait <seconds>] [--out file]` | The receipt with your disclosures (exit 5 while pending) |
| `receipt verify <file\|share url> [--intent <id>] [--keys <file\|url>]` | Offline check: digest, Ed25519 signature, key, every disclosure, inclusion, EAS envelope (with `viem` installed) |
| `receipt reverify <file\|share url> [--rpc <network>=<url>…] [--quorum N] [--providers] [--archive-rpc <network>=<url>]` | Re-reads every anchor from public RPCs (read-only), checks finality and the landed quote binding, reads the log anchor on Base |
| `receipt share <intent> [--profile route\|amounts\|proof\|full \| --groups a,b] [--expires 7d\|never] [--out file]`, `receipt shares <intent>`, `receipt unshare <intent> <share>`, `receipt withdraw <intent> --yes` | Shares: the link (with its key in the fragment) is printed once; revoke or withdraw any time |
| `receipt keys [--check]`, `receipt log [<seq>] [--inclusion <digest>]` | Receipt keys (cross-checked with the web mirror) and the transparency log |
| `webhooks list`, `webhooks create <url> [--event <type>]`, `webhooks delete <id> --yes` | Webhook management |
| `webhooks test <id>`, `webhooks deliveries <id>` | Send a signed test event now; read the delivery log |
| `webhooks verify --signature "<header>" [--file body.json]` | Checks a delivery's signature (body on stdin by default) |
| `webhooks forward --intent <id> --to http://localhost:3000/…` | Forwards an intent's events to a local endpoint, signed like real deliveries |
| `listen --forward-to http://localhost:3000/… [--event <type>…] [--scope self\|subtree]` | Forwards every event of your key (contracts, links, rule books, keys and intents) to a local endpoint, signed like real deliveries, until Ctrl-C |
| `contracts init --network <key> --address <0x…> [--out file] [--function <name or signature>…]` | Writes a starter definition from the contract's verified ABI (or `--abi <file>`), with TODOs for what needs a decision; an ERC-4626 vault's deposit is prefilled from the inspection |
| `contracts inspect --network <key> (--address <0x…> \| --program <id>…)` | Code hash, proxy and implementation, source verification, and every ABI function marked allowed or refused (with the reason); Solana program pins and upgrade authorities |
| `contracts register --file def.json` | Validates the definition locally, then registers it (`--file -` reads stdin) |
| `contracts list [--network] [--vm] [--status]`, `contracts get <id>` | Registrations with status, pins, verification, actions and revisions |
| `contracts update <id> --file patch.json`, `contracts reverify <id>`, `contracts delete <id> --yes` | Change, re-pin or delete a registration |
| `contracts test <id> --entry <action> --account <account> [--amount N] [--param k=v]` | Dry run: simulation and the review users will see; exit 1 when the simulation is not `ok` |
| `sessions create --file session.json`, `sessions get <id>` | Embed sessions: a fixed template your page turns into an intent for the visitor |
| `links create --file link.json [--dry-run]` | Intent links: validated locally; `--dry-run` plans one representative intent with its fare and creates nothing |
| `links list [--status]`, `links get <id>`, `links pause\|resume <id> [--accept recipient_changed]`, `links delete <id> --yes` | Manage links (tighten-only changes through the SDK or API) |
| `links stats <id> [--window 30d]`, `links card <id> --out card.png [--variant square]`, `links open <id>` | Counters (nothing per visitor), the share card, the page URL |
| `usage [--window 24h\|7d]`, `errors [<CODE>]`, `openapi` | Usage of your key, the error catalog, the OpenAPI document |

Accounts are CAIP-10 ids (`eip155:8453:0x…`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:…`)
or the shorthand `<network>:<address>` (`base:0x…`, `solana:…`). Add `--json`
to any command for machine-readable output on stdout, and `--help` for its
options.

`plan` prints the steps, venues, amounts with their minimums, and lists every
step that sends funds to an account that is not one of yours (your own address
on another network of the same VM, such as a bridge's default recipient, counts
as yours).

### Questions

When a sentence leaves something open that matters ("swap SOL to USDC": how
much?), `plan` asks in the terminal:

```
$ kletia plan "swap SOL to USDC" --account solana:YourSolanaAddress
How much SOL?  You hold 2.5 SOL on Solana.
  1) All · 2.49 SOL   Keeps 0.01 SOL for network fees
  2) Half · 1.25 SOL
  or type amount in sol
> 1
Planned: swap 2.49 SOL to USDC on solana
Kletia assumed: All your SOL: 2.49 (You hold 2.5 SOL on Solana; 0.01 SOL stays for network fees.)
```

Without a terminal (piped, in CI, from an agent) or with `--json`, it prints
the `needs_input` response as JSON and exits **6**. Save its `thread` and
continue with the answer:

```bash
kletia plan "swap SOL to USDC" --account solana:… > turn.json   # exit 6
kletia plan --thread turn.json --answer q.actions.0.amount=all --account solana:…
```

`--no-clarify` keeps the strict behaviour: an incomplete sentence is refused
with its error code. Against an API without clarifying questions, `plan`
plans as before.

## Custom contracts

Register your own EVM contract functions (or a Solana Actions endpoint) so
intents created with your key can call them. The rules (argument bindings,
forbidden functions, pins, simulation, review) are in the
[contracts guide](../../docs/platform/contracts.md).

```bash
export KLETIA_API_KEY=kl_dev_…
kletia contracts inspect --network base --address 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183
kletia contracts init --network base --address 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183 \
  --function deposit --name "Acme Yield" --website https://acme.example --out acme.json
# decide the TODOs in acme.json (input token, limits, phrases), then:
kletia contracts register --file acme.json
kletia contracts test ct_… --entry deposit --account base:0xYourTestAccount --amount 100
```

- `init` guesses only unambiguous bindings (a receiver-like address is your
  user, an `amount`/`assets` argument is the step amount, an event named
  after the function proves it) and writes everything else as a `TODO` that
  local validation reports. It never overwrites a file. `--function` takes a
  name or a canonical signature (`--function "deposit(uint256,address)"`;
  commas inside parentheses do not split the list).
- For an ERC-4626 vault (the inspection's `hints.erc4626`), the
  `deposit(uint256,address)` entry is prefilled: the vault's asset as input
  with an exact approval to the vault, its shares (`$self`) as output, the
  standard `Deposit` event and a phrase from `--name`. `limits.maxAmount`
  stays a decision on mainnet.
- `sessions create` prints a warning when a registration of the template is
  still pending: visitors cannot use the session before it activates.
- `register` and `sessions create` run the same checks as the API
  (`validateContractDefinition`, `validateSessionCreateRequest`) before
  sending anything; a refusal prints the code, the issues and the docs link,
  and exits 1.
- `test` prints the review in the order users see it: who, what (decoded
  arguments and where each comes from), permissions (exact approvals),
  result (simulated asset changes and network fee), provenance (source and
  proxy verification) and the "Not audited by Kletia" notice.
- On mainnet networks a new registration, and any security-relevant update,
  is `pending` until its activation time. `register` tells you how to verify
  your domain (`/.well-known/kletia.json`); run `reverify` once it is served.

None of these commands prepares, signs or submits a transaction.

## Secrets

`keys create`, `keys create-agent`, `keys rotate`, `webhooks create` and
`receipt share` (the share link carries its decryption key) mint a secret that
is shown once. The CLI decides where it goes before calling the API:

- stdout redirected or piped: the secret is the only line on stdout, the
  summary goes to stderr (`kletia keys create ci > ci-key.txt`);
- `--secret-file <path>` (`--out <path>` for `receipt share`): written to a
  new file with mode 600 (an existing file is refused, before anything is
  created);
- `--reveal`: printed on the terminal.

On a terminal without one of these, the command stops before creating
anything.

`keys rotate <id> --grace-seconds 0` is refused for the key in
`KLETIA_API_KEY`: its secret would stop working at once, so a lost response
could not be replayed and the new secret would be gone. Rotate it with another
key of the project, or keep a grace period. If a rotation's response is lost
and the retry is refused, the command fails with `OUTCOME_UNKNOWN` (check
`rotatedAt` and `last4` in `keys list` with another key); a key that revoked
itself is reported as revoked. Everything else the CLI prints is redacted: keys and webhook
secrets appear as `kl_dev_…1234` / `kl_agt_…1234` / `whsec_…abcd`, share links
as `…#s=rsh_…&k=[redacted]`, and the configured
`KLETIA_API_KEY` never appears in output or errors.

## Local webhook development

Real deliveries go only to public HTTPS endpoints. To exercise a local
receiver, forward your key's events to it with `kletia listen`, signed with
your secret exactly like real deliveries:

```bash
export KLETIA_API_KEY=kl_dev_…  KLETIA_WEBHOOK_SECRET=whsec_…
kletia listen --forward-to http://localhost:3000/webhooks/kletia
kletia listen --forward-to http://localhost:3000/webhooks/kletia --event contract.activated --scope subtree
```

It follows `GET /v1/events` (the same routing as your webhooks: contract,
link, rule book and key events as well as intent events), reconnects after
the last event when the API closes the stream, skips events it already
forwarded, and runs until Ctrl-C (or `--wait <seconds>`). Each line shows the
endpoint's HTTP status. Verify on the receiving side with
`constructWebhookEvent` / `expressWebhookHandler` from `@kletia/sdk/server`
([examples/node-server](../../examples/node-server/README.md)).

For one intent only:

```bash
export KLETIA_WEBHOOK_SECRET=whsec_…
kletia webhooks forward --intent int_… --to http://localhost:3000/api/kletia
```

`--to` must be `localhost`, `127.0.0.1` or `[::1]`. Events are delivered in
order with the same headers as real deliveries (`Kletia-Signature`,
`Kletia-Event-Id`, `Kletia-Event-Type`); the command ends with the intent's
final `intent.status_changed`. An intent that already ended is replayed from
the events the API still holds. When the event stream stays unavailable (for
example `429 TOO_MANY_STREAMS`) it is retried within `--wait`; if the final
event still was not forwarded, the command prints a warning and exits 1.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (`intents watch`: the intent completed) |
| 1 | API or runtime error (code, docs link and request id on stderr; Rule Book refusals list their rule ids); a definition, session, rule book or link refused by local validation; `contracts test`: the simulation is not `ok`; `policy evaluate`: deny; `webhooks forward`: not every event could be forwarded |
| 2 | `intents watch` / `webhooks forward`: the intent ended without completing |
| 3 | Receipt invalid (signature, digest, commitment, key, share link, EAS envelope); `policy decisions --verify-chain`: the chain is broken |
| 4 | `receipt reverify`: an on-chain source proved a difference, or sources conflict |
| 5 | Receipt checks inconclusive: sources unavailable (a pruned public node is never evidence), evidence sealed, or the receipt is still pending |
| 6 | `plan`: Kletia needs an answer and there is no terminal to ask in (the `needs_input` JSON is on stdout) |
| 64 | Usage error |
| 130 | Interrupted |

The CLI's version always equals the `@kletia/core` and `@kletia/sdk` versions
it depends on.

## License

MIT
