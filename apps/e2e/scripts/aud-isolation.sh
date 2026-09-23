#!/usr/bin/env bash
# The admin API's audience check, proven against a running throwaway stack (compose project
# mm-m2-e2e only). It starts a second control plane from that project with a different CONSOLE_URL,
# so it expects a different `aud`, and sends it an access token the stack's own control plane
# accepts. The same token must get 200 from the original and 401 from the second. Nothing else
# differs between the two: same image, same OIDC_ISSUER and OIDC_INTERNAL_URL, same key set.
#
#   AUD_ACCESS_TOKEN=<an at+jwt access token for the original console> \
#     apps/e2e/scripts/aud-isolation.sh <compose file> <env file> <free host port> <original console URL>
#
# <compose file> must be this repository's docker-compose.yml (compared by realpath). <env file> is
# the throwaway stack's env file. The script makes exactly one `docker compose` call, from compose()
# below, and that call carries `-p mm-m2-e2e` as a literal. Nothing the caller passes adds or changes
# a project flag: both paths are resolved to absolute paths and passed as `--file=…` and
# `--env-file=…`, one argument each. Compose ranks `-p` above COMPOSE_PROJECT_NAME and above a
# top-level `name:` (docs.docker.com/compose/how-tos/project-name/), so neither the caller's
# environment nor the env file can move the project; COMPOSE_PROJECT_NAME is unset anyway. Before any
# token is sent, the script reads the started container's `com.docker.compose.project` label and
# aborts unless it is exactly `mm-m2-e2e`.
#
# The token is read from AUD_ACCESS_TOKEN into an unexported variable, and AUD_ACCESS_TOKEN is unset
# before any child process starts, so the token is in no argument list and no child environment. It
# reaches curl on stdin and is never printed. This script's own process keeps the environment it was
# started with (`ps e` on its PID). Do not run this under `bash -x`: that would print it.
#
# See apps/e2e/README.md.
set -euo pipefail

# First, before any child process: take the token out of the environment.
aud_token=${AUD_ACCESS_TOKEN:-}
export -n aud_token
unset AUD_ACCESS_TOKEN
unset COMPOSE_PROJECT_NAME

readonly CONTAINER='mm-m2-e2e-aud'
# RFC 2606 reserves `.invalid`: an origin that resolves nowhere, used only as the expected audience.
readonly OTHER_CONSOLE_URL='http://other.invalid'
readonly HEALTH_TIMEOUT_S=180

die() { echo "aud-isolation: $*" >&2; exit 2; }

[[ $# -eq 4 ]] || die "usage: AUD_ACCESS_TOKEN=… $0 <compose file> <env file> <free host port> <original console URL>"
port=$3
original=${4%/}

# --- The compose file must be this repo's; the env file must be a file ----------------------------------
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_compose=$(realpath -e -- "$(git -C "$script_dir" rev-parse --show-toplevel)/docker-compose.yml")
compose_file=$(realpath -e -- "$1" 2>/dev/null) || die "the compose file '$1' does not exist"
[[ $compose_file == "$repo_compose" ]] || die "refusing: '$1' is not ${repo_compose}"
[[ -f $2 ]] || die "the env file '$2' is not a file"
env_file=$(realpath -e -- "$2")

# The only `docker compose` call in this script. The project is this literal, and both paths are
# absolute, so neither can be read as a flag.
compose() {
  docker compose -p mm-m2-e2e --file="$compose_file" --env-file="$env_file" "$@"
}

# --- Arguments and the token ------------------------------------------------------------------------
if ! [[ $port =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 )); then
  die "the host port must be 1024-65535, got '$port'"
fi
[[ $original =~ ^https?://[^/[:space:]]+$ ]] || die "the original console URL must be an origin (http(s)://host[:port]), got '$original'"
[[ -n $aud_token ]] || die "set AUD_ACCESS_TOKEN to an access token for $original (it is never printed)"
[[ $aud_token =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || die "AUD_ACCESS_TOKEN is not a compact JWT"

# Every curl call starts `curl -q -g`. `-q` must be the first argument to stop curl reading a
# .curlrc, which could, for example, turn on `verbose` and print the Authorization header. `-g` turns
# off URL globbing, so `{a,b}` or `[1-2]` in a URL cannot make one call send the token to two URLs.
#
# The port must be free: curl exits 7 only when nothing accepts the connection.
set +e
curl -q -g -s -o /dev/null --max-time 3 "http://127.0.0.1:${port}/"
free=$?
set -e
[[ $free -eq 7 ]] || die "refusing: something already answers on 127.0.0.1:${port}"

# GET /api/admin/v1/flocks with the token; prints only the status. The header goes to curl on its
# stdin (`-H @-`), from `printf`, a shell builtin: the token is in no argument list and no child
# environment.
status_of() {
  printf 'Authorization: Bearer %s\n' "$aud_token" \
    | curl -q -g -sS -o /dev/null -w '%{http_code}' --max-time 20 -H @- "$1/api/admin/v1/flocks"
}

# --- The second control plane -------------------------------------------------------------------------
# Removes this exact container name, on every exit. The only destructive call in this script.
# shellcheck disable=SC2317  # invoked by the EXIT trap
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# An interrupt becomes an ordinary exit, so the EXIT trap runs for it too.
trap 'exit 130' INT
trap 'exit 143' TERM

echo "aud-isolation: starting ${CONTAINER}: CONSOLE_URL=${OTHER_CONSOLE_URL}, on 127.0.0.1:${port}"
# --no-deps: the stack is already up; starting dependencies could re-run `migrate`. The service's own
# port mapping is not applied by `run`, so only this one is published, on loopback. The `-p` after
# `run` is that publish flag, not a project flag.
compose run -d --rm --no-deps --name "$CONTAINER" \
  -e "CONSOLE_URL=${OTHER_CONSOLE_URL}" -p "127.0.0.1:${port}:3000" control-plane >/dev/null

# The container compose actually started must belong to the throwaway project. Checked before any
# request to it and before the token is sent anywhere.
label=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER" 2>/dev/null || true)
[[ $label == 'mm-m2-e2e' ]] || die "refusing: ${CONTAINER} is in compose project '${label}', not mm-m2-e2e; no token was sent"
echo "aud-isolation: ${CONTAINER} is in compose project mm-m2-e2e"

deadline=$(( SECONDS + HEALTH_TIMEOUT_S ))
until curl -q -g -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${port}/api/healthz" 2>/dev/null; do
  (( SECONDS < deadline )) || die "${CONTAINER} did not answer /api/healthz within ${HEALTH_TIMEOUT_S}s"
  sleep 2
done
echo "aud-isolation: ${CONTAINER} is up"

# --- The requests, same token -------------------------------------------------------------------------
# A request that gets no answer at all prints 000; `|| true` keeps it instead of aborting under -e.
# The anchor is asked again after the second console: a token that expired in between would turn a
# refusal for `exp` into a false PASS.
anchor=$(status_of "$original" || true)
echo "original console (${original}): GET /api/admin/v1/flocks -> ${anchor} (expect 200)"
other=$(status_of "http://127.0.0.1:${port}" || true)
echo "second console (CONSOLE_URL=${OTHER_CONSOLE_URL}): GET /api/admin/v1/flocks -> ${other} (expect 401)"
anchor_after=$(status_of "$original" || true)
echo "original console again: GET /api/admin/v1/flocks -> ${anchor_after} (expect 200)"

if [[ $anchor == 200 && $other == 401 && $anchor_after == 200 ]]; then
  echo "aud-isolation: PASS: a token for ${original}/api/admin is refused by a console expecting ${OTHER_CONSOLE_URL}/api/admin"
  exit 0
fi
echo "aud-isolation: FAIL" >&2
[[ $anchor == 200 && $anchor_after == 200 ]] \
  || echo "aud-isolation: the anchor is not 200 both times, so the token proves nothing here; get a fresh one" >&2
exit 1
