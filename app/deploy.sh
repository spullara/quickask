#!/usr/bin/env bash
# Deploy Quick to Cloudflare.
# Each key is read from the environment, then app/.env, then ~/.env.
# App secrets (ACCESS_KEY, SESSION_SECRET) are created once in app/.env.
# Usage: ./deploy.sh            deploy
#        ./deploy.sh destroy    remove everything
set -euo pipefail
cd "$(dirname "$0")"

get() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- | sed -E "s/^['\"]//; s/['\"]$//"; }
# key NAME [ALIAS...]: first value found for any name, in the environment, app/.env, then ~/.env.
key() { local n f v; for f in env .env ~/.env; do for n in "$@"; do
  if [ "$f" = env ]; then v="${!n:-}"; else v="$(get "$n" "$f")"; fi
  [ -n "$v" ] && { echo "$v"; return; }; done; done; }
need() { [ -n "${!1:-}" ] || { echo "Missing $1. Set it in the environment, app/.env or ~/.env." >&2; exit 1; }; }

touch .env
export GEMINI_API_KEY="$(key GEMINI_API_KEY)"
export EXA_API_KEY="$(key EXA_API_KEY)"
export CLOUDFLARE_API_TOKEN="$(key CLOUDFLARE_API_TOKEN CF_TOKEN)"
export CLOUDFLARE_ACCOUNT_ID="$(key CLOUDFLARE_ACCOUNT_ID)"
export QUICK_DOMAIN="$(key QUICK_DOMAIN)"
export ADMIN_NAME="$(key ADMIN_NAME)"
export WAITLIST="$(key WAITLIST)"
export DAILY_QUERIES="$(key DAILY_QUERIES)"
export MAIL_FORWARD_TO="$(key MAIL_FORWARD_TO)"
need GEMINI_API_KEY; need EXA_API_KEY; need CLOUDFLARE_API_TOKEN

# App secrets: created once, then reused so sessions and the access key survive redeploys.
grep -q '^ACCESS_KEY=' .env || echo "ACCESS_KEY=$(openssl rand -hex 16)" >> .env
grep -q '^SESSION_SECRET=' .env || echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
export ACCESS_KEY="$(get ACCESS_KEY .env)" SESSION_SECRET="$(get SESSION_SECRET .env)"

# Default to the token's first account; set CLOUDFLARE_ACCOUNT_ID when the token can see several.
if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
  CLOUDFLARE_ACCOUNT_ID="$(curl -fsS https://api.cloudflare.com/client/v4/accounts \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | bun -e 'console.log((await Bun.stdin.json()).result[0].id)')"
fi

# Waitlist emails are sent from the custom domain's zone (Cloudflare Email Service). Try the domain, then its parents.
# Set WAITLIST=off to use the access key and open sign-up instead.
if [ -n "$QUICK_DOMAIN" ] && [ "$WAITLIST" != off ] && [ -z "${QUICK_ZONE_ID:-}" ]; then
  d="$QUICK_DOMAIN"
  while [ -z "${QUICK_ZONE_ID:-}" ] && [[ "$d" == *.* ]]; do
    QUICK_ZONE_ID="$(curl -fsS "https://api.cloudflare.com/client/v4/zones?name=$d" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      | bun -e 'console.log((await Bun.stdin.json()).result[0]?.id ?? "")')"
    d="${d#*.}"
  done
  export QUICK_ZONE_ID
fi

bun install --frozen-lockfile >/dev/null
if [ "${1:-}" = destroy ]; then exec bunx alchemy destroy --yes; fi
log="$(mktemp)"
bunx alchemy deploy --yes | tee "$log"
url="${QUICK_DOMAIN:+https://$QUICK_DOMAIN}"
url="${url:-$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' "$log" | tail -1)}"
echo
echo "App:          $url"
echo "First visit:  $url/?k=$ACCESS_KEY"
echo "Search URL:   $url/?q=%s"
