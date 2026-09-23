#!/usr/bin/env bash
# Tests aud-isolation.sh without docker: fake `docker` and `curl` executables go first on PATH, log
# their argv and environment, and return canned answers. Nothing here talks to a daemon or a network.
#
#   bash apps/e2e/scripts/aud-isolation.test.sh
#
# It checks that every `docker compose` call carries exactly `-p mm-m2-e2e` and no other project flag,
# whatever the caller passes; that a container in another project aborts the run before any request
# carries the token; that COMPOSE_PROJECT_NAME, in the caller's environment or in the env file,
# changes no argument; and that the token reaches curl on stdin only.
#
# `[[ … ]] && ok … || fail …` is safe here: ok() always returns 0, so fail runs only when the test does.
# shellcheck disable=SC2015
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
script="$here/aud-isolation.sh"
repo_compose=$(realpath -e -- "$(git -C "$here" rev-parse --show-toplevel)/docker-compose.yml")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

readonly TOKEN='eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl'
readonly PORT=38123

mkdir -p "$work/bin"
cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
{ printf 'docker'; printf ' %q' "$@"; printf '\n'; } >>"$FAKE_LOG/calls.log"
env >>"$FAKE_LOG/child-env.log"
case $1 in
  compose) echo 0123456789ab ;;
  inspect) [[ ${FAKE_INSPECT_FAIL:-0} == 1 ]] && { echo 'Error: No such object' >&2; exit 1; }
           printf '%s\n' "$FAKE_LABEL" ;;
esac
EOF
cat >"$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
{ printf 'curl'; printf ' %q' "$@"; printf '\n'; } >>"$FAKE_LOG/calls.log"
env >>"$FAKE_LOG/child-env.log"
url=${!#}
for a in "$@"; do [[ $a == '@-' ]] && cat >>"$FAKE_LOG/curl-stdin.log"; done
case $url in
  */api/healthz) exit 0 ;;
  */api/admin/v1/flocks)
    status=$(head -n1 "$FAKE_LOG/statuses"); tail -n +2 "$FAKE_LOG/statuses" >"$FAKE_LOG/statuses.next"; mv "$FAKE_LOG/statuses.next" "$FAKE_LOG/statuses"; printf '%s' "$status" ;;
  *) exit "${FAKE_PROBE_EXIT:-7}" ;;
esac
EOF
chmod +x "$work/bin/docker" "$work/bin/curl"

printf 'COMPOSE_PROJECT_NAME=metamodels\nDATABASE_URL=postgres://x@postgres/x\n' >"$work/e2e.env"
# A file whose name is a project flag: it must reach compose as part of one `--env-file=` argument.
mkdir -p "$work/cwd"
cp "$work/e2e.env" "$work/cwd/--project-name=metamodels"
# A compose file that is not the repo's, naming the live project.
printf 'name: metamodels\nservices: {}\n' >"$work/other-compose.yml"

failures=0
case_name=''
fail() { echo "  not ok: $*"; failures=$((failures + 1)); }
ok() { echo "  ok: $*"; }

# run_case <label> <statuses> [env assignments…] -- <script args…>; runs from $work/cwd.
run_case() {
  local label=$1 statuses=$2; shift 2
  local envs=()
  while [[ $1 != -- ]]; do envs+=("$1"); shift; done
  shift
  log="$work/log-$case_name"
  rm -rf "$log"; mkdir -p "$log"
  : >"$log/calls.log"; : >"$log/child-env.log"; : >"$log/curl-stdin.log"
  tr ' ' '\n' <<<"$statuses" >"$log/statuses"
  set +e
  (cd "$work/cwd" && env PATH="$work/bin:$PATH" FAKE_LOG="$log" FAKE_LABEL="$label" \
    AUD_ACCESS_TOKEN="$TOKEN" "${envs[@]}" bash "$script" "$@") >"$log/out" 2>&1
  code=$?
  set -e
}

docker_calls() { grep '^docker ' "$log/calls.log" || true; }
curl_calls() { grep '^curl ' "$log/calls.log" || true; }

# Every `docker compose` call: the global flags are exactly `-p mm-m2-e2e --file=… --env-file=…`,
# and no argument anywhere is a project flag other than that one `-p`.
check_compose_calls() {
  local expected_env=$1 n=0 line
  while IFS= read -r line; do
    local -a argv
    eval "argv=(${line#docker })"
    [[ ${argv[0]} == compose ]] || continue
    n=$((n + 1))
    local global=("${argv[@]:1:4}")
    local want=(-p mm-m2-e2e "--file=$repo_compose" "--env-file=$expected_env")
    [[ "${global[*]}" == "${want[*]}" && ${#global[@]} -eq 4 ]] \
      || fail "compose global flags are '${global[*]}', want '${want[*]}'"
    [[ ${argv[5]} == run ]] || fail "compose subcommand is '${argv[5]}', want run"
    local i p_count=0
    for ((i = 1; i < ${#argv[@]}; i++)); do
      case ${argv[i]} in
        --project-name*|-p?*) fail "project flag in compose argv: ${argv[i]}" ;;
        -p) p_count=$((p_count + 1))
            if ((i == 1)); then [[ ${argv[i + 1]} == mm-m2-e2e ]] || fail "-p ${argv[i + 1]}"
            else [[ ${argv[i + 1]} == "127.0.0.1:${PORT}:3000" ]] || fail "run -p ${argv[i + 1]} is not the publish mapping"; fi ;;
      esac
    done
    [[ $p_count -eq 2 ]] || fail "compose argv has $p_count -p flags, want 2 (project, then run's publish)"
  done < <(docker_calls)
  [[ $n -eq 1 ]] && ok "one compose call, project flags exactly '-p mm-m2-e2e'" || fail "$n compose calls, want 1"
}

check_no_token_leak() {
  if grep -qF "$TOKEN" "$log/calls.log" "$log/child-env.log"; then
    fail "the token is in a child's argv or environment"
  else
    ok "the token is in no child's argv or environment"
  fi
  grep -q '^COMPOSE_PROJECT_NAME=' "$log/child-env.log" \
    && fail "COMPOSE_PROJECT_NAME reached a child" || ok "COMPOSE_PROJECT_NAME reached no child"
}

expect_code() { [[ $code -eq $1 ]] && ok "exit $1" || { fail "exit $code, want $1"; sed 's/^/    | /' "$log/out"; }; }
expect_no_docker() { [[ -z $(docker_calls) ]] && ok "no docker call" || fail "docker was called: $(docker_calls)"; }

# ---------------------------------------------------------------------------------------------------
case_name=pass; echo "# PASS: 200 / 401 / 200, COMPOSE_PROJECT_NAME=metamodels in the caller's env and the env file"
run_case mm-m2-e2e '200 401 200' COMPOSE_PROJECT_NAME=metamodels aud_token=preexported -- \
  "$repo_compose" "$work/e2e.env" "$PORT" http://console.example.test/
expect_code 0
check_compose_calls "$work/e2e.env"
check_no_token_leak
want_docker=$(printf '%s\n' \
  "docker compose -p mm-m2-e2e --file=$(printf %q "$repo_compose") --env-file=$(printf %q "$work/e2e.env") run -d --rm --no-deps --name mm-m2-e2e-aud -e CONSOLE_URL=http://other.invalid -p 127.0.0.1:${PORT}:3000 control-plane" \
  "docker inspect -f \\{\\{index\\ .Config.Labels\\ \\\"com.docker.compose.project\\\"\\}\\} mm-m2-e2e-aud" \
  "docker rm -f mm-m2-e2e-aud")
[[ $(docker_calls) == "$want_docker" ]] && ok "docker calls: run, inspect, rm -f, in that order" \
  || fail "docker calls differ:"$'\n'"$(docker_calls)"
[[ $(grep -c -- ' -H @-' "$log/calls.log") -eq 3 ]] && ok "three token requests (anchor, second, anchor again)" || fail "token requests != 3"
[[ $(sort -u "$log/curl-stdin.log") == "Authorization: Bearer $TOKEN" ]] && ok "the token went to curl on stdin" || fail "curl stdin differs"

case_name=label; echo "# the container is in compose project 'metamodels'"
run_case metamodels '200 401 200' -- "$repo_compose" "$work/e2e.env" "$PORT" http://console.example.test
expect_code 2
check_compose_calls "$work/e2e.env"
[[ $(curl_calls | wc -l) -eq 1 && -z $(curl_calls | grep -F -- '-H' || true) ]] \
  && ok "only the port probe ran, with no header: $(curl_calls)" || fail "curl calls after the label check:"$'\n'"$(curl_calls)"
[[ ! -s $log/curl-stdin.log ]] && ok "no token was sent" || fail "a token was sent"
[[ $(docker_calls | tail -n1) == 'docker rm -f mm-m2-e2e-aud' ]] && ok "the EXIT trap removed the container" || fail "no rm -f"
grep -q "compose project 'metamodels'" "$log/out" && ok "says why" || fail "no reason printed"

case_name=inspect; echo "# docker inspect fails (no label)"
run_case '' '' FAKE_INSPECT_FAIL=1 -- "$repo_compose" "$work/e2e.env" "$PORT" http://console.example.test
expect_code 2
[[ ! -s $log/curl-stdin.log && $(curl_calls | wc -l) -eq 1 ]] && ok "no request after the probe" || fail "requests were made"

case_name=flagfile; echo "# an env file named '--project-name=metamodels', passed relative"
run_case mm-m2-e2e '200 401 200' -- "$repo_compose" '--project-name=metamodels' "$PORT" http://console.example.test
expect_code 0
check_compose_calls "$work/cwd/--project-name=metamodels"

case_name=othercompose; echo "# a compose file that is not the repo's (top-level name: metamodels)"
run_case mm-m2-e2e '' -- "$work/other-compose.yml" "$work/e2e.env" "$PORT" http://console.example.test
expect_code 2
expect_no_docker
[[ -z $(curl_calls) ]] && ok "no curl call" || fail "curl was called"

case_name=symlink; echo "# a symlink to the repo's compose file is the same file"
ln -sf "$repo_compose" "$work/link.yml"
run_case mm-m2-e2e '200 401 200' -- "$work/link.yml" "$work/e2e.env" "$PORT" http://console.example.test
expect_code 0
check_compose_calls "$work/e2e.env"

case_name=wrapper; echo "# the old interface (a wrapper and three arguments) is refused"
printf '#!/bin/sh\nexec docker compose "$@"\n' >"$work/wrapper.sh"; chmod +x "$work/wrapper.sh"
run_case mm-m2-e2e '' -- "$work/wrapper.sh" "$PORT" http://console.example.test
expect_code 2
expect_no_docker

case_name=port; echo "# something already answers on the port"
run_case mm-m2-e2e '' FAKE_PROBE_EXIT=0 -- "$repo_compose" "$work/e2e.env" "$PORT" http://console.example.test
expect_code 2
expect_no_docker

case_name=expired; echo "# the anchor is 401 after the second request (token expired in between)"
run_case mm-m2-e2e '200 401 401' -- "$repo_compose" "$work/e2e.env" "$PORT" http://console.example.test
expect_code 1
grep -q 'not 200 both times' "$log/out" && ok "says the anchor failed" || fail "no anchor message"

case_name=accepted; echo "# the second console accepts the token"
run_case mm-m2-e2e '200 200 200' -- "$repo_compose" "$work/e2e.env" "$PORT" http://console.example.test
expect_code 1

echo
if ((failures)); then echo "aud-isolation.test: $failures failure(s)"; exit 1; fi
echo "aud-isolation.test: all passed"
