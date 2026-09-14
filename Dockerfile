# syntax=docker/dockerfile:1
# Portal production image (I1-4): pnpm fetch layer cache → build → nginx.

FROM node:24-alpine AS build
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Dependency layer: only the manifest + lockfile invalidate the cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# Build args are BAKE-TIME: Vite env vars are inlined into the bundle.
ARG VITE_GATEWAY_WS_URL
ARG VITE_MAP_STYLE_URL
ARG VITE_RASTER_TILES_URL
ARG VITE_TILES_MAX_BYTES
ARG VITE_DEFAULT_QUALITY
ENV VITE_GATEWAY_WS_URL=$VITE_GATEWAY_WS_URL \
    VITE_MAP_STYLE_URL=$VITE_MAP_STYLE_URL \
    VITE_RASTER_TILES_URL=$VITE_RASTER_TILES_URL \
    VITE_TILES_MAX_BYTES=$VITE_TILES_MAX_BYTES \
    VITE_DEFAULT_QUALITY=$VITE_DEFAULT_QUALITY

COPY . .
RUN pnpm install --frozen-lockfile --offline \
 && pnpm --filter @twin/portal build

FROM nginx:1.27-alpine AS runtime
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/portal/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
CMD ["nginx", "-g", "daemon off;"]
