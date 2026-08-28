# Mokuro Reader is a fully client-side SPA (IndexedDB storage, hash-based
# routing, ssr disabled) — see svelte.config.js — so it builds to static
# files and needs nothing but a static file server at runtime.

FROM node:22-alpine AS build
WORKDIR /app

# The VITE_* values are inlined into the JS bundle at build time by Vite.
# To let docker-compose configure them via env/.env without rebuilding the
# image, we bake in placeholder tokens here and swap them for the real
# values at container startup (see docker/docker-entrypoint.sh).
ARG VITE_GDRIVE_CLIENT_ID=__VITE_GDRIVE_CLIENT_ID__
ARG VITE_GDRIVE_API_KEY=__VITE_GDRIVE_API_KEY__
ARG VITE_ONEDRIVE_CLIENT_ID=__VITE_ONEDRIVE_CLIENT_ID__
ENV VITE_GDRIVE_CLIENT_ID=$VITE_GDRIVE_CLIENT_ID \
    VITE_GDRIVE_API_KEY=$VITE_GDRIVE_API_KEY \
    VITE_ONEDRIVE_CLIENT_ID=$VITE_ONEDRIVE_CLIENT_ID

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/docker-entrypoint.sh /docker-entrypoint.d/40-mokuro-reader-env.sh
RUN chmod +x /docker-entrypoint.d/40-mokuro-reader-env.sh

COPY --from=build /app/build /usr/share/nginx/html

EXPOSE 80
