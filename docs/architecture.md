# Architecture

Colonizt is a TypeScript npm workspace for a browser-first multiplayer board game. The current architecture keeps the deterministic game rules independent from UI, transport, persistence, and bot scheduling, while the server owns online room authority.

The main packages are:

- `packages/game-core`: pure deterministic domain model, board/map generation, commands, events, reducers, replay, resource bank rules, and viewer-safe serialization.
- `packages/protocol`: shared REST/WebSocket Zod schemas, protocol constants, public payload types, and lobby readiness helpers used by both server and web.
- `packages/server`: Fastify REST and WebSocket gateway, authoritative room orchestration, lobby state, command idempotency, automation, presence, observability, and persistence adapters.
- `packages/web`: React/Vite client for local bot play, online lobby/gameplay, replay-after-game-over viewing, mobile UI, sounds, and local automation.
- `packages/db`: PostgreSQL migrations and SQL helpers for sessions, rooms, leases, matches, events, command results, chat, reports, analytics, and leaderboard data.
- `packages/bots`, `packages/demo-state`, and `packages/test-utils`: bot controllers, local/demo fixtures, deterministic scenario runners, and test helpers.

## Runtime Topology

```mermaid
flowchart LR
  browser["Browser"]

  subgraph client["packages/web"]
    web["React client"]
    localBots["Local bots"]
  end

  subgraph shared["shared packages"]
    protocol["protocol"]
    core["game-core"]
    bots["bots"]
    demo["demo-state"]
  end

  subgraph online["packages/server"]
    server["Fastify API"]
    rooms["RoomManager"]
    automation["Automation"]
  end

  subgraph data["state stores"]
    postgres[("PostgreSQL")]
    redis[("Redis presence")]
  end

  browser --> web
  web --> protocol
  web --> core
  web --> demo
  web --> localBots
  localBots --> bots
  bots --> core

  web -->|"REST + WS"| server
  server --> protocol
  server --> rooms
  rooms --> core
  rooms --> bots
  automation --> rooms

  rooms --> postgres
  server -. optional .-> redis
```

This top-level diagram is intentionally coarse. The detailed module relationships are split below so generated Mermaid images stay readable instead of routing every edge through one dense canvas.

## Web Client Detail

```mermaid
flowchart TB
  app["App controller"]

  subgraph ui["UI components"]
    lobbyScreen["Lobby screen"]
    boardUi["Board HUD and overlays"]
    actionDock["Action dock"]
    handRack["HandRack"]
    playerStats["PlayerStatsList"]
    sidebar["Sidebar info panels"]
    postGame["PostGame overlay"]
    options["Match options"]
  end

  subgraph network["online client"]
    client["REST client"]
    socket["WebSocket hook"]
    resume["Resume state"]
  end

  subgraph local["local play"]
    localAutomation["Local automation"]
    replayUi["Replay projection"]
    viewerProjection["viewer-projection.ts"]
  end

  subgraph sharedClient["shared domain"]
    protocol["protocol schemas"]
    core["game-core"]
    bots["bots"]
    demo["demo-state"]
  end

  app --> lobbyScreen
  app --> boardUi
  app --> actionDock
  app --> handRack
  app --> playerStats
  app --> sidebar
  app --> postGame
  app --> options
  app --> client
  app --> socket
  app --> localAutomation
  app --> replayUi
  app --> viewerProjection

  client --> protocol
  socket --> protocol
  lobbyScreen --> protocol
  boardUi --> core
  actionDock --> core
  handRack --> core
  playerStats --> core
  sidebar --> core
  postGame --> core
  replayUi --> core
  viewerProjection --> core
  localAutomation --> bots
  localAutomation --> core
  demo --> core
  demo --> bots
```

The web package owns screen state, local bot games, online lobby/gameplay, trade and special-card overlays, mobile HUD layout, post-game replay viewing, sounds, and analytics. It uses `protocol` for wire contracts and `game-core` for deterministic local projections; online rooms still treat the server as authoritative. `viewer-projection.ts` is the only client boundary that converts a viewer-safe online payload into game-shaped UI state, so redacted opponent cards stay redacted even when incremental events arrive.

## Server Runtime Detail

```mermaid
flowchart TB
  subgraph ingress["ingress"]
    rest["REST routes"]
    ws["WebSocket route"]
    tickets["WS tickets"]
  end

  subgraph authority["room authority"]
    manager["RoomManager"]
    lobby["lobby helpers"]
    runtime["room-runtime helpers"]
    scheduler["Scheduler"]
    due["DueWorkIndex"]
    security["idempotency"]
  end

  subgraph domainServer["domain"]
    core["game-core"]
    bots["bots"]
    protocol["protocol"]
  end

  subgraph stores["stores"]
    events["EventStore"]
    storeValidation["store validation"]
    presence["PresenceStore"]
    leases["RoomOwnership"]
    metrics["observability"]
  end

  postgres[("PostgreSQL")]
  redis[("Redis")]

  rest --> tickets
  rest --> manager
  ws --> manager
  ws --> presence
  rest --> protocol
  ws --> protocol

  manager --> lobby
  manager --> runtime
  manager --> security
  manager --> core
  manager --> bots
  manager --> events
  events --> storeValidation
  manager --> leases
  scheduler --> manager
  scheduler --> due
  scheduler --> metrics

  events --> postgres
  leases --> postgres
  presence -. optional .-> redis
```

`RoomManager` owns online room authority: seats, host actions, spectators, chat, reports, accepted commands, timers, persistence, and viewer-safe broadcasts. Shared room lifecycle/counting/timer derivation lives in `room-runtime.ts` so scheduler, metrics, and admin room-health reports use the same semantics. `RoomAutomationScheduler` drives due bot actions, trade deadlines, turn expiry, and cleanup callbacks without scanning every room blindly.

## Package Dependencies

```mermaid
flowchart TB
  subgraph domain["domain layer"]
    core["@colonizt/game-core"]
    protocol["@colonizt/protocol"]
    bots["@colonizt/bots"]
    demo["@colonizt/demo-state"]
  end

  subgraph runtime["runtime layer"]
    server["@colonizt/server"]
    web["@colonizt/web"]
    db["@colonizt/db"]
  end

  subgraph validation["validation layer"]
    tests["Vitest and Playwright"]
    scripts["smokes and simulations"]
    testUtils["@colonizt/test-utils"]
  end

  protocol --> core
  bots --> core
  demo --> core
  demo --> bots

  server --> protocol
  server --> core
  server --> bots
  server --> db

  web --> protocol
  web --> core
  web --> bots
  web --> demo

  testUtils --> core
  testUtils --> bots
  tests --> testUtils
  tests --> server
  tests --> web
  scripts --> testUtils
  scripts --> server
  scripts --> db
```

`game-core` is the domain dependency root. It imports only local pure modules and has no React, HTTP, WebSocket, database, filesystem, wall-clock, or ambient-randomness dependencies. `protocol` depends on `game-core` for public payload types and owns shared schemas plus lobby readiness logic. `server` and `web` both depend on `protocol`, which keeps room settings, `mapPreset`, lobby messages, and public payload shapes aligned.

## Online Lobby Lifecycle

```mermaid
sequenceDiagram
  participant Host as Host browser
  participant Guest as Guest browser
  participant API as Fastify REST
  participant WS as WebSocket gateway
  participant Manager as RoomManager
  participant Lobby as lobby helpers
  participant Store as EventStore

  Host->>API: POST /sessions
  Host->>API: POST /rooms<br/>minPlayers, maxPlayers, rules, botFill false
  API->>Manager: createRoom
  Manager->>Store: persistRoom with short room code
  API-->>Host: PublicRoomPayload and invite URL

  Host->>API: POST /ws-tickets
  Host->>WS: connect /ws?ticket=...
  Host->>WS: JOIN_ROOM by public code
  WS->>Manager: joinRoom
  WS-->>Host: ROOM_STATE lobby with seats, settings, code

  Guest->>API: POST /sessions
  Guest->>API: POST /ws-tickets
  Guest->>WS: JOIN_ROOM by public code
  WS->>Manager: joinRoom
  WS-->>Host: ROOM_STATE guest seated
  WS-->>Guest: ROOM_STATE guest seated

  Host->>WS: UPDATE_DISPLAY_NAME or UPDATE_ROOM_SETTINGS
  WS->>Manager: update display name or settings
  Manager->>Lobby: validate seat counts, map rules, readiness resets
  Manager->>Store: persistRoom
  WS-->>Host: ROOM_STATE
  WS-->>Guest: ROOM_STATE

  Host->>WS: ADD_BOT or REMOVE_BOT
  WS->>Manager: add/remove host-controlled lobby bot
  Manager->>Lobby: bots are connected ready seats
  Manager->>Store: persistRoom
  WS-->>Host: ROOM_STATE
  WS-->>Guest: ROOM_STATE

  Host->>WS: READY
  Guest->>WS: READY
  Host->>WS: START_ROOM Go
  WS->>Manager: startRoomByHost
  Manager->>Lobby: canStartLobby with connected ready humans and bots
  Manager->>Manager: startable seats only
  Manager->>Store: persistMatchStart
  WS-->>Host: ROOM_STATE with viewer-safe game
  WS-->>Guest: ROOM_STATE with viewer-safe game
```

Online rooms are still bounded to 2-4 public seats. The host can start from two connected ready players without filling every open seat, or can add lobby bots before starting. Bots added in the lobby are server-side automation seats and are not exposed as a separate public room-creation mode.

## Authoritative Command Flow

```mermaid
sequenceDiagram
  participant Client as React client
  participant API as Fastify REST
  participant Socket as Fastify WebSocket
  participant Presence as PresenceStore
  participant Manager as RoomManager
  participant Core as game-core
  participant Store as EventStore
  participant Scheduler as RoomAutomationScheduler
  participant Bots as bot controllers
  participant DB as PostgreSQL

  Client->>API: GET /config
  API-->>Client: protocol version, auth mode, API/WS URLs
  Client->>API: POST /ws-tickets with session token
  API-->>Client: short-lived single-use WebSocket ticket
  Client->>Socket: connect /ws?ticket=...
  Socket->>Presence: connect and refresh socket presence

  Client->>Socket: COMMAND with clientSeq and GameCommand
  Socket->>Manager: submitCommand(roomRef, session, clientSeq, command)
  Manager->>Manager: claim room lease and enqueue per-room work
  Manager->>Manager: hash command and dedupe by room, user, clientSeq
  Manager->>Core: applyCommand(previousState, command)
  Core-->>Manager: accepted GameEvent list and next GameState
  Manager->>Store: appendEvents and persistCommandResult
  Store->>DB: insert match_events and command_results
  Store->>DB: save match_snapshot every 25 events and game over
  Manager->>Core: serializeEventsForViewer and serializeForViewer
  Socket-->>Client: viewer-safe EVENTS and snapshot

  Scheduler->>Manager: due trade deadlines, turn expiry, bot automation, cleanup
  Manager->>Bots: choose bot command from viewer-safe bot view
  Bots-->>Manager: command candidate
  Manager->>Core: applyCommand for accepted automation command
  Manager->>Store: appendEvents
  Scheduler-->>Socket: callback broadcasts room-local events
```

Rejected commands are persisted with their `clientSeq` and command hash when the backing store supports command results. Replayed duplicate commands return `COMMAND_ACK`; conflicting reuse of the same sequence returns `CLIENT_SEQ_CONFLICT`. The server serializes per room, so simultaneous rooms can progress without sharing command state or broadcasts.

## Game-Core Responsibilities

```mermaid
flowchart TB
  seed["match seed and rules"]
  resolver["createBoardForRules<br/>standard, islands, continent"]
  board["BoardGraph<br/>hexes, vertices, edges, ports"]
  commands["GameCommand"]
  reducer["applyCommand"]
  events["GameEvent log"]
  state["GameState"]
  replay["replay"]
  viewer["serializeForViewer<br/>secret resources and secret VP filtering"]
  bank["resource bank<br/>authoritative production supply"]

  seed --> resolver --> board
  board --> state
  commands --> reducer
  state --> reducer
  reducer --> events
  reducer --> state
  reducer --> bank
  events --> replay --> state
  state --> viewer
```

`game-core` owns deterministic map generation and validation for `standard`, `islands`, and `continent`, resource-bank production constraints, discard/robber/special-card rules, hidden victory-point accounting, and replay reconstruction. Online and local play both run through the same command/event model.

## Replay And Recovery

```mermaid
flowchart TB
  accepted["Accepted commands"]
  reducer["game-core applyCommand"]
  events["Ordered GameEvent log"]
  commandResults["command_results<br/>idempotency"]
  roomRows["rooms<br/>code, seats, timers"]
  snapshots["server snapshots<br/>full GameState"]
  validator["validateReplayLog<br/>and store-validation"]
  tail["tail events<br/>seq greater than snapshot"]
  replay["game-core replay"]
  viewer["viewer-safe serialization"]
  replayUi["React replay UI"]
  hydrate["RoomManager hydrateFromStore"]
  activeRooms["active in-memory rooms"]
  leases["room_leases"]
  postgres[("PostgreSQL replay truth")]

  accepted --> reducer --> events --> postgres
  accepted --> commandResults --> postgres
  activeRooms --> roomRows --> postgres
  events --> snapshots --> postgres
  postgres --> validator --> replay --> viewer --> replayUi
  postgres --> snapshots --> tail --> validator
  validator --> hydrate --> activeRooms
  postgres --> leases --> activeRooms
  events --> activeRooms
```

PostgreSQL is durable match truth when `DATABASE_URL` is configured. The server runs migrations on startup, hydrates recent sessions and rooms, preserves public room codes, lobby seats, trade deadlines, and active turn timers, validates stored room and command-result payloads before hydration, validates stored replay rows, and reconstructs game state from persisted config, board, snapshots, and tail events. Full snapshots are server-only acceleration data; viewer APIs continue to receive redacted state and events.

## Persistence Model

```mermaid
erDiagram
  USERS ||--o{ SESSIONS : owns
  USERS ||--o{ ROOM_SEATS : occupies
  ROOMS ||--o{ ROOM_SEATS : has
  ROOMS ||--o| MATCHES : starts
  ROOMS ||--o| ROOM_LEASES : claims
  MATCHES ||--o{ MATCH_PLAYERS : includes
  MATCHES ||--o{ MATCH_EVENTS : records
  MATCHES ||--o{ MATCH_SNAPSHOTS : snapshots
  MATCHES ||--o{ COMMAND_RESULTS : dedupes
  MATCHES ||--o{ CHAT_MESSAGES : contains
  MATCHES ||--o{ REPORTS : receives
  MATCHES ||--o{ ANALYTICS_EVENTS : annotates
```

The migrations in `packages/db/migrations` define the concrete schema. `PostgresEventStore` is the server adapter that translates room/session/match operations into SQL helpers exported from `@colonizt/db`. `MemoryEventStore` implements the same interface for tests and no-database local runs. Redis presence is intentionally absent from this model because it is ephemeral socket membership, not match truth.

## Deployment Shape

```mermaid
flowchart LR
  subgraph Build["Build artifacts"]
    npm["npm workspace build<br/>tsc -b plus Vite build"]
    dockerServer["Dockerfile.server<br/>Node runtime"]
    dockerWeb["Dockerfile.web<br/>static web runtime"]
  end

  subgraph Runtime["Runtime services"]
    browser["Browser<br/>loads static app"]
    webContainer["web container<br/>serves packages/web/dist"]
    serverContainer["server container<br/>Fastify on SERVER_PORT"]
    pg[("postgres:16<br/>DATABASE_URL")]
    optionalRedis[("redis optional<br/>REDIS_URL")]
    caddy["Caddy reverse proxy<br/>ops/caddy/colonizt.Caddyfile"]
    nginx["Nginx static config<br/>ops/nginx/default.conf"]
  end

  npm --> dockerServer --> serverContainer
  npm --> dockerWeb --> webContainer
  caddy --> webContainer
  caddy --> serverContainer
  nginx --> webContainer
  browser --> webContainer
  browser -->|"GET /config<br/>REST and WS URLs"| serverContainer
  browser -->|"WebSocket ticket then /ws"| serverContainer
  serverContainer --> pg
  serverContainer -. optional presence adapter .-> optionalRedis
```

Local production-style compose starts PostgreSQL, the Fastify server, and the static web build. Redis is optional and must not be treated as authoritative match history. `INSTANCE_MODE` must be `single`; active room authority currently lives inside one `RoomManager` owner guarded by memory or Postgres room leases.

## Boundary Notes

- The browser can run a complete local bot game because `packages/web` imports `game-core`, `bots`, and `demo-state`; network rooms still use the server as the authority.
- The server accepts player intent as commands and broadcasts only accepted, viewer-safe events and snapshots.
- `packages/protocol` owns shared wire contracts and lobby readiness math. Server and web should not duplicate startability rules.
- `RoomManager` owns authoritative room state: seats, host actions, spectators, pause/resume, chat, reports, command idempotency, automation progress, and persistence decisions. `room-runtime.ts` owns shared room liveness, connected-user counts, and timer keys.
- `lobby.ts` owns lobby settings transforms and startability; public online rooms remain bounded to 2-4 seats.
- `RoomAutomationScheduler` owns recurring work: turn expiry, staged trade deadlines, due bot actions, and room cleanup callbacks.
- `DueWorkIndex` keeps scheduler work scoped to due rooms rather than scanning every room blindly.
- `observability.ts` owns structured logs, metrics counters, admin-gated metrics/leaderboard support, and the enforced single-node instance-mode guard.
- `/admin/rooms/health` is admin-gated and reports room lifecycle, event progress, timers, connected-user counts, bots, spectators, and cleanup deadlines without exposing hands or hidden card data.
- `PresenceStore` tracks sockets and room membership only. The memory adapter is default; the Redis adapter is optional and ephemeral.
- `RoomOwnershipStore` guards active-room ownership. Memory is used for local/no-database runs; PostgreSQL leases are used when `DATABASE_URL` is configured.
- `EventStore` adapters validate stored rooms, command results, snapshots, and replay logs before returning hydrated runtime records.
- `packages/db` knows PostgreSQL tables but does not know Fastify, WebSocket sockets, React, or game rules.
- `packages/test-utils` re-exports bots and demo state so tests and scripts can build deterministic scenarios without depending on the UI or server internals.
