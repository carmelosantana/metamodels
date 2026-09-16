#!/usr/bin/env bash
# Bring the whole stack up from a clean state, verify migrate, health and the sign-in hand-off,
# then tear down. Requires a Docker daemon.
#
#   ./scripts/smoke.sh                        # .env.example: host ports 3000 / 8787 / 3100
#   ENV_FILE=.env.verify ./scripts/smoke.sh   # another env file; its ports and URLs move the probes
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.example}"
# A dedicated compose project. Without -p, compose names the project after the directory, so
# running this from a checkout that also hosts a real stack would `down -v` that stack — and
# its database volume — on exit.
PROJECT="${SMOKE_PROJECT:-metamodels-smoke}"
COMPOSE="docker compose -p ${PROJECT} --env-file ${ENV_FILE}"

# Probe the ports and URLs from the same file compose interpolates.
case "$ENV_FILE" in */*) ENV_PATH="$ENV_FILE" ;; *) ENV_PATH="./$ENV_FILE" ;; esac
set -a; . "$ENV_PATH"; set +a
: "${OIDC_ISSUER:?OIDC_ISSUER must be set in $ENV_FILE}"
CONSOLE="http://localhost:${CONTROL_PLANE_PORT:-3000}"
PROXY="http://localhost:${DATA_PLANE_PORT:-8787}"
AUTH="http://localhost:${AUTH_HOST_PORT:-3100}"

cleanup() { $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== building + starting stack (project ${PROJECT}) =="
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
  "data-plane ${PROXY}/healthz" \
  "data-plane ${PROXY}/readyz" \
  "auth ${AUTH}/healthz" \
  "auth ${AUTH}/.well-known/openid-configuration" \
  "control-plane ${CONSOLE}/api/healthz"; do
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

echo "== checking the sign-in hand-off =="
# /login must answer 303 with a Location on the PUBLIC issuer. That proves the console reached
# the auth service over the compose network (OIDC_INTERNAL_URL) AND re-homed the browser-facing
# endpoint onto OIDC_ISSUER rather than http://auth:3100, which no browser can resolve.
read -r status location < <(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' "${CONSOLE}/login")
if [ "$status" != "303" ] || [[ "${location:-}" != "${OIDC_ISSUER}/auth?"* ]]; then
  echo "FAILED: /login answered ${status} -> ${location:-<none>} (expected 303 -> ${OIDC_ISSUER}/auth?...)"
  $COMPOSE logs control-plane auth
  exit 1
fi
echo "OK: console /login -> ${OIDC_ISSUER}/auth"

echo "== smoke passed =="
