# syntax=docker/dockerfile:1

# Pinned by @sha256: digest (base for BOTH published GHCR images). Refresh with:
#   docker buildx imagetools inspect node:24-bookworm-slim --format '{{.Manifest.Digest}}'
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app

# --- deps: install the whole workspace once (full install; tsx is a devDep the tsx apps need) ---
FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

# --- control-plane: build then serve with next start ---
FROM deps AS control-plane-build
RUN pnpm --filter @metamodels/control-plane build

FROM control-plane-build AS control-plane
WORKDIR /app/apps/control-plane
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "start"]

# --- tsx-app: run data-plane / worker / migrate straight from TS source ---
FROM deps AS tsx-app
ARG APP
WORKDIR /app/apps/${APP}
CMD ["pnpm", "start"]

# --- runtime: all workspace TS source + tsx in one image. The deploy compose runs
#     data-plane / worker / migrate from it via per-service working_dir + command. ---
FROM deps AS runtime
WORKDIR /app
ENV NODE_ENV=production
