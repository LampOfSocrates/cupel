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

# ---- stage 2: runtime ----------------------------------------------------
FROM python:3.12-slim
WORKDIR /app
# Runtime deps only (mock/requirements.txt minus pytest, which is test-only).
RUN pip install --no-cache-dir \
    "fastapi>=0.115" "uvicorn[standard]>=0.30" "python-multipart>=0.0.9" "httpx>=0.27"
COPY mock ./mock
COPY --from=frontend /app/dist ./dist
ENV SKEIN_STATIC_DIR=/app/dist
# Render injects PORT; 4010 is the local default (mock/entrypoint.py).
EXPOSE 4010
CMD ["python", "-m", "mock.entrypoint"]
