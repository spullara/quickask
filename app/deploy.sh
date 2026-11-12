#!/usr/bin/env bash
# Deploy Quick to Cloudflare. Reads provider keys from ~/.env, keeps app secrets in app/.env.
# Usage: ./deploy.sh            deploy
#        ./deploy.sh destroy    remove everything
set -euo pipefail
cd "$(dirname "$0")"

get() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- | sed -E "s/^['\"]//; s/['\"]$//"; }
need() { [ -n "${!1:-}" ] || { echo "Missing $1 in $2" >&2; exit 1; }; }

export GEMINI_API_KEY="${GEMINI_API_KEY:-$(get GEMINI_API_KEY ~/.env)}"
export EXA_API_KEY="${EXA_API_KEY:-$(get EXA_API_KEY ~/.env)}"
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-$(get CF_TOKEN ~/.env)}"
need GEMINI_API_KEY ~/.env; need EXA_API_KEY ~/.env; need CLOUDFLARE_API_TOKEN "~/.env (CF_TOKEN)"

# App secrets: created once, then reused so sessions and the access key survive redeploys.
touch .env
grep -q '^ACCESS_KEY=' .env || echo "ACCESS_KEY=$(openssl rand -hex 16)" >> .env
grep -q '^SESSION_SECRET=' .env || echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
export ACCESS_KEY="$(get ACCESS_KEY .env)" SESSION_SECRET="$(get SESSION_SECRET .env)"

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID="$(curl -fsS https://api.cloudflare.com/client/v4/accounts \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | bun -e 'console.log((await Bun.stdin.json()).result[0].id)')"
  export CLOUDFLARE_ACCOUNT_ID
fi

bun install --frozen-lockfile >/dev/null
if [ "${1:-}" = destroy ]; then exec bunx alchemy destroy --yes; fi
bunx alchemy deploy --yes | tee "$TMPDIR/quick-deploy.log"
url="$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' "$TMPDIR/quick-deploy.log" | tail -1)"
echo
echo "App:          $url"
echo "First visit:  $url/?k=$ACCESS_KEY"
echo "Search URL:   $url/?q=%s"
