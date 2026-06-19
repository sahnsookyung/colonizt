# Codebase Review

Reviewed on 2026-06-16.

## Scope

This review covers the current workspace modules one by one:

- Root workspace, scripts, and documentation
- `packages/game-core`
- `packages/bots`
- `packages/demo-state`
- `packages/test-utils`
- `packages/db`
- `packages/server`
- `packages/web`
- Tests, smoke checks, and deployment files

The main product risk is multiplayer outside localhost. The domain model and local game loop are fairly strong, but public network play still needs a dedicated hardening pass around host binding, public configuration, WebSocket auth/origin checks, reconnect behavior, room joining, and multi-instance ownership.

## Executive Summary

The repo has a healthy shape for an interview-grade real-time board game: deterministic core, server-authoritative commands, event logs, viewer-safe serialization, bot automation, React UI, and a useful test matrix. The strongest boundaries are `game-core` and `server`; most game behavior can be replayed and inspected without UI dependencies.

The biggest tightening opportunities are:

1. Make online multiplayer usable across networks, not just local host-created rooms.
2. Make the server production-safe for public WebSocket traffic.
3. Split the large web app component into hooks and focused UI modules.
4. Persist enough command/session metadata to make reconnect and retry behavior robust after process restarts.
5. Add real cross-network smoke tests against configurable HTTP/WSS URLs.
6. Clarify replay/import migration behavior around v1 and v2 staged trades.

## Highest Priority Work

### P0: Public Multiplayer Connectivity

The original review called out localhost defaults that made multiplayer brittle outside one machine. The current implementation addresses the deployment-facing pieces:

- Container/server deploys bind through `SERVER_HOST=0.0.0.0`.
- Web, WebSocket, and analytics calls discover the public API through `GET /config`, with `VITE_API_BASE_URL` kept only as an optional fallback.
- `docker-compose.prod.yml` no longer bakes a localhost API URL into the web image.

Remaining recommended work:

- Add invite links and a join-room form.
- Add a deployed smoke command, for example `npm run smoke:network -- --base-url https://api.example.com --origin https://play.example.com`.
- Require HTTPS/WSS for non-local production.

### P0: WebSocket Security and Auth

The WebSocket route accepts `sessionToken` from the query string and does not visibly enforce `Origin` itself. Browser CORS does not protect WebSocket upgrades the same way it protects normal fetches.

Recommended changes:

- Check `request.headers.origin` against `WEB_ORIGIN` or an allow-list before accepting `/ws`.
- Replace long-lived query-string session tokens with one-time, short-lived WebSocket tickets, Secure SameSite cookies, or another browser-compatible handshake.
- Avoid logging tokens in request URLs.
- Add tests for disallowed WebSocket origins and invalid tickets.

### P1: Reconnect and Command Idempotency

The web client reconnects every 750 ms forever, and `clientSeq` advances before command acknowledgement. The server idempotency cache is in memory only.

Recommended changes:

- Add exponential backoff with jitter and visible reconnect states.
- Track pending commands until the server confirms by `clientSeq` and server `seq`.
- Persist accepted command idempotency keys or command hashes in the database.
- On reconnect, reconcile pending commands against server events before allowing new commands.

### P1: Single-Instance Room Ownership

PostgreSQL is the replay truth, but active room state is process-local. Redis is currently presence only. Multiple server instances can diverge if they accept commands for the same room.

Recommended changes:

- For the next public deployment, use one active server process or sticky route all players in a room to the same process.
- Before horizontal scaling, add room ownership leases or Postgres advisory locks.
- Add Redis or Postgres pub/sub fanout if clients for one room can land on different instances.

## Module Review

## Root Workspace

Relevant files:

- `package.json`
- `README.md`
- `.env.example`
- `docker-compose.yml`
- `docker-compose.prod.yml`

What is working:

- Workspace scripts cover linting, typechecking, unit tests, property tests, integration tests, smoke tests, simulations, and build.
- The README explains the project boundaries clearly.
- Docker Compose provides local Postgres and Redis and a production-style build path.

What to tighten:

- The package set is coherent, but `README.md` says `packages/test-utils` contains bots, while bots are now in `packages/bots`. Update the package list to match the current split.
- `docker-compose.prod.yml` is production-style but still points the web build at localhost. This is fine for local Compose, but it should be clearly named as local production, or parameterized for public hosts.
- Add a `verify:deployed` script that can hit an externally reachable URL and WSS endpoint.

## `packages/game-core`

Relevant files:

- `packages/game-core/src/types.ts`
- `packages/game-core/src/engine.ts`
- `packages/game-core/src/board.ts`
- `packages/game-core/src/replay.ts`
- `packages/game-core/src/serialize.ts`

What is working:

- This is the cleanest boundary in the repo. It has no React, WebSocket, database, HTTP, filesystem, time, or ambient randomness dependency.
- The engine is deterministic and event-sourced.
- Board creation validates classic tile counts, token distribution, port placement, and high-probability token spacing.
- Commands are validated before application, and event application updates state through a single reducer path.
- Staged trades have explicit commands and event types: offer, response, finalize, cancel, expire, close.
- Viewer serialization redacts hidden resources and staged response details from uninvolved viewers.
- Invariants cover settlement distance, ownership consistency, staged trade response shape, piece limits, and game-over threshold.

What to tighten:

- `replay(log)` sorts events by sequence but does not reject duplicate or missing sequence numbers. For persisted multiplayer truth, replay should fail fast on duplicate, missing, or out-of-range event sequences.
- `normalizeImportedState` upgrades every imported state to schema v2 and closes `OPEN` trades with `MIGRATED`. The docs say this is for unfinished v1 open trades, so either gate the close behavior on `state.schemaVersion === 1` or rename/document it as a broad import normalizer.
- `closeExpiredTrades` only handles legacy TTL-style `OPEN` trades. That is probably intentional because staged trade response deadlines live outside core, but the name invites misuse. Rename to `closeExpiredLegacyTrades` or add a doc comment.
- `applyEvents` trusts event payloads. That is fine internally, but replay/import paths should validate stored payloads before applying them.
- The core supports both legacy and staged trade concepts. Add a short architecture note stating which statuses are live v2 behavior and which exist for replay compatibility.

Suggested tests:

- Replay rejects duplicate sequence numbers.
- Replay rejects missing sequence numbers.
- v2 imported `COLLECTING_RESPONSES` trades are preserved or intentionally closed according to the chosen migration policy.
- Staged trade redaction remains correct when a spectator reconnects from a snapshot and then receives events.

## `packages/bots`

Relevant files:

- `packages/bots/src/index.ts`
- `packages/bots/tests/bots.test.ts`

What is working:

- Bots consume viewer-safe state through `createBotView`, so hidden opponent resources are not used for decisions.
- Trade evaluation considers hand value, production coverage, shortfalls, ports, waste pressure, leader pressure, and difficulty.
- Bot temperament is stable per turn, reducing exploitability from repeated trade spam.
- There are different bot personalities and a planner-style bot for stronger play.

What to tighten:

- Some bot utility simulation manually mutates cloned state rather than evaluating the command by passing through `applyCommand`. This can drift from engine behavior as rules evolve.
- Server-side bot offer resolution scores the bot offerer's hand after trade, while the local web path also subtracts a small responder score factor. Align those two paths so local and network bot behavior stay predictable.
- Setup-placement scoring is duplicated between bot and demo/test helpers. Move common placement scoring into one package if it is intended to remain shared.
- Add more seeded regression tests for bot-offered trades with multiple willing responders.

Suggested tests:

- Bot trade response is deterministic for the same turn and seed.
- Bot offerer chooses the same responder locally and on the server for the same state.
- Hard difficulty rejects mildly favorable-to-human trades more often than easy difficulty.
- Bots never use hidden resource counts in their trade decision.

## `packages/demo-state`

Relevant files:

- `packages/demo-state/src/index.ts`

What is working:

- Centralized demo game creation keeps local UI, tests, and simulations aligned.
- Bot-filled setup helpers make end-to-end and replay tests easy to write.

What to tighten:

- This package now carries more than demo state. It includes helpers that look like test fixtures and game setup utilities.
- Rename or split responsibilities: `demo-state` for product demo seeds, `test-utils` for test-only helpers, and possibly `scenario-fixtures` for reusable deterministic scenarios.
- Keep all demo fixtures explicit about whether they use hidden full state or viewer-safe state.

## `packages/test-utils`

Relevant files:

- `packages/test-utils/src/index.ts`

What is working:

- The package provides a stable import surface for tests and scripts.

What to tighten:

- It currently appears to be a thin re-export layer. That is acceptable, but the package name implies it owns test helpers.
- Either collapse it into `demo-state` or move test-only helpers into this package to clarify ownership.

## `packages/db`

Relevant files:

- `packages/db/src/index.ts`
- `packages/db/src/migrate.ts`
- `packages/db/migrations/001_init.sql`
- `packages/db/migrations/002_sessions_and_event_writes.sql`

What is working:

- The schema has the right backbone: users, rooms, seats, matches, match players, event log, snapshots, ratings, chat, reports, analytics, and sessions.
- `match_events` uses `(match_id, seq)` as a primary key, which protects replay order.
- Migrations are wrapped in transactions.
- Replay loading reads config, board, and events in sequence order.

What to tighten:

- Session tokens are stored plaintext. Hash session tokens at rest, and only compare hashes.
- `match_snapshots` exists but does not appear to be written yet. Add periodic snapshots for long games and faster restart hydration.
- Event appends insert one row at a time inside a transaction. This is fine for now, but batch insertion will matter under load.
- Restart hydration loads recent rooms and replays all events. Once games grow, hydrate from the latest snapshot plus tail events.
- `listPersistedRooms` should avoid N+1-style loading before public scale.

Suggested tests:

- Duplicate event `seq` insert fails and the room manager surfaces a clear rejection.
- Hydration from a room with many events is bounded once snapshots are added.
- Revoked sessions cannot reconnect.
- Hashed tokens never appear in persisted rows or logs.

## `packages/server`

Relevant files:

- `packages/server/src/index.ts`
- `packages/server/src/room-manager.ts`
- `packages/server/src/event-store.ts`
- `packages/server/src/presence.ts`
- `packages/server/src/schemas.ts`

What is working:

- `RoomManager` is the authoritative gameplay boundary for sessions, rooms, readiness, commands, timers, bots, chat, reports, and replay.
- Per-room queues serialize commands and timer/bot work.
- Accepted events are persisted before in-memory state is advanced.
- Viewer-specific snapshots and events preserve hidden information.
- WebSocket message validation and command/chat rate limits are present.
- Startup can hydrate recent rooms from Postgres.
- Redis is correctly treated as ephemeral presence, not match truth.

What to tighten:

- Change the CLI server bind default or make local-only binding loud. `127.0.0.1` is safe for development, but it is a common deployment footgun.
- Add explicit WebSocket origin validation.
- Replace query-string WebSocket tokens with short-lived tickets or cookie-backed auth.
- Add server-side heartbeat and dead socket cleanup. The client sends PING, but the server should also detect half-open sockets.
- Rate limits are per socket. Add per-session and per-IP limits for public traffic.
- `processedClientCommands` is in memory only. Persist command idempotency if clients can retry after restart.
- Active room ownership is in memory. Add a single-owner strategy before running multiple server instances.
- `refreshTimer` uses one `turnSeconds` value for all server phases. Product behavior currently wants separate roll and action timers. Make timers phase-specific in server truth, not only local UI.
- `tradeResponseDeadlines` rebuild to a fresh 15 seconds on hydration. Decide whether restart should close expired staged trades, preserve original deadlines, or grant a new window, then document and test it.
- Bot automation is a 1-second scan over all rooms. This is fine for small scale; a priority queue keyed by next due action will scale better.

Suggested tests:

- WebSocket upgrade rejects disallowed origins.
- WebSocket token/ticket cannot be reused after expiry.
- Reconnect after accepted command but before client broadcast does not duplicate or lose the command.
- Two rapid commands for one room are serialized and acknowledged in sequence.
- Hydration with an active staged trade follows the documented deadline policy.
- Server timer behavior matches roll/action timeout requirements.

## `packages/web`

Relevant files:

- `packages/web/src/App.tsx`
- `packages/web/src/network.ts`
- `packages/web/src/analytics.ts`
- `packages/web/src/sounds.ts`
- `packages/web/tests`

What is working:

- The UI supports local play, bot play, network room creation, replay/history, trade overlays, dice animation, keyboard shortcuts on desktop, resource visuals, sounds, and mobile-aware behavior.
- Trade counters clamp against available resources and clear after trade actions.
- Local timers support 60-second roll and 4-minute action deadlines.
- Staged trade UI shows recipients and lets the offerer finalize or cancel.
- E2E and component tests cover a useful amount of user behavior.

What to tighten:

- `App.tsx` is too large. Split it into focused modules:
  - `useLocalGame`
  - `useNetworkRoom`
  - `useTurnTimers`
  - `useTradeOverlay`
  - `BoardView`
  - `ActionDock`
  - `Sidebar`
  - `MatchMenu`
- Runtime config should replace hard-coded localhost defaults for deployed web builds.
- WebSocket URL construction should use `new URL()` instead of string replacement so pathful base URLs and reverse proxies work correctly.
- The WebSocket message handler should catch JSON parse errors and surface a recoverable error instead of throwing.
- Reconnect should use backoff with jitter and a maximum delay.
- The UI needs an explicit join-room path, invite URL copy, and room code entry.
- Resume state should clear on unrecoverable auth or missing-room errors.
- `viewerToGameState` reconstructs hidden resources as zero for non-viewer players. Keep viewer projection and authoritative state more separate to avoid accidental game logic over projected data.
- Local and network timers should use the same semantic source of truth.

Suggested tests:

- Networked two-browser flow: host creates room, second browser joins by link, both ready, both see same state.
- WebSocket close during a pending command, then reconnect and reconcile.
- Invalid JSON from WebSocket does not crash the app.
- Reconnect backoff progresses and resets after successful open.
- Invite link works on mobile viewport.
- Trade response overlay updates from remote accept/reject events before finalization.

## Scripts and Tooling

Relevant files:

- `scripts/network-smoke.ts`
- `scripts/load-sockets.ts`
- `scripts/verify-local.sh`
- `scripts/simulate-ranked.ts`
- `scripts/simulate-rush.ts`

What is working:

- `verify-local.sh` is a good comprehensive local quality gate.
- `network-smoke.ts` spins up a real server, session, room, WebSocket, ready action, and command.
- Simulations exercise deterministic game behavior and conflict-style command flow.

What to tighten:

- `network-smoke.ts` is local-only because it starts an in-process server on `127.0.0.1`. Keep it, but add a separate deployed-network smoke that accepts public HTTP and WSS URLs.
- `load-sockets.ts` currently simulates bot games rather than opening real sockets. Rename it or add a true socket load test.
- Add a chaos/reconnect script that creates a room, drops the socket after sending a command, reconnects, and verifies command reconciliation.
- Add a reverse-proxy smoke profile with HTTPS and WSS.

## Documentation

Relevant files:

- `docs/architecture.md`
- `docs/deployment.md`
- `docs/testing.md`
- `docs/replay-format.md`
- `docs/bot-trade-and-rules.md`

What is working:

- The docs describe the architecture boundaries accurately.
- Deployment notes already say sticky sessions or a room router are required before horizontal scaling.
- Testing docs cover the current script surface.
- Bot trade and staged trade behavior are documented enough to preserve design intent.

What to tighten:

- Add a public multiplayer deployment guide with:
  - Public web origin
  - Public API origin
  - Required HTTPS/WSS reverse proxy rules
  - `SERVER_HOST=0.0.0.0`
  - `WEB_ORIGIN`
  - Runtime client config
  - Sticky sessions or single server process
  - WebSocket origin checks
  - Token/ticket strategy
- Document the v1 to v2 replay migration behavior next to code.
- Clarify which scripts are pure local smoke checks and which validate deployed networking.

## Multiplayer Across Different Networks

The current architecture can become public multiplayer, but it should be hardened in stages.

### Stage 1: Make One Public Server Work Reliably

Goal: one server process, one public web origin, one public API/WSS origin, real players can join by link.

Tasks:

1. Public binding and config
   - Set `SERVER_HOST=0.0.0.0` for deploys.
   - Validate startup config: fail fast if production mode has localhost `WEB_ORIGIN` or API URL.
   - Add web runtime config so the browser can call the public API.

2. Join flow
   - Add `Join Match` to the pre-game menu.
   - Add room code entry and invite link copy.
   - Route invite links to auto-create a session, connect, and join the room.
   - Preserve spectator join as a separate action.

3. WebSocket security
   - Validate `Origin` on `/ws`.
   - Replace query-string auth with short-lived WebSocket tickets or Secure SameSite cookies.
   - Add ticket expiry and one-time use.

4. Reconnect
   - Add exponential backoff with jitter.
   - Keep pending commands until the server confirms them.
   - Resync by last server sequence after reconnect.
   - Clear stale resume state on 401, revoked session, or room not found.

5. Timers
   - Move the 1-minute roll and 4-minute action timers into server state.
   - Broadcast timer metadata from the server.
   - Keep local UI timers as display only for online games.

6. Smoke test
   - Add `smoke:deployed-network`.
   - Test public HTTP health, session creation, room creation, WebSocket connect, join, ready, command, resync, close, reconnect.

### Stage 2: Make Restart and Retry Safe

Goal: a single public server can restart without corrupting games or losing accepted player intent.

Tasks:

1. Persist command idempotency
   - Store `(room_id, user_id, client_seq, command_hash, accepted_event_seq_start, accepted_event_seq_end)`.
   - On duplicate client command, return the original accepted event range.
   - Reject same seq with different command hash.

2. Snapshot active games
   - Write snapshots every N events or every M seconds.
   - Hydrate from latest snapshot plus tail events.
   - Validate replay sequence continuity during hydration.

3. Deadline policy
   - Persist staged trade response deadline metadata or intentionally close on restart.
   - Persist phase timer deadline metadata.
   - Ensure restarted server does not grant inconsistent extra time unless that is the documented policy.

4. Session hardening
   - Hash session tokens at rest.
   - Add revocation and expiry behavior.
   - Update `last_seen_at` on authenticated traffic.

### Stage 3: Horizontal Scaling

Goal: multiple server instances without room divergence.

Tasks:

1. Choose a room ownership model
   - Easiest: sticky sessions by `roomId` at the load balancer.
   - Safer: one active owner lease per room using Postgres advisory locks or a leases table.

2. Cross-node fanout
   - Publish accepted events to Redis/Postgres channels.
   - Instances subscribed to a room broadcast viewer-redacted events to their local sockets.
   - Include monotonic event seq checks before broadcasting.

3. Distributed timers
   - Ensure only the room owner runs timers and bots.
   - Reassign ownership and rebuild due timers on owner loss.

4. Load tests
   - True WebSocket load with many rooms, players, spectators, reconnects, and chat.
   - Measure command latency, queue time, DB append time, event fanout latency, reconnect recovery time, and dropped sockets.

## Recommended Implementation Order

1. Add join-room/invite UI and runtime web config.
2. Change production bind/config defaults and add startup validation.
3. Add WebSocket origin validation and short-lived WS tickets.
4. Add reconnect backoff and pending command acknowledgement.
5. Move online timer truth fully to server phase timers.
6. Add deployed-network smoke tests.
7. Persist command idempotency and snapshots.
8. Hash sessions and add expiry/revocation.
9. Add room ownership strategy for multi-instance scaling.
10. Split `App.tsx` into focused hooks/components.

## Suggested Quality Gate

Before calling public multiplayer ready, this should pass:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:property
npm run test:integration
npm --workspace @colonizt/web run test
npm run smoke:network
npm run smoke:deployed-network -- --base-url https://api.example.com --web-origin https://play.example.com
```

The deployed smoke should run against an environment that uses HTTPS and WSS through the same reverse proxy a player will use.
