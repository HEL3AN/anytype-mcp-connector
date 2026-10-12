# syntax=docker/dockerfile:1

# The build stage runs on the builder's native platform: the output (dist + production node_modules)
# is plain JavaScript (no native modules), so it is identical for every target architecture.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && mkdir -p /data

# Runtime: distroless Node (no shell, no package manager, minimal OS packages).
FROM gcr.io/distroless/nodejs24-debian13@sha256:96df910f65fdd8a21d00d14d4cc046adcfcf3ced2d5e96be4b39ebde9f4866c6
LABEL org.opencontainers.image.source="https://github.com/HEL3AN/anytype-mcp-connector" \
      org.opencontainers.image.description="Remote MCP server that connects Claude to Anytype" \
      org.opencontainers.image.licenses="MIT"
# PATH: deploy scripts run `docker compose exec connector node ...`.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
# uid 1000 = the `node` user of the earlier Alpine images, so existing /data volumes stay writable.
COPY --from=build --chown=1000:1000 /data /data
USER 1000:1000
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/index.js"]
