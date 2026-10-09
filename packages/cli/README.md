# @kletia/cli

The Kletia intent API from your terminal: list networks and venues, quote a
movement, plan an intent, follow it live, and manage your API keys and
webhooks. Built on [`@kletia/sdk`](../sdk/README.md).

The CLI never prepares, signs or submits a transaction and never holds funds.
Execution happens in your users' wallets (SDK, widget or Studio).

```bash
npx @kletia/cli networks
npx @kletia/cli quote 25 USDC --from base --to solana
npx @kletia/cli plan "bridge 25 USDC from base to solana then swap half to JitoSOL" \
  --account base:0xYourEvmAddress --account solana:YourSolanaAddress
```

Install it globally with `npm install -g @kletia/cli` to get the `kletia`
command. Node 20 or newer.

## Configuration

| Variable | Purpose |
|---|---|
| `KLETIA_API_KEY` | Developer key (`kl_dev_…`) for keyed commands and higher limits |
| `KLETIA_BASE_URL` | API origin (default `https://api.kletiaai.xyz`; `http://` only for localhost) |
| `KLETIA_WEBHOOK_SECRET` | Signing secret for `webhooks verify` and `webhooks forward` (comma-separated during a rotation) |

Secrets are read from the environment only. `--api-key` and similar flags are
refused, because flags end up in shell history and process lists.

## Commands

| Command | What it does |
|---|---|
| `health` | API and per-network RPC health |
| `networks`, `protocols`, `assets [--network <key>]` | Registries |
| `venues [--network <key>] [--protocol <id>]` | EVM lending venues with supply APY, size and exit liquidity |
| `quote <amount> <asset> [<to-asset>] --from <network> [--to <network>]` | Best routes for one movement; the best is marked `*`. `--max-seconds` sets the bridge time limit (default 600) |
| `plan "<text>" --account <account>…` | Plans an intent as a dry run; `--save` stores it. `--max-slippage-bps` and `--max-seconds` set constraints |
| `intents get <id>`, `intents list` | Read intents (`list` needs a key) |
| `intents watch <id>` | Follows the event stream until the intent ends |
| `keys create <name>`, `keys list`, `keys rotate <id> [--grace-seconds N]`, `keys revoke <id> --yes` | Key management |
| `webhooks list`, `webhooks create <url> [--event <type>]`, `webhooks delete <id> --yes` | Webhook management |
| `webhooks test <id>`, `webhooks deliveries <id>` | Send a signed test event now; read the delivery log |
| `webhooks verify --signature "<header>" [--file body.json]` | Checks a delivery's signature (body on stdin by default) |
| `webhooks forward --intent <id> --to http://localhost:3000/…` | Forwards an intent's events to a local endpoint, signed like real deliveries |
| `usage [--window 24h\|7d]`, `errors [<CODE>]`, `openapi` | Usage of your key, the error catalog, the OpenAPI document |

Accounts are CAIP-10 ids (`eip155:8453:0x…`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:…`)
or the shorthand `<network>:<address>` (`base:0x…`, `solana:…`). Add `--json`
to any command for machine-readable output on stdout, and `--help` for its
options.

`plan` prints the steps, venues, amounts with their minimums, and lists every
step that sends funds to an account that is not one of yours (your own address
on another network of the same VM, such as a bridge's default recipient, counts
as yours).

## Secrets

`keys create`, `keys rotate` and `webhooks create` mint a secret that is shown
once. The CLI decides where it goes before calling the API:

- stdout redirected or piped: the secret is the only line on stdout, the
  summary goes to stderr (`kletia keys create ci > ci-key.txt`);
- `--secret-file <path>`: written to a new file with mode 600 (an existing
  file is refused, before anything is created);
- `--reveal`: printed on the terminal.

On a terminal without one of these, the command stops before creating
anything. Everything else the CLI prints is redacted: keys and webhook
secrets appear as `kl_dev_…1234` / `whsec_…abcd`, and the configured
`KLETIA_API_KEY` never appears in output or errors.

## Local webhook development

Real deliveries go only to public HTTPS endpoints. To exercise a local
receiver, forward an intent's events to it, signed with your secret:

```bash
export KLETIA_WEBHOOK_SECRET=whsec_…
kletia webhooks forward --intent int_… --to http://localhost:3000/api/kletia
```

`--to` must be `localhost`, `127.0.0.1` or `[::1]`. Events are delivered in
order with the same headers as real deliveries (`Kletia-Signature`,
`Kletia-Event-Id`, `Kletia-Event-Type`); the command ends with the intent.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (`intents watch`: the intent completed) |
| 1 | API or runtime error (code, docs link and request id on stderr) |
| 2 | `intents watch` / `webhooks forward`: the intent ended without completing |
| 64 | Usage error |
| 130 | Interrupted |

The CLI's version always equals the `@kletia/core` and `@kletia/sdk` versions
it depends on.

## License

MIT
