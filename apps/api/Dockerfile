FROM node:22.23.1-alpine3.24 AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev --legacy-peer-deps

COPY src ./src
COPY tsconfig.json tsconfig.build.json ./
RUN npm run build

FROM node:22.23.1-alpine3.24 AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --legacy-peer-deps --omit=dev

COPY --from=build /app/dist ./dist

USER node
EXPOSE 10000

CMD ["node", "dist/index.js"]
