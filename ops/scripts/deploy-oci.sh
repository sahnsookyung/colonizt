#!/usr/bin/env bash
set -euo pipefail

SERVER_IP="${1:?Usage: $0 <server-ip> <image-tag>}"
IMAGE_TAG="${2:?Usage: $0 <server-ip> <image-tag>}"
REMOTE_USER="${REMOTE_USER:-opc}"
REMOTE_ROOT="${COLONIZT_REMOTE_ROOT:-/srv/colonizt}"
JOBSCOUT_ROOT="${JOBSCOUT_REMOTE_ROOT:-/srv/jobscout-cloud}"
CADDY_SITES_DIR="${JOBSCOUT_ROOT}/ops/caddy/sites"
CADDY_IMPORT_LINE="import /etc/caddy/sites/*.Caddyfile"
GHCR_USER="${GHCR_USER:-sahnsookyung}"
GHCR_PAT="${COLONIZT_GHCR_SECRET:-${JOBSCOUT_IMAGE_GHCR_PAT:-${GHCR_PAT:-}}}"
SSH_KNOWN_HOSTS_FILE="${COLONIZT_SSH_KNOWN_HOSTS_FILE:-${HOME}/.ssh/known_hosts}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${COLONIZT_ENV_FILE:-$REPO_ROOT/.env}"
COMPOSE_FILE="$REPO_ROOT/deploy/compose/docker-compose.oci.yml"
CADDY_SITE_FILE="$REPO_ROOT/ops/caddy/colonizt.Caddyfile"
REMOTE_STAGING="/tmp/colonizt-deploy-${IMAGE_TAG}"
DEPLOY_STAMP="$(date +%Y%m%d%H%M%S)"
CADDY_ROOT_BACKUP="${JOBSCOUT_ROOT}/ops/caddy/Caddyfile.pre-colonizt.${DEPLOY_STAMP}"
CADDY_SITE_BACKUP="${CADDY_SITES_DIR}/colonizt.Caddyfile.pre-colonizt.${DEPLOY_STAMP}"
CADDY_SITE_EMPTY_MARKER="${CADDY_SITES_DIR}/colonizt.Caddyfile.pre-colonizt.${DEPLOY_STAMP}.empty"
CADDY_SITE_INSTALL="install -m 0644"
APP_ROLLBACK_ROOT="${REMOTE_ROOT}/deploy/rollback-${DEPLOY_STAMP}"
APP_ENV_BACKUP="${APP_ROLLBACK_ROOT}/colonizt.env"
APP_ENV_EMPTY_MARKER="${APP_ROLLBACK_ROOT}/colonizt.env.empty"
APP_COMPOSE_BACKUP="${APP_ROLLBACK_ROOT}/docker-compose.oci.yml"
APP_COMPOSE_EMPTY_MARKER="${APP_ROLLBACK_ROOT}/docker-compose.oci.yml.empty"
STAGING_CREATED=0
APP_CONFIG_TOUCHED=0
CADDY_CONFIG_TOUCHED=0

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${SSH_KNOWN_HOSTS_FILE}" "${REMOTE_USER}@${SERVER_IP}")
SCP=(scp -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${SSH_KNOWN_HOSTS_FILE}")

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

remote() {
  "${SSH[@]}" "$@"
}

restore_caddy_config() {
  echo "==> Restoring previous Caddy config/snippet" >&2
  remote "if [ -f ${CADDY_ROOT_BACKUP} ]; then sudo cp ${CADDY_ROOT_BACKUP} ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile; fi" || true
  remote "if [ -f ${CADDY_SITE_EMPTY_MARKER} ]; then sudo rm -f ${CADDY_SITES_DIR}/colonizt.Caddyfile ${CADDY_SITE_EMPTY_MARKER}; elif [ -f ${CADDY_SITE_BACKUP} ]; then sudo cp ${CADDY_SITE_BACKUP} ${CADDY_SITES_DIR}/colonizt.Caddyfile; fi" || true
  remote "sudo docker exec jobscout-cloud-caddy caddy reload --config /etc/caddy/Caddyfile" || true
}

restore_application_stack() {
  echo "==> Restoring previous Colonizt compose configuration and stack" >&2
  remote "if sudo test -f ${REMOTE_ROOT}/deploy/compose/.env && sudo test -f ${REMOTE_ROOT}/deploy/compose/docker-compose.oci.yml; then cd ${REMOTE_ROOT}/deploy/compose && sudo docker compose --env-file .env -f docker-compose.oci.yml down --remove-orphans; fi" || true
  remote "if sudo test -f ${APP_ENV_EMPTY_MARKER}; then sudo rm -f ${REMOTE_ROOT}/deploy/compose/.env; elif sudo test -f ${APP_ENV_BACKUP}; then sudo install -m 0600 ${APP_ENV_BACKUP} ${REMOTE_ROOT}/deploy/compose/.env; fi" || true
  remote "if sudo test -f ${APP_COMPOSE_EMPTY_MARKER}; then sudo rm -f ${REMOTE_ROOT}/deploy/compose/docker-compose.oci.yml; elif sudo test -f ${APP_COMPOSE_BACKUP}; then sudo install -m 0644 ${APP_COMPOSE_BACKUP} ${REMOTE_ROOT}/deploy/compose/docker-compose.oci.yml; fi" || true
  remote "if sudo test -f ${REMOTE_ROOT}/deploy/compose/.env && sudo test -f ${REMOTE_ROOT}/deploy/compose/docker-compose.oci.yml; then cd ${REMOTE_ROOT}/deploy/compose && sudo docker compose --env-file .env -f docker-compose.oci.yml config --quiet && sudo docker compose --env-file .env -f docker-compose.oci.yml up -d --remove-orphans; fi" || true
}

on_exit() {
  local status=$?
  trap - EXIT
  set +e
  if (( status != 0 )); then
    if (( APP_CONFIG_TOUCHED == 1 )); then
      restore_application_stack
    fi
    if (( CADDY_CONFIG_TOUCHED == 1 )); then
      restore_caddy_config
    fi
  fi
  if (( STAGING_CREATED == 1 )); then
    remote "rm -rf ${REMOTE_STAGING}" || true
  fi
  if (( status == 0 )); then
    remote "sudo rm -rf ${APP_ROLLBACK_ROOT}" || true
  fi
  exit "$status"
}

trap on_exit EXIT

verify_origin_endpoints_once() {
  curl -fsS --resolve "jobscout.sookyungahn.com:443:${SERVER_IP}" "https://jobscout.sookyungahn.com/" >/dev/null
  curl -kfsS --resolve "colonizt.sookyungahn.com:443:${SERVER_IP}" "https://colonizt.sookyungahn.com/health" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const json = JSON.parse(data); if (!json.ok || json.presence !== 'memory') process.exit(1); console.log(JSON.stringify({ origin: true, ...json })); });"
  curl -kfsS --resolve "colonizt.sookyungahn.com:443:${SERVER_IP}" "https://colonizt.sookyungahn.com/config" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const json = JSON.parse(data); if (json.apiBaseUrl !== 'https://colonizt.sookyungahn.com' || json.wsBaseUrl !== 'wss://colonizt.sookyungahn.com') process.exit(1); console.log(JSON.stringify({ origin: true, apiBaseUrl: json.apiBaseUrl, wsBaseUrl: json.wsBaseUrl })); });"
}

verify_origin_endpoints() {
  local attempt
  for attempt in {1..12}; do
    if verify_origin_endpoints_once; then
      return 0
    fi
    echo "Origin endpoint verification attempt ${attempt}/12 failed; retrying..." >&2
    sleep 5
  done
  return 1
}

if [[ "$IMAGE_TAG" == "latest" ]]; then
  fail "Refusing to deploy mutable latest; use the Git SHA image tag."
fi

if [[ ! "$IMAGE_TAG" =~ ^[0-9a-fA-F]{40}$ ]]; then
  fail "IMAGE_TAG must be the full 40-character immutable Git SHA image tag."
fi

[[ -f "$ENV_FILE" ]] || fail "$ENV_FILE not found"
[[ -f "$COMPOSE_FILE" ]] || fail "$COMPOSE_FILE not found"
[[ -f "$CADDY_SITE_FILE" ]] || fail "$CADDY_SITE_FILE not found"
[[ -s "$SSH_KNOWN_HOSTS_FILE" ]] || fail "$SSH_KNOWN_HOSTS_FILE is missing or empty; pin the production SSH host key before deploying"

echo "==> Preflight: JobScout public route before Colonizt deploy"
curl -fsS --resolve "jobscout.sookyungahn.com:443:${SERVER_IP}" "https://jobscout.sookyungahn.com/" >/dev/null

echo "==> Preflight: remote Docker and JobScout Caddy"
remote "command -v docker >/dev/null"
remote "sudo docker ps --format '{{.Names}}' | grep -qx jobscout-cloud-caddy"
remote "sudo test -f ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile"
remote "sudo docker exec jobscout-cloud-caddy test -d /etc/caddy/sites" || fail "JobScout Caddy is missing /etc/caddy/sites. Deploy the JobScout shared-sites mount first."
if remote "id jobscout >/dev/null 2>&1"; then
  CADDY_SITE_INSTALL="install -o jobscout -g jobscout -m 0644"
fi

echo "==> Preparing remote Colonizt directories"
remote "sudo mkdir -p ${REMOTE_ROOT}/deploy/compose ${REMOTE_ROOT}/ops/caddy ${REMOTE_ROOT}/data/postgres ${CADDY_SITES_DIR}"
remote "sudo rm -rf ${REMOTE_STAGING} && mkdir -p ${REMOTE_STAGING}"
STAGING_CREATED=1

echo "==> Capturing rollback configuration"
remote "sudo rm -rf ${APP_ROLLBACK_ROOT} && sudo mkdir -p ${APP_ROLLBACK_ROOT}"
remote "if sudo test -f ${REMOTE_ROOT}/deploy/compose/.env; then sudo cp ${REMOTE_ROOT}/deploy/compose/.env ${APP_ENV_BACKUP}; else sudo touch ${APP_ENV_EMPTY_MARKER}; fi"
remote "if sudo test -f ${REMOTE_ROOT}/deploy/compose/docker-compose.oci.yml; then sudo cp ${REMOTE_ROOT}/deploy/compose/docker-compose.oci.yml ${APP_COMPOSE_BACKUP}; else sudo touch ${APP_COMPOSE_EMPTY_MARKER}; fi"

echo "==> Syncing Colonizt compose and env"
"${SCP[@]}" "$ENV_FILE" "${REMOTE_USER}@${SERVER_IP}:${REMOTE_STAGING}/.env"
"${SCP[@]}" "$COMPOSE_FILE" "${REMOTE_USER}@${SERVER_IP}:${REMOTE_STAGING}/docker-compose.oci.yml"
"${SCP[@]}" "$CADDY_SITE_FILE" "${REMOTE_USER}@${SERVER_IP}:${REMOTE_STAGING}/colonizt.Caddyfile"
APP_CONFIG_TOUCHED=1
remote "sudo install -m 0600 ${REMOTE_STAGING}/.env ${REMOTE_ROOT}/deploy/compose/.env"
remote "sudo install -m 0644 ${REMOTE_STAGING}/docker-compose.oci.yml ${REMOTE_ROOT}/deploy/compose/docker-compose.oci.yml"
remote "sudo install -m 0644 ${REMOTE_STAGING}/colonizt.Caddyfile ${REMOTE_ROOT}/ops/caddy/colonizt.Caddyfile"
remote "if [ ! -f ${CADDY_SITES_DIR}/00-placeholder.Caddyfile ]; then printf '%s\n' '# Placeholder for colocated Caddy site snippets.' > ${REMOTE_STAGING}/00-placeholder.Caddyfile && sudo ${CADDY_SITE_INSTALL} ${REMOTE_STAGING}/00-placeholder.Caddyfile ${CADDY_SITES_DIR}/00-placeholder.Caddyfile; fi"
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
remote "cd ${REMOTE_ROOT}/deploy/compose && sudo docker compose --env-file .env -f docker-compose.oci.yml up -d postgres"
remote "cd ${REMOTE_ROOT}/deploy/compose && sudo docker compose --env-file .env -f docker-compose.oci.yml run --rm server npm --workspace @colonizt/db run migrate"
remote "cd ${REMOTE_ROOT}/deploy/compose && sudo docker compose --env-file .env -f docker-compose.oci.yml up -d --remove-orphans"

echo "==> Installing Colonizt Caddy site without changing JobScout routes"
remote "sudo cp ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile ${CADDY_ROOT_BACKUP}"
remote "if [ -f ${CADDY_SITES_DIR}/colonizt.Caddyfile ]; then sudo cp ${CADDY_SITES_DIR}/colonizt.Caddyfile ${CADDY_SITE_BACKUP}; else sudo touch ${CADDY_SITE_EMPTY_MARKER}; fi"
CADDY_CONFIG_TOUCHED=1
remote "sudo ${CADDY_SITE_INSTALL} ${REMOTE_STAGING}/colonizt.Caddyfile ${CADDY_SITES_DIR}/colonizt.Caddyfile"
remote "tmp=\$(mktemp); sudo awk 'BEGIN{skip=0} /# BEGIN COLONIZT SITE/{skip=1; next} /# END COLONIZT SITE/{skip=0; next} !skip{print}' ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile > \"\$tmp\" && sudo install -m 0644 \"\$tmp\" ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile; rm -f \"\$tmp\""
remote "if ! sudo grep -Fxq '${CADDY_IMPORT_LINE}' ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile; then printf '\n# Colocated apps own snippets under /etc/caddy/sites. Keep this import stable so\n# deploys do not rewrite app-owned routes or Caddy certificate storage.\n${CADDY_IMPORT_LINE}\n' | sudo tee -a ${JOBSCOUT_ROOT}/ops/caddy/Caddyfile >/dev/null; fi"
if ! remote "sudo docker exec jobscout-cloud-caddy caddy validate --config /etc/caddy/Caddyfile"; then
  fail "Caddy validation failed"
fi
if ! remote "sudo docker exec jobscout-cloud-caddy caddy reload --config /etc/caddy/Caddyfile"; then
  fail "Caddy reload failed"
fi

echo "==> Verifying origin endpoints"
if ! verify_origin_endpoints; then
  fail "Endpoint verification failed"
fi

remote "sudo rm -f ${CADDY_ROOT_BACKUP} ${CADDY_SITE_BACKUP} ${CADDY_SITE_EMPTY_MARKER}"
echo "Colonizt deployed successfully at https://colonizt.sookyungahn.com"
