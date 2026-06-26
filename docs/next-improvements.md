# Next Improvements

Reviewed on 2026-06-26.

This document tracks the remaining engineering pass from the current production-shaped codebase. It intentionally avoids already-completed work such as room-code joins, lobby Go, due-work scheduling, room-indexed WebSocket broadcast, replay validation, snapshot hydration, visible mobile UI hardening, viewer-safe projection extraction, stored room validation, gate alignment, and admin room-health reporting.

## Current Baseline

- `packages/game-core` is deterministic and event-sourced. It owns board presets, rules, serialization, replay validation, hidden victory-point accounting, bank supply constraints, discard/robber flow, and command legality.
- `packages/protocol` owns shared REST/WebSocket schemas, room settings, lobby readiness helpers, and public payload types.
- `packages/server` is the single-node authoritative runtime for rooms, seats, commands, timers, bots, chat, reports, snapshots, and persistence.
- `packages/web` supports local bot games, online lobby/gameplay, post-game replay, hand-rack development cards, board-first interaction, trade/discard/robber overlays, and responsive HUD layouts.
- PostgreSQL is durable truth for sessions, rooms, matches, events, command results, snapshots, chat, reports, and analytics. Redis remains optional ephemeral presence only.

## Priority Map

| Priority | Theme | Why now |
| --- | --- | --- |
| P0 | Module boundaries | `App.tsx`, `RoomManager`, server bootstrap, and `engine.ts` are still large enough to slow future fixes. |
| P1 | Operator diagnostics depth | Room-health exists, but snapshot hydration outcomes, validation failures, automation stalls, and command conflicts need richer metrics and runbook output. |
| P2 | Horizontal scale readiness | The current supported mode is single-node authority. Multi-node requires room-owner routing or sticky sessions before Redis can help beyond presence. |

## Completed In This Pass

- `packages/web/src/viewer-projection.ts` owns viewer-safe online payload projection for UI rendering.
- Projection tests prove own resources remain usable, opponent resources remain redacted, and hidden opponent resource counts can update from redacted events.
- `packages/server/src/room-runtime.ts` owns shared liveness, connected-user counts, active-room checks, and timer keys.
- `packages/server/src/store-validation.ts` validates hydrated room metadata, timers, replay/snapshot tails, and command-result event ranges before runtime use.
- `/admin/rooms/health` exposes admin-gated, hand-safe room lifecycle diagnostics for active rooms.
- CI and `scripts/verify-local.sh` now include diagram validation, desktop/mobile Playwright, websocket load, and the existing bot gates in the documented tiers.

## 1. Module Boundary Refactor

### Risk

Large files make small behavioral changes harder to prove:

- `packages/web/src/App.tsx` still owns screen state, network session handling, board interaction, trade/discard/special-card modes, local automation wiring, replay, and most selectors.
- `packages/server/src/room-manager.ts` still owns room lifecycle, seats, settings, commands, automation, replay, chat, reports, and hydration.
- `packages/server/src/index.ts` still mixes HTTP routes, WebSocket handling, ticket/session setup, rate limiting, broadcasting, metrics, and shutdown.
- `packages/game-core/src/engine.ts` still contains most reducer logic.

### Direction

- Extract pure helpers before moving stateful hooks.
- Web: move selectors to `game-view-model`, and then split `BoardView`, `ActionDock`, `HandRack`, `InfoSidebar`, `TradeOverlay`, `RobberOverlay`, and `PostGameOverlay`.
- Server: split lobby/seats/settings, command commit/idempotency, replay hydration, automation driver, cleanup/liveness, and chat/report/analytics.
- Transport: split REST routes, WebSocket message handlers, socket registry, runtime config, and rate limits.
- Engine: split command reducers by setup, dice/production, building, development cards, trade, turn, and invariants.

### Acceptance Criteria

- Refactors are behavior-preserving and covered by existing tests.
- Public wire payloads remain additive/backward-compatible.
- New modules have small, focused exports rather than moving a god object into a new file.

## 2. Operator Diagnostics Depth

### Risk

The server has room liveness, pause reasons, cleanup reasons, metrics, and an admin room-health report, but deeper debugging still requires piecing snapshot hydration, validation, command conflict, and automation details together from code or logs.

### Direction

- Add counters for snapshot hydration success/fallback/failure, command-result conflicts, malformed stored records, automation budget pauses, and stalled rooms.
- Add a CLI/runbook view that combines room-health output with recent metrics and store-validation failures.
- Add optional structured sampling for command conflict payload metadata without recording hidden hands.

### Acceptance Criteria

- Metrics identify whether failures come from transport, command rejection, event-store validation, automation, or room lifecycle.
- Room-health plus metrics can be pasted into an incident note without exposing hidden player hands.

## 3. Horizontal Scale Readiness

### Risk

The current deployment model is explicit single-node authority. Room ownership leases exist, but active socket routing and command fanout are still process-local.

### Direction

- Keep single-node as the supported production mode until room routing exists.
- Before multi-node, add sticky sessions or room-owner forwarding.
- Ensure WebSocket tickets carry enough room intent to route or reject early.
- Keep Redis limited to presence unless it becomes a deliberate pub/sub adapter.

### Acceptance Criteria

- Deployment docs continue to state the single-node authority boundary.
- Multi-node work has a separate design with routing, ownership, fanout, and failure-mode tests.
