FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY src ./src
COPY tsconfig.json tsconfig.build.json ./
RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --legacy-peer-deps --omit=dev

COPY --from=build /app/dist ./dist

USER node
EXPOSE 3001

CMD ["node", "dist/index.js"]
