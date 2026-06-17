# Replay Format

Replays are reconstructed from:

- Initial game config.
- Initial board.
- Ordered accepted game events.
- Optional snapshots used only to speed loading.

Every event has:

- `schemaVersion`.
- `matchId`.
- `serverSeq`.
- `type`.
- `payload`.

Snapshots are optimization, not truth. If a snapshot disagrees with the event log, replay must prefer the ordered events.

## Schema Version 2

New games and events use `schemaVersion: 2`. Version 2 keeps bank and harbor trades immediate, but player-to-player trades are staged:

- `TRADE_OFFERED` opens a trade with `status: "COLLECTING_RESPONSES"` and a `responses` entry for every eligible recipient.
- Recipients answer with `RESPOND_TRADE`, which emits `TRADE_RESPONSE_RECORDED`.
- Responses do not move resources. The offerer chooses one `WANTS_ACCEPT` responder with `FINALIZE_TRADE`, which emits `TRADE_ACCEPTED`.
- The offerer can cancel with `CANCEL_TRADE`.
- If every eligible recipient rejects, the trade closes with `TRADE_CLOSED` reason `ALL_REJECTED`.
- If the staged response window expires, the trade closes with `TRADE_CLOSED` reason `RESPONSE_TIMEOUT`.

The response window is 15 seconds in the server/UI layer. Wall-clock deadlines are not part of the deterministic replay state; snapshots may include viewer-only `tradeResponseDeadlines` metadata so clients can render countdowns.

## Version 1 Import

Version 1 logs are replayed with their original immediate `ACCEPT_TRADE` and `REJECT_TRADE` semantics. Compatibility import keeps those legacy commands/events valid for historical replays.

When importing a saved snapshot instead of a full event log, unfinished v1 trades with `status: "OPEN"` are normalized to:

- `status: "CLOSED"`
- `closedReason: "MIGRATED"`
- no staged `responses` map

This avoids resurrecting an old immediate-accept offer inside a version 2 staged match.

## Redaction

Trade resources and response details are visible only to involved players. Spectators and uninvolved players receive redacted bundles for trade offers and no `responses` map. `TRADE_RESPONSE_RECORDED` events sent to uninvolved viewers include only the event identity and `tradeId`.
