# Replay Format

Replays are reconstructed from:

- Initial game config.
- Initial board.
- Accepted game events ordered by contiguous `seq`.
- Optional server-only snapshots used to speed loading.

Every event has:

- `schemaVersion`.
- `seq`.
- `type`.
- event-specific payload fields.

Snapshots are optimization, not public truth. Authoritative snapshots contain full `GameState`, are never exposed directly through viewer APIs, and must have `snapshot.seq === snapshot.state.eventSeq`. Public room and replay endpoints still use viewer-safe serialization.

## Replay Validation

`@colonizt/game-core` validates replay logs before applying events:

- snapshots must have a non-negative integer `seq`, matching state `eventSeq`, and a supported schema version;
- event payloads must be objects with integer `seq`, supported `schemaVersion`, and string `type`;
- event sequences must start at `1` for full logs, or `snapshot.seq + 1` for snapshot-plus-tail logs;
- duplicate and missing event sequences are rejected.

The SQL replay loader also checks that each persisted row's `seq` and `event_type` match the embedded event payload before hydration. A corrupt row fails closed instead of silently rebuilding partial state.

## Snapshot Hydration

When a snapshot is available, room hydration replays `snapshot.state` plus only events after `snapshot.seq`. Snapshot-plus-tail replay must equal full replay for the same match. The server writes snapshots every 25 accepted events and at game over.

## Schema Versions 2 And 3

New games and events use `schemaVersion: 3`. Version 2 and 3 keep bank and harbor trades immediate, but player-to-player trades are staged:

- `TRADE_OFFERED` opens a trade with `status: "COLLECTING_RESPONSES"` and a `responses` entry for every eligible recipient.
- Recipients answer with `RESPOND_TRADE`, which emits `TRADE_RESPONSE_RECORDED`.
- Responses do not move resources. The offerer chooses one `WANTS_ACCEPT` responder with `FINALIZE_TRADE`, which emits `TRADE_ACCEPTED`.
- The offerer can cancel with `CANCEL_TRADE`.
- If every eligible recipient rejects, the trade closes with `TRADE_CLOSED` reason `ALL_REJECTED`.
- If the staged response window expires, the trade closes with `TRADE_CLOSED` reason `RESPONSE_TIMEOUT`.

The response window is 15 seconds in the server/UI layer. Wall-clock deadlines are not part of the deterministic replay state. Active room payloads may include viewer-safe deadline metadata so clients can render countdowns; replay reconstruction is based on accepted events.

## Version 1 Import

Version 1 logs are replayed with their original immediate `ACCEPT_TRADE` and `REJECT_TRADE` semantics. Compatibility import keeps those legacy commands/events valid for historical replays.

When importing a saved snapshot instead of a full event log, unfinished v1 trades with `status: "OPEN"` are normalized to:

- `status: "CLOSED"`
- `closedReason: "MIGRATED"`
- no staged `responses` map

This avoids resurrecting an old immediate-accept offer inside a version 2 staged match.

## Redaction

Trade resources and response details are visible only to involved players. Spectators and uninvolved players receive redacted bundles for trade offers and no `responses` map. `TRADE_RESPONSE_RECORDED` events sent to uninvolved viewers include only the event identity and `tradeId`.
