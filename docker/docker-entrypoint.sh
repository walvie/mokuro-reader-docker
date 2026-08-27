#!/bin/sh
# Runs automatically before nginx starts (see /docker-entrypoint.d in the
# nginx:alpine image). The image is built once with placeholder tokens baked
# into the JS bundle in place of the VITE_* values (see Dockerfile); this
# swaps them for the real values from the container's environment so the
# same image can be reconfigured per-deployment via docker-compose/.env
# without rebuilding.
set -eu

substitute() {
  token="$1"
  # Escape sed special characters (\, |, &) so arbitrary key/secret values
  # can't break the substitution expression.
  value=$(printf '%s' "$2" | sed -e 's/[\&|]/\\&/g')
  find /usr/share/nginx/html -type f -name '*.js' -exec \
    sed -i "s|${token}|${value}|g" {} +
}

substitute '__VITE_GDRIVE_CLIENT_ID__' "${VITE_GDRIVE_CLIENT_ID:-}"
substitute '__VITE_GDRIVE_API_KEY__' "${VITE_GDRIVE_API_KEY:-}"
substitute '__VITE_ONEDRIVE_CLIENT_ID__' "${VITE_ONEDRIVE_CLIENT_ID:-}"
