#!/usr/bin/env bash
# Bitcorn Lightning — operator secret loader.
#
# Umbrel's legacy-compat app-script `source_app` runs this file before invoking
# docker compose. We read the operator's .env (next to docker-compose.yml) and
# auto-export each assignment so compose's ${VAR:-} interpolation picks them up
# without us needing to list them individually here.
#
# This replaces the `env_file: [.env]` approach which fails under umbreld's
# invocation — when umbreld runs compose with multiple --file args (its
# fragment + our app's), relative `.env` resolves against the fragment dir
# instead of ours, so the file can't be found.

APP_ENV_FILE="${UMBREL_ROOT}/app-data/bitcorn-lightning-node/.env"
if [[ -f "${APP_ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "${APP_ENV_FILE}"
  set +a
fi
