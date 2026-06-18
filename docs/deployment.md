# Deployment

## Local Production Build

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build postgres server web
```

This starts PostgreSQL, the Fastify server on `http://127.0.0.1:8787`, and the static web build on `http://127.0.0.1:8080`. Redis remains optional for local presence experiments and is not part of the production path.

## Environment

- `DATABASE_URL`: PostgreSQL connection string for migrations, rooms, matches, and replay event logs.
- `REDIS_URL`: optional; when omitted the single-node server uses in-memory presence. Redis must never be treated as match truth.
- `SERVER_HOST`: bind host, usually `0.0.0.0` in containers.
- `SERVER_PORT`: server port, default `8787`.
- `WEB_ORIGIN`: allowed browser origin for CORS.
- `VITE_API_BASE_URL`: web build-time API URL, default `http://127.0.0.1:8787`.

## Operations Notes

- Run migrations with `npm --workspace @colonizt/db run migrate`.
- `GET /health` is the server health check.
- The server handles `SIGTERM` and `SIGINT` by closing Fastify, draining WebSockets through Fastify shutdown, and closing the PostgreSQL pool.
- On startup with `DATABASE_URL`, the server runs migrations and hydrates recent rooms from PostgreSQL event logs.
- Sticky sessions or a room router are needed before horizontal scaling active rooms; PostgreSQL remains replay truth, while Redis should only coordinate ephemeral presence, queues, and cross-node notifications.

## OCI Colocated Deploy

Colonizt can run beside JobScout on the existing OCI host without sharing app state. The deployment uses separate containers and data under `/srv/colonizt`; the only shared surface is the existing Caddy reverse proxy.

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
