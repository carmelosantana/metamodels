#!/usr/bin/env bash
# Bring the whole stack up from a clean state, verify migrate + health, then tear down.
# Requires a Docker daemon. Usage: ./scripts/smoke.sh
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.example}"
COMPOSE="docker compose --env-file ${ENV_FILE}"

cleanup() { $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== building + starting stack =="
$COMPOSE up -d --build

echo "== waiting for migrate to complete =="
# migrate is a one-shot; it should exit 0. Wait for it to finish, then check its exit code.
# `up -d` already blocks on migrate via depends_on: service_completed_successfully, so by the
# time we get here migrate has exited. Some compose versions make `wait` error ("no containers")
# on an already-exited service, so tolerate that; the exit-code check below is the real assertion.
$COMPOSE wait migrate >/dev/null 2>&1 || true
code=$($COMPOSE ps -a --format '{{.ExitCode}}' migrate)
if [ "$code" != "0" ]; then echo "migrate exited $code"; $COMPOSE logs migrate; exit 1; fi
echo "migrate OK"

echo "== waiting for health endpoints =="
for probe in \
  "data-plane http://localhost:8787/healthz" \
  "data-plane http://localhost:8787/readyz" \
  "control-plane http://localhost:3000/api/healthz"; do
  name=$(echo "$probe" | awk '{print $1}')
  url=$(echo "$probe" | awk '{print $2}')
  ok=""
  for _ in $(seq 1 30); do
    if curl -fsS "$url" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [ -z "$ok" ]; then echo "FAILED: $name $url"; $COMPOSE logs "$name"; exit 1; fi
  echo "OK: $name $url"
done

echo "== smoke passed =="
