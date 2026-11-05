# Used by directories (e.g. Glama) that build and introspect MCP servers.
# Defaults to mock mode so the image starts without SAP credentials.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production SAPB1_MOCK=1
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY fixtures ./fixtures
COPY config/saved-queries.example.json ./config/saved-queries.example.json
USER node
ENTRYPOINT ["node", "dist/index.js"]
