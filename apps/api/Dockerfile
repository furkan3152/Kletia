# Build from the repository root (npm workspace):
#   docker build -f apps/api/Dockerfile -t kletia-api .
# Every workspace manifest is copied so `npm ci` can check the lockfile; only
# @kletia/core and the API are installed and built.
# The API listens on PORT (10000 in this image); Docker Compose sets 3001.
# Behind a TLS-intercepting proxy, pass its CA bundle as a build secret:
#   docker build --secret id=npm_ca,src=/path/to/ca.pem -f apps/api/Dockerfile .
FROM node:22.23.1-alpine3.24 AS build

WORKDIR /repo

COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/widget/package.json packages/widget/
COPY packages/embed/package.json packages/embed/
COPY packages/cli/package.json packages/cli/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=npm_ca,required=false \
  NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm ci --include=dev --ignore-scripts --workspace @kletia/core --workspace @kletia/api

COPY packages/core packages/core
COPY apps/api apps/api
RUN npm run build -w @kletia/core && npm run build -w @kletia/api

FROM node:22.23.1-alpine3.24 AS runtime

WORKDIR /repo
ENV NODE_ENV=production PORT=10000

# Keep root metadata readable by USER node under a restrictive host umask.
COPY --chmod=644 package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/widget/package.json packages/widget/
COPY packages/embed/package.json packages/embed/
COPY packages/cli/package.json packages/cli/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=npm_ca,required=false \
  NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm ci --omit=dev --ignore-scripts --workspace @kletia/core --workspace @kletia/api

COPY --from=build /repo/packages/core/dist packages/core/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
# COPY preserves host permissions; runtime manifests and artifacts are read-only
# to node, with traversable directories. npm-installed executable bits stay intact.
RUN find packages apps -type d -exec chmod 755 {} + \
  && find packages apps -type f -exec chmod 644 {} +

USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -Y off -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "apps/api/dist/index.js"]
