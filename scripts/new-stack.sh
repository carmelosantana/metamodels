#!/usr/bin/env bash
# Generate a paste-ready environment block for the MetaModels Portainer stack.
#
#   ./scripts/new-stack.sh                      # print the block
#   ./scripts/new-stack.sh --out .env.portainer # also write it to a file (mode 600)
#   ./scripts/new-stack.sh --domain api.example.com --tag 0.3.0 --email me@example.com
#
# Secrets are URL-safe hex on purpose: POSTGRES_PASSWORD is interpolated into DATABASE_URL,
# so a password containing :/@?# would produce a malformed connection string.
set -euo pipefail

DOMAIN='api.metamodels.cc'
TAG='0.3.0'
EMAIL='admin@metamodels.cc'
OUT=''

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
    --tag)    TAG="${2:?--tag needs a value}";       shift 2 ;;
    --email)  EMAIL="${2:?--email needs a value}";   shift 2 ;;
    --out)    OUT="${2:?--out needs a path}";        shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

# 32 bytes of hex = 64 chars, comfortably above the >=16-char floor both secrets enforce.
gen() { openssl rand -hex 32; }

BLOCK=$(cat <<EOF
# MetaModels stack — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Paste into Portainer › Stacks › Environment variables. Keep this out of git.
TAG=${TAG}
API_DOMAIN=${DOMAIN}
OPERATOR_EMAIL=${EMAIL}
POSTGRES_PASSWORD=$(gen)
SESSION_SECRET=$(gen)
LICENSE_KEY_SECRET=$(gen)
OPERATOR_PASSWORD=$(gen)
EOF
)

if [ -n "$OUT" ]; then
  if [ -e "$OUT" ]; then
    echo "refusing to overwrite existing file: $OUT" >&2
    echo "(rotating secrets in place would orphan the encrypted license key — see below)" >&2
    exit 1
  fi
  ( umask 077; printf '%s\n' "$BLOCK" > "$OUT" )
  echo "wrote $OUT (mode $(stat -c '%a' "$OUT"))"
  echo
fi

printf '%s\n' "$BLOCK"

cat <<'NOTE'

--------------------------------------------------------------------------------
Store these now — they are not recoverable from the running stack.

  LICENSE_KEY_SECRET  encrypts the stored Lemon Squeezy license key at rest.
                      Losing or changing it makes an existing entitlement
                      undecryptable and you must re-activate the license.
  OPERATOR_PASSWORD   only used by `pnpm seed` to create the first admin.
                      Change it in the console after first login.

Next: paste docker-compose.portainer.yml as the stack, add the block above as the
stack's environment variables, deploy, then seed the first operator once:

  docker exec -it <control-plane-container> pnpm seed
--------------------------------------------------------------------------------
NOTE
