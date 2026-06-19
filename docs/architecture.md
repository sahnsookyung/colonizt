# Architecture

Colonizt is a TypeScript npm workspace for a browser-first multiplayer board game. The main split is:

- `packages/game-core`: pure deterministic domain model.
- `packages/protocol`: shared REST/WebSocket schemas, protocol constants, and public payload types.
- `packages/server`: Fastify REST and WebSocket gateway plus authoritative room orchestration.
- `packages/web`: React/Vite client for local play, network play, and replay viewing.
- `packages/db`: PostgreSQL migrations and persistence helpers.
- `packages/bots`, `packages/demo-state`, and `packages/test-utils`: reusable automation, fixtures, and simulations.

## Runtime Topology

```mermaid
flowchart TB
  browser["Browser player or spectator"]
  web["packages/web<br/>React app<br/>local play, network play, replay UI"]
  network["network.ts<br/>runtime config, REST client, ticketed WebSocket client"]
  analytics["analytics.ts<br/>localStorage plus best-effort beacon"]

  server["packages/server<br/>Fastify app"]
  routes["REST routes<br/>/config, /sessions, /rooms, /matches, /leaderboard, /analytics"]
  ws["WebSocket route<br/>/ws?ticket=..."]
  schemas["schemas.ts<br/>Zod input validation"]
  protocol["packages/protocol<br/>wire schemas and protocol constants"]
  roomManager["RoomManager<br/>sessions, rooms, seats, timers, cleanup, idempotency"]
  scheduler["RoomAutomationScheduler<br/>turn expiry, bot ticks, cleanup lifecycle"]
  observability["observability.ts<br/>structured logs and Prometheus metrics"]
  presence["PresenceStore<br/>memory by default<br/>Redis when REDIS_URL is set"]
  eventStore["EventStore interface<br/>MemoryEventStore or PostgresEventStore"]

  gameCore["packages/game-core<br/>commands, events, reducers, replay, viewer serialization"]
  bots["packages/bots<br/>random, greedy, planner controllers"]
  demoState["packages/demo-state<br/>demo games and bot-game fixtures"]
  db["packages/db<br/>pg pool, migrations, SQL helpers"]
  postgres[("PostgreSQL<br/>sessions, rooms, matches, events, command results, chat, reports, analytics")]
  redis[("Redis optional<br/>ephemeral socket and room presence only")]

  browser --> web
  web --> network
  web --> analytics
  web --> gameCore
  web --> bots
  web --> demoState
  network --> protocol
  network -->|"GET /config<br/>REST: sessions, rooms, matches, replay<br/>POST /ws-tickets"| routes
  network -->|"WebSocket: JOIN_ROOM, READY, COMMAND, CHAT, RESYNC, PING"| ws
  analytics -->|"POST /analytics<br/>best effort"| routes

  server --> routes
  server --> ws
  routes --> schemas
  ws --> schemas
  schemas --> protocol
  routes --> observability
  ws --> observability
  routes --> roomManager
  ws --> roomManager
  ws --> presence
  scheduler --> roomManager
  scheduler --> observability

  roomManager --> gameCore
  roomManager --> bots
  roomManager --> eventStore
  eventStore --> db
  db --> postgres
  presence -. when configured .-> redis

  demoState --> gameCore
  demoState --> bots
  bots --> gameCore
```

## Package Dependencies

```mermaid
flowchart LR
  gameCore["@colonizt/game-core<br/>pure engine"]
  protocol["@colonizt/protocol<br/>wire contracts"]
  bots["@colonizt/bots"]
  demoState["@colonizt/demo-state"]
  testUtils["@colonizt/test-utils"]
  db["@colonizt/db"]
  server["@colonizt/server"]
  web["@colonizt/web"]
  scripts["scripts/*.ts<br/>smokes, simulations, replay fixtures, load tests"]
  tests["Vitest and Playwright tests"]

  protocol --> gameCore
  bots --> gameCore
  demoState --> gameCore
  demoState --> bots
  testUtils --> gameCore
  testUtils --> bots
  testUtils --> demoState
  server --> gameCore
  server --> protocol
  server --> bots
  server --> db
  web --> gameCore
  web --> protocol
  web --> bots
  web --> demoState
  scripts --> gameCore
  scripts --> testUtils
  scripts --> db
  scripts --> server
  tests --> gameCore
  tests --> testUtils
  tests --> server
  tests --> web
```

`game-core` is the domain dependency root. It imports only local pure modules and has no React, HTTP, WebSocket, database, filesystem, wall-clock, or ambient-randomness dependencies. `protocol` depends on `game-core` for public payload types and owns the shared wire schemas used by server validation and client network code.

## Authoritative Command Flow

```mermaid
sequenceDiagram
  participant Client as React client
  participant API as Fastify REST
  participant Socket as Fastify WebSocket
  participant Manager as RoomManager
  participant Scheduler as RoomAutomationScheduler
  participant Core as game-core
  participant Store as EventStore
  participant DB as PostgreSQL

  Client->>API: POST /sessions
  API->>Manager: createSession(displayName)
  Manager->>Store: persistSession
  Store->>DB: upsert hashed session token
  API-->>Client: session token and userId

  Client->>API: POST /rooms
  API->>Manager: createRoom(session, settings)
  Manager->>Store: persistRoom
  Store->>DB: upsert room and seats
  API-->>Client: room id, code, invite URL

  Client->>API: POST /ws-tickets
  API-->>Client: short-lived single-use ticket
  Client->>Socket: connect /ws?ticket=...
  Client->>Socket: JOIN_ROOM then READY
  Socket->>Manager: joinRoom / setReady
  Manager->>Core: createGame and create board when room can start
  Manager->>Store: persistMatchStart
  Store->>DB: insert match, players, room state
  Socket-->>Client: ROOM_STATE

  Client->>Socket: COMMAND with clientSeq
  Socket->>Manager: submitCommand
  Manager->>Manager: dedupe by room/user/clientSeq and command hash
  Manager->>Core: applyCommand(previousState, command)
  Core-->>Manager: accepted events and next state
  Manager->>Store: appendEvents and persistCommandResult
  Store->>DB: insert match_events and command result
  Manager->>Core: serializeEventsForViewer / serializeForViewer
  Socket-->>Client: viewer-safe EVENTS plus snapshot

  Scheduler->>Manager: expire turns, run due bots, cleanup rooms
  Scheduler-->>Socket: callbacks broadcast events or close abandoned rooms
```

Rejected commands are persisted with their `clientSeq` and command hash when the backing store supports command results. Replayed duplicate commands return `COMMAND_ACK`; conflicting reuse of the same sequence returns `CLIENT_SEQ_CONFLICT`.

## Replay And Recovery

```mermaid
flowchart TB
  command["Accepted game commands"]
  reducer["game-core applyCommand"]
  events["Ordered GameEvent log"]
  replay["game-core replay(log)"]
  viewer["serializeForViewer <br /> and serializeEventsForViewer"]
  ui["React replay UI"]
  hydrate["server startup hydrateFromStore"]
  activeRooms["active RoomManager rooms"]
  postgres[("PostgreSQL replay truth")]

  command --> reducer --> events --> postgres
  postgres -->|"loadReplay / loadReplayByRoomId"| replay --> viewer --> ui
  postgres -->|"loadSessions and loadRooms"| hydrate --> activeRooms
  events -->|"in-memory active room log"| activeRooms
```

PostgreSQL is durable match truth when `DATABASE_URL` is configured. The server runs migrations on startup, hydrates recent sessions and rooms, and reconstructs room game state from persisted config, board, and events. Snapshots and active room state are conveniences; ordered events remain the replay source of truth.

## Persistence Model

```mermaid
erDiagram
  USERS ||--o{ SESSIONS : owns
  USERS ||--o{ ROOM_SEATS : occupies
  ROOMS ||--o{ ROOM_SEATS : has
  ROOMS ||--o| MATCHES : starts
  MATCHES ||--o{ MATCH_PLAYERS : includes
  MATCHES ||--o{ MATCH_EVENTS : records
  MATCHES ||--o{ COMMAND_RESULTS : dedupes
  MATCHES ||--o{ CHAT_MESSAGES : contains
  MATCHES ||--o{ REPORTS : receives
  MATCHES ||--o{ ANALYTICS_EVENTS : annotates
```

The migrations in `packages/db/migrations` define the concrete schema. `PostgresEventStore` is the server adapter that translates room/session/match operations into the SQL helpers exported from `@colonizt/db`. `MemoryEventStore` implements the same interface for tests and no-database local runs.

## Deployment Shape

```mermaid
flowchart LR
  subgraph Build
    npm["npm workspace build<br/>tsc -b plus Vite build"]
    dockerServer["Dockerfile.server<br/>Node 22 runtime"]
    dockerWeb["Dockerfile.web<br/>Nginx static web runtime"]
  end

  subgraph Runtime
    webContainer["web container<br/>serves packages/web/dist"]
    serverContainer["server container<br/>Fastify on SERVER_PORT"]
    pg[("postgres:16<br/>DATABASE_URL")]
    optionalRedis[("redis:7 optional<br/>REDIS_URL")]
    caddy["Caddy site snippet<br/>ops/caddy/colonizt.Caddyfile"]
  end

  npm --> dockerServer --> serverContainer
  npm --> dockerWeb --> webContainer
  webContainer -->|"browser requests<br /> API and WS using<br /> /config<br /> VITE fallback only"| serverContainer
  serverContainer --> pg
  serverContainer -. optional presence adapter .-> optionalRedis
  caddy --> webContainer
  caddy --> serverContainer
```

Local production-style compose starts PostgreSQL, the Fastify server, and the static web build. Redis is optional and must not be treated as authoritative match history. `INSTANCE_MODE` must be `single`; horizontal scaling active rooms would need sticky sessions or room routing because active room authority currently lives inside one `RoomManager` instance.

## Boundary Notes

- The browser can run a complete local game because `packages/web` imports `game-core`, `bots`, and `demo-state`; network rooms still use the server as the authority.
- The server accepts player intent as commands and broadcasts only accepted, viewer-safe events and snapshots.
- `RoomManager` owns authoritative room state: seats, spectators, pause/resume, chat, reports, command idempotency, and persistence decisions.
- `RoomAutomationScheduler` owns recurring work: turn expiry, due bot actions, and room cleanup callbacks.
- `observability.ts` owns structured logs, metrics counters, and the enforced single-node instance-mode guard.
- `PresenceStore` tracks sockets and room membership only. The memory adapter is default; the Redis adapter is optional and ephemeral.
- `packages/db` knows PostgreSQL tables but does not know Fastify, WebSocket sockets, React, or game rules.
- `packages/test-utils` re-exports bots and demo state so tests and scripts can build deterministic scenarios without depending on the UI or server internals.
