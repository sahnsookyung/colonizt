# Testing Strategy

- Unit tests cover pure engine commands, phases, resource payments, scoring, and serializers.
- Property tests generate random legal games and assert invariants.
- Replay fixture tests rebuild known games from event logs.
- Integration tests cover WebSocket ticket auth, origin checks, sequencing, resync, idempotency, hidden-information safety, command ordering, match history, and restart hydration through the event-store interface.
- Protocol tests verify that shared `@colonizt/protocol` schemas accept current client/server message fixtures and reject invalid payloads before game-core sees them.
- Scheduler and observability tests cover room automation ticks, cleanup callbacks, structured logs, metrics rendering, and the enforced single-node instance mode.
- Postgres integration tests are opt-in through `COLONIZT_TEST_DATABASE_URL`; they persist sessions, rooms, matches, events, command results, replay data, chat, reports, analytics, and cleanup state against a real database.
- Privacy tests verify that live spectator event payloads and snapshots do not expose opponent resource details.
- E2E tests cover local bot game play and mobile viewport interactions.
- Load scripts exercise sockets, spectators, chat bursts, and command latency; multi-worker Redis fanout remains a future stress target.
- `npm run smoke:network` starts a real HTTP/WebSocket server, creates four human sessions, opens one-use WebSocket tickets, joins all clients into a non-bot CLASSIC room, readies all four clients, submits a setup command, verifies matching event sequences across the full table, reconnects with a fresh ticket, and verifies `RESYNC`.
- `npm run smoke:deployed-network` runs the same public API/WSS flow against a deployment. It requires `PUBLIC_API_URL=https://...`, `PUBLIC_WS_URL=wss://...`, `PUBLIC_WEB_ORIGIN=https://...`, and optional `SMOKE_TIMEOUT_MS`. It fails if any public URL points at localhost, loopback, or private-network hosts.
- `npm run smoke:deployed-browser` runs Playwright against `PUBLIC_WEB_URL` without starting Vite. The browser smoke creates a player match through the UI, joins the invite query from three additional browser contexts, readies all four clients, performs setup, reloads, and verifies reconnect state.
- `npm run smoke:cross-network` runs the deployed network and browser smokes. This is a release gate only when executed from two independent network egresses, such as separate CI runners or one local machine plus a remote runner. Two local browser contexts are a regression aid, not proof of cross-network connectivity.
- `REDIS_URL=redis://127.0.0.1:6389 npm run smoke:network` exercises the Redis-backed ephemeral presence adapter.
- `npm run smoke:local` runs migrations when `DATABASE_URL` is set, creates a bot-filled match, submits a command, starts a fresh manager, hydrates persisted rooms, and reconstructs replay from stored events.
- `npm run docs:diagrams` validates Mermaid blocks in `docs/architecture.md` and is part of `npm run verify:local`.
- `npm run simulate:ranked` verifies queue grouping, abandonment, match quality, and duplicate-ticket prevention.
- `npm run simulate:rush` verifies first-valid-wins conflict resolution for simultaneous commands.

## Multiplayer Release Gates

- PR gate: `npm run docs:diagrams`, `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:property`, `npm run test:integration`, `npm --workspace @colonizt/web run test`, and `npm run smoke:network`.
- Pre-deploy gate: `npm run build`, `npm run test:e2e -- --project=chromium`, replay fixtures, and migration smoke.
- Post-deploy gate: `npm run smoke:deployed-network` and `npm run smoke:deployed-browser` with production public URLs.
- Nightly/release gate: run `npm run smoke:cross-network` from distinct network egresses and record the logs. A pass requires all four human clients to observe the same canonical event sequence after reconnect.
