#!/usr/bin/env bash
set -euo pipefail

SERVER_IP="${1:?Usage: $0 <server-ip> <image-tag>}"
IMAGE_TAG="${2:?Usage: $0 <server-ip> <image-tag>}"
REMOTE_USER="${REMOTE_USER:-opc}"
REMOTE_ROOT="${COLONIZT_REMOTE_ROOT:-/srv/colonizt}"
JOBSCOUT_ROOT="${JOBSCOUT_REMOTE_ROOT:-/srv/jobscout-cloud}"
GHCR_USER="${GHCR_USER:-sahnsookyung}"
GHCR_PAT="${COLONIZT_GHCR_SECRET:-${JOBSCOUT_IMAGE_GHCR_PAT:-${GHCR_PAT:-}}}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${COLONIZT_ENV_FILE:-$REPO_ROOT/.env}"
COMPOSE_FILE="$REPO_ROOT/deploy/compose/docker-compose.oci.yml"
CADDY_SITE_FILE="$REPO_ROOT/ops/caddy/colonizt.Caddyfile"
REMOTE_STAGING="/tmp/colonizt-deploy-${IMAGE_TAG}"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "${REMOTE_USER}@${SERVER_IP}")
SCP=(scp -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

remote() {
  "${SSH[@]}" "$@"
}

if [[ "$IMAGE_TAG" == "latest" ]]; then
  fail "Refusing to deploy mutable latest; use the Git SHA image tag."
fi

if [[ ! "$IMAGE_TAG" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  fail "IMAGE_TAG must look like an immutable Git SHA."
fi

[[ -f "$ENV_FILE" ]] || fail "$ENV_FILE not found"
[[ -f "$COMPOSE_FILE" ]] || fail "$COMPOSE_FILE not found"
[[ -f "$CADDY_SITE_FILE" ]] || fail "$CADDY_SITE_FILE not found"

echo "==> Preflight: JobScout public route before Colonizt deploy"
curl -fsS --resolve "jobscout.sookyungahn.com:443:${SERVER_IP}" "https://jobscout.sookyungahn.com/" >/dev/null

echo "==> Preflight: remote Docker and JobScout Caddy"
remote "command -v docker >/dev/null"
remote "sudo docker ps --format '{{.Names}}' | grep -qx jobscout-cloud-caddy"
remote "sudo test -f ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile"

echo "==> Preparing remote Colonizt directories"
remote "sudo mkdir -p ${REMOTE_ROOT}/deploy/compose ${REMOTE_ROOT}/ops/caddy ${REMOTE_ROOT}/data/postgres"
remote "sudo rm -rf ${REMOTE_STAGING} && mkdir -p ${REMOTE_STAGING}"

echo "==> Syncing Colonizt compose and env"
"${SCP[@]}" "$ENV_FILE" "${REMOTE_USER}@${SERVER_IP}:${REMOTE_STAGING}/.env"
"${SCP[@]}" "$COMPOSE_FILE" "${REMOTE_USER}@${SERVER_IP}:${REMOTE_STAGING}/docker-compose.oci.yml"
"${SCP[@]}" "$CADDY_SITE_FILE" "${REMOTE_USER}@${SERVER_IP}:${REMOTE_STAGING}/colonizt.Caddyfile"
remote "sudo install -m 0600 ${REMOTE_STAGING}/.env ${REMOTE_ROOT}/deploy/compose/.env"
remote "sudo install -m 0644 ${REMOTE_STAGING}/docker-compose.oci.yml ${REMOTE_ROOT}/deploy/compose/docker-compose.oci.yml"
remote "sudo install -m 0644 ${REMOTE_STAGING}/colonizt.Caddyfile ${REMOTE_ROOT}/ops/caddy/colonizt.Caddyfile"
remote "sudo grep -q '^IMAGE_TAG=' ${REMOTE_ROOT}/deploy/compose/.env && sudo sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=${IMAGE_TAG}/' ${REMOTE_ROOT}/deploy/compose/.env || echo IMAGE_TAG=${IMAGE_TAG} | sudo tee -a ${REMOTE_ROOT}/deploy/compose/.env >/dev/null"
remote "sudo grep -q '^COMPOSE_PROJECT_NAME=' ${REMOTE_ROOT}/deploy/compose/.env || echo COMPOSE_PROJECT_NAME=colonizt | sudo tee -a ${REMOTE_ROOT}/deploy/compose/.env >/dev/null"
remote "sudo grep -q '^COLONIZT_DATA_ROOT=' ${REMOTE_ROOT}/deploy/compose/.env || echo COLONIZT_DATA_ROOT=${REMOTE_ROOT}/data | sudo tee -a ${REMOTE_ROOT}/deploy/compose/.env >/dev/null"

if [[ -n "$GHCR_PAT" ]]; then
  echo "==> Refreshing remote GHCR credentials"
  printf '%s' "$GHCR_PAT" | "${SSH[@]}" "sudo docker login ghcr.io -u '${GHCR_USER}' --password-stdin >/dev/null"
else
  echo "==> No GHCR token provided locally; using existing remote Docker credentials"
fi

echo "==> Starting Colonizt stack"
remote "cd ${REMOTE_ROOT}/deploy/compose && sudo docker compose --env-file .env -f docker-compose.oci.yml config --quiet"
remote "cd ${REMOTE_ROOT}/deploy/compose && sudo docker compose --env-file .env -f docker-compose.oci.yml pull"
remote "cd ${REMOTE_ROOT}/deploy/compose && sudo docker compose --env-file .env -f docker-compose.oci.yml up -d --remove-orphans"

echo "==> Installing Colonizt Caddy site without changing JobScout services"
remote "sudo cp ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile.pre-colonizt.\$(date +%Y%m%d%H%M%S)"
remote "sudo awk 'BEGIN{skip=0} /# BEGIN COLONIZT SITE/{skip=1; next} /# END COLONIZT SITE/{skip=0; next} !skip{print}' ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile > /tmp/Caddyfile.no-colonizt"
remote "cat /tmp/Caddyfile.no-colonizt ${REMOTE_ROOT}/ops/caddy/colonizt.Caddyfile | sudo tee ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile >/dev/null"
if ! remote "sudo docker exec jobscout-cloud-caddy caddy validate --config /etc/caddy/Caddyfile"; then
  echo "==> Caddy validation failed; restoring previous Caddyfile" >&2
  remote "sudo cp \$(ls -1t ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile.pre-colonizt.* | head -n1) ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile"
  fail "Caddy validation failed"
fi
remote "sudo docker exec jobscout-cloud-caddy caddy reload --config /etc/caddy/Caddyfile"

echo "==> Verifying public endpoints"
curl -fsS --resolve "jobscout.sookyungahn.com:443:${SERVER_IP}" "https://jobscout.sookyungahn.com/" >/dev/null
curl -kfsS --resolve "colonizt.sookyungahn.com:443:${SERVER_IP}" "https://colonizt.sookyungahn.com/health" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const json = JSON.parse(data); if (!json.ok || json.presence !== 'memory') process.exit(1); console.log(JSON.stringify({ origin: true, ...json })); });"
curl -kfsS --resolve "colonizt.sookyungahn.com:443:${SERVER_IP}" "https://colonizt.sookyungahn.com/config" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const json = JSON.parse(data); if (json.apiBaseUrl !== 'https://colonizt.sookyungahn.com' || json.wsBaseUrl !== 'wss://colonizt.sookyungahn.com') process.exit(1); console.log(JSON.stringify({ origin: true, apiBaseUrl: json.apiBaseUrl, wsBaseUrl: json.wsBaseUrl })); });"
curl -fsS "https://colonizt.sookyungahn.com/health" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const json = JSON.parse(data); if (!json.ok || json.presence !== 'memory') process.exit(1); console.log(JSON.stringify({ public: true, ...json })); });"
curl -fsS "https://colonizt.sookyungahn.com/config" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const json = JSON.parse(data); if (json.apiBaseUrl !== 'https://colonizt.sookyungahn.com' || json.wsBaseUrl !== 'wss://colonizt.sookyungahn.com') process.exit(1); console.log(JSON.stringify({ public: true, apiBaseUrl: json.apiBaseUrl, wsBaseUrl: json.wsBaseUrl })); });"

remote "rm -rf ${REMOTE_STAGING}"
echo "Colonizt deployed successfully at https://colonizt.sookyungahn.com"
