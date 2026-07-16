# Next Improvements

Reviewed and implemented on 2026-07-15.

This document records the completed engineering pass from the production-shaped codebase. It intentionally avoids earlier work such as room-code joins, lobby Go, due-work scheduling, room-indexed WebSocket broadcast, replay validation, snapshot hydration, visible mobile UI hardening, viewer-safe projection extraction, stored room validation, gate alignment, and admin room-health reporting.

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

## Implementation Plan

The work was implemented in dependency order so refactors did not outrun their safety evidence:

1. **Test-strength baseline**
   - Raise the measured coverage gate to at least 95% statements/lines/functions and 85% branches with behavioral tests around persistence failures, transport rejection, reconnect/resync, replay validation, and UI interaction modes.
   - Classify every surviving mutation as a missing assertion or redundant implementation, remove redundant code, and require at least a 95% mutation score.
2. **Web orchestration and accessibility**
   - Extract pure game-view selectors, discard/robber policy, replay policy, and screen/session state from `App.tsx` before moving stateful hooks.
   - Add automated accessibility coverage for setup, lobby, active game, dialogs, game over, and replay, including keyboard interaction and focus restoration.
3. **Server application boundaries**
   - Split REST registration, socket registry/broadcast, runtime configuration, and process lifecycle out of server composition.
   - Split seat/settings, command commit, and moderation/analytics policy from `RoomManager` while retaining it as the authoritative room and persistence facade.
4. **Game reducer boundaries**
   - Extract cohesive setup, production, building, development-card, trade, and turn reducer helpers while retaining one public command dispatcher and invariant validator.
5. **Operations and resilience**
   - Measure hydration outcomes, invalid stored records, command-result conflicts, automation budget pauses, and stalled rooms without exposing private hands.
   - Add a diagnostic CLI plus failure tests for database write loss, optional Redis loss, restart/resync, reconnect storms, and graceful shutdown.
   - Store machine-readable nightly mutation and WebSocket-soak artifacts.
6. **Supply chain and scaling contract**
   - Pin workflow actions to immutable revisions and add dependency-review/SBOM or container-vulnerability evidence where applicable.
   - Record the multi-node ownership/routing/fanout decision in an ADR; keep `INSTANCE_MODE=single` enforced until that design has multi-instance proof.
7. **Completion audit**
   - Run lint, typecheck, coverage, mutation, PostgreSQL integration, bot/property/replay, desktop/mobile/multiplayer Playwright, socket load/soak, dependency audit, build, and documentation checks.
   - Treat skipped PostgreSQL tests, unexplained mutation survivors, inaccessible critical flows, or unverified acceptance criteria as incomplete.

Public REST/WebSocket payloads and replay formats remain compatible throughout. Refactors must keep dependencies directed from transports and UI adapters toward the existing protocol and deterministic game core.

## Completed In This Pass

- `packages/web/src/viewer-projection.ts` owns viewer-safe online payload projection for UI rendering.
- Projection tests prove own resources remain usable, opponent resources remain redacted, and hidden opponent resource counts can update from redacted events.
- `packages/server/src/room-runtime.ts` owns shared liveness, connected-user counts, active-room checks, and timer keys.
- `packages/server/src/store-validation.ts` validates hydrated room metadata, timers, replay/snapshot tails, and command-result event ranges before runtime use.
- `/admin/rooms/health` exposes admin-gated, hand-safe room lifecycle diagnostics for active rooms.
- CI and `scripts/verify-local.sh` now include diagram validation, desktop/mobile Playwright, websocket load, and the existing bot gates in the documented tiers.
- CI and SonarCloud now run the PostgreSQL persistence suite instead of silently skipping it, and CI fails fast if its database URL is missing.
- `App.tsx` delegates board interaction policy, network error presentation, trade/special-card overlays, and match analysis to focused modules with direct scenario tests.
- `RoomManager` retains authority while command idempotency, lifecycle policy, and bot automation are isolated behind focused modules; WebSocket frame dispatch is separated from server composition.
- A real local two-browser Playwright gate covers create/join/ready/start/setup/reload/reconnect/resync, including the StrictMode invite-join regression it exposed.
- The WebSocket soak enforces concurrency, p95/p99 latency, heap-growth, and reconnect-success thresholds.
- Coverage now gates statements at 95%, lines/functions at 95.5%, and branches at 85%; the measured pass is 95.18% statements, 98.02% lines, 97.73% functions, and 85.27% branches. Nightly mutation testing kills all 443 mutants across replay, invariants, lifecycle, and idempotency with no survivors or uncovered mutants.
- CodeQL, Dependabot, and dependency audits cover static and supply-chain security checks.
- [ADR 0001](adr/0001-room-authority-and-horizontal-routing.md) keeps single-node room authority explicit and defines the room-aware routing, fencing, fanout, failover, and multi-process proof required before horizontal execution.
- `App.tsx` now delegates game guidance, view selection, discard policy, replay control, accessible dialogs, and overlay rendering to focused tested modules.
- Server bootstrap delegates runtime parsing, rate limits, HTTP routes, WebSocket tickets, socket registry, transport dispatch, and graceful shutdown; `RoomManager` delegates command commit, content creation, lifecycle, idempotency, automation, and diagnostics facets.
- Game event application is split into setup, production/discard/thief, building, development-card, trade, and turn reducers behind the existing public dispatcher. The invariant validator and shared game limits are dedicated modules, allowing mutation testing to target the complete validator without brittle source-line ranges.
- Hydration/store/conflict/automation metrics, a hand-safe diagnostic CLI, optional-Redis fallback, snapshot replay fallback, graceful socket drain, and JSON nightly soak artifacts are implemented and tested.
- Every third-party workflow action is pinned to an immutable commit; pull requests receive dependency review and CI uploads a CycloneDX production dependency SBOM.

## Completion Evidence

### Module boundaries

- Web view selection, guidance, discard policy, replay control, dialogs, overlays, and analysis are isolated behind focused exports and direct behavioral tests.
- Server composition delegates HTTP routes, runtime parsing, tickets, rate limits, sockets, transport, and process lifecycle. `RoomManager` retains room authority while delegating command commits, content, diagnostics, lifecycle, idempotency, and bot automation.
- Game event reduction is separated by domain, and the invariant validator plus public game limits no longer depend on engine source-line positions.
- Public protocol payloads and replay formats remain unchanged; the full replay, network, browser, and PostgreSQL gates pass.

### Operator diagnostics

- Hydration success/fallback/failure, invalid stored data, command conflicts, automation pauses, and stalled rooms have hand-safe counters and logs.
- `COLONIZT_ADMIN_URL=https://… ADMIN_TOKEN=… npm run ops:diagnose` combines room-health and metrics into a pasteable, hand-safe incident snapshot.
- Failure tests cover malformed snapshots, full-log fallback, persistence conflicts, Redis loss, graceful shutdown failure, reconnect/resync, and socket drain.

### Horizontal-scale contract

- Single-node authority remains enforced because process-local sockets cannot safely provide multi-node command routing or fanout.
- [ADR 0001](adr/0001-room-authority-and-horizontal-routing.md) specifies the required room-aware tickets, fenced ownership, forwarding, fanout, failover behavior, observability, and multi-process acceptance tests.
- Enabling horizontal execution is intentionally blocked until that ADR is implemented and proven; optional Redis remains an ephemeral presence adapter, not an implied distributed-room solution.
