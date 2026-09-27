# Illustrated table and session recovery

## Implementation boundaries

The pure rules engine, bots, map generator, and replay schema remain the source of truth. `GameBoard` owns the SVG layers, deterministic decorative variants, keyboard previews, and confirm/cancel interaction. `useBoardCamera` owns bounded camera gestures and measures SVG-to-screen coordinates so hit targets stay at least 44 pixels. Drag gestures suppress clicks; they never commit a piece.

`SetupScreen`, existing lobby/hand/trade/analysis components, and the four component stylesheets share paper, forest, teal water, and muted accent tokens. Terrain imagery is decorative. Tokens, probabilities, harbor ratios, player symbols, roads, and houses remain vectors or text. Player symbols distinguish ownership in addition to color. The compact player strip stays above the board; hands/actions stay below it on portrait phones. Table details collapse into a journal and dialogs become bottom sheets. Reduced motion disables the short placement/dice/resource transitions.

`SessionController` owns online transport epochs, lifecycle listeners, reconnect deadlines, sequence reconciliation, command identity, persistence, and status. `useNetworkRoom` subscribes React to it. UI projection is separate from transport recovery. Connecting/joining/synchronizing sessions cannot issue gameplay commands. A board already loaded remains visible during recovery. Diagnostics record reconnect attempts, resync count, command kind, and acknowledgement latency; they contain no session tokens, resource bundles, or private hands.

## Artwork provenance

`packages/web/src/assets/terrain-atlas.png` was generated specifically for this project with the built-in imagegen tool on 2026-09-27. The brief requested an original overhead gouache miniature island atlas: six equal square panels in a 3 × 2 grid, forest/clay quarry/wheat above pasture/mountains/dunes, warm illustrated indie tabletop style, no text, numbers, player colors, labels, gameplay symbols, hex outlines, or gutters. The checked-in 1536 × 1024 PNG is the original returned raster. Each panel is clipped by board geometry at runtime. Panel flips depend on stable board order, never device randomness. No third-party game assets were used.

### Shared illustrated surfaces

The home screen, lobby, game, and replay share `island-backdrop.webp`, an original 1536 × 1024 scene generated with the built-in imagegen tool on 2026-09-27. It is losslessly encoded from the generated PNG: 1,958,886 bytes instead of 2,968,385 bytes, with unchanged pixels. The background is decorative and contains no game state. The terrain atlas also supplies the match-choice and resource-card artwork; counts, labels, and symbols remain HTML/SVG on opaque paper badges.

Shared paper tokens define translucent warm surfaces, inset panels, borders, and shadows. The game board has a stronger water wash to keep the scenery subordinate to legal placements. Player colors identify seats along the left edge, alongside their existing symbols. Dialogs and lobby panels use the same paper material. Reduced transparency requests replace the shared translucent paper with a solid surface and disable its blur. Layout checks include narrow tablets and 320px phones.

Final image-generation prompt:

> Use case: illustration-story. Asset type: original background artwork for a cozy illustrated island tabletop game. Create a wide landscape (1536 x 1024) hand-painted gouache and watercolor aerial archipelago scene, with muted deep teal sea, tiny cream surf brushstrokes, warm ochre coastlines, forest green trees, pale sage meadows, golden wheat, terracotta clay cliffs, and soft slate mountains. Match an artisanal painted board-game terrain atlas: miniature detailed terrain, soft dry brush texture and paper grain, understated afternoon light. Composition: an irregular lush island concentrated in the lower left and lower center, a small island near upper right, generous quiet teal water in the central and upper regions so HTML content can be legible over translucent warm paper panels. All terrain blends naturally into the water, no geometric hexagons, no board border. Keep the water fairly even in value, edges softly painterly, earthy inviting indie-game art, no glossy 3D or plastic, no neon, no strong vignette. This is scenery only: absolutely no text, letters, numerals, labels, symbols, UI, frames, logos or gameplay information. No transparency; the application will layer translucent paper UI over this image.

## Local cross-device review

Run the API on loopback and expose Vite to your LAN. Set `WEB_ORIGIN` to the exact URL opened on the phones; do not use a wildcard origin. For example, replacing the example LAN address with your machine's address:

```bash
WEB_ORIGIN=http://192.168.1.20:5173 SERVER_HOST=127.0.0.1 npm run dev:server
npm run dev:web
```

Open that same `http://192.168.1.20:5173` URL on each device. Vite proxies `/config`, `/sessions`, `/ws-tickets`, `/rooms`, `/matches`, `/analytics`, and `/ws` to the API. Phone clients use their page origin instead of their own localhost. Keep `VITE_API_BASE_URL` unset for this workflow. The production reverse proxy must expose the same paths and support WebSocket upgrades; use HTTPS/WSS in production. Local HTTP sharing falls back to a selectable invite link when native share or clipboard is unavailable.

## Deployment sequence

1. Deploy server protocol 4 support first; verify `/config` and existing clients.
2. Deploy the new browser bundle with the atlas and styles atomically.
3. Watch reconnect/resync counts and acknowledgement latency alongside existing server command metrics.
4. Roll back the client first if necessary. Keep server support for outstanding protocol 4 clients until they have drained. No database or replay migration is needed.

The local verification below was recorded before deployment. Automated emulation does not establish physical phone reliability. Separately record iOS Safari and Android Chrome model/OS/browser versions, Wi-Fi/cellular handoff, lock/unlock, foreground restoration, refresh, long disconnect, room expiry, and lost-ACK recovery. Confirm that all participants converge and private hands remain private. Physical-device checks are pending and remain an unverified release risk.

Browser lifecycle handling follows [Chrome's lifecycle guidance](https://developer.chrome.com/docs/web-platform/page-lifecycle-api); fault injection uses the supported [Playwright WebSocket routing API](https://playwright.dev/docs/api/class-websocketroute).

## Local verification — 2026-09-27

| Check | Result |
| --- | --- |
| ESLint, TypeScript, production build, whitespace check | Passed |
| Unit/property/integration/UI coverage suite | 663 passed, including PostgreSQL persistence, WebSocket recovery, trusted-proxy validation, and deployment preflight tests, after installing the patched dependency lockfile |
| Coverage | 95.07% statements, 85.56% branches, 97.83% functions, 97.99% lines; existing gates passed |
| Dependency audit | Zero vulnerabilities after compatible updates; no forced major upgrades |
| Bot simulations | 247 games and five concurrent rooms passed with no invalid commands, unfinished games, or crashes |
| Browser suite | 45 passed across desktop Chromium, Pixel Chromium, iPhone WebKit, and iPad WebKit; 27 project/environment exclusions skipped |
| Automated accessibility | No serious or critical axe violations on audited setup, board, trade, special-card, discard, victory, and replay surfaces |
| Live mixed-device room | Passed with four isolated contexts; setup, trade, lost ACK, original-identity retry, delayed/duplicate events, refresh, offline recovery, lifecycle restoration, private-hand isolation, and cursor convergence |
| Physical iOS Safari / Android Chrome | Pending; no physical Wi-Fi/cellular or lock/unlock verification performed |

Reviewed screenshots cover all three map presets in both orientations, long names, setup, dialogs, victory tabs, and replay. Number text is at least 12 screen pixels at fit scale; camera buttons and placement targets remain at least 44 pixels. Landscape dice and camera controls occupy reserved space. Touch placement resolves overlapping hit areas to the nearest legal position and still requires confirmation. The rejected-command recovery check verifies both restored drafts and persistent rejection text after the authoritative resync.

The latest development-build click-to-visible samples were 103–125 ms on desktop Chromium, 92–117 ms on Pixel Chromium, 77–133 ms on iPhone WebKit, and 77–164 ms on iPad WebKit. These measure DOM visibility with automation overhead on this machine, not network-cold loading or physical device frame rates; there is no measured before/after performance claim. The production JavaScript is 479.86 kB (140.36 kB gzip), CSS 35.25 kB (8.54 kB gzip), and the original terrain PNG is 3.47 MB. The image is a material cold-load cost; cellular performance remains unverified.

Local screenshots and a compact browser results record are retained under `reports/illustrated-review/` (ignored by Git); the desktop review image is also checked in at `docs/assets/colonizt-illustrated.png`. Production release status is recorded in the GitHub Actions deployment history.

### Visual refinement verification — 2026-09-27

The shared-backdrop/paper refinement passed 187 frontend unit tests, 28 visual/accessibility browser tests across desktop Chromium, Android-sized Chromium, iPhone WebKit, and iPad WebKit, plus three mobile lobby interaction tests. ESLint, forced TypeScript checking, and the production build passed. An additional home/lobby inspection at 320, 390, 700, 768, 920, and 1440 CSS pixels found no horizontal page overflow. Lobby axe audits cover both open and closed seats at those widths. Closed seats use a muted inset and dashed border instead of fading their text. Screenshots include all map presets in both orientations, trade/development/discard/robber dialogs, victory, and replay. The narrow-card clipping caught by the first touch run was corrected before the passing run.

Current development-build click-to-board-visible samples were 101–127 ms on desktop Chromium, 84–121 ms on Android-sized Chromium, 64–98 ms on iPhone WebKit, and 68–95 ms on iPad WebKit. These are local automation measurements, not evidence of improved rendering performance or cellular loading. The new background adds 1.96 MB to a cold visit; physical-device and constrained-network review remain pending. Updated local screenshots and capture scripts are under `reports/ui-review/` (ignored by Git).
