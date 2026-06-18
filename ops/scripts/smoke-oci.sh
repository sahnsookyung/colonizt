#!/usr/bin/env bash
set -euo pipefail

PUBLIC_WEB_URL="${PUBLIC_WEB_URL:-https://colonizt.sookyungahn.com}"
PUBLIC_API_URL="${PUBLIC_API_URL:-https://colonizt.sookyungahn.com}"
PUBLIC_WS_URL="${PUBLIC_WS_URL:-wss://colonizt.sookyungahn.com}"
PUBLIC_WEB_ORIGIN="${PUBLIC_WEB_ORIGIN:-$PUBLIC_WEB_URL}"
export PUBLIC_WEB_URL PUBLIC_API_URL PUBLIC_WS_URL PUBLIC_WEB_ORIGIN

echo "==> Checking Colonizt health"
curl -fsS "${PUBLIC_API_URL%/}/health" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const json = JSON.parse(data); if (!json.ok || json.presence !== 'memory') process.exit(1); console.log(JSON.stringify(json)); });"

echo "==> Checking Colonizt public runtime config"
curl -fsS "${PUBLIC_API_URL%/}/config" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const json = JSON.parse(data); if (json.apiBaseUrl !== process.env.PUBLIC_API_URL?.replace(/\\/$/, '') || json.wsBaseUrl !== process.env.PUBLIC_WS_URL?.replace(/\\/$/, '')) process.exit(1); console.log(JSON.stringify({ apiBaseUrl: json.apiBaseUrl, wsBaseUrl: json.wsBaseUrl })); });"

echo "==> Running deployed API/WSS smoke"
PUBLIC_WEB_URL="$PUBLIC_WEB_URL" \
PUBLIC_API_URL="$PUBLIC_API_URL" \
PUBLIC_WS_URL="$PUBLIC_WS_URL" \
PUBLIC_WEB_ORIGIN="$PUBLIC_WEB_ORIGIN" \
npm run smoke:deployed-network
