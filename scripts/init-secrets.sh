#!/bin/bash
# Initialize secrets for the application
# TODO: Generate and store required secrets (JWT keys, API keys, etc.)
#!/bin/sh
set -e

SECRETS_DIR="/data/secrets"

echo "[init-secrets] Ensuring secrets directory exists..."
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

generate_secret() {
  FILE="$1"
  BYTES="$2"

  if [ -f "$FILE" ]; then
    echo "[init-secrets] Secret already exists: $(basename "$FILE")"
  else
    echo "[init-secrets] Generating secret: $(basename "$FILE")"
    umask 177
    head -c "$BYTES" /dev/urandom | base64 > "$FILE"
    chmod 600 "$FILE"
  fi
}

# Core application secrets
generate_secret "$SECRETS_DIR/db.key" 64
generate_secret "$SECRETS_DIR/jwt.key" 64
generate_secret "$SECRETS_DIR/hmac.key" 64

echo "[init-secrets] Secret initialization complete."
