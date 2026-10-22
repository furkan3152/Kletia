# Status, availability and versioning

What a third party can rely on today, how to tell which code a deployment
runs, and how the API changes over time.

## Hosted endpoints

| What | Where |
|---|---|
| Platform API v1 | `https://api.kletiaai.xyz/v1` |
| Health | `GET https://api.kletiaai.xyz/v1/health` |
| OpenAPI document | `GET https://api.kletiaai.xyz/v1/openapi.json` ([codegen.md](codegen.md)) |
| Error catalog | `GET https://api.kletiaai.xyz/v1/errors` ([errors.md](errors.md)) |
| Status badge | `GET https://api.kletiaai.xyz/v1/status/badge` (SVG) or `?format=shields` |
| Web app, developer portal, embed frame | `https://kletiaai.xyz`, `/developers`, `/embed` |

A self-hosted deployment serves the same paths on its own origins
([self-hosting](../deployment/self-hosting.md)); set `KLETIA_API_ORIGIN` so its
served OpenAPI document names it.

## Health

`GET /v1/health` never fails; it reports:

| Field | Meaning |
|---|---|
| `status` | `ok` (every network answered), `degraded` (some did not) or `down` (none did) |
| `api`, `version` | `v1` and the API contract version (`1.0.0`) |
| `build.commit` | The git commit this deployment runs: `RENDER_GIT_COMMIT` on Render, otherwise `KLETIA_BUILD_COMMIT`; `null` when the deployment does not say |
| `build.source` | `render`, `env` or `null` |
| `time`, `uptimeSeconds` | Server clock and process uptime |
| `networks[]` | Per network: `ok`, `latencyMs`, `height` (latest block or slot), `detail` when not ok |
| `storage` | Where intents, keys, webhooks, contracts and sessions live (`memory`, `postgres`) |
| `policies`, `links`, `webhooks`, `contracts`, `receipts`, `preview` | Whether each feature is enabled and configured |

Compare `build.commit` with the commit you expect (the latest `main`, or the
release you tested). A deployment that answers `null`, or a commit older than
the documentation you are reading, may lack the endpoints those docs describe.
Results are cached for 10 seconds.

## Availability today

| Piece | State |
|---|---|
| Platform API v1 (this repository's `main`) | Live at `https://api.kletiaai.xyz/v1`; also runs locally and self-hosted. Without a database (`KLETIA_DATABASE_URL`) the hosted API keeps keys, projects and intents in memory, so they are lost when the instance restarts |
| Developer portal and `/embed` | Same: part of the web app build, live on the hosted site after a redeploy |
| `@kletia/core`, `@kletia/sdk`, `@kletia/widget`, `@kletia/embed`, `@kletia/cli` on npm | Not yet published. Install from the tarballs attached to the GitHub release of a `packages-v*` tag, or use the SDK as one ES module file from `https://kletiaai.xyz/sdk/kletia-sdk-<version>.js` ([quickstart](quickstart.md#install-without-npm)) |
| Embed script | Served by the site with Subresource Integrity at `https://kletiaai.xyz/sdk/embed/<version>/kletia-embed.min.js` ([embed](embed.md)); no third-party CDN |
| Testnets | Arbitrum Sepolia, Arc Testnet and Solana Devnet, with [sandbox keys](api-v1.md#sandbox-keys) |

The cold start of a free hosting tier takes 65 to 75 seconds; the SDK's
default timeout is 20 seconds per attempt, so the first call after 15 idle
minutes may time out. Retry, or run the API on an always-on instance.

### Public smoke check

`tooling/check-public-deployment.mjs` checks a deployment from the outside,
read-only (nothing is created, signed or sent):

```bash
node tooling/check-public-deployment.mjs https://api.kletiaai.xyz https://kletiaai.xyz
```

It probes `GET /v1/health` (200, `status` ok or degraded, `build.commit`
present), `GET /v1/openapi.json` (an OpenAPI 3.1 document), `/developers`
(HTML), `/embed` (`Content-Security-Policy: frame-ancestors *`), the embed script
manifest (`/sdk/embed/manifest.json`) and the SDK build manifest
(`/sdk/manifest.json`): every listed file hashes to its `sha384` integrity, and
the manifests and files answer `Access-Control-Allow-Origin: *` (without it a
partner page cannot load them). It prints one line per probe and exits 1 when
any fails. `--skip <probe>` leaves one out, `--timeout <ms>` bounds each
request (default 90 s, longer than a cold start), `--json` prints the report as
JSON. The `Public smoke` workflow (`.github/workflows/public-smoke.yml`) is
scheduled hourly and can be run on demand (GitHub delays scheduled runs on
busy days, so runs can be hours apart); a stale or broken hosted deployment
shows up as a failing run. It fails until the operator steps below are done;
that is intended.

## Versioning and deprecation

- The path names the major version (`/v1`). Within v1, changes are additive:
  new endpoints, new optional request fields, new response fields, new error
  codes, new enum values in responses. Clients must ignore unknown response
  fields and treat unknown error codes by their HTTP status and
  `retryable` flag from the [catalog](errors.md).
- A field or endpoint is removed or changed incompatibly only in a new major
  version. Before that, the deprecated item is announced in the
  [changelog](../../CHANGELOG.md) and in the OpenAPI document (`deprecated:
  true`), and its responses carry `Deprecation` (RFC 9745) and `Sunset`
  (RFC 8594) headers with at least 90 days' notice.
- Security fixes may tighten behaviour without notice when the old behaviour
  could put funds at risk (for example a new refusal of an unsafe request);
  such changes use a documented error code.
- The intent spec (`spec: "kletia.intent/v1"`) and the receipt, rule book and
  link schemas are versioned on their own and follow the same rules.

## Operator steps (owned by the operator)

These cannot be done from the repository; the hosted deployment depends on
them:

1. Copy the static site's headers and rewrites from `render.yaml` into the
   dashboard of the hosted site, and set the API's database and secrets
   ([render.md](../deployment/render.md#services-created-in-the-dashboard)).
   Expected afterwards: `GET /v1/health` 200 with `build.commit` and
   `storage: postgres`, `/developers` 200, `/embed` 200 with
   `frame-ancestors *`, `/sdk/embed/manifest.json` with
   `Access-Control-Allow-Origin: *`.
2. Run the API on an always-on instance (no 65-75 second cold starts).
3. Create the npm organisation `kletia`, bump the packages
   (`npm run bump:packages -- 0.2.0`) and push the `packages-v0.2.0` tag; the
   release workflow publishes core, sdk, widget, embed and cli in order.
4. Watch the `Public smoke` workflow turn green.

## Reporting problems

Security issues: follow [SECURITY.md](../../SECURITY.md) (never in a public
issue). Everything else: a GitHub issue with the `X-Request-Id` of the failing
response, the `build.commit` from `GET /v1/health` and the error code.
