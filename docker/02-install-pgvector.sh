#!/bin/bash
# Install pgvector extension at container startup (not build time, since we have no network during Docker build)

if [ -f "/usr/local/share/postgresql/extension/vector.control" ]; then
  echo "[INIT] pgvector already installed"
  exit 0
fi

echo "[INIT] Installing pgvector extension..."

# Install build dependencies (pgvector needs gcc/make/git to compile)
apk add --no-cache \
  build-base git cmake libssl3 zlib-dev curl wget make gcc g++ pkgconfig 2>/dev/null || true

cd /tmp
if git clone https://github.com/pgvectorscale/pgvector.git 2>&1 | tail -1; then
  cd pgvector && \
  make PG_CONFIG=/usr/local/bin/pg_config 2>&1 | tail -3 && \
  make install PG_CONFIG=/usr/local/bin/pg_config 2>&1 | tail -3 && \
  echo "[INIT] pgvector installed successfully" || {
    echo "[INIT] WARNING: pgvector build failed, extension may not be available"
  }
else
  echo "[INIT] WARNING: Could not clone pgvector repo (no network), skipping"
fi

rm -rf /tmp/pgvector 2>/dev/null || true
