import { describe, expect, it, vi } from "vitest";
import type { Session } from "../src/room-manager.js";
import { RateLimitBuckets } from "../src/rate-limits.js";
import { configuredSecret, externalBaseUrl, isDatabaseError, nonNegativeInt, positiveInt } from "../src/server-runtime.js";
import { SocketRegistry } from "../src/socket-registry.js";
import { WebSocketTicketStore } from "../src/websocket-tickets.js";
import type { SocketClient, WebSocketLike } from "../src/websocket-transport.js";

const session: Session = { token: "session-token", userId: "user-1", displayName: "Player" };

describe("server runtime configuration", () => {
  it("parses bounded integer settings without accepting invalid values", () => {
    expect(positiveInt("12", 4)).toBe(12);
    expect(positiveInt("0", 4)).toBe(4);
    expect(positiveInt("not-a-number", 4)).toBe(4);
    expect(nonNegativeInt("0", 3)).toBe(0);
    expect(nonNegativeInt("2.5", 3)).toBe(3);
    expect(nonNegativeInt("-1", 3)).toBe(3);
  });

  it("normalizes optional secrets, database errors, and proxy-aware external URLs", () => {
    expect(configuredSecret("  secret  ")).toBe("secret");
    expect(configuredSecret("   ")).toBeUndefined();
    expect(configuredSecret(null)).toBeUndefined();
    expect(isDatabaseError({ code: "23505", routine: "unique_violation" })).toBe(true);
    expect(isDatabaseError({ code: "08006", severity: "FATAL" })).toBe(true);
    expect(isDatabaseError({ code: "bad", severity: "ERROR" })).toBe(false);
    expect(isDatabaseError(null)).toBe(false);
    expect(externalBaseUrl({ headers: {} }, "https://api.example.test/")).toBe("https://api.example.test");
    expect(externalBaseUrl({ headers: { "x-forwarded-proto": "https, http", "x-forwarded-host": "game.example.test, internal" } })).toBe("https://game.example.test");
    expect(externalBaseUrl({ headers: { host: "localhost:8787" }, protocol: "http" })).toBe("http://localhost:8787");
    expect(externalBaseUrl({ headers: {} })).toBe("http://127.0.0.1");
  });
});

describe("rate-limit buckets", () => {
  it("isolates keys, rejects full windows, and removes expired buckets", () => {
    let now = 1_000;
    const buckets = new RateLimitBuckets(() => now);
    expect(buckets.allow("sessions", 2, 1_000)).toBe(true);
    expect(buckets.allow("sessions", 2, 1_000)).toBe(true);
    expect(buckets.allow("sessions", 2, 1_000)).toBe(false);
    expect(buckets.allow("tickets", 1, 1_000)).toBe(true);
    expect(buckets.size()).toBe(2);
    now = 2_001;
    buckets.sweep(1_000);
    expect(buckets.size()).toBe(0);
    expect(buckets.allow("sessions", 2, 1_000)).toBe(true);
  });

  it("can enforce a caller-supplied receipt time after processing is delayed", () => {
    const buckets = new RateLimitBuckets(() => 10_000);
    expect(buckets.allow("messages", 1, 1_000, 1_000)).toBe(true);
    expect(buckets.allow("messages", 1, 1_000, 1_500)).toBe(false);
    expect(buckets.allow("messages", 1, 1_000, 2_001)).toBe(true);
  });
});

describe("WebSocket ticket store", () => {
  it("issues one-use tickets and resolves their session exactly once", async () => {
    let now = 10_000;
    const store = new WebSocketTicketStore(500, () => now, () => "wst-fixed");
    const resolve = vi.fn(async (token: string) => token === session.token ? session : undefined);
    const ticket = store.issue(session);
    expect(ticket).toEqual({ token: "wst-fixed", expiresAt: 10_500 });
    expect(store.size()).toBe(1);
    await expect(store.consume(ticket.token, resolve)).resolves.toEqual(session);
    await expect(store.consume(ticket.token, resolve)).resolves.toBeUndefined();
    await expect(store.consume(null, resolve)).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledOnce();

    store.issue(session);
    now = 10_500;
    await expect(store.consume("wst-fixed", resolve)).resolves.toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("sweeps expired tickets without disturbing active ones", () => {
    let now = 1_000;
    let sequence = 0;
    const store = new WebSocketTicketStore(100, () => now, () => `wst-${sequence += 1}`);
    store.issue(session);
    now = 1_050;
    store.issue(session);
    expect(store.size()).toBe(2);
    now = 1_100;
    store.sweep();
    expect(store.size()).toBe(1);
  });
});

describe("socket registry", () => {
  const client = (userId: string): { client: SocketClient; send: ReturnType<typeof vi.fn> } => {
    const send = vi.fn();
    const socket: WebSocketLike = { send, close: vi.fn(), on: vi.fn() };
    return { client: { socket, session: { ...session, userId, token: `token-${userId}` } }, send };
  };

  it("tracks, moves, broadcasts, detaches, and untracks clients by authority room", () => {
    const registry = new SocketRegistry();
    const first = client("p1");
    const second = client("p2");
    registry.track("socket-1", first.client);
    registry.track("socket-2", second.client);
    registry.attach(first.client, "room-a");
    registry.attach(second.client, "room-a");
    expect(registry.size()).toBe(2);
    expect(registry.find("socket-1")).toBe(first.client);
    expect(registry.roomClients("room-a")).toHaveLength(2);
    expect(registry.roomUserIds("room-a")).toEqual(new Set(["p1", "p2"]));
    registry.broadcast("room-a", (target) => ({ userId: target.session.userId }));
    expect(first.send).toHaveBeenCalledWith(JSON.stringify({ userId: "p1" }));
    expect(second.send).toHaveBeenCalledWith(JSON.stringify({ userId: "p2" }));

    registry.attach(first.client, "room-b");
    expect(registry.roomClients("room-a")).toEqual([second.client]);
    expect(registry.roomUserIds("room-a")).toEqual(new Set(["p2"]));
    expect(registry.roomClients("room-b")).toEqual([first.client]);
    registry.detach(first.client, "room-b");
    expect(first.client.roomId).toBeUndefined();
    expect(registry.untrack("socket-2", second.client)).toEqual({ tracked: true, roomId: "room-a" });
    expect(registry.untrack("socket-2", second.client)).toEqual({ tracked: false });
    registry.sweepEmptyRooms();
    expect(registry.size()).toBe(1);
  });

  it("continues broadcasting when one client send fails", () => {
    const registry = new SocketRegistry();
    const failing = client("failing");
    const healthy = client("healthy");
    failing.send.mockImplementation(() => { throw new Error("socket closed"); });
    registry.attach(failing.client, "room-a");
    registry.attach(healthy.client, "room-a");

    const failures = registry.broadcast("room-a", (target) => ({ userId: target.session.userId }));

    expect(failures).toEqual([{ client: failing.client, error: expect.objectContaining({ message: "socket closed" }) }]);
    expect(healthy.send).toHaveBeenCalledWith(JSON.stringify({ userId: "healthy" }));
  });
});
