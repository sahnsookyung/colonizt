# Deployment

## Local Production Build

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

This starts PostgreSQL, Redis, the Fastify server on `http://127.0.0.1:8787`, and the static web build on `http://127.0.0.1:8080`.

## Environment

- `DATABASE_URL`: PostgreSQL connection string for migrations, rooms, matches, and replay event logs.
- `REDIS_URL`: enables ephemeral socket and room presence. Redis must never be treated as match truth.
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
