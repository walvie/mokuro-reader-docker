# Read-only HTTP API that serves a mounted manga library directly to the
# reader, bypassing browser storage. See docker-compose.yml (service
# "library-server") and README.md ("Self-hosted server library").

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 3300
CMD ["node", "dist/index.js"]
