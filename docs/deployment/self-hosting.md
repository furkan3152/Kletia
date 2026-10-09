# Self-hosting

Kletia runs as two containers (API and web) plus PostgreSQL. The API prepares
unsigned transactions and verifies evidence; it never holds user keys, so a
self-hosted instance needs no wallet material.

## Local evaluation with Docker Compose

```bash
export KLETIA_PLATFORM_SECRET=$(openssl rand -hex 32)
docker compose up --build
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
`KLETIA_OPERATOR_API_KEYS`, `KLETIA_POSTGRES_PASSWORD` and
`VITE_WALLETCONNECT_PROJECT_ID`. Without private RPC URLs the API uses
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
