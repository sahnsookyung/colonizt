# API

## REST

- `GET /health` returns service health and active presence adapter (`memory` or `redis`).
- `GET /metrics` returns Prometheus-style operational metrics for the active single-node server. When `ADMIN_TOKEN` is set, callers must send it as `Authorization: Bearer ...` or `x-admin-token`.
- `GET /config` returns browser runtime configuration, protocol version, WebSocket auth mode, node ID, and instance mode.
- `GET /rooms` lists discoverable public rooms. Rooms are private by default, so private invite codes are never returned by this endpoint.
- `POST /rooms` creates a private room.
- `GET /matches?limit=20` lists persisted match summaries.
- `GET /matches/:id` returns a persisted match summary by match ID or room ID.
- `GET /matches/:id/replay` returns full replay config and events by match ID or room ID for seated players with a valid session token.
- `GET /leaderboard` returns simulated/admin-only ranking data and uses the same optional `ADMIN_TOKEN` gate as metrics.
- `POST /sessions` creates a guest session token. Expired session rows and in-memory entries are reclaimed by the server's periodic transient-state sweep; guest-user rows are removed only when no room, match, moderation, rating, chat, command, analytics, or active-session history still references them.
- `POST /rooms/:roomId/reports` creates a moderation report only when the reporter belongs to the room and the reported identity occupies one of its seats.

Protocol schemas live in `@colonizt/protocol` and are shared by the server and web client. Existing REST and WebSocket JSON shapes remain backward compatible.

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

Joining a different room atomically removes lobby or spectator membership from the previous room and adds the destination membership. A seated player in an active game must remain attached to that game for reconnect safety and receives `ROOM_SWITCH_ACTIVE_GAME` instead of being moved; explicitly disconnecting first does not bypass that invariant. Authenticated room snapshots include at most the newest 100 chat messages; persisted chat uses the same retention window.

## Operations Metrics

`GET /metrics` is intended for operators and reverse-proxy-controlled access. It includes active rooms, connected sockets, command outcomes and latency, replay load outcomes, room cleanup counts with reasons, scheduler actions, WebSocket lifecycle events, and DB failure counters. Deployment config should expose it only to trusted monitoring paths or set `ADMIN_TOKEN`.
