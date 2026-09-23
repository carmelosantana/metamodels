#!/usr/bin/env bash
# Generate a paste-ready environment block for the MetaModels Portainer stack.
#
#   ./scripts/new-stack.sh                      # print the block
#   ./scripts/new-stack.sh --out .env.portainer # also write it to a file (mode 600)
#   ./scripts/new-stack.sh --domain api.example.com --tag 0.4.0 --email me@example.com
#
# Secrets are URL-safe hex on purpose: POSTGRES_PASSWORD is interpolated into DATABASE_URL,
# so a password containing :/@?# would produce a malformed connection string.
set -euo pipefail

DOMAIN='api.metamodels.cc'
TAG='0.4.0'
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

# 32 bytes of hex = 64 chars, comfortably above the >=16-char floor every secret enforces.
gen() { openssl rand -hex 32; }
# The token-signing key: RSA-2048 as a PKCS#8 PEM (genpkey's default), base64'd onto one line
# so it survives being a KEY=value environment variable.
genkey() { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | openssl base64 -A; }

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
CONSOLE_CLIENT_SECRET=$(gen)
OIDC_COOKIE_KEYS=$(gen)
OIDC_SIGNING_KEY=$(genkey)
# Empty until you rotate OIDC_SIGNING_KEY: the retired key, published for verification only.
OIDC_PREVIOUS_SIGNING_KEYS=
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
                      There is no password-change screen yet, and re-running
                      `pnpm seed` will not reset an existing user. To retire
                      it, invite a second admin from Team (they choose their
                      own password), then deactivate the seeded account.
  OIDC_SIGNING_KEY    signs every token the sign-in service issues. Rotate it
                      via OIDC_PREVIOUS_SIGNING_KEYS. Replaced outright, issued
                      tokens stop verifying within 10 minutes, or at once if
                      you restart the control plane after auth runs the new
                      key. It does not sign anyone out (see "Rotating the
                      sign-in keys" in docs/DEPLOY.md).
  OIDC_COOKIE_KEYS    signs the sign-in service's cookies. Rotate without
                      signing anyone out by prepending: <new>,<old>

Next: paste docker-compose.portainer.yml as the stack, add the block above as the
stack's environment variables, and deploy. The first operator is seeded
automatically. The console and the sign-in service are loopback-only by default,
so forward both ports, then open http://127.0.0.1:3200 (exactly — it is CONSOLE_URL):

  ssh -L 3200:127.0.0.1:3200 -L 3100:127.0.0.1:3100 <host>
--------------------------------------------------------------------------------
NOTE
