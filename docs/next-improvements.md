# Next Improvement Deep Dive

Reviewed on 2026-06-20.

This document captures the next improvement set after the architecture hardening pass. It is intentionally implementation-oriented: each section names the current risk, the desired shape, and acceptance criteria that can become tickets or PR slices.

## Current Baseline

The repo now has a strong enough shape to start tightening for real public multiplayer:

- `packages/game-core` remains pure, deterministic, and event-sourced.
- `packages/server` is the authoritative runtime for rooms, commands, bots, timers, persistence, chat, reports, and viewer-safe broadcasts.
- Network play uses runtime config, short-lived WebSocket tickets, origin checks, room codes, invite links, reconnect/resync, and deployed API/WSS smoke coverage.
- PostgreSQL stores sessions, room metadata, matches, events, command results, chat, reports, and analytics.
- Redis is optional presence only. It is not match truth.
- Current supported active-room deployment mode is single owner in one server process.

The next work should therefore focus less on basic architecture and more on game liveness, room recovery, durable command boundaries, operational backpressure, and a smoother multiplayer experience.

## Priority Map

| Priority | Theme | Why now |
| --- | --- | --- |
| P0 | Loop and liveness guardrails | Bot and human automation is mostly bounded, but the system lacks a single "no progress" watchdog across turns, trades, timers, and retries. |
| P0 | Room lookup and recovery | Stored rooms can be status-checked by code, but WebSocket `JOIN_ROOM` only joins active in-memory rooms. Restart or ownership changes can still feel like rooms vanished. |
| P0 | Durable command transaction | Accepted events and command idempotency rows are persisted in separate calls. A crash between them can still make lost-ack retries ambiguous. |
| P1 | Room lifecycle and scheduler efficiency | Cleanup is good for small scale, but recurring automation scans every active room each second. Dead/idle room handling needs clearer budgets and operator visibility. |
| P1 | Multiplayer UX | Invite, reconnect, paused, closed-room, and waiting states work, but the UI exposes them as thin status text instead of deliberate workflows. |
| P1 | Security and abuse controls | WebSocket command/chat limits exist per socket. Public REST, room code joins, analytics, and session creation need per-IP and per-session limits. |
| P2 | Maintainability and scaling shape | `RoomManager` and `App.tsx` are doing too much. Split by use case before adding ownership leases, fanout, and richer UI. |

## 1. Heuristics And Bot Logic

### Observed Risks

- Bot command selection is bounded to one command per scheduler tick or local timer tick, which is good.
- Bot trade response and offer resolution use shared scoring concepts, but local web automation and server automation still duplicate enough logic to drift.
- `packages/bots` scores possible actions partly by manually mutating cloned state instead of simulating through `applyCommand`.
- Current duplicate-offer prevention catches equivalent active bot offers, but repeated low-value offers across multiple turns can still feel uncanny.
- The engine blocks the active offerer from taking other actions while a staged trade is collecting responses, but the decision layer does not yet track "this turn is going nowhere".

### Improvements

1. Add an engine-backed command preview helper.
   - Introduce a helper in `packages/bots` or `packages/game-core` test utilities that evaluates a legal command by calling `applyCommand` on a cloned state and then scoring the resulting state.
   - Replace manual action utility mutations with this helper.
   - Keep the helper deterministic and side-effect free.

2. Add bot action budgets.
   - Per turn: maximum number of bot-originated non-terminal actions before forced `END_TURN`.
   - Per match minute: maximum automated commands per room.
   - Per trade: maximum response or resolution attempts for the same trade id.
   - Per offer shape: cooldown for repeated bot-originated trade shapes across adjacent turns.

3. Add progress-aware scoring.
   - Track a lightweight progress score for the active player: score changed, building count changed, resource diversity improved, playable cost shortfall reduced, trade closed, or turn ended.
   - If no progress occurs after N bot actions in the same turn, force end turn and record a metric.

4. Make trade heuristics more human-readable.
   - Add a debug trace mode that explains why a bot accepted, rejected, offered, finalized, or cancelled a trade.
   - Keep traces out of normal production logs unless sampled or explicitly enabled.

5. Add anti-annoyance heuristics.
   - Penalize offers to a clear leader more aggressively.
   - Penalize trades that help the recipient immediately win.
   - Prefer bank/harbor trades over human-facing offers when the utility difference is small.
   - Avoid repeating the same request after every player rejected it recently.

### Acceptance Criteria

- A property test runs many seeded bot games and asserts every bot command is legal through the real engine.
- A simulation reports no room exceeding configured automation budgets.
- A seeded replay can show bot decision traces for at least one accepted trade, one rejected trade, and one cancelled offer.
- Local and server bot offer resolution share the same core scoring helper.

## 2. Infinite Loop And Liveness Guardrails

### Observed Risks

- Server automation processes at most one bot command per room per scheduler tick.
- Local automation also schedules one bot command at a time.
- Turn timers can force roll/end-turn, and staged trades have response windows.
- However, there is no single cross-cutting liveness model that detects repeated no-op retries, reconnect churn, trade churn, or a room that is technically active but not meaningfully progressing.

### Improvements

1. Define a room liveness model.
   - `ACTIVE`: at least one seated human connected or current bot/timer work is progressing.
   - `PAUSED_EMPTY`: in-game room with no connected seated humans.
   - `IDLE_LOBBY`: lobby with no connected seated humans.
   - `STALLED`: repeated automation or command attempts without event progress.
   - `ABANDONED`: cleanup policy closed the room.
   - `FINISHED_UNLOADED`: completed room kept for replay but removed from memory.

2. Add monotonic progress checks.
   - Track last meaningful progress: event sequence, active phase key, active player, turn number, open staged trade id, and room status.
   - If the same progress key persists past a configured threshold while automation keeps running, pause the room with a typed reason instead of spinning.

3. Add automation watchdog metrics.
   - Count forced end-turns.
   - Count stalled bot turns.
   - Count trade timeouts.
   - Count rooms paused for no connected humans.
   - Count rooms paused for no progress.

4. Add human idle handling.
   - Before forced end-turn, show a visible countdown and "still here" affordance for network rooms.
   - For repeated idle human turns, shorten future timers or require the player to resume explicitly.
   - Do not let spectators keep a room alive forever unless a deliberate "watch replay/live" mode is added.

5. Add stuck-room admin tooling.
   - Internal endpoint or CLI script to list active rooms by liveness state, connected humans, event age, timer due time, staged trades, and memory age.
   - Internal command to pause, archive, or force cleanup a room.

### Acceptance Criteria

- A test can create a deliberately stalled room and verify it transitions to `STALLED` or paused state without unbounded automation.
- Bot-only progress tests complete or pause within a fixed command budget.
- Metrics expose liveness state counts and watchdog trip counts.

## 3. Multiplayer Room Finding Across Networks

### Observed Risks

- `GET /rooms/:roomRef` can look up persisted room status by id or room code.
- WebSocket `JOIN_ROOM` only calls `RoomManager.joinRoom`, which only searches active in-memory rooms.
- Startup hydrates a bounded recent set. A valid persisted room outside that window, or a room on another future owner instance, can appear closed or missing to a joining user.
- The client joins invite links optimistically by creating a session and opening a socket, without a clear preflight room lookup step.

### Improvements

1. Add `joinRoomByRef`.
   - Resolve active memory first.
   - If not active, load the room record by id or code from the store.
   - If the stored room is joinable, hydrate it into memory under the same room id and continue join.
   - If the stored room is closed, return a typed closed response with status and cleanup reason.

2. Add join preflight to the web client.
   - Invite links should call `GET /rooms/:roomRef` before opening the socket.
   - Show explicit states: joining, lobby full, already started as spectator, expired, abandoned, finished, or unavailable.
   - Preserve room code display even when the canonical id differs.

3. Add room-code abuse protection.
   - Rate-limit direct code lookup and join attempts per IP and per session.
   - Consider increasing room-code length if public enumeration becomes plausible.
   - Keep lobby listing separate from private code lookup.

4. Prepare owner routing.
   - Add a room ownership abstraction now, even if the only implementation is local memory.
   - Future implementations can use sticky sessions, a leases table, or advisory locks.
   - Tickets should optionally carry intended room ref so the gateway can route or reject before accepting a long-lived socket.

5. Expand cross-network proof.
   - Keep `smoke:deployed-network` and `smoke:deployed-browser`.
   - Add a mode that validates joining by room code rather than canonical id.
   - Run cross-network smoke from two different egress paths before calling public multiplayer stable.

### Acceptance Criteria

- A room created before server restart can be joined by code after restart, if still active by lifecycle policy.
- Joining an expired, abandoned, full, or finished room shows a typed UI state and does not loop reconnects forever.
- Direct room-code brute force tests hit rate limits.
- Deployed browser smoke covers invite link, room code, reconnect, and one command after reconnect.

## 4. Room Lifecycle And Resource Management

### Observed Risks

- The server has a max active room cap and cleanup policy for empty lobbies, empty in-game rooms, and finished rooms.
- Empty in-game rooms pause and later resume without shortening timers.
- Scheduler automation scans all active rooms every second and then cleanup scans on a separate interval.
- Broadcasts scan all socket clients and filter by room id.
- Presence can use Redis, but socket TTL refresh is not tied to the heartbeat path.

### Improvements

1. Move from scan-all automation to due-work scheduling.
   - Track next due work per room: turn timer, staged trade deadline, bot action delay, cleanup deadline.
   - Use a priority queue or min-heap keyed by next due timestamp.
   - Recompute due work whenever a room changes phase, timer, connection state, trade state, or lifecycle state.

2. Index sockets by room.
   - Maintain `roomId -> Set<SocketClient>` in the WebSocket layer.
   - Broadcast room events by room set instead of scanning every connected socket.
   - Keep a global socket set only for shutdown and metrics.

3. Tighten cleanup policy semantics.
   - Separate lobby idle timeout, in-game paused timeout, finished memory retention, and stale persisted-room archival.
   - Store the exact cleanup deadline and reason, not only `emptySince` and `pausedAt`.
   - Make cleanup idempotent and auditable.

4. Refresh presence on heartbeat.
   - Treat client `PING` as a presence refresh.
   - Redis adapter should extend socket and room membership TTLs on heartbeat.
   - Memory adapter should track last heartbeat for dead socket cleanup.

5. Add graceful shutdown draining.
   - Stop accepting new WebSocket joins.
   - Persist latest room metadata and timers.
   - Close sockets with a restart code and a retry-after hint.
   - On startup, hydrate active rooms and recompute timers/deadlines from persisted policy.

6. Add resource budgets.
   - Max active rooms.
   - Max connected sockets.
   - Max spectators per room.
   - Max chat messages per room per minute.
   - Max automation commands per room per minute.
   - Max event log size before snapshot compaction is required.

### Acceptance Criteria

- Scheduler runtime is proportional to due rooms, not all active rooms per second.
- Broadcast tests verify a busy unrelated room does not affect command latency in another room.
- A Redis presence smoke proves heartbeat TTL refresh keeps connected seats alive and stale sockets are eventually removed.
- Cleanup emits metrics and structured logs with room id, status, reason, age, connected humans, and event seq.

## 5. Durable Commands, Replay, And Persistence

### Observed Risks

- Event append is transactional inside `appendMatchEvents`.
- Command result persistence is a separate call after event append.
- If the process crashes after events are written but before the command result is written, a lost-ack retry may not find the original idempotency row.
- Rehydration rebuilds staged trade deadlines as a fresh window, which is simple but can extend old offers after restart.
- Hydration replays all events for loaded rooms. This is fine now, but long matches should hydrate from snapshots plus tail events.

### Improvements

1. Add an atomic command commit.
   - Introduce a store method that writes accepted events, command result, room metadata, and optional match-finished status in one database transaction.
   - For rejected commands, write the rejection row atomically before returning.
   - Keep memory store behavior equivalent for tests.

2. Make command result replay independent of in-memory state.
   - Persist enough command result metadata to return `COMMAND_ACK` after restart.
   - For accepted commands, store `seqStart`, `seqEnd`, and a command hash.
   - Prefer returning event range plus requiring resync over storing duplicate event payloads forever.

3. Clarify restart semantics for timers and staged trades.
   - Persist absolute deadline and logical event-seq deadline for staged trades.
   - On restart, choose the earlier safe deadline unless the room was deliberately paused.
   - Document whether restart pauses countdowns or preserves elapsed wall time.

4. Add replay invariants.
   - Reject duplicate or missing event sequences during replay import.
   - Verify event schema version compatibility.
   - Add fixture coverage for v1 immediate trades and v2 staged trades.

5. Add snapshots.
   - Persist periodic snapshots by match id and event seq.
   - Hydrate long rooms from latest snapshot plus tail events.
   - Keep events as the canonical audit log.

### Acceptance Criteria

- A crash-window test simulates append success and command-result failure, then restart and retry. The retry must reconcile cleanly.
- Postgres integration tests prove accepted and rejected command idempotency survives restart.
- Staged trade deadlines after restart match documented behavior.
- Replay fails fast on duplicate or missing event sequence.

## 6. UI And UX

### Observed Risks

- The main game experience is feature-rich, but `App.tsx` carries local game state, network session state, reconnect, trade drafting, timers, replay, sounds, analytics, and rendering orchestration.
- Network states are mostly expressed through terse status text.
- Invite join is optimistic and can create confusing errors when rooms are gone, full, paused, or already started.
- Reconnect retries every 750 ms without jitter, user control, or a clear stop condition.
- Trade UI is functional but can still feel abrupt when multiple bot responses and timeouts fire.

### Improvements

1. Add a room entry flow.
   - Room code input on the main screen.
   - Paste link detection.
   - Preflight room lookup before socket connect.
   - Clear states for lobby, in-game spectator, full, expired, abandoned, finished, and unavailable.

2. Improve reconnect UX.
   - Exponential backoff with jitter and a visible retry countdown.
   - "Retry now" and "leave online room" actions.
   - Clear stale resume state on unrecoverable auth or closed-room states.
   - Show whether commands are pending, acknowledged, or need resync.

3. Make paused and idle states explicit.
   - Show "waiting for seated player to reconnect" when a room is paused.
   - Show the timer freeze/resume behavior.
   - Give hosts a clear abandoned-room explanation after cleanup.

4. Improve trade comprehension.
   - Show response countdown consistently from server-provided deadlines in network rooms.
   - Show responder states in player order.
   - Explain why a trade cannot be finalized: insufficient resources, no willing responder, expired, or already closed.
   - Reduce overlay conflicts on mobile.

5. Split client state by hook.
   - `useNetworkRoom`: sessions, tickets, socket, reconnect, resync, pending commands.
   - `useTradeDraft`: offer/request normalization, maritime preview, validation.
   - `useTurnTimer`: local timer and network timer display.
   - `useReplayControls`: replay loading and stepping.
   - `GameShell` and focused panels for room share, phase, players, trade, log, and board.

6. Accessibility and polish.
   - Keep keyboard shortcuts discoverable but not text-heavy in the game surface.
   - Ensure overlays trap focus only when modal.
   - Add ARIA live regions for turn changes, trade responses, and reconnect state.
   - Validate mobile layouts for trade panel, player stats, and room share.

### Acceptance Criteria

- Invite link join can be tested from a fresh browser context with no stored session.
- Reconnect has bounded backoff and recoverable/unrecoverable UI states.
- Mobile E2E covers trade response, room code display, reconnect, and paused room messaging.
- `App.tsx` loses the network and trade orchestration responsibilities to focused hooks.

## 7. Reliability And Observability

### Observed Risks

- Metrics cover active rooms, sockets, commands, replay, cleanup, scheduler, WebSockets, and DB failures.
- Health returns service, presence adapter, node id, and instance mode.
- Logs are structured for many server events.
- There is no readiness distinction for migrations, store connectivity, room hydration status, or scheduler health.
- Client-side analytics are best effort and stored locally before sending.

### Improvements

1. Split health and readiness.
   - `/health` remains cheap process liveness.
   - `/ready` verifies database connectivity, migrations applied, event store usable, and scheduler started.
   - Include hydration count and last hydration error on startup.

2. Add room lifecycle metrics.
   - Active rooms by status.
   - Rooms by liveness state.
   - Cleanup reason counts.
   - Paused duration histogram.
   - Room age and event count histograms.

3. Add command latency details.
   - Separate validate, append, persist metadata, serialize, and broadcast timings.
   - Track idempotent replay and conflict rates.

4. Add client-visible error codes.
   - Map server error codes to stable UI messages.
   - Avoid raw `JSON.stringify(error)` in player-facing surfaces.
   - Preserve full detail in logs or debug panels.

5. Add chaos and recovery scripts.
   - Drop socket after command send before ack.
   - Restart server after accepted command append.
   - Restart during staged trade.
   - Disconnect all seated humans and reconnect before cleanup.

### Acceptance Criteria

- `/ready` fails when database migrations or event store writes are unavailable.
- Dashboard metrics can answer: how many rooms are active, paused, stalled, finished, abandoned, or cleanup-pending.
- A chaos script verifies lost-ack command recovery and paused-room reconnect.

## 8. Maintainability

### Observed Risks

- `RoomManager` is the core orchestration object for sessions, rooms, seats, starts, readiness, commands, timers, bots, cleanup, chat, reports, replay, and hydration.
- This was useful for the prototype, but the next features will make it harder to reason about transactions, liveness, and owner routing.
- `App.tsx` has similar concentration on the frontend.

### Improvements

1. Split server use cases while keeping one authoritative runtime.
   - `SessionService`: session creation, lookup, revocation, display names.
   - `RoomDirectory`: room create, lookup by id/code, persisted hydration.
   - `RoomLifecycleService`: cleanup, pause/resume, liveness, ownership status.
   - `CommandService`: idempotency, validation, atomic commit, replay ack.
   - `AutomationService`: bot turns, trade deadlines, turn expiry.
   - `RoomProjectionService`: viewer state, room summaries, replay payloads.

2. Keep domain logic in `game-core`.
   - Avoid adding wall-clock or persistence to engine code.
   - Move reusable rule calculations and command simulation helpers into pure modules.

3. Make ports explicit.
   - Event store should expose atomic command commit.
   - Presence should expose heartbeat refresh and stale socket cleanup.
   - Room ownership should be an interface even before multi-instance support.

4. Add architecture decision records.
   - Command idempotency transaction shape.
   - Timer and trade deadline restart semantics.
   - Room ownership strategy.
   - Redis role and limits.

### Acceptance Criteria

- `RoomManager` becomes a thin facade or is split without changing public server behavior.
- Server tests can exercise command commit, lifecycle cleanup, and automation through focused services.
- Frontend network/reconnect logic is testable without rendering the full game board.

## 9. Scalability

### Observed Risks

- Current mode is explicitly single-node active-room authority.
- Redis presence can help socket presence but cannot prevent two instances from processing the same room.
- WebSocket tickets are local memory and single-use only within one process.
- Broadcast fanout is local to one process.

### Improvements

1. Single-node hardening first.
   - Keep `INSTANCE_MODE=single` as the supported production mode until owner routing exists.
   - Enforce one active server replica in deployment docs and health metadata.

2. Add room ownership leases.
   - Use Postgres advisory locks or a `room_leases` table.
   - Only the owner may process commands, timers, bots, and cleanup for that room.
   - Lease renewal should be observable and bounded.

3. Add owner-aware routing.
   - Easiest path: sticky sessions by room code or room id at the load balancer.
   - Stronger path: any gateway can accept the socket, then forward room commands to the owner.
   - Tickets should include room intent or be exchanged after room lookup.

4. Add cross-node fanout.
   - Use Redis pub/sub or Postgres notify for accepted events, room state, chat, presence, and timer updates.
   - Apply viewer redaction before sending to each local socket.
   - Ensure only event ids and room ids are broadcast when possible; avoid pushing full private game state through shared channels.

5. Add true socket load tests.
   - Replace or rename `load:sockets`, which currently simulates bot games without opening real sockets.
   - Cover many rooms, full human rooms, spectators, chat bursts, reconnects, and idle cleanup.

### Acceptance Criteria

- Two server instances cannot both own the same active room.
- Clients connected to different instances observe the same event sequence for one room.
- Load tests use real WebSockets and report p95 command latency, fanout latency, event loop lag, DB latency, socket count, and cleanup behavior.

## 10. Security

### Observed Risks

- WebSocket origin checks and ticket auth are in place.
- Sessions are persisted as token hashes when PostgreSQL is used.
- REST endpoints for sessions, room creation, room lookup, analytics, and tickets need stronger public abuse controls.
- Chat and reports are persisted and should be treated as user-generated content.
- `/metrics` exists and deployment docs warn it should be admin-only.

### Improvements

1. Add layered rate limits.
   - Per IP: sessions, room creation, room lookup, WebSocket ticket issuance, analytics, reports.
   - Per session: commands, chat, reports, room joins.
   - Per room: chat, spectators, joins, automation side effects.
   - Preserve current per-socket command/chat protection as an inner layer.

2. Harden sessions.
   - Add default session expiry.
   - Add revocation endpoint or operator tool.
   - Enforce session expiry in REST and WebSocket paths.
   - Consider rotating token hash secret if a server-side pepper is introduced.

3. Harden WebSocket tickets.
   - Consider persisted or shared ticket store before multiple gateway processes.
   - Bind tickets to session, expected origin, and optional room intent.
   - Reject reuse races deterministically.

4. Protect user content.
   - Normalize and sanitize chat display.
   - Add moderation controls for reports.
   - Limit stored message size and report reason size.
   - Avoid exposing raw user IDs where display names are enough.

5. Tighten headers and admin paths.
   - Keep static web security headers.
   - Ensure public Caddy config does not expose `/metrics`.
   - Add operator authentication if metrics or admin endpoints move behind the app.

6. Add security tests.
   - Origin rejection.
   - Ticket reuse and expiry.
   - Rate-limit behavior.
   - Room code enumeration throttling.
   - Session revocation.
   - Chat/report payload limits.

### Acceptance Criteria

- Public unauthenticated endpoints have rate limits.
- Expired or revoked sessions fail consistently across REST and WebSocket.
- Metrics and admin-only lifecycle tools are not publicly reachable.

## Suggested Implementation Order

1. `P0 durable command commit`
   - Add atomic store method.
   - Add crash-window tests.
   - Update command submit path.

2. `P0 room lookup and join recovery`
   - Implement `joinRoomByRef`.
   - Add invite preflight.
   - Add closed-room UI states.

3. `P0 liveness watchdog`
   - Add room progress key.
   - Add automation budgets.
   - Add stalled room metrics and tests.

4. `P1 bot heuristic consolidation`
   - Add engine-backed command preview.
   - Share local/server trade resolution scoring.
   - Add trade cooldown and traces.

5. `P1 scheduler and broadcast scaling`
   - Add due-work queue.
   - Add room-indexed socket fanout.
   - Refresh presence on heartbeat.

6. `P1 reconnect and multiplayer UX`
   - Add preflight room entry flow.
   - Add bounded reconnect backoff.
   - Add pending command status and player-facing error mapping.

7. `P1 REST/session security`
   - Add rate limits.
   - Add session expiry/revocation.
   - Add code enumeration tests.

8. `P2 service splits and ownership prep`
   - Extract focused server services.
   - Add room ownership interface.
   - Add ADRs for ownership and deadline semantics.

9. `P2 true load and multi-instance prototype`
   - Replace simulated socket load with real sockets.
   - Add owner lease experiment.
   - Add cross-node fanout proof.

## First Sprint Recommendation

The next sprint should take slices 1 through 3 only:

1. Atomic command commit.
2. Join-by-code hydration and invite preflight.
3. Liveness watchdog for automation, staged trades, and idle rooms.

Those three reduce the most serious correctness risk: players losing rooms or command acknowledgement during reconnect/restart, and rooms consuming resources while not actually progressing.
