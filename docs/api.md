# API

## REST

- `GET /health` returns service health and active presence adapter (`memory` or `redis`).
- `GET /rooms` lists lobby rooms.
- `POST /rooms` creates a private room.
- `GET /matches?limit=20` lists persisted match summaries.
- `GET /matches/:id` returns a persisted match summary by match ID or room ID.
- `GET /matches/:id/replay` returns full replay config and events by match ID or room ID for seated players with a valid session token.
- `GET /leaderboard` returns simulated/admin-only ranking data.
- `POST /sessions` creates a guest session token.
- `POST /rooms/:roomId/reports` creates a moderation report for a seated user.

## WebSocket

Clients first call `POST /ws-tickets` with `x-session-token`, then connect to `/ws?ticket=...`.
Tickets are short-lived and single-use; long-lived `sessionToken` query auth is rejected by default.

Client messages:

- `JOIN_ROOM`
- `READY`
- `COMMAND`
- `CHAT`
- `RESYNC`
- `PING`

Server messages:

- `ROOM_STATE`
- `EVENTS`
- `COMMAND_REJECTED`
- `EVENTS` with viewer-safe event payloads and a viewer-safe snapshot
- `RESYNC` with either viewer-safe contiguous events or a viewer-safe snapshot fallback
- `CHAT`
- `PONG`
