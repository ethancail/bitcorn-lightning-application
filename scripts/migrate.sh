#!/bin/bash
# Run database migrations
# TODO: Execute database migration scripts
set -e

echo "[migrate] Running database migrations..."
node dist/db/migrate.js
echo "[migrate] Migrations complete."