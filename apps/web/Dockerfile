# Build from the repository root (npm workspace):
#   docker build -f apps/web/Dockerfile -t kletia-web \
#     --build-arg VITE_BACKEND_URL=https://api.example.com .
# VITE_* values are compiled into the public bundle: never pass secrets.
# Behind a TLS-intercepting proxy, add --secret id=npm_ca,src=/path/to/ca.pem.
FROM node:22.23.1-alpine3.24 AS build

WORKDIR /repo

ARG VITE_BACKEND_URL=http://localhost:3001
ARG VITE_ALLOW_LOCAL_BACKEND=true
ARG VITE_WALLETCONNECT_PROJECT_ID=
ARG VITE_BASE_RPC_URL=https://mainnet.base.org
ARG VITE_ALLOW_PUBLIC_BASE_RPC_FALLBACK=true
ARG VITE_ARC_RPC_URL=https://rpc.testnet.arc.network
ARG VITE_ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
# Optional wallet RPCs for intent steps on Ethereum, OP Mainnet and Polygon;
# empty uses the public endpoints built into the app.
ARG VITE_ETHEREUM_RPC_URL=
ARG VITE_OPTIMISM_RPC_URL=
ARG VITE_POLYGON_RPC_URL=
ARG VITE_ARBITRUM_MVP_ENABLED=true
ARG VITE_ARC_VAULT_EXECUTION_MODE=vault_v2
ARG VITE_ARC_VAULT_V2_ADDRESS=0xBe385e3520C20D44697CC1bEEDc9DF759C3A184d
ARG VITE_BASE_SWAP_EXECUTION_MODE=intent_v2
ARG VITE_BASE_PAYMASTER_ENABLED=false

COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/widget/package.json packages/widget/
COPY packages/embed/package.json packages/embed/
COPY packages/cli/package.json packages/cli/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=npm_ca,required=false \
  NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm ci --include=dev --ignore-scripts \
  --workspace @kletia/core --workspace @kletia/sdk --workspace @kletia/widget --workspace @kletia/web

COPY packages packages
COPY apps/web apps/web
# Only the packages the web app imports; @kletia/embed and @kletia/cli are not installed here.
RUN npm run build -w @kletia/core && npm run build -w @kletia/sdk && npm run build -w @kletia/widget \
  && npm run build -w @kletia/web

FROM node:22.23.1-alpine3.24 AS runtime

WORKDIR /srv
ENV NODE_ENV=production PORT=10000

# The production server only uses Node built-ins and sends the same framing,
# caching and security headers as the hosted static site.
COPY --from=build /repo/apps/web/scripts/serve-production.mjs scripts/serve-production.mjs
COPY --from=build /repo/apps/web/dist dist

USER node
EXPOSE 10000

CMD ["node", "scripts/serve-production.mjs"]
