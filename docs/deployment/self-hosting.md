# Self-hosting

Kletia runs as two containers (API and web) plus PostgreSQL. The API prepares
unsigned transactions and verifies evidence; it never holds user keys, so a
self-hosted instance needs no wallet material.

## Local evaluation with Docker Compose

```bash
export KLETIA_PLATFORM_SECRET=$(openssl rand -hex 32)
docker compose up --build
```

To run the published images instead of building (see
[Published images](#published-images)):

```bash
export KLETIA_API_IMAGE=ghcr.io/furkan3152/kletia-api:main
export KLETIA_WEB_IMAGE=ghcr.io/furkan3152/kletia-web:main
docker compose up --pull always --no-build
```

| Service | URL | Notes |
|---|---|---|
| Web | http://localhost:10000 | Home, console, Studio, developer portal, `/embed` |
| API | http://localhost:3001 | Console routes under `/api`, Platform API under `/v1` |
| PostgreSQL | internal | Durable intents, developer keys and webhooks |

The compose file runs the API in development mode so the browser may call it
over local HTTP. Optional variables are read from your shell:
`BASE_RPC_URL`, `ARBITRUM_RPC_URL`, `ETHEREUM_RPC_URL`, `OPTIMISM_RPC_URL`,
`POLYGON_RPC_URL`, `SOLANA_RPC_URL`, `JUPITER_API_KEY`, `RELAY_API_KEY`,
`LIFI_API_KEY`, `DEBRIDGE_ACCESS_TOKEN`, `KLETIA_WEB_ORIGIN` (default
`http://localhost:10000`, used for error docs and MCP hand-off links),
`KLETIA_MCP_ALLOWED_ORIGINS`, `KLETIA_OPERATOR_API_KEYS`,
`KLETIA_POSTGRES_PASSWORD`, and for the web build `VITE_WALLETCONNECT_PROJECT_ID`
and the optional wallet RPCs `VITE_ETHEREUM_RPC_URL`, `VITE_OPTIMISM_RPC_URL`
and `VITE_POLYGON_RPC_URL`. Without private RPC URLs the API uses
rate-limited public endpoints and `GET /api/capabilities` reports anything that
still needs configuration.

Smoke test:

```bash
curl -s localhost:3001/v1/health
curl -s -X POST 'localhost:3001/v1/intents?dryRun=true' -H 'content-type: application/json' \
  -d '{"text":"swap 1 SOL to USDC","accounts":["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"]}'
```

## Building the images

Both Dockerfiles build from the repository root:

```bash
docker build -f apps/api/Dockerfile -t kletia-api .
docker build -f apps/web/Dockerfile -t kletia-web --build-arg VITE_BACKEND_URL=https://api.example.com .
```

`VITE_*` build arguments are compiled into the public bundle; never pass a
secret. Behind a TLS-intercepting proxy, give npm the proxy CA as a build
secret: `--secret id=npm_ca,src=/path/to/ca.pem`.

Both images listen on port `10000` (`PORT`); the API image also has a
`HEALTHCHECK` on `/health`. Docker Compose runs the API on `3001`.

## Published images

[`images.yml`](../../.github/workflows/images.yml) builds both images on every
push to `main` and on every `v*` release tag, and pushes them to the GitHub
Container Registry:

| Image | Tags |
|---|---|
| `ghcr.io/furkan3152/kletia-api` | `main`, `sha-<short commit>`; for a tag `v2.1.0`: `2.1.0`, `2.1`, `latest` |
| `ghcr.io/furkan3152/kletia-web` | the same |

Each image is `linux/amd64` and carries SLSA provenance (`mode=max`) and an
SPDX SBOM as registry attestations. Inspect them before you deploy:

```bash
docker buildx imagetools inspect ghcr.io/furkan3152/kletia-api:main --format '{{ json .Provenance }}'
docker buildx imagetools inspect ghcr.io/furkan3152/kletia-api:main --format '{{ json .SBOM }}'
```

Deploy by digest (`ghcr.io/furkan3152/kletia-api@sha256:…`) rather than a
moving tag. The workflow also starts each pushed image and checks `/health`
(API) and the framing headers (web) before it finishes.

The published web image is built with the Dockerfile defaults: it calls the
API at `http://localhost:3001`, which suits Docker Compose. `VITE_*` values are
compiled into the bundle, so for any other API origin build the web image
yourself with `--build-arg VITE_BACKEND_URL=https://api.example.com` (and
`VITE_ALLOW_LOCAL_BACKEND=false`). The API image needs no build arguments; it is
configured entirely through environment variables.

## Public deployment checklist

- Serve both services over HTTPS and run the API with `NODE_ENV=production`.
- Set `CORS_ORIGINS` to the exact HTTPS origin of your web app.
- Set `KLETIA_DATABASE_URL` and `KLETIA_PLATFORM_SECRET` (at least 32
  characters; required whenever a database is configured).
- Use private RPC endpoints (`BASE_RPC_URL`, `ARBITRUM_RPC_URL`,
  `SOLANA_RPC_URL`) and set `TRUST_PROXY_HOPS` to the number of proxies in front
  of the API.
- Keep one long-running API process (or more behind a load balancer): the
  settlement poller and webhook dispatcher run inside it.
- Keep the web server's framing rules: only `/embed` may be framed by other
  sites. `scripts/serve-production.mjs` (used by the web image) already sends
  them.
- Optional integrations (Webacy, Allora, Across, CDP on-ramp, x402) stay
  disabled until their keys are set; set `KLETIA_REQUIRE_ALL_FEATURES=true` to
  refuse to start without them.
- Run `GET /api/release/mvp-readiness` and `GET /api/capabilities` after every
  deploy.
