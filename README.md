# Kletia

Kletia is an intent-driven Web3 aggregator with one application shell and two
strictly isolated execution profiles:

| Profile | Chain                   | Runtime role                                                                                                      |
| ------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Base    | Base Mainnet (`8453`)   | Production DeFi aggregation, Basenames, Across, Allora, x402, token launch, portfolio and security tooling        |
| Arc     | Arc Testnet (`5042002`) | Native-USDC programmable money, swap, liquidity, lending, vault, staking, memo, batch payments and Circle App Kit |

A network switch changes the wallet chain, intent vocabulary, asset registry,
native currency, protocol targets, widgets, response validation and executable
state together. Base plans cannot execute in Arc mode, and Arc plans cannot
execute in Base mode.

## Repository

```text
apps/api        Unified intent API and route engine
apps/web        Unified React interface
contracts/base  Base Mainnet contracts and deployment evidence
contracts/arc   Arc Testnet contracts
attachments     Path-stable hackathon submission files
docs            Architecture, deployment and protocol documentation
tooling         Repository-wide validation
```

See [Repository Structure](docs/REPOSITORY_STRUCTURE.md) for ownership rules
and [Technical Architecture](docs/Kletia_Architecture_OnePager.md) for the
intent lifecycle.

## Requirements

- Node.js 22.13 or newer
- npm
- An EVM wallet supporting Base Mainnet and Arc Testnet

## Local development

API:

```bash
cd apps/api
cp .env.example .env
npm ci --legacy-peer-deps
npm run dev
```

Web application:

```bash
cd apps/web
cp .env.example .env
npm ci --legacy-peer-deps
npm run dev
```

The web application runs at `http://127.0.0.1:5174` and the API defaults to
port `3001` locally. Production services use Render's `PORT` value.

## Configuration boundaries

Server secrets belong only in `apps/api/.env` or the Render API service:

- `OPENROUTER_API_KEY`, `WEBACY_API_KEY`, `ALLORA_API_KEY`
- CDP server credentials for x402, onramp, and optional paymaster routes
- Across API credentials
- dedicated server-side Base RPC credentials

`VITE_*` values are embedded in the browser bundle. They must contain only
public or domain-restricted client configuration. Private keys, deployer keys,
wallet exports, and unrestricted server credentials are never web-runtime
configuration.

## Verification

From the repository root:

```bash
npm run check:structure
npm run typecheck:api
npm run build:api
npm run lint:web
npm run build:web
npm run compile:base
npm run compile:arc
```

The structure check preserves the hackathon attachment paths, rejects old
package roots, prevents Base/Arc contract mixing, and fails if generated build
outputs are tracked.

## Contracts

Base and Arc are independent Hardhat packages:

```bash
npm --prefix contracts/base ci --legacy-peer-deps
npm --prefix contracts/base run compile

npm --prefix contracts/arc ci --legacy-peer-deps
npm --prefix contracts/arc run compile
```

Contract deployment credentials remain in ignored, package-local `.env` files.
Application services do not need deployer private keys.

Operational and migration runbooks:

- [Base V2 router release and verification](contracts/base/contracts/v2/DEPLOYMENT.md)
- [Arc Vault V2 migration](contracts/arc/VAULT_V2_MIGRATION.md)
- [Base contract workspace and X402Factory exact verification](contracts/base/README.md)

## Deployment

[`render.yaml`](render.yaml) defines the two production services that make up
the unified application:

- a Node Web Service from `apps/api` for `api.kletiaai.xyz`
- a Static Site from `apps/web` for `kletiaai.xyz`

The exact dashboard settings, environment boundaries, DNS steps, and release
checks are in [Render Deployment](docs/RENDER_DEPLOYMENT.md).

## License

Kletia is licensed under the [MIT License](LICENSE).
