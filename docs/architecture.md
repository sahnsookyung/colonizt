# Architecture

Colonizt is split into pure domain logic, transport adapters, persistence, and UI.

```text
React Web Client
  | REST: rooms, history, replay
  | WebSocket: commands, events, chat, resync
  v
Node Server
  Auth/session, room membership, rate limits, sequencing
  v
Game Core
  Pure deterministic reducer, validation, legal actions, replay
  v
PostgreSQL event log and snapshots
```

## Boundaries

- `packages/game-core` imports no React, WebSocket, database, HTTP, filesystem, time, or ambient randomness code.
- The server receives player intent as commands and broadcasts only accepted events.
- Clients render viewer-safe snapshots and derive UI affordances from state.
- PostgreSQL stores durable match truth and can hydrate recent rooms after a server restart.
- Redis is used only for ephemeral socket/room presence when `REDIS_URL` is configured; it is deliberately not used for authoritative match history.
