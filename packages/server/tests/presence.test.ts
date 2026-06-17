import { describe, expect, it } from "vitest";
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
  });
});
