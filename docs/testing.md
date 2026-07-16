# Testing Strategy

- Unit tests cover pure engine commands, phases, resource payments, scoring, and serializers.
- Property tests generate random legal games and assert invariants.
- Replay fixture tests rebuild known games from event logs.
- Integration tests cover WebSocket ticket auth, origin checks, sequencing, resync, idempotency, hidden-information safety, command ordering, match history, and restart hydration through the event-store interface.
- Protocol tests verify that shared `@colonizt/protocol` schemas accept current client/server message fixtures and reject invalid payloads before game-core sees them.
- Scheduler and observability tests cover room automation ticks, cleanup callbacks, structured logs, metrics rendering, and the enforced single-node instance mode.
- Postgres integration tests run whenever `COLONIZT_TEST_DATABASE_URL` is set and fail fast if CI omits it; CI and SonarCloud provide a real PostgreSQL service. Local runs may leave it unset when intentionally testing only the in-memory adapter.
- Privacy tests verify that live spectator event payloads and snapshots do not expose opponent resource details.
- E2E tests cover local bot game play, mobile viewport interactions, automated axe checks for setup and active-game surfaces, and a real two-browser server journey through create/join/ready/start/setup/reload/reconnect/resync via `npm run test:multiplayer`. Dialog unit tests cover focus entry, Escape dismissal, and focus restoration.
- Load scripts exercise concurrent rooms, players, spectators, chat, reconnect/resync, operation p95/p99, peak sockets, reconnect success, and heap growth. `npm run load:sockets:soak` enforces the nightly thresholds and uploads a machine-readable `reports/load/soak.json` artifact containing measurements, thresholds, and failure reasons; multi-worker Redis fanout remains a future stress target.
- `npm run test:coverage` enforces at least 95% statement coverage, 95.5% line/function coverage, and 85% branch coverage across the measured repository surface. The threshold is backed by behavioral scenarios; the critical replay, invariant, idempotency, and lifecycle paths additionally require a 95% mutation score.
- `npm run test:mutation` targets replay validation/application, the complete game-invariant module, command idempotency, and room lifecycle policy; the nightly gate fails below a 95% mutation score. The current suite kills all 443 configured mutants with no survivors or uncovered mutants.
- `npm run smoke:network` starts a real HTTP/WebSocket server, creates two human sessions, opens one-use WebSocket tickets, joins both clients by public room code into a non-bot CLASSIC room with four available seats, readies both clients, starts from the host lobby Go path, submits a setup command, verifies matching event sequences across connected clients, reconnects with a fresh ticket, and verifies `RESYNC`.
- `npm run smoke:deployed-network` runs the same public API/WSS flow against a deployment. It requires `PUBLIC_API_URL=https://...`, `PUBLIC_WS_URL=wss://...`, `PUBLIC_WEB_ORIGIN=https://...`, and optional `SMOKE_TIMEOUT_MS`. It fails if any public URL points at localhost, loopback, or private-network hosts.
- `npm run smoke:deployed-browser` runs Playwright against `PUBLIC_WEB_URL` without starting Vite. The browser smoke creates a player match through the UI, joins the invite query from another browser context, readies both clients, starts from the host Go button, performs setup, reloads, and verifies reconnect state.
- `npm run smoke:cross-network` runs the deployed network and browser smokes. This is a release gate only when executed from two independent network egresses, such as separate CI runners or one local machine plus a remote runner. Two local browser contexts are a regression aid, not proof of cross-network connectivity.
- `REDIS_URL=redis://127.0.0.1:6389 npm run smoke:network` exercises the Redis-backed ephemeral presence adapter.
- `npm run smoke:local` runs migrations when `DATABASE_URL` is set, creates a bot-filled match, submits a command, starts a fresh manager, hydrates persisted rooms, and reconstructs replay from stored events.
- `npm run docs:diagrams` validates Mermaid syntax and readability in `docs/architecture.md` and `README.md`, and runs in CI plus `npm run verify:local`.
- `npm run simulate:ranked` verifies queue grouping, abandonment, match quality, and duplicate-ticket prevention.
- `npm run simulate:rush` verifies first-valid-wins conflict resolution for simultaneous commands.

## Multiplayer Release Gates

- PR gate: dependency audit and change review, a CycloneDX production-dependency SBOM, immutable action-reference validation, CodeQL, `npm run docs:diagrams`, `npm run lint`, `npm run typecheck`, coverage-backed unit/property/integration tests with mandatory PostgreSQL coverage, `npm run simulate:bots:gate`, `npm --workspace @colonizt/web run test`, `npm run smoke:network`, the two-browser multiplayer journey, and desktop/mobile Playwright in CI.
- Pre-deploy gate: `npm run build`, `npm run test:e2e -- --project=chromium`, `npm run test:e2e -- --project=mobile`, replay fixtures, `npm run load:sockets`, and migration smoke.
- Post-deploy gate: `npm run smoke:deployed-network` and `npm run smoke:deployed-browser` with production public URLs.
- Nightly/release gate: mutation testing and the thresholded WebSocket soak run automatically. Also run `npm run smoke:cross-network`, `npm run simulate:bots:default-lineup`, and `npm run simulate:bots:difficulty` from distinct network egresses where applicable and record the logs. A pass requires connected human clients to observe the same canonical event sequence after host-start and reconnect.
