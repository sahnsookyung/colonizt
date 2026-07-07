# Deployment

## Local Production Build

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build postgres server web
```

This starts PostgreSQL, the Fastify server on `http://127.0.0.1:8787`, and the static web build on `http://127.0.0.1:8080`. Redis remains optional for local presence experiments and is not part of the production path.

## Environment

- `DATABASE_URL`: PostgreSQL connection string for migrations, rooms, matches, and replay event logs.
- `REDIS_URL`: optional; when omitted the single-node server uses in-memory presence. Redis must never be treated as match truth.
- `INSTANCE_MODE`: must be `single`; the current server enforces one authoritative `RoomManager` per active room.
- `NODE_ID`: optional identifier included in health, config, logs, and metrics.
- `SERVER_HOST`: bind host, usually `0.0.0.0` in containers.
- `SERVER_PORT`: server port, default `8787`.
- `WEB_ORIGIN`: allowed browser origin for CORS.
- `ADMIN_TOKEN`: optional bearer or `x-admin-token` secret required for `/metrics` and `/leaderboard` when set.
- `VITE_API_BASE_URL`: optional legacy web build-time API fallback for local or custom builds. Leave unset for portable production images; browsers should discover the public API through `GET /config`.
- `MAX_ACTIVE_ROOMS`: cap for active in-memory rooms, default `200`.
- `ROOM_CLEANUP_INTERVAL_MS`: abandoned-room cleanup cadence, default `30000`.
- `EMPTY_LOBBY_TTL_MS`: empty lobby expiry window, default `600000`.
- `EMPTY_GAME_TTL_MS`: empty in-progress game abandonment window, default `1800000`.
- `FINISHED_ROOM_UNLOAD_MS`: finished-room memory unload window after everyone disconnects, default `300000`.
- `PRESENCE_STALE_MS`: socket heartbeat stale window before a player is marked disconnected, default `120000`.
- `PRESENCE_SWEEP_INTERVAL_MS`: stale-presence sweep cadence, default `30000`.

## Operations Notes

- Run migrations with `npm --workspace @colonizt/db run migrate`.
- `GET /health` is the server health check.
- `GET /config` is the canonical browser runtime configuration source. Reverse proxies should route it to the server so the same web image can move between environments.
- `GET /metrics` returns Prometheus-style operational metrics. Set `ADMIN_TOKEN` or expose it only through trusted monitoring or admin proxy rules.
- The server handles `SIGTERM` and `SIGINT` by closing Fastify, draining WebSockets through Fastify shutdown, and closing the PostgreSQL pool.
- On startup with `DATABASE_URL`, the server runs migrations and hydrates recent rooms from PostgreSQL event logs.
- Rooms have short share codes and invite URLs. Empty lobbies expire, empty in-progress games pause immediately and are abandoned after the configured TTL, and finished games unload from active memory while replay history stays in PostgreSQL.
- Sticky sessions or a room router are needed before horizontal scaling active rooms. The current supported mode is explicitly single-node authority; PostgreSQL remains replay truth, while Redis should only coordinate ephemeral presence.
- The web container serves static assets with security headers, long-lived immutable caching for hashed assets, and no-store HTML fallback. Caddy remains responsible for public TLS, compression, and routing `/config`, `/ws`, and API paths to the server. Scrape `/metrics` through an internal or admin-only monitoring path, not the public site route; when it is routed through the app, configure `ADMIN_TOKEN`.

## OCI Colocated Deploy

Colonizt can run beside JobScout on the existing OCI host without sharing app state. The deployment uses separate containers and data under `/srv/colonizt`; the only shared surface is the existing Caddy reverse proxy and its certificate storage.

## GitHub Actions Production Deploy

The preferred production path is GitHub Actions:

1. `CI` and `SonarCloud` must pass for the target commit.
2. `CD - Build & Push Images` builds and pushes `linux/arm64` images to GHCR with the full `github.sha` tag.
3. `Deploy Production` waits for those gates, verifies both SHA-tagged GHCR images exist, writes the production `.env` from a protected GitHub secret, runs `ops/scripts/deploy-oci.sh`, then runs deployed network and browser smokes.

The workflow runs automatically when the CD image-build workflow succeeds on the current `main` SHA. It can also be run manually from GitHub Actions with an optional full 40-character SHA for a deliberate rollback or redeploy. Production deploys use the GitHub `production` environment and the `colonizt-production` concurrency group, so only one promotion can run at a time.

GitHub-hosted runners verify the production hostname against the OCI origin during deploy and route deployed smoke traffic directly to that origin. This keeps CI/CD deterministic when the public edge blocks runner IPs; validate the public edge separately from a normal client network after the workflow succeeds.

Configure these GitHub environment secrets on `production`:

| Secret | Purpose |
| --- | --- |
| `COLONIZT_PRODUCTION_HOST` | OCI host or IP passed to `ops/scripts/deploy-oci.sh`. |
| `COLONIZT_PRODUCTION_USER` | SSH user, usually `opc`. |
| `COLONIZT_DEPLOY_KEY` | Private SSH key with access to the OCI host. |
| `COLONIZT_PRODUCTION_ENV_B64` | Base64-encoded production `.env` uploaded to the host for Docker Compose. |
| `COLONIZT_GHCR_SECRET` | Optional GHCR token for the runner and remote Docker host to pull private images. |
| `COLONIZT_GHCR_USER` | Optional GHCR username; defaults to `sahnsookyung`. |

Optional GitHub environment variables can override public smoke defaults: `COLONIZT_PUBLIC_WEB_URL`, `COLONIZT_PUBLIC_API_URL`, `COLONIZT_PUBLIC_WS_URL`, and `COLONIZT_PUBLIC_WEB_ORIGIN`.

The production `.env` secret can be prepared from the same file used by local deploy fallback:

```bash
base64 -w0 .env
```

Use the output as `COLONIZT_PRODUCTION_ENV_B64`. On macOS, use `base64 < .env | tr -d '\n'`.

## Manual Fallback

JobScout owns the root Caddyfile and Caddy data volumes. Its Caddyfile imports
`/etc/caddy/sites/*.Caddyfile`, and colocated apps install their own site
snippets there. Colonizt only writes `/srv/jobscout-cloud/ops/caddy/sites/colonizt.Caddyfile`;
it does not rewrite the JobScout site block or Caddy certificate data. Deploy the
JobScout shared-sites Caddy mount before running the Colonizt deploy script on a
fresh host.

```bash
./ops/scripts/deploy-oci.sh <jobscout-oci-ip> <full-40-character-git-sha-image-tag>
./ops/scripts/smoke-oci.sh
```

Production intentionally omits `REDIS_URL`; `/health` should report `presence: "memory"`.

If `colonizt.sookyungahn.com` is proxied through Cloudflare before Caddy has a
certificate, Let's Encrypt HTTP/TLS challenges can fail with Cloudflare 525. For
the first deploy, either set the DNS record to DNS-only until Caddy obtains the
certificate, or use a Cloudflare DNS-01/API-token based certificate flow. After
Caddy has a valid public certificate, the record can be proxied again.
