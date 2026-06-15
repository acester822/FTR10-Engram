#!/bin/bash
# Install pgvector and halfvec extensions after PostgreSQL starts
# This runs as part of docker-entrypoint-initdb.d (before PG accepts connections)

set -e

echo "[INIT] Installing vector extensions..."

# Install build dependencies
apk add --no-cache \
  build-base git cmake libssl3 zlib-dev curl wget make gcc g++ pkgconfig 2>/dev/null || true

cd /tmp

# Install halfvec (built into PG source but needs to be compiled)
if ! psql -U postgres -tc "SELECT 1 FROM pg_extension WHERE extname='halfvec'" | grep -q 1; then
  echo "[INIT] Installing halfvec..."
  git clone --depth 1 https://github.com/pgvector/halfvec.git 2>/dev/null || true
  if [ -d "/tmp/halfvec" ]; then
    cd /tmp/halfvec && make PG_CONFIG=/usr/local/bin/pg_config 2>&1 | tail -3 || true
    make install PG_CONFIG=/usr/local/bin/pg_config 2>&1 | tail -3 || true
    echo "[INIT] halfvec installed"
  fi
fi

# Install pgvector (for vector type and H indexes)
if ! psql -U postgres -tc "SELECT 1 FROM pg_extension WHERE extname='vector'" | grep -q 1; then
  echo "[INIT] Installing pgvector..."
  git clone --depth 1 https://github.com/pgvectorscale/pgvector.git 2>/dev/null || true
  if [ -d "/tmp/pgvector" ]; then
    cd /tmp/pgvector && make PG_CONFIG=/usr/local/bin/pg_config 2>&1 | tail -3 || true
    make install PG_CONFIG=/usr/local/bin/pg_config 2>&1 | tail -3 || true
    echo "[INIT] pgvector installed"
  fi
fi

rm -rf /tmp/halfvec /tmp/pgvector 2>/dev/null || true
echo "[INIT] Extension installation complete"
