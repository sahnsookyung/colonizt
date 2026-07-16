import { describe, expect, it, vi } from "vitest";
import { createPresenceStore, MemoryPresenceStore, RedisPresenceStore } from "../src/presence.js";
import type { Session } from "../src/room-manager.js";

describe("PresenceStore", () => {
  it("degrades to in-memory presence when optional Redis cannot connect", async () => {
    const failure = new Error("redis unavailable");
    const client = { connect: vi.fn(async () => { throw failure; }), destroy: vi.fn() };
    const onFallback = vi.fn();

    const store = await createPresenceStore("redis://unavailable", {
      createRedisClient: () => client as never,
      onFallback,
    });

    expect(store.kind).toBe("memory");
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith(failure);
  });

  it("uses Redis when the optional adapter connects", async () => {
    const client = { connect: vi.fn(async () => undefined) };
    const store = await createPresenceStore("redis://available", { createRedisClient: () => client as never });
    expect(store.kind).toBe("redis");
  });
  it("keeps a user present while another socket remains in the room", async () => {
    const store = new MemoryPresenceStore();
    const session: Session = { token: "s_1", userId: "u_1", displayName: "Soo" };
    await store.connect(session, "socket-a");
    await store.connect(session, "socket-b");
    await store.joinRoom(session, "socket-a", "room_1");
    await store.joinRoom(session, "socket-b", "room_1");

    await store.disconnect(session, "socket-a", "room_1");

    expect(await store.roomUserCount("room_1")).toBe(1);
    expect(await store.roomUserIds("room_1")).toEqual(new Set(["u_1"]));
  });

  it("refreshes existing socket presence without dropping room membership", async () => {
    vi.useFakeTimers();
    const store = new MemoryPresenceStore();
    const session: Session = { token: "s_1", userId: "u_1", displayName: "Soo" };
    vi.setSystemTime(1_000);
    await store.connect(session, "socket-a");
    await store.joinRoom(session, "socket-a", "room_1");

    vi.setSystemTime(2_000);
    await store.refresh(session, "socket-a");

    expect(await store.roomUserIds("room_1")).toEqual(new Set(["u_1"]));
    vi.useRealTimers();
  });

  it("moves a socket out of its previous room when it joins another", async () => {
    const store = new MemoryPresenceStore();
    const session: Session = { token: "s_1", userId: "u_1", displayName: "Soo" };
    await store.connect(session, "socket-a");
    await store.joinRoom(session, "socket-a", "room_1");
    await store.joinRoom(session, "socket-a", "room_2");

    expect(await store.roomUserIds("room_1")).toEqual(new Set());
    expect(await store.roomUserIds("room_2")).toEqual(new Set(["u_1"]));
  });

  it("removes Redis socket membership from the previous room before switching", async () => {
    const client = {
      hGet: vi.fn(async () => "room_1"),
      hSet: vi.fn(async () => 1),
      sRem: vi.fn(async () => 1),
      sCard: vi.fn(async () => 0),
      sAdd: vi.fn(async () => 1),
      expire: vi.fn(async () => true),
    };
    const store = new RedisPresenceStore(client as never);
    const session: Session = { token: "s_1", userId: "u_1", displayName: "Soo" };

    await store.joinRoom(session, "socket-a", "room_2");

    expect(client.sRem).toHaveBeenCalledWith("colonizt:presence:room:room_1:users", "socket-a");
    expect(client.sRem).toHaveBeenCalledWith("colonizt:presence:rooms", "room_1");
    expect(client.sAdd).toHaveBeenCalledWith("colonizt:presence:room:room_2:users", "socket-a");
  });

  it("connects, refreshes, disconnects, and closes Redis presence", async () => {
    const client = {
      hSet: vi.fn(async () => 1),
      expire: vi.fn(async () => true),
      del: vi.fn(async () => 1),
      sRem: vi.fn(async () => 1),
      quit: vi.fn(async () => "OK"),
    };
    const store = new RedisPresenceStore(client as never);
    const session: Session = { token: "s_1", userId: "u_1", displayName: "Soo" };

    await store.connect(session, "socket-a");
    expect(client.hSet).toHaveBeenCalledWith("colonizt:presence:socket:socket-a", expect.objectContaining({ userId: "u_1", displayName: "Soo" }));
    await store.refresh(session, "socket-a", "room_1");
    await store.refresh(session, "socket-a");
    expect(client.expire).toHaveBeenCalledWith("colonizt:presence:room:room_1:users", 3600);
    await store.disconnect(session, "socket-a", "room_1");
    await store.disconnect(session, "socket-b");
    expect(client.del).toHaveBeenCalledWith("colonizt:presence:socket:socket-a");
    expect(client.sRem).toHaveBeenCalledWith("colonizt:presence:room:room_1:users", "socket-a");
    await store.close();
    expect(client.quit).toHaveBeenCalledOnce();
  });

  it("sweeps stale Redis sockets while preserving fresh users", async () => {
    const hashes = new Map<string, Record<string, string>>([
      ["colonizt:presence:socket:stale", { userId: "u_stale", lastSeenAt: "2026-07-14T00:00:00.000Z" }],
      ["colonizt:presence:socket:fresh", { userId: "u_fresh", lastSeenAt: "2026-07-14T00:02:30.000Z" }],
      ["colonizt:presence:socket:missing-time", { userId: "u_missing" }],
    ]);
    const roomMembers = new Map([
      ["colonizt:presence:room:room_1:users", new Set(["stale", "fresh", "missing-time"])],
      ["colonizt:presence:room:room_empty:users", new Set<string>()],
    ]);
    const client = {
      sMembers: vi.fn(async (key: string) => key === "colonizt:presence:rooms"
        ? ["room_1", "room_empty"]
        : [...(roomMembers.get(key) ?? [])]),
      hGet: vi.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
      del: vi.fn(async (key: string) => { hashes.delete(key); return 1; }),
      sRem: vi.fn(async (key: string, member: string) => { roomMembers.get(key)?.delete(member); return 1; }),
      sCard: vi.fn(async (key: string) => roomMembers.get(key)?.size ?? 0),
    };
    const store = new RedisPresenceStore(client as never);

    const stale = await store.sweepStale(120_000, Date.parse("2026-07-14T00:03:00.000Z"));

    expect(stale).toEqual([
      { socketId: "stale", userId: "u_stale", roomId: "room_1" },
      { socketId: "missing-time", userId: "u_missing", roomId: "room_1" },
    ]);
    expect(client.sRem).toHaveBeenCalledWith("colonizt:presence:rooms", "room_empty");
    expect(await store.roomUserCount("room_1")).toBe(1);
    expect(await store.roomUserIds("room_1")).toEqual(new Set(["u_fresh"]));
  });

  it("drops orphaned Redis room members during lookup", async () => {
    const client = {
      sMembers: vi.fn(async () => ["known", "orphan"]),
      hGet: vi.fn(async (_key: string, field: string) => field === "userId" ? "u_known" : null),
      sRem: vi.fn(async () => 1),
    };
    client.hGet.mockImplementation(async (key: string) => key.endsWith(":known") ? "u_known" : null);
    const store = new RedisPresenceStore(client as never);

    expect(await store.roomUserIds("room_1")).toEqual(new Set(["u_known"]));
    expect(client.sRem).toHaveBeenCalledWith("colonizt:presence:room:room_1:users", "orphan");
  });

  it("sweeps stale sockets and reports affected rooms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const store = new MemoryPresenceStore();
    const session: Session = { token: "s_1", userId: "u_1", displayName: "Soo" };
    await store.connect(session, "socket-a");
    await store.joinRoom(session, "socket-a", "room_1");

    const fresh = await store.sweepStale(120_000, 20_000);
    expect(fresh).toEqual([]);
    expect(await store.roomUserIds("room_1")).toEqual(new Set(["u_1"]));

    const stale = await store.sweepStale(120_000, 131_000);
    expect(stale).toEqual([{ socketId: "socket-a", userId: "u_1", roomId: "room_1" }]);
    expect(await store.roomUserIds("room_1")).toEqual(new Set());
    vi.useRealTimers();
  });
});
