import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ColoniztDb from "@colonizt/db";

const dbMocks = vi.hoisted(() => ({
  createPool: vi.fn(),
  runMigrations: vi.fn(),
}));

vi.mock("@colonizt/db", async (importOriginal) => {
  const actual = await importOriginal<typeof ColoniztDb>();
  return {
    ...actual,
    createPool: dbMocks.createPool,
    runMigrations: dbMocks.runMigrations,
  };
});

import type { StructuredLogger } from "../src/observability.js";
import { buildServer, MetricsRegistry } from "../src/index.js";
import { MemoryPresenceStore } from "../src/presence.js";
import { RoomManager } from "../src/room-manager.js";

const logger = (): StructuredLogger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe("database-backed server bootstrap", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("runs migrations, hydrates through PostgreSQL, and closes the pool", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://colonizt.example/test");
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      end: vi.fn(async () => undefined),
    };
    dbMocks.createPool.mockReturnValue(pool);
    dbMocks.runMigrations.mockResolvedValue(undefined);

    const app = await buildServer({
      logger: logger(),
      presenceStore: new MemoryPresenceStore(),
      nodeId: "database-test",
    });
    const health = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(dbMocks.createPool).toHaveBeenCalledWith({ connectionString: "postgres://colonizt.example/test" });
    expect(dbMocks.runMigrations).toHaveBeenCalledWith(pool);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("FROM rooms"), [200]);
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, service: "colonizt-server", nodeId: "database-test" });
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("records and reports migration failures without starting the server", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://colonizt.example/test");
    const failure = new Error("migration failed");
    const pool = {
      query: vi.fn(),
      end: vi.fn(async () => Promise.reject(new Error("pool close failed"))),
    };
    const metrics = new MetricsRegistry("database-test", "single");
    const testLogger = logger();
    dbMocks.createPool.mockReturnValue(pool);
    dbMocks.runMigrations.mockRejectedValue(failure);

    await expect(buildServer({ metrics, logger: testLogger, presenceStore: new MemoryPresenceStore() }))
      .rejects.toBe(failure);

    expect(testLogger.error).toHaveBeenCalledWith("db.migrations_failed", { message: "migration failed" });
    expect(testLogger.error).toHaveBeenCalledWith("db.pool_close_failed", { message: "pool close failed" });
    expect(metrics.render(new RoomManager(), 0, "memory")).toContain('operation="migrations"} 1');
    expect(metrics.render(new RoomManager(), 0, "memory")).toContain('operation="pool_close"} 1');
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("still closes the database pool when presence shutdown fails", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://colonizt.example/test");
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      end: vi.fn(async () => undefined),
    };
    const presence = new MemoryPresenceStore();
    vi.spyOn(presence, "close").mockRejectedValue(new Error("presence close failed"));
    dbMocks.createPool.mockReturnValue(pool);
    dbMocks.runMigrations.mockResolvedValue(undefined);
    const app = await buildServer({ logger: logger(), presenceStore: presence });

    await expect(app.close()).rejects.toThrow("Server cleanup failed: Error: presence close failed");

    expect(presence.close).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
