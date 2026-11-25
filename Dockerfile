FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 SESSION_DIR=/data/sessions
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json .
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /data/sessions && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/server.mjs"]
