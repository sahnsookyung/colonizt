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

JobScout owns the root Caddyfile and Caddy data volumes. Its Caddyfile imports
`/etc/caddy/sites/*.Caddyfile`, and colocated apps install their own site
snippets there. Colonizt only writes `/srv/jobscout-cloud/ops/caddy/sites/colonizt.Caddyfile`;
it does not rewrite the JobScout site block or Caddy certificate data. Deploy the
JobScout shared-sites Caddy mount before running the Colonizt deploy script on a
fresh host.

```bash
./ops/scripts/deploy-oci.sh <jobscout-oci-ip> <git-sha-image-tag>
./ops/scripts/smoke-oci.sh
```

Production intentionally omits `REDIS_URL`; `/health` should report `presence: "memory"`.

If `colonizt.sookyungahn.com` is proxied through Cloudflare before Caddy has a
certificate, Let's Encrypt HTTP/TLS challenges can fail with Cloudflare 525. For
the first deploy, either set the DNS record to DNS-only until Caddy obtains the
certificate, or use a Cloudflare DNS-01/API-token based certificate flow. After
Caddy has a valid public certificate, the record can be proxied again.
