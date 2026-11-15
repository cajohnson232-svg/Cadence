# Cadence: the website and the scheduling engine in one image.
# A hosting service builds this file and runs the result; see DEPLOY.md.

# ── 1. build the website ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS web
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# The build never connects to a database; these stand-in values only satisfy tools that insist on one being named.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" NEXT_TELEMETRY_DISABLED=1 \
    sh -c "npx prisma generate && npm run build"

# ── 2. what actually runs ───────────────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

# Python for the scheduling engine, in its own environment so nothing else on the system can disturb it
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN python3 -m venv /opt/engine && /opt/engine/bin/pip install --no-cache-dir -r requirements.txt
COPY run.py ./
COPY cadence ./cadence
ENV ENGINE_DIR=/app ENGINE_PYTHON=/opt/engine/bin/python

COPY --from=web --chown=node:node /app/web ./web
WORKDIR /app/web
USER node

# The hosting service says which port to listen on through PORT. On start: bring the database up to date
# (only ever adds what is missing), then serve the site.
EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node_modules/.bin/next start -H 0.0.0.0 -p ${PORT:-3000}"]
