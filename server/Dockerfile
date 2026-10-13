# Build from the repository root:  docker build -f server/Dockerfile -t kerf-server .
FROM node:22-slim AS editor
WORKDIR /app/editor
COPY editor/package*.json ./
RUN npm ci
COPY editor/ ./
COPY shared/ /app/shared/
RUN npm run build

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 KERF_DATA_DIR=/data KERF_SHARED_DIR=/app/shared KERF_EDITOR_DIST=/app/editor-dist
WORKDIR /app
COPY server/ /app/server/
COPY shared/ /app/shared/
RUN pip install --no-cache-dir /app/server
COPY --from=editor /app/editor/dist /app/editor-dist
VOLUME /data
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["kerf-server"]
