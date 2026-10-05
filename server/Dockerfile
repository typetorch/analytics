# TypeTorch analytics server (DuckDB analytics API + SQLite fleet API).
#   docker build -f server/Dockerfile -t typetorch-analytics .
#   docker run -d --name typetorch-analytics --restart unless-stopped -p 127.0.0.1:8787:8787 \
#     --env-file /etc/typetorch/analytics.env -v /var/lib/typetorch-analytics:/data --memory 900m typetorch-analytics
# Debian-based (glibc) so DuckDB's prebuilt linux binding loads.
FROM oven/bun:1.3-slim

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY basin ./basin

ENV NODE_ENV=production \
    TT_ANALYTICS_DATA=/data \
    TT_ANALYTICS_HOST=0.0.0.0 \
    TT_ANALYTICS_PORT=8787
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
EXPOSE 8787
USER bun
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/server/main.ts"]
