# Downloads and verifies the pinned inputs listed in deploy/inputs.json.
FROM docker.io/library/node:26-trixie-slim AS inputs
RUN apt-get update \
 && apt-get install -y --no-install-recommends bzip2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY deploy/inputs.json deploy/fetch-inputs.mjs /build/deploy/
RUN node /build/deploy/fetch-inputs.mjs /vendor

# Node 26 is required: the analyzer sandbox relies on the permission model's --allow-net.
FROM docker.io/library/node:26-trixie-slim
COPY --from=inputs /vendor /app/vendor
COPY server /app/server
COPY analyzer /app/analyzer
COPY runtime /app/runtime
COPY web /app/web
ENV KALAPANA_DATA_DIR=/data \
    KALAPANA_PORT=8080
USER node
EXPOSE 8080
CMD ["node", "/app/server/main.mjs"]
