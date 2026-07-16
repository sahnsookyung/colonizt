import { describe, expect, it, vi } from "vitest";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import { MemoryRoomOwnershipStore, PostgresRoomOwnershipStore } from "../src/ownership.js";

const queryResult = (rows: QueryResultRow[] = [], rowCount = rows.length): QueryResult<QueryResultRow> => ({
  command: "", rowCount, oid: 0, fields: [], rows,
});

describe("room ownership stores", () => {
  it("enforces owners, renewal, expiry, and release in memory", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = new MemoryRoomOwnershipStore();

    await expect(store.ownerOf("room_1")).resolves.toBeUndefined();
    await expect(store.acquire("room_1", "node_a", 500)).resolves.toBe(true);
    await expect(store.ownerOf("room_1")).resolves.toBe("node_a");
    await expect(store.acquire("room_1", "node_b", 500)).resolves.toBe(false);
    await expect(store.release("room_1", "node_b")).resolves.toBe(false);
    await expect(store.acquire("room_1", "node_a", 1_000)).resolves.toBe(true);

    vi.setSystemTime(2_001);
    await expect(store.ownerOf("room_1")).resolves.toBeUndefined();
    await expect(store.acquire("room_1", "node_b", 500)).resolves.toBe(true);
    await expect(store.release("room_1", "node_b")).resolves.toBe(true);
    await expect(store.release("room_1", "node_b")).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("maps PostgreSQL lease acquisition, lookup, and release", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO room_leases")) return queryResult([{ room_id: "room_1", owner_id: "node_a", expires_at: "2026-07-14T01:00:00.000Z" }]);
      if (sql.includes("SELECT owner_id")) return queryResult([{ owner_id: "node_a" }]);
      if (sql.includes("DELETE FROM room_leases")) return queryResult([], 1);
      return queryResult();
    });
    const store = new PostgresRoomOwnershipStore({ query } as unknown as Pool);

    await expect(store.acquire("room_1", "node_a", 30_000)).resolves.toBe(true);
    await expect(store.ownerOf("room_1")).resolves.toBe("node_a");
    await expect(store.release("room_1", "node_a")).resolves.toBe(true);

    const deniedQuery = vi.fn(async () => queryResult());
    const denied = new PostgresRoomOwnershipStore({ query: deniedQuery } as unknown as Pool);
    await expect(denied.acquire("room_1", "node_b", 30_000)).resolves.toBe(false);
    await expect(denied.ownerOf("room_1")).resolves.toBeUndefined();
    await expect(denied.release("room_1", "node_b")).resolves.toBe(false);
  });
});
