# ADR 0001: Room Authority and Horizontal Routing

- Status: Accepted
- Date: 2026-07-15
- Owners: Server and operations maintainers

## Context

Colonizt keeps active room state, connected sockets, timers, and broadcasts in one server process. PostgreSQL stores durable room and match history, ownership leases fence concurrent command authority, and Redis is an optional presence adapter. Neither store routes a WebSocket frame or broadcasts an accepted event to sockets owned by another process.

Running multiple authoritative server replicas without a routing contract could therefore split a room across processes, accept commands against divergent memory, miss broadcasts, and let a stale lease holder act after failover.

## Decision

`INSTANCE_MODE=single` remains the only supported production mode. Startup rejects a multi-node mode. Redis remains optional and must not be described as horizontal room fanout.

Horizontal execution may be enabled only after one design implements and proves all of these boundaries:

1. **Room-aware ingress.** The initial room create/join request establishes a canonical room identifier. Subsequent WebSocket tickets bind the authenticated user, intended room, role, expiry, and one-use nonce. The load balancer or gateway routes that intent to the current room owner; a ticket for another owner is forwarded or rejected with a retryable owner hint before the socket joins.
2. **Fenced room ownership.** PostgreSQL remains the ownership source of truth. Every mutation uses an owner epoch or fencing token obtained with the lease. Renewals, command commits, timer work, and event appends fail when that token is stale.
3. **Single command path.** Client command IDs remain idempotent across retries. Non-owners forward commands to the owner over an authenticated internal channel or redirect clients; they never execute game-core commands locally.
4. **Cross-process fanout.** Accepted canonical events, room state changes, presence, and disconnects use a deliberate fanout adapter. Delivery is at-least-once, ordered by room sequence, and consumers discard duplicates and request resync on gaps. Redis pub/sub is one possible adapter, not an implicit requirement.
5. **Failover semantics.** A replacement owner hydrates validated snapshot plus event tail, acquires a newer fencing token, resumes due work once, and forces connected clients to resync. The old owner stops command and automation work as soon as lease renewal or fencing fails.
6. **Observable routing.** Metrics distinguish owner redirects, forwards, stale-owner rejections, fanout lag/gaps, ownership changes, and hydration outcomes without exposing private hands.

## Required Proof Before Enabling Multi-node

- Two or more real server processes with independent in-memory registries.
- Concurrent join, command, trade, reconnect, and resync tests routed through the public ingress.
- Owner crash during event commit and during timer/bot work, proving exactly one canonical result.
- Network partition and delayed fanout tests, proving fencing, duplicate suppression, and gap-triggered resync.
- Load evidence for room migration and reconnect storms, plus an operator runbook for draining an owner.
- Backward-compatible public REST/WebSocket and replay payloads.

## Consequences

The current deployment is intentionally simpler and honest: one authoritative server replica can scale vertically, while PostgreSQL provides durability and Redis may improve presence behavior. Horizontal scale work has a concrete compatibility and failure-safety contract, but no partial multi-node switch is accepted merely because leases or Redis exist.

WebSocket ticket room intent is deferred until routing exists; adding it prematurely would create an unused contract and would not solve initial create/join routing by itself.
