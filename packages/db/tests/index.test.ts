import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { upsertRoom } from "../src/index.js";

describe("room persistence", () => {
  it("updates transferred hosts and removes seats beyond the current room size", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await upsertRoom(pool, {
      id: "room_1",
      mode: "DUEL",
      status: "LOBBY",
      hostUserId: "u_new_host",
      settings: { mode: "DUEL", minPlayers: 2, maxPlayers: 2 },
      seats: [
        { seatIndex: 0, userId: "u_new_host", ready: true, connected: true },
        { seatIndex: 1, botId: "bot_2", ready: true, connected: true },
      ],
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("host_user_id = EXCLUDED.host_user_id"))).toBe(true);
    expect(query.mock.calls).toContainEqual([
      "DELETE FROM room_seats WHERE room_id = $1 AND seat_index >= $2",
      ["room_1", 2],
    ]);
  });
});
