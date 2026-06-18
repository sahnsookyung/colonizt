# Colonizt

Colonizt is an original browser-first multiplayer resource-route board-game prototype. It is built as a portfolio and interview-preparation project for real-time full-stack product development: deterministic game rules, server-authoritative WebSockets, React/TypeScript UI, replayable event logs, mobile usability, and clear testing gates.

This project does not copy Colonist/CATAN branding, art, proprietary UI, wording, or assets. Product research notes are kept outside the published repository.

## Quick Start

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run dev
```

The local web app runs on `http://127.0.0.1:5173` and the server runs on `http://127.0.0.1:8787`.
Redis is optional and only exercises the non-authoritative presence adapter when `REDIS_URL` is set.

## Useful Commands

```bash
npm run typecheck
npm run test:unit
npm run test:property
npm run replay:fixtures
npm run build
npm run verify:local
```

## Production-Style Run

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build postgres server web
```

See `docs/deployment.md` for environment variables, health checks, migrations, and restart recovery notes.

## Project Shape

- `packages/game-core`: pure deterministic engine, board model, commands/events, serializers, replay.
- `packages/server`: REST and WebSocket gateway, room state, sequencing, replay endpoints.
- `packages/web`: React client, board renderer, mobile layout, local and network play.
- `packages/db`: migrations and persistence helpers.
- `packages/test-utils`: bots, simulations, fixture helpers.
- `docs`: architecture, MVP rules, API, replay format, testing, and interview notes.
- Bot trade decisions and optional rule toggles are documented in `docs/bot-trade-and-rules.md`.

## What I Would Improve Next

- Move from the MVP no-op seven rule to a full robber/discard flow.
- Add ports and a map editor after the replay and reconnect gates are stable.
- Replace the local/admin ranked simulation with a public ranked queue only after moderation, mobile, and replay workflows are strong.
