# Testing Strategy

- Unit tests cover pure engine commands, phases, resource payments, scoring, and serializers.
- Property tests generate random legal games and assert invariants.
- Replay fixture tests rebuild known games from event logs.
- Integration tests cover WebSocket ticket auth, origin checks, sequencing, resync, idempotency, hidden-information safety, command ordering, match history, and restart hydration through the event-store interface.
- Protocol tests verify that shared `@colonizt/protocol` schemas accept current client/server message fixtures and reject invalid payloads before game-core sees them.
- Scheduler and observability tests cover room automation ticks, cleanup callbacks, structured logs, metrics rendering, and the enforced single-node instance mode.
- Postgres integration tests run whenever `COLONIZT_TEST_DATABASE_URL` is set and fail fast if CI omits it; CI and SonarCloud provide a real PostgreSQL service. Local runs may leave it unset when intentionally testing only the in-memory adapter.
- Privacy tests verify that live spectator event payloads and snapshots do not expose opponent resource details.
- E2E tests cover local bot game play, mobile viewport interactions, automated axe checks for setup and active-game surfaces, and a real mixed-device server journey through create/join/ready/start/setup/reload/reconnect/resync via `npm run test:multiplayer`. Dialog unit tests cover focus entry, Escape dismissal, and focus restoration.
- Load scripts exercise concurrent rooms, players, spectators, chat, reconnect/resync, operation p95/p99, peak sockets, reconnect success, and heap growth. `npm run load:sockets:soak` enforces the nightly thresholds and uploads a machine-readable `reports/load/soak.json` artifact containing measurements, thresholds, and failure reasons; multi-worker Redis fanout remains a future stress target.
- `npm run test:coverage` enforces at least 95% statement coverage, 95.5% line/function coverage, and 85% branch coverage across all package source files, including files that no test imports yet. Only the database migration and browser bootstrap entrypoints are excluded because their behavior is exercised by migration, build, smoke, and browser gates. The threshold is backed by behavioral scenarios; the critical replay, invariant, idempotency, and lifecycle paths additionally require a 95% mutation score.
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

## SonarCloud authentication and dependency updates

The SonarCloud workflow runs lint, type checking, coverage, and the build before
uploading analysis. A scanner HTTP 403 can indicate rejected credentials or missing
analysis permissions even when all of those local quality gates pass. Check the
token first; updating npm packages does not repair a missing or rejected token.

Dependabot pull requests skip the entire SonarCloud job before a runner or
PostgreSQL service starts, saving the repeated installation and coverage run as
well as the scan. The condition checks the PR author, so human-triggered updates
to a Dependabot PR also skip it. Regular CI, dependency review, and CodeQL still
run. SonarCloud runs on other PRs, pushes to `main` after merging, merge groups,
and manual dispatches. Dependency updates therefore receive Sonar analysis after
merging to `main`, rather than as a prerequisite on each Dependabot PR.

Generate a token for an account with **Execute Analysis** access to
`sahnsookyung_colonizt` in the `sahnsookyung` organization. Store it as `SONAR_TOKEN`
in repository Settings → Secrets and variables → Actions. No Dependabot
`SONAR_TOKEN` is needed with this policy. Never put the token in source control,
workflow arguments, or logs. After replacing the secret, rerun the failed
SonarCloud workflow.

SonarCloud personal tokens without an expiration date are automatically removed
after 60 days of inactivity. If a previously working scan starts returning 403
after a long gap, check the token's validity and project permissions. The workflow
fails early with a setup message
when the token is absent; it continues to enforce the Sonar quality gate.

See [SonarCloud token management](https://docs.sonarsource.com/sonarqube-cloud/managing-your-account/managing-tokens)
and [GitHub's Dependabot secret rules](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-on-actions).

Dependabot groups npm and GitHub Actions version updates into one weekly PR using
[multi-ecosystem updates](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configuring-multi-ecosystem-updates).
Each combined update must pass a clean `npm ci`, audit, and the existing CI gates
before merging. Human-authored consolidation PRs also run SonarCloud. TypeScript
major updates are held for a separate compatibility review: the proposed
TypeScript 7.0.2 cannot satisfy
`typescript-eslint` 8.70.1's `>=4.8.4 <6.1.0` peer requirement. Do not use
`--force` or `--legacy-peer-deps` to bypass this conflict.

Use an up-to-date Node 22 release for local validation, matching CI. The updated
jsdom requires Node 22.22.2 or later within the Node 22 line; Vitest 5 does not
support Node 25.

## Multiplayer Release Gates

- PR gate: dependency audit and change review, a CycloneDX production-dependency SBOM, immutable action-reference validation, CodeQL, `npm run docs:diagrams`, `npm run lint`, `npm run typecheck`, coverage-backed unit/property/integration tests with mandatory PostgreSQL coverage, `npm run simulate:bots:gate`, `npm --workspace @colonizt/web run test`, `npm run smoke:network`, the two-browser multiplayer journey, and desktop/mobile Playwright in CI.
- Pre-deploy gate: `npm run build`, `npm run test:e2e -- --project=chromium`, `npm run test:e2e -- --project=mobile`, replay fixtures, `npm run load:sockets`, and migration smoke.
- Post-deploy gate: `npm run smoke:deployed-network` and `npm run smoke:deployed-browser` with production public URLs.
- Nightly/release gate: mutation testing and the thresholded WebSocket soak run automatically. Also run `npm run smoke:cross-network`, `npm run simulate:bots:default-lineup`, and `npm run simulate:bots:difficulty` from distinct network egresses where applicable and record the logs. A pass requires connected human clients to observe the same canonical event sequence after host-start and reconnect.


## Illustrated redesign and protocol 4

- `npm run test:coverage`: full rules, bots, server, transport, session recovery, and UI suite; existing thresholds are unchanged.
- `npm run test:e2e`: desktop Chromium, Pixel-sized Chromium, iPhone WebKit, and iPad WebKit. Includes each map in both orientations, keyboard confirmation/cancellation, reduced motion, long names, measured camera button size, setup/board/dialog accessibility, discard reachability, victory tabs, and replay. Tests write screenshots to their Playwright output directories.
- `npm run test:multiplayer`: four isolated browser contexts in one authoritative room, with Android event delay/duplication and a dropped ACK via `routeWebSocket`. Covers readiness, all setup placements, original-identity retry after refresh, a turn and completed trade, network recovery, and page lifecycle restoration. Viewer payload assertions verify private resource isolation and public event-sequence convergence. Lifecycle dispatch and device viewports are emulations, not physical device checks.
- `packages/web/tests/network-recovery.test.ts`: missing/wrong heartbeat replies, clock skew, hanging HTTP bodies/headers, cancellation, and server version negotiation.
- `packages/web/tests/session-controller.test.ts`: stale callbacks, bounded retry, overlapping streams, stale snapshots, resync deadlines, pending identity, unrelated ACKs, and expired sessions.

`illustrated-experience.spec.ts` records development-build click-to-board timings as test annotations. These include automation overhead and are diagnostic samples, not a before/after performance claim. Physical iOS/Android Wi-Fi/cellular and lock/unlock checks remain a separate pre-release checklist in [illustrated-redesign.md](illustrated-redesign.md).
