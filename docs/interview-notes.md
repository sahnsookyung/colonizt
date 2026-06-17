# Interview Notes

## Server Authority

The client sends intent. The server validates the command, appends accepted events, and broadcasts the resulting truth.

## Reconnect

Every server event has a sequence number. A reconnecting client resumes from its last seen sequence or requests a full viewer-safe snapshot.

## Scaling

Active rooms should have clear ownership by one worker at a time. Durable events make crash recovery possible; Redis-style coordination should not replace authoritative match history.

## Dice Trust

The event log records RNG policy and dice events. Seeded paths make tests and replays deterministic, while simulation reports help explain aggregate fairness.

## PostgreSQL vs Redis

PostgreSQL stores users, rooms, matches, ratings, events, snapshots, chat, reports, and analytics. Redis is for ephemeral presence, queue coordination, and non-critical notifications.

## Rush Conflict Resolution

Simultaneous modes still become deterministic when the server sequences commands. First valid command after sequencing wins; stale commands are rejected with clear errors.
