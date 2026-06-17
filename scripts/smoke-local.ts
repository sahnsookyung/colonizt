import { replay } from "@colonizt/game-core";
import { createDemoConfig, playBotGame } from "@colonizt/test-utils";
import { createFixedBoard } from "@colonizt/game-core";
import { createPool, runMigrations } from "@colonizt/db";
import { MemoryEventStore, PostgresEventStore, RoomManager } from "@colonizt/server";

let migrations = "skipped-no-database-url";
let services = "in-memory-room-manager";
let pool: ReturnType<typeof createPool> | undefined;
const eventStore = process.env.DATABASE_URL
  ? new PostgresEventStore(pool = createPool({ connectionString: process.env.DATABASE_URL }))
  : new MemoryEventStore();

if (process.env.DATABASE_URL) {
  await runMigrations(pool!);
  migrations = "applied";
  services = "postgres-event-store";
}

const manager = new RoomManager(eventStore);
const session = await manager.createSession("Smoke");
const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: true, ranked: false });
const ready = await manager.setReady(room.id, session, true);

if (!ready.ok || !ready.room.game) {
  throw new Error("Room creation/start failed");
}

const firstVertex = Object.keys(ready.room.game.board.vertices)[0];
if (!firstVertex) throw new Error("No board vertices");
const firstEdge = ready.room.game.board.adjacency.vertexToEdges[firstVertex]?.[0];
if (!firstEdge) throw new Error("No board edges");
const commandResult = await manager.submitCommand(ready.room.id, session, 1, {
  type: "PLACE_SETUP",
  playerId: session.userId,
  vertexId: firstVertex,
  edgeId: firstEdge,
});
if (!commandResult.ok) {
  throw new Error(`Smoke command failed: ${commandResult.code}`);
}
await manager.addChat(room.id, session, "smoke chat");
await manager.createReport(room.id, session, "bot_2", "smoke report");
await manager.recordAnalytics({
  userId: session.userId,
  matchId: commandResult.state.config.matchId,
  eventName: "smoke_local_completed",
  payload: { source: "smoke-local" },
});

let nonMatchPersistence = "not-queried";
if (pool) {
  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM chat_messages WHERE match_id = $1) AS chat_count,
       (SELECT COUNT(*)::int FROM reports WHERE match_id = $1) AS report_count,
       (SELECT COUNT(*)::int FROM analytics_events WHERE match_id = $1) AS analytics_count`,
    [commandResult.state.config.matchId],
  );
  const row = counts.rows[0];
  if (row.chat_count < 1 || row.report_count < 1 || row.analytics_count < 1) {
    throw new Error("Expected chat, report, and analytics rows to persist");
  }
  nonMatchPersistence = `${row.chat_count}/${row.report_count}/${row.analytics_count}`;
}

const restarted = new RoomManager(eventStore);
await restarted.hydrateFromStore();
const storedReplay = await restarted.getReplayById(room.id);
if (!storedReplay) throw new Error("Stored replay not found after restart hydration");
const storedState = replay(storedReplay);
if (storedState.eventSeq !== commandResult.state.eventSeq) {
  throw new Error("Stored replay reconstruction did not match accepted command state");
}

const seed = "smoke-local";
const played = playBotGame(seed, 120);
const replayed = replay({ config: createDemoConfig(seed), board: createFixedBoard(), events: played.events });

if (replayed.eventSeq !== played.state.eventSeq) {
  throw new Error("Smoke replay reconstruction failed");
}

console.log(
  JSON.stringify(
    {
      migrations,
      services,
      roomCreated: true,
      botFilledMatchStarted: true,
      commandApplied: true,
      eventsPersisted: storedReplay.events.length,
      nonMatchPersistence,
      replayReconstructed: true,
      restartRecovered: true,
      phase: replayed.phase.type,
    },
    null,
    2,
  ),
);

await pool?.end();
