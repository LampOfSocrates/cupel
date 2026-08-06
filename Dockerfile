# P1-TDEPLOY — Render demo image (docs/deployment.md:3-12).
# "One Docker container: FastAPI mock serves the API AND the built Vite bundle."

# ---- stage 1: build the frontend ----------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# agentic.config.ts is the one config artifact and src/ imports it (P2-CONFIG,
# src/api/target.ts) — without it `vite build` fails with UNRESOLVED_IMPORT.
COPY index.html tsconfig.json vite.config.ts agentic.config.ts ./
COPY src ./src
RUN npm run build

# ---- stage 2: litestream (P2-PERSIST, only used by SKEIN_STORAGE=s3) -----
# Pinned official image, copied binary only: one static Go executable, no
# runtime deps, no download step that can rot. Present in every image so the
# storage mode stays a pure env flip — SKEIN_STORAGE=local ignores it.
FROM litestream/litestream:0.5.16 AS litestream

# ---- stage 3: runtime ----------------------------------------------------
FROM python:3.12-slim
WORKDIR /app
# Runtime deps only (mock/requirements.txt minus pytest, which is test-only).
# P2-PERSIST adds NO Python dependency: replication is the litestream binary.
RUN pip install --no-cache-dir \
    "fastapi>=0.115" "uvicorn[standard]>=0.30" "python-multipart>=0.0.9" "httpx>=0.27"
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY mock ./mock
COPY --from=frontend /app/dist ./dist
ENV SKEIN_STATIC_DIR=/app/dist
# The database lives outside the code tree so Litestream's sidecar files
# (-wal/-shm) and a restore into an empty dir have somewhere of their own.
ENV SKEIN_MOCK_DB=/app/data/skein-mock.sqlite
RUN mkdir -p /app/data
# Render injects PORT; 4010 is the local default (mock/entrypoint.py).
EXPOSE 4010
# mock.boot picks the storage mode, then execs mock.entrypoint (directly in
# local mode, under `litestream replicate -exec` in s3 mode).
CMD ["python", "-m", "mock.boot"]
