#!/bin/sh
set -eu

echo "[WORKER] Waiting for database connection..."

until nc -z "${DB_HOST:-postgres}" "${DB_PORT:-5432}"; do
  echo "[WORKER] Database not ready, waiting..."
  sleep 2
done

echo "[WORKER] Database connection established"

mkdir -p \
  /app/backend/uploads/trades \
  /app/backend/uploads/diary \
  /app/backend/uploads/avatars \
  /app/backend/src/data/backups \
  /app/backend/src/logs

chown -R appuser:appgroup \
  /app/backend/uploads \
  /app/backend/src/data \
  /app/backend/src/logs

cd /app/backend

echo "[WORKER] Starting Teejarah background worker..."
exec su-exec appuser node src/server.js
