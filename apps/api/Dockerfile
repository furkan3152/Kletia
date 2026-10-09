# Build from the repository root (npm workspace):
#   docker build -f apps/api/Dockerfile -t kletia-api .
# Behind a TLS-intercepting proxy, pass its CA bundle as a build secret:
#   docker build --secret id=npm_ca,src=/path/to/ca.pem -f apps/api/Dockerfile .
FROM node:22.23.1-alpine3.24 AS build

WORKDIR /repo

COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/widget/package.json packages/widget/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=npm_ca,required=false \
  NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm ci --include=dev --ignore-scripts --workspace @kletia/core --workspace @kletia/api

COPY packages/core packages/core
COPY apps/api apps/api
RUN npm run build -w @kletia/core && npm run build -w @kletia/api

FROM node:22.23.1-alpine3.24 AS runtime

WORKDIR /repo
ENV NODE_ENV=production

COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/widget/package.json packages/widget/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=npm_ca,required=false \
  NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm ci --omit=dev --ignore-scripts --workspace @kletia/core --workspace @kletia/api

COPY --from=build /repo/packages/core/dist packages/core/dist
COPY --from=build /repo/apps/api/dist apps/api/dist

USER node
EXPOSE 10000

CMD ["node", "apps/api/dist/index.js"]
