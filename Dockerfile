ARG NODE_IMAGE=node:24.18.0-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker:29-cli
ARG POSTGRES_IMAGE=postgres:18-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650
FROM ${DOCKER_CLI_IMAGE} AS docker-cli
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY docs ./docs
COPY scripts ./scripts
COPY LICENSE COPYING.md README.md UPSTREAM.md CONTRIBUTING.md SECURITY.md AGENTS.md ./
COPY LICENSES ./LICENSES
COPY Dockerfile .dockerignore .gitignore .gitattributes .npmrc .env.example compose.yaml compose.build.yaml biome.json vitest.base.ts install.sh upgrade.sh uninstall.sh ./
COPY deploy ./deploy
COPY fixtures ./fixtures
COPY .github ./.github
COPY .husky ./.husky
RUN npm ci --registry="$NPM_REGISTRY" --ignore-scripts --no-audit --no-fund --fetch-retries=3 --fetch-timeout=60000 \
    && npm run build --workspace=@earendil-works/pi-telemetry \
    && npm run build:offline --workspace=@earendil-works/pi-ai \
    && npm run build --workspace=@setdraft/authoring \
    && npm run build --workspace=@setdraft/server \
    && npm run build --workspace=@setdraft/web \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
FROM ${NODE_IMAGE} AS web
LABEL org.opencontainers.image.source="https://github.com/Albert-Li-Sz/setdraft" \
      org.opencontainers.image.title="Setdraft" \
      org.opencontainers.image.description="Competitive programming authoring workspace" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
ENV NODE_ENV=production SETDRAFT_HOST=0.0.0.0 SETDRAFT_WEB_ROOT=/app/packages/hydro-web/dist
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/LICENSE /app/COPYING.md ./
COPY --from=build /app/LICENSES ./LICENSES
COPY deploy/container-entrypoint.sh /usr/local/bin/setdraft-entrypoint
RUN command -v flock && chmod +x /usr/local/bin/setdraft-entrypoint
EXPOSE 4321
ENTRYPOINT ["setdraft-entrypoint"]
CMD ["node", "packages/hydro-server/dist/cli.js"]

FROM ${POSTGRES_IMAGE} AS maintenance
LABEL org.opencontainers.image.source="https://github.com/Albert-Li-Sz/setdraft" \
      org.opencontainers.image.title="Setdraft maintenance" \
      org.opencontainers.image.description="PostgreSQL and workspace backup and restore tools" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=web /app /app
ENTRYPOINT ["node", "scripts/compose-maintenance.mjs"]
