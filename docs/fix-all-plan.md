# Fix-All Remediation Plan

Created on 2026-06-16 from `docs/codebase-review.md`.

## Goal

Turn the current Colonizt prototype into a reliable public multiplayer game that can run across different networks while keeping the deterministic engine, replay model, staged trades, bots, and UI maintainable.

The plan is ordered by dependency. Do not begin multi-instance scaling work until one public server process is secure, reconnect-safe, and validated through deployed smoke tests.

## Definition of Done

All review findings are considered fixed when:

- Two humans on different networks can create, join, play, trade, reconnect, and finish a match through public HTTPS/WSS.
- Online game truth is fully server-owned, including timers and command ordering.
- WebSocket auth no longer relies on long-lived query-string session tokens.
- The server rejects disallowed WebSocket origins.
- Reconnect and retry cannot duplicate or silently lose accepted commands.
- Persisted replay logs validate sequence continuity and can hydrate through snapshots.
- Public lobbies support human-human invite flow without premature bot-fill start.
- Runtime, REST, and WebSocket handshakes reject incompatible protocol/schema versions.
- The web app is split into focused hooks/components before major new UI work, but this does not block secure single-instance multiplayer.
- Local, integration, deployed-network smoke, and replay tests are green.
- Documentation describes the deployment model, security posture, timer behavior, replay migration, and scaling limits.

## Workstream 0: Baseline and Guardrails

Purpose: make future fixes easier to land and verify.

Tasks:

- Create the first git commit or otherwise establish a clean baseline so future diffs are reviewable.
- Update `README.md` package descriptions so `packages/bots`, `packages/demo-state`, and `packages/test-utils` are accurately described.
- Add this remediation plan to the docs index or README.
- Optionally add issue labels or a simple tracking table for `P0`, `P1`, `P2`, `multiplayer`, `security`, `web`, `core`, and `db`.
- Decide whether `docker-compose.prod.yml` means "local production-style" or "real public production"; rename or document it accordingly.

Acceptance criteria:

- `git status` can distinguish new work from the current baseline.
- The docs accurately describe the package split.
- The plan has an owner-facing checklist for each workstream.

Verification:

```bash
npm run lint
npm run typecheck
npm test
```

## Workstream 1: Public Multiplayer Connectivity

Purpose: make a single server reachable and usable by players on different networks.

Tasks:

- Change deployment defaults so public/server containers bind to `0.0.0.0`.
- Add startup validation for production-like mode:
  - reject localhost `WEB_ORIGIN` unless explicitly marked local
  - reject missing public API origin for web runtime config
  - warn loudly when TLS is not enabled outside localhost
- Add web runtime config:
  - serve `/config.json` or inject `window.__COLONIZT_CONFIG__`
  - include `apiBaseUrl`, `wsBaseUrl`, and `environment`
  - include `protocolVersion` and supported `schemaVersion`
  - keep `VITE_API_BASE_URL` as a local fallback only
- Replace string-based WebSocket URL construction with `new URL()`-based construction.
- Add protocol/version negotiation:
  - runtime config advertises client/server protocol version
  - REST and WebSocket handshakes reject incompatible clients with a clear code
  - UI shows a version-mismatch recovery message
- Add a player-facing join flow:
  - pre-game `Join Match` action
  - room code input
  - invite link copy
  - invite URL opens the app, creates/resumes a session, and joins the room
  - spectator join remains explicit
- Protect invite codes:
  - generate non-enumerable room codes with enough entropy for public links
  - rate-limit direct room-code join attempts
  - return clear errors for invalid, private, full, started, and finished rooms
- Fix the human-human lobby path:
  - player-match rooms should not force `botFill: true`
  - host should not auto-ready before inviting others unless they explicitly choose bot match
  - bot fill should be delayed until the host chooses `Fill Bots` or the room mode is explicitly bot match
  - game start should require all seated humans to be ready
- Define room visibility:
  - invite/private rooms should not be exposed by default through `GET /rooms`
  - public lobby listing should be separate from direct room-code join
- Add a clear online status indicator for connecting, joined lobby, ready, reconnecting, and failed auth.

Acceptance criteria:

- Host can create an online room and copy an invite link.
- A second browser on a different network can join by link.
- Both players can ready up and see the same server snapshot.
- Public URL config works without rebuilding the web app.
- Invited human players can join before bots fill empty seats.
- Private invite rooms do not appear in public room lists.
- Invite codes are not practically enumerable and join attempts are rate-limited.
- Invalid/private/full/started/finished room joins produce clear user-facing outcomes.
- Incompatible protocol clients receive a clear version error.

Tests:

- Web component test for join form and invite link parsing.
- Server route test for runtime config.
- Playwright flow with two browser contexts joining the same room.
- Lobby test proving player-match rooms do not auto-ready or auto-fill bots.
- Room visibility test for public list vs direct invite join.
- Invite-code entropy and brute-force rate-limit tests.
- Invalid/private/full/started/finished room join tests.
- Protocol mismatch test for REST/runtime config and WebSocket handshake.
- Deployed smoke test against configurable public HTTP/WSS URLs.

## Workstream 2: WebSocket Security and Session Hardening

Purpose: make public WebSocket traffic safe enough for real internet exposure.

Tasks:

- Add explicit `/ws` origin checks using the same allow-list as REST CORS.
- Decide and implement missing-origin policy:
  - allow missing `Origin` only in local/test mode or for explicitly trusted non-browser clients
  - reject missing `Origin` in production-like public mode
- Add reverse-proxy/trust-proxy support:
  - forwarded proto/host handling
  - public WSS URL generation
  - secure cookie behavior if cookie auth is selected
  - TLS-required validation behind a proxy
- If cookie-backed auth is chosen, define and test CSRF protection for state-changing REST routes.
- Hash, expire, and revoke sessions before introducing WebSocket tickets.
- Replace long-lived `sessionToken` query param with one of:
  - preferred: short-lived one-time WebSocket ticket from `POST /ws-ticket`
  - acceptable: Secure SameSite cookie-backed session for same-site deployment
  - fallback: WebSocket subprotocol token with short expiry
- Make the ticket/routing shape explicit:
  - include intended room id or join intent in the ticket when possible
  - support future room-aware sticky routing
  - otherwise document that owner forwarding is required before horizontal scaling
- Store only hashed session tokens and hashed WebSocket tickets at rest.
- Add token expiry, ticket expiry, and ticket one-time-use semantics.
- Update `last_seen_at` on authenticated REST and WebSocket activity.
- Add session revocation support and enforce it in REST and WebSocket paths.
- Scrub tokens/tickets from logs, errors, analytics, and URLs.
- Add per-session and per-IP rate limits in addition to per-socket limits.
- Add server-side heartbeat:
  - server pings clients
  - closes sockets that do not pong within a grace window
  - cleans presence on stale close
- Define seat connection-state behavior:
  - socket close marks the seated player disconnected but preserves the seat
  - heartbeat timeout follows the same path as socket close
  - reconnect restores connected state for the same session
  - stale presence cleanup cannot remove ownership of an occupied seat

Acceptance criteria:

- A raw WebSocket from a disallowed origin is rejected.
- Missing-origin WebSockets follow the documented local/prod policy.
- Expired/reused tickets cannot connect.
- Concurrent attempts to consume the same one-time ticket allow at most one connection.
- Session tokens are not present in DB rows in plaintext.
- Reconnecting clients use a fresh ticket.
- Public WSS URLs are generated correctly behind the configured proxy.
- Stale sockets are closed by the server without waiting on client-side close.
- Seat connection state updates on close, heartbeat timeout, reconnect, and stale presence cleanup without losing the seat.

Tests:

- WebSocket allowed-origin acceptance.
- WebSocket origin rejection.
- Missing-origin WebSocket policy.
- Query-token WebSocket rejection in v2 protocol.
- Ticket issue/connect/reuse/expiry.
- Concurrent one-time ticket consumption.
- Revoked session rejection for REST and WS.
- CSRF tests for state-changing REST routes if cookie auth is selected.
- Token hashing migration and no-plaintext assertion.
- Heartbeat closes a simulated dead socket.
- Seat remains occupied but disconnected after close/heartbeat timeout, then reconnects.
- Rate limits persist across reconnects for the same session.

## Workstream 3: Online Command Acknowledgement and Reconnect

Purpose: make bad networks survivable without corrupting gameplay.

Tasks:

- Add server command acknowledgements that include:
  - `clientSeq`
  - accepted server event sequence range
  - command hash
  - rejection code when rejected
- Define rejected-command `clientSeq` semantics:
  - whether rejected commands consume the client sequence
  - whether rejection ACKs are durable
  - how the client retries or advances if a rejection ACK is lost
- Persist command idempotency in the same slice as command acknowledgements:
  - table: `(room_id, match_id, user_id, client_seq, command_hash, seq_start, seq_end, created_at)`
  - duplicate same hash returns original event range
  - duplicate different hash rejects as `CLIENT_SEQ_CONFLICT`
- Canonicalize command hashes:
  - stable JSON/object-key ordering
  - include room id, match id, user id, and protocol/schema version in the hash scope
  - prevent equivalent commands from hashing differently due to key order
  - prevent cross-room, cross-match, or cross-session ambiguity
- Keep client commands pending until ACK or matching event range is seen.
- On reconnect:
  - request resync by last confirmed server seq
  - reconcile pending commands against event ranges
  - resend only commands known not to have committed
- Add exponential reconnect backoff:
  - immediate first retry
  - then jittered exponential delay
  - cap at 30 seconds
  - reset after successful open
- Clear resume state on:
  - 401/unauthorized
  - revoked session
  - room not found
  - match finished and replay loaded successfully
- Add robust WebSocket JSON parse handling in the network client so malformed server or proxy messages surface recoverable errors instead of crashing the app.
- Add user-visible reconnect state and "retry now" action.

Acceptance criteria:

- Dropping a socket after sending a command cannot duplicate the command.
- Losing only the ACK does not cause a duplicate command on retry.
- Losing the broadcast does not hide a committed command after resync.
- A committed command is visible after reconnect even if the client missed the broadcast.
- Browser reload with pending commands reconciles before allowing new commands.
- Server restart after commit preserves idempotency behavior.
- Rejected-command retry behavior follows the documented `clientSeq` semantics.
- Canonical command hashes are stable across object key order and scoped to room/match/user/version.
- Malformed WebSocket messages do not crash the app.
- The client does not spam reconnects during outages.
- Stale resume data cannot trap the UI in an endless reconnect loop.

Tests:

- Server idempotency for duplicate same command.
- Server rejection for same `clientSeq` with different command.
- Rejected command with lost rejection ACK.
- Command hash canonicalization and scope tests.
- Client `lastSeq` ahead of server returns a clear resync error or snapshot policy.
- ACK lost after accepted command.
- Broadcast missed after accepted command.
- Socket closed immediately after send.
- Browser reload with pending commands.
- Server restart after committed command.
- Web reconnect after command send before broadcast.
- Web reconnect after missed event gap.
- Backoff timing unit test with fake timers.
- Resume-state clearing tests for auth and room errors.
- Network client malformed JSON message test.

## Workstream 4: Server-Owned Timers and Staged Trade Deadlines

Purpose: ensure online games behave consistently regardless of client clocks.

Tasks:

- Move online phase timer truth into server state:
  - `WAITING_FOR_ROLL`: 60 seconds
  - `ACTION_PHASE`: 4 minutes
  - setup placement: choose and document an explicit setup timer policy
- Store timer metadata:
  - active phase key
  - deadline timestamp
  - duration
  - server time issued
- Broadcast timer metadata in viewer snapshots.
- Make local UI timers display server deadlines for network games.
- Persist or intentionally close timer state on restart:
  - recommended: persist deadlines for phase timers
  - recommended: persist staged trade response deadline or close stale trade with `RESPONSE_TIMEOUT` during hydration
- Clarify trade response deadline policy:
  - response window remains 15 seconds
  - expired staged offers close without trading
  - restart must not grant indefinite extra time
- Ensure modal staged trades block offerer actions on server and UI.

Acceptance criteria:

- Online roll timeout auto-rolls on the server after 60 seconds.
- Online post-roll timeout ends the turn on the server after 4 minutes.
- Setup placement timeout follows the documented server policy.
- Trade response overlays expire according to server time.
- Refreshing or reconnecting a browser does not reset the timer.
- Duplicate `expireTurn` attempts cannot emit duplicate timeout actions.
- Restart behavior is deterministic and documented.

Tests:

- Server roll timeout.
- Server action timeout.
- Server modal trade timeout then end-turn behavior.
- Server duplicate timeout suppression.
- Server modal trade blocking for non-finalize/non-cancel commands.
- UI modal trade blocking for hidden/disabled actions.
- Hydration of phase deadline.
- Hydration of staged trade deadline or deterministic close.
- Web displays server timer rather than local regenerated timer.

## Workstream 5: Replay, Migration, and Snapshot Reliability

Purpose: make persisted match truth robust enough for long games and restarts.

Tasks:

- Validate replay event sequence continuity:
  - duplicate seq rejects
  - missing seq rejects
  - seq starts at 1
  - event `schemaVersion` is supported or migrated
- Clarify v1/v2 migration:
  - v1 full event logs keep immediate trade semantics
  - unfinished v1 `OPEN` trades normalize to `CLOSED` with `MIGRATED`
  - v2 `COLLECTING_RESPONSES` trades follow the chosen deadline policy
- Rename or document `closeExpiredTrades` as legacy TTL trade closure.
- Validate stored event payloads before applying them during import/hydration.
- During DB hydration/import, verify row metadata matches payload:
  - row `seq` equals payload `seq`
  - row `event_type` equals payload `type`
  - mismatches fail closed before replay
- Add authoritative snapshot safety rules:
  - full-state snapshots are server-only and never sent directly through viewer APIs
  - snapshot `seq` must equal the stored state `eventSeq`
  - snapshot schema/version is validated before hydration
  - optional checksum guards config, board, state, and tail-event compatibility
- Write snapshots to `match_snapshots`:
  - every N events, for example 25
  - on match finish
- Hydrate from latest snapshot plus tail events.
- Do not trust snapshot hydration until replay sequence validation is in place.
- Add a snapshot compatibility test for old event logs.

Acceptance criteria:

- Corrupt event logs fail loudly instead of silently replaying partial truth.
- Long games hydrate from snapshots.
- Replay docs match code behavior.
- v1 and v2 trade migration behavior is deterministic.
- Viewer/spectator APIs never expose authoritative full-state snapshot data.
- Snapshot seq/schema/checksum mismatches fail closed.
- DB row/payload seq and type mismatches fail closed.

Tests:

- Invalid event payload shape failure.
- Persisted row `seq` vs payload `seq` mismatch failure.
- Persisted row `event_type` vs payload `type` mismatch failure.
- Duplicate seq replay failure.
- Missing seq replay failure.
- Non-1 starting seq replay failure.
- Unsupported schema failure.
- v1 full event-log trade semantics remain valid.
- v1 open trade migration.
- v2 collecting trade hydration policy.
- Snapshot seq mismatch failure.
- Snapshot schema/checksum mismatch failure.
- Snapshot plus tail replay equals full replay.
- Spectator redaction after snapshot hydration.

## Workstream 6: Database Scalability and Data Safety

Purpose: make persistence ready for public load and operational recovery.

Tasks:

- Hash session tokens and WebSocket tickets with a server secret or slow hash strategy appropriate for token lookup.
- Add command idempotency table.
- Add snapshot write/read helpers.
- Batch event insertions where possible.
- Avoid N+1 loading in `listPersistedRooms`.
- Add targeted indexes:
  - command idempotency lookup
  - active rooms by status and updated time
  - snapshots by match and seq descending
- Add `updated_at` to rooms if needed for hydration ordering.
- Add cleanup jobs:
  - expired tickets
  - expired sessions
  - old analytics beyond retention
- Document backup/restore expectations for event logs and snapshots.

Acceptance criteria:

- Hydration queries stay bounded for recent rooms.
- Token and ticket secrets are not stored plaintext.
- Event append remains atomic.
- Snapshot recovery works after server restart.

Tests:

- Migration up on empty DB.
- Migration up on existing DB with sessions.
- Hashed session lookup.
- Event batch insert rollback on duplicate seq.
- Snapshot read newest.
- Room list query returns expected records without per-room event scans where avoidable.

## Workstream 7: Bot and Trade Consistency

Purpose: keep bot decisions fair and consistent between local and network play. This is important, but it is not a blocker for secure human-human public multiplayer.

Tasks:

- Extract shared bot trade resolution helper used by server and local web.
- Align responder selection scoring:
  - offerer utility gain
  - responder win/score risk penalty
  - deterministic tie-break by `playerOrder`
- Prefer `applyCommand`-based simulations over manual state mutation for bot utility where feasible.
- Centralize setup-placement scoring if it remains shared.
- Add bot difficulty regression scenarios.
- Keep per-turn trade temperament deterministic and documented.

Acceptance criteria:

- The same state and seed produce the same bot trade choice locally and on the server.
- Bots do not use hidden resource counts.
- Higher difficulty is measurably less willing to accept unfavorable trades.
- Bot-bot staged trade finalizes through the same response/finalize flow as human trades.

Tests:

- Local/server bot trade parity.
- Multiple willing responders with deterministic tie-break.
- Easy/medium/hard trade threshold scenarios.
- Hidden-hand invariance.
- Bot-bot staged trade full flow.

## Workstream 8: Web App Decomposition and UX Tightening

Purpose: reduce fragility in the UI while preserving current gameplay improvements. Treat this as P2 cleanup for public multiplayer unless the networking changes become unmanageable inside the current file.

Tasks:

- Split `packages/web/src/App.tsx` into:
  - `useLocalGame`
  - `useNetworkRoom`
  - `useTurnTimers`
  - `useTradeOverlay`
  - `useSoundEffects`
  - `BoardView`
  - `ActionDock`
  - `Sidebar`
  - `MatchMenu`
  - `TradeOverlay`
- Keep `ViewerState` projection separate from authoritative `GameState`.
- Move resource/trade controls into reusable components.
- Keep keyboard shortcuts desktop-only and documented in accessible labels, not visible clutter.
- Improve online error handling:
  - connection failed
  - auth expired
  - room full
  - room not found
  - version mismatch
- Add visual states for pending command, reconnecting, and stale/offline.
- Keep low-cost visuals:
  - SVG board and pieces
  - CSS gradients/patterns
  - no heavy canvas/3D runtime unless needed later

Acceptance criteria:

- No single web file owns unrelated networking, board, trade, replay, timer, and layout concerns.
- Network errors do not crash the app.
- The UI clearly shows whose turn it is, whether the client is online, and whether a command is pending.
- Existing visual polish remains intact.

Tests:

- Component tests for hooks with fake network client.
- Network JSON parse failure test.
- Pending command UI test.
- Reconnect state UI test.
- Mobile viewport test for join flow and action dock.
- Existing trade and board tests remain green.

## Workstream 9: True Network Smoke and Load Testing

Purpose: verify the exact path real players use.

Tasks:

- Keep existing `smoke:network` as local in-process smoke.
- Add `smoke:deployed-network` with parameters:
  - `--base-url`
  - `--ws-url`
  - `--web-origin`
  - `--join-second-player`
  - `--simulate-reconnect`
- Scaffold the deployed smoke harness once runtime config exists, but require the first passing deployed smoke gate only after session hardening and WebSocket auth are in place.
- Add deployed web-origin browser validation:
  - public web URL loads the static app
  - runtime config fetch succeeds from the deployed origin
  - host can create and copy an invite link through the deployed UI
  - second browser context can open that real invite URL and join through the deployed origin
- Rename `load-sockets.ts` if it remains pure simulation, or replace it with a real WebSocket load script.
- Add true socket load:
  - many rooms
  - multiple players per room
  - spectators
  - chat bursts
  - reconnect churn
  - staged trade flows
- Add reverse proxy smoke using HTTPS/WSS locally or in CI if feasible.
- Track metrics:
  - command queue wait
  - DB append latency
  - broadcast latency
  - reconnect recovery time
  - socket count
  - dropped sockets
  - event-loop lag

Acceptance criteria:

- A deployed environment can be validated by one command.
- Load script opens real sockets, not just local bot simulations.
- Reconnect and staged trade paths are covered by smoke.
- At least one smoke run validates public DNS, HTTPS, and WSS from outside the host/network path.
- A browser-level deployed-origin smoke validates static web loading, runtime config, invite-link routing, and joining through the real public web URL.

Tests:

- CI can run local smoke.
- Manual or scheduled environment can run deployed smoke.
- Manual or scheduled environment can run deployed web-origin browser smoke.
- Load script has threshold assertions for p95 command latency and reconnect recovery.

## Workstream 10: Horizontal Scaling Readiness

Purpose: prepare for multi-instance multiplayer without room divergence.

Prerequisite:

- Workstreams 1 through 6 must be done first.
- The WebSocket ticket/routing shape from Workstream 2 must already account for room-aware routing or owner forwarding.

Tasks:

- Choose one active room ownership model:
  - near-term: sticky sessions by room
  - stronger: Postgres advisory lock or leases table per room
- Ensure only the room owner runs:
  - command processing
  - timers
  - bot automation
  - staged trade deadline closure
- Add cross-node event fanout:
  - Redis pub/sub or Postgres notify
  - per-viewer redaction still happens before socket send
  - monotonic seq checks before broadcast
- Include every live room payload in the cross-node delivery story:
  - game events
  - `ROOM_STATE`
  - lobby ready/seat changes
  - chat
  - presence/connected status
  - timer metadata
- Add owner failover:
  - detect owner death
  - acquire lease
  - hydrate from latest snapshot plus tail
  - resume timers according to persisted deadline policy
- Add routing docs for the chosen deployment platform.

Acceptance criteria:

- Two server instances cannot process commands for the same room at once.
- Clients connected to different instances for the same room receive the same event stream.
- Clients connected to different instances also receive consistent lobby, chat, presence, and timer updates.
- Owner failover does not duplicate timer actions.

Tests:

- Simulated two-manager ownership conflict.
- Stale lease fencing.
- Pub/sub fanout event ordering.
- Per-viewer redaction on cross-node fanout.
- Cross-node lobby state, chat, presence, and timer fanout.
- Owner failover hydration.
- Timer failover no-duplicate action.
- Cross-node reconnect to a different instance.

## Workstream 11: Documentation Completion

Purpose: make the implementation understandable and operable.

Tasks:

- Update `docs/deployment.md` with:
  - public HTTPS/WSS setup
  - required env vars
  - reverse proxy notes
  - single-instance limitation
  - sticky-session or room-owner strategy
- Update `docs/api.md` with:
  - runtime config
  - WebSocket ticket flow
  - command ACKs
  - reconnect/resync semantics
- Update `docs/replay-format.md` with:
  - sequence validation
  - schema v1/v2 migration
  - snapshot format
  - staged trade deadline policy
- Update `docs/testing.md` with:
  - deployed smoke
  - true socket load
  - reconnect chaos tests
- Update `docs/bot-trade-and-rules.md` with:
  - shared bot trade resolution
  - difficulty behavior
  - deterministic temperament
- Add a short "Public Multiplayer Runbook" for diagnosing:
  - cannot connect
  - origin rejected
  - stale resume
  - command duplicate
  - room ownership conflict

Acceptance criteria:

- Docs describe current code, not planned behavior.
- A developer can deploy one public instance by following docs.
- A developer can explain the scaling boundary and why it exists.

## Final Verification Gate

Run this before declaring the remediation complete:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:property
npm run test:integration
npm --workspace @colonizt/web run test
npm run test:e2e
npm run smoke:network
npm run smoke:local
npm run replay:fixtures
npm run build
npm run smoke:deployed-network -- --base-url "$PUBLIC_API_URL" --ws-url "$PUBLIC_WS_URL" --web-origin "$PUBLIC_WEB_ORIGIN" --join-second-player --simulate-reconnect
```

For horizontal scaling readiness, add a separate multi-instance smoke gate after Workstream 10.

## Suggested Execution Slices

Use these as PR-sized chunks:

1. Docs/package cleanup and baseline.
2. Runtime web config plus public bind/startup validation.
3. Join-room/invite UX.
4. Initial deployed-network smoke harness scaffolding.
5. Session hashing/revocation/expiry and REST/session rate limits.
6. WebSocket origin checks, reverse-proxy trust, room-aware WS ticket shape, and ticket auth.
7. First required passing deployed API/WSS and deployed web-origin browser smoke.
8. Command ACK protocol plus persisted idempotency.
9. Reconnect backoff and pending-command reconciliation.
10. Server-owned phase timers.
11. Staged trade deadline persistence/hydration policy.
12. Replay validation and migration clarity.
13. Snapshot persistence and hydration.
14. Expand deployed smoke for reconnect, timers, and staged trades.
15. Bot trade parity extraction.
16. Web app decomposition.
17. True socket load test.
18. Horizontal room ownership and fanout.

The safest first implementation batch is slices 1 through 7. That gets real cross-network players into one secure room with a usable invite path, production-shaped WebSocket handshake, and a real deployed browser/API/WSS smoke gate, without yet taking on restart recovery or horizontal scaling complexity.
