# Build from the repository root: docker build -f relay/Dockerfile -t nova-relay .
FROM node:24-alpine AS build
WORKDIR /source
COPY package.json package-lock.json tsconfig.base.json ./
COPY runtime/package.json runtime/package.json
COPY cli/package.json cli/package.json
COPY clients/desktop/package.json clients/desktop/package.json
COPY relay/package.json relay/package.json
COPY push-gateway/package.json push-gateway/package.json
RUN --mount=type=secret,id=relay_build_ca \
    if [ -f /run/secrets/relay_build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/relay_build_ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000 --workspace @nova-personal-agent/relay --include-workspace-root
COPY relay/tsconfig.json relay/tsconfig.json
COPY relay/src relay/src
RUN mkdir -p /build/relay && npx tsc -p relay/tsconfig.json --noEmit false --outDir /build/relay
RUN --mount=type=secret,id=relay_build_ca \
    if [ -f /run/secrets/relay_build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/relay_build_ca; fi; \
    npm prune --omit=dev --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000 --workspace @nova-personal-agent/relay --include-workspace-root

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /source/node_modules ./node_modules
COPY --from=build --chown=node:node /build/relay/src ./relay
COPY --chown=node:node relay/package.json ./package.json
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/relay/cli.js"]
CMD ["--config", "/etc/nova-relay/config.json"]
