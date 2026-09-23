#!/usr/bin/env bash
# The admin API's audience check, proven against a running throwaway stack (compose project
# mm-m2-e2e only). It starts a second control plane from that project with a different CONSOLE_URL,
# so it expects a different `aud`, and sends it an access token the stack's own control plane
# accepts. The same token must get 200 from the original and 401 from the second. Nothing else
# differs between the two: same image, same OIDC_ISSUER and OIDC_INTERNAL_URL, same key set.
#
#   AUD_ACCESS_TOKEN=<an at+jwt access token for the original console> \
#     apps/e2e/scripts/aud-isolation.sh <compose wrapper> <free host port> <original console URL>
#
# <compose wrapper> is an executable that runs `docker compose -p mm-m2-e2e … "$@"`. The script
# refuses any wrapper that does not hard-code that project, and never calls `docker compose` itself.
# The token is read from the environment, never from an argument, so it stays out of `ps`, and it is
# never printed. Do not run this under `bash -x`: that would print it.
#
# See apps/e2e/README.md.
set -euo pipefail

readonly PROJECT='mm-m2-e2e'
readonly CONTAINER='mm-m2-e2e-aud'
# RFC 2606 reserves `.invalid`: an origin that resolves nowhere, used only as the expected audience.
readonly OTHER_CONSOLE_URL='http://other.invalid'
readonly HEALTH_TIMEOUT_S=180

die() { echo "aud-isolation: $*" >&2; exit 2; }

[[ $# -eq 3 ]] || die "usage: AUD_ACCESS_TOKEN=… $0 <compose wrapper> <free host port> <original console URL>"
wrapper=$1
port=$2
original=${3%/}

# --- The wrapper must hard-code the throwaway project, and name no other ---------------------------
[[ -f $wrapper && -x $wrapper ]] || die "$wrapper is not an executable file"
# Only lines that are not comments count: a `-p mm-m2-e2e` in a comment proves nothing.
code=$(grep -Ev '^[[:space:]]*(#|$)' "$wrapper" || true)
if ! grep -Eq -- "docker[[:space:]]+compose[[:space:]]+(.*[[:space:]])?-p[[:space:]]+${PROJECT}([[:space:]]|$)" <<<"$code"; then
  die "refusing: $wrapper does not hard-code \`docker compose -p ${PROJECT}\`"
fi
# Every project flag in it must name that project: no second -p, --project-name or -p=… elsewhere.
while read -r value; do
  [[ -z $value ]] && continue
  [[ $value == "$PROJECT" ]] || die "refusing: $wrapper also names the compose project '$value'"
done < <(grep -Eo -- '(^|[[:space:]])(-p|--project-name)([[:space:]]+|=)[^[:space:]]+' <<<"$code" \
  | sed -E 's/^[[:space:]]*(-p|--project-name)([[:space:]]+|=)//')
if grep -Eq 'COMPOSE_PROJECT_NAME' <<<"$code"; then
  die "refusing: $wrapper sets COMPOSE_PROJECT_NAME; let -p ${PROJECT} be the only project name"
fi
echo "aud-isolation: $wrapper hard-codes -p ${PROJECT}"

# --- Arguments and the token ------------------------------------------------------------------------
if ! [[ $port =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 )); then
  die "the host port must be 1024-65535, got '$port'"
fi
[[ $original =~ ^https?://[^/[:space:]]+$ ]] || die "the original console URL must be an origin (http(s)://host[:port]), got '$original'"
[[ -n ${AUD_ACCESS_TOKEN:-} ]] || die "set AUD_ACCESS_TOKEN to an access token for $original (it is never printed)"
[[ $AUD_ACCESS_TOKEN =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || die "AUD_ACCESS_TOKEN is not a compact JWT"

# The port must be free: curl exits 7 only when nothing accepts the connection.
set +e
curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${port}/"
free=$?
set -e
[[ $free -eq 7 ]] || die "refusing: something already answers on 127.0.0.1:${port}"

# GET /api/admin/v1/flocks with the token; prints only the status. The header goes to curl on its
# stdin (`-H @-`), from `printf`, a shell builtin: the token is in no process's argument list.
status_of() {
  printf 'Authorization: Bearer %s\n' "$AUD_ACCESS_TOKEN" \
    | curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -H @- "$1/api/admin/v1/flocks"
}

# --- The second control plane -------------------------------------------------------------------------
# The only direct docker call in this script, and only on this exact name. It runs on every exit.
# shellcheck disable=SC2317  # invoked by the EXIT trap
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# An interrupt becomes an ordinary exit, so the EXIT trap runs for it too.
trap 'exit 130' INT
trap 'exit 143' TERM

echo "aud-isolation: starting ${CONTAINER}: CONSOLE_URL=${OTHER_CONSOLE_URL}, on 127.0.0.1:${port}"
# --no-deps: the stack is already up; starting dependencies could re-run `migrate`. The service's own
# port mapping is not applied by `run`, so only this one is published, on loopback.
"$wrapper" run -d --rm --no-deps --name "$CONTAINER" \
  -e "CONSOLE_URL=${OTHER_CONSOLE_URL}" -p "127.0.0.1:${port}:3000" control-plane >/dev/null

deadline=$(( SECONDS + HEALTH_TIMEOUT_S ))
until curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${port}/api/healthz" 2>/dev/null; do
  (( SECONDS < deadline )) || die "${CONTAINER} did not answer /api/healthz within ${HEALTH_TIMEOUT_S}s"
  sleep 2
done
echo "aud-isolation: ${CONTAINER} is up"

# --- The two requests, same token -------------------------------------------------------------------
# A request that gets no answer at all prints 000; `|| true` keeps it instead of aborting under -e.
anchor=$(status_of "$original" || true)
echo "original console (${original}): GET /api/admin/v1/flocks -> ${anchor} (expect 200)"
other=$(status_of "http://127.0.0.1:${port}" || true)
echo "second console (CONSOLE_URL=${OTHER_CONSOLE_URL}): GET /api/admin/v1/flocks -> ${other} (expect 401)"

if [[ $anchor == 200 && $other == 401 ]]; then
  echo "aud-isolation: PASS: a token for ${original}/api/admin is refused by a console expecting ${OTHER_CONSOLE_URL}/api/admin"
  exit 0
fi
echo "aud-isolation: FAIL" >&2
[[ $anchor == 200 ]] || echo "aud-isolation: the anchor is not 200, so the token proves nothing here; get a fresh one" >&2
exit 1
