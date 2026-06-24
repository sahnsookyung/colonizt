import { describe, expect, it, vi } from "vitest";
import { MemoryPresenceStore } from "../src/presence.js";
import type { Session } from "../src/room-manager.js";

describe("PresenceStore", () => {
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
